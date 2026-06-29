import { describe, expect, it } from "vitest";
import { buildLiveModel, type RawBoardEntry } from "../cockpit-live.js";

function raw(o: Partial<RawBoardEntry> & { name: string }): RawBoardEntry {
  return {
    name: o.name,
    node: o.node ?? "linux",
    status: o.status ?? "active",
    mission: o.mission ?? null,
    activity: o.activity ?? null,
    todos: o.todos ?? null,
    subagents: o.subagents ?? 0,
    sid: o.sid ?? null,
    updatedAt: o.updatedAt ?? 1000,
    lastSeenAt: o.lastSeenAt ?? 1000,
    online: o.online ?? true,
    stale: o.stale ?? false,
  };
}

describe("buildLiveModel", () => {
  it("returns empty array for empty board", () => {
    expect(buildLiveModel([])).toEqual([]);
  });

  it("maps a basic online entry as non-stale", () => {
    const result = buildLiveModel([raw({ name: "linux-abc" })]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("linux-abc");
    expect(result[0].online).toBe(true);
    expect(result[0].stale).toBe(false);
  });

  it("passes through server stale=true", () => {
    const result = buildLiveModel([raw({ name: "ghost", online: true, stale: true })]);
    expect(result[0].stale).toBe(true);
  });

  it("passes through server stale=false", () => {
    const result = buildLiveModel([raw({ name: "edge", online: true, stale: false })]);
    expect(result[0].stale).toBe(false);
  });

  it("offline entries have stale passed through as-is (server owns the value)", () => {
    const result = buildLiveModel([raw({ name: "off", online: false, stale: false })]);
    expect(result[0].stale).toBe(false);
  });

  it("passes through mission, activity, todos, subagents, sid, node", () => {
    const todos = [{ content: "do it", status: "completed" }];
    const result = buildLiveModel([
      raw({ name: "a", mission: "m", activity: "act", todos, subagents: 3, sid: "s1", node: "mac" }),
    ]);
    expect(result[0].mission).toBe("m");
    expect(result[0].activity).toBe("act");
    expect(result[0].todos).toEqual(todos);
    expect(result[0].subagents).toBe(3);
    expect(result[0].sid).toBe("s1");
    expect(result[0].node).toBe("mac");
  });

  it("sorts online before offline", () => {
    const result = buildLiveModel([raw({ name: "b", online: false }), raw({ name: "a", online: true })]);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("b");
  });

  it("sorts non-stale before stale within online group", () => {
    const result = buildLiveModel([
      raw({ name: "stale-one", online: true, stale: true }),
      raw({ name: "fresh-one", online: true, stale: false }),
    ]);
    expect(result[0].name).toBe("fresh-one");
    expect(result[1].name).toBe("stale-one");
  });

  it("sorts alphabetically within same liveness tier", () => {
    const result = buildLiveModel([raw({ name: "linux-z", online: true }), raw({ name: "linux-a", online: true })]);
    expect(result[0].name).toBe("linux-a");
    expect(result[1].name).toBe("linux-z");
  });

  it("filters out signed-off entries", () => {
    const result = buildLiveModel([
      raw({ name: "gone", status: "signed-off", online: false }),
      raw({ name: "here", online: true }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("here");
  });

  it("full sort order: online-fresh, online-stale, offline", () => {
    const result = buildLiveModel([
      raw({ name: "off", online: false }),
      raw({ name: "ghost", online: true, stale: true }),
      raw({ name: "live", online: true, stale: false }),
    ]);
    expect(result.map((r) => r.name)).toEqual(["live", "ghost", "off"]);
  });
});
