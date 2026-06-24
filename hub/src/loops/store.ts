// Loop governor — data layer + stop-condition evaluator (Phase 1).
//
// Makes "loops" first-class GOVERNED objects in the hub. The hub does NOT run an
// agent's inner loop: each agent runs its own loop in its own runtime and calls
// loop_tick() each iteration to get a continue/stop decision. This module is the
// GOVERNOR (registry + the synchronous stop-condition evaluator), never the executor.
//
// SINGLE-WRITER INVARIANT (mirrors plan/store.ts): correctness of the read-modify-write
// in tickLoop depends on better-sqlite3's synchronous execution — no await, no pool, no
// worker threads. The decision critical section runs inside a db.transaction() so two
// ticks can never interleave a SELECT with another tick's UPDATE.
//
// BUDGET NOTE (Phase 1 seam): token_budget is enforced from agent-reported tokens_delta
// only — cooperative trust. The hub holds NO authoritative token ledger (cost accounting
// lives in external per-host JSONL ledgers read by the metrics pipeline). A future
// fleet-wide Max-quota pool MUST cross-check that external ledger; this per-loop counter
// is the local guardrail, not the authoritative quota.
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { computeNextFire, fireDrift } from "./schedule.js";
import {
  type EvaluatorOptimizerConfig,
  evaluateVerdict,
  normalizeVerdict,
  type Verdict,
  type VerdictStopReason,
} from "./verdict.js";
// openApproval (below) opens the HITL queue item; createApproval is the txn-free INSERT.
import { createApproval } from "./approvals.js";

export type LoopStatus = "running" | "paused" | "stopped" | "completed";

// Base stop conditions plus the Phase-4 evaluator-optimizer outcomes (accepted/escalated/plateau).
export type StopReason =
  | "max_iterations"
  | "token_budget"
  | "wall_clock_timeout"
  | "completeness"
  | "confidence"
  | "repetition"
  | "diminishing_returns"
  | "external_terminate"
  | "paused"
  // Phase 4 evaluator-optimizer outcomes: "accepted" | "escalated" | "plateau".
  // "escalated" (HITL): verifier recommended escalate → loop PAUSED + approval opened.
  | VerdictStopReason;

export type { Verdict } from "./verdict.js";

// Composable stop-conditions (all optional; evaluated OR-wise, first-trip-wins).
export interface LoopConfig {
  max_iterations?: number; // hard backstop
  token_budget?: number; // agent-reported tokens; see BUDGET NOTE
  wall_clock_timeout_ms?: number; // now - created_at
  completeness_threshold?: number; // stop when reported completeness >= this
  confidence_threshold?: number; // stop when reported confidence >= this
  diminishing_returns?: { window: number; min_improvement: number };
  repetition?: { window: number };
  // Phase 4: evaluator-optimizer guardrails (used with reported verdicts; see verdict.ts).
  evaluator_optimizer?: EvaluatorOptimizerConfig;
  // Seam for a future fleet-wide pool. Phase 1 ignores the value beyond recording it.
  fleet_pool?: string | null;
}

// Mutable per-loop counters + the short ring buffers for repetition/diminishing detection.
export interface LoopState {
  iterations: number;
  tokens: number;
  improvements: number[]; // ring of recent `improvement` deltas
  signatures: string[]; // ring of recent opaque signature hashes (hub equality-compares only)
  last_completeness: number | null;
  last_confidence: number | null;
  scores: number[]; // Phase 4: ring of reported verdict completeness scores (the cockpit trajectory)
  last_verdict: Verdict | null; // Phase 4: most recent verdict (cockpit detail; Phase-5 reads recommendation)
}

export interface LoopRow {
  id: string;
  kind: string;
  owner_callsign: string;
  owner_sid: string | null; // forward-compat for future stale-loop lease reclaim (not implemented Phase 1)
  label: string;
  status: LoopStatus;
  config: string; // JSON LoopConfig
  state: string; // JSON LoopState
  stop_reason: string | null;
  created_at: number;
  updated_at: number;
  // Phase 3 recurring-schedule columns (nullable; NULL interval_ms = non-recurring).
  interval_ms: number | null;
  anchor_ms: number | null;
  last_fire_ms: number | null;
  next_fire_ms: number | null;
}

// Parsed view returned to callers (config/state decoded).
export interface Loop {
  id: string;
  kind: string;
  owner_callsign: string;
  owner_sid: string | null;
  label: string;
  status: LoopStatus;
  config: LoopConfig;
  state: LoopState;
  stop_reason: StopReason | null;
  created_at: number;
  updated_at: number;
  // Phase 3 recurring schedule (all null on non-recurring loops).
  interval_ms: number | null; // recurrence period (ms)
  anchor_ms: number | null; // wall-clock grid origin
  last_fire_ms: number | null; // actual time of last advancing tick
  next_fire_ms: number | null; // scheduled next fire (drift-corrected, off the grid)
}

export interface TickInput {
  iteration_delta?: number; // default 1
  tokens_delta?: number; // default 0
  improvement?: number; // optional progress delta for diminishing-returns
  completeness?: number; // optional 0..1
  confidence?: number; // optional 0..1
  signature?: string; // optional opaque hash for repetition detection
  // Phase 4/5: the verifier verdict for this iteration. recommendation:"escalate" trips the
  // HITL gate (pause + open approval); accept/retry feed the evaluator-optimizer decision.
  verdict?: Verdict; // already typed/validated (submitVerdict normalizes at the boundary)
}

export interface TickResult {
  continue: boolean;
  stop_reason?: StopReason;
  // Phase 3: present ONLY for recurring loops (interval_ms set). Absent on
  // non-recurring loops so the Phase-1 TickResult shape is byte-identical.
  next_fire_ms?: number; // drift-corrected next fire (omitted once the loop stops)
  last_fire_ms?: number; // wall-clock time this tick was recorded as a fire
  drift_ms?: number; // how late this fire was vs its intended grid slot
  // Phase 4/5: set only when an escalate verdict opened a HITL approval. openApproval runs
  // INSIDE this tick's txn and returns the id (cockpit/agent find the queue item by it).
  approval_id?: string;
}

// Keep the rings bounded regardless of config; max useful window is small.
const RING_CAP = 64;

let db: Database.Database;

export function initLoopSchema(database: Database.Database): void {
  db = database;

  db.exec(`
    CREATE TABLE IF NOT EXISTS loops (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      owner_callsign TEXT NOT NULL,
      owner_sid TEXT,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      config TEXT NOT NULL,
      state TEXT NOT NULL,
      stop_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      interval_ms INTEGER,
      anchor_ms INTEGER,
      last_fire_ms INTEGER,
      next_fire_ms INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loops_status ON loops (status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loops_owner ON loops (owner_callsign)`);

  // Forward-compat: add owner_sid to DBs created before this column existed.
  try {
    db.exec("ALTER TABLE loops ADD COLUMN owner_sid TEXT");
  } catch {
    /* column already exists */
  }

  // Phase 3 — recurring-loop scheduling columns (all nullable; a NULL interval_ms
  // means "not a recurring loop" → Phase-1 behavior is byte-identical). Same guarded
  // ALTER idiom as owner_sid so pre-existing DBs migrate forward without data loss.
  for (const col of [
    "interval_ms INTEGER", // recurrence period; NULL = non-recurring
    "anchor_ms INTEGER", // wall-clock grid origin (fires at anchor + N*interval)
    "last_fire_ms INTEGER", // actual wall-clock time of the last advancing tick
    "next_fire_ms INTEGER", // scheduled next fire, recomputed off the grid each tick
  ]) {
    try {
      db.exec(`ALTER TABLE loops ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
}

function genId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

// Backfill any missing fields so a state loaded from an older row (pre-Phase-4) is always
// well-formed — tickLoop reads state.scores, so it must never be undefined.
function hydrateState(s: Partial<LoopState>): LoopState {
  return {
    iterations: s.iterations ?? 0,
    tokens: s.tokens ?? 0,
    improvements: s.improvements ?? [],
    signatures: s.signatures ?? [],
    last_completeness: s.last_completeness ?? null,
    last_confidence: s.last_confidence ?? null,
    scores: s.scores ?? [],
    last_verdict: s.last_verdict ?? null,
  };
}

function freshState(): LoopState {
  return hydrateState({});
}

function parseRow(row: LoopRow): Loop {
  return {
    id: row.id,
    kind: row.kind,
    owner_callsign: row.owner_callsign,
    owner_sid: row.owner_sid,
    label: row.label,
    status: row.status,
    config: JSON.parse(row.config) as LoopConfig,
    state: hydrateState(JSON.parse(row.state) as Partial<LoopState>),
    stop_reason: (row.stop_reason as StopReason | null) ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    interval_ms: row.interval_ms ?? null,
    anchor_ms: row.anchor_ms ?? null,
    last_fire_ms: row.last_fire_ms ?? null,
    next_fire_ms: row.next_fire_ms ?? null,
  };
}

export interface CreateLoopOpts {
  kind: string;
  label: string;
  owner_callsign: string;
  owner_sid?: string | null;
  config?: LoopConfig;
  // Phase 3: set interval_ms to make this a RECURRING loop. anchor_ms is the
  // wall-clock grid origin (the schedule is anchor, anchor+interval, ...);
  // it defaults to the creation time. Omit interval_ms for a normal loop.
  interval_ms?: number | null;
  anchor_ms?: number | null;
}

export function createLoop(opts: CreateLoopOpts): Loop {
  const id = genId("loop");
  const now = Date.now();
  const config = opts.config ?? {};
  const state = freshState();

  // Recurring scheduling (Phase 3). A NULL interval keeps every schedule column
  // NULL → identical to a Phase-1 loop. computeNextFire validates interval_ms > 0
  // (throws → the endpoint maps it to 400).
  const interval = opts.interval_ms ?? null;
  let anchor: number | null = null;
  let nextFire: number | null = null;
  if (interval !== null) {
    anchor = opts.anchor_ms ?? now;
    nextFire = computeNextFire(anchor, interval, now);
  }

  db.prepare(
    `INSERT INTO loops (id, kind, owner_callsign, owner_sid, label, status, config, state, stop_reason, created_at, updated_at, interval_ms, anchor_ms, last_fire_ms, next_fire_ms)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, NULL, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    opts.kind,
    opts.owner_callsign,
    opts.owner_sid ?? null,
    opts.label,
    JSON.stringify(config),
    JSON.stringify(state),
    now,
    now,
    interval,
    anchor,
    nextFire,
  );
  return getLoop(id) as Loop;
}

export function getLoop(id: string): Loop | undefined {
  const row = db.prepare("SELECT * FROM loops WHERE id = ?").get(id) as LoopRow | undefined;
  return row ? parseRow(row) : undefined;
}

export function listLoops(filter?: { status?: LoopStatus; owner_callsign?: string }): Loop[] {
  let sql = "SELECT * FROM loops";
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.owner_callsign) {
    where.push("owner_callsign = ?");
    params.push(filter.owner_callsign);
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY created_at DESC";
  return (db.prepare(sql).all(...params) as LoopRow[]).map(parseRow);
}

function ring(arr: number[] | string[], v: number | string): void {
  (arr as unknown[]).push(v);
  if (arr.length > RING_CAP) arr.shift();
}

// ── The evaluator (pure, the critical piece) ───────────────────────────────────
// Returns the FIRST stop-condition that trips in priority order, or null to continue.
// Pure over (config, state, now, createdAt) so it is unit-testable in isolation.
export function evaluateStopConditions(
  config: LoopConfig,
  state: LoopState,
  now: number,
  createdAt: number,
): StopReason | null {
  if (config.max_iterations !== undefined && state.iterations >= config.max_iterations) {
    return "max_iterations";
  }
  if (config.token_budget !== undefined && state.tokens >= config.token_budget) {
    return "token_budget";
  }
  if (config.wall_clock_timeout_ms !== undefined && now - createdAt >= config.wall_clock_timeout_ms) {
    return "wall_clock_timeout";
  }
  if (
    config.completeness_threshold !== undefined &&
    state.last_completeness !== null &&
    state.last_completeness >= config.completeness_threshold
  ) {
    return "completeness";
  }
  if (
    config.confidence_threshold !== undefined &&
    state.last_confidence !== null &&
    state.last_confidence >= config.confidence_threshold
  ) {
    return "confidence";
  }
  // Repetition: the last `window` signatures are all identical (a stuck loop).
  if (config.repetition !== undefined) {
    const w = config.repetition.window;
    if (w >= 1 && state.signatures.length >= w) {
      const recent = state.signatures.slice(-w);
      if (recent.every((s) => s === recent[0])) return "repetition";
    }
  }
  // Diminishing returns: the last `window` improvements are all below min_improvement.
  if (config.diminishing_returns !== undefined) {
    const { window: w, min_improvement } = config.diminishing_returns;
    if (w >= 1 && state.improvements.length >= w) {
      const recent = state.improvements.slice(-w);
      if (recent.every((x) => x < min_improvement)) return "diminishing_returns";
    }
  }
  return null;
}

// ── loop_tick: THE core control point ──────────────────────────────────────────
// Agent reports progress each iteration; hub merges deltas, evaluates ALL stop
// conditions, and returns continue/stop. Wrapped in a single synchronous
// transaction (read → mutate → evaluate → write) so concurrent ticks are atomic.
export function tickLoop(id: string, input: TickInput): TickResult {
  const txn = db.transaction((tickInput: TickInput): TickResult => {
    const loop = getLoop(id);
    if (!loop) throw new Error(`Loop "${id}" not found`);

    // Parked / terminal states do not advance. Surface the recorded reason (e.g. "escalated"
    // for a loop parked at the HITL gate) rather than a flat "paused", so a re-tick keeps
    // reporting WHY it's parked; a normally-paused loop has no stop_reason and falls back to
    // "paused".
    if (loop.status === "paused") {
      return { continue: false, stop_reason: (loop.stop_reason as StopReason | null) ?? "paused" };
    }
    if (loop.status === "stopped" || loop.status === "completed") {
      return { continue: false, stop_reason: loop.stop_reason ?? undefined };
    }

    const state = loop.state;
    state.iterations += tickInput.iteration_delta ?? 1;
    state.tokens += tickInput.tokens_delta ?? 0;
    if (tickInput.improvement !== undefined) ring(state.improvements, tickInput.improvement);
    if (tickInput.signature !== undefined) ring(state.signatures, tickInput.signature);
    if (tickInput.completeness !== undefined) state.last_completeness = tickInput.completeness;
    if (tickInput.confidence !== undefined) state.last_confidence = tickInput.confidence;

    // Phase 4 — evaluator-optimizer verdict. Record the completeness score into the trajectory
    // and the full verdict, then let the verdict decision (accept/escalate/target/plateau) trip
    // FIRST — a judge's accept on the final allowed iteration should report "accepted", not the
    // generic cap. If the verdict only says "retry", the base stop-conditions below still apply
    // (max_iterations etc. remain the hard backstop on a stuck retry loop).
    let verdictReason: VerdictStopReason | null = null;
    const verdict = tickInput.verdict; // hoisted so the escalate branch can hand it to openApproval
    if (verdict !== undefined) {
      ring(state.scores, verdict.completeness);
      state.last_verdict = verdict;
      state.last_completeness = verdict.completeness; // keep completeness_threshold in sync with verdicts
      verdictReason = evaluateVerdict(loop.config.evaluator_optimizer, state.scores, verdict);
    }

    const now = Date.now();
    const reason = verdictReason ?? evaluateStopConditions(loop.config, state, now, loop.created_at);

    // Phase 3 schedule bookkeeping — computed once, used by every exit path below. A
    // recurring loop records THIS tick as a wall-clock FIRE (last_fire_ms) and its lateness
    // vs the grid (driftMs); non-recurring loops keep their schedule columns NULL and their
    // result shape byte-identical to Phase 1. (nextFire is computed AFTER the escalate gate
    // because it depends on whether the loop keeps running.)
    const recurring = loop.interval_ms != null;
    const lastFire = recurring ? now : loop.last_fire_ms;
    const driftMs = recurring
      ? fireDrift(loop.anchor_ms as number, loop.interval_ms as number, now)
      : undefined;

    // Phase 4↔5 HITL gate — escalate PAUSES (resumable), it does NOT terminally stop: a
    // stopped loop can't be resumed, which would strand the human-approval flow.
    // ATOMICITY (seam #4): persist the merged state + (recurring) stamp last_fire_ms here,
    // then openApproval flips status→'paused' / stop_reason→'escalated' AND opens the
    // idempotent pending approval. openApproval is TXN-FREE, so it nests in THIS tick txn:
    // state + pause + queue-item commit atomically (a dropped SSE can't strand a paused
    // loop with no approval). Status is still 'running' when openApproval reads it, so its
    // running-guard pauses exactly once. (verdictReason === "escalated" ⇒ verdict defined.)
    // SCHEDULE (seam #6): stamp last_fire_ms=now (the iteration DID fire) but FREEZE
    // next_fire_ms by NOT writing it — paused = awaiting human, must not fire; the first
    // advancing tick after resume re-arms next_fire off the grid.
    if (reason === "escalated" && verdict !== undefined) {
      db.prepare("UPDATE loops SET state = ?, updated_at = ?, last_fire_ms = ? WHERE id = ?").run(
        JSON.stringify(state),
        now,
        lastFire,
        id,
      );
      const approval_id = openApproval(id, verdict);
      const paused: TickResult = { continue: false, stop_reason: "escalated", approval_id };
      if (recurring) {
        paused.last_fire_ms = now;
        paused.drift_ms = driftMs;
      }
      return paused;
    }

    // Phase 3: re-arm the next fire off the grid (anchor + N*interval) — never "now +
    // interval" — so a late tick can't push the schedule forward. Cleared once the loop
    // terminally stops; for a non-recurring loop the column stays NULL.
    const nextFire: number | null =
      recurring && !reason
        ? computeNextFire(loop.anchor_ms as number, loop.interval_ms as number, now)
        : recurring
          ? null // stopped recurring loop: no future fire
          : loop.next_fire_ms;

    if (reason) {
      db.prepare(
        "UPDATE loops SET state = ?, status = 'stopped', stop_reason = ?, updated_at = ?, last_fire_ms = ?, next_fire_ms = ? WHERE id = ?",
      ).run(JSON.stringify(state), reason, now, lastFire, nextFire, id);
      const stopped: TickResult = { continue: false, stop_reason: reason };
      if (recurring) {
        stopped.last_fire_ms = now;
        stopped.drift_ms = driftMs;
      }
      return stopped;
    }
    db.prepare(
      "UPDATE loops SET state = ?, updated_at = ?, last_fire_ms = ?, next_fire_ms = ? WHERE id = ?",
    ).run(JSON.stringify(state), now, lastFire, nextFire, id);
    const cont: TickResult = { continue: true };
    if (recurring) {
      cont.last_fire_ms = now;
      cont.next_fire_ms = nextFire as number;
      cont.drift_ms = driftMs;
    }
    return cont;
  });
  return txn(input);
}

// ── submit_verdict: the evaluator-optimizer control point (Phase 4) ─────────────
// THE public entry for verdict-driven loops. Validates/normalizes an untrusted verdict at the
// boundary (throws on a malformed verdict — the endpoint maps that to 400), then routes it
// through tickLoop so a verdict also counts as one iteration and shares the same atomic,
// single-writer critical section. Defaults: iteration_delta 1, tokens_delta 0.
export function submitVerdict(
  id: string,
  rawVerdict: unknown,
  deltas?: { iteration_delta?: number; tokens_delta?: number },
): TickResult {
  const verdict = normalizeVerdict(rawVerdict);
  return tickLoop(id, {
    verdict,
    iteration_delta: deltas?.iteration_delta,
    tokens_delta: deltas?.tokens_delta,
  });
}

// ── openApproval: the HITL escalate → pause → open-queue-item primitive ─────────────
// THE integration seam (#4) between the loop engine and the HITL queue. Given a loop and
// the verifier's escalate verdict, it PAUSES the loop (status → "paused", stop_reason →
// "escalated") and opens (or returns the existing) pending approval, then returns the
// approval_id.
//
// Contract:
//  • SYNCHRONOUS and TRANSACTION-FREE — it issues plain statements and opens NO
//    db.transaction() of its own, so the CALLER wraps it in a transaction for atomicity
//    (tickLoop does today; at merge the engine's /loop-verdict escalate branch calls it
//    inside its own txn — better-sqlite3 forbids nested transactions, hence txn-free here).
//  • IDEMPOTENT — re-invoking for an already-parked loop re-pauses nothing (the status
//    guard skips it) and createApproval returns the existing pending item, so the same
//    approval_id comes back and no duplicate queue item is ever fanned out.
//  • Signature coordinated with linux-247e5e (wip/loop-phase4) so the engine lines up at
//    integration: openApproval(loopId, verdict) → approval_id.
export function openApproval(loopId: string, verdict: Verdict): string {
  const loop = getLoop(loopId);
  if (!loop) throw new Error(`Loop "${loopId}" not found`);
  // Only park a live loop; an already paused/stopped loop keeps its recorded reason.
  if (loop.status === "running") {
    db.prepare(
      "UPDATE loops SET status = 'paused', stop_reason = 'escalated', updated_at = ? WHERE id = ?",
    ).run(Date.now(), loopId);
  }
  const approval = createApproval({
    loop_id: loopId,
    reason: verdict.rationale ?? "verifier recommended escalate",
    verdict,
  });
  return approval.id;
}

// ── Lifecycle controls (owner/admin authorization is enforced at the endpoint layer) ──
export function pauseLoop(id: string): Loop | undefined {
  const loop = getLoop(id);
  if (!loop) return undefined;
  if (loop.status === "running") {
    db.prepare("UPDATE loops SET status = 'paused', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }
  return getLoop(id);
}

export function resumeLoop(id: string): Loop | undefined {
  const loop = getLoop(id);
  if (!loop) return undefined;
  if (loop.status === "paused") {
    // Clear stop_reason on resume. An escalate-pause records stop_reason='escalated'; once
    // resumed (e.g. HITL approve = resumeLoop) the loop is running again and must NOT carry
    // the stale reason — and since the parked-state short-circuit echoes stop_reason, a later
    // *manual* pause would otherwise mis-report 'escalated' on its re-tick. Resume → clean slate.
    db.prepare("UPDATE loops SET status = 'running', stop_reason = NULL, updated_at = ? WHERE id = ?").run(
      Date.now(),
      id,
    );
  }
  return getLoop(id);
}

// Terminal stop. `reason` defaults to external_terminate (operator/cockpit kill).
export function stopLoop(id: string, reason: StopReason = "external_terminate"): Loop | undefined {
  const loop = getLoop(id);
  if (!loop) return undefined;
  if (loop.status !== "stopped" && loop.status !== "completed") {
    db.prepare(
      "UPDATE loops SET status = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ?",
    ).run(reason, Date.now(), id);
  }
  return getLoop(id);
}
