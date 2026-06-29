// D4: owner_sid liveness binding on /plan-heartbeat (anti-zombie gate).
//
// /plan-heartbeat now cross-references the board registry: if a board entry is bound
// to the posted owner_sid AND the bound agent is no longer registered (unregistered /
// dead), the renewal is silently skipped so reclaim can reap the task normally.
// Sids with NO board entry are allowed through unchanged (backward compat / fail-open).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTask, setLeaseExpiry } from "../plan/store.js";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function post(path: string, body: unknown, token: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function newProject(): Promise<string> {
  const res = await post("/project-create", { title: "D4-P", by: "system" }, ctx.joinToken);
  return ((await res.json()) as { project: { id: string } }).project.id;
}

async function readyTask(projectId: string, title: string): Promise<string> {
  const res = await post("/task-create", { project_id: projectId, title, by: "system" }, ctx.joinToken);
  const id = ((await res.json()) as { task: { id: string } }).task.id;
  await post("/task-transition", { task_id: id, to: "ratified", actor: "system" }, ctx.joinToken);
  return id;
}

async function registerAgent(name: string): Promise<string> {
  const res = await post("/register", { name }, ctx.joinToken);
  return ((await res.json()) as { token: string }).token;
}

async function boardUpdate(name: string, sid: string, token: string): Promise<void> {
  await post("/board-update", { name, sid, status: "active" }, token);
}

async function unregisterAgent(token: string): Promise<void> {
  await fetch(`${ctx.baseUrl}/unregister`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function planHeartbeat(sid: string): Promise<Response> {
  return post("/plan-heartbeat", { owner_sid: sid }, ctx.joinToken);
}

describe("D4 — /plan-heartbeat liveness binding", () => {
  it("zombie sid (board entry exists, agent unregistered) → skip renewal, renewed=0", async () => {
    const projectId = await newProject();
    const taskId = await readyTask(projectId, "D4-zombie-task");

    // Register agent "d4-zombie" and bind their sid to the board.
    const agentToken = await registerAgent("d4-zombie");
    await boardUpdate("d4-zombie", "d4-zombie-sid", ctx.joinToken);

    // Claim the task as the zombie sid.
    await post("/task-claim", { task_id: taskId, owner: "d4-zombie", owner_sid: "d4-zombie-sid" }, ctx.joinToken);
    // Set a near-expiry so we can verify it was NOT renewed.
    const nearExpiry = Date.now() + 2_000;
    setLeaseExpiry(taskId, nearExpiry);

    // Kill the agent — unregister it so the board entry persists but auth registry drops it.
    await unregisterAgent(agentToken);

    // Heartbeat with the zombie's sid — should be blocked.
    const res = await planHeartbeat("d4-zombie-sid");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { renewed: number; skipped?: boolean };
    expect(body.renewed).toBe(0);
    expect(body.skipped).toBe(true);

    // Lease was NOT renewed — still near the original near-expiry.
    const lease = getTask(taskId)?.lease_expires_at as number;
    expect(lease).toBe(nearExpiry);
  });

  it("live sid (board entry exists, agent registered) → renews task lease", async () => {
    const projectId = await newProject();
    const taskId = await readyTask(projectId, "D4-live-task");

    // Register agent "d4-live" and bind their sid.
    await registerAgent("d4-live");
    await boardUpdate("d4-live", "d4-live-sid", ctx.joinToken);

    // Claim task.
    await post("/task-claim", { task_id: taskId, owner: "d4-live", owner_sid: "d4-live-sid" }, ctx.joinToken);
    const nearExpiry = Date.now() + 1_000;
    setLeaseExpiry(taskId, nearExpiry);

    // Heartbeat — agent is still registered, should renew.
    const res = await planHeartbeat("d4-live-sid");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { renewed: number; skipped?: boolean };
    expect(body.renewed).toBe(1);
    expect(body.skipped).toBeUndefined();

    // Lease slid forward.
    const lease = getTask(taskId)?.lease_expires_at as number;
    expect(lease).toBeGreaterThan(nearExpiry + 1_000);
  });

  it("unknown sid (no board entry) → backward-compat allow-through, renewed=0 if no tasks", async () => {
    // "d4-unknown-sid" has never been posted in any board-update.
    const res = await planHeartbeat("d4-unknown-sid");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { renewed: number; skipped?: boolean };
    // No tasks exist for this sid, but the call is NOT skipped.
    expect(body.renewed).toBe(0);
    expect(body.skipped).toBeUndefined();
  });

  it("zombie does NOT prevent reclaim — lease expires after skip", async () => {
    const projectId = await newProject();
    const taskId = await readyTask(projectId, "D4-reclaim-task");

    const agentToken = await registerAgent("d4-reclaim-zombie");
    await boardUpdate("d4-reclaim-zombie", "d4-rcl-sid", ctx.joinToken);
    await post("/task-claim", { task_id: taskId, owner: "d4-reclaim-zombie", owner_sid: "d4-rcl-sid" }, ctx.joinToken);

    await unregisterAgent(agentToken);

    // Force the lease to expire in the past.
    setLeaseExpiry(taskId, Date.now() - 1);

    // Heartbeat is skipped.
    const hbRes = await planHeartbeat("d4-rcl-sid");
    expect(((await hbRes.json()) as { renewed: number }).renewed).toBe(0);

    // Expired + not renewed → task should be reclaimed on the next inflight sweep.
    const inflight = (await (await fetch(`${ctx.baseUrl}/plan-inflight`)).json()) as { tasks: { id: string }[] };
    expect(inflight.tasks.some((t) => t.id === taskId)).toBe(false);
  });
});
