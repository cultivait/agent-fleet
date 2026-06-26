import { beforeEach, describe, expect, it } from "vitest";
import { dbInsertLog, dbListLog, dbListLatestLogPerAgent, dbListLogSince, initDB } from "../db.js";

// Pure DB-layer tests for the board auto-digest logbook (agent_log). Append-only,
// per-agent; the dashboard reads these — they never wake anyone.

beforeEach(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
});

describe("dbInsertLog", () => {
  it("appends and returns the row with an id + ts", () => {
    const row = dbInsertLog("alice", "finding", "found a thing");
    expect(row.id).toBeGreaterThan(0);
    expect(row.name).toBe("alice");
    expect(row.kind).toBe("finding");
    expect(row.note).toBe("found a thing");
    expect(row.ts).toBeGreaterThan(0);
  });

  it("is append-only — repeated inserts accumulate (no upsert)", () => {
    dbInsertLog("alice", "finding", "one");
    dbInsertLog("alice", "decision", "two");
    dbInsertLog("alice", "blocker", "three");
    expect(dbListLog("alice", 10)).toHaveLength(3);
  });
});

describe("dbListLog", () => {
  it("returns newest-first, capped by limit", () => {
    dbInsertLog("alice", "finding", "first");
    dbInsertLog("alice", "finding", "second");
    dbInsertLog("alice", "finding", "third");
    const rows = dbListLog("alice", 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].note).toBe("third");
    expect(rows[1].note).toBe("second");
  });

  it("scopes to the requested agent only", () => {
    dbInsertLog("alice", "finding", "alice-line");
    dbInsertLog("bob", "finding", "bob-line");
    const rows = dbListLog("alice", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("alice-line");
  });

  it("returns empty for an agent with no log", () => {
    expect(dbListLog("ghost", 5)).toEqual([]);
  });
});

describe("dbListLatestLogPerAgent", () => {
  it("returns exactly one row per agent — the freshest by id", () => {
    dbInsertLog("alice", "finding", "alice-old");
    dbInsertLog("bob", "finding", "bob-old");
    dbInsertLog("alice", "decision", "alice-new");
    const latest = dbListLatestLogPerAgent();
    const byName = new Map(latest.map((r) => [r.name, r]));
    expect(byName.size).toBe(2);
    expect(byName.get("alice")!.note).toBe("alice-new");
    expect(byName.get("bob")!.note).toBe("bob-old");
  });

  it("is empty when nothing has been logged", () => {
    expect(dbListLatestLogPerAgent()).toEqual([]);
  });
});

describe("dbListLogSince (board-digest v2 read-half)", () => {
  it("returns only entries with id > since, newest-first", () => {
    const a = dbInsertLog("alice", "finding", "one");
    const b = dbInsertLog("bob", "finding", "two");
    const c = dbInsertLog("carol", "done", "three");
    const rows = dbListLogSince(a.id, null, 10); // strictly after a
    expect(rows.map((r) => r.id)).toEqual([c.id, b.id]); // DESC, excludes a (id == since)
  });

  it("excludes the caller's own callsign", () => {
    dbInsertLog("alice", "finding", "a1");
    dbInsertLog("bob", "finding", "b1");
    dbInsertLog("alice", "decision", "a2");
    const rows = dbListLogSince(0, "alice", 10);
    expect(rows.every((r) => r.name !== "alice")).toBe(true);
    expect(rows.map((r) => r.note)).toEqual(["b1"]);
  });

  it("honors a smaller limit and hard-caps at 20", () => {
    for (let i = 0; i < 25; i++) dbInsertLog("bob", "finding", "n" + i);
    expect(dbListLogSince(0, null, 5)).toHaveLength(5);
    expect(dbListLogSince(0, null, 100)).toHaveLength(20); // hard cap
  });

  it("entries[0].id is the max id (the hook's next watermark)", () => {
    dbInsertLog("alice", "finding", "x");
    const last = dbInsertLog("bob", "finding", "y");
    expect(dbListLogSince(0, null, 5)[0].id).toBe(last.id);
  });

  it("is empty when nothing is newer than since", () => {
    const a = dbInsertLog("alice", "finding", "only");
    expect(dbListLogSince(a.id, null, 5)).toEqual([]);
  });
});
