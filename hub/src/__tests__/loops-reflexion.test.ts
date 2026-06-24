import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  registerUser,
  startTestServer,
  stopTestServer,
  type TestContext,
} from "./helpers/server-harness.js";

let ctx: TestContext;
let aliceToken: string;
let bobToken: string;

beforeAll(async () => {
  ctx = await startTestServer();
  aliceToken = await registerUser(ctx, "refl-alice");
  bobToken = await registerUser(ctx, "refl-bob");
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
  const res = await post("/loop-create", { kind: "generic", label: "refl", config }, token);
  expect(res.status).toBe(200);
  const { loop } = (await res.json()) as { loop: { id: string } };
  return loop.id;
}

describe("loop reflexion memory — record, feed back, bound", () => {
  it("rejects /loop-reflect without a user token (401)", async () => {
    const res = await post("/loop-reflect", { loop_id: "loop_x", reflection: "x" });
    expect(res.status).toBe(401);
  });

  it("records a reflection and lists it most-recent-first", async () => {
    const id = await createLoop(aliceToken);
    const r1 = await post("/loop-reflect", { loop_id: id, reflection: "tried A, failed on edge case", iteration: 1 }, aliceToken);
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { ok: boolean; count: number }).count).toBe(1);

    // any member who can tick can also reflect
    const r2 = await post("/loop-reflect", { loop_id: id, reflection: "tried B, closer", iteration: 2 }, bobToken);
    expect(((await r2.json()) as { count: number }).count).toBe(2);

    const list = await post("/loop-reflections", { loop_id: id }, aliceToken);
    const { reflections } = (await list.json()) as {
      reflections: Array<{ reflection: string; agent_callsign: string; iteration: number }>;
    };
    expect(reflections).toHaveLength(2);
    expect(reflections[0].reflection).toBe("tried B, closer"); // newest first
    expect(reflections[0].agent_callsign).toBe("refl-bob");
    expect(reflections[1].agent_callsign).toBe("refl-alice");
  });

  it("feeds prior reflections back in the /loop-tick response", async () => {
    const id = await createLoop(aliceToken);
    // no reflections yet → bare contract, no reflections key
    const bare = await (await post("/loop-tick", { id }, aliceToken)).json();
    expect(bare).toEqual({ continue: true });

    await post("/loop-reflect", { loop_id: id, reflection: "remember: validate input first" }, aliceToken);
    const tick = await post("/loop-tick", { id }, aliceToken);
    const body = (await tick.json()) as { continue: boolean; reflections?: Array<{ reflection: string }> };
    expect(body.continue).toBe(true);
    expect(body.reflections).toBeDefined();
    expect(body.reflections?.[0].reflection).toBe("remember: validate input first");
  });

  it("bounds reflections per loop (prunes oldest beyond the cap)", async () => {
    const id = await createLoop(aliceToken);
    const CAP = 25; // MAX_REFLECTIONS_PER_LOOP
    for (let i = 1; i <= CAP + 5; i++) {
      const res = await post("/loop-reflect", { loop_id: id, reflection: `reflection #${i}`, iteration: i }, aliceToken);
      expect(res.status).toBe(200);
    }
    const list = await post("/loop-reflections", { loop_id: id, limit: 100 }, aliceToken);
    const { reflections } = (await list.json()) as { reflections: Array<{ reflection: string }> };
    expect(reflections).toHaveLength(CAP);
    // newest retained, oldest (reflection #1..#5) pruned
    expect(reflections[0].reflection).toBe(`reflection #${CAP + 5}`);
    expect(reflections.some((r) => r.reflection === "reflection #1")).toBe(false);
    expect(reflections[reflections.length - 1].reflection).toBe("reflection #6");
  });

  it("404s reflecting on an unknown loop", async () => {
    const res = await post("/loop-reflect", { loop_id: "loop_nope", reflection: "x" }, aliceToken);
    expect(res.status).toBe(404);
  });

  it("400s on empty reflection text", async () => {
    const id = await createLoop(aliceToken);
    const res = await post("/loop-reflect", { loop_id: id, reflection: "   " }, aliceToken);
    expect(res.status).toBe(400);
  });
});
