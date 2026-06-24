import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// Phase 2 operator endpoints: admin-gated loop visibility + override pause/resume.
// These mirror /loop-admin-stop — admin token, operator override, NO owner check.

let ctx: TestContext;
let ownerToken: string;

beforeAll(async () => {
  ctx = await startTestServer();
  ownerToken = await registerUser(ctx, "loop-owner");
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}
function get(path: string, token?: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
async function createLoop(config?: unknown): Promise<string> {
  const res = await post("/loop-create", { kind: "generic", label: "ops", config }, ownerToken);
  expect(res.status).toBe(200);
  return ((await res.json()) as { loop: { id: string } }).loop.id;
}

describe("/loop-admin-list (admin read)", () => {
  it("rejects without the admin token (401), including a member token", async () => {
    expect((await get("/loop-admin-list")).status).toBe(401);
    expect((await get("/loop-admin-list", ownerToken)).status).toBe(401);
  });

  it("returns every loop plus a server clock with the admin token", async () => {
    const id = await createLoop({ max_iterations: 5 });
    const res = await get("/loop-admin-list", ctx.adminToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loops: Array<{ id: string; owner_callsign: string }>; now: number };
    expect(typeof body.now).toBe("number");
    const mine = body.loops.find((l) => l.id === id);
    expect(mine?.owner_callsign).toBe("loop-owner");
  });
});

describe("/loop-admin-pause + /loop-admin-resume (operator override)", () => {
  it("rejects without the admin token (401)", async () => {
    const id = await createLoop();
    expect((await post("/loop-admin-pause", { id }, ownerToken)).status).toBe(401);
    expect((await post("/loop-admin-resume", { id })).status).toBe(401);
  });

  it("pauses then resumes a loop owned by someone else (no owner check)", async () => {
    const id = await createLoop();
    const paused = await post("/loop-admin-pause", { id }, ctx.adminToken);
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { loop: { status: string } }).loop.status).toBe("paused");

    const resumed = await post("/loop-admin-resume", { id }, ctx.adminToken);
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { loop: { status: string } }).loop.status).toBe("running");
  });

  it("404s an unknown id and 400s a missing id", async () => {
    expect((await post("/loop-admin-pause", { id: "loop_nope" }, ctx.adminToken)).status).toBe(404);
    expect((await post("/loop-admin-resume", {}, ctx.adminToken)).status).toBe(400);
  });
});
