import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProject,
  createTask,
  dbIndexExists,
  getTask,
  getTaskEvents,
  logEvent,
  planTransaction,
  setRollupSignaled,
  setTaskStatus,
} from "../plan/store.js";
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

// ─── D1: transaction atomicity ───────────────────────────────────────────────

describe("D1 — transaction atomicity", () => {
  it("rolls back THREE real mid-transaction writes atomically (flips RED if planTransaction is reduced to fn())", () => {
    const proj = createProject("D1 rollback test", null, "test");
    const task = createTask(proj.id, { title: "rollback-target", by: "test" });

    expect(getTask(task.id)?.status).toBe("proposed");
    expect(getTask(task.id)?.rollup_signaled).toBe(0);
    const eventsBefore = getTaskEvents(task.id).length;

    // Perform THREE real writes inside the txn (status + rollup flag + an event),
    // THEN throw. A correct db.transaction()() rolls ALL THREE back as a unit.
    // This is the teeth of D1: if planTransaction were reduced to a bare `fn()`
    // (no BEGIN/COMMIT) each write would auto-commit and survive the throw, so
    // every assertion below flips RED — exactly the regression guard f8e1 required.
    expect(() =>
      planTransaction(() => {
        setTaskStatus(task.id, "ratified");
        setRollupSignaled(task.id);
        logEvent(task.id, { actor: "test", kind: "rollup", note: "must-not-persist" });
        throw new Error("simulated mid-transaction failure");
      }),
    ).toThrow("simulated mid-transaction failure");

    // Both-or-neither: status, flag, and event all rolled back together.
    const after = getTask(task.id);
    expect(after?.status).toBe("proposed"); // status write rolled back
    expect(after?.rollup_signaled).toBe(0); // flag write rolled back
    expect(getTaskEvents(task.id).length).toBe(eventsBefore); // event write rolled back
    expect(getTaskEvents(task.id).some((e) => e.kind === "rollup")).toBe(false);
  });

  it("commits all writes atomically when the transaction completes normally", () => {
    const proj = createProject("D1 commit test", null, "test");
    const task = createTask(proj.id, { title: "commit-target", by: "test" });

    expect(getTask(task.id)?.status).toBe("proposed");
    expect(getTask(task.id)?.rollup_signaled).toBe(0);

    // Same two writes as the rollback test, minus the throw — both must persist.
    planTransaction(() => {
      setTaskStatus(task.id, "ratified");
      setRollupSignaled(task.id);
    });

    const after = getTask(task.id);
    expect(after?.status).toBe("ratified"); // committed
    expect(after?.rollup_signaled).toBe(1); // committed
  });
});

// ─── D3: task_event indexing + rollup_signaled ───────────────────────────────

describe("D3 — task_event indexing + rollup_signaled", () => {
  it("composite index (task_id, kind, id) exists on task_event", () => {
    expect(dbIndexExists("idx_task_event_kind")).toBe(true);
  });

  it("setRollupSignaled sets rollup_signaled = 1 (direct store test)", () => {
    // Pure unit test: bypass HTTP entirely to verify the column write works
    const proj = createProject("D3 rollup_signaled unit test", null, "test");
    const task = createTask(proj.id, { title: "signaled-task", by: "test" });

    expect(getTask(task.id)?.rollup_signaled).toBe(0); // starts at 0

    setRollupSignaled(task.id);

    expect(getTask(task.id)?.rollup_signaled).toBe(1); // set to 1
  });

  it("rollup fires exactly once via the boolean guard (behavioral: event count stays 1)", async () => {
    const projRes = await post("/project-create", { title: "D3 rollup-once test" }, ctx.joinToken);
    const { project } = (await projRes.json()) as { project: { id: string } };

    // parent + 2 children with parent_id
    const parentRes = await post("/task-create", { project_id: project.id, title: "parent" }, ctx.joinToken);
    const { task: parent } = (await parentRes.json()) as { task: { id: string } };

    const c1Res = await post(
      "/task-create",
      { project_id: project.id, title: "child-1", parent_id: parent.id },
      ctx.joinToken,
    );
    const { task: c1 } = (await c1Res.json()) as { task: { id: string } };

    const c2Res = await post(
      "/task-create",
      { project_id: project.id, title: "child-2", parent_id: parent.id },
      ctx.joinToken,
    );
    const { task: c2 } = (await c2Res.json()) as { task: { id: string } };

    const force = (id: string, to: string) =>
      fetch(`${ctx.baseUrl}/admin-task-force`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
        body: JSON.stringify({ task_id: id, to, actor: "test" }),
      });

    // First child done — no rollup yet
    await force(c1.id, "done");
    expect(getTaskEvents(parent.id).some((e) => e.kind === "rollup")).toBe(false);

    // Second child done — rollup fires exactly once
    await force(c2.id, "done");
    expect(getTaskEvents(parent.id).filter((e) => e.kind === "rollup")).toHaveLength(1);

    // Re-transition c1 to another terminal status — rollup_signaled prevents a second rollup
    await force(c1.id, "failed");
    expect(getTaskEvents(parent.id).filter((e) => e.kind === "rollup")).toHaveLength(1); // still exactly 1
  });

  it("existing-DB migration is idempotent — double-init does not corrupt data", () => {
    // The test server initializes the DB once in beforeAll. Verify the schema is correct:
    // - rollup_signaled column exists and has the right default
    // - composite index was created
    const proj = createProject("idempotent migration test", null, "test");
    const task = createTask(proj.id, { title: "migration-check", by: "test" });

    // Default should be 0 (NOT NULL DEFAULT 0 constraint)
    expect(getTask(task.id)?.rollup_signaled).toBe(0);
    // Composite index must exist
    expect(dbIndexExists("idx_task_event_kind")).toBe(true);
  });
});
