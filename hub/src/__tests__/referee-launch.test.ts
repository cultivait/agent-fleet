import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbConsumeRefereeSpec, dbCreateRefereeSpec, dbGetPendingRefereeSpec } from "../db.js";
import { createLoop } from "../loops/store.js";
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
async function registerPrincipal(name: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/admin-register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
    body: JSON.stringify({ name, principal: true }),
  });
  return ((await res.json()) as { token: string }).token;
}
function specGet(token: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}/referee-spec`, { headers: { Authorization: `Bearer ${token}` } });
}

describe("referee launch spec (item 3) — store", () => {
  it("createRefereeSpec is the latest pending; consume is one-shot", () => {
    const a = dbCreateRefereeSpec("#all", 2, null);
    expect(dbGetPendingRefereeSpec()?.id).toBe(a.id);
    const claimed = dbConsumeRefereeSpec("REFEREE");
    expect(claimed?.id).toBe(a.id);
    expect(claimed?.consumed_by).toBe("REFEREE");
    // consumed → no longer pending, second consume is empty
    expect(dbGetPendingRefereeSpec()).toBeUndefined();
    expect(dbConsumeRefereeSpec("REFEREE")).toBeUndefined();
  });
});

describe("referee launch spec (item 3) — read-back endpoint", () => {
  it("GET /referee-spec: principal reads + consumes (one-shot); plain member → 403", async () => {
    dbCreateRefereeSpec("#all", 1, "loop_demo");
    // a plain member cannot read a launch spec
    const member = await registerUser(ctx, "spec-member");
    expect((await specGet(member)).status).toBe(403);
    // a principal (referee) reads it
    const ref = await registerPrincipal("spec-ref");
    const r1 = (await (await specGet(ref)).json()) as { spec: { channel: string; loop_id: string | null } | null };
    expect(r1.spec?.channel).toBe("#all");
    expect(r1.spec?.loop_id).toBe("loop_demo");
    // consumed — a second read returns null
    const r2 = (await (await specGet(ref)).json()) as { spec: unknown };
    expect(r2.spec).toBeNull();
  });
});

describe("referee launch (item 3) — dialog submit validation (pre-spawn)", () => {
  it("missing channel → 400", async () => {
    expect((await adminPost("/admin-referee-launch", { builder_count: 1 })).status).toBe(400);
  });
  it("unknown channel → 404", async () => {
    expect((await adminPost("/admin-referee-launch", { channel: "#nope", builder_count: 0 })).status).toBe(404);
  });
  it("negative builder_count → 400", async () => {
    expect((await adminPost("/admin-referee-launch", { channel: "#all", builder_count: -1 })).status).toBe(400);
  });
  it("a non-draft loop → 409", async () => {
    const running = createLoop({ kind: "generic", label: "already running", owner_callsign: "someone" });
    const res = await adminPost("/admin-referee-launch", { channel: "#all", builder_count: 0, loop_id: running.id });
    expect(res.status).toBe(409);
  });
  it("requires the admin token (join token → 401)", async () => {
    const res = await adminPost("/admin-referee-launch", { channel: "#all", builder_count: 0 }, ctx.joinToken);
    expect(res.status).toBe(401);
  });
});
