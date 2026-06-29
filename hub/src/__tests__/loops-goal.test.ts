import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApproval, getPendingApprovalForLoop, openCriteriaGate } from "../loops/approvals.js";
import {
  applyAcceptanceCriteria,
  bindLoopToReferee,
  createDraftLoop,
  getLoop,
  revertLoopToDraft,
  setLoopProject,
  stopLoop,
  tickLoop,
} from "../loops/store.js";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("loop-goal (item 2) — pre-run state machine", () => {
  it("createDraftLoop starts in draft with the goal + defaults", () => {
    const loop = createDraftLoop({ label: "ship X", goal: "Ship feature X end to end", owner_callsign: "Operator" });
    expect(loop.status).toBe("draft");
    expect(loop.goal).toBe("Ship feature X end to end");
    expect(loop.auto_approve).toBe(false);
    expect(loop.acceptance_criteria).toBeNull();
    expect(loop.project_id).toBeNull();
    expect(loop.owner_callsign).toBe("Operator");
    expect(getLoop(loop.id)?.status).toBe("draft");
  });

  it("a draft loop does not advance on tick (no approved criteria yet)", () => {
    const loop = createDraftLoop({ label: "inert", goal: "do a thing", owner_callsign: "Operator" });
    const r = tickLoop(loop.id, { iteration_delta: 1 });
    expect(r.continue).toBe(false);
    expect(getLoop(loop.id)?.state.iterations).toBe(0);
  });

  it("bind transfers ownership operator→Referee and moves draft→awaiting_approval", () => {
    const loop = createDraftLoop({ label: "bindme", goal: "g", owner_callsign: "Operator" });
    const bound = bindLoopToReferee(loop.id, "REFEREE", "sid-ref");
    expect(bound.owner_callsign).toBe("REFEREE");
    expect(bound.owner_sid).toBe("sid-ref");
    expect(bound.status).toBe("awaiting_approval");
  });

  it("bind throws unless the loop is a draft", () => {
    const loop = createDraftLoop({ label: "x", goal: "g", owner_callsign: "Operator" });
    bindLoopToReferee(loop.id, "REFEREE");
    expect(() => bindLoopToReferee(loop.id, "REFEREE")).toThrow(/not draft/);
  });

  it("an awaiting_approval loop is held at the gate — tick does not advance", () => {
    const loop = createDraftLoop({ label: "held", goal: "g", owner_callsign: "Operator" });
    bindLoopToReferee(loop.id, "REFEREE");
    const r = tickLoop(loop.id, { iteration_delta: 1 });
    expect(r.continue).toBe(false);
    expect(getLoop(loop.id)?.state.iterations).toBe(0);
  });

  it("applyAcceptanceCriteria populates criteria, mirrors guardrails into config, and runs", () => {
    const loop = createDraftLoop({ label: "approve", goal: "g", owner_callsign: "Operator" });
    bindLoopToReferee(loop.id, "REFEREE");
    const running = applyAcceptanceCriteria(loop.id, {
      rubric: "All acceptance tests pass and docs updated",
      completeness_target: 0.9,
      plateau: { window: 3, epsilon: 0.01 },
    });
    expect(running.status).toBe("running");
    expect(running.acceptance_criteria?.rubric).toContain("acceptance tests");
    // numeric guardrails mirrored into the existing verdict engine's config
    expect(running.config.evaluator_optimizer?.completeness_target).toBe(0.9);
    expect(running.config.evaluator_optimizer?.plateau).toEqual({ window: 3, epsilon: 0.01 });
  });

  it("applyAcceptanceCriteria throws unless awaiting_approval", () => {
    const loop = createDraftLoop({ label: "early", goal: "g", owner_callsign: "Operator" });
    expect(() => applyAcceptanceCriteria(loop.id, { rubric: "r" })).toThrow(/not awaiting_approval/);
  });

  it("revertLoopToDraft sends awaiting_approval back to draft (reject-and-regenerate)", () => {
    const loop = createDraftLoop({ label: "regen", goal: "g", owner_callsign: "Operator" });
    bindLoopToReferee(loop.id, "REFEREE");
    const reverted = revertLoopToDraft(loop.id);
    expect(reverted.status).toBe("draft");
    expect(() => revertLoopToDraft(loop.id)).toThrow(/not awaiting_approval/);
  });

  it("auto_approve persists on the loop record (travels with the loop)", () => {
    const loop = createDraftLoop({ label: "auto", goal: "g", owner_callsign: "Operator", auto_approve: true });
    expect(loop.auto_approve).toBe(true);
    expect(getLoop(loop.id)?.auto_approve).toBe(true);
  });

  it("setLoopProject links the loop to its delegated Plan (append-wave)", () => {
    const loop = createDraftLoop({ label: "plan", goal: "g", owner_callsign: "Operator" });
    const linked = setLoopProject(loop.id, "proj_abc123");
    expect(linked.project_id).toBe("proj_abc123");
  });

  it("setLoopProject rejects a terminal (stopped) loop — no link onto a dead loop", () => {
    const loop = createDraftLoop({ label: "term", goal: "g", owner_callsign: "Operator" });
    stopLoop(loop.id, "external_terminate");
    expect(() => setLoopProject(loop.id, "proj_x")).toThrow(/stopped/);
  });
});

describe("loop-goal (item 2) — criteria-gate approvals", () => {
  it("openCriteriaGate opens a pending criteria_gate carrying the proposed criteria", () => {
    const loop = createDraftLoop({ label: "gate", goal: "g", owner_callsign: "Operator" });
    bindLoopToReferee(loop.id, "REFEREE");
    const appr = openCriteriaGate(loop.id, { rubric: "tests pass", completeness_target: 0.85 });
    expect(appr.kind).toBe("criteria_gate");
    expect(appr.status).toBe("pending");
    expect(appr.criteria?.rubric).toBe("tests pass");
    expect(appr.criteria?.completeness_target).toBe(0.85);
    // attached to the loop as its single pending gate
    expect(getPendingApprovalForLoop(loop.id)?.kind).toBe("criteria_gate");
  });

  it("a plain createApproval defaults to the escalation_gate kind with no criteria", () => {
    const loop = createDraftLoop({ label: "esc", goal: "g", owner_callsign: "Operator" });
    const appr = createApproval({ loop_id: loop.id, reason: "verifier said escalate" });
    expect(appr.kind).toBe("escalation_gate");
    expect(appr.criteria).toBeNull();
  });
});
