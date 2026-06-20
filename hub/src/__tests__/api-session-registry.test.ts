import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reapCrashedSessions } from "../server.js";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

interface RegistryEntry {
  session_id: string | null;
  spawn_id: string | null;
  callsign: string | null;
  node: string | null;
  workdir: string | null;
  started_at: number | null;
  pid: number | null;
  control_handle: string | null;
  worktree_path: string | null;
  owned_branch: string | null;
  status: string;
  last_standby_at: number | null;
  context_tokens: number | null;
  context_ts: number | null;
}

async function register(body: Record<string, unknown>, token = ctx.joinToken): Promise<Response> {
  return fetch(`${ctx.baseUrl}/session-register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function listRegistry(): Promise<RegistryEntry[]> {
  const res = await fetch(`${ctx.baseUrl}/registry`);
  const body = (await res.json()) as { registry: RegistryEntry[] };
  return body.registry;
}

async function boardUpdate(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ctx.baseUrl}/board-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
    body: JSON.stringify(body),
  });
}

interface RosterUser {
  name: string;
  online: boolean;
}

async function listUsers(): Promise<RosterUser[]> {
  const res = await fetch(`${ctx.baseUrl}/users`);
  const body = (await res.json()) as { users: RosterUser[] };
  return body.users;
}

// True when the roster shows this callsign present AND online — i.e. a live or
// ghosted presence. False when offline or fully unregistered (the retired state).
async function isOnRoster(name: string): Promise<boolean> {
  return (await listUsers()).some((u) => u.name === name && u.online);
}

interface BoardRow {
  name: string;
  status: string;
}

async function getBoardRow(name: string): Promise<BoardRow | undefined> {
  const res = await fetch(`${ctx.baseUrl}/board`);
  const body = (await res.json()) as { board: BoardRow[] };
  return body.board.find((r) => r.name === name);
}

describe("POST /session-register", () => {
  it("registers a session and lists it in /registry", async () => {
    const res = await register({
      session_id: "sid-A",
      spawn_id: "rid-A",
      callsign: "linux-aaaa",
      node: "linux",
      workdir: "/home/x",
      started_at: 1000,
    });
    expect(res.status).toBe(200);
    const entry = (await listRegistry()).find((e) => e.session_id === "sid-A");
    expect(entry).toBeDefined();
    expect(entry?.spawn_id).toBe("rid-A");
    expect(entry?.callsign).toBe("linux-aaaa");
    expect(entry?.workdir).toBe("/home/x");
    expect(entry?.status).toBe("active");
  });

  it("requires the join token", async () => {
    const res = await register({ session_id: "sid-noauth" }, "wrong-token");
    expect(res.status).toBe(401);
  });

  it("rejects a payload with neither session_id nor spawn_id", async () => {
    const res = await register({ callsign: "orphan", node: "linux" });
    expect(res.status).toBe(400);
  });

  it("merges launcher-first then session into one row on spawn_id", async () => {
    // launcher writes first (no session_id yet — only spawn_id + pid + handle)
    expect(
      (await register({ spawn_id: "rid-B", pid: 4242, control_handle: "tmux:wt-rid-B", node: "linux" })).status,
    ).toBe(200);
    // session start arrives later carrying the same spawn_id
    expect(
      (
        await register({
          session_id: "sid-B",
          spawn_id: "rid-B",
          callsign: "linux-bbbb",
          workdir: "/b",
          started_at: 2000,
        })
      ).status,
    ).toBe(200);

    const rows = (await listRegistry()).filter((e) => e.spawn_id === "rid-B");
    expect(rows).toHaveLength(1); // merged, not duplicated
    expect(rows[0].pid).toBe(4242); // launcher field preserved
    expect(rows[0].control_handle).toBe("tmux:wt-rid-B");
    expect(rows[0].session_id).toBe("sid-B"); // session field merged in
    expect(rows[0].callsign).toBe("linux-bbbb");
  });

  it("merges session-first then launcher into one row on spawn_id", async () => {
    expect(
      (
        await register({
          session_id: "sid-C",
          spawn_id: "rid-C",
          callsign: "linux-cccc",
          workdir: "/c",
          started_at: 3000,
        })
      ).status,
    ).toBe(200);
    expect(
      (await register({ spawn_id: "rid-C", pid: 5252, control_handle: "tmux:wt-rid-C", node: "linux" })).status,
    ).toBe(200);

    const rows = (await listRegistry()).filter((e) => e.spawn_id === "rid-C");
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(5252);
    expect(rows[0].session_id).toBe("sid-C");
  });

  it("preserves earlier fields a later partial omits (pid survives a session re-post)", async () => {
    await register({ spawn_id: "rid-D", pid: 6363, node: "linux" });
    await register({ session_id: "sid-D", spawn_id: "rid-D", callsign: "linux-dddd" });
    // a later status-only refresh must not wipe pid
    await register({ session_id: "sid-D", spawn_id: "rid-D" });
    const rows = (await listRegistry()).filter((e) => e.spawn_id === "rid-D");
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(6363);
    expect(rows[0].callsign).toBe("linux-dddd");
  });

  it("upserts a human session (no spawn_id) by session_id without duplicating", async () => {
    await register({ session_id: "sid-human", callsign: "windows-x", node: "windows", workdir: "/w" });
    await register({ session_id: "sid-human", callsign: "windows-x", workdir: "/w2" });
    const rows = (await listRegistry()).filter((e) => e.session_id === "sid-human");
    expect(rows).toHaveLength(1);
    expect(rows[0].spawn_id).toBeNull();
    expect(rows[0].workdir).toBe("/w2");
  });
});

describe("board-update callsign stamp", () => {
  it("stamps the confirmed callsign onto the registry row for that sid", async () => {
    // SessionStart registers with a COMPUTED callsign
    await register({ session_id: "sid-E", spawn_id: "rid-E", callsign: "linux-eeee", node: "linux", workdir: "/e" });
    // radio_join board-update carries the CONFIRMED callsign + sid
    expect((await boardUpdate({ name: "linux-cockpit", sid: "sid-E", status: "active" })).status).toBe(200);
    const entry = (await listRegistry()).find((e) => e.session_id === "sid-E");
    expect(entry?.callsign).toBe("linux-cockpit"); // confirmed overrides computed
  });
});

describe("reapCrashedSessions liveness sweep", () => {
  it("marks a dead pid CRASHED and leaves a live pid active", async () => {
    // a definitely-dead pid: spawn then kill, await exit
    const child = spawn("sleep", ["60"]);
    const deadPid = child.pid as number;
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    await register({ session_id: "sid-dead", spawn_id: "rid-dead", pid: deadPid, callsign: "linux-dead" });
    await register({ session_id: "sid-live", spawn_id: "rid-live", pid: process.pid, callsign: "linux-live" });

    const reaped = reapCrashedSessions();
    expect(reaped).toContain("sid-dead");
    expect(reaped).not.toContain("sid-live");

    const rows = await listRegistry();
    expect(rows.find((e) => e.session_id === "sid-dead")?.status).toBe("crashed");
    expect(rows.find((e) => e.session_id === "sid-live")?.status).toBe("active");
  });
});

describe("presence reconciliation on terminal status (option b)", () => {
  it("retires the roster + board ghost when a signed_off POST lands (launcher kill)", async () => {
    // the agent is live on the roster (radio_join) AND has a registry row + board entry
    await registerUser(ctx, "linux-ffff");
    await register({ session_id: "sid-F", spawn_id: "rid-F", callsign: "linux-ffff", node: "linux", workdir: "/f" });
    await boardUpdate({ name: "linux-ffff", sid: "sid-F", status: "active" });
    expect(await isOnRoster("linux-ffff")).toBe(true); // precondition: a live presence
    expect((await getBoardRow("linux-ffff"))?.status).toBe("active");

    // launcher reaps it: one signed_off POST keyed by the spawn_id it holds
    const res = await register({ spawn_id: "rid-F", status: "signed_off" });
    expect(res.status).toBe(200);

    // registry row reflects the kill...
    expect((await listRegistry()).find((e) => e.spawn_id === "rid-F")?.status).toBe("signed_off");
    // ...AND the roster/board ghost is gone in the SAME pass — no 40min wait, no admin-kick
    expect(await isOnRoster("linux-ffff")).toBe(false);
    expect((await getBoardRow("linux-ffff"))?.status).toBe("signed-off");
  });

  it("retires the roster + board ghost when the crash sweep marks a row crashed", async () => {
    const child = spawn("sleep", ["60"]);
    const deadPid = child.pid as number;
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    await registerUser(ctx, "linux-gggg");
    await register({ session_id: "sid-G", spawn_id: "rid-G", callsign: "linux-gggg", pid: deadPid });
    await boardUpdate({ name: "linux-gggg", sid: "sid-G", status: "active" });
    expect(await isOnRoster("linux-gggg")).toBe(true);

    reapCrashedSessions();

    expect((await listRegistry()).find((e) => e.session_id === "sid-G")?.status).toBe("crashed");
    expect(await isOnRoster("linux-gggg")).toBe(false);
    expect((await getBoardRow("linux-gggg"))?.status).toBe("signed-off");
  });

  it("is a safe no-op when the signed_off row's callsign was never on the roster", async () => {
    // a session killed before it ever radio_joined: registry row exists, no roster presence
    await register({ spawn_id: "rid-H", callsign: "linux-hhhh", node: "linux" });
    const before = await listUsers();
    expect(before.some((u) => u.name === "linux-hhhh")).toBe(false);

    const res = await register({ spawn_id: "rid-H", status: "signed_off" });
    expect(res.status).toBe(200); // does not throw on a missing roster entry
    expect((await listRegistry()).find((e) => e.spawn_id === "rid-H")?.status).toBe("signed_off");
    // unaffected callsigns stay exactly as they were
    expect(await listUsers()).toHaveLength(before.length);
  });
});

// The gauge producer (wt-context-gauge.js) writes the live context occupancy +
// a freshness-ts. context_ts is the producer's "still writing?" liveness signal
// (advancing = live-but-quiet, stalled = frozen gauge → liveness sweep, never a
// pointless compact). It must round-trip and partial-merge like any registry field.
describe("context_ts gauge freshness column", () => {
  it("round-trips context_tokens + context_ts via /session-register → /registry", async () => {
    await register({
      session_id: "sid-gauge",
      spawn_id: "rid-gauge",
      callsign: "linux-gauge",
      context_tokens: 188359,
      context_ts: 1781700000000,
    });
    const entry = (await listRegistry()).find((e) => e.session_id === "sid-gauge");
    expect(entry?.context_tokens).toBe(188359);
    expect(entry?.context_ts).toBe(1781700000000);
  });

  it("a later gauge-only write advances context_ts + context_tokens without wiping identity", async () => {
    await register({ session_id: "sid-gauge2", spawn_id: "rid-gauge2", callsign: "linux-gauge2", pid: 9988 });
    await register({ spawn_id: "rid-gauge2", context_tokens: 250000, context_ts: 1781700001000 });
    const entry = (await listRegistry()).find((e) => e.spawn_id === "rid-gauge2");
    expect(entry?.context_tokens).toBe(250000);
    expect(entry?.context_ts).toBe(1781700001000);
    expect(entry?.callsign).toBe("linux-gauge2"); // identity preserved across a gauge-only POST
    expect(entry?.pid).toBe(9988);
  });
});
