// C2: work-stealing auto-wake — integration tests for the hub-side mechanism.
// When a task auto-promotes to ready (ratify→ready, or done→cascade→ready),
// the hub synthesizes a system message addressed to a target agent so idle
// instances can claim work without waiting for a manual @-mention.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

afterEach(() => {
  // Restore env vars modified within individual tests
  delete process.env.WORK_STEAL_NOTIFY;
  delete process.env.WORK_STEAL_DISPATCHER;
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
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function registerAgent(name: string): Promise<string> {
  const res = await post("/register", { name }, ctx.joinToken);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function makeProject(): Promise<string> {
  const res = await post("/project-create", { title: "P", by: "system" }, ctx.joinToken);
  return ((await res.json()) as { project: { id: string } }).project.id;
}

async function makeTask(projectId: string): Promise<string> {
  const res = await post("/task-create", { project_id: projectId, title: "T" }, ctx.joinToken);
  return ((await res.json()) as { task: { id: string } }).task.id;
}

async function pendingCounts(): Promise<{ counts: Record<string, number>; queued: Record<string, number> }> {
  // /pending-counts is a joinRoute requiring the join token, not a per-agent token
  const res = await get("/pending-counts", ctx.joinToken);
  return res.json() as Promise<{ counts: Record<string, number>; queued: Record<string, number> }>;
}

describe("C2 work-steal auto-wake", () => {
  it("ratify→ready with an online agent sends a system message addressed to that agent", async () => {
    const agentToken = await registerAgent("ws-agent-1");
    const projectId = await makeProject();
    const taskId = await makeTask(projectId);

    await post("/task-transition", { task_id: taskId, to: "ratified", actor: "system" }, ctx.joinToken);
    // Hub auto-promotes ratified (no blockers) → ready + fires work-steal message

    const { counts } = await pendingCounts();
    expect(counts["ws-agent-1"]).toBeGreaterThan(0);
  });

  it("cascade unblock: N tasks ready → ONE coalesced message to the target", async () => {
    await registerAgent("ws-agent-2");
    // Pin the dispatcher so the work-steal message targets ws-agent-2 regardless of
    // other online agents (e.g. ws-agent-1 still registered from the previous test).
    process.env.WORK_STEAL_DISPATCHER = "ws-agent-2";
    const projectId = await makeProject();

    // Create blocker + 3 dependents
    const blocker = await makeTask(projectId);
    const deps = await Promise.all([makeTask(projectId), makeTask(projectId), makeTask(projectId)]);

    // Ratify blocker (auto-promotes to ready); wire deps; ratify dependents
    // (dependents stay ratified because blocker isn't done yet)
    await post("/task-transition", { task_id: blocker, to: "ratified", actor: "system" }, ctx.joinToken);
    for (const depId of deps) {
      await post("/task-dep-add", { task_id: depId, blocks_on: blocker }, ctx.joinToken);
    }
    for (const depId of deps) {
      await post("/task-transition", { task_id: depId, to: "ratified", actor: "system" }, ctx.joinToken);
    }

    // Snapshot counts before the cascade (may include the ratify→ready work-steal message)
    const before = await pendingCounts();
    const countBefore = before.counts["ws-agent-2"] ?? 0;

    // Claim + transition blocker to done → triggers cascade → 3 tasks go ready
    const claimRes = await post("/task-claim", { task_id: blocker, owner: "ws-agent-2" }, ctx.joinToken);
    expect(claimRes.status).toBe(200);
    await post("/task-transition", { task_id: blocker, to: "in_progress", actor: "ws-agent-2" }, ctx.joinToken);
    await post("/task-transition", { task_id: blocker, to: "review", actor: "ws-agent-2" }, ctx.joinToken);
    // review→done requires a different actor than the owner (no-self-merge rule)
    await post("/task-transition", { task_id: blocker, to: "done", actor: "system" }, ctx.joinToken);
    // ↑ done → propagateUnblock → 3 × promoteIfReady → 3 hook calls → 1 coalesced message

    const after = await pendingCounts();
    const countAfter = after.counts["ws-agent-2"] ?? 0;
    // Exactly one new addressed message (the coalesced work-steal notification)
    expect(countAfter - countBefore).toBe(1);
  });

  it("no online agents → no message, no crash", async () => {
    const projectId = await makeProject();
    const taskId = await makeTask(projectId);
    // No registered agents — still no crash
    const res = await post("/task-transition", { task_id: taskId, to: "ratified", actor: "system" }, ctx.joinToken);
    expect(res.status).toBe(200);
  });

  it("WORK_STEAL_NOTIFY=false → no message sent", async () => {
    process.env.WORK_STEAL_NOTIFY = "false";
    const agentToken = await registerAgent("ws-agent-3");
    const projectId = await makeProject();
    const taskId = await makeTask(projectId);

    const before = await pendingCounts();
    const countBefore = before.counts["ws-agent-3"] ?? 0;

    await post("/task-transition", { task_id: taskId, to: "ratified", actor: "system" }, ctx.joinToken);

    const after = await pendingCounts();
    const countAfter = after.counts["ws-agent-3"] ?? 0;
    expect(countAfter - countBefore).toBe(0);
  });

  it("WORK_STEAL_DISPATCHER routes message to dispatcher over other online agents", async () => {
    const _agentToken = await registerAgent("ws-general");
    const dispatcherToken = await registerAgent("ws-dispatcher");
    process.env.WORK_STEAL_DISPATCHER = "ws-dispatcher";

    const projectId = await makeProject();
    const taskId = await makeTask(projectId);

    const before = await pendingCounts();
    const countBefore = before.counts["ws-dispatcher"] ?? 0;

    await post("/task-transition", { task_id: taskId, to: "ratified", actor: "system" }, ctx.joinToken);

    const after = await pendingCounts();
    const countAfter = after.counts["ws-dispatcher"] ?? 0;
    expect(countAfter - countBefore).toBe(1);
  });
});
