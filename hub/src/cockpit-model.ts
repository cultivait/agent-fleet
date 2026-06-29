// Pure view-model normalizer for the cockpit. Turns a raw /plan-board payload
// (lanes-by-status + deps + child rollups) plus the radio presence list into a
// render-ready model: lanes in canonical order, tasks enriched with a resolved
// owner (owner_sid → live callsign), dep counts, child rollups, the drawer's
// dep adjacency, and the Right-Now per-instance grouping.
//
// Deliberately does NOT compute lease state — leases tick every second against
// the server clock, so the renderer calls cockpit-lease.leaseState() per task
// per tick. This module is a pure function of the fetched data, recomputed only
// on refetch. DOM-free for unit testing; a verbatim copy lives in dashboard.ts.
export interface PlanTask {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  detail: string | null;
  status: string;
  owner: string | null;
  owner_sid: string | null;
  priority: number;
  artifacts: string | null;
  claimed_at: number | null;
  done_at: number | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface PlanDep {
  task_id: string;
  blocks_on: string;
}
export interface ChildSummary {
  total: number;
  terminal: number;
  done: number;
}
export interface Presence {
  sid: string;
  name: string;
  online: boolean;
}
export interface PlanBoard {
  project: { id: string; title: string; status: string } | null;
  lanes: Record<string, PlanTask[]>;
  deps: PlanDep[];
  childSummaries: Record<string, ChildSummary>;
  now?: number;
}
export interface ModelTask extends PlanTask {
  ownerLabel: string | null;
  ownerOnline: boolean;
  blockedByCount: number;
  blocksCount: number;
  childSummary: ChildSummary | null;
}
export interface InstanceEntry {
  sid: string;
  label: string;
  online: boolean;
  task: ModelTask;
  secondaryTasks: ModelTask[];
}
export type LaneGroup = "backlog" | "active" | "terminal";
export interface LaneView {
  status: string;
  label: string;
  group: LaneGroup;
  tasks: ModelTask[];
  count: number;
}
export interface CockpitModel {
  project: PlanBoard["project"];
  lanes: LaneView[];
  instances: InstanceEntry[];
  byId: Record<string, ModelTask>;
  blockedBy: Record<string, string[]>;
  blocks: Record<string, string[]>;
}

export const STATUS_META: Record<string, { label: string; group: LaneGroup }> = {
  proposed: { label: "Proposed", group: "backlog" },
  ratified: { label: "Ratified", group: "backlog" },
  ready: { label: "Ready", group: "active" },
  claimed: { label: "Claimed", group: "active" },
  in_progress: { label: "In progress", group: "active" },
  review: { label: "Review", group: "active" },
  blocked: { label: "Blocked", group: "active" },
  done: { label: "Done", group: "terminal" },
  failed: { label: "Failed", group: "terminal" },
  abandoned: { label: "Abandoned", group: "terminal" },
};

const IN_FLIGHT = new Set(["claimed", "in_progress", "review"]);
// Which in-flight task to surface on an instance's Right-Now card when it holds
// several: in_progress (actually working) over claimed (grabbed) over review.
const INSTANCE_PICK: Record<string, number> = { in_progress: 0, claimed: 1, review: 2 };

function emptyLanes(): LaneView[] {
  return Object.keys(STATUS_META).map((status) => ({
    status,
    label: STATUS_META[status].label,
    group: STATUS_META[status].group,
    tasks: [],
    count: 0,
  }));
}

export function buildCockpitModel(board: PlanBoard, presence: Presence[]): CockpitModel {
  if (!board || typeof board !== "object" || !board.lanes || typeof board.lanes !== "object") {
    return { project: null, lanes: emptyLanes(), instances: [], byId: {}, blockedBy: {}, blocks: {} };
  }

  const presenceBySid = new Map<string, Presence>();
  if (Array.isArray(presence)) {
    for (const p of presence) {
      if (p && typeof p.sid === "string") presenceBySid.set(p.sid, p);
    }
  }

  // Dependency adjacency: task_id is blocked_on blocks_on.
  const blockedBy: Record<string, string[]> = {};
  const blocks: Record<string, string[]> = {};
  const deps = Array.isArray(board.deps) ? board.deps : [];
  for (const d of deps) {
    if (!d || typeof d.task_id !== "string" || typeof d.blocks_on !== "string") continue;
    blockedBy[d.task_id] ||= [];
    blockedBy[d.task_id].push(d.blocks_on);
    blocks[d.blocks_on] ||= [];
    blocks[d.blocks_on].push(d.task_id);
  }

  const childSummaries = board.childSummaries && typeof board.childSummaries === "object" ? board.childSummaries : {};

  const byId: Record<string, ModelTask> = {};
  const enrich = (t: PlanTask): ModelTask => {
    const p = t.owner_sid ? presenceBySid.get(t.owner_sid) : undefined;
    const ownerLabel = p ? p.name : (t.owner ?? (t.owner_sid ? t.owner_sid.slice(0, 6) : null));
    const mt: ModelTask = {
      ...t,
      ownerLabel,
      ownerOnline: p ? p.online : false,
      blockedByCount: blockedBy[t.id]?.length ?? 0,
      blocksCount: blocks[t.id]?.length ?? 0,
      childSummary: childSummaries[t.id] ?? null,
    };
    byId[t.id] = mt;
    return mt;
  };

  // Lanes in canonical order, then any unknown statuses the server sent, appended.
  const orderedStatuses = [...Object.keys(STATUS_META), ...Object.keys(board.lanes).filter((s) => !(s in STATUS_META))];
  const lanes: LaneView[] = orderedStatuses.map((status) => {
    const raw = Array.isArray(board.lanes[status]) ? board.lanes[status] : [];
    const tasks = raw
      .map(enrich)
      .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.created_at - b.created_at));
    return {
      status,
      label: STATUS_META[status]?.label ?? status,
      group: STATUS_META[status]?.group ?? "active",
      tasks,
      count: tasks.length,
    };
  });

  // Right-Now rail: one entry per instance holding an in-flight or blocked task.
  // allInstTasks tracks every relevant task per owner_sid (in-flight + blocked).
  const byInstance = new Map<string, ModelTask>();
  const allInstTasks = new Map<string, ModelTask[]>();
  for (const t of Object.values(byId)) {
    if (!t.owner_sid || (!IN_FLIGHT.has(t.status) && t.status !== "blocked")) continue;
    const list = allInstTasks.get(t.owner_sid) ?? [];
    list.push(t);
    allInstTasks.set(t.owner_sid, list);
    if (!IN_FLIGHT.has(t.status)) continue; // blocked tasks don't compete for primary slot
    const cur = byInstance.get(t.owner_sid);
    if (!cur) {
      byInstance.set(t.owner_sid, t);
      continue;
    }
    const better =
      (INSTANCE_PICK[t.status] ?? 9) - (INSTANCE_PICK[cur.status] ?? 9) || (cur.claimed_at ?? 0) - (t.claimed_at ?? 0); // tie-break: most recent claim wins (negative ⇒ replace cur)
    if (better < 0) byInstance.set(t.owner_sid, t);
  }
  // Include blocked-only instances (no in-flight primary task picked).
  for (const [sid, tasks] of allInstTasks.entries()) {
    if (!byInstance.has(sid)) {
      const blocked = tasks.find((t) => t.status === "blocked");
      if (blocked) byInstance.set(sid, blocked);
    }
  }
  const instances: InstanceEntry[] = [...byInstance.entries()]
    .map(([sid, task]) => {
      const all = allInstTasks.get(sid) ?? [];
      const secondaryTasks = all.filter((t) => t.id !== task.id && (t.status === "review" || t.status === "blocked"));
      return { sid, label: task.ownerLabel ?? sid.slice(0, 6), online: task.ownerOnline, task, secondaryTasks };
    })
    .sort((a, b) => (a.online === b.online ? a.label.localeCompare(b.label) : a.online ? -1 : 1));

  return { project: board.project ?? null, lanes, instances, byId, blockedBy, blocks };
}
