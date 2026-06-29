import { describe, expect, it } from "vitest";
import { computeNextFire, fireDrift, scheduledFireAtOrBefore, summarizeLoopSchedule } from "../loops/schedule.js";
import type { Loop } from "../loops/store.js";

const I = 60_000; // 1-minute interval
const A = 1_000_000; // anchor (grid origin)

describe("computeNextFire — drift-free wall-clock re-arm", () => {
  it("before the anchor, the first fire is the anchor itself", () => {
    expect(computeNextFire(A, I, A - 5_000)).toBe(A);
  });

  it("at the anchor, the next fire is one interval out (strictly future)", () => {
    expect(computeNextFire(A, I, A)).toBe(A + I);
  });

  it("a LATE tick re-arms to the GRID, not now+interval (the core property)", () => {
    const now = A + I + 5_000; // 5s into the 2nd period
    expect(computeNextFire(A, I, now)).toBe(A + 2 * I); // grid slot
    expect(computeNextFire(A, I, now)).not.toBe(now + I); // would be A+2I+5s — drift
  });

  it("coalesces missed slots to the next FUTURE grid point (no catch-up burst)", () => {
    const now = A + 3 * I + 1; // overshot slots at +I, +2I, +3I
    expect(computeNextFire(A, I, now)).toBe(A + 4 * I);
  });

  it("on an exact grid point, returns the NEXT slot (strictly after now)", () => {
    expect(computeNextFire(A, I, A + 2 * I)).toBe(A + 3 * I);
  });

  it("drift does not accumulate across many late ticks", () => {
    let next = computeNextFire(A, I, A); // A + I
    for (let k = 1; k <= 10; k++) {
      const firedAt = next + 200; // each tick fires 200ms late
      next = computeNextFire(A, I, firedAt);
      expect(next).toBe(A + (k + 1) * I); // stays exactly on the grid, no creep
    }
  });

  it("throws on a non-positive or non-finite interval", () => {
    expect(() => computeNextFire(A, 0, A)).toThrow(/positive/);
    expect(() => computeNextFire(A, -1, A)).toThrow(/positive/);
    expect(() => computeNextFire(A, Number.NaN, A)).toThrow(/positive/);
  });
});

describe("scheduledFireAtOrBefore / fireDrift", () => {
  it("scheduledFireAtOrBefore returns the slot containing now", () => {
    expect(scheduledFireAtOrBefore(A, I, A + 2 * I + 123)).toBe(A + 2 * I);
    expect(scheduledFireAtOrBefore(A, I, A + 2 * I)).toBe(A + 2 * I); // exact grid point
    expect(scheduledFireAtOrBefore(A, I, A - 1)).toBe(A); // clamps before start
  });

  it("fireDrift is 0 dead-on the grid and the lateness otherwise", () => {
    expect(fireDrift(A, I, A + 3 * I)).toBe(0);
    expect(fireDrift(A, I, A + 3 * I + 250)).toBe(250);
    expect(fireDrift(A, I, A)).toBe(0); // anchor fire is on time
  });
});

describe("summarizeLoopSchedule — cockpit projection", () => {
  function loop(partial: Partial<Loop>): Loop {
    return {
      id: "loop_x",
      kind: "generic",
      owner_callsign: "a",
      owner_sid: null,
      label: "L",
      status: "running",
      config: {},
      state: {
        iterations: 3,
        tokens: 0,
        improvements: [],
        signatures: [],
        last_completeness: null,
        last_confidence: null,
      },
      stop_reason: null,
      created_at: A,
      updated_at: A,
      interval_ms: null,
      anchor_ms: null,
      last_fire_ms: null,
      next_fire_ms: null,
      ...partial,
    } as Loop;
  }

  it("a non-recurring loop reports recurring=false and null schedule fields", () => {
    const v = summarizeLoopSchedule(loop({}), A + I);
    expect(v.recurring).toBe(false);
    expect(v.interval_ms).toBeNull();
    expect(v.next_fire_ms).toBeNull();
    expect(v.last_drift_ms).toBeNull();
    expect(v.overdue_ms).toBeNull();
  });

  it("a recurring loop surfaces scheduled-vs-actual + drift + overdue", () => {
    const v = summarizeLoopSchedule(
      loop({ interval_ms: I, anchor_ms: A, last_fire_ms: A + I + 300, next_fire_ms: A + 2 * I }),
      A + 2 * I + 5_000, // 5s past the scheduled next fire → overdue
    );
    expect(v.recurring).toBe(true);
    expect(v.last_fire_ms).toBe(A + I + 300);
    expect(v.next_fire_ms).toBe(A + 2 * I);
    expect(v.last_drift_ms).toBe(300); // last fire was 300ms late
    expect(v.overdue_ms).toBe(5_000);
    expect(v.iterations).toBe(3);
  });

  it("a not-yet-due recurring loop has overdue_ms === 0", () => {
    const v = summarizeLoopSchedule(
      loop({ interval_ms: I, anchor_ms: A, last_fire_ms: A, next_fire_ms: A + I }),
      A + I - 1_000, // 1s before the next scheduled fire
    );
    expect(v.overdue_ms).toBe(0);
  });

  it("a stopped recurring loop is not 'overdue' (no next-fire pressure)", () => {
    const v = summarizeLoopSchedule(
      loop({ status: "stopped", interval_ms: I, anchor_ms: A, last_fire_ms: A + I, next_fire_ms: null }),
      A + 10 * I,
    );
    expect(v.overdue_ms).toBeNull();
  });
});
