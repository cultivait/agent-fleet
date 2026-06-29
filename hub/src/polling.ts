import type { IncomingMessage, ServerResponse } from "node:http";
import { isPersistentUser } from "./auth.js";
import { dbListRegistry, dbRegistryUpsert } from "./db.js";
import { drainQueue } from "./router.js";
import { deriveTmuxSession, resolveLiveTmuxSession, tmuxHasSession } from "./terminal.js";
import type { PendingPoll, RegistryEntry } from "./types.js";

const POLL_TIMEOUT_MS = 3_600_000; // 1 hour
const pendingPolls = new Map<string, PendingPoll>();

// Track users explicitly detected as offline (poll connection dropped).
// Registered users NOT in this set are considered online (default = online).
const offlineUsers = new Set<string>();

// Last time we saw any sign of life from a user (poll start/end, any auth'd
// request). Used to reap "ghosts" — sessions that died between polls, where no
// socket was open to drop, so onPollDisconnect never fired.
const lastSeen = new Map<string, number>();

export function touchLastSeen(userName: string): void {
  lastSeen.set(userName, Date.now());
}

export function getLastSeen(userName: string): number {
  return lastSeen.get(userName) ?? 0;
}

export function clearLastSeen(userName: string): void {
  lastSeen.delete(userName);
}

// True when the user is actively holding a long-poll open — the strongest
// liveness signal there is. Such users are never ghost-reaped.
export function hasOpenPoll(userName: string): boolean {
  return pendingPolls.has(userName);
}

let onDisconnectCallback: ((userName: string) => void) | null = null;

export function onPollDisconnect(cb: (userName: string) => void): void {
  onDisconnectCallback = cb;
}

export function isOnline(userName: string): boolean {
  return !offlineUsers.has(userName);
}

export function setOnline(userName: string): void {
  offlineUsers.delete(userName);
}

export function setOffline(userName: string): void {
  offlineUsers.add(userName);
}

// Startup reconcile pass — B3 offline-sweep + B4 duplicate-row reconcile fused into ONE coherent
// boot pass (no double-shed).
//
// B3 (offline-sweep): `isOnline` defaults to ONLINE for any callsign not in the in-memory
// `offlineUsers` set — but that set is empty on a fresh process, so after an unclean reboot every
// persisted registry row reads ONLINE even though its session is dead. That phantom-online state
// wedges vacancy checks (e.g. a dead-but-persisted REFEREE row makes `fleet_claim_referee` return
// 409 forever, since the reaper never frees a seat it believes is live). The fix: at boot, mark
// every persisted registry callsign OFFLINE as the baseline (dead until proven live). A live agent
// re-polls within one cycle and `handlePoll` flips it back online via setOnline; a dead seat never
// re-polls, so it stays offline and a claim can shed it. Persistent users (the virtual operator)
// are NOT swept — they have no live session to re-poll and must stay reachable; ensureOperatorPresence
// keeps them online.
//
// B4 (dup-row reconcile): become_referee's in-memory-only shed leaves a STALE duplicate registry row
// behind (callsign REFEREE / spawn_id null / control_handle null) alongside the LIVE referee row. Reap
// that ghost at the registry level: when a callsign has a LIVE-handle sibling (a control_handle that
// resolves to a live tmux session) AND a null/empty-handle duplicate, mark the null-handle dup
// status='signed_off'. CONSERVATIVE — only when a live sibling exists. If ALL handles are dead (full
// reboot, no tmux), the offline-sweep alone applies and NO row is signed_off. Liveness is probed with
// the SAME tmuxHasSession helper terminal.ts resolves sessions with; `hasSession` is injectable for tests.
export function reconcilePresenceFromRegistry(
  hasSession: (session: string) => boolean = tmuxHasSession,
): void {
  // Group rows by callsign so the sweep marks each callsign once AND the reconcile sees its siblings.
  const byCallsign = new Map<string, RegistryEntry[]>();
  for (const row of dbListRegistry()) {
    const callsign = row.callsign;
    if (!callsign) continue;
    const group = byCallsign.get(callsign);
    if (group) group.push(row);
    else byCallsign.set(callsign, [row]);
  }

  let swept = 0;
  let signedOff = 0;
  for (const [callsign, group] of byCallsign) {
    // B3: one OFFLINE mark per callsign. Persistent = operator/Operator only → leave online. A
    // principal-but-non-persistent callsign (e.g. REFEREE) IS swept — that dead seat is the wedge bug.
    if (!isPersistentUser(callsign)) {
      setOffline(callsign);
      swept++;
    }
    // B4 (unified): reap null-handle ghost dups via the canonical liveness derivation — see
    // reapableNullHandleGhosts. It recognizes a spawn_id-derived live sibling (not just tmux:-prefixed
    // handles) and spares a row that is itself the pre-enrich live seat.
    for (const r of reapableNullHandleGhosts(group, hasSession)) {
      dbRegistryUpsert({ session_id: r.session_id, status: "signed_off" });
      signedOff++;
    }
  }
  console.log(
    `[presence-reconcile] swept ${swept} persisted callsign(s) offline (dead until they re-poll); ` +
      `signed_off ${signedOff} stale duplicate row(s)`,
  );
}

// Shared liveness-aware ghost selector — the ONE place BOTH reconcile sites (startup B4 and
// reconcile-on-rejoin) decide which rows in a callsign group are reapable null-handle ghosts, so they
// judge liveness identically via the canonical resolveLiveTmuxSession + deriveTmuxSession (spawn_id-
// aware, NOT a tmux:-prefix-only check). A row is a reapable ghost iff:
//  • a VERIFIED-LIVE seat exists for the callsign (resolveLiveTmuxSession ≠ null) — conservative: with
//    no live seat (full reboot, all sessions dead) nothing is reaped, the offline-sweep alone applies;
//  • the row has a null/empty control_handle (the in-memory-shed signature; a dead-but-non-null handle
//    is left for the operator/boot, never auto-reaped);
//  • it is NOT itself live: a null-handle row whose spawn_id derives a LIVE session is the pre-enrich
//    live seat — sparing it fixes a latent over-reap the old tmux:-prefix-only gate could hit when a
//    callsign had two independently-live rows (one tmux:-handle, one spawn_id-derived);
//  • it has a session_id to key the upsert, isn't already signed_off, and isn't skipSessionId (the row
//    reconcile-on-rejoin just wrote).
function reapableNullHandleGhosts(
  group: RegistryEntry[],
  hasSession: (session: string) => boolean,
  skipSessionId?: string,
): RegistryEntry[] {
  if (group.length < 2) return [];
  const callsign = group[0]?.callsign;
  if (!callsign) return [];
  if (!resolveLiveTmuxSession(callsign, group, hasSession)) return []; // no live seat → reap nothing
  const ghosts: RegistryEntry[] = [];
  for (const r of group) {
    if (skipSessionId && r.session_id === skipSessionId) continue; // never the row reconcile-on-rejoin wrote
    if (r.control_handle || !r.session_id) continue; // only null-handle rows with a key to upsert
    if (r.status === "signed_off") continue; // already retired
    const session = deriveTmuxSession(r);
    if (session && hasSession(session)) continue; // this null-handle row is itself live → spare it
    ghosts.push(r);
  }
  return ghosts;
}

// Reconcile-on-rejoin (post-outage hardening, incident 2026-06-28). The B4 dup-row reconcile above
// only runs at startup, so a ghost row left mid-session lingers until the NEXT boot. That is exactly
// how 6eafd7 accumulated 2 null-handle ghosts: its spawn inherited a leaked sid, collided, regenerated
// to a fresh sid, and re-registered — the prior null-handle rows sat as ghosts until a hub bounce swept
// them. When a callsign re-registers a live session row, retire those leftovers NOW instead of waiting,
// applying the SAME reapableNullHandleGhosts rule as B4 (excluding the just-written keepSessionId row).
// Returns the rows it signed off so the caller can broadcast the live registry update.
export function reconcileRejoinDuplicates(
  callsign: string,
  keepSessionId: string,
  hasSession: (session: string) => boolean = tmuxHasSession,
): RegistryEntry[] {
  const group = dbListRegistry().filter((r) => r.callsign === callsign);
  return reapableNullHandleGhosts(group, hasSession, keepSessionId).map((r) =>
    dbRegistryUpsert({ session_id: r.session_id, status: "signed_off" }),
  );
}

export function addPoll(userName: string, req: IncomingMessage, res: ServerResponse): void {
  removePoll(userName);
  touchLastSeen(userName);

  console.log(`[poll-start] ${userName} waiting for messages...`);

  const timer = setTimeout(() => {
    pendingPolls.delete(userName);
    touchLastSeen(userName); // clean poll-end: give the agent a fresh window to re-poll
    console.log(`[poll-timeout] ${userName} (no messages after ${POLL_TIMEOUT_MS / 1000}s)`);
    res.writeHead(204);
    res.end();
  }, POLL_TIMEOUT_MS);

  pendingPolls.set(userName, { userName, res, timer });

  // Detect unexpected connection drop (agent crash, network loss).
  // Listen on req (not res) — more reliable when no response has been written yet.
  req.on("close", () => {
    if (!res.writableEnded && pendingPolls.has(userName)) {
      console.log(`[poll-disconnect] ${userName} connection dropped`);
      clearTimeout(timer);
      pendingPolls.delete(userName);
      onDisconnectCallback?.(userName);
    }
  });

  // Check if there are already queued messages
  const messages = drainQueue(userName);
  if (messages.length > 0) {
    clearTimeout(timer);
    pendingPolls.delete(userName);
    console.log(`[poll-immediate] ${userName} <- ${messages.length} queued message(s)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages }));
  }
}

export function deliverMessage(userName: string): void {
  const poll = pendingPolls.get(userName);
  if (!poll) return;

  const messages = drainQueue(userName);
  if (messages.length === 0) return;

  clearTimeout(poll.timer);
  pendingPolls.delete(userName);
  touchLastSeen(userName); // clean poll-end on delivery: fresh window to re-poll

  for (const m of messages) {
    if (m.image) {
      console.log(`[poll-deliver] ${userName} <- image (${m.image.mimeType}, ${m.image.data.length} chars base64)`);
    }
  }
  console.log(`[poll-deliver] ${userName} <- ${messages.length} message(s)`);

  poll.res.writeHead(200, { "Content-Type": "application/json" });
  poll.res.end(JSON.stringify({ messages }));
}

export function closeAllPolls(): void {
  for (const [, poll] of pendingPolls) {
    clearTimeout(poll.timer);
    if (!poll.res.writableEnded) {
      poll.res.writeHead(204);
      poll.res.end();
    }
  }
  pendingPolls.clear();
}

export function removePoll(userName: string): void {
  const poll = pendingPolls.get(userName);
  if (poll) {
    clearTimeout(poll.timer);
    pendingPolls.delete(userName);
    if (!poll.res.writableEnded) {
      poll.res.writeHead(204);
      poll.res.end();
    }
  }
}
