// Phase 3 — wall-clock, drift-tolerant recurring scheduler (pure).
//
// Recurring loops fire on a wall-clock GRID anchored at `anchor_ms`:
//   anchor, anchor+interval, anchor+2*interval, ...
// The re-arm rule is the whole point of this phase: the NEXT fire is computed
// from the grid (anchor + N*interval), NOT "now + interval". So a late tick does
// not push the schedule forward — drift never accumulates. A tick that overshoots
// one or more slots COALESCES to the next future grid point (we do NOT fire a
// burst to "catch up"). Timers are FLOORS (the earliest a fire may happen), not
// deadlines.
//
// Every function here is pure over its (anchor, interval, now) arguments — no
// Date.now(), no I/O — so the drift math is unit-testable in isolation. The hub
// stays the GOVERNOR: it records the schedule-of-record; the agent owns its own
// timer and asks the hub (via loop_tick) for the drift-corrected next fire. No
// hub-side firing daemon exists, so nothing here can block the message-poll phase.
import type { Loop } from "./store.js";

function assertInterval(intervalMs: number): void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("interval_ms must be a positive, finite number");
  }
}

/**
 * The grid fire-slot at or before `now`: the largest `anchor + k*interval` that is
 * <= now. Clamps to the anchor before the schedule has started. Used to measure
 * how late an actual fire was (its intended slot).
 */
export function scheduledFireAtOrBefore(anchorMs: number, intervalMs: number, nowMs: number): number {
  assertInterval(intervalMs);
  if (nowMs <= anchorMs) return anchorMs;
  const periods = Math.floor((nowMs - anchorMs) / intervalMs);
  return anchorMs + periods * intervalMs;
}

/**
 * The next fire-slot STRICTLY AFTER `now` — the drift-free re-arm value.
 * Before the anchor, the first fire is the anchor itself. On an exact grid point,
 * the NEXT slot is returned (we never re-arm to `now` itself).
 */
export function computeNextFire(anchorMs: number, intervalMs: number, nowMs: number): number {
  assertInterval(intervalMs);
  if (nowMs < anchorMs) return anchorMs;
  const periods = Math.floor((nowMs - anchorMs) / intervalMs) + 1;
  return anchorMs + periods * intervalMs;
}

/**
 * How late a fire that actually happened at `actualMs` was, relative to its
 * intended grid slot. >= 0 in normal operation; 0 means dead-on the grid.
 */
export function fireDrift(anchorMs: number, intervalMs: number, actualMs: number): number {
  assertInterval(intervalMs);
  if (actualMs <= anchorMs) return Math.max(0, actualMs - anchorMs);
  return actualMs - scheduledFireAtOrBefore(anchorMs, intervalMs, actualMs);
}

// ── Cockpit/observability projection ────────────────────────────────────────────
// A compact, display-oriented view of a loop's schedule: scheduled-vs-actual fire
// times plus the derived drift and overdue gap. Pure over (loop, now) so the
// `/loops` route and the cockpit render the same numbers and it stays testable.
export interface LoopScheduleView {
  id: string;
  label: string;
  kind: string;
  status: string;
  owner_callsign: string;
  recurring: boolean;
  interval_ms: number | null;
  anchor_ms: number | null;
  last_fire_ms: number | null; // actual wall-clock time of the last advancing tick
  next_fire_ms: number | null; // scheduled next fire (wall-clock grid)
  last_drift_ms: number | null; // how late the last actual fire was vs its slot
  overdue_ms: number | null; // for a RUNNING recurring loop, ms past next_fire (0 until due)
  iterations: number;
}

export function summarizeLoopSchedule(loop: Loop, nowMs: number): LoopScheduleView {
  const recurring = loop.interval_ms != null;
  const lastDrift =
    recurring && loop.last_fire_ms != null
      ? fireDrift(loop.anchor_ms as number, loop.interval_ms as number, loop.last_fire_ms)
      : null;
  const overdue =
    recurring && loop.status === "running" && loop.next_fire_ms != null
      ? Math.max(0, nowMs - loop.next_fire_ms)
      : null;
  return {
    id: loop.id,
    label: loop.label,
    kind: loop.kind,
    status: loop.status,
    owner_callsign: loop.owner_callsign,
    recurring,
    interval_ms: loop.interval_ms,
    anchor_ms: loop.anchor_ms,
    last_fire_ms: loop.last_fire_ms,
    next_fire_ms: loop.next_fire_ms,
    last_drift_ms: lastDrift,
    overdue_ms: overdue,
    iterations: loop.state.iterations,
  };
}
