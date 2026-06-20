import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbSaveMessage } from "../db.js";
import type { Message } from "../types.js";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// Integration tests for the rolling 16h live-window + the GET /messages history
// endpoint, exercised through the real HTTP routes. Retrieval is tested on a
// dedicated non-#all channel for clean isolation from other test traffic. (#all
// is no longer prune-capped — it joined the never-delete model.)

const HOUR_MS = 60 * 60 * 1000;
let ctx: TestContext;
let now: number;
let oldTs: number;
let recentTs: number;
let creatorToken: string;

async function createChannel(token: string, name: string): Promise<void> {
  const res = await fetch(`${ctx.baseUrl}/channel-create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 200) throw new Error(`channel-create failed: ${res.status}`);
}

function seed(id: string, channel: string, timestamp: number): void {
  const msg: Message = { id, from: "seeder", to: channel, content: `msg-${id}`, channel, timestamp };
  dbSaveMessage(msg);
}

beforeAll(async () => {
  ctx = await startTestServer();
  now = Date.now();
  oldTs = now - 20 * HOUR_MS; // outside the default 16h window
  recentTs = now - 1 * HOUR_MS; // inside the window

  // #win is a normal (non-#all) channel; its creator is auto-joined as a member.
  creatorToken = await registerUser(ctx, "win-creator");
  await createChannel(creatorToken, "win");
  seed("old1", "#win", oldTs);
  seed("recent1", "#win", recentTs);
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("GET /channel-history (agent-join history path) with the 16h window", () => {
  it("returns only messages inside the last 16h", async () => {
    const token = creatorToken;
    const res = await fetch(`${ctx.baseUrl}/channel-history?channel=${encodeURIComponent("#win")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Message[] };
    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain("recent1");
    expect(ids).not.toContain("old1");
  });
});

describe("GET /admin-channel-history (dashboard initial-load path) with the 16h window", () => {
  it("excludes >16h messages from the global recent load", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-channel-history`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Message[] };
    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain("recent1");
    expect(ids).not.toContain("old1");
  });

  it("excludes >16h messages from a channel-scoped load", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-channel-history?channel=${encodeURIComponent("#win")}`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Message[] };
    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain("recent1");
    expect(ids).not.toContain("old1");
  });
});

describe("GET /messages (history retrieval endpoint)", () => {
  it("returns messages OLDER than `before`, including >16h history", async () => {
    const token = creatorToken;
    const res = await fetch(`${ctx.baseUrl}/messages?channel=${encodeURIComponent("#win")}&before=${now + 1000}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Message[] };
    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain("old1"); // the >16h message is retrievable
    expect(ids).toContain("recent1");
  });

  it("returns newest-first", async () => {
    const token = creatorToken;
    const res = await fetch(`${ctx.baseUrl}/messages?channel=${encodeURIComponent("#win")}&before=${now + 1000}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { messages: Message[] };
    expect(body.messages.map((m) => m.id)).toEqual(["recent1", "old1"]);
  });

  it("excludes messages at or after `before`", async () => {
    const token = creatorToken;
    const res = await fetch(`${ctx.baseUrl}/messages?channel=${encodeURIComponent("#win")}&before=${recentTs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { messages: Message[] };
    const ids = body.messages.map((m) => m.id);
    expect(ids).toContain("old1");
    expect(ids).not.toContain("recent1");
  });

  it("defaults `before` to now when omitted (returns all existing history)", async () => {
    const token = creatorToken;
    const res = await fetch(`${ctx.baseUrl}/messages?channel=${encodeURIComponent("#win")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Message[] };
    expect(body.messages.map((m) => m.id).sort()).toEqual(["old1", "recent1"]);
  });

  it("requires a channel parameter", async () => {
    const token = creatorToken;
    const res = await fetch(`${ctx.baseUrl}/messages?before=${now}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-members (channel-scoped auth)", async () => {
    const outsider = await registerUser(ctx, "win-outsider");
    const res = await fetch(`${ctx.baseUrl}/messages?channel=${encodeURIComponent("#win")}`, {
      headers: { Authorization: `Bearer ${outsider}` },
    });
    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    const res = await fetch(`${ctx.baseUrl}/messages?channel=${encodeURIComponent("#win")}`);
    expect(res.status).toBe(401);
  });

  it("does not delete anything — both messages remain retrievable (no message loss)", async () => {
    const token = creatorToken;
    const res = await fetch(
      `${ctx.baseUrl}/messages?channel=${encodeURIComponent("#win")}&before=${now + 10_000}&limit=500`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = (await res.json()) as { messages: Message[] };
    expect(body.messages.map((m) => m.id).sort()).toEqual(["old1", "recent1"]);
  });
});

describe("SSE live stream is unchanged by the windowing", () => {
  it("still delivers a new message over GET /events", async () => {
    const ac = new AbortController();
    const evRes = await fetch(`${ctx.baseUrl}/events`, { signal: ac.signal });
    expect(evRes.status).toBe(200);
    const reader = evRes.body!.getReader();
    const decoder = new TextDecoder();

    const sender = await registerUser(ctx, "sse-sender");
    await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sender}` },
      body: JSON.stringify({ to: "@all", content: "sse-live-ping" }),
    });

    let buf = "";
    let found = false;
    // Bounded read: race each chunk against a timeout so a missing broadcast
    // fails the assertion instead of hanging the test.
    while (!found) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 3000),
        ),
      ]);
      if (next.done) break;
      buf += decoder.decode(next.value, { stream: true });
      if (buf.includes("sse-live-ping")) found = true;
    }
    ac.abort();
    expect(found).toBe(true);
  });
});
