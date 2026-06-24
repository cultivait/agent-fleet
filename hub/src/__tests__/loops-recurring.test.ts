import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLoop, getLoop, tickLoop } from "../loops/store.js";
import { computeNextFire, fireDrift } from "../loops/schedule.js";
import {
  registerUser,
  startTestServer,
  stopTestServer,
  type TestContext,
} from "./helpers/server-harness.js";

let ctx: TestContext;
let aliceToken: string;

beforeAll(async () => {
  ctx = await startTestServer();
  aliceToken = await registerUser(ctx, "rec-alice");
});

afterAll(async () => {
  await stopTestServer(ctx);
});

// A deliberately-stale anchor: a real tick lands many intervals after it, which is
// exactly the "drift" case — it lets us prove grid alignment against the real clock
// without being able to inject Date.now() into the store.
const PAST_ANCHOR = 1_000_000;
const I = 1000;

describe("createLoop — recurring schedule (store)", () => {
  it("a non-recurring loop keeps every schedule column null", () => {
    const loop = createLoop({ kind: "generic", label: "plain", owner_callsign: "a" });
    expect(loop.interval_ms).toBeNull();
    expect(loop.anchor_ms).toBeNull();
    expect(loop.last_fire_ms).toBeNull();
    expect(loop.next_fire_ms).toBeNull();
  });

  it("interval_ms makes it recurring: anchor defaults to created_at, next_fire = anchor+interval, last_fire null", () => {
    const loop = createLoop({ kind: "generic", label: "rec", owner_callsign: "a", interval_ms: 60_000 });
    expect(loop.interval_ms).toBe(60_000);
    expect(loop.anchor_ms).toBe(loop.created_at); // default grid origin
    expect(loop.next_fire_ms).toBe(loop.created_at + 60_000); // first fire one interval out
    expect(loop.last_fire_ms).toBeNull(); // has not fired yet
  });

  it("an explicit future anchor schedules the first fire AT the anchor", () => {
    const future = Date.now() + 10 * 60_000;
    const loop = createLoop({
      kind: "generic",
      label: "future",
      owner_callsign: "a",
      interval_ms: 60_000,
      anchor_ms: future,
    });
    expect(loop.anchor_ms).toBe(future);
    expect(loop.next_fire_ms).toBe(future); // before the anchor, first fire is the anchor itself
  });

  it("rejects a non-positive interval_ms", () => {
    expect(() => createLoop({ kind: "generic", label: "bad", owner_callsign: "a", interval_ms: 0 })).toThrow(
      /positive/,
    );
  });
});

describe("tickLoop — recurring re-arm is drift-free and on the wall-clock grid", () => {
  it("records the fire and re-arms next_fire on the grid, strictly within one interval", () => {
    const loop = createLoop({
      kind: "generic",
      label: "tickrec",
      owner_callsign: "a",
      interval_ms: I,
      anchor_ms: PAST_ANCHOR,
    });
    const r = tickLoop(loop.id, {});
    expect(r.continue).toBe(true);
    expect(typeof r.last_fire_ms).toBe("number");
    // re-armed STRICTLY into the future, exactly on the anchor+N*interval grid,
    // and no more than one interval ahead of the actual fire (no drift creep).
    expect(r.next_fire_ms).toBeGreaterThan(r.last_fire_ms as number);
    expect(((r.next_fire_ms as number) - PAST_ANCHOR) % I).toBe(0);
    expect((r.next_fire_ms as number) - (r.last_fire_ms as number)).toBeLessThanOrEqual(I);
    // self-consistent with the pure helpers
    expect(r.next_fire_ms).toBe(computeNextFire(PAST_ANCHOR, I, r.last_fire_ms as number));
    expect(r.drift_ms).toBe(fireDrift(PAST_ANCHOR, I, r.last_fire_ms as number));
    // persisted
    const after = getLoop(loop.id)!;
    expect(after.last_fire_ms).toBe(r.last_fire_ms);
    expect(after.next_fire_ms).toBe(r.next_fire_ms);
  });

  it("a non-recurring tick result stays byte-identical to Phase 1 (no schedule fields)", () => {
    const loop = createLoop({ kind: "generic", label: "plain-tick", owner_callsign: "a" });
    expect(tickLoop(loop.id, {})).toEqual({ continue: true }); // exact match — no extra keys
    const after = getLoop(loop.id)!;
    expect(after.last_fire_ms).toBeNull();
    expect(after.next_fire_ms).toBeNull();
  });

  it("a recurring loop that trips a stop-condition records the last fire and clears next_fire", () => {
    const loop = createLoop({
      kind: "generic",
      label: "rec-stop",
      owner_callsign: "a",
      interval_ms: I,
      anchor_ms: PAST_ANCHOR,
      config: { max_iterations: 1 },
    });
    const r = tickLoop(loop.id, {}); // iter 1 -> trips max_iterations
    expect(r.continue).toBe(false);
    expect(r.stop_reason).toBe("max_iterations");
    expect(typeof r.last_fire_ms).toBe("number"); // the fire still happened
    expect(r.next_fire_ms).toBeUndefined(); // ...but there is no future fire
    const after = getLoop(loop.id)!;
    expect(after.status).toBe("stopped");
    expect(after.last_fire_ms).toBe(r.last_fire_ms);
    expect(after.next_fire_ms).toBeNull();
  });
});

describe("loop API — recurring create + tick + public /loops read", () => {
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

  it("POST /loop-create with interval_ms persists the schedule and rejects a bad interval (400)", async () => {
    const res = await post(
      "/loop-create",
      { kind: "generic", label: "api-rec", interval_ms: 30_000 },
      aliceToken,
    );
    expect(res.status).toBe(200);
    const { loop } = (await res.json()) as {
      loop: { id: string; interval_ms: number; anchor_ms: number; next_fire_ms: number; last_fire_ms: number | null };
    };
    expect(loop.interval_ms).toBe(30_000);
    expect(loop.anchor_ms).toBe(loop.next_fire_ms - 30_000);
    expect(loop.last_fire_ms).toBeNull();

    const bad = await post("/loop-create", { kind: "generic", label: "bad", interval_ms: -5 }, aliceToken);
    expect(bad.status).toBe(400);
  });

  it("POST /loop-tick on a recurring loop returns next_fire/last_fire/drift", async () => {
    const created = await post(
      "/loop-create",
      { kind: "generic", label: "api-tick", interval_ms: I, anchor_ms: PAST_ANCHOR },
      aliceToken,
    );
    const { loop } = (await created.json()) as { loop: { id: string } };
    const tick = await post("/loop-tick", { id: loop.id }, aliceToken);
    const r = (await tick.json()) as { continue: boolean; next_fire_ms: number; last_fire_ms: number; drift_ms: number };
    expect(r.continue).toBe(true);
    expect(r.next_fire_ms).toBe(computeNextFire(PAST_ANCHOR, I, r.last_fire_ms));
    expect(typeof r.drift_ms).toBe("number");
  });

  it("GET /loops is public (no auth) and shows scheduled-vs-actual + drift per loop", async () => {
    // a recurring loop with a real tick (so it has an actual fire to compare)
    const created = await post(
      "/loop-create",
      { kind: "generic", label: "loops-view", interval_ms: I, anchor_ms: PAST_ANCHOR },
      aliceToken,
    );
    const { loop } = (await created.json()) as { loop: { id: string } };
    await post("/loop-tick", { id: loop.id }, aliceToken);
    // a plain loop to confirm the non-recurring projection
    const plain = await post("/loop-create", { kind: "generic", label: "loops-plain" }, aliceToken);
    const { loop: plainLoop } = (await plain.json()) as { loop: { id: string } };

    const res = await fetch(`${ctx.baseUrl}/loops`); // NO Authorization header
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      now: number;
      loops: Array<{
        id: string;
        recurring: boolean;
        interval_ms: number | null;
        last_fire_ms: number | null;
        next_fire_ms: number | null;
        last_drift_ms: number | null;
      }>;
    };
    expect(typeof body.now).toBe("number");

    const rec = body.loops.find((l) => l.id === loop.id)!;
    expect(rec.recurring).toBe(true);
    expect(rec.interval_ms).toBe(I);
    expect(typeof rec.last_fire_ms).toBe("number"); // it fired once
    expect(typeof rec.next_fire_ms).toBe("number");
    expect(typeof rec.last_drift_ms).toBe("number");

    const pl = body.loops.find((l) => l.id === plainLoop.id)!;
    expect(pl.recurring).toBe(false);
    expect(pl.interval_ms).toBeNull();
    expect(pl.next_fire_ms).toBeNull();
    expect(pl.last_drift_ms).toBeNull();
  });
});
