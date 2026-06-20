import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// #6 soft-hang-retire ISOLATION test.
//
// The launcher reaps a fleet session with ONE retire POST keyed on the spawn_id
// it holds — the `reapRegisterPayload()` contract in scripts/fleet/fleet.mjs:
//   { spawn_id, node, status: "signed_off" }
// (its SHAPE is unit-tested in scripts/fleet/fleet.test.mjs; here we pin the
// hub's MERGE behaviour given that body, so the two stay in lockstep — this file
// deliberately does NOT import fleet.mjs to keep the hub tsc rootDir clean and
// avoid coupling to that single-writer file).
//
// api-session-registry.test.ts already proves a retire transitions the TARGET's
// registry row + roster/board ghost. What it never asserts is the ISOLATION
// property a fleet reaper lives or dies on: retiring session A must touch ONLY
// A — a co-resident sibling B (registry row, roster presence, board card) must
// be left exactly as it was. A reaper that collaterally signs-off siblings would
// silently decimate the fleet, and `kill --all` walking every linux row is the
// exact failure a node-keyed (rather than spawn_id-keyed) merge would cause.

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
  status: string;
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

async function rowBySpawn(spawnId: string): Promise<RegistryEntry | undefined> {
  return (await listRegistry()).find((e) => e.spawn_id === spawnId);
}

async function boardUpdate(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ctx.baseUrl}/board-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
    body: JSON.stringify(body),
  });
}

async function isOnRoster(name: string): Promise<boolean> {
  const res = await fetch(`${ctx.baseUrl}/users`);
  const body = (await res.json()) as { users: { name: string; online: boolean }[] };
  return body.users.some((u) => u.name === name && u.online);
}

async function boardStatus(name: string): Promise<string | undefined> {
  const res = await fetch(`${ctx.baseUrl}/board`);
  const body = (await res.json()) as { board: { name: string; status: string }[] };
  return body.board.find((r) => r.name === name)?.status;
}

// The retire body the launcher actually POSTs (reapRegisterPayload contract).
function retire(spawnId: string): Promise<Response> {
  return register({ spawn_id: spawnId, node: "linux", status: "signed_off" });
}

describe("#6 retire isolation — registry rows", () => {
  it("retires ONLY the targeted spawn_id and leaves same-node siblings active", async () => {
    // three co-resident linux siblings — if the merge keyed on `node` (not
    // spawn_id) a single reap would mass-retire the whole linux cohort.
    await register({ session_id: "sid-iso-a", spawn_id: "rid-iso-a", callsign: "linux-iso-a", node: "linux" });
    await register({ session_id: "sid-iso-b", spawn_id: "rid-iso-b", callsign: "linux-iso-b", node: "linux" });
    await register({ session_id: "sid-iso-c", spawn_id: "rid-iso-c", callsign: "linux-iso-c", node: "linux" });

    // reap the MIDDLE sibling only
    expect((await retire("rid-iso-b")).status).toBe(200);

    expect((await rowBySpawn("rid-iso-b"))?.status).toBe("signed_off"); // target retired
    expect((await rowBySpawn("rid-iso-a"))?.status).toBe("active"); // sibling untouched
    expect((await rowBySpawn("rid-iso-c"))?.status).toBe("active"); // sibling untouched
    // and the surviving rows keep their identity (no field bleed from the retire)
    expect((await rowBySpawn("rid-iso-a"))?.callsign).toBe("linux-iso-a");
    expect((await rowBySpawn("rid-iso-c"))?.callsign).toBe("linux-iso-c");
  });

  it("retiring one session leaves a co-resident sibling's roster + board presence intact", async () => {
    // both siblings fully live: roster (radio_join) + registry + board card
    await registerUser(ctx, "linux-pres-a");
    await register({ session_id: "sid-pres-a", spawn_id: "rid-pres-a", callsign: "linux-pres-a", node: "linux" });
    await boardUpdate({ name: "linux-pres-a", sid: "sid-pres-a", status: "active" });

    await registerUser(ctx, "linux-pres-b");
    await register({ session_id: "sid-pres-b", spawn_id: "rid-pres-b", callsign: "linux-pres-b", node: "linux" });
    await boardUpdate({ name: "linux-pres-b", sid: "sid-pres-b", status: "active" });

    expect(await isOnRoster("linux-pres-a")).toBe(true);
    expect(await isOnRoster("linux-pres-b")).toBe(true);

    // reap A
    expect((await retire("rid-pres-a")).status).toBe(200);

    // A's presence is retired in the same pass...
    expect(await isOnRoster("linux-pres-a")).toBe(false);
    expect(await boardStatus("linux-pres-a")).toBe("signed-off");
    // ...while B stays fully present — the reconciliation targeted A's callsign only
    expect(await isOnRoster("linux-pres-b")).toBe(true);
    expect(await boardStatus("linux-pres-b")).toBe("active");
    expect((await rowBySpawn("rid-pres-b"))?.status).toBe("active");
  });

  it("a redundant re-reap and an orphan reap never disturb a live sibling", async () => {
    await registerUser(ctx, "linux-idem-a");
    await register({ session_id: "sid-idem-a", spawn_id: "rid-idem-a", callsign: "linux-idem-a", node: "linux" });
    await boardUpdate({ name: "linux-idem-a", sid: "sid-idem-a", status: "active" });
    await register({ session_id: "sid-idem-b", spawn_id: "rid-idem-b", callsign: "linux-idem-b", node: "linux" });

    const rowsBefore = (await listRegistry()).length;

    // reap A, then reap A AGAIN (launcher re-fire / retry)
    expect((await retire("rid-idem-a")).status).toBe(200);
    expect((await retire("rid-idem-a")).status).toBe(200);
    // reap a spawn_id that never existed (stale launcher state)
    expect((await retire("rid-does-not-exist")).status).toBe(200);

    // sibling B is exactly as it was
    expect((await rowBySpawn("rid-idem-b"))?.status).toBe("active");
    expect((await rowBySpawn("rid-idem-b"))?.callsign).toBe("linux-idem-b");
    // the orphan reap created no phantom row beyond its own keyed upsert, and B's row still exists
    const rowsAfter = await listRegistry();
    expect(rowsAfter.find((e) => e.spawn_id === "rid-idem-b")).toBeDefined();
    // only the orphan spawn_id may have been added; no sibling rows were dropped
    expect(rowsAfter.length).toBeGreaterThanOrEqual(rowsBefore);
  });

  it("retires strictly by spawn_id — a sibling sharing the same callsign string is untouched", async () => {
    // two DISTINCT spawns that happen to carry the same callsign (e.g. a fresh
    // spawn computed a callsign a not-yet-reaped crashed row still holds). The
    // retire key is the spawn_id the launcher holds — NEVER the callsign — so a
    // reap must kill only the named spawn, not every row bearing that name.
    await register({ session_id: "sid-dup-a", spawn_id: "rid-dup-a", callsign: "linux-dup", node: "linux" });
    await register({ session_id: "sid-dup-b", spawn_id: "rid-dup-b", callsign: "linux-dup", node: "linux" });

    // reap the SECOND-registered of the pair: a retire that mis-keyed on callsign
    // would resolve to the FIRST row bearing "linux-dup" (rid-dup-a) and kill the
    // wrong session — so targeting rid-dup-b proves the key is spawn_id, not name.
    expect((await retire("rid-dup-b")).status).toBe(200);

    expect((await rowBySpawn("rid-dup-b"))?.status).toBe("signed_off"); // named spawn retired
    expect((await rowBySpawn("rid-dup-a"))?.status).toBe("active"); // same-callsign sibling survives
  });
});
