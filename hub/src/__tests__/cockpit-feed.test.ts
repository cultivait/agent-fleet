import { describe, expect, it } from "vitest";
import { feedKey, mergeFeed, type RawEvent } from "../cockpit-feed.js";

const ev = (o: Partial<RawEvent> & { taskId: string; kind: string; ts: number }): RawEvent => o;

describe("feedKey", () => {
  it("uses the task_event id as the identity when present", () => {
    expect(feedKey(ev({ id: 7, taskId: "t1", kind: "transition", ts: 1000 }))).toBe("id:7");
  });
  it("falls back to taskId|kind|ts when there is no id (coarse live emit)", () => {
    expect(feedKey(ev({ id: null, taskId: "t1", kind: "claim", ts: 1000 }))).toBe("t1|claim|1000");
  });
  it("treats a missing id field the same as null", () => {
    expect(feedKey(ev({ taskId: "t9", kind: "handoff", ts: 42 }))).toBe("t9|handoff|42");
  });
});

describe("mergeFeed", () => {
  it("renders an empty feed from backfill rows in chronological (oldest→newest) order", () => {
    const backfill = [
      ev({ id: 3, taskId: "t1", kind: "transition", ts: 3000 }),
      ev({ id: 1, taskId: "t1", kind: "create", ts: 1000 }),
      ev({ id: 2, taskId: "t2", kind: "claim", ts: 2000 }),
    ];
    const out = mergeFeed([], backfill);
    expect(out.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("dedups a live event against the backfill via the shared task_event id", () => {
    const existing = mergeFeed([], [ev({ id: 5, taskId: "t1", kind: "transition", ts: 5000 })]);
    // The same logical event arrives live carrying eventId=5.
    const out = mergeFeed(existing, [ev({ id: 5, taskId: "t1", kind: "transition", ts: 5000 })]);
    expect(out).toHaveLength(1);
  });

  it("appends a newer live event after the backfilled window", () => {
    const existing = mergeFeed([], [ev({ id: 5, taskId: "t1", kind: "create", ts: 5000 })]);
    const out = mergeFeed(existing, [ev({ id: 6, taskId: "t2", kind: "claim", ts: 6000 })]);
    expect(out.map((e) => e.id)).toEqual([5, 6]);
  });

  it("tie-breaks equal timestamps by id so order is stable", () => {
    const out = mergeFeed(
      [],
      [
        ev({ id: 11, taskId: "t1", kind: "transition", ts: 1000 }),
        ev({ id: 10, taskId: "t1", kind: "claim", ts: 1000 }),
      ],
    );
    expect(out.map((e) => e.id)).toEqual([10, 11]);
  });

  it("caps to the limit, keeping the most recent events", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ev({ id: n, taskId: "t", kind: "transition", ts: n * 1000 }));
    const out = mergeFeed([], rows, { limit: 3 });
    expect(out.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it("dedups two id-less live events of the same logical event via the fallback key", () => {
    const e = ev({ id: null, taskId: "t1", kind: "blocked", ts: 7000 });
    const existing = mergeFeed([], [e]);
    const out = mergeFeed(existing, [{ ...e }]);
    expect(out).toHaveLength(1);
  });

  it("fails open: non-array incoming leaves the existing feed untouched", () => {
    const existing = mergeFeed([], [ev({ id: 1, taskId: "t", kind: "create", ts: 1000 })]);
    // @ts-expect-error exercising the fail-open guard with a bad value
    const out = mergeFeed(existing, null);
    expect(out).toEqual(existing);
  });

  it("stamps each item with its dedup key", () => {
    const out = mergeFeed([], [ev({ id: 8, taskId: "t1", kind: "artifact", ts: 1000 })]);
    expect(out[0].key).toBe("id:8");
  });
});
