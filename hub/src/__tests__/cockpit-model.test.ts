import { describe, expect, it } from "vitest";
import { buildCockpitModel, type PlanBoard, type PlanTask, type Presence, STATUS_META } from "../cockpit-model.js";

const task = (o: Partial<PlanTask> & { id: string; status: string }): PlanTask => ({
  project_id: "p1",
  parent_id: null,
  title: o.id,
  detail: null,
  owner: null,
  owner_sid: null,
  priority: 2,
  artifacts: null,
  claimed_at: null,
  done_at: null,
  lease_expires_at: null,
  created_at: 1000,
  updated_at: 1000,
  ...o,
});

const board = (lanes: Record<string, PlanTask[]>, extra: Partial<PlanBoard> = {}): PlanBoard => ({
  project: { id: "p1", title: "Proj", status: "active" },
  lanes,
  deps: [],
  childSummaries: {},
  ...extra,
});

describe("buildCockpitModel — lanes", () => {
  it("returns lanes in canonical status order with labels, groups and counts", () => {
    const m = buildCockpitModel(
      board({ done: [task({ id: "d1", status: "done" })], ready: [task({ id: "r1", status: "ready" })] }),
      [],
    );
    const statuses = m.lanes.map((l) => l.status);
    expect(statuses.indexOf("ready")).toBeLessThan(statuses.indexOf("done"));
    const ready = m.lanes.find((l) => l.status === "ready")!;
    expect(ready.label).toBe(STATUS_META.ready.label);
    expect(ready.group).toBe("active");
    expect(ready.count).toBe(1);
    expect(m.lanes.find((l) => l.status === "done")!.group).toBe("terminal");
  });

  it("sorts within a lane by priority then created_at", () => {
    const m = buildCockpitModel(
      board({
        ready: [
          task({ id: "late", status: "ready", priority: 2, created_at: 5000 }),
          task({ id: "urgent", status: "ready", priority: 0, created_at: 9000 }),
          task({ id: "early", status: "ready", priority: 2, created_at: 1000 }),
        ],
      }),
      [],
    );
    expect(m.lanes.find((l) => l.status === "ready")!.tasks.map((t) => t.id)).toEqual(["urgent", "early", "late"]);
  });
});

describe("buildCockpitModel — owner resolution", () => {
  const presence: Presence[] = [{ sid: "sid-aaa", name: "linux-255c", online: true }];

  it("resolves owner_sid to a live callsign + online from presence", () => {
    const m = buildCockpitModel(
      board({ claimed: [task({ id: "t1", status: "claimed", owner_sid: "sid-aaa", owner: "stale" })] }),
      presence,
    );
    const t = m.byId["t1"];
    expect(t.ownerLabel).toBe("linux-255c");
    expect(t.ownerOnline).toBe(true);
  });

  it("falls back to the stored owner name when the sid is not in presence", () => {
    const m = buildCockpitModel(
      board({ claimed: [task({ id: "t1", status: "claimed", owner_sid: "sid-zzz", owner: "linux-old" })] }),
      presence,
    );
    expect(m.byId["t1"].ownerLabel).toBe("linux-old");
    expect(m.byId["t1"].ownerOnline).toBe(false);
  });

  it("falls back to a short sid when there is neither presence nor a stored owner", () => {
    const m = buildCockpitModel(
      board({ claimed: [task({ id: "t1", status: "claimed", owner_sid: "sid-zzzzzzzz" })] }),
      presence,
    );
    expect(m.byId["t1"].ownerLabel).toBe("sid-zz");
  });
});

describe("buildCockpitModel — deps + child rollup", () => {
  it("counts blockers (blockedBy) and dependents (blocks) and exposes the adjacency", () => {
    const m = buildCockpitModel(
      board(
        {
          ready: [
            task({ id: "a", status: "ready" }),
            task({ id: "b", status: "ready" }),
            task({ id: "c", status: "ready" }),
          ],
        },
        {
          deps: [
            { task_id: "c", blocks_on: "a" },
            { task_id: "c", blocks_on: "b" },
          ],
        },
      ),
      [],
    );
    expect(m.byId["c"].blockedByCount).toBe(2);
    expect(m.byId["a"].blocksCount).toBe(1);
    expect(m.blockedBy["c"].sort()).toEqual(["a", "b"]);
    expect(m.blocks["a"]).toEqual(["c"]);
  });

  it("attaches the child rollup summary when present", () => {
    const m = buildCockpitModel(
      board(
        { in_progress: [task({ id: "parent", status: "in_progress" })] },
        { childSummaries: { parent: { total: 4, terminal: 2, done: 2 } } },
      ),
      [],
    );
    expect(m.byId["parent"].childSummary).toEqual({ total: 4, terminal: 2, done: 2 });
    expect(m.byId["parent"].childSummary !== null).toBe(true);
  });
});

describe("buildCockpitModel — Right Now instances", () => {
  const presence: Presence[] = [
    { sid: "s1", name: "linux-255c", online: true },
    { sid: "s2", name: "linux-d4aa", online: false },
  ];

  it("groups in-flight tasks by owner_sid, one entry per instance", () => {
    const m = buildCockpitModel(
      board({
        claimed: [task({ id: "t1", status: "claimed", owner_sid: "s1", claimed_at: 1000 })],
        in_progress: [task({ id: "t2", status: "in_progress", owner_sid: "s2", claimed_at: 2000 })],
      }),
      presence,
    );
    expect(m.instances).toHaveLength(2);
    expect(m.instances.map((i) => i.sid).sort()).toEqual(["s1", "s2"]);
  });

  it("prefers the in_progress task when an instance holds more than one", () => {
    const m = buildCockpitModel(
      board({
        claimed: [task({ id: "held", status: "claimed", owner_sid: "s1", claimed_at: 3000 })],
        in_progress: [task({ id: "active", status: "in_progress", owner_sid: "s1", claimed_at: 1000 })],
      }),
      presence,
    );
    expect(m.instances).toHaveLength(1);
    expect(m.instances[0].task.id).toBe("active");
    expect(m.instances[0].label).toBe("linux-255c");
  });

  it("surfaces the MOST-recently-claimed task when an instance holds two at the same status rank", () => {
    const m = buildCockpitModel(
      board({
        in_progress: [
          task({ id: "older", status: "in_progress", owner_sid: "s1", claimed_at: 1000 }),
          task({ id: "newer", status: "in_progress", owner_sid: "s1", claimed_at: 5000 }),
        ],
      }),
      presence,
    );
    expect(m.instances).toHaveLength(1);
    expect(m.instances[0].task.id).toBe("newer");
  });

  it("sorts online instances ahead of offline ones", () => {
    const m = buildCockpitModel(
      board({
        in_progress: [
          task({ id: "t2", status: "in_progress", owner_sid: "s2", claimed_at: 2000 }),
          task({ id: "t1", status: "in_progress", owner_sid: "s1", claimed_at: 1000 }),
        ],
      }),
      presence,
    );
    expect(m.instances[0].online).toBe(true);
    expect(m.instances[0].sid).toBe("s1");
  });

  it("ignores tasks with no owner_sid and non-in-flight statuses", () => {
    const m = buildCockpitModel(
      board({
        ready: [task({ id: "r", status: "ready", owner_sid: null })],
        done: [task({ id: "d", status: "done", owner_sid: "s1", claimed_at: 1000 })],
      }),
      presence,
    );
    expect(m.instances).toHaveLength(0);
  });
});

describe("buildCockpitModel — fail open", () => {
  it("returns an empty, canonically-laned model for malformed input", () => {
    // @ts-expect-error exercising the guard
    const m = buildCockpitModel(null, null);
    expect(m.project).toBeNull();
    expect(m.instances).toEqual([]);
    expect(m.lanes.map((l) => l.status)).toEqual(Object.keys(STATUS_META));
    expect(m.lanes.every((l) => l.count === 0)).toBe(true);
  });
});
