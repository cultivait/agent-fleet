import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reapDeadRegistryRows } from "../server.js";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// Registry GC (reapDeadRegistryRows) prunes the dead session ledger that reapCrashedSessions
// only ever MARKS. These tests pin the two safety guards (alive row; live-identity newest
// row of a connected callsign) and the deletion of malformed / superseded / old-dead rows —
// the exact shapes that produced 9 stale "REFEREE" rows + a "who-B" fixture in prod.

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
  started_at: number | null;
  pid: number | null;
  status: string;
}

async function register(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ctx.baseUrl}/session-register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
    body: JSON.stringify(body),
  });
}

async function listRegistry(): Promise<RegistryEntry[]> {
  const res = await fetch(`${ctx.baseUrl}/registry`);
  const body = (await res.json()) as { registry: RegistryEntry[] };
  return body.registry;
}

const has = (rows: RegistryEntry[], sid: string) => rows.some((r) => r.session_id === sid);

// A reliably-dead pid: spawn then SIGKILL and await exit, so process.kill(pid,0) ⇒ ESRCH.
async function deadPid(): Promise<number> {
  const child = spawn("sleep", ["60"]);
  const pid = child.pid as number;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return pid;
}

describe("reapDeadRegistryRows (registry GC)", () => {
  it("deletes a malformed row with no started_at (the 'who-B' fixture shape)", async () => {
    await register({ session_id: "gc-who-B", callsign: "REFEREE", node: "linux", workdir: "/b" }); // no started_at
    expect(has(await listRegistry(), "gc-who-B")).toBe(true);

    reapDeadRegistryRows(60_000);

    expect(has(await listRegistry(), "gc-who-B")).toBe(false);
  });

  it("collapses superseded duplicates of a callsign but KEEPS the newest live-identity row", async () => {
    // newest row backs the connected identity (on the roster) — must survive even though
    // it carries no pid (undeterminable liveness, like a heads-down REFEREE session).
    await registerUser(ctx, "linux-keep");
    await register({ session_id: "gc-keep-new", callsign: "linux-keep", started_at: 9_000_000_000 });
    // three older superseded rows for the SAME callsign — stale, must all be pruned.
    await register({ session_id: "gc-keep-old1", callsign: "linux-keep", started_at: 1000 });
    await register({ session_id: "gc-keep-old2", callsign: "linux-keep", started_at: 2000 });
    await register({ session_id: "gc-keep-old3", callsign: "linux-keep", started_at: 3000 });

    reapDeadRegistryRows(60_000);

    const rows = await listRegistry();
    expect(has(rows, "gc-keep-new")).toBe(true); // guard (2): newest row of a registered callsign
    expect(has(rows, "gc-keep-old1")).toBe(false);
    expect(has(rows, "gc-keep-old2")).toBe(false);
    expect(has(rows, "gc-keep-old3")).toBe(false);
    expect(rows.filter((r) => r.callsign === "linux-keep")).toHaveLength(1);
  });

  it("never deletes a row whose pid is still alive, even if superseded", async () => {
    // older row is alive (this test process) → guard (1); newer row is a dead duplicate.
    await register({ session_id: "gc-alive", callsign: "linux-dup", pid: process.pid, started_at: 1000 });
    await register({ session_id: "gc-dup-dead", callsign: "linux-dup", pid: await deadPid(), started_at: 5000 });

    reapDeadRegistryRows(60_000);

    const rows = await listRegistry();
    expect(has(rows, "gc-alive")).toBe(true); // alive ⇒ sacrosanct regardless of newest-ness
    expect(has(rows, "gc-dup-dead")).toBe(false); // dead + superseded ⇒ pruned
  });

  it("deletes the newest row of a DEPARTED callsign (dead pid, not on the roster)", async () => {
    await register({ session_id: "gc-gone", callsign: "linux-gone", pid: await deadPid(), started_at: 1000 });
    expect(has(await listRegistry(), "gc-gone")).toBe(true);

    reapDeadRegistryRows(60_000);

    expect(has(await listRegistry(), "gc-gone")).toBe(false);
  });

  it("KEEPS a newest unregistered row that is old but UNDETERMINABLE (no pid/handle) — no false-positive reap", async () => {
    // Post-bounce a live-but-idle session stays un-rejoined (not on roster) and may carry no
    // pid/control_handle, so its liveness is undeterminable. Age alone must NOT reap it — that
    // would churn a live session's identity (the linux-0a24 hazard). Only PROVEN death reaps.
    await register({ session_id: "gc-idle", callsign: "linux-idle", started_at: 1000 }); // old, no pid, not on roster

    reapDeadRegistryRows(60_000);

    expect(has(await listRegistry(), "gc-idle")).toBe(true);
  });

  it("respects the grace window — a recent dead-but-newest unregistered row is kept until it ages out", async () => {
    // started_at = now ⇒ not yet 'old'; pid dead, callsign not on roster, no newer sibling.
    await register({ session_id: "gc-recent", callsign: "linux-recent", pid: await deadPid(), started_at: Date.now() });

    reapDeadRegistryRows(3600_000); // 1h grace — the row is seconds old

    expect(has(await listRegistry(), "gc-recent")).toBe(true);
  });
});
