import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPendingApprovalForLoop } from "../loops/approvals.js";
import { createLoop, getLoop, pauseLoop, resumeLoop, submitVerdict, tickLoop } from "../loops/store.js";
import type { Verdict } from "../loops/verdict.js";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;
let aliceToken: string;

beforeAll(async () => {
  ctx = await startTestServer();
  aliceToken = await registerUser(ctx, "verdict-alice");
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function verdict(partial: Partial<Verdict> = {}): Verdict {
  return {
    status: "partial",
    completeness: 0.5,
    missing: [],
    contradictions: [],
    recommendation: "retry",
    ...partial,
  };
}

function evalOptimizerLoop(config = {}) {
  return createLoop({
    kind: "evaluator_optimizer",
    label: "eo",
    owner_callsign: "verdict-alice",
    config,
  });
}

describe("submitVerdict (store) — evaluator-optimizer decisions", () => {
  it("records the completeness trajectory + last_verdict and keeps iterating on 'retry'", () => {
    const loop = evalOptimizerLoop();
    expect(submitVerdict(loop.id, verdict({ completeness: 0.3 }))).toEqual({ continue: true });
    expect(submitVerdict(loop.id, verdict({ completeness: 0.55 }))).toEqual({ continue: true });
    const after = getLoop(loop.id);
    expect(after?.state.scores).toEqual([0.3, 0.55]);
    expect(after?.state.iterations).toBe(2); // each verdict counts as an iteration
    expect(after?.state.last_verdict?.completeness).toBe(0.55);
    expect(after?.state.last_completeness).toBe(0.55); // kept in sync for completeness_threshold
  });

  it("'accept' stops the loop with stop_reason 'accepted'", () => {
    const loop = evalOptimizerLoop();
    expect(submitVerdict(loop.id, verdict({ recommendation: "accept", status: "complete" }))).toEqual({
      continue: false,
      stop_reason: "accepted",
    });
    expect(getLoop(loop.id)?.status).toBe("stopped");
    expect(getLoop(loop.id)?.stop_reason).toBe("accepted");
  });

  it("'escalate' PAUSES (resumable) with 'escalated' and preserves the verdict for Phase-5 HITL", () => {
    const loop = evalOptimizerLoop();
    const res = submitVerdict(loop.id, verdict({ recommendation: "escalate", missing: ["sources"] }));
    // Post-integration: escalate opens a HITL approval atomically (same tick txn) and returns its id.
    expect(res).toEqual({
      continue: false,
      stop_reason: "escalated",
      approval_id: expect.any(String),
    });
    // the approval really was opened, in the same transaction as the pause.
    expect(getPendingApprovalForLoop(loop.id)?.id).toBe((res as { approval_id: string }).approval_id);
    const after = getLoop(loop.id);
    // PAUSED, not stopped — so the HITL approve path can resume it (terminal-stop would strand it).
    expect(after?.status).toBe("paused");
    expect(after?.stop_reason).toBe("escalated");
    // Phase 5 consumes this: the recommendation + gaps survive on the paused loop.
    expect(after?.state.last_verdict?.recommendation).toBe("escalate");
    expect(after?.state.last_verdict?.missing).toEqual(["sources"]);
    // A re-tick on the parked loop keeps reporting WHY it's parked (not a flat "paused").
    expect(tickLoop(loop.id, {})).toEqual({ continue: false, stop_reason: "escalated" });
    // HITL approve = resumeLoop (reuses the existing verb); reject would be stopLoop.
    expect(resumeLoop(loop.id)?.status).toBe("running");
    // Resume clears the stale escalate reason — the running loop is back to a clean slate.
    expect(getLoop(loop.id)?.stop_reason).toBeNull();
    expect(tickLoop(loop.id, { verdict: verdict({ recommendation: "retry" }) })).toEqual({ continue: true });
  });

  it("seam #6 — a RECURRING loop that escalate-pauses stamps last_fire_ms but FREEZES next_fire", () => {
    const loop = createLoop({
      kind: "evaluator_optimizer",
      label: "recurring-eo",
      owner_callsign: "verdict-alice",
      config: {},
      interval_ms: 60_000,
    });
    const frozenNextFire = loop.next_fire_ms;
    expect(frozenNextFire).not.toBeNull(); // recurring → next_fire computed at create
    expect(loop.last_fire_ms).toBeNull(); // no tick yet

    const res = submitVerdict(loop.id, verdict({ recommendation: "escalate" }));
    expect(res.stop_reason).toBe("escalated");
    const after = getLoop(loop.id);
    expect(after?.status).toBe("paused");
    expect(after?.last_fire_ms).not.toBeNull(); // the iteration DID fire → stamped
    expect(after?.next_fire_ms).toBe(frozenNextFire); // FROZEN — paused must not advance the schedule
    // resume → the first advancing tick re-arms next_fire off the grid (still present).
    resumeLoop(loop.id);
    tickLoop(loop.id, {});
    expect(getLoop(loop.id)?.next_fire_ms).not.toBeNull();
  });

  it("a manual pause AFTER an escalate-pause→resume reports 'paused', not the stale 'escalated'", () => {
    const loop = evalOptimizerLoop();
    // escalate → paused+escalated, then approve(resume) clears the reason.
    submitVerdict(loop.id, verdict({ recommendation: "escalate" }));
    resumeLoop(loop.id);
    // a later, unrelated manual pause must NOT inherit the old escalate reason.
    expect(pauseLoop(loop.id)?.status).toBe("paused");
    expect(tickLoop(loop.id, {})).toEqual({ continue: false, stop_reason: "paused" });
  });

  it("completeness_target accepts even when the judge keeps saying 'retry'", () => {
    const loop = evalOptimizerLoop({ evaluator_optimizer: { completeness_target: 0.9 } });
    expect(submitVerdict(loop.id, verdict({ recommendation: "retry", completeness: 0.85 }))).toEqual({
      continue: true,
    });
    expect(submitVerdict(loop.id, verdict({ recommendation: "retry", completeness: 0.92 }))).toEqual({
      continue: false,
      stop_reason: "accepted",
    });
  });

  it("plateau trips when scores stop improving across the window", () => {
    const loop = evalOptimizerLoop({ evaluator_optimizer: { plateau: { window: 3, epsilon: 0.02 } } });
    expect(submitVerdict(loop.id, verdict({ completeness: 0.8 }))).toEqual({ continue: true });
    expect(submitVerdict(loop.id, verdict({ completeness: 0.81 }))).toEqual({ continue: true });
    expect(submitVerdict(loop.id, verdict({ completeness: 0.8 }))).toEqual({
      continue: false,
      stop_reason: "plateau",
    });
  });

  it("max_iterations remains a hard backstop on a stuck retry loop", () => {
    const loop = evalOptimizerLoop({ max_iterations: 2 });
    expect(submitVerdict(loop.id, verdict({ recommendation: "retry" }))).toEqual({ continue: true });
    expect(submitVerdict(loop.id, verdict({ recommendation: "retry" }))).toEqual({
      continue: false,
      stop_reason: "max_iterations",
    });
  });

  it("a judge 'accept' on the final allowed iteration reports 'accepted', not 'max_iterations'", () => {
    const loop = evalOptimizerLoop({ max_iterations: 1 });
    // verdict decision is evaluated before the generic caps, so accept wins.
    expect(submitVerdict(loop.id, verdict({ recommendation: "accept" }))).toEqual({
      continue: false,
      stop_reason: "accepted",
    });
  });

  it("accumulates agent-reported tokens via verdict deltas", () => {
    const loop = evalOptimizerLoop();
    submitVerdict(loop.id, verdict(), { tokens_delta: 120 });
    submitVerdict(loop.id, verdict(), { tokens_delta: 30 });
    expect(getLoop(loop.id)?.state.tokens).toBe(150);
  });

  it("throws on a malformed verdict (so the endpoint can map it to 400)", () => {
    const loop = evalOptimizerLoop();
    expect(() => submitVerdict(loop.id, { status: "nope", completeness: 0.5, recommendation: "retry" })).toThrow(
      /status/,
    );
  });

  it("tickLoop accepts a typed verdict inline (verdict path shares the tick critical section)", () => {
    const loop = evalOptimizerLoop();
    expect(tickLoop(loop.id, { verdict: verdict({ recommendation: "accept" }) })).toEqual({
      continue: false,
      stop_reason: "accepted",
    });
  });
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

async function createEoLoopViaApi(config: unknown = {}): Promise<string> {
  const res = await post("/loop-create", { kind: "evaluator_optimizer", label: "api-eo", config }, aliceToken);
  expect(res.status).toBe(200);
  const { loop } = (await res.json()) as { loop: { id: string } };
  return loop.id;
}

describe("/loop-verdict API — auth, decision, validation", () => {
  it("rejects without a user token (401)", async () => {
    const res = await post("/loop-verdict", { id: "loop_x", verdict: verdict() });
    expect(res.status).toBe(401);
  });

  it("submits a verdict and returns {result, loop} with the score trajectory", async () => {
    const id = await createEoLoopViaApi({ evaluator_optimizer: { completeness_target: 0.9 } });
    const res = await post("/loop-verdict", { id, verdict: verdict({ completeness: 0.4 }) }, aliceToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { continue: boolean; stop_reason?: string };
      loop: { state: { scores: number[]; last_verdict: { completeness: number } } };
    };
    expect(body.result).toEqual({ continue: true });
    expect(body.loop.state.scores).toEqual([0.4]);
    expect(body.loop.state.last_verdict.completeness).toBe(0.4);
  });

  it("an 'accept' verdict stops the loop end-to-end", async () => {
    const id = await createEoLoopViaApi();
    const res = await post("/loop-verdict", { id, verdict: verdict({ recommendation: "accept" }) }, aliceToken);
    const body = (await res.json()) as { result: { continue: boolean; stop_reason?: string } };
    expect(body.result).toEqual({ continue: false, stop_reason: "accepted" });
  });

  it("400 on a missing verdict, 400 on a malformed verdict, 404 on an unknown loop", async () => {
    const id = await createEoLoopViaApi();
    expect((await post("/loop-verdict", { id }, aliceToken)).status).toBe(400);
    expect(
      (
        await post(
          "/loop-verdict",
          { id, verdict: { status: "bad", completeness: 0.5, recommendation: "retry" } },
          aliceToken,
        )
      ).status,
    ).toBe(400);
    expect((await post("/loop-verdict", { id: "loop_missing", verdict: verdict() }, aliceToken)).status).toBe(404);
  });
});
