// Meta-harness plan core — task state machine (rules, not data).
// The transition guard is an explicit ALLOW-LIST: a transition not listed here
// is rejected. This is what turns advisory todos into enforced work state.
// Atomic claim (ready→claimed) is NOT here — it is the dedicated /task-claim
// endpoint (step 2) so the race is closed by a single conditional UPDATE.
//
// SINGLE-WRITER INVARIANT (D1): every compound mutation in this module wraps its
// reads+writes in planTransaction() so they execute inside one BEGIN/COMMIT block.
// Correctness depends on a single synchronous Node.js process — no multi-process
// fleet, no connection pool. Moving to Postgres is required before relaxing this.
import {
  addHandoff,
  claimTaskAtomic,
  getBlockers,
  getDependents,
  getHandoffs,
  getTask,
  hasEventOfKind,
  leaseMs,
  listChildren,
  listExpiredLeases,
  listRatifiedTasks,
  listReadyStatusTasks,
  listTasksByOwnerSid,
  logEvent,
  planTransaction,
  type SetTaskStatusExtra,
  setLeaseExpiry,
  setRollupSignaled,
  setTaskStatus,
  type TaskRow,
} from "./store.js";

// C2: work-steal hook. Fires when a task auto-promotes to ready so the hub can
// synthesize a wake message for idle instances. Single slot — last writer wins;
// set by server.ts during init. Null = no-op (safe for unit tests that don't wire it).
let onTaskReady: ((taskId: string, projectId: string) => void) | null = null;

export function setOnTaskReadyHook(fn: ((taskId: string, projectId: string) => void) | null): void {
  onTaskReady = fn;
}

const TRANSITIONS: Record<string, readonly string[]> = {
  proposed: ["ratified", "abandoned"],
  ratified: ["abandoned"], // →ready is hub-controlled (auto-unblock), never set by an agent
  ready: ["abandoned"], // →claimed only via atomic /task-claim
  claimed: ["in_progress", "ready", "abandoned"], // ready = release/unclaim
  in_progress: ["review", "blocked", "failed", "abandoned"],
  review: ["done", "in_progress", "abandoned"], // review→in_progress = reject
  blocked: ["in_progress", "abandoned"],
  done: [],
  failed: [],
  abandoned: [],
};

const VALID_STATUSES = new Set(Object.keys(TRANSITIONS));

// Canonical lane order for the board view — the insertion order of TRANSITIONS,
// which reads left-to-right as a task's lifecycle. Single source of truth so the
// board can't drift from the state machine.
export const STATUS_ORDER: readonly string[] = Object.keys(TRANSITIONS);

export function isTerminal(status: string): boolean {
  return status === "done" || status === "failed" || status === "abandoned";
}

export function isValidStatus(status: string): boolean {
  return VALID_STATUSES.has(status);
}

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export type TransitionResult = { ok: true; task: TaskRow } | { ok: false; code: number; error: string };

// F2 owner-gating. Once a task is claimed it has an owner, and only that owner
// drives its work. The lone exception is the review gate: `review→done` is a
// second-party approval that must come from someone OTHER than the owner (no
// self-merge), while `review→in_progress` (reject / pull-back) is open to
// either party. Pre-claim tasks (owner == null) are ungated — any join-token
// holder may ratify/abandon. The admin override (forceTransition) never calls this.
function ownerGate(task: TaskRow, to: string, actor: string | null): { code: number; error: string } | null {
  if (!task.owner) return null;
  if (task.status === "review") {
    if (to === "done") {
      if (!actor || actor === task.owner) {
        return { code: 403, error: "review→done requires a different actor than the owner (no self-merge)" };
      }
      return null;
    }
    if (to === "in_progress") return null; // reviewer rejects or owner pulls back — either is fine
  }
  if (actor !== task.owner) {
    return { code: 403, error: `Only the owner (${task.owner}) may transition this claimed task` };
  }
  return null;
}

export function transitionTask(
  taskId: string,
  to: string,
  actor: string | null,
  note?: string | null,
): TransitionResult {
  return planTransaction((): TransitionResult => {
    const task = getTask(taskId);
    if (!task) return { ok: false, code: 404, error: `Task "${taskId}" not found` };
    if (!canTransition(task.status, to)) {
      return { ok: false, code: 409, error: `Illegal transition ${task.status} → ${to}` };
    }
    const gate = ownerGate(task, to, actor);
    if (gate) return { ok: false, code: gate.code, error: gate.error };
    const extra: SetTaskStatusExtra = { doneAt: isTerminal(to) ? Date.now() : null };
    // Releasing a claim (claimed→ready) returns the task to the pool — clear
    // ownership AND the lease so it is cleanly claimable again and not owner-gated
    // or stale-leased while idle.
    if (to === "ready") {
      extra.owner = null;
      extra.ownerSid = null;
      extra.claimedAt = null;
      extra.leaseExpiresAt = null;
    }
    setTaskStatus(taskId, to, extra);
    logEvent(taskId, { actor, kind: "transition", fromStatus: task.status, toStatus: to, note: note ?? null });
    applyPostTransitionEffects(to, taskId);
    // S2-1: a release (claimed→ready) re-enters the pool, so re-check readiness —
    // a blocker added while the task was claimed must knock it back to ratified
    // instead of being silently re-advertised as ready. Deliberately NOT folded
    // into applyPostTransitionEffects so admin-force→ready stays a true override.
    if (to === "ready") demoteIfBlocked(taskId);
    // Re-entering active work (claimed→in_progress, or resuming from review/blocked)
    // renews the lease — an owner-driven transition is itself a liveness signal.
    // The PRIMARY renewal is still the all-tools heartbeat (4B); this is a bonus.
    if (to === "in_progress") setLeaseExpiry(taskId, Date.now() + leaseMs());
    const updated = getTask(taskId);
    // updated cannot be undefined — we just transitioned an existing row. The
    // status returned reflects any auto-promotion (ratified→ready) the hub applied.
    return { ok: true, task: updated as TaskRow };
  });
}

// Side-effects shared by the normal transition path AND the admin override, so
// the same invariants hold however a task reached its new status: a freshly
// ratified task may auto-promote to ready; a freshly completed task may unblock
// its dependents; a child reaching terminal may complete a parent's roll-up.
function applyPostTransitionEffects(to: string, taskId: string): void {
  if (to === "ratified") promoteIfReady(taskId);
  else if (to === "done") propagateUnblock(taskId);
  else if (to === "failed" || to === "abandoned") propagateWedge(taskId); // surface newly-wedged dependents (flag #1)
  if (isTerminal(to)) maybeRollupParent(taskId);
}

// Parent roll-up. When a child reaches a terminal state and that leaves EVERY
// child of its parent terminal, the hub does two things:
//   (1) emits a one-time `rollup` SIGNAL on the parent (idempotent via the D3
//       rollup_signaled column) so the operator knows the decomposition resolved; and
//   (2) W4.1-c — AUTO-COMPLETES the parent to `done`, but ONLY when every child is
//       `done`. A parent/epic otherwise has no path to terminal (ready→done is
//       illegal in the allow-list, ready→in_progress needs a claim), so an
//       all-done epic would sit at ready/proposed forever. This is hub-controlled,
//       exactly like promoteIfReady setting `ready` — it deliberately bypasses the
//       agent allow-list because the hub, not an agent, owns roll-up completion.
// GUARD: a failed/abandoned child is terminal but not `done`; it still gets the
// signal but must NOT auto-complete the parent — partial failure is the operator's
// call (re-open the child, drop it, or close the parent by hand).
// IDEMPOTENT — and the two guards are intentionally SEPARATE: the signal is guarded
// by rollup_signaled, the completion by the parent already being terminal (`done`
// has no re-entry). They must not share a guard: if a failed child is later
// force-reopened and driven to `done`, the signal must not re-fire yet the
// now-all-done parent must still complete — so completion cannot sit behind
// rollup_signaled.
// NESTED: completing the parent is itself a terminal transition, so we re-run the
// standard `done` side-effects on it (propagateUnblock + roll ITS parent up),
// which completes grandparents bottom-up. The whole chain runs inside the caller's
// D1 transaction, so nested completion is atomic.
function maybeRollupParent(childId: string): void {
  const child = getTask(childId);
  if (!child?.parent_id || !isTerminal(child.status)) return;
  const parentId = child.parent_id;
  const parent = getTask(parentId);
  if (!parent) return;
  const children = listChildren(parentId);
  if (children.length === 0 || !children.every((c) => isTerminal(c.status))) return;

  // (1) one-time rollup signal — all children terminal, any outcome mix.
  if (!parent.rollup_signaled) {
    setRollupSignaled(parentId); // D3: mark before logging (atomic under D1 transaction)
    const done = children.filter((c) => c.status === "done").length;
    logEvent(parentId, {
      actor: null,
      kind: "rollup",
      note: `all ${children.length} children terminal (${done} done)`,
    });
  }

  // (2) auto-complete — only when EVERY child is `done` and the parent isn't
  // already terminal. Mirror a normal done transition's effects so a hub-completed
  // parent unblocks its dependents and rolls up into its own parent (recurses up).
  if (!isTerminal(parent.status) && children.every((c) => c.status === "done")) {
    setTaskStatus(parentId, "done", { doneAt: Date.now() });
    logEvent(parentId, {
      actor: null,
      kind: "transition",
      fromStatus: parent.status,
      toStatus: "done",
      note: "auto-complete: all children done",
    });
    applyPostTransitionEffects("done", parentId);
  }
}

// Operator override: force a task to any valid status, bypassing the allow-list.
// Admin-token only (the endpoint enforces that). Still validates the target is a
// real status so a typo can't wedge a task into a dead state.
export function forceTransition(taskId: string, to: string, actor: string | null): TransitionResult {
  return planTransaction((): TransitionResult => {
    const task = getTask(taskId);
    if (!task) return { ok: false, code: 404, error: `Task "${taskId}" not found` };
    if (!isValidStatus(to)) return { ok: false, code: 400, error: `Unknown status "${to}"` };
    setTaskStatus(taskId, to, { doneAt: isTerminal(to) ? Date.now() : null });
    logEvent(taskId, { actor, kind: "transition", fromStatus: task.status, toStatus: to, note: "admin-force" });
    applyPostTransitionEffects(to, taskId);
    return { ok: true, task: getTask(taskId) as TaskRow };
  });
}

// Take a task: ready→claimed via the atomic store UPDATE. 404 if the task is
// gone, 409 if it wasn't `ready` (already claimed, not yet promoted, or terminal).
// The conditional UPDATE is the ONLY thing standing between two racing claimants.
export function claimTask(
  taskId: string,
  owner: string,
  ownerSid: string | null,
  actor: string | null,
): TransitionResult {
  return planTransaction((): TransitionResult => {
    if (!getTask(taskId)) return { ok: false, code: 404, error: `Task "${taskId}" not found` };
    if (!claimTaskAtomic(taskId, owner, ownerSid)) {
      const cur = getTask(taskId);
      return { ok: false, code: 409, error: `Task is ${cur?.status ?? "gone"}, not claimable (must be ready)` };
    }
    logEvent(taskId, { actor: actor ?? owner, kind: "claim", fromStatus: "ready", toStatus: "claimed", note: owner });
    return { ok: true, task: getTask(taskId) as TaskRow };
  });
}

// Only these states hold a live lease — the "death mid-work" window. review and
// blocked are PARKED (the owner is legitimately idle), so they are neither
// lease-renewable nor lease-reclaimable (R1).
const LEASE_GOVERNED = new Set(["claimed", "in_progress"]);

// Renew a task's lease — SLIDING (now + leaseMs, never accumulate; C1). Only the
// holding session may renew, and only while the task is lease-governed.
// 404 missing / 409 not lease-governed / 403 wrong session.
export function heartbeatTask(taskId: string, ownerSid: string): TransitionResult {
  const task = getTask(taskId);
  if (!task) return { ok: false, code: 404, error: `Task "${taskId}" not found` };
  if (!LEASE_GOVERNED.has(task.status)) {
    return { ok: false, code: 409, error: `Task is ${task.status}, not lease-governed` };
  }
  if (task.owner_sid !== ownerSid) return { ok: false, code: 403, error: "Not the lease holder" };
  setLeaseExpiry(taskId, Date.now() + leaseMs());
  return { ok: true, task: getTask(taskId) as TaskRow };
}

export interface Renewed {
  id: string;
  projectId: string;
}

// Step 4B: the all-tools heartbeat hook only knows the SESSION id, not task ids.
// Renew EVERY lease-governed task this session holds in one sliding write
// (now + leaseMs, never accumulate; C1). Parked review/blocked are skipped (R1),
// so a heartbeat can never resurrect a parked task's lease, and another session's
// tasks are never touched (the query is scoped to ownerSid). Returns the renewed
// tasks so the caller can emit a coarse refetch trigger per task (no task_event).
export function heartbeatByOwnerSid(ownerSid: string): Renewed[] {
  const expiry = Date.now() + leaseMs();
  const renewed: Renewed[] = [];
  for (const t of listTasksByOwnerSid(ownerSid)) {
    if (!LEASE_GOVERNED.has(t.status)) continue;
    setLeaseExpiry(t.id, expiry);
    renewed.push({ id: t.id, projectId: t.project_id });
  }
  return renewed;
}

export interface Reclaimed {
  id: string;
  projectId: string;
}

// Lazy lease-guard. Reclaim every expired held task (claimed/in_progress only —
// R1) as a FORCED release: back to ready, ownership + lease cleared, logged. It
// bypasses owner-gating (the holder is presumed dead, so it can't route through
// owner-gated transitionTask) but MUST run the same readiness re-check as a normal
// release — otherwise an undone blocker would re-advertise the task as ready, the
// S2-1 hazard via the lease door. Returns the reclaimed tasks so the caller can
// emit a board update for each. No setInterval — runs on read (flag #2).
export function reclaimExpiredLeases(now: number): Reclaimed[] {
  const reclaimed: Reclaimed[] = [];
  for (const t of listExpiredLeases(now)) {
    // D1: wrap each task's reclaim in a transaction — status update, event, readiness
    // re-check, and optional synthetic handoff are all-or-nothing per task.
    planTransaction(() => {
      setTaskStatus(t.id, "ready", { owner: null, ownerSid: null, claimedAt: null, leaseExpiresAt: null });
      logEvent(t.id, {
        actor: null,
        kind: "lease_expired",
        fromStatus: t.status,
        toStatus: "ready",
        note: `lease expired (held by ${t.owner ?? "?"})`,
      });
      demoteIfBlocked(t.id);
      // Step 5 (S5-1): if the dying owner left a real handoff during THIS ownership
      // (a non-system note since claimed_at), that note is the graceful breadcrumb —
      // keep it as the latest so the next claimant resumes with it. Only when no such
      // note exists do we append the synthetic "no graceful handoff" marker, so the
      // synthetic never shadows (or contradicts) a real one.
      const gracefulHandoff = getHandoffs(t.id).some((h) => !h.system && h.ts >= (t.claimed_at ?? 0));
      if (!gracefulHandoff) {
        addHandoff(t.id, null, {
          summary: `Reclaimed from ${t.owner ?? "?"} mid-${t.status}; lease expired with no graceful handoff.`,
          next_step: null,
          blockers: [],
          system: true,
        });
      }
    });
    reclaimed.push({ id: t.id, projectId: t.project_id });
  }
  return reclaimed;
}

// Adding edge taskId → blocksOn (taskId depends on blocksOn) closes a cycle iff
// blocksOn already (transitively) depends on taskId. DFS over the blockers graph.
export function wouldCreateCycle(taskId: string, blocksOn: string): boolean {
  if (taskId === blocksOn) return true;
  const seen = new Set<string>();
  const stack: string[] = [blocksOn];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const b of getBlockers(cur)) stack.push(b);
  }
  return false;
}

// `ready` is a stored state the hub alone maintains — never set by an agent. A
// blocker counts as satisfied ONLY when it is `done`; a failed/abandoned blocker
// leaves the dependent waiting (surface to operator) — build flag #1.
function allBlockersDone(taskId: string): boolean {
  return getBlockers(taskId).every((b) => getTask(b)?.status === "done");
}

// Wave-4 (d) — surface the silent dead-blocker wedge (build flag #1).
//
// allBlockersDone above is correctly fail-CLOSED: a blocker that is missing,
// failed, or abandoned is not `done`, so the dependent is never auto-promoted.
// That guard must NOT change (promoting on a broken dep is the real hazard). The
// gap it leaves is diagnostic: such a blocker can never reach `done` (failed and
// abandoned are terminal; a missing row can't reappear), so the dependent waits
// FOREVER with no signal. These read-only classifiers + a one-shot event surface
// that wedge so an operator can intervene (re-open the blocker, drop the dep, or
// abandon the dependent). They never mutate task status → no promotion-path risk.
export type DeadBlockerReason = "missing" | "failed" | "abandoned";

export interface DeadBlocker {
  blockerId: string;
  reason: DeadBlockerReason;
}

export interface WedgedTask {
  taskId: string;
  projectId: string;
  deadBlockers: DeadBlocker[];
}

// Classify one blocker as permanently unsatisfiable, or null when it is either
// already satisfied (`done`) or still legitimately pending (any non-terminal
// state — it may yet reach done, so it is NOT a wedge).
function deadBlockerReason(blockerId: string): DeadBlockerReason | null {
  const b = getTask(blockerId);
  if (!b) return "missing";
  if (b.status === "failed") return "failed";
  if (b.status === "abandoned") return "abandoned";
  return null;
}

// A task's permanently-unsatisfiable blockers (empty = not wedged on a dead dep).
export function deadBlockers(taskId: string): DeadBlocker[] {
  const out: DeadBlocker[] = [];
  for (const b of getBlockers(taskId)) {
    const reason = deadBlockerReason(b);
    if (reason) out.push({ blockerId: b, reason });
  }
  return out;
}

// Every ratified task wedged on a dead blocker, with reasons — the on-demand
// diagnostic counterpart to the one-shot blocker_wedge event. Pure read: no
// mutation, no promotion change.
export function wedgedTasks(): WedgedTask[] {
  const out: WedgedTask[] = [];
  for (const t of listRatifiedTasks()) {
    const dead = deadBlockers(t.id);
    if (dead.length > 0) out.push({ taskId: t.id, projectId: t.project_id, deadBlockers: dead });
  }
  return out;
}

// Emit a ONE-SHOT blocker_wedge event for a ratified task whose promotion is
// blocked by a dead (not merely pending) blocker. Idempotent via hasEventOfKind so
// repeated promotion attempts / additional blocker deaths don't spam the feed; the
// live truth is always deadBlockers()/wedgedTasks(). Append-only event → safe
// inside the caller's transaction, and it can never 500 a live task.
function signalWedgeIfDead(taskId: string): void {
  const task = getTask(taskId);
  if (!task || task.status !== "ratified") return;
  const dead = deadBlockers(taskId);
  if (dead.length === 0) return; // blockers merely pending — legitimate wait, not a wedge
  if (hasEventOfKind(taskId, "blocker_wedge")) return; // already surfaced
  const detail = dead.map((d) => `${d.blockerId}:${d.reason}`).join(", ");
  logEvent(taskId, { actor: null, kind: "blocker_wedge", note: `wedged — dead blocker(s): ${detail}` });
}

// Promote a ratified task to ready the instant all its blockers are done
// (vacuously true with no blockers). The hub is the SOLE setter of `ready`.
export function promoteIfReady(taskId: string): boolean {
  const task = getTask(taskId);
  if (!task || task.status !== "ratified") return false;
  if (!allBlockersDone(taskId)) {
    signalWedgeIfDead(taskId); // build flag #1: surface a dead-dep wedge (no-op while merely pending)
    return false;
  }
  setTaskStatus(taskId, "ready");
  logEvent(taskId, {
    actor: null,
    kind: "transition",
    fromStatus: "ratified",
    toStatus: "ready",
    note: "auto-unblock",
  });
  onTaskReady?.(taskId, task.project_id); // C2: notify work-steal subscribers
  return true;
}

// A ready task that gains an unsatisfied blocker must fall back to ratified, or
// its status would claim "ready" while a prerequisite is unfinished (the F1
// divergence). The hub re-promotes it once that blocker completes.
export function demoteIfBlocked(taskId: string): boolean {
  const task = getTask(taskId);
  if (!task || task.status !== "ready") return false;
  if (allBlockersDone(taskId)) return false;
  setTaskStatus(taskId, "ratified");
  logEvent(taskId, { actor: null, kind: "transition", fromStatus: "ready", toStatus: "ratified", note: "re-blocked" });
  return true;
}

// After a task reaches done, re-evaluate every task that was blocked on it.
export function propagateUnblock(doneTaskId: string): void {
  for (const dep of getDependents(doneTaskId)) promoteIfReady(dep);
}

// The other-terminal counterpart of propagateUnblock: when a task reaches
// failed/abandoned, its dependents lose that prerequisite forever (failed and
// abandoned are terminal). The fail-closed guard already keeps them correctly
// un-promoted, but at this moment promoteIfReady is NOT re-run on them (only `done`
// triggers propagateUnblock), so the wedge would otherwise stay silent. Surface
// each newly-wedged dependent. Pure diagnostic — never changes a dependent's status.
export function propagateWedge(deadTaskId: string): void {
  for (const dep of getDependents(deadTaskId)) signalWedgeIfDead(dep);
}

// `ready` is authoritative — list it directly (no on-read recomputation).
export function listReadyTasks(): TaskRow[] {
  return listReadyStatusTasks();
}

// C1: ack-wake. When a BLOCKING-prefixed message is acknowledged by its
// recipient, the hub unblocks every task the sender's session holds in
// `blocked` status. Uses forceTransition (bypasses owner gate) because the
// trigger is a system event (the ack), not the task owner driving the move.
// Returns the IDs of tasks that were successfully unblocked.
export function unblockOnAck(ownerSid: string, actor: string | null): string[] {
  const unblocked: string[] = [];
  for (const t of listTasksByOwnerSid(ownerSid)) {
    if (t.status !== "blocked") continue;
    const result = forceTransition(t.id, "in_progress", actor);
    if (result.ok) {
      setLeaseExpiry(t.id, Date.now() + leaseMs());
      unblocked.push(t.id);
    }
  }
  return unblocked;
}
