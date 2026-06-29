import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function adminPost(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ctx.adminToken}` },
    body: JSON.stringify(body),
  });
}
function tokPost(path: string, body: unknown, token: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
async function adminGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ctx.baseUrl}${path}`, { headers: { Authorization: `Bearer ${ctx.adminToken}` } });
  return (await res.json()) as T;
}
// A principal (referee) member — /loop-bind is principal-gated, so a plain member can't bind.
async function registerPrincipal(name: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/admin-register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
    body: JSON.stringify({ name, principal: true }),
  });
  return ((await res.json()) as { token: string }).token;
}

interface Loop {
  id: string;
  status: string;
  goal: string | null;
  acceptance_criteria: { rubric: string; completeness_target?: number } | null;
}
interface Approval {
  id: string;
  loop_id: string;
  kind: string;
  status: string;
}

describe("loop-goal (item 2) — operator-create → bind → criteria gate → run", () => {
  it("operator creates a draft loop with a one-sentence goal (admin-gated)", async () => {
    const res = await adminPost("/loop-admin-create-draft", { goal: "Ship the onboarding flow" });
    expect(res.status).toBe(200);
    const { loop } = (await res.json()) as { loop: Loop };
    expect(loop.status).toBe("draft");
    expect(loop.goal).toBe("Ship the onboarding flow");
  });

  it("rejects operator-create with the join token (401)", async () => {
    const res = await adminPost("/loop-admin-create-draft", { goal: "nope" }, ctx.joinToken);
    expect(res.status).toBe(401);
  });

  it("binding a Referee → awaiting_approval + opens a pending criteria gate", async () => {
    const created = (await (await adminPost("/loop-admin-create-draft", { goal: "Improve search" })).json()) as {
      loop: Loop;
    };
    const ref = await registerPrincipal("ref-bind");
    const bindRes = await tokPost(
      "/loop-bind",
      { id: created.loop.id, criteria: { rubric: "search p95 < 200ms", completeness_target: 0.9 } },
      ref,
    );
    expect(bindRes.status).toBe(200);
    const { loop } = (await bindRes.json()) as { loop: Loop };
    expect(loop.status).toBe("awaiting_approval");

    const { approvals } = await adminGet<{ approvals: Approval[] }>(`/loop-approvals?loop_id=${created.loop.id}`);
    const gate = approvals.find((a) => a.loop_id === created.loop.id);
    expect(gate?.kind).toBe("criteria_gate");
    expect(gate?.status).toBe("pending");
  });

  it("approving the criteria gate populates acceptance_criteria and runs the loop", async () => {
    const created = (await (await adminPost("/loop-admin-create-draft", { goal: "Cut build time" })).json()) as {
      loop: Loop;
    };
    const ref = await registerPrincipal("ref-approve");
    await tokPost(
      "/loop-bind",
      { id: created.loop.id, criteria: { rubric: "build < 60s", completeness_target: 0.8 } },
      ref,
    );
    const { approvals } = await adminGet<{ approvals: Approval[] }>(`/loop-approvals?loop_id=${created.loop.id}`);
    const gateId = approvals[0].id;

    const res = await adminPost("/loop-approval-resolve", { id: gateId, decision: "approve" });
    expect(res.status).toBe(200);
    const { loop } = (await res.json()) as { loop: Loop };
    expect(loop.status).toBe("running");
    expect(loop.acceptance_criteria?.rubric).toBe("build < 60s");
  });

  it("edit-then-approve persists the operator's edited criteria", async () => {
    const created = (await (await adminPost("/loop-admin-create-draft", { goal: "Edit me" })).json()) as { loop: Loop };
    const ref = await registerPrincipal("ref-edit");
    await tokPost("/loop-bind", { id: created.loop.id, criteria: { rubric: "original" } }, ref);
    const { approvals } = await adminGet<{ approvals: Approval[] }>(`/loop-approvals?loop_id=${created.loop.id}`);
    const res = await adminPost("/loop-approval-resolve", {
      id: approvals[0].id,
      decision: "approve",
      criteria: { rubric: "edited by operator", completeness_target: 0.95 },
    });
    const { loop } = (await res.json()) as { loop: Loop };
    expect(loop.status).toBe("running");
    expect(loop.acceptance_criteria?.rubric).toBe("edited by operator");
    expect(loop.acceptance_criteria?.completeness_target).toBe(0.95);
  });

  it("reject-and-regenerate sends the loop back to draft", async () => {
    const created = (await (await adminPost("/loop-admin-create-draft", { goal: "Reject me" })).json()) as {
      loop: Loop;
    };
    const ref = await registerPrincipal("ref-reject");
    await tokPost("/loop-bind", { id: created.loop.id, criteria: { rubric: "r" } }, ref);
    const { approvals } = await adminGet<{ approvals: Approval[] }>(`/loop-approvals?loop_id=${created.loop.id}`);
    const res = await adminPost("/loop-approval-resolve", { id: approvals[0].id, decision: "reject" });
    const { loop } = (await res.json()) as { loop: Loop };
    expect(loop.status).toBe("draft");
  });

  it("auto_approve skips the gate — bind goes straight to running", async () => {
    const created = (await (
      await adminPost("/loop-admin-create-draft", { goal: "Trusted run", auto_approve: true })
    ).json()) as { loop: Loop };
    const ref = await registerPrincipal("ref-auto");
    const bindRes = await tokPost(
      "/loop-bind",
      { id: created.loop.id, criteria: { rubric: "auto", completeness_target: 0.9 } },
      ref,
    );
    const { loop } = (await bindRes.json()) as { loop: Loop };
    expect(loop.status).toBe("running");
    expect(loop.acceptance_criteria?.rubric).toBe("auto");
    // no pending gate was opened
    const { approvals } = await adminGet<{ approvals: Approval[] }>(
      `/loop-approvals?loop_id=${created.loop.id}&status=pending`,
    );
    expect(approvals.length).toBe(0);
  });

  it("operator can admin-stop a draft loop at any point", async () => {
    const created = (await (await adminPost("/loop-admin-create-draft", { goal: "Stop me" })).json()) as { loop: Loop };
    const res = await adminPost("/loop-admin-stop", { id: created.loop.id });
    expect(res.status).toBe(200);
    const { loop } = (await res.json()) as { loop: Loop };
    expect(loop.status).toBe("stopped");
  });

  it("rejects /loop-bind from a non-principal member (403) — bind is principal-gated", async () => {
    const created = (await (await adminPost("/loop-admin-create-draft", { goal: "Guarded bind" })).json()) as {
      loop: Loop;
    };
    const member = await registerUser(ctx, "plain-binder");
    const res = await tokPost("/loop-bind", { id: created.loop.id, criteria: { rubric: "x" } }, member);
    expect(res.status).toBe(403);
    // loop untouched — still a draft (a plain member could not transfer ownership)
    const { approvals } = await adminGet<{ approvals: Approval[] }>(
      `/loop-approvals?loop_id=${created.loop.id}&status=pending`,
    );
    expect(approvals.length).toBe(0);
  });

  it("rejects edit-then-approve with an empty rubric (400)", async () => {
    const created = (await (await adminPost("/loop-admin-create-draft", { goal: "Empty rubric guard" })).json()) as {
      loop: Loop;
    };
    const ref = await registerPrincipal("ref-empty");
    await tokPost("/loop-bind", { id: created.loop.id, criteria: { rubric: "ok" } }, ref);
    const { approvals } = await adminGet<{ approvals: Approval[] }>(`/loop-approvals?loop_id=${created.loop.id}`);
    const res = await adminPost("/loop-approval-resolve", {
      id: approvals[0].id,
      decision: "approve",
      criteria: { rubric: "   " },
    });
    expect(res.status).toBe(400);
  });
});
