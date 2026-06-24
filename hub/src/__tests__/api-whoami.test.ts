import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// GET /whoami is the rewake resolver: it maps a Claude session id (sid) -> the
// session's CURRENT callsign from the registry row, so the Stop hooks no longer
// trust the static /tmp/wt-callsign file (which goes stale on an identity rename).
// These tests pin: (1) the resolver itself, (2) that it is NO-auth like /users, and
// (3) that the callsign is restamped on every identity op the hooks must follow —
// fleet_join (/register) and become_referee (/admin-register). claim_referee's
// /claim-referee endpoint lives on the referee-claim branch and stamps the same way
// (verified there); the tabtitle hook + this resolver already cover its tool name.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

async function sessionRegister(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ctx.baseUrl}/session-register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
    body: JSON.stringify(body),
  });
}

async function register(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ctx.baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
    body: JSON.stringify(body),
  });
}

async function adminRegister(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ctx.baseUrl}/admin-register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
    body: JSON.stringify(body),
  });
}

// No Authorization header on purpose — /whoami must be reachable by the hooks with
// zero token plumbing, exactly like /users.
async function whoamiName(sid: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/whoami?sid=${encodeURIComponent(sid)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { name: string }).name;
}

describe("GET /whoami (rewake sid->callsign resolver)", () => {
  it("returns the registry callsign for a known sid, no auth required", async () => {
    await sessionRegister({ session_id: "who-A", callsign: "linux-aaaa", node: "linux", workdir: "/a" });
    expect(await whoamiName("who-A")).toBe("linux-aaaa");
  });

  it("400s when sid is missing", async () => {
    const res = await fetch(`${ctx.baseUrl}/whoami`);
    expect(res.status).toBe(400);
  });

  it("404s for an unknown sid", async () => {
    const res = await fetch(`${ctx.baseUrl}/whoami?sid=who-nonexistent`);
    expect(res.status).toBe(404);
  });

  it("follows an identity rename: join then become_referee both restamp the row", async () => {
    // SessionStart self-registers with a COMPUTED cwd-derived callsign.
    await sessionRegister({ session_id: "who-B", callsign: "linux-bbbb", node: "linux", workdir: "/b" });
    expect(await whoamiName("who-B")).toBe("linux-bbbb");

    // fleet_join carries the sid -> /register stamps the CONFIRMED join name NOW
    // (authoritative immediately, not only after the first board-update).
    expect((await register({ name: "linux-coord", sid: "who-B" })).status).toBe(200);
    expect(await whoamiName("who-B")).toBe("linux-coord");

    // become_referee (admin path) renames again -> /whoami follows to REFEREE.
    expect((await adminRegister({ name: "REFEREE", oldName: "linux-coord", sid: "who-B" })).status).toBe(200);
    expect(await whoamiName("who-B")).toBe("REFEREE");
  });

  it("join-stamp is a no-op when no registry row exists yet for the sid", async () => {
    // A join whose sid has no SessionStart row cannot stamp a nonexistent row, so
    // /whoami stays 404 until a row is created (session-register / board-update). The
    // rewake hook then falls back to the static file, so waking still works.
    expect((await register({ name: "linux-cccc", sid: "who-C" })).status).toBe(200);
    const res = await fetch(`${ctx.baseUrl}/whoami?sid=who-C`);
    expect(res.status).toBe(404);
  });
});
