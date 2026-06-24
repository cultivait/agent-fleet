import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  aliceToken = await registerUser(ctx, "appr-alice");
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

function get(path: string, token?: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

async function createLoop(token: string, config?: unknown): Promise<string> {
  const res = await post("/loop-create", { kind: "evaluator-optimizer", label: "appr", config }, token);
  expect(res.status).toBe(200);
  const { loop } = (await res.json()) as { loop: { id: string } };
  return loop.id;
}

// Locked Verdict shape (Phase 4 / linux-247e5e @9945324). Phase 5 keys only on
// recommendation === "escalate".
const ESCALATE_VERDICT = {
  status: "incomplete",
  completeness: 0.2,
  missing: ["a verified fix"],
  contradictions: [],
  recommendation: "escalate",
  rationale: "stuck — needs human call",
};

describe("loop HITL approval queue — escalate → pause → operator decision", () => {
  it("an escalate verdict pauses the loop and opens a pending approval", async () => {
    const id = await createLoop(aliceToken);
    const tick = await post("/loop-tick", { id, verdict: ESCALATE_VERDICT }, aliceToken);
    expect(tick.status).toBe(200);
    const body = (await tick.json()) as { continue: boolean; stop_reason: string; approval_id: string };
    expect(body.continue).toBe(false);
    expect(body.stop_reason).toBe("escalated");
    expect(body.approval_id).toMatch(/^appr_/);

    // loop is parked as paused, and loop-get surfaces the pending approval
    const got = await post("/loop-get", { id }, aliceToken);
    const { loop, pending_approval } = (await got.json()) as {
      loop: { status: string; stop_reason: string };
      pending_approval: { id: string; status: string; reason: string };
    };
    expect(loop.status).toBe("paused");
    expect(loop.stop_reason).toBe("escalated");
    expect(pending_approval.id).toBe(body.approval_id);
    expect(pending_approval.status).toBe("pending");
    expect(pending_approval.reason).toBe("stuck — needs human call");
  });

  it("is idempotent: re-ticking a parked loop does not fan out duplicate approvals", async () => {
    const id = await createLoop(aliceToken);
    await post("/loop-tick", { id, verdict: ESCALATE_VERDICT }, aliceToken);
    // re-tick (still escalating) — loop already paused, short-circuits
    const again = await post("/loop-tick", { id, verdict: ESCALATE_VERDICT }, aliceToken);
    expect(((await again.json()) as { stop_reason: string }).stop_reason).toBe("escalated");

    const list = await get(`/loop-approvals?status=pending&loop_id=${id}`, ctx.adminToken);
    const { approvals } = (await list.json()) as { approvals: unknown[] };
    expect(approvals).toHaveLength(1);
  });

  it("the approval queue is admin-gated (no auto-approve, no member access)", async () => {
    // a normal member token cannot read the operator queue
    expect((await get("/loop-approvals", aliceToken)).status).toBe(401);
    // nor resolve
    expect((await post("/loop-approval-resolve", { id: "appr_x", decision: "approve" }, aliceToken)).status).toBe(401);
  });

  it("operator approve resumes the loop; the item flips to approved", async () => {
    const id = await createLoop(aliceToken);
    const tick = await post("/loop-tick", { id, verdict: ESCALATE_VERDICT }, aliceToken);
    const { approval_id } = (await tick.json()) as { approval_id: string };

    const res = await post(
      "/loop-approval-resolve",
      { id: approval_id, decision: "approve", by: "Operator", note: "go ahead" },
      ctx.adminToken,
    );
    expect(res.status).toBe(200);
    const { approval, loop } = (await res.json()) as {
      approval: { status: string; decided_by: string; note: string };
      loop: { status: string };
    };
    expect(approval.status).toBe("approved");
    expect(approval.decided_by).toBe("Operator");
    expect(loop.status).toBe("running"); // resumed

    // re-resolving the now-decided item is a conflict
    const again = await post("/loop-approval-resolve", { id: approval_id, decision: "reject" }, ctx.adminToken);
    expect(again.status).toBe(409);
  });

  it("operator reject terminates the loop; the item flips to rejected", async () => {
    const id = await createLoop(aliceToken);
    const tick = await post("/loop-tick", { id, verdict: ESCALATE_VERDICT }, aliceToken);
    const { approval_id } = (await tick.json()) as { approval_id: string };

    const res = await post("/loop-approval-resolve", { id: approval_id, decision: "reject" }, ctx.adminToken);
    expect(res.status).toBe(200);
    const { approval, loop } = (await res.json()) as {
      approval: { status: string };
      loop: { status: string; stop_reason: string };
    };
    expect(approval.status).toBe("rejected");
    expect(loop.status).toBe("stopped");
    expect(loop.stop_reason).toBe("external_terminate");
  });

  it("validates decision and 404s an unknown approval", async () => {
    expect((await post("/loop-approval-resolve", { id: "appr_x", decision: "maybe" }, ctx.adminToken)).status).toBe(400);
    expect((await post("/loop-approval-resolve", { id: "appr_nope", decision: "approve" }, ctx.adminToken)).status).toBe(
      404,
    );
  });
});
