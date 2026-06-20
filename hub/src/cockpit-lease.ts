// Pure lease-clock math for the cockpit. Leases are stamped on the SERVER clock
// (lease_expires_at, claimed_at), so a countdown rendered against the phone's
// (possibly skewed) clock would lie. The dashboard captures one offset at fetch
// time — serverClockOffset(serverNow, clientNow) — and every tick re-derives the
// effective server time as clientNow + offset. DOM-free so it can be unit-tested;
// a verbatim copy lives in the dashboard <script>. Keep the two identical.

import { STALL_BEAT_MS } from "./constants.js";

export type LeaseUrgency = "ok" | "soon" | "urgent" | "expired";

export interface LeaseState {
  hasLease: boolean;
  /** Whole seconds remaining on the server clock, clamped at 0. */
  secondsLeft: number;
  urgency: LeaseUrgency;
  /** "mm:ss left", or "expired", or "—" when there is no lease. */
  label: string;
  /** Remaining fraction of the claim→expiry window for a progress bar, 0..1.
   *  null when there is no lease, no claim time, or no sizeable window. */
  fraction: number | null;
}

const URGENT_S = 60;
const SOON_S = 300;

// C5 stall radar: claimed→in_progress is optional and reclaim is on-read only, so
// the board can't tell "actively working" from "stalled" until the (default 30min)
// lease lapses. A claimed/in_progress task whose owning session has gone quiet —
// no heartbeat/board-update in STALL_BEAT_MS — while its lease is STILL VALID is a
// likely dead agent. This is distinct from (and fires BEFORE) the A3 expired-lease
// "reclaim pending" chip: that one is lease-lapsed; this one is an early warning.
// The board-update heartbeat fires on tool use (<=15s typically) but a single long
// tool call / blocked subagent can be legitimately silent for minutes, so the
// threshold sits at ~2x a conservative 2min cadence (4min) to avoid false alarms.
// STALL_BEAT_MS is imported from ./constants.js — the single source of truth (C5).
// The browser copy in cockpit-ui.ts injects the same canonical value at build time.

/** Signed gap between the server and client clocks: add it to a client time to
 *  land on the server timeline. Positive when the server clock is ahead. */
export function serverClockOffset(serverNow: number, clientNow: number): number {
  return serverNow - clientNow;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function leaseState(opts: {
  claimedAt: number | null;
  leaseExpiresAt: number | null;
  clientNow: number;
  offset: number;
}): LeaseState {
  const { claimedAt, leaseExpiresAt, clientNow, offset } = opts;

  if (leaseExpiresAt == null) {
    return { hasLease: false, secondsLeft: 0, urgency: "ok", label: "—", fraction: null };
  }

  const effectiveNow = clientNow + offset;
  const remainingMs = leaseExpiresAt - effectiveNow;
  const secondsLeft = remainingMs <= 0 ? 0 : Math.floor(remainingMs / 1000);

  let urgency: LeaseUrgency;
  if (remainingMs <= 0) urgency = "expired";
  else if (secondsLeft < URGENT_S) urgency = "urgent";
  else if (secondsLeft < SOON_S) urgency = "soon";
  else urgency = "ok";

  const label =
    urgency === "expired" ? "expired" : `${pad2(Math.floor(secondsLeft / 60))}:${pad2(secondsLeft % 60)} left`;

  let fraction: number | null;
  if (remainingMs <= 0) {
    fraction = 0;
  } else if (claimedAt == null) {
    fraction = null;
  } else {
    const window = leaseExpiresAt - claimedAt;
    fraction = window > 0 ? clamp01(remainingMs / window) : null;
  }

  return { hasLease: true, secondsLeft, urgency, label, fraction };
}

export interface StallState {
  /** ms since the owning session's last heartbeat/board-update; null when unknown. */
  beatAgeMs: number | null;
  /** True when the owner has gone quiet past STALL_BEAT_MS while the lease is still
   *  valid (lease present and not yet expired) — a likely-dead agent the board would
   *  otherwise hide until the lease lapses. Never true once the lease has expired
   *  (the A3 reclaim chip owns that case). */
  stalled: boolean;
  /** "Nm idle" / "Ns idle" for the badge, or null when not stalled. */
  label: string | null;
}

/** Pure stall-radar math. `lastSeenAt` is the owning session's last-seen time on the
 *  SERVER clock (0/null when the session is unknown or never beat). `clientNow + offset`
 *  re-derives effective server time, mirroring leaseState. A task only stalls while
 *  its lease is present AND not yet expired — so an expired lease (handled by the A3
 *  reclaim chip) never double-flags as stalled. */
export function stallState(opts: {
  lastSeenAt: number | null;
  leaseExpiresAt: number | null;
  clientNow: number;
  offset: number;
}): StallState {
  const { lastSeenAt, leaseExpiresAt, clientNow, offset } = opts;
  const effectiveNow = clientNow + offset;

  // No live lease, or already expired → not our case (A3 reclaim chip owns expired).
  if (leaseExpiresAt == null || leaseExpiresAt - effectiveNow <= 0) {
    return { beatAgeMs: null, stalled: false, label: null };
  }
  // Unknown/never-seen owner: can't measure a beat age, so don't false-alarm.
  if (lastSeenAt == null || lastSeenAt <= 0) {
    return { beatAgeMs: null, stalled: false, label: null };
  }

  const beatAgeMs = Math.max(0, effectiveNow - lastSeenAt);
  const stalled = beatAgeMs > STALL_BEAT_MS;
  if (!stalled) return { beatAgeMs, stalled: false, label: null };

  const mins = Math.floor(beatAgeMs / 60_000);
  const label = mins >= 1 ? `${mins}m idle` : `${Math.floor(beatAgeMs / 1000)}s idle`;
  return { beatAgeMs, stalled: true, label };
}
