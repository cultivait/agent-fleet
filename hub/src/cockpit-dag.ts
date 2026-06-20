// Pure layered layout for the cockpit's desktop dependency DAG. Dependencies
// flow down: a task sits one layer below its deepest blocker (longest-path
// layering). Roots (no blockers) are layer 0. Within a layer, nodes are ordered
// by parent-group → priority → id so siblings cluster and the layout is stable.
//
// A dependency cycle (a creation bug) must DEGRADE, not hang: a DFS visited-stack
// detects a back-edge, drops it (treats it as absent for layering) and flags the
// node + edge so the renderer can mark it. Dangling blocker refs (blocks_on an
// unknown task) are simply ignored. DOM-free for unit testing; a verbatim copy
// lives in dashboard.ts (desktop-only mount).

export interface DagInputTask {
  id: string;
  parent_id: string | null;
  priority: number;
  status: string;
}
export interface DagDep { task_id: string; blocks_on: string; }
export interface DagNode { id: string; layer: number; order: number; flagged: boolean; }
export interface DagLayout { nodes: DagNode[]; flaggedEdges: Array<{ from: string; to: string }>; }

export function layoutDag(tasks: DagInputTask[], deps: DagDep[]): DagLayout {
  if (!Array.isArray(tasks) || tasks.length === 0) return { nodes: [], flaggedEdges: [] };
  const ids = new Set(tasks.map((t) => t.id));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Blockers of each task, restricted to known tasks (dangling refs dropped).
  const blockers = new Map<string, string[]>();
  if (Array.isArray(deps)) {
    for (const d of deps) {
      if (!d || !ids.has(d.task_id) || !ids.has(d.blocks_on)) continue;
      const list = blockers.get(d.task_id);
      if (list) list.push(d.blocks_on);
      else blockers.set(d.task_id, [d.blocks_on]);
    }
  }

  const layer = new Map<string, number>();
  const onStack = new Set<string>();
  const flaggedNodes = new Set<string>();
  const flaggedEdges: Array<{ from: string; to: string }> = [];

  const computeLayer = (id: string): number => {
    const memo = layer.get(id);
    if (memo !== undefined) return memo;
    onStack.add(id);
    let lv = 0;
    for (const b of blockers.get(id) ?? []) {
      if (onStack.has(b)) {
        // Back-edge: drop it so layering terminates; flag node + edge.
        flaggedNodes.add(id);
        flaggedEdges.push({ from: id, to: b });
        continue;
      }
      lv = Math.max(lv, 1 + computeLayer(b));
    }
    onStack.delete(id);
    layer.set(id, lv);
    return lv;
  };
  for (const t of tasks) computeLayer(t.id);

  // Order within each layer: parent-group → priority → id.
  const byLayer = new Map<number, string[]>();
  for (const t of tasks) {
    const lv = layer.get(t.id) ?? 0;
    const bucket = byLayer.get(lv);
    if (bucket) bucket.push(t.id);
    else byLayer.set(lv, [t.id]);
  }
  const order = new Map<string, number>();
  for (const bucket of byLayer.values()) {
    bucket.sort((x, y) => {
      const tx = taskById.get(x)!;
      const ty = taskById.get(y)!;
      const px = tx.parent_id ?? "";
      const py = ty.parent_id ?? "";
      if (px !== py) return px < py ? -1 : 1;
      if (tx.priority !== ty.priority) return tx.priority - ty.priority;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    bucket.forEach((id, i) => order.set(id, i));
  }

  const nodes: DagNode[] = tasks.map((t) => ({
    id: t.id,
    layer: layer.get(t.id) ?? 0,
    order: order.get(t.id) ?? 0,
    flagged: flaggedNodes.has(t.id),
  }));
  return { nodes, flaggedEdges };
}
