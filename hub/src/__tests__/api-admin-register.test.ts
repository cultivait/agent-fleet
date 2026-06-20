import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// REFEREE: tests for the admin-gated /admin-register endpoint and the principal
// stamping it enables. The shared test server persists state across tests in this
// file, so each test uses unique callsigns to stay independent.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

function adminHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` };
}

async function adminRegister(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ctx.baseUrl}/admin-register`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
}

describe("POST /admin-register", () => {
  it("rejects without admin token (401)", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ar-noauth" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects with a wrong admin token (401)", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-admin-token" },
      body: JSON.stringify({ name: "ar-wrongauth" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects missing name (400)", async () => {
    const res = await adminRegister({});
    expect(res.status).toBe(400);
  });

  it("bypasses the reserved-name block with the admin token (registers 'referee')", async () => {
    // Sanity: the join-token path refuses this exact name.
    const joinRes = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "referee" }),
    });
    expect(joinRes.status).toBe(403);

    // The admin path succeeds for the same reserved name.
    const res = await adminRegister({ name: "referee" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("referee");
    expect(body.token).toBeTruthy();

    // It appears in the users list.
    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const usersBody = (await usersRes.json()) as { users: { name: string }[] };
    expect(usersBody.users.map((u) => u.name)).toContain("referee");
  });

  it("registers a reserved 'REFEREE' callsign (case-variant) via admin path", async () => {
    const res = await adminRegister({ name: "REFEREE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("REFEREE");
  });

  it("kicks oldName when provided, shedding the auto-joined callsign", async () => {
    // Agent auto-joins under a normal callsign first.
    await registerUser(ctx, "ar-oldcall");
    // Promote: rename ar-oldcall -> ar-newref.
    const res = await adminRegister({ name: "ar-newref", oldName: "ar-oldcall" });
    expect(res.status).toBe(200);

    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const names = ((await usersRes.json()) as { users: { name: string }[] }).users.map((u) => u.name);
    expect(names).toContain("ar-newref");
    expect(names).not.toContain("ar-oldcall");
  });

  it("a /send from a principal user (set via admin-register) stamps principal:true", async () => {
    // Register a recipient on the normal join path.
    const recvRes = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "ar-princ-recv" }),
    });
    const { token: recvToken } = (await recvRes.json()) as { token: string };

    // Admin-register a principal sender; principal:true requested explicitly.
    const senderRes = await adminRegister({ name: "ar-princ-sender", principal: true });
    expect(senderRes.status).toBe(200);
    const { token: senderToken } = (await senderRes.json()) as { token: string };

    // The principal user sends a normal /send (its OWN user token, NOT the admin token).
    const sendRes = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ to: "ar-princ-recv", content: "principal go" }),
    });
    expect(sendRes.status).toBe(200);

    const inboxRes = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${recvToken}` } });
    const inbox = (await inboxRes.json()) as { messages: Array<{ from: string; principal?: boolean }> };
    const msg = inbox.messages.find((m) => m.from === "ar-princ-sender");
    expect(msg?.principal).toBe(true);
  });

  it("a reserved-name admin-register is principal by default (no explicit flag) and stamps principal on /send", async () => {
    const recvRes = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "ar-resv-recv" }),
    });
    const { token: recvToken } = (await recvRes.json()) as { token: string };

    // No principal flag — but "operator" is a reserved identity, so it's principal.
    const senderRes = await adminRegister({ name: "operator" });
    expect(senderRes.status).toBe(200);
    const { token: senderToken } = (await senderRes.json()) as { token: string };

    const sendRes = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ to: "ar-resv-recv", content: "operator go" }),
    });
    expect(sendRes.status).toBe(200);

    const inboxRes = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${recvToken}` } });
    const inbox = (await inboxRes.json()) as { messages: Array<{ from: string; principal?: boolean }> };
    const msg = inbox.messages.find((m) => m.from === "operator");
    expect(msg?.principal).toBe(true);
  });

  it("FORGERY GUARD: a normal join-token user's /send never carries principal, even with body principal:true", async () => {
    const recvRes = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "ar-forge-recv" }),
    });
    const { token: recvToken } = (await recvRes.json()) as { token: string };

    const senderToken = await registerUser(ctx, "ar-forge-sender");

    // Try to forge principal via the body — must be ignored (server reads ONLY the
    // user record, which for a join-token user has isPrincipal=false).
    const sendRes = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ to: "ar-forge-recv", content: "forged", principal: true }),
    });
    expect(sendRes.status).toBe(200);

    const inboxRes = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${recvToken}` } });
    const inbox = (await inboxRes.json()) as { messages: Array<{ from: string; principal?: boolean }> };
    const msg = inbox.messages.find((m) => m.from === "ar-forge-sender");
    expect(msg).toBeTruthy();
    expect(msg?.principal).toBeFalsy();
  });

  it("a normal join-token user does NOT become principal even if they share a non-reserved name promoted earlier", async () => {
    // ar-newref was admin-registered above WITHOUT principal:true and is not a
    // reserved name, so it must NOT be a principal. Verify its /send is unstamped.
    const recvRes = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "ar-nonprinc-recv" }),
    });
    const { token: recvToken } = (await recvRes.json()) as { token: string };

    // Fetch ar-newref's token by re-admin-registering it (idempotent path) WITHOUT principal.
    const reRes = await adminRegister({ name: "ar-newref" });
    expect(reRes.status).toBe(200);
    const { token: newrefToken } = (await reRes.json()) as { token: string };

    const sendRes = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${newrefToken}` },
      body: JSON.stringify({ to: "ar-nonprinc-recv", content: "not principal" }),
    });
    expect(sendRes.status).toBe(200);

    const inboxRes = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${recvToken}` } });
    const inbox = (await inboxRes.json()) as { messages: Array<{ from: string; principal?: boolean }> };
    const msg = inbox.messages.find((m) => m.from === "ar-newref");
    expect(msg?.principal).toBeFalsy();
  });
});
