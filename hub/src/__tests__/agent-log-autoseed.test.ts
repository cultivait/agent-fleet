import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// Board auto-digest v1 — auto-seed integration. A task reaching a terminal OUTCOME
// (done/blocked) appends ONE agent_log row, attributed to the task owner, via the
// live /task-transition path. Routine states (claimed/in_progress/review) do NOT
// log — that keeps the last-5 findings-first instead of flip-spam.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => {
  await stopTestServer(ctx);
});

function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function tail(name: string): Promise<Array<{ kind: string; note: string }>> {
  const res = await fetch(`${ctx.baseUrl}/agent-log-tail?name=${encodeURIComponent(name)}&limit=10`);
  return ((await res.json()) as { log: Array<{ kind: string; note: string }> }).log;
}

async function readyTask(title: string): Promise<string> {
  const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
  const projectId = ((await p.json()) as { project: { id: string } }).project.id;
  const t = await post("/task-create", { project_id: projectId, title, by: "alice" }, ctx.joinToken);
  const id = ((await t.json()) as { task: { id: string } }).task.id;
  await post("/task-transition", { task_id: id, to: "ratified", actor: "alice" }, ctx.joinToken); // → ready
  return id;
}

describe("board auto-digest — task→done/blocked auto-seed", () => {
  it("logs a 'done' row on the OWNER's timeline (not the approver's) when review→done", async () => {
    const id = await readyTask("ship the widget");
    await post("/task-claim", { task_id: id, owner: "bob" }, ctx.joinToken);
    await post("/task-transition", { task_id: id, to: "in_progress", actor: "bob" }, ctx.joinToken);
    await post("/task-transition", { task_id: id, to: "review", actor: "bob" }, ctx.joinToken);
    // carol (a DIFFERENT actor) approves — no self-merge.
    const res = await post("/task-transition", { task_id: id, to: "done", actor: "carol" }, ctx.joinToken);
    expect(res.status).toBe(200);

    const bobLog = await tail("bob");
    expect(bobLog.some((r) => r.kind === "done" && r.note.includes("ship the widget"))).toBe(true);
    // The approver carol must NOT get the completion on her timeline.
    const carolLog = await tail("carol");
    expect(carolLog.some((r) => r.note.includes("ship the widget"))).toBe(false);
  });

  it("logs a 'blocker' row when a task transitions to blocked", async () => {
    const id = await readyTask("integrate the API");
    await post("/task-claim", { task_id: id, owner: "dave" }, ctx.joinToken);
    await post("/task-transition", { task_id: id, to: "in_progress", actor: "dave" }, ctx.joinToken);
    const res = await post(
      "/task-transition",
      { task_id: id, to: "blocked", actor: "dave", note: "upstream contract undecided" },
      ctx.joinToken,
    );
    expect(res.status).toBe(200);
    const log = await tail("dave");
    const row = log.find((r) => r.note.includes("integrate the API"));
    expect(row?.kind).toBe("blocker");
    expect(row?.note).toContain("upstream contract undecided"); // transition note is carried
  });

  it("does NOT log routine transitions (claim / in_progress / review)", async () => {
    const id = await readyTask("routine task");
    await post("/task-claim", { task_id: id, owner: "erin" }, ctx.joinToken);
    await post("/task-transition", { task_id: id, to: "in_progress", actor: "erin" }, ctx.joinToken);
    await post("/task-transition", { task_id: id, to: "review", actor: "erin" }, ctx.joinToken);
    const log = await tail("erin");
    expect(log.some((r) => r.note.includes("routine task"))).toBe(false);
  });
});
