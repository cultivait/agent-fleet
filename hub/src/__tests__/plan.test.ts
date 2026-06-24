import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deadBlockers, wedgedTasks } from "../plan/machine.js";
import { addDep, getTask, getTaskEvents, setLeaseExpiry } from "../plan/store.js";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

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
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(path: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`);
}

describe("plan core — projects", () => {
  it("rejects /project-create without a join token", async () => {
    const res = await post("/project-create", { title: "X" });
    expect(res.status).toBe(401);
  });

  it("creates a project and serves it back via /plan-get", async () => {
    const res = await post(
      "/project-create",
      { title: "Meta-harness overhaul", brief: "build Layer 2", by: "alice" },
      ctx.joinToken,
    );
    expect(res.status).toBe(200);
    const { project } = (await res.json()) as {
      project: { id: string; title: string; brief: string; status: string };
    };
    expect(project.id).toMatch(/^proj_/);
    expect(project.title).toBe("Meta-harness overhaul");
    expect(project.brief).toBe("build Layer 2");
    expect(project.status).toBe("active");

    const planRes = await get(`/plan-get?project_id=${project.id}`);
    expect(planRes.status).toBe(200);
    const plan = (await planRes.json()) as {
      project: { id: string; title: string };
      tasks: unknown[];
    };
    expect(plan.project.id).toBe(project.id);
    expect(plan.tasks).toEqual([]);
  });

  it("404s /plan-get for an unknown project", async () => {
    const res = await get("/plan-get?project_id=proj_nope");
    expect(res.status).toBe(404);
  });
});

describe("plan core — tasks", () => {
  async function makeProject(): Promise<string> {
    const res = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await res.json()) as { project: { id: string } }).project.id;
  }

  it("rejects /task-create without a join token", async () => {
    const res = await post("/task-create", { project_id: "proj_x", title: "x" });
    expect(res.status).toBe(401);
  });

  it("404s /task-create for an unknown project", async () => {
    const res = await post("/task-create", { project_id: "proj_nope", title: "x" }, ctx.joinToken);
    expect(res.status).toBe(404);
  });

  it("creates a task (proposed) and lists it via /plan-get, with a create event", async () => {
    const projectId = await makeProject();
    const res = await post(
      "/task-create",
      { project_id: projectId, title: "design schema", detail: "the DAG", priority: 1, by: "alice" },
      ctx.joinToken,
    );
    expect(res.status).toBe(200);
    const { task } = (await res.json()) as {
      task: { id: string; status: string; title: string; priority: number; project_id: string; parent_id: string | null };
    };
    expect(task.id).toMatch(/^task_/);
    expect(task.status).toBe("proposed");
    expect(task.title).toBe("design schema");
    expect(task.priority).toBe(1);
    expect(task.project_id).toBe(projectId);
    expect(task.parent_id).toBeNull();

    const plan = (await (await get(`/plan-get?project_id=${projectId}`)).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].id).toBe(task.id);

    const events = getTaskEvents(task.id);
    expect(events.some((e) => e.kind === "create")).toBe(true);
  });

  it("supports parent_id (decomposition tree) on create", async () => {
    const projectId = await makeProject();
    const parent = (await (
      await post("/task-create", { project_id: projectId, title: "package", by: "alice" }, ctx.joinToken)
    ).json()) as { task: { id: string } };
    const childRes = await post(
      "/task-create",
      { project_id: projectId, title: "subagent slice", parent_id: parent.task.id, by: "alice" },
      ctx.joinToken,
    );
    expect(childRes.status).toBe(200);
    const child = (await childRes.json()) as { task: { parent_id: string | null } };
    expect(child.task.parent_id).toBe(parent.task.id);
  });
});

async function makeTask(): Promise<string> {
  const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
  const projectId = ((await p.json()) as { project: { id: string } }).project.id;
  const t = await post("/task-create", { project_id: projectId, title: "T", by: "alice" }, ctx.joinToken);
  return ((await t.json()) as { task: { id: string } }).task.id;
}

describe("plan core — transitions (allow-list state machine)", () => {
  it("auto-promotes proposed → ratified → ready (ready is hub-controlled), logging both", async () => {
    const taskId = await makeTask();
    const r1 = await post("/task-transition", { task_id: taskId, to: "ratified", actor: "alice" }, ctx.joinToken);
    expect(r1.status).toBe(200);
    // The hub promotes a blocker-free ratified task straight to ready; the
    // response reflects the final state and two transitions are logged.
    expect(((await r1.json()) as { task: { status: string } }).task.status).toBe("ready");
    expect(getTask(taskId)?.status).toBe("ready");
    const transitions = getTaskEvents(taskId).filter((e) => e.kind === "transition");
    expect(transitions.map((e) => e.to_status)).toEqual(["ratified", "ready"]);
  });

  it("rejects an illegal transition (proposed → done) with 409", async () => {
    const taskId = await makeTask();
    const res = await post("/task-transition", { task_id: taskId, to: "done", actor: "alice" }, ctx.joinToken);
    expect(res.status).toBe(409);
  });

  it("rejects any transition out of a terminal state", async () => {
    const taskId = await makeTask();
    await post("/task-transition", { task_id: taskId, to: "abandoned", actor: "alice" }, ctx.joinToken);
    const res = await post("/task-transition", { task_id: taskId, to: "ratified", actor: "alice" }, ctx.joinToken);
    expect(res.status).toBe(409);
  });

  it("404s a transition on an unknown task", async () => {
    const res = await post("/task-transition", { task_id: "task_nope", to: "ratified", actor: "alice" }, ctx.joinToken);
    expect(res.status).toBe(404);
  });
});

describe("plan core — deps & readiness", () => {
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function newTask(projectId: string, title: string): Promise<string> {
    const t = await post("/task-create", { project_id: projectId, title, by: "alice" }, ctx.joinToken);
    return ((await t.json()) as { task: { id: string } }).task.id;
  }
  function depAdd(taskId: string, blocksOn: string): Promise<Response> {
    return post("/task-dep-add", { task_id: taskId, blocks_on: blocksOn }, ctx.joinToken);
  }
  async function readyIds(): Promise<string[]> {
    const r = await get("/tasks-ready");
    return ((await r.json()) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
  }
  async function ratify(taskId: string): Promise<void> {
    await post("/task-transition", { task_id: taskId, to: "ratified", actor: "alice" }, ctx.joinToken);
  }

  it("adds a dependency edge and surfaces it in /plan-get", async () => {
    const projectId = await newProject();
    const a = await newTask(projectId, "A");
    const b = await newTask(projectId, "B");
    expect((await depAdd(a, b)).status).toBe(200); // A blocks_on B
    const plan = (await (await get(`/plan-get?project_id=${projectId}`)).json()) as {
      deps: Array<{ task_id: string; blocks_on: string }>;
    };
    expect(plan.deps).toContainEqual({ task_id: a, blocks_on: b });
  });

  it("404s /task-create when a dep target does not exist (F3)", async () => {
    const projectId = await newProject();
    const res = await post(
      "/task-create",
      { project_id: projectId, title: "A", deps: ["task_nope"], by: "alice" },
      ctx.joinToken,
    );
    expect(res.status).toBe(404);
  });

  it("rejects a dependency edge that would create a cycle (409)", async () => {
    const projectId = await newProject();
    const a = await newTask(projectId, "A");
    const b = await newTask(projectId, "B");
    expect((await depAdd(a, b)).status).toBe(200); // A depends on B
    expect((await depAdd(b, a)).status).toBe(409); // B depends on A → cycle
  });

  it("accepts deps[] at /task-create time", async () => {
    const projectId = await newProject();
    const b = await newTask(projectId, "B");
    const res = await post("/task-create", { project_id: projectId, title: "A", deps: [b], by: "alice" }, ctx.joinToken);
    expect(res.status).toBe(200);
    const a = ((await res.json()) as { task: { id: string } }).task.id;
    const plan = (await (await get(`/plan-get?project_id=${projectId}`)).json()) as {
      deps: Array<{ task_id: string; blocks_on: string }>;
    };
    expect(plan.deps).toContainEqual({ task_id: a, blocks_on: b });
  });

  async function force(taskId: string, to: string): Promise<void> {
    await post("/admin-task-force", { task_id: taskId, to, actor: "operator" }, ctx.adminToken);
  }

  it("only a DONE blocker unblocks a dependent — abandoned/unsatisfied does NOT (flag #1)", async () => {
    const projectId = await newProject();
    const blocker = await newTask(projectId, "blocker");
    const dependent = await newTask(projectId, "dependent");
    await ratify(blocker); // no deps → hub auto-promotes to ready
    await ratify(dependent);
    await depAdd(dependent, blocker);

    // blocker has no deps → ready; dependent has an unsatisfied dep → not ready
    let ready = await readyIds();
    expect(ready).toContain(blocker);
    expect(ready).not.toContain(dependent);

    // blocker DONE → hub auto-unblocks dependent; done is no longer ready
    await force(blocker, "done");
    ready = await readyIds();
    expect(ready).toContain(dependent);
    expect(ready).not.toContain(blocker);

    // an ABANDONED blocker must NOT unblock its dependent
    const projectId2 = await newProject();
    const blocker2 = await newTask(projectId2, "blocker2");
    const dependent2 = await newTask(projectId2, "dependent2");
    await ratify(dependent2);
    await depAdd(dependent2, blocker2);
    await force(blocker2, "abandoned");
    expect(await readyIds()).not.toContain(dependent2);
  });
});

describe("plan core — artifacts & admin override", () => {
  it("rejects /task-artifact without a join token", async () => {
    const res = await post("/task-artifact", { task_id: "task_x", kind: "pr", uri: "http://x" });
    expect(res.status).toBe(401);
  });

  it("appends an artifact to a task and logs an artifact event", async () => {
    const taskId = await makeTask();
    const res = await post(
      "/task-artifact",
      { task_id: taskId, kind: "pr", uri: "https://example/pr/1", note: "the PR", actor: "alice" },
      ctx.joinToken,
    );
    expect(res.status).toBe(200);
    const artifacts = JSON.parse(getTask(taskId)?.artifacts ?? "[]") as Array<{ kind: string; uri: string }>;
    expect(artifacts).toContainEqual({ kind: "pr", uri: "https://example/pr/1", note: "the PR" });
    expect(getTaskEvents(taskId).some((e) => e.kind === "artifact")).toBe(true);
  });

  it("admin-task-force overrides the state machine, but only with the admin token", async () => {
    const taskId = await makeTask();
    // join token is not enough for an operator override
    expect((await post("/admin-task-force", { task_id: taskId, to: "done" }, ctx.joinToken)).status).toBe(401);
    const res = await post("/admin-task-force", { task_id: taskId, to: "done", actor: "operator" }, ctx.adminToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { task: { status: string } }).task.status).toBe("done");
  });

  it("admin-task-force rejects an unknown target status (400)", async () => {
    const taskId = await makeTask();
    const res = await post("/admin-task-force", { task_id: taskId, to: "bogus" }, ctx.adminToken);
    expect(res.status).toBe(400);
  });
});

// Step 2 (F1): `ready` is a stored state the HUB alone sets/clears. Agents may
// not transition into `ready`; the hub promotes a ratified task the instant all
// its blockers are done and demotes it if a fresh undone blocker appears.
describe("plan step 2 — hub-controlled readiness (F1)", () => {
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function newTask(projectId: string, title: string): Promise<string> {
    const t = await post("/task-create", { project_id: projectId, title, by: "alice" }, ctx.joinToken);
    return ((await t.json()) as { task: { id: string } }).task.id;
  }
  function transition(taskId: string, to: string, actor = "alice"): Promise<Response> {
    return post("/task-transition", { task_id: taskId, to, actor }, ctx.joinToken);
  }
  function depAdd(taskId: string, blocksOn: string): Promise<Response> {
    return post("/task-dep-add", { task_id: taskId, blocks_on: blocksOn }, ctx.joinToken);
  }
  function force(taskId: string, to: string): Promise<Response> {
    return post("/admin-task-force", { task_id: taskId, to, actor: "operator" }, ctx.adminToken);
  }
  async function readyIds(): Promise<string[]> {
    const r = await get("/tasks-ready");
    return ((await r.json()) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
  }

  it("auto-promotes a ratified task with no blockers straight to ready, logging auto-unblock", async () => {
    const projectId = await newProject();
    const taskId = await newTask(projectId, "solo");
    expect((await transition(taskId, "ratified")).status).toBe(200);
    expect(getTask(taskId)?.status).toBe("ready");
    const promo = getTaskEvents(taskId).filter((e) => e.kind === "transition" && e.to_status === "ready");
    expect(promo).toHaveLength(1);
    expect(promo[0].note).toBe("auto-unblock");
  });

  it("keeps a ratified task with an undone blocker at ratified (not ready)", async () => {
    const projectId = await newProject();
    const blocker = await newTask(projectId, "blocker");
    const dependent = await newTask(projectId, "dependent");
    await depAdd(dependent, blocker);
    await transition(dependent, "ratified");
    expect(getTask(dependent)?.status).toBe("ratified");
    expect(await readyIds()).not.toContain(dependent);
  });

  it("rejects a manual /task-transition into ready (409) — ready is hub-controlled", async () => {
    const projectId = await newProject();
    const blocker = await newTask(projectId, "blocker");
    const dependent = await newTask(projectId, "dependent");
    await depAdd(dependent, blocker);
    await transition(dependent, "ratified"); // stays ratified, blocker undone
    expect((await transition(dependent, "ready")).status).toBe(409);
  });

  it("auto-unblocks a dependent when its blocker reaches done (via the transition path)", async () => {
    const projectId = await newProject();
    const blocker = await newTask(projectId, "blocker");
    const dependent = await newTask(projectId, "dependent");
    await depAdd(dependent, blocker);
    await transition(blocker, "ratified"); // → ready (no blockers)
    await transition(dependent, "ratified"); // stays ratified
    expect(getTask(dependent)?.status).toBe("ratified");
    await force(blocker, "done"); // operator completes the blocker
    expect(getTask(blocker)?.status).toBe("done");
    expect(getTask(dependent)?.status).toBe("ready");
    const ready = await readyIds();
    expect(ready).toContain(dependent);
    expect(ready).not.toContain(blocker);
  });

  it("does NOT auto-unblock when a blocker is failed or abandoned (flag #1)", async () => {
    for (const terminal of ["abandoned", "failed"]) {
      const projectId = await newProject();
      const blocker = await newTask(projectId, "blocker");
      const dependent = await newTask(projectId, "dependent");
      await depAdd(dependent, blocker);
      await transition(dependent, "ratified");
      await force(blocker, terminal);
      expect(getTask(blocker)?.status).toBe(terminal);
      expect(getTask(dependent)?.status).toBe("ratified");
      expect(await readyIds()).not.toContain(dependent);
    }
  });

  it("demotes a ready task back to ratified when an undone blocker is added", async () => {
    const projectId = await newProject();
    const target = await newTask(projectId, "target");
    const blocker = await newTask(projectId, "blocker");
    await transition(target, "ratified"); // → ready (no blockers)
    expect(getTask(target)?.status).toBe("ready");
    expect((await depAdd(target, blocker)).status).toBe(200);
    expect(getTask(target)?.status).toBe("ratified"); // re-blocked
    expect(await readyIds()).not.toContain(target);
  });

  it("re-promotes a demoted task once the late blocker completes", async () => {
    const projectId = await newProject();
    const target = await newTask(projectId, "target");
    const blocker = await newTask(projectId, "blocker");
    await transition(target, "ratified");
    await depAdd(target, blocker); // demotes target → ratified
    expect(getTask(target)?.status).toBe("ratified");
    await force(blocker, "done"); // blocker done → target re-promoted
    expect(getTask(target)?.status).toBe("ready");
  });

  // ── Wave-4 (d): surface the silent dead-blocker wedge (build flag #1) ──────────
  // The fail-closed promotion guard above is CORRECT (a missing/failed/abandoned
  // blocker must never auto-promote its dependent), but otherwise SILENT — a task
  // can wait forever undiagnosed. These assert BOTH the (unchanged) correct
  // non-promotion AND that the wedge is now surfaced exactly once.
  function wedges(taskId: string) {
    return getTaskEvents(taskId).filter((e) => e.kind === "blocker_wedge");
  }

  it("surfaces a blocker_wedge when a blocker fails/abandons while the dependent waits", async () => {
    for (const terminal of ["failed", "abandoned"]) {
      const projectId = await newProject();
      const blocker = await newTask(projectId, "blocker");
      const dependent = await newTask(projectId, "dependent");
      await depAdd(dependent, blocker);
      await transition(dependent, "ratified");
      expect(wedges(dependent)).toHaveLength(0); // blocker still pending — no wedge yet
      await force(blocker, terminal);
      // promotion guard stays correctly fail-closed ...
      expect(getTask(dependent)?.status).toBe("ratified");
      expect(await readyIds()).not.toContain(dependent);
      // ... and the silent wedge is now surfaced exactly once, naming blocker + reason
      const w = wedges(dependent);
      expect(w).toHaveLength(1);
      expect(w[0].note).toContain(blocker);
      expect(w[0].note).toContain(terminal);
    }
  });

  it("surfaces a blocker_wedge when a task is ratified with an already-dead blocker", async () => {
    const projectId = await newProject();
    const blocker = await newTask(projectId, "blocker");
    const dependent = await newTask(projectId, "dependent");
    await depAdd(dependent, blocker);
    await force(blocker, "abandoned"); // blocker dead BEFORE dependent is ratified
    await transition(dependent, "ratified"); // promoteIfReady runs → detects dead dep
    expect(getTask(dependent)?.status).toBe("ratified");
    const w = wedges(dependent);
    expect(w).toHaveLength(1);
    expect(w[0].note).toContain("abandoned");
  });

  it("does NOT surface a wedge while a blocker is merely pending, nor after a clean completion", async () => {
    const projectId = await newProject();
    const blocker = await newTask(projectId, "blocker");
    const dependent = await newTask(projectId, "dependent");
    await depAdd(dependent, blocker);
    await transition(dependent, "ratified"); // blocker still proposed — legitimate wait
    expect(wedges(dependent)).toHaveLength(0);
    await transition(blocker, "ratified");
    await force(blocker, "done"); // blocker completes → dependent promotes cleanly
    expect(getTask(dependent)?.status).toBe("ready");
    expect(wedges(dependent)).toHaveLength(0); // never a false-positive wedge
  });

  it("emits the wedge signal only once even as more blockers die", async () => {
    const projectId = await newProject();
    const b1 = await newTask(projectId, "b1");
    const b2 = await newTask(projectId, "b2");
    const dependent = await newTask(projectId, "dependent");
    await depAdd(dependent, b1);
    await depAdd(dependent, b2);
    await transition(dependent, "ratified");
    await force(b1, "failed"); // first death → surfaces
    await force(b2, "abandoned"); // second death → no duplicate signal
    expect(wedges(dependent)).toHaveLength(1);
  });

  it("wedgedTasks()/deadBlockers() report the live dead-blocker set with reasons", async () => {
    const projectId = await newProject();
    const blocker = await newTask(projectId, "blocker");
    const dependent = await newTask(projectId, "dependent");
    await depAdd(dependent, blocker);
    await transition(dependent, "ratified");
    await force(blocker, "failed");
    // per-task classifier
    expect(deadBlockers(dependent)).toEqual([{ blockerId: blocker, reason: "failed" }]);
    // project-wide scan
    const mine = wedgedTasks().find((w) => w.taskId === dependent);
    expect(mine).toBeDefined();
    expect(mine?.projectId).toBe(projectId);
    expect(mine?.deadBlockers).toEqual([{ blockerId: blocker, reason: "failed" }]);
    // a healthy ratified task with a still-pending blocker is NOT wedged
    expect(deadBlockers(blocker)).toEqual([]);
  });
});

// ── Wave-4.1 (a): GET /plan-wedged surfaces the dead-blocker wedge to the operator.
// Endpoint-level coverage (public access + the wedgedTasks() projection over HTTP);
// the wedgedTasks()/deadBlockers() internals are unit-tested in the block above.
describe("plan W4.1-a — GET /plan-wedged (operator surfacing)", () => {
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "W", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function newTask(projectId: string, title: string): Promise<string> {
    const t = await post("/task-create", { project_id: projectId, title, by: "alice" }, ctx.joinToken);
    return ((await t.json()) as { task: { id: string } }).task.id;
  }
  function depAdd(taskId: string, blocksOn: string): Promise<Response> {
    return post("/task-dep-add", { task_id: taskId, blocks_on: blocksOn }, ctx.joinToken);
  }
  function transition(id: string, to: string): Promise<Response> {
    return post("/task-transition", { task_id: id, to, actor: "alice" }, ctx.joinToken);
  }
  function force(id: string, to: string): Promise<Response> {
    return post("/admin-task-force", { task_id: id, to, actor: "operator" }, ctx.adminToken);
  }
  type Wedged = {
    tasks: Array<{
      taskId: string;
      projectId: string;
      deadBlockers: Array<{ blockerId: string; reason: "missing" | "failed" | "abandoned" }>;
    }>;
  };
  const wedged = async (): Promise<Wedged> => (await (await get("/plan-wedged")).json()) as Wedged;

  it("is public (no token) and returns a tasks array", async () => {
    const res = await get("/plan-wedged");
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json() as Wedged).tasks)).toBe(true);
  });

  it("surfaces a ratified task whose blocker failed, with the dead blocker + reason", async () => {
    const projectId = await newProject();
    const blocker = await newTask(projectId, "blocker");
    const dependent = await newTask(projectId, "dependent");
    await depAdd(dependent, blocker);
    await transition(dependent, "ratified");
    // blocker merely pending → legitimate wait, NOT surfaced
    expect((await wedged()).tasks.find((w) => w.taskId === dependent)).toBeUndefined();
    // blocker dies → endpoint now surfaces the wedge with blocker id + reason
    await force(blocker, "failed");
    const mine = (await wedged()).tasks.find((w) => w.taskId === dependent);
    expect(mine).toBeDefined();
    expect(mine?.projectId).toBe(projectId);
    expect(mine?.deadBlockers).toEqual([{ blockerId: blocker, reason: "failed" }]);
  });

  it("does NOT list a task whose blocker completed cleanly", async () => {
    const projectId = await newProject();
    const blocker = await newTask(projectId, "blocker");
    const dependent = await newTask(projectId, "dependent");
    await depAdd(dependent, blocker);
    await transition(dependent, "ratified");
    await transition(blocker, "ratified");
    await force(blocker, "done"); // clean completion → dependent promotes, never wedged
    expect((await wedged()).tasks.find((w) => w.taskId === dependent)).toBeUndefined();
  });
});

// Step 2 (claim): work is taken with a SINGLE conditional UPDATE on status='ready'.
// The race between two instances grabbing the same task is resolved entirely by
// that WHERE clause — exactly one wins, the loser gets 409. Never select-then-update.
describe("plan step 2 — atomic claim", () => {
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function makeProposed(projectId: string, title = "T"): Promise<string> {
    const t = await post("/task-create", { project_id: projectId, title, by: "alice" }, ctx.joinToken);
    return ((await t.json()) as { task: { id: string } }).task.id;
  }
  async function makeReady(projectId: string, title = "T"): Promise<string> {
    const id = await makeProposed(projectId, title);
    await post("/task-transition", { task_id: id, to: "ratified", actor: "alice" }, ctx.joinToken); // → ready
    return id;
  }
  function claim(taskId: string, owner: string, ownerSid?: string, token = ctx.joinToken): Promise<Response> {
    return post("/task-claim", { task_id: taskId, owner, owner_sid: ownerSid }, token);
  }

  it("rejects /task-claim without a join token", async () => {
    const res = await post("/task-claim", { task_id: "task_x", owner: "bob" });
    expect(res.status).toBe(401);
  });

  it("claims a ready task → claimed, with owner/owner_sid/claimed_at set and a claim event", async () => {
    const projectId = await newProject();
    const id = await makeReady(projectId);
    const res = await claim(id, "bob", "sid-1");
    expect(res.status).toBe(200);
    const { task } = (await res.json()) as {
      task: { status: string; owner: string; owner_sid: string; claimed_at: number | null };
    };
    expect(task.status).toBe("claimed");
    expect(task.owner).toBe("bob");
    expect(task.owner_sid).toBe("sid-1");
    expect(typeof task.claimed_at).toBe("number");
    expect(getTaskEvents(id).some((e) => e.kind === "claim")).toBe(true);
    // a claimed task is no longer offered as ready work
    const ready = (await (await get("/tasks-ready")).json()) as { tasks: Array<{ id: string }> };
    expect(ready.tasks.map((t) => t.id)).not.toContain(id);
  });

  it("404s a claim on an unknown task", async () => {
    const res = await claim("task_nope", "bob");
    expect(res.status).toBe(404);
  });

  it("409s a claim on a task that is not ready (still proposed)", async () => {
    const projectId = await newProject();
    const id = await makeProposed(projectId);
    const res = await claim(id, "bob");
    expect(res.status).toBe(409);
  });

  it("400s a claim missing an owner", async () => {
    const projectId = await newProject();
    const id = await makeReady(projectId);
    const res = await post("/task-claim", { task_id: id }, ctx.joinToken);
    expect(res.status).toBe(400);
  });

  it("lets exactly one of two concurrent claims win — the loser gets 409, owner not overwritten", async () => {
    const projectId = await newProject();
    const id = await makeReady(projectId);
    const [a, b] = await Promise.all([claim(id, "bob", "sid-bob"), claim(id, "carol", "sid-carol")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? "bob" : "carol";
    expect(getTask(id)?.status).toBe("claimed");
    expect(getTask(id)?.owner).toBe(winner);
  });
});

// Step 2 (F2): once a task is claimed, only its owner drives it forward — except
// the review gate, where review→done must be approved by a DIFFERENT actor (no
// self-merge). Pre-claim transitions stay open; admin-force bypasses the gate.
describe("plan step 2 — owner-gating + no-self-merge (F2)", () => {
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function claimedBy(projectId: string, owner: string): Promise<string> {
    const t = await post("/task-create", { project_id: projectId, title: "T", by: "alice" }, ctx.joinToken);
    const id = ((await t.json()) as { task: { id: string } }).task.id;
    await post("/task-transition", { task_id: id, to: "ratified", actor: "alice" }, ctx.joinToken); // → ready
    await post("/task-claim", { task_id: id, owner }, ctx.joinToken); // → claimed, owner set
    return id;
  }
  function transition(id: string, to: string, actor?: string): Promise<Response> {
    return post("/task-transition", { task_id: id, to, ...(actor ? { actor } : {}) }, ctx.joinToken);
  }
  async function toReview(projectId: string, owner: string): Promise<string> {
    const id = await claimedBy(projectId, owner);
    await transition(id, "in_progress", owner);
    await transition(id, "review", owner);
    return id;
  }

  it("lets the owner drive their claimed task forward", async () => {
    const id = await claimedBy(await newProject(), "bob");
    expect((await transition(id, "in_progress", "bob")).status).toBe(200);
    expect((await transition(id, "review", "bob")).status).toBe(200);
  });

  it("blocks a non-owner from transitioning a claimed task (403)", async () => {
    const id = await claimedBy(await newProject(), "bob");
    expect((await transition(id, "in_progress", "mallory")).status).toBe(403);
    expect(getTask(id)?.status).toBe("claimed"); // unchanged
  });

  it("forbids the owner from self-merging review→done (403)", async () => {
    const id = await toReview(await newProject(), "bob");
    expect((await transition(id, "done", "bob")).status).toBe(403);
    expect(getTask(id)?.status).toBe("review"); // not merged
  });

  it("requires an actor for review→done — anonymous cannot approve (403)", async () => {
    const id = await toReview(await newProject(), "bob");
    expect((await transition(id, "done")).status).toBe(403);
    expect(getTask(id)?.status).toBe("review");
  });

  it("allows a non-owner to approve review→done (no self-merge satisfied)", async () => {
    const id = await toReview(await newProject(), "bob");
    const res = await transition(id, "done", "carol");
    expect(res.status).toBe(200);
    expect(getTask(id)?.status).toBe("done");
  });

  it("lets a non-owner reviewer reject review→in_progress", async () => {
    const id = await toReview(await newProject(), "bob");
    const res = await transition(id, "in_progress", "carol");
    expect(res.status).toBe(200);
    expect(getTask(id)?.status).toBe("in_progress");
  });

  it("gates release (claimed→ready) to the owner and clears ownership on release", async () => {
    const id = await claimedBy(await newProject(), "bob");
    expect((await transition(id, "ready", "mallory")).status).toBe(403); // non-owner can't release
    expect((await transition(id, "ready", "bob")).status).toBe(200); // owner releases
    const t = getTask(id);
    expect(t?.status).toBe("ready");
    expect(t?.owner).toBeNull(); // released back to the pool, claimable afresh
  });

  it("re-checks readiness on release — a blocker added while claimed demotes the released task (S2-1)", async () => {
    const projectId = await newProject();
    const id = await claimedBy(projectId, "bob");
    // a prerequisite appears while the task is in-flight (claimed); demoteIfBlocked
    // is a no-op here (acts only on `ready`), so the dep sits until release.
    const b = await post("/task-create", { project_id: projectId, title: "late blocker", by: "alice" }, ctx.joinToken);
    const blockerId = ((await b.json()) as { task: { id: string } }).task.id;
    await post("/task-dep-add", { task_id: id, blocks_on: blockerId }, ctx.joinToken);
    expect(getTask(id)?.status).toBe("claimed");
    // releasing must NOT re-advertise the task as ready while its blocker is unfinished
    expect((await transition(id, "ready", "bob")).status).toBe(200);
    expect(getTask(id)?.status).toBe("ratified");
    const ready = (await (await get("/tasks-ready")).json()) as { tasks: Array<{ id: string }> };
    expect(ready.tasks.map((t) => t.id)).not.toContain(id);
  });

  it("lets admin-force bypass the owner gate (operator override)", async () => {
    const id = await toReview(await newProject(), "bob");
    const res = await post("/admin-task-force", { task_id: id, to: "done", actor: "operator" }, ctx.adminToken);
    expect(res.status).toBe(200);
    expect(getTask(id)?.status).toBe("done");
  });

  it("leaves pre-claim transitions open to any join-token holder", async () => {
    const projectId = await newProject();
    const t = await post("/task-create", { project_id: projectId, title: "T", by: "alice" }, ctx.joinToken);
    const id = ((await t.json()) as { task: { id: string } }).task.id;
    // 'zoe' is not the creator, but the task has no owner yet — ratify is allowed
    expect((await transition(id, "ratified", "zoe")).status).toBe(200);
  });
});

// Roll-up: when every child of a decomposed parent reaches terminal, the hub emits
// a one-time `rollup` SIGNAL + children summary; and (W4.1-c) when every child is
// `done` it AUTO-COMPLETES the parent to `done` (hub-controlled, like auto-ready;
// recurses up nested parents). A failed/abandoned child still signals but does NOT
// auto-complete the parent — partial failure is the operator's call.
describe("plan step 2 — parent roll-up signal + auto-complete (W4.1-c)", () => {
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function makeTaskIn(projectId: string, title: string, parentId?: string): Promise<string> {
    const t = await post(
      "/task-create",
      { project_id: projectId, title, ...(parentId ? { parent_id: parentId } : {}), by: "alice" },
      ctx.joinToken,
    );
    return ((await t.json()) as { task: { id: string } }).task.id;
  }
  function force(id: string, to: string): Promise<Response> {
    return post("/admin-task-force", { task_id: id, to, actor: "operator" }, ctx.adminToken);
  }
  async function summaries(
    projectId: string,
  ): Promise<Record<string, { total: number; terminal: number; done: number }>> {
    const plan = (await (await get(`/plan-get?project_id=${projectId}`)).json()) as {
      childSummaries: Record<string, { total: number; terminal: number; done: number }>;
    };
    return plan.childSummaries;
  }

  it("auto-completes the parent to done when ALL children are done (+ one-time rollup)", async () => {
    const projectId = await newProject();
    const parentId = await makeTaskIn(projectId, "parent");
    const c1 = await makeTaskIn(projectId, "c1", parentId);
    const c2 = await makeTaskIn(projectId, "c2", parentId);

    await force(c1, "done"); // one child done — parent not yet complete
    expect(getTaskEvents(parentId).some((e) => e.kind === "rollup")).toBe(false);
    expect(getTask(parentId)?.status).toBe("proposed"); // not yet — c2 still open

    await force(c2, "done"); // last child done — rollup fires once AND parent auto-completes
    expect(getTaskEvents(parentId).filter((e) => e.kind === "rollup")).toHaveLength(1);
    expect(getTask(parentId)?.status).toBe("done"); // W4.1-c: hub auto-advances when all children done
    // exactly one auto-complete transition→done was logged on the parent (idempotent)
    expect(
      getTaskEvents(parentId).filter((e) => e.kind === "transition" && e.to_status === "done"),
    ).toHaveLength(1);

    expect((await summaries(projectId))[parentId]).toEqual({ total: 2, terminal: 2, done: 2 });
  });

  it("does NOT auto-complete the parent when a child failed/abandoned (mixed outcomes)", async () => {
    const projectId = await newProject();
    const parentId = await makeTaskIn(projectId, "parent");
    const c1 = await makeTaskIn(projectId, "c1", parentId);
    const c2 = await makeTaskIn(projectId, "c2", parentId);
    await force(c1, "done");
    await force(c2, "abandoned"); // all terminal, but NOT all done
    // signal still fires (all terminal)…
    expect(getTaskEvents(parentId).filter((e) => e.kind === "rollup")).toHaveLength(1);
    // …but the parent must NOT auto-complete — partial failure is the operator's call
    expect(getTask(parentId)?.status).toBe("proposed");
    expect(
      getTaskEvents(parentId).some((e) => e.kind === "transition" && e.to_status === "done"),
    ).toBe(false);
    expect((await summaries(projectId))[parentId]).toEqual({ total: 2, terminal: 2, done: 1 });
  });

  it("auto-completes a parent that was force-reopened: a failed child later driven to done", async () => {
    const projectId = await newProject();
    const parentId = await makeTaskIn(projectId, "parent");
    const c1 = await makeTaskIn(projectId, "c1", parentId);
    const c2 = await makeTaskIn(projectId, "c2", parentId);
    await force(c1, "done");
    await force(c2, "failed"); // mixed → signal fires, parent stays open
    expect(getTaskEvents(parentId).filter((e) => e.kind === "rollup")).toHaveLength(1);
    expect(getTask(parentId)?.status).toBe("proposed");

    // operator reopens the failed child and drives it to done → now ALL done
    await force(c2, "in_progress");
    await force(c2, "done");
    // signal must NOT re-fire (rollup_signaled already set)…
    expect(getTaskEvents(parentId).filter((e) => e.kind === "rollup")).toHaveLength(1);
    // …but the now-all-done parent MUST complete (completion guard is separate)
    expect(getTask(parentId)?.status).toBe("done");
  });

  it("does not roll up while any child is still open", async () => {
    const projectId = await newProject();
    const parentId = await makeTaskIn(projectId, "parent");
    const c1 = await makeTaskIn(projectId, "c1", parentId);
    await makeTaskIn(projectId, "c2", parentId); // stays proposed
    await force(c1, "done");
    expect(getTaskEvents(parentId).some((e) => e.kind === "rollup")).toBe(false);
    expect((await summaries(projectId))[parentId]).toEqual({ total: 2, terminal: 1, done: 1 });
  });

  it("propagates completion up nested parents (grandparent auto-completes)", async () => {
    const projectId = await newProject();
    const g = await makeTaskIn(projectId, "grandparent");
    const p = await makeTaskIn(projectId, "parent", g); // child of g, parent of c1/c2
    const c1 = await makeTaskIn(projectId, "c1", p);
    const c2 = await makeTaskIn(projectId, "c2", p);

    await force(c1, "done");
    expect(getTask(p)?.status).toBe("proposed");
    expect(getTask(g)?.status).toBe("proposed");

    await force(c2, "done"); // p's children all done → p done → g's only child done → g done
    expect(getTask(p)?.status).toBe("done");
    expect(getTask(g)?.status).toBe("done");
    // each parent auto-completed exactly once
    expect(getTaskEvents(p).filter((e) => e.kind === "transition" && e.to_status === "done")).toHaveLength(1);
    expect(getTaskEvents(g).filter((e) => e.kind === "transition" && e.to_status === "done")).toHaveLength(1);
  });

  it("is idempotent — re-evaluating an already-completed parent neither re-signals nor re-completes", async () => {
    const projectId = await newProject();
    const parentId = await makeTaskIn(projectId, "parent");
    const c1 = await makeTaskIn(projectId, "c1", parentId);
    const c2 = await makeTaskIn(projectId, "c2", parentId);
    await force(c1, "done");
    await force(c2, "done"); // parent auto-completes
    expect(getTask(parentId)?.status).toBe("done");
    expect(getTaskEvents(parentId).filter((e) => e.kind === "rollup")).toHaveLength(1);
    expect(
      getTaskEvents(parentId).filter((e) => e.kind === "transition" && e.to_status === "done"),
    ).toHaveLength(1);

    // re-trigger the terminal roll-up path on the already-done parent (done→done admin force)
    await force(c1, "done");
    expect(getTaskEvents(parentId).filter((e) => e.kind === "rollup")).toHaveLength(1); // not re-signaled
    expect(
      getTaskEvents(parentId).filter((e) => e.kind === "transition" && e.to_status === "done"),
    ).toHaveLength(1); // not re-completed
    expect(getTask(parentId)?.status).toBe("done");
  });
});

// Step 3: the plan is a live BOARD. /plan-board projects a project's tasks into
// status lanes (the read model), and every plan mutation broadcasts a
// `plan_update` SSE event so a viewer refreshes without polling.
describe("plan step 3 — board-as-view (status-lane projection)", () => {
  const LANES = [
    "proposed",
    "ratified",
    "ready",
    "claimed",
    "in_progress",
    "review",
    "blocked",
    "done",
    "failed",
    "abandoned",
  ];
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function newTask(projectId: string, title: string): Promise<string> {
    const t = await post("/task-create", { project_id: projectId, title, by: "alice" }, ctx.joinToken);
    return ((await t.json()) as { task: { id: string } }).task.id;
  }
  function transition(id: string, to: string, actor = "alice"): Promise<Response> {
    return post("/task-transition", { task_id: id, to, actor }, ctx.joinToken);
  }
  function board(projectId: string): Promise<Response> {
    return get(`/plan-board?project_id=${projectId}`);
  }

  it("400s without project_id and 404s an unknown project", async () => {
    expect((await get("/plan-board")).status).toBe(400);
    expect((await get("/plan-board?project_id=proj_nope")).status).toBe(404);
  });

  it("projects tasks into ordered status lanes, every lane present even when empty", async () => {
    const projectId = await newProject();
    const a = await newTask(projectId, "A"); // proposed
    const b = await newTask(projectId, "B");
    await transition(b, "ratified"); // → ready
    const res = await board(projectId);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      project: { id: string };
      lanes: Record<string, Array<{ id: string }>>;
      deps: unknown[];
      childSummaries: object;
    };
    expect(Object.keys(data.lanes)).toEqual(LANES); // canonical order, all present
    expect(data.lanes.proposed.map((t) => t.id)).toContain(a);
    expect(data.lanes.ready.map((t) => t.id)).toContain(b);
    expect(data.lanes.proposed.map((t) => t.id)).not.toContain(b);
    expect(data.lanes.in_progress).toEqual([]); // empty lane still present
  });

  it("carries owner on a claimed task and includes deps + childSummaries", async () => {
    const projectId = await newProject();
    const id = await newTask(projectId, "T");
    await transition(id, "ratified"); // → ready
    await post("/task-claim", { task_id: id, owner: "bob" }, ctx.joinToken);
    const data = (await (await board(projectId)).json()) as {
      lanes: Record<string, Array<{ id: string; owner: string | null }>>;
      deps: unknown[];
      childSummaries: object;
    };
    expect(data.lanes.claimed.find((t) => t.id === id)?.owner).toBe("bob");
    expect(Array.isArray(data.deps)).toBe(true);
    expect(typeof data.childSummaries).toBe("object");
  });

  // Read one plan_update off the live SSE stream. Open /events first (registers
  // the client), then fire the mutation; bound the read so a missing broadcast
  // fails cleanly instead of hanging.
  async function awaitPlanEvent(
    trigger: () => Promise<unknown>,
    match: (ev: Record<string, unknown>) => boolean,
    timeoutMs = 3000,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const resp = await fetch(`${ctx.baseUrl}/events`, {
      headers: { Authorization: `Bearer ${ctx.cockpitToken}` },
      signal: controller.signal,
    });
    const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    await trigger();
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SSE timeout")), timeoutMs));
    try {
      for (;;) {
        const { value, done } = (await Promise.race([reader.read(), timeout])) as ReadableStreamReadResult<Uint8Array>;
        if (done) throw new Error("SSE stream closed");
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const ev = JSON.parse(dataLine.slice(dataLine.indexOf(":") + 1).trim()) as Record<string, unknown>;
          if (match(ev)) return ev;
        }
      }
    } finally {
      controller.abort();
      void reader.cancel().catch(() => undefined);
    }
  }

  it("broadcasts a plan_update SSE event on a task transition", async () => {
    const projectId = await newProject();
    const id = await newTask(projectId, "T");
    const ev = await awaitPlanEvent(
      () => transition(id, "ratified"),
      (e) => e.type === "plan_update" && e.taskId === id,
    );
    expect(ev.projectId).toBe(projectId);
    expect(ev.kind).toBe("transition");
  });

  it("broadcasts a plan_update SSE event on project creation", async () => {
    const ev = await awaitPlanEvent(
      () => post("/project-create", { title: "via-sse", by: "alice" }, ctx.joinToken),
      (e) => e.type === "plan_update" && e.kind === "project_create",
    );
    expect(typeof ev.projectId).toBe("string");
  });

  it("400s /plan-owned without owner_sid", async () => {
    expect((await get("/plan-owned")).status).toBe(400);
  });

  it("serves a by-owner_sid view of what a session actively holds (feeder's query)", async () => {
    const projectId = await newProject();
    const t1 = await newTask(projectId, "T1");
    const t2 = await newTask(projectId, "T2");
    const t3 = await newTask(projectId, "T3");
    for (const id of [t1, t2, t3]) await transition(id, "ratified"); // → ready
    await post("/task-claim", { task_id: t1, owner: "bob", owner_sid: "sid-A" }, ctx.joinToken);
    await post("/task-claim", { task_id: t2, owner: "bob", owner_sid: "sid-A" }, ctx.joinToken);
    await post("/task-claim", { task_id: t3, owner: "carol", owner_sid: "sid-B" }, ctx.joinToken);
    await transition(t1, "in_progress", "bob"); // still held by sid-A

    // sid-A actively holds t1 (in_progress) + t2 (claimed), not t3 (sid-B)
    const res = await get("/plan-owned?owner_sid=sid-A");
    expect(res.status).toBe(200);
    const owned = (await res.json()) as { tasks: Array<{ id: string }> };
    expect(owned.tasks.map((t) => t.id).sort()).toEqual([t1, t2].sort());

    // releasing clears owner_sid → drops out of the owned view immediately
    await transition(t2, "ready", "bob");
    const after = (await (await get("/plan-owned?owner_sid=sid-A")).json()) as { tasks: Array<{ id: string }> };
    expect(after.tasks.map((t) => t.id)).toEqual([t1]);
  });
});

// Step 4A: a claim grants a time-boxed LEASE; if the owner stops heartbeating it
// lazily expires on the next read and the task returns to the pool. Governed set
// is claimed + in_progress ONLY (review/blocked are parked). The all-tools
// heartbeat hook (renewal driver) is 4B — verified live at deploy.
describe("plan step 4 — leases & lazy reclaim", () => {
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function readyTask(projectId: string, title = "T"): Promise<string> {
    const t = await post("/task-create", { project_id: projectId, title, by: "alice" }, ctx.joinToken);
    const id = ((await t.json()) as { task: { id: string } }).task.id;
    await post("/task-transition", { task_id: id, to: "ratified", actor: "alice" }, ctx.joinToken); // → ready
    return id;
  }
  function claim(id: string, owner: string, sid: string): Promise<Response> {
    return post("/task-claim", { task_id: id, owner, owner_sid: sid }, ctx.joinToken);
  }
  function heartbeat(id: string, sid: string): Promise<Response> {
    return post("/task-heartbeat", { task_id: id, owner_sid: sid }, ctx.joinToken);
  }
  function transition(id: string, to: string, actor = "alice"): Promise<Response> {
    return post("/task-transition", { task_id: id, to, actor }, ctx.joinToken);
  }
  async function readyIds(): Promise<string[]> {
    return ((await (await get("/tasks-ready")).json()) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
  }

  it("claim grants a lease in the future", async () => {
    const id = await readyTask(await newProject());
    const before = Date.now();
    await claim(id, "bob", "sid-A");
    const lease = getTask(id)?.lease_expires_at;
    expect(typeof lease).toBe("number");
    expect(lease as number).toBeGreaterThan(before);
  });

  it("/task-heartbeat: 401 no token, 404 unknown, 409 non-governed, 403 wrong sid, 200 owner", async () => {
    expect((await post("/task-heartbeat", { task_id: "x", owner_sid: "s" })).status).toBe(401);
    expect((await heartbeat("task_nope", "s")).status).toBe(404);
    const id = await readyTask(await newProject());
    expect((await heartbeat(id, "sid-A")).status).toBe(409); // ready = not lease-governed
    await claim(id, "bob", "sid-A");
    expect((await heartbeat(id, "sid-WRONG")).status).toBe(403);
    expect((await heartbeat(id, "sid-A")).status).toBe(200);
  });

  it("heartbeat RENEWS sliding (now+LEASE), never accumulates (C1)", async () => {
    const id = await readyTask(await newProject());
    await claim(id, "bob", "sid-A");
    setLeaseExpiry(id, Date.now() + 1000); // near-expiry
    await heartbeat(id, "sid-A");
    const lease = getTask(id)?.lease_expires_at as number;
    const now = Date.now();
    expect(lease).toBeGreaterThan(now + 1000); // moved forward to ~now+LEASE
    expect(lease).toBeLessThan(now + 3_600_000); // NOT doubled (default LEASE=1800s)
  });

  it("reclaims an expired claimed lease on read → ready, owner cleared, lease_expired logged", async () => {
    const id = await readyTask(await newProject());
    await claim(id, "bob", "sid-A");
    setLeaseExpiry(id, Date.now() - 1000); // expired
    await get("/tasks-ready"); // lazy sweep fires on read
    const t = getTask(id);
    expect(t?.status).toBe("ready");
    expect(t?.owner).toBeNull();
    expect(t?.owner_sid).toBeNull();
    expect(t?.lease_expires_at).toBeNull();
    expect(getTaskEvents(id).some((e) => e.kind === "lease_expired")).toBe(true);
  });

  it("reclaims an expired in_progress lease too", async () => {
    const id = await readyTask(await newProject());
    await claim(id, "bob", "sid-A");
    await transition(id, "in_progress", "bob");
    setLeaseExpiry(id, Date.now() - 1000);
    await get("/tasks-ready");
    expect(getTask(id)?.status).toBe("ready");
  });

  it("does NOT reclaim parked review/blocked even with a stale lease (R1)", async () => {
    for (const park of ["review", "blocked"]) {
      const id = await readyTask(await newProject(), park);
      await claim(id, "bob", "sid-A");
      await transition(id, "in_progress", "bob");
      await transition(id, park, "bob");
      setLeaseExpiry(id, Date.now() - 1000);
      await get("/tasks-ready");
      expect(getTask(id)?.status).toBe(park);
    }
  });

  it("a heartbeat before the sweep prevents reclaim", async () => {
    const id = await readyTask(await newProject());
    await claim(id, "bob", "sid-A");
    setLeaseExpiry(id, Date.now() - 1000); // would expire
    await heartbeat(id, "sid-A"); // renew first
    await get("/tasks-ready"); // sweep
    expect(getTask(id)?.status).toBe("claimed"); // survived
  });

  it("reclaim runs the readiness re-check — expired task with an undone dep demotes to ratified, not ready (no S2-1 via lease door)", async () => {
    const projectId = await newProject();
    const id = await readyTask(projectId);
    const blocker = await readyTask(projectId, "blocker"); // ready, not done
    await claim(id, "bob", "sid-A");
    await post("/task-dep-add", { task_id: id, blocks_on: blocker }, ctx.joinToken); // demote no-op while claimed
    setLeaseExpiry(id, Date.now() - 1000);
    await get("/tasks-ready");
    expect(getTask(id)?.status).toBe("ratified"); // reclaimed → ready → demoted (blocker undone)
    expect(await readyIds()).not.toContain(id);
  });

  it("reclaim on the /task-claim path frees an expired lease so a new claimant can take it", async () => {
    const id = await readyTask(await newProject());
    await claim(id, "bob", "sid-A");
    setLeaseExpiry(id, Date.now() - 1000);
    // carol claims: the sweep at the top of /task-claim reclaims bob's expired lease first
    const res = await claim(id, "carol", "sid-B");
    expect(res.status).toBe(200);
    expect(getTask(id)?.owner).toBe("carol");
  });
});

// Step 5: durable handoffs. The lease/reclaim machinery already moves OWNERSHIP
// through the pool; handoffs move CONTEXT — append-only notes on task_event so a
// next claimant resumes without re-deriving, surviving an instance dying.
describe("plan step 5 — durable handoffs", () => {
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function readyTask(projectId: string, title = "T"): Promise<string> {
    const t = await post("/task-create", { project_id: projectId, title, by: "alice" }, ctx.joinToken);
    const id = ((await t.json()) as { task: { id: string } }).task.id;
    await post("/task-transition", { task_id: id, to: "ratified", actor: "alice" }, ctx.joinToken);
    return id;
  }
  function claim(id: string, owner: string, sid: string): Promise<Response> {
    return post("/task-claim", { task_id: id, owner, owner_sid: sid }, ctx.joinToken);
  }
  function handoff(id: string, body: Record<string, unknown>): Promise<Response> {
    return post("/task-handoff", { task_id: id, ...body }, ctx.joinToken);
  }
  function getHandoffs(id: string): Promise<Response> {
    return get(`/task-handoffs?task_id=${id}`);
  }

  it("401 without token; 400 missing summary; 404 unknown task", async () => {
    expect((await post("/task-handoff", { task_id: "x", actor: "bob", summary: "s" })).status).toBe(401);
    const id = await readyTask(await newProject());
    expect((await post("/task-handoff", { task_id: id, actor: "bob" }, ctx.joinToken)).status).toBe(400);
    expect((await post("/task-handoff", { task_id: "task_nope", actor: "bob", summary: "s" }, ctx.joinToken)).status).toBe(404);
  });

  it("writes a structured handoff and serves it back parsed", async () => {
    const id = await readyTask(await newProject());
    const res = await handoff(id, {
      actor: "bob",
      summary: "did the schema",
      next_step: "wire the endpoint",
      blockers: ["needs review token"],
    });
    expect(res.status).toBe(200);
    const list = (await (await getHandoffs(id)).json()) as {
      handoffs: Array<{ summary: string; next_step: string | null; blockers: string[]; actor: string | null }>;
    };
    expect(list.handoffs).toHaveLength(1);
    expect(list.handoffs[0]).toMatchObject({
      summary: "did the schema",
      next_step: "wire the endpoint",
      blockers: ["needs review token"],
      actor: "bob",
    });
  });

  it("appends handoff artifacts to the task", async () => {
    const id = await readyTask(await newProject());
    await handoff(id, { actor: "bob", summary: "s", artifacts: [{ kind: "pr", uri: "https://x/pr/1", note: "the PR" }] });
    const got = (await (await getHandoffs(id)).json()) as { artifacts: Array<{ kind: string; uri: string; note: string | null }> };
    expect(got.artifacts).toContainEqual({ kind: "pr", uri: "https://x/pr/1", note: "the PR" });
  });

  it("the /task-claim response carries the latest handoff (B2: by id, resume-without-re-derive)", async () => {
    const id = await readyTask(await newProject());
    await handoff(id, { actor: "alice", summary: "first" });
    await handoff(id, { actor: "alice", summary: "second — latest" });
    const body = (await (await claim(id, "bob", "sid-A")).json()) as { handoff: { summary: string } | null };
    expect(body.handoff?.summary).toBe("second — latest");
  });

  it("claim handoff is null when the task has none", async () => {
    const id = await readyTask(await newProject());
    const body = (await (await claim(id, "bob", "sid-A")).json()) as { handoff: unknown };
    expect(body.handoff).toBeNull();
  });

  it("B1: plain-string notes from other event kinds never break /task-handoffs", async () => {
    const id = await readyTask(await newProject()); // ratify → 'auto-unblock' note (plain string)
    await claim(id, "bob", "sid-A"); // claim note = owner (plain string)
    await post("/task-transition", { task_id: id, to: "in_progress", actor: "bob" }, ctx.joinToken);
    await handoff(id, { actor: "bob", summary: "only handoff" });
    const res = await getHandoffs(id);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { handoffs: Array<{ summary: string }> };
    expect(list.handoffs.map((h) => h.summary)).toEqual(["only handoff"]);
  });

  it("B3: posting a handoff does NOT touch the lease", async () => {
    const id = await readyTask(await newProject());
    await claim(id, "bob", "sid-A");
    const before = getTask(id)?.lease_expires_at;
    await handoff(id, { actor: "bob", summary: "checkpoint" });
    expect(getTask(id)?.lease_expires_at).toBe(before);
  });

  it("on lease-reclaim a synthetic death-handoff is appended for the next claimant", async () => {
    const id = await readyTask(await newProject());
    await claim(id, "bob", "sid-A");
    await post("/task-transition", { task_id: id, to: "in_progress", actor: "bob" }, ctx.joinToken);
    setLeaseExpiry(id, Date.now() - 1000);
    await get("/tasks-ready"); // reclaim fires
    const body = (await (await claim(id, "carol", "sid-B")).json()) as {
      handoff: { summary: string; system: boolean } | null;
    };
    expect(body.handoff?.system).toBe(true);
    expect(body.handoff?.summary).toMatch(/reclaim/i);
  });

  it("resume ordering: a single /task-claim that triggers the reclaim returns the synthetic handoff", async () => {
    const id = await readyTask(await newProject());
    await claim(id, "bob", "sid-A");
    await post("/task-transition", { task_id: id, to: "in_progress", actor: "bob" }, ctx.joinToken);
    setLeaseExpiry(id, Date.now() - 1000);
    // carol claims directly — the sweep at the TOP of /task-claim reclaims bob's
    // task (appending the synthetic handoff) BEFORE the claim reads latest.
    const body = (await (await claim(id, "carol", "sid-B")).json()) as {
      task: { owner: string };
      handoff: { system: boolean; summary: string } | null;
    };
    expect(body.task.owner).toBe("carol");
    expect(body.handoff?.system).toBe(true);
    expect(body.handoff?.summary).toMatch(/mid-in_progress/);
  });

  it("S5-1: a real mid-work handoff is NOT shadowed — no synthetic when the dying owner left one", async () => {
    const id = await readyTask(await newProject());
    await claim(id, "bob", "sid-A");
    await post("/task-transition", { task_id: id, to: "in_progress", actor: "bob" }, ctx.joinToken);
    await handoff(id, { actor: "bob", summary: "real progress: did X, next do Y" }); // graceful breadcrumb
    setLeaseExpiry(id, Date.now() - 1000); // then bob dies
    const body = (await (await claim(id, "carol", "sid-B")).json()) as {
      handoff: { summary: string; system: boolean } | null;
    };
    // carol resumes with BOB'S real note, not a misleading "no graceful handoff" synthetic
    expect(body.handoff?.system).toBe(false);
    expect(body.handoff?.summary).toMatch(/real progress/);
  });
});

// Step 4B: the all-tools PreToolUse heartbeat hook can't know task ids — it only
// has the session id. So /plan-heartbeat renews EVERY lease-governed task a sid
// holds in one call. Lease-governed = claimed + in_progress ONLY (review/blocked
// are parked, per R1). It emits a coarse plan_update per renewed task (a refetch
// trigger with NO task_event) so the cockpit's lease countdowns stay honest
// without spamming the Feed. Uses sids unique to this block so the step-4 leftovers
// above don't inflate the renewed count.
describe("plan step 4B — sid-scoped /plan-heartbeat", () => {
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function readyTask(projectId: string, title = "T"): Promise<string> {
    const t = await post("/task-create", { project_id: projectId, title, by: "alice" }, ctx.joinToken);
    const id = ((await t.json()) as { task: { id: string } }).task.id;
    await post("/task-transition", { task_id: id, to: "ratified", actor: "alice" }, ctx.joinToken); // → ready
    return id;
  }
  function claim(id: string, owner: string, sid: string): Promise<Response> {
    return post("/task-claim", { task_id: id, owner, owner_sid: sid }, ctx.joinToken);
  }
  function transition(id: string, to: string, actor = "bob"): Promise<Response> {
    return post("/task-transition", { task_id: id, to, actor }, ctx.joinToken);
  }
  function planHeartbeat(sid: string | undefined): Promise<Response> {
    return post("/plan-heartbeat", sid === undefined ? {} : { owner_sid: sid }, ctx.joinToken);
  }

  it("requires a join token (401 without)", async () => {
    const res = await fetch(`${ctx.baseUrl}/plan-heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_sid: "hb-A" }),
    });
    expect(res.status).toBe(401);
  });

  it("400 when owner_sid is missing", async () => {
    expect((await planHeartbeat(undefined)).status).toBe(400);
  });

  it("unknown sid renews nothing → 200, renewed 0", async () => {
    const res = await planHeartbeat("hb-NOBODY");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { renewed: number }).renewed).toBe(0);
  });

  it("renews ALL of a sid's claimed + in_progress leases in one call; ignores review + other sids", async () => {
    const projectId = await newProject();
    const a = await readyTask(projectId, "A-claimed");
    const b = await readyTask(projectId, "B-inprogress");
    const c = await readyTask(projectId, "C-review");
    const d = await readyTask(projectId, "D-othersid");
    await claim(a, "bob", "hb-A"); // stays claimed
    await claim(b, "bob", "hb-A");
    await transition(b, "in_progress"); // in_progress
    await claim(c, "bob", "hb-A");
    await transition(c, "in_progress");
    await transition(c, "review"); // parked → NOT lease-governed
    await claim(d, "carol", "hb-B"); // different sid

    const near = Date.now() + 1000;
    for (const id of [a, b, c, d]) setLeaseExpiry(id, near);

    const res = await planHeartbeat("hb-A");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { renewed: number }).renewed).toBe(2);

    const now = Date.now();
    for (const id of [a, b]) {
      const lease = getTask(id)?.lease_expires_at as number;
      expect(lease).toBeGreaterThan(now + 1000); // slid forward to ~now+LEASE
      expect(lease).toBeLessThan(now + 3_600_000); // not doubled (default 1800s)
    }
    expect(getTask(c)?.lease_expires_at).toBe(near); // review parked — untouched
    expect(getTask(d)?.lease_expires_at).toBe(near); // other sid — untouched
  });

  it("renewal is sliding, never accumulating", async () => {
    const id = await readyTask(await newProject(), "slide");
    await claim(id, "bob", "hb-SLIDE");
    setLeaseExpiry(id, Date.now() + 1000);
    await planHeartbeat("hb-SLIDE");
    const lease = getTask(id)?.lease_expires_at as number;
    const now = Date.now();
    expect(lease).toBeGreaterThan(now + 1000);
    expect(lease).toBeLessThan(now + 3_600_000);
  });

  // Symmetry with the review case: `blocked` is the other parked state and must
  // also never be lease-renewed (both excluded via the same LEASE_GOVERNED set).
  it("does not renew a parked blocked task", async () => {
    const id = await readyTask(await newProject(), "blocked-parked");
    await claim(id, "bob", "hb-BLK");
    await transition(id, "in_progress");
    await transition(id, "blocked");
    const near = Date.now() + 1000;
    setLeaseExpiry(id, near);
    const res = await planHeartbeat("hb-BLK");
    expect(((await res.json()) as { renewed: number }).renewed).toBe(0);
    expect(getTask(id)?.lease_expires_at).toBe(near);
  });
});

// Step 3B: the dashboard surfaces the plan task each instance has claimed on its
// board card. It joins board rows to tasks by owner_sid, so it needs every owned
// task across ALL projects in one read — /plan-inflight. Expired leases are swept
// first so a dead instance's task doesn't linger as "claimed". Asserts by specific
// task id (not counts) so leftovers from earlier blocks don't matter.
describe("plan step 3B — /plan-inflight (board card source)", () => {
  async function newProject(): Promise<string> {
    const p = await post("/project-create", { title: "P", by: "alice" }, ctx.joinToken);
    return ((await p.json()) as { project: { id: string } }).project.id;
  }
  async function readyTask(projectId: string, title = "T"): Promise<string> {
    const t = await post("/task-create", { project_id: projectId, title, by: "alice" }, ctx.joinToken);
    const id = ((await t.json()) as { task: { id: string } }).task.id;
    await post("/task-transition", { task_id: id, to: "ratified", actor: "alice" }, ctx.joinToken); // → ready
    return id;
  }
  function claim(id: string, owner: string, sid: string): Promise<Response> {
    return post("/task-claim", { task_id: id, owner, owner_sid: sid }, ctx.joinToken);
  }
  function transition(id: string, to: string, actor = "bob"): Promise<Response> {
    return post("/task-transition", { task_id: id, to, actor }, ctx.joinToken);
  }
  type Inflight = {
    now: number;
    tasks: Array<{
      id: string;
      project_id: string;
      title: string;
      status: string;
      owner_sid: string | null;
      lease_expires_at: number | null;
    }>;
  };

  it("is public and returns server now + a tasks array", async () => {
    const res = await get("/plan-inflight");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Inflight;
    expect(typeof body.now).toBe("number");
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it("surfaces owned tasks (claimed/in_progress) with owner_sid + lease; excludes ready and done", async () => {
    const p = await newProject();
    const claimed = await readyTask(p, "INF-claimed");
    const inprog = await readyTask(p, "INF-inprog");
    const stillReady = await readyTask(p, "INF-ready");
    const finished = await readyTask(p, "INF-done");
    await claim(claimed, "bob", "inf-A");
    await claim(inprog, "bob", "inf-A");
    await transition(inprog, "in_progress");
    await claim(finished, "bob", "inf-A");
    await transition(finished, "in_progress");
    await transition(finished, "review");
    await transition(finished, "done", "alice"); // non-owner merge (no self-merge)

    const body = (await (await get("/plan-inflight")).json()) as Inflight;
    const byId = new Map(body.tasks.map((t) => [t.id, t]));
    expect(byId.get(claimed)?.owner_sid).toBe("inf-A");
    expect(byId.get(claimed)?.title).toBe("INF-claimed");
    expect(typeof byId.get(claimed)?.lease_expires_at).toBe("number");
    expect(byId.has(inprog)).toBe(true);
    expect(byId.has(stillReady)).toBe(false); // ready = not yet owned
    expect(byId.has(finished)).toBe(false); // done = terminal
  });

  it("sweeps an expired lease so the dead instance's task drops out", async () => {
    const p = await newProject();
    const id = await readyTask(p, "INF-expired");
    await claim(id, "bob", "inf-EXP");
    setLeaseExpiry(id, Date.now() - 1000);
    const body = (await (await get("/plan-inflight")).json()) as Inflight;
    expect(body.tasks.some((t) => t.id === id)).toBe(false);
  });
});

// D2: PRAGMA foreign_keys=ON + FK clauses on all plan tables. The DB layer must
// reject referential violations even if the application layer never reaches the
// INSERT — tests the constraint itself, not the router.
describe("D2 — foreign-key enforcement on plan tables", () => {
  it("rejects a dangling dep at DB write time (task_dep.task_id → task)", () => {
    // Both task ids are fabricated and absent from the task table.
    // With foreign_keys=ON the insert must throw a constraint error.
    expect(() => addDep("task_dangling_src", "task_dangling_dst")).toThrow(/FOREIGN KEY/i);
  });
});
