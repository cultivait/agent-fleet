// Pure model normalizer for the Cockpit Live fleet view. Transforms a raw
// /board payload into sorted, render-ready LiveEntry rows.
// DOM-free for unit testing; a verbatim copy lives in the dashboard <script>.
// Keep the two identical.
//
// Three liveness states (server-computed, passed through):
//   online && !stale  → live (green dot)
//   online && stale   → ghost/unresponsive (amber dot)
//   !online           → explicitly disconnected (grey dot)
//
// stale is computed server-side using the same PRESENCE_GRACE_MS threshold as
// the ghost-reaper, so cockpit and reaper agree on what "stale" means.

export interface TodoItem {
  content: string;
  status: string;
}

export interface RawBoardEntry {
  name: string;
  node: string | null;
  status: string;
  mission: string | null;
  activity: string | null;
  todos: TodoItem[] | null;
  subagents: number;
  sid: string | null;
  updatedAt: number;
  lastSeenAt: number;
  online: boolean;
  stale: boolean;
}

export interface LiveBoardEntry {
  name: string;
  node: string | null;
  online: boolean;
  stale: boolean;
  mission: string | null;
  activity: string | null;
  todos: TodoItem[] | null;
  subagents: number;
  updatedAt: number;
  sid: string | null;
}

export function buildLiveModel(board: RawBoardEntry[]): LiveBoardEntry[] {
  return board
    .filter((r) => r.status !== "signed-off")
    .map((r) => ({
      name: r.name,
      node: r.node,
      online: r.online,
      stale: r.stale,
      mission: r.mission,
      activity: r.activity,
      todos: r.todos,
      subagents: r.subagents ?? 0,
      updatedAt: r.updatedAt,
      sid: r.sid,
    }))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      if (a.online && a.stale !== b.stale) return a.stale ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
}
