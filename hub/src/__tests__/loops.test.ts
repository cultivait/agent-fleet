import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPendingApprovalForLoop } from "../loops/approvals.js";
import {
  createLoop,
  evaluateStopConditions,
  getLoop,
  type LoopConfig,
  type LoopState,
  listLoops,
  openApproval,
  pauseLoop,
  resumeLoop,
  stopLoop,
  tickLoop,
  type Verdict,
} from "../loops/store.js";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

const ESCALATE: Verdict = {
  status: "incomplete",
  completeness: 0.1,
  missing: ["a working fix"],
  contradictions: [],
  recommendation: "escalate",
  rationale: "needs a human call",
};

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function state(partial: Partial<LoopState> = {}): LoopState {
  return {
    iterations: 0,
    tokens: 0,
    improvements: [],
    signatures: [],
    last_completeness: null,
    last_confidence: null,
    scores: [],
    last_verdict: null,
    ...partial,
  };
}

const T0 = 1_000_000;

describe("evaluateStopConditions (pure) — each condition fires", () => {
  it("max_iterations fires when iterations >= cap", () => {
    const cfg: LoopConfig = { max_iterations: 3 };
    expect(evaluateStopConditions(cfg, state({ iterations: 2 }), T0, T0)).toBeNull();
    expect(evaluateStopConditions(cfg, state({ iterations: 3 }), T0, T0)).toBe("max_iterations");
  });

  it("token_budget fires when tokens >= budget", () => {
    const cfg: LoopConfig = { token_budget: 1000 };
    expect(evaluateStopConditions(cfg, state({ tokens: 999 }), T0, T0)).toBeNull();
    expect(evaluateStopConditions(cfg, state({ tokens: 1000 }), T0, T0)).toBe("token_budget");
  });

  it("wall_clock_timeout fires when now - createdAt >= timeout", () => {
    const cfg: LoopConfig = { wall_clock_timeout_ms: 5000 };
    expect(evaluateStopConditions(cfg, state(), T0 + 4999, T0)).toBeNull();
    expect(evaluateStopConditions(cfg, state(), T0 + 5000, T0)).toBe("wall_clock_timeout");
  });

  it("completeness fires when reported completeness >= threshold", () => {
    const cfg: LoopConfig = { completeness_threshold: 0.8 };
    expect(evaluateStopConditions(cfg, state({ last_completeness: 0.79 }), T0, T0)).toBeNull();
    expect(evaluateStopConditions(cfg, state({ last_completeness: 0.8 }), T0, T0)).toBe("completeness");
    // null completeness never trips
    expect(evaluateStopConditions(cfg, state({ last_completeness: null }), T0, T0)).toBeNull();
  });

  it("confidence fires when reported confidence >= threshold", () => {
    const cfg: LoopConfig = { confidence_threshold: 0.75 };
    expect(evaluateStopConditions(cfg, state({ last_confidence: 0.74 }), T0, T0)).toBeNull();
    expect(evaluateStopConditions(cfg, state({ last_confidence: 0.9 }), T0, T0)).toBe("confidence");
  });

  it("repetition fires when the last `window` signatures are all identical", () => {
    const cfg: LoopConfig = { repetition: { window: 3 } };
    // mixed tail → no trip
    expect(evaluateStopConditions(cfg, state({ signatures: ["a", "b", "a", "b"] }), T0, T0)).toBeNull();
    // 3 identical in a row → trip
    expect(evaluateStopConditions(cfg, state({ signatures: ["x", "a", "a", "a"] }), T0, T0)).toBe("repetition");
    // not enough samples yet → no trip
    expect(evaluateStopConditions(cfg, state({ signatures: ["a", "a"] }), T0, T0)).toBeNull();
  });

  it("diminishing_returns fires when the last `window` improvements are all below min", () => {
    const cfg: LoopConfig = { diminishing_returns: { window: 3, min_improvement: 0.05 } };
    // last 3 not all below → no trip
    expect(evaluateStopConditions(cfg, state({ improvements: [0.01, 0.2, 0.01, 0.01] }), T0, T0)).toBeNull();
    // last 3 all below → trip
    expect(evaluateStopConditions(cfg, state({ improvements: [0.2, 0.04, 0.01, 0.0] }), T0, T0)).toBe(
      "diminishing_returns",
    );
    // not enough samples → no trip
    expect(evaluateStopConditions(cfg, state({ improvements: [0.0, 0.0] }), T0, T0)).toBeNull();
  });

  it("returns null when no condition is configured or tripped", () => {
    expect(evaluateStopConditions({}, state({ iterations: 99, tokens: 1e9 }), T0, T0)).toBeNull();
  });
});

describe("evaluateStopConditions — OR semantics, first-trip-wins priority", () => {
  it("max_iterations outranks token_budget when both exceeded", () => {
    const cfg: LoopConfig = { max_iterations: 3, token_budget: 1000 };
    const reason = evaluateStopConditions(cfg, state({ iterations: 5, tokens: 5000 }), T0, T0);
    expect(reason).toBe("max_iterations");
  });

  it("token_budget outranks wall_clock_timeout when iterations are fine", () => {
    const cfg: LoopConfig = { token_budget: 1000, wall_clock_timeout_ms: 1 };
    const reason = evaluateStopConditions(cfg, state({ tokens: 5000 }), T0 + 10_000, T0);
    expect(reason).toBe("token_budget");
  });

  it("any single condition trips independently (OR, not AND)", () => {
    const cfg: LoopConfig = { max_iterations: 3, token_budget: 1000, wall_clock_timeout_ms: 5000 };
    // only the timeout is exceeded
    expect(evaluateStopConditions(cfg, state({ iterations: 1, tokens: 1 }), T0 + 6000, T0)).toBe("wall_clock_timeout");
  });
});

describe("loop store — create / get / list", () => {
  it("createLoop returns a running loop with a loop_ id and persists owner_sid", () => {
    const loop = createLoop({
      kind: "generic",
      label: "test loop",
      owner_callsign: "linux-247e5e",
      owner_sid: "sid-123",
      config: { max_iterations: 5 },
    });
    expect(loop.id).toMatch(/^loop_[0-9a-f]{10}$/);
    expect(loop.status).toBe("running");
    expect(loop.owner_sid).toBe("sid-123");
    expect(loop.config.max_iterations).toBe(5);
    expect(loop.state.iterations).toBe(0);

    const fetched = getLoop(loop.id);
    expect(fetched?.id).toBe(loop.id);
    expect(listLoops({ owner_callsign: "linux-247e5e" }).some((l) => l.id === loop.id)).toBe(true);
  });
});

describe("tickLoop — accumulation, stop, post-stop", () => {
  it("accumulates iterations and tokens across ticks", () => {
    const loop = createLoop({ kind: "generic", label: "acc", owner_callsign: "a" });
    expect(tickLoop(loop.id, { iteration_delta: 1, tokens_delta: 100 })).toEqual({ continue: true });
    tickLoop(loop.id, { tokens_delta: 50 }); // iteration_delta defaults to 1
    const after = getLoop(loop.id);
    expect(after?.state.iterations).toBe(2);
    expect(after?.state.tokens).toBe(150);
  });

  it("stops at max_iterations and reports stop_reason; subsequent ticks stay stopped", () => {
    const loop = createLoop({
      kind: "generic",
      label: "cap",
      owner_callsign: "a",
      config: { max_iterations: 2 },
    });
    expect(tickLoop(loop.id, {})).toEqual({ continue: true }); // iter 1
    expect(tickLoop(loop.id, {})).toEqual({ continue: false, stop_reason: "max_iterations" }); // iter 2 -> trip
    expect(getLoop(loop.id)?.status).toBe("stopped");
    // a further tick does not advance and echoes the stored reason
    expect(tickLoop(loop.id, {})).toEqual({ continue: false, stop_reason: "max_iterations" });
    expect(getLoop(loop.id)?.state.iterations).toBe(2);
  });

  it("stops on token_budget from agent-reported tokens_delta", () => {
    const loop = createLoop({
      kind: "generic",
      label: "budget",
      owner_callsign: "a",
      config: { token_budget: 1000 },
    });
    expect(tickLoop(loop.id, { tokens_delta: 600 })).toEqual({ continue: true });
    expect(tickLoop(loop.id, { tokens_delta: 600 })).toEqual({
      continue: false,
      stop_reason: "token_budget",
    });
  });

  it("detects repetition from repeated signatures via ticks", () => {
    const loop = createLoop({
      kind: "generic",
      label: "rep",
      owner_callsign: "a",
      config: { repetition: { window: 3 } },
    });
    expect(tickLoop(loop.id, { signature: "h1" })).toEqual({ continue: true });
    expect(tickLoop(loop.id, { signature: "h1" })).toEqual({ continue: true });
    expect(tickLoop(loop.id, { signature: "h1" })).toEqual({
      continue: false,
      stop_reason: "repetition",
    });
  });

  it("detects diminishing returns from low improvement deltas via ticks", () => {
    const loop = createLoop({
      kind: "generic",
      label: "dim",
      owner_callsign: "a",
      config: { diminishing_returns: { window: 2, min_improvement: 0.05 } },
    });
    expect(tickLoop(loop.id, { improvement: 0.5 })).toEqual({ continue: true });
    expect(tickLoop(loop.id, { improvement: 0.01 })).toEqual({ continue: true });
    expect(tickLoop(loop.id, { improvement: 0.0 })).toEqual({
      continue: false,
      stop_reason: "diminishing_returns",
    });
  });

  it("throws for an unknown loop id", () => {
    expect(() => tickLoop("loop_doesnotexist", {})).toThrow(/not found/);
  });
});

describe("tickLoop — concurrent-tick atomicity (no lost updates)", () => {
  it("accumulates exactly N iterations and the full token sum across many ticks", () => {
    const N = 100;
    const loop = createLoop({ kind: "generic", label: "atomic", owner_callsign: "a" });
    for (let i = 0; i < N; i++) tickLoop(loop.id, { iteration_delta: 1, tokens_delta: 10 });
    const after = getLoop(loop.id);
    expect(after?.state.iterations).toBe(N);
    expect(after?.state.tokens).toBe(N * 10);
    expect(after?.status).toBe("running"); // no stop condition set
  });
});

describe("lifecycle — pause / resume / stop", () => {
  it("pause holds the loop: tick returns paused and does not advance", () => {
    const loop = createLoop({ kind: "generic", label: "pause", owner_callsign: "a" });
    tickLoop(loop.id, {}); // iter 1
    expect(pauseLoop(loop.id)?.status).toBe("paused");
    expect(tickLoop(loop.id, { iteration_delta: 5 })).toEqual({
      continue: false,
      stop_reason: "paused",
    });
    expect(getLoop(loop.id)?.state.iterations).toBe(1); // unchanged while paused
  });

  it("resume returns the loop to running and ticking advances again", () => {
    const loop = createLoop({ kind: "generic", label: "resume", owner_callsign: "a" });
    pauseLoop(loop.id);
    expect(resumeLoop(loop.id)?.status).toBe("running");
    expect(tickLoop(loop.id, {})).toEqual({ continue: true });
    expect(getLoop(loop.id)?.state.iterations).toBe(1);
  });

  it("stop terminates with external_terminate by default and is sticky", () => {
    const loop = createLoop({ kind: "generic", label: "stop", owner_callsign: "a" });
    const stopped = stopLoop(loop.id);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.stop_reason).toBe("external_terminate");
    expect(tickLoop(loop.id, {})).toEqual({ continue: false, stop_reason: "external_terminate" });
  });
});

// The integration seam the evaluator-optimizer engine will call directly (#4). Tested
// here in isolation from the /loop-tick caller, which is dropped at merge.
describe("openApproval — HITL escalate → pause → open queue item (direct)", () => {
  it("pauses a running loop as 'escalated' and returns an appr_ id", () => {
    const loop = createLoop({ kind: "evaluator-optimizer", label: "esc", owner_callsign: "a" });
    const approvalId = openApproval(loop.id, ESCALATE);
    expect(approvalId).toMatch(/^appr_/);
    const after = getLoop(loop.id);
    expect(after?.status).toBe("paused");
    expect(after?.stop_reason).toBe("escalated");

    const pending = getPendingApprovalForLoop(loop.id);
    expect(pending?.id).toBe(approvalId);
    expect(pending?.status).toBe("pending");
    expect(pending?.reason).toBe("needs a human call"); // derived from verdict.rationale
    expect(pending?.verdict?.recommendation).toBe("escalate");
  });

  it("is idempotent: a second call returns the same id and opens no duplicate", () => {
    const loop = createLoop({ kind: "evaluator-optimizer", label: "esc2", owner_callsign: "a" });
    const first = openApproval(loop.id, ESCALATE);
    const second = openApproval(loop.id, ESCALATE);
    expect(second).toBe(first);
    expect(getLoop(loop.id)?.status).toBe("paused");
  });

  it("throws for an unknown loop id", () => {
    expect(() => openApproval("loop_nope", ESCALATE)).toThrow(/not found/);
  });
});
