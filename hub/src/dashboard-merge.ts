// Pure merge logic for the dashboard's lazy-loaded channel history.
//
// The dashboard's #messages container is ONE flat, timestamp-ordered list of
// rows mixing every channel (it filters by the selected channel for display).
// The initial load only renders a recent-N window across all channels, so a
// chatty channel can have messages OLDER than that window. When a channel is
// first opened we lazy-fetch its recent history and need to splice the missing
// (older) rows into the existing list at the right spots — NOT append them at
// the bottom, which would put old messages after newer ones.
//
// This module holds the DOM-free core so it can be unit-tested. The dashboard's
// inline <script> contains a verbatim copy of `mergeChannelHistory` (it can't
// import this module in the browser); keep the two identical. See dashboard.ts,
// the `lazyLoadChannelHistory` handler.

export interface MergeMessage {
  id: string;
  timestamp: number;
}

export interface MergeInsertion<T extends MergeMessage> {
  /** The fetched message to render. */
  message: T;
  /**
   * The id of the EXISTING (already-rendered) message this one should be
   * inserted before, or null to append at the end of the list. Insertions are
   * returned in ascending timestamp order; applying them in that order against
   * the live list (inserting each before its anchor, or appending when null)
   * yields a fully timestamp-sorted list.
   */
  insertBeforeId: string | null;
}

/**
 * Given the ids/timestamps already rendered (`existing`, the full mixed-channel
 * list in render order) and the freshly `fetched` messages for one channel,
 * compute the de-duplicated, timestamp-ordered list of NEW messages to insert
 * and where to anchor each.
 *
 * - DEDUP BY ID: any fetched message whose id is already present is skipped.
 * - CHRONOLOGICAL: each insertion is anchored before the first existing message
 *   with a strictly greater timestamp, so the merged list stays sorted.
 * - FAIL-OPEN: malformed / empty input yields an empty insertion list (the
 *   caller leaves the existing view untouched).
 */
export function mergeChannelHistory<T extends MergeMessage>(
  existing: MergeMessage[],
  fetched: T[],
): MergeInsertion<T>[] {
  // Fail-open on anything that isn't a usable array of fetched messages.
  if (!Array.isArray(fetched) || fetched.length === 0) return [];
  const existingList = Array.isArray(existing) ? existing : [];

  const seen = new Set<string>();
  for (const m of existingList) {
    if (m && typeof m.id === "string") seen.add(m.id);
  }

  // Keep only well-formed, not-already-present fetched messages, then sort by
  // timestamp ascending (ties keep their fetched order — already chronological
  // from the endpoint) so chained insertions land in order.
  const newMessages = fetched.filter(
    (m) => m && typeof m.id === "string" && typeof m.timestamp === "number" && !seen.has(m.id),
  );
  if (newMessages.length === 0) return [];
  newMessages.sort((a, b) => a.timestamp - b.timestamp);

  // Anchor each new message before the FIRST existing message whose timestamp is
  // strictly greater. The anchor is found in the ORIGINAL existing list only —
  // not against other new messages — so processing new messages in ascending
  // order naturally chains consecutive inserts before the same anchor in order.
  const insertions: MergeInsertion<T>[] = [];
  for (const msg of newMessages) {
    let anchorId: string | null = null;
    for (const ex of existingList) {
      if (ex && typeof ex.id === "string" && ex.timestamp > msg.timestamp) {
        anchorId = ex.id;
        break;
      }
    }
    insertions.push({ message: msg, insertBeforeId: anchorId });
  }
  return insertions;
}
