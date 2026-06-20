// Pure feed merge for the cockpit's live event ticker. The feed is fed from two
// sources that must share ONE identity space so they don't double-render at the
// load boundary: a cold-load backfill from task_event (rows carry their row id)
// and live plan_update SSE events (carry eventId = that same task_event.id, or
// null for the rare coarse emit). Dedup is by id when present, else by a
// (taskId|kind|ts) fallback. DOM-free for unit testing; a verbatim copy lives in
// cockpit-ui.ts's browser script. Keep the two identical. (Same extract-and-mirror
// pattern as dashboard-merge.ts.)

export interface RawEvent {
  id?: number | null;
  taskId: string;
  kind: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actor?: string | null;
  ts: number;
}

export interface FeedItem extends RawEvent {
  /** Stable dedup key: "id:<n>" when an id is present, else "taskId|kind|ts". */
  key: string;
}

export function feedKey(e: RawEvent): string {
  return e.id != null ? `id:${e.id}` : `${e.taskId}|${e.kind}|${e.ts}`;
}

/** Ascending by ts, tie-broken by id (id-less events sort after id-bearing ones
 *  at the same ts, by insertion — stable). Oldest first; the renderer appends
 *  newest at the bottom and the limit keeps the most recent slice. */
function chronological(a: FeedItem, b: FeedItem): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Merge `incoming` events into the `existing` feed: dedup by key, sort
 * chronologically, and (optionally) cap to the most recent `limit`. Used both
 * for the initial backfill (existing=[]) and each live append. Fail-open: a
 * non-array `incoming` returns the existing feed untouched.
 */
export function mergeFeed(existing: FeedItem[], incoming: RawEvent[], opts?: { limit?: number }): FeedItem[] {
  const base = Array.isArray(existing) ? existing : [];
  if (!Array.isArray(incoming)) return base;

  const seen = new Set<string>();
  const merged: FeedItem[] = [];
  for (const item of base) {
    if (item && typeof item.key === "string" && !seen.has(item.key)) {
      seen.add(item.key);
      merged.push(item);
    }
  }
  for (const raw of incoming) {
    if (!raw || typeof raw.taskId !== "string" || typeof raw.ts !== "number") continue;
    const key = feedKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...raw, key });
  }

  merged.sort(chronological);

  const limit = opts?.limit;
  if (typeof limit === "number" && limit >= 0 && merged.length > limit) {
    return merged.slice(merged.length - limit);
  }
  return merged;
}
