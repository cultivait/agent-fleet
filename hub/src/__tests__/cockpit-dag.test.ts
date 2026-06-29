import { describe, expect, it } from "vitest";
import { type DagDep, type DagInputTask, layoutDag } from "../cockpit-dag.js";

const t = (id: string, o: Partial<DagInputTask> = {}): DagInputTask => ({
  id,
  parent_id: null,
  priority: 2,
  status: "ready",
  ...o,
});
// dep: `task` is blocked on `on`.
const dep = (task: string, on: string): DagDep => ({ task_id: task, blocks_on: on });

const layerOf = (nodes: { id: string; layer: number }[], id: string) => nodes.find((n) => n.id === id)!.layer;

describe("layoutDag — layering", () => {
  it("puts a root (no blockers) at layer 0 and each node one past its deepest blocker", () => {
    const { nodes } = layoutDag([t("a"), t("b"), t("c")], [dep("b", "a"), dep("c", "b")]);
    expect(layerOf(nodes, "a")).toBe(0);
    expect(layerOf(nodes, "b")).toBe(1);
    expect(layerOf(nodes, "c")).toBe(2);
  });

  it("uses the LONGEST path (diamond converges at max depth)", () => {
    const { nodes } = layoutDag(
      [t("a"), t("b"), t("c"), t("d")],
      [dep("b", "a"), dep("c", "a"), dep("d", "b"), dep("d", "c")],
    );
    expect(layerOf(nodes, "a")).toBe(0);
    expect(layerOf(nodes, "b")).toBe(1);
    expect(layerOf(nodes, "c")).toBe(1);
    expect(layerOf(nodes, "d")).toBe(2);
  });

  it("treats a dangling blocker reference (blocks_on an unknown task) as no constraint", () => {
    const { nodes } = layoutDag([t("a")], [dep("a", "ghost")]);
    expect(layerOf(nodes, "a")).toBe(0);
    expect(nodes).toHaveLength(1);
  });
});

describe("layoutDag — intra-layer order", () => {
  it("orders within a layer by parent-group, then priority, then id (stable)", () => {
    const { nodes } = layoutDag(
      [
        t("a2", { parent_id: "P1", priority: 2 }),
        t("b1", { parent_id: "P2", priority: 2 }),
        t("a1", { parent_id: "P1", priority: 2 }),
      ],
      [],
    );
    // All layer 0. P1 group {a1,a2} adjacent (orders 0,1), P2 {b1} after.
    const ordered = [...nodes].sort((x, y) => x.order - y.order).map((n) => n.id);
    expect(ordered).toEqual(["a1", "a2", "b1"]);
  });

  it("breaks ties by priority before id", () => {
    const { nodes } = layoutDag([t("zzz", { priority: 2 }), t("aaa", { priority: 0 })], []);
    const ordered = [...nodes].sort((x, y) => x.order - y.order).map((n) => n.id);
    expect(ordered).toEqual(["aaa", "zzz"]);
  });

  it("assigns a contiguous 0..n-1 order within each layer", () => {
    const { nodes } = layoutDag([t("a"), t("b"), t("c")], [dep("b", "a"), dep("c", "a")]);
    const layer1 = nodes
      .filter((n) => n.layer === 1)
      .map((n) => n.order)
      .sort();
    expect(layer1).toEqual([0, 1]);
  });
});

describe("layoutDag — cycle guard (degrade, never hang)", () => {
  it("drops the back-edge of a 2-cycle, flags it, and produces a finite layout", () => {
    const { nodes, flaggedEdges } = layoutDag([t("a"), t("b")], [dep("a", "b"), dep("b", "a")]);
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => Number.isFinite(n.layer))).toBe(true);
    expect(flaggedEdges.length).toBeGreaterThan(0);
    expect(nodes.some((n) => n.flagged)).toBe(true);
  });

  it("handles a self-loop without hanging", () => {
    const { nodes, flaggedEdges } = layoutDag([t("a")], [dep("a", "a")]);
    expect(layerOf(nodes, "a")).toBe(0);
    expect(flaggedEdges.length).toBeGreaterThan(0);
  });
});
