import { beforeEach, describe, expect, it } from "vitest";
import { dbGetChannelMessages, dbGetChannelMessagesBefore, dbGetRecentMessages, dbSaveMessage, initDB } from "../db.js";
import type { Message } from "../types.js";

// Pure DB-layer tests for the rolling live-window (filter-on-read) + the
// older-than-`before` history retrieval. Deterministic: timestamps are passed
// explicitly, no wall-clock dependence inside the DB functions themselves.

function seed(id: string, channel: string, timestamp: number): void {
  const msg: Message = {
    id,
    from: "tester",
    to: channel,
    content: `msg-${id}`,
    channel,
    timestamp,
  };
  dbSaveMessage(msg);
}

const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
});

describe("dbGetChannelMessagesBefore", () => {
  it("returns only messages strictly older than `before`, newest-first", () => {
    seed("a", "#room", 1000);
    seed("b", "#room", 2000);
    seed("c", "#room", 3000);
    seed("d", "#room", 4000);

    const result = dbGetChannelMessagesBefore("#room", 3000, 200);

    expect(result.map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("respects the limit, returning the newest below `before`", () => {
    seed("a", "#room", 1000);
    seed("b", "#room", 2000);
    seed("c", "#room", 3000);
    seed("d", "#room", 4000);

    const result = dbGetChannelMessagesBefore("#room", 5000, 2);

    expect(result.map((m) => m.id)).toEqual(["d", "c"]);
  });

  it("is channel-scoped (never leaks other channels)", () => {
    seed("a", "#alpha", 1000);
    seed("b", "#beta", 1500);
    seed("c", "#alpha", 2000);

    const result = dbGetChannelMessagesBefore("#alpha", 5000, 200);

    expect(result.map((m) => m.id)).toEqual(["c", "a"]);
  });
});

describe("dbGetChannelMessages with a sinceMs window", () => {
  it("excludes messages older than the window boundary", () => {
    const now = 1_000_000_000_000;
    seed("old", "#room", now - 20 * HOUR_MS);
    seed("recent", "#room", now - 1 * HOUR_MS);

    const result = dbGetChannelMessages("#room", 50, now - 16 * HOUR_MS);

    expect(result.map((m) => m.id)).toEqual(["recent"]);
  });

  it("returns all channel messages when no window is given (back-compat)", () => {
    const now = 1_000_000_000_000;
    seed("old", "#room", now - 20 * HOUR_MS);
    seed("recent", "#room", now - 1 * HOUR_MS);

    const result = dbGetChannelMessages("#room", 50);

    expect(result.map((m) => m.id)).toEqual(["old", "recent"]);
  });

  it("includes a message exactly on the window boundary (>= boundary)", () => {
    const now = 1_000_000_000_000;
    const boundary = now - 16 * HOUR_MS;
    seed("edge", "#room", boundary);

    const result = dbGetChannelMessages("#room", 50, boundary);

    expect(result.map((m) => m.id)).toEqual(["edge"]);
  });

  it("keeps the NEWEST `limit` in-window messages, not the oldest (displayed oldest-first)", () => {
    // P1 regression: a busy channel with > limit messages inside the window must
    // surface the most RECENT `limit`, not the oldest. (ASC+LIMIT returned oldest.)
    const now = 1_000_000_000_000;
    seed("m1", "#busy", now - 5000); // oldest
    seed("m2", "#busy", now - 4000);
    seed("m3", "#busy", now - 3000);
    seed("m4", "#busy", now - 2000);
    seed("m5", "#busy", now - 1000); // newest

    const result = dbGetChannelMessages("#busy", 3, now - 16 * HOUR_MS);

    expect(result.map((m) => m.id)).toEqual(["m3", "m4", "m5"]);
  });

  it("keeps the NEWEST `limit` even without a window (back-compat ordering fix)", () => {
    const now = 1_000_000_000_000;
    seed("m1", "#busy", now - 5000);
    seed("m2", "#busy", now - 4000);
    seed("m3", "#busy", now - 3000);
    seed("m4", "#busy", now - 2000);
    seed("m5", "#busy", now - 1000);

    const result = dbGetChannelMessages("#busy", 2);

    expect(result.map((m) => m.id)).toEqual(["m4", "m5"]);
  });
});

describe("dbGetRecentMessages with a sinceMs window", () => {
  it("excludes messages older than the window boundary across channels", () => {
    const now = 1_000_000_000_000;
    seed("old-a", "#alpha", now - 20 * HOUR_MS);
    seed("recent-a", "#alpha", now - 2 * HOUR_MS);
    seed("recent-b", "#beta", now - 1 * HOUR_MS);

    const result = dbGetRecentMessages(200, now - 16 * HOUR_MS);

    expect(result.map((m) => m.id).sort()).toEqual(["recent-a", "recent-b"]);
  });

  it("returns all recent messages when no window is given (back-compat)", () => {
    const now = 1_000_000_000_000;
    seed("old-a", "#alpha", now - 20 * HOUR_MS);
    seed("recent-a", "#alpha", now - 2 * HOUR_MS);

    const result = dbGetRecentMessages(200);

    expect(result.map((m) => m.id).sort()).toEqual(["old-a", "recent-a"]);
  });
});
