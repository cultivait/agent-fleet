import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}
const get = (path: string): Promise<Response> => fetch(`${ctx.baseUrl}${path}`);

async function makeProjectWithTasks(n: number): Promise<string> {
  const pres = await post("/project-create", { title: "Cockpit test", by: "tester" }, ctx.joinToken);
  const pid = (await pres.json()).project.id as string;
  for (let i = 0; i < n; i++) {
    await post("/task-create", { project_id: pid, title: `task ${i}`, by: "tester" }, ctx.joinToken);
  }
  return pid;
}

describe("cockpit backend — /plan-board now", () => {
  it("includes a server clock `now` for lease math", async () => {
    const pid = await makeProjectWithTasks(1);
    const board = await (await get(`/plan-board?project_id=${pid}`)).json();
    expect(typeof board.now).toBe("number");
    expect(Math.abs(board.now - Date.now())).toBeLessThan(5000);
  });
});

describe("cockpit backend — /plan-projects", () => {
  it("lists projects (newest first) with a task count for the picker", async () => {
    const pid = await makeProjectWithTasks(3);
    const res = await get("/plan-projects");
    expect(res.status).toBe(200);
    const { projects } = await res.json();
    expect(Array.isArray(projects)).toBe(true);
    const mine = projects.find((p: { id: string }) => p.id === pid);
    expect(mine).toBeTruthy();
    expect(mine.taskCount).toBe(3);
    // newest-first: our just-created project should sort at/near the front.
    expect(projects[0].created_at).toBeGreaterThanOrEqual(projects[projects.length - 1].created_at);
  });
});

describe("cockpit backend — /plan-events backfill", () => {
  it("requires a project_id", async () => {
    expect((await get("/plan-events")).status).toBe(400);
  });

  it("returns an empty feed (200) for an unknown project, never 404", async () => {
    const res = await get("/plan-events?project_id=proj_does_not_exist");
    expect(res.status).toBe(200);
    expect((await res.json()).events).toEqual([]);
  });

  it("returns events in chronological (ascending) order", async () => {
    const pid = await makeProjectWithTasks(4);
    const { events } = await (await get(`/plan-events?project_id=${pid}`)).json();
    expect(events.length).toBeGreaterThanOrEqual(4);
    const ids = events.map((e: { id: number }) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("caps to the limit keeping the MOST RECENT events (not the oldest-N)", async () => {
    const pid = await makeProjectWithTasks(5);
    const all = (await (await get(`/plan-events?project_id=${pid}&limit=100`)).json()).events;
    const small = (await (await get(`/plan-events?project_id=${pid}&limit=3`)).json()).events;
    expect(small).toHaveLength(3);
    // the capped window is the TAIL (most recent) of the full chronological list
    expect(small.map((e: { id: number }) => e.id)).toEqual(all.slice(-3).map((e: { id: number }) => e.id));
  });
});
