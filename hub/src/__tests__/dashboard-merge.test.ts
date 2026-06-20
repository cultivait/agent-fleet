import { describe, expect, it } from "vitest";
import { mergeChannelHistory, type MergeMessage } from "../dashboard-merge.js";

interface FetchedMsg extends MergeMessage {
  content?: string;
}

describe("mergeChannelHistory", () => {
  it("merges fetched messages OUTSIDE the initial window in correct timestamp order", () => {
    // The initial recent-window only rendered two newer messages.
    const existing: MergeMessage[] = [
      { id: "c", timestamp: 300 },
      { id: "e", timestamp: 500 },
    ];
    // Lazy-fetch returns the channel's full recent history, including OLDER rows
    // (a, b) that fell outside the window and one in the gap (d).
    const fetched: FetchedMsg[] = [
      { id: "a", timestamp: 100 },
      { id: "b", timestamp: 200 },
      { id: "d", timestamp: 400 },
    ];

    const result = mergeChannelHistory(existing, fetched);

    // Returned in ascending timestamp order.
    expect(result.map((r) => r.message.id)).toEqual(["a", "b", "d"]);
    // a (100) and b (200) anchor before c (300); d (400) anchors before e (500).
    expect(result.map((r) => r.insertBeforeId)).toEqual(["c", "c", "e"]);

    // Applying the insertions yields a fully sorted list.
    const applied = applyInsertions(existing, result);
    expect(applied.map((m) => m.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(isSorted(applied)).toBe(true);
  });

  it("appends (insertBeforeId=null) for messages newer than everything rendered", () => {
    const existing: MergeMessage[] = [
      { id: "a", timestamp: 100 },
      { id: "b", timestamp: 200 },
    ];
    const fetched: FetchedMsg[] = [
      { id: "x", timestamp: 50 }, // older → before a
      { id: "y", timestamp: 300 }, // newer than all → append
      { id: "z", timestamp: 400 }, // newer still → append
    ];

    const result = mergeChannelHistory(existing, fetched);

    expect(result.map((r) => r.message.id)).toEqual(["x", "y", "z"]);
    expect(result.map((r) => r.insertBeforeId)).toEqual(["a", null, null]);

    const applied = applyInsertions(existing, result);
    expect(applied.map((m) => m.id)).toEqual(["x", "a", "b", "y", "z"]);
    expect(isSorted(applied)).toBe(true);
  });

  it("does NOT duplicate ids already present in the rendered set", () => {
    const existing: MergeMessage[] = [
      { id: "a", timestamp: 100 },
      { id: "b", timestamp: 200 },
      { id: "c", timestamp: 300 },
    ];
    // Fetched overlaps the window (a, b, c already rendered) and adds one older (z).
    const fetched: FetchedMsg[] = [
      { id: "z", timestamp: 50 },
      { id: "a", timestamp: 100 },
      { id: "b", timestamp: 200 },
      { id: "c", timestamp: 300 },
    ];

    const result = mergeChannelHistory(existing, fetched);

    // Only the genuinely-new message comes back.
    expect(result.map((r) => r.message.id)).toEqual(["z"]);
    expect(result[0].insertBeforeId).toBe("a");

    const applied = applyInsertions(existing, result);
    expect(applied.map((m) => m.id)).toEqual(["z", "a", "b", "c"]);
    // No duplicate ids.
    expect(new Set(applied.map((m) => m.id)).size).toBe(applied.length);
  });

  it("returns empty when every fetched message is already present", () => {
    const existing: MergeMessage[] = [
      { id: "a", timestamp: 100 },
      { id: "b", timestamp: 200 },
    ];
    const fetched: FetchedMsg[] = [
      { id: "a", timestamp: 100 },
      { id: "b", timestamp: 200 },
    ];
    expect(mergeChannelHistory(existing, fetched)).toEqual([]);
  });

  it("fails open on empty fetched input (returns no insertions)", () => {
    const existing: MergeMessage[] = [{ id: "a", timestamp: 100 }];
    expect(mergeChannelHistory(existing, [])).toEqual([]);
  });

  it("fails open on malformed / non-array input (returns no insertions)", () => {
    const existing: MergeMessage[] = [{ id: "a", timestamp: 100 }];
    // Simulate a fetch error path / garbage body — never throw, never break.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mergeChannelHistory(existing, null as any)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mergeChannelHistory(existing, undefined as any)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mergeChannelHistory(existing, { messages: [] } as any)).toEqual([]);
  });

  it("skips individual malformed entries but keeps the well-formed new ones", () => {
    const existing: MergeMessage[] = [{ id: "b", timestamp: 200 }];
    const fetched = [
      { id: "a", timestamp: 100 }, // good, older
      { id: "bad", timestamp: "nope" }, // malformed timestamp → skip
      { timestamp: 150 }, // missing id → skip
      null, // garbage → skip
      { id: "c", timestamp: 300 }, // good, newer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;

    const result = mergeChannelHistory(existing, fetched);
    expect(result.map((r) => r.message.id)).toEqual(["a", "c"]);
    expect(result.map((r) => r.insertBeforeId)).toEqual(["b", null]);
  });

  it("handles an empty existing list by appending all fetched in order", () => {
    const existing: MergeMessage[] = [];
    const fetched: FetchedMsg[] = [
      { id: "a", timestamp: 200 },
      { id: "b", timestamp: 100 },
    ];
    const result = mergeChannelHistory(existing, fetched);
    // Sorted ascending; nothing to anchor against → all append.
    expect(result.map((r) => r.message.id)).toEqual(["b", "a"]);
    expect(result.map((r) => r.insertBeforeId)).toEqual([null, null]);
  });
});

// --- Test helpers: simulate applying insertions to the rendered list ---

/**
 * Mirrors what the browser does: for each insertion (in order), insert the new
 * message before its anchor id, or append when the anchor is null.
 */
function applyInsertions(
  existing: MergeMessage[],
  insertions: { message: MergeMessage; insertBeforeId: string | null }[],
): MergeMessage[] {
  const list = existing.map((m) => ({ ...m }));
  for (const { message, insertBeforeId } of insertions) {
    if (insertBeforeId === null) {
      list.push({ ...message });
    } else {
      const idx = list.findIndex((m) => m.id === insertBeforeId);
      if (idx === -1) list.push({ ...message });
      else list.splice(idx, 0, { ...message });
    }
  }
  return list;
}

function isSorted(list: MergeMessage[]): boolean {
  for (let i = 1; i < list.length; i++) {
    if (list[i].timestamp < list[i - 1].timestamp) return false;
  }
  return true;
}
