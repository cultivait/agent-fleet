import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbPutBoardEntry } from "../db.js";
import { clearLastSeen, hasOpenPoll } from "../polling.js";
import { reapGhostAgents, reapStaleBoardEntries } from "../server.js";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

async function boardUpdate(body: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}/board-update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.joinToken}`,
    },
    body: JSON.stringify(body),
  });
}

interface BoardEntry {
  name: string;
  node: string | null;
  status: string;
  mission: string | null;
  activity: string | null;
  todos: Array<{ content: string; status: string }> | null;
  subagents: number;
  updatedAt: number;
  online: boolean;
}

async function getBoard(): Promise<BoardEntry[]> {
  const res = await fetch(`${ctx.baseUrl}/board`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { board: BoardEntry[] };
  return body.board;
}

describe("task board", () => {
  it("should reject /board-update without join token", async () => {
    const res = await fetch(`${ctx.baseUrl}/board-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject /board-update without name", async () => {
    const res = await boardUpdate({ mission: "no name" });
    expect(res.status).toBe(400);
  });

  it("should create an entry and serve it publicly on /board", async () => {
    const res = await boardUpdate({ name: "alice", node: "windows", mission: "ship the board" });
    expect(res.status).toBe(200);
    const board = await getBoard();
    const alice = board.find((e) => e.name === "alice");
    expect(alice).toBeDefined();
    expect(alice?.node).toBe("windows");
    expect(alice?.status).toBe("active");
    expect(alice?.mission).toBe("ship the board");
    expect(alice?.online).toBe(false);
  });

  it("should merge partial updates without clobbering other fields", async () => {
    await boardUpdate({ name: "alice", activity: "Edit hub/src/server.ts" });
    const alice = (await getBoard()).find((e) => e.name === "alice");
    expect(alice?.activity).toBe("Edit hub/src/server.ts");
    expect(alice?.mission).toBe("ship the board");
  });

  it("should store and return todos", async () => {
    await boardUpdate({
      name: "alice",
      todos: [
        { content: "one", status: "completed" },
        { content: "two", status: "in_progress" },
        { content: "", status: "pending" }, // dropped: empty content
      ],
    });
    const alice = (await getBoard()).find((e) => e.name === "alice");
    expect(alice?.todos).toEqual([
      { content: "one", status: "completed" },
      { content: "two", status: "in_progress" },
    ]);
  });

  it("should clear fields on explicit null", async () => {
    await boardUpdate({ name: "alice", status: "idle", activity: null });
    const alice = (await getBoard()).find((e) => e.name === "alice");
    expect(alice?.status).toBe("idle");
    expect(alice?.activity).toBeNull();
    expect(alice?.todos?.length).toBe(2);
  });

  it("should reject non-array todos", async () => {
    const res = await boardUpdate({ name: "alice", todos: "nope" });
    expect(res.status).toBe(400);
  });

  it("should default subagents to 0 for a new entry", async () => {
    await boardUpdate({ name: "subzero", mission: "no kids yet" });
    const e = (await getBoard()).find((b) => b.name === "subzero");
    expect(e?.subagents).toBe(0);
  });

  it("should set and merge the subagents count without clobbering other fields", async () => {
    await boardUpdate({ name: "subzero", subagents: 3 });
    const e = (await getBoard()).find((b) => b.name === "subzero");
    expect(e?.subagents).toBe(3);
    expect(e?.mission).toBe("no kids yet"); // untouched by a count-only update
  });

  it("should clamp the subagents count to >= 0 and floor fractions", async () => {
    await boardUpdate({ name: "subzero", subagents: -5 });
    expect((await getBoard()).find((b) => b.name === "subzero")?.subagents).toBe(0);
    await boardUpdate({ name: "subzero", subagents: 2.9 });
    expect((await getBoard()).find((b) => b.name === "subzero")?.subagents).toBe(2);
  });

  it("should reset subagents to 0 on explicit null", async () => {
    await boardUpdate({ name: "subzero", subagents: 4 });
    await boardUpdate({ name: "subzero", subagents: null });
    expect((await getBoard()).find((b) => b.name === "subzero")?.subagents).toBe(0);
  });

  it("should ignore a non-numeric subagents value (keep current)", async () => {
    await boardUpdate({ name: "subzero", subagents: 5 });
    await boardUpdate({ name: "subzero", subagents: "lots" });
    expect((await getBoard()).find((b) => b.name === "subzero")?.subagents).toBe(5);
  });

  it("should drop the prior card when a session rejoins under a new callsign (rename)", async () => {
    await boardUpdate({ name: "rename-old", sid: "sess-rename-1", mission: "first identity" });
    expect((await getBoard()).find((b) => b.name === "rename-old")).toBeDefined();
    // same session id, new callsign → old card is a stale duplicate, must vanish
    await boardUpdate({ name: "rename-new", sid: "sess-rename-1", mission: "renamed" });
    const board = await getBoard();
    expect(board.find((b) => b.name === "rename-old")).toBeUndefined();
    expect(board.find((b) => b.name === "rename-new")).toBeDefined();
  });

  it("should NOT cross-drop cards from different sessions, nor on the 'nosession' sentinel", async () => {
    await boardUpdate({ name: "keep-a", sid: "sess-A", mission: "distinct A" });
    await boardUpdate({ name: "keep-b", sid: "sess-B", mission: "distinct B" });
    // sentinel sid must never be treated as a shared session
    await boardUpdate({ name: "sentinel-1", sid: "nosession" });
    await boardUpdate({ name: "sentinel-2", sid: "nosession" });
    const board = await getBoard();
    for (const n of ["keep-a", "keep-b", "sentinel-1", "sentinel-2"]) {
      expect(board.find((b) => b.name === n)).toBeDefined();
    }
  });

  it("should zero the subagents count when an agent is retired", async () => {
    const token = await registerUser(ctx, "subretire");
    await boardUpdate({ name: "subretire", subagents: 2, mission: "spawning then leaving" });
    const res = await fetch(`${ctx.baseUrl}/unregister`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const e = (await getBoard()).find((b) => b.name === "subretire");
    expect(e?.status).toBe("signed-off");
    expect(e?.subagents).toBe(0);
  });

  it("should report online for a registered, connected agent", async () => {
    await registerUser(ctx, "bob");
    await boardUpdate({ name: "bob", node: "linux", mission: "be online" });
    const bob = (await getBoard()).find((e) => e.name === "bob");
    expect(bob?.online).toBe(true);
  });

  it("should reject wrong method on /board-update", async () => {
    const res = await fetch(`${ctx.baseUrl}/board-update`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ctx.joinToken}` },
    });
    expect(res.status).toBe(405);
  });

  it("should reject /admin-board-delete without admin token", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-board-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(401);
  });

  it("should 404 deleting an unknown board entry", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-board-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ name: "nobody" }),
    });
    expect(res.status).toBe(404);
  });

  it("should delete a board entry with admin token", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-board-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(200);
    const board = await getBoard();
    expect(board.find((e) => e.name === "alice")).toBeUndefined();
  });

  it("should retire the entry to signed-off when an agent unregisters", async () => {
    const token = await registerUser(ctx, "carol");
    await boardUpdate({ name: "carol", mission: "leaving soon", activity: "Edit something.ts" });
    const res = await fetch(`${ctx.baseUrl}/unregister`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const carol = (await getBoard()).find((e) => e.name === "carol");
    expect(carol?.status).toBe("signed-off");
    expect(carol?.activity).toBeNull();
    expect(carol?.mission).toBe("leaving soon"); // last known state stays readable
  });

  it("should retire the entry when an agent is kicked", async () => {
    await registerUser(ctx, "dave");
    await boardUpdate({ name: "dave", mission: "about to be kicked" });
    const res = await fetch(`${ctx.baseUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ name: "dave" }),
    });
    expect(res.status).toBe(200);
    expect((await getBoard()).find((e) => e.name === "dave")?.status).toBe("signed-off");
  });

  it("should reap a ghost agent that has no open poll and went stale", async () => {
    // Register but never poll: lastSeen is seeded at register, no open poll held.
    await registerUser(ctx, "ghost");
    await boardUpdate({ name: "ghost", mission: "died between polls" });
    expect(hasOpenPoll("ghost")).toBe(false);
    // grace 0 → immediately considered stale (no open poll, lastSeen in the past)
    const reaped = reapGhostAgents(0);
    expect(reaped).toContain("ghost");
    // unregistered from the hub and board entry retired
    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const users = (await usersRes.json()) as { users: Array<{ name: string }> };
    expect(users.users.find((u) => u.name === "ghost")).toBeUndefined();
    const board = await getBoard();
    expect(board.find((e) => e.name === "ghost")?.status).toBe("signed-off");
    clearLastSeen("ghost");
  });

  it("should NOT reap an agent seen within the grace window", async () => {
    await registerUser(ctx, "alive"); // register touches lastSeen = now
    const reaped = reapGhostAgents(60_000); // 60s grace; just-registered is fresh
    expect(reaped).not.toContain("alive");
    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const users = (await usersRes.json()) as { users: Array<{ name: string }> };
    expect(users.users.find((u) => u.name === "alive")).toBeDefined();
  });

  it("should NOT reap a working agent that heartbeats via board-update", async () => {
    // A heads-down agent (no standby poll) proves liveness via the taskboard
    // hook's board-update. Simulate it having gone stale, then heartbeat.
    await registerUser(ctx, "worker");
    clearLastSeen("worker");
    await boardUpdate({ name: "worker", activity: "Edit sync/asana.ts" });
    expect(reapGhostAgents(60_000)).not.toContain("worker");
    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const users = (await usersRes.json()) as { users: Array<{ name: string }> };
    expect(users.users.find((u) => u.name === "worker")).toBeDefined();
  });

  it("should reap an agent with no poll and no activity past grace", async () => {
    await registerUser(ctx, "stale");
    clearLastSeen("stale"); // no heartbeat, no poll
    expect(reapGhostAgents(60_000)).toContain("stale");
  });

  it("should reap old entries unless the agent is still registered and online", async () => {
    dbPutBoardEntry({
      name: "old-ghost",
      node: "mac",
      status: "signed-off",
      mission: null,
      activity: null,
      todos: null,
      subagents: 0,
      sid: null,
      updated_at: Date.now() - 2 * 3_600_000,
    });
    await registerUser(ctx, "fresh");
    await boardUpdate({ name: "fresh", mission: "alive and recent" });
    const reaped = reapStaleBoardEntries(3_600_000);
    expect(reaped).toContain("old-ghost");
    const board = await getBoard();
    expect(board.find((e) => e.name === "old-ghost")).toBeUndefined();
    expect(board.find((e) => e.name === "fresh")).toBeDefined();
  });
});
