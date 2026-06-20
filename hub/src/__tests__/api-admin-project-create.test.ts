import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// WS-? Cockpit "+ New Plan": an admin-bearer route so the operator can create a
// project (plan) straight from the cockpit, which only holds the admin token (the
// existing /project-create is join-token-authed and not reachable from the UI).

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

describe("cockpit backend — /admin-project-create", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await post("/admin-project-create", { title: "No auth plan" });
    expect(res.status).toBe(401);
  });

  it("rejects the join token (admin-bearer only) with 401", async () => {
    const res = await post("/admin-project-create", { title: "Wrong token plan" }, ctx.joinToken);
    expect(res.status).toBe(401);
  });

  it("rejects a missing/blank title with 400", async () => {
    const res = await post("/admin-project-create", { title: "   " }, ctx.adminToken);
    expect(res.status).toBe(400);
  });

  it("creates a project with the admin token and returns it with an id", async () => {
    const res = await post("/admin-project-create", { title: "Operator plan", brief: "via cockpit" }, ctx.adminToken);
    expect(res.status).toBe(200);
    const { project } = await res.json();
    expect(project.id).toBeTruthy();
    expect(project.title).toBe("Operator plan");
    expect(project.brief).toBe("via cockpit");
  });

  it("makes the new project visible in the /plan-projects picker feed", async () => {
    const res = await post("/admin-project-create", { title: "Picker plan", by: "operator" }, ctx.adminToken);
    const pid = (await res.json()).project.id as string;
    const { projects } = await (await get("/plan-projects")).json();
    expect(projects.find((p: { id: string }) => p.id === pid)).toBeTruthy();
  });
});
