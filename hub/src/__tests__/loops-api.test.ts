import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;
let aliceToken: string;
let bobToken: string;

beforeAll(async () => {
  ctx = await startTestServer();
  aliceToken = await registerUser(ctx, "loop-alice");
  bobToken = await registerUser(ctx, "loop-bob");
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function createLoop(token: string, config?: unknown): Promise<string> {
  const res = await post("/loop-create", { kind: "generic", label: "api", config }, token);
  expect(res.status).toBe(200);
  const { loop } = (await res.json()) as { loop: { id: string } };
  return loop.id;
}

describe("loop API — auth + ownership", () => {
  it("rejects /loop-create without a user token (401)", async () => {
    const res = await post("/loop-create", { kind: "generic", label: "x" });
    expect(res.status).toBe(401);
  });

  it("creates a loop owned by the authenticated caller", async () => {
    const res = await post(
      "/loop-create",
      { kind: "generic", label: "owned", config: { max_iterations: 5 } },
      aliceToken,
    );
    expect(res.status).toBe(200);
    const { loop } = (await res.json()) as {
      loop: { id: string; owner_callsign: string; status: string };
    };
    expect(loop.owner_callsign).toBe("loop-alice");
    expect(loop.status).toBe("running");
    expect(loop.id).toMatch(/^loop_/);
  });

  it("lets any member tick, but only the owner pause/resume/stop", async () => {
    const id = await createLoop(aliceToken);

    // any member can tick
    const tick = await post("/loop-tick", { id, tokens_delta: 10 }, bobToken);
    expect(tick.status).toBe(200);
    expect(await tick.json()).toEqual({ continue: true });

    // non-owner cannot pause
    expect((await post("/loop-pause", { id }, bobToken)).status).toBe(403);
    // owner can pause
    const paused = await post("/loop-pause", { id }, aliceToken);
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { loop: { status: string } }).loop.status).toBe("paused");

    // non-owner cannot resume; owner can
    expect((await post("/loop-resume", { id }, bobToken)).status).toBe(403);
    const resumed = await post("/loop-resume", { id }, aliceToken);
    expect(((await resumed.json()) as { loop: { status: string } }).loop.status).toBe("running");

    // non-owner cannot stop; owner can
    expect((await post("/loop-stop", { id }, bobToken)).status).toBe(403);
    const stopped = await post("/loop-stop", { id, reason: "external_terminate" }, aliceToken);
    expect(((await stopped.json()) as { loop: { status: string; stop_reason: string } }).loop.status).toBe("stopped");
  });

  it("enforces a stop-condition end-to-end via /loop-tick", async () => {
    const id = await createLoop(aliceToken, { max_iterations: 2 });
    expect(await (await post("/loop-tick", { id }, aliceToken)).json()).toEqual({ continue: true });
    expect(await (await post("/loop-tick", { id }, aliceToken)).json()).toEqual({
      continue: false,
      stop_reason: "max_iterations",
    });
  });

  it("returns 404 ticking an unknown loop", async () => {
    const res = await post("/loop-tick", { id: "loop_nope" }, aliceToken);
    expect(res.status).toBe(404);
  });

  it("serves loops via /loop-get and /loop-list", async () => {
    const id = await createLoop(aliceToken);
    const got = await post("/loop-get", { id }, aliceToken);
    expect(((await got.json()) as { loop: { id: string } }).loop.id).toBe(id);

    const list = await post("/loop-list", { owner_callsign: "loop-alice" }, aliceToken);
    const { loops } = (await list.json()) as { loops: Array<{ id: string }> };
    expect(loops.some((l) => l.id === id)).toBe(true);
  });
});

describe("loop API — operator force-stop (admin token)", () => {
  it("force-stops ANY loop with the admin token, and rejects non-admin", async () => {
    const id = await createLoop(aliceToken);

    // a normal user token cannot reach the admin route
    expect((await post("/loop-admin-stop", { id }, aliceToken)).status).toBe(401);

    // admin token force-stops regardless of owner
    const res = await post("/loop-admin-stop", { id, reason: "external_terminate" }, ctx.adminToken);
    expect(res.status).toBe(200);
    const { loop } = (await res.json()) as { loop: { status: string; stop_reason: string } };
    expect(loop.status).toBe("stopped");
    expect(loop.stop_reason).toBe("external_terminate");
  });
});
