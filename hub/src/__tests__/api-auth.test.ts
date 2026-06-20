import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("authentication", () => {
  it("should reject /register without join token", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject /send without user token", async () => {
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "@all", content: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject /kick without admin token", async () => {
    const res = await fetch(`${ctx.baseUrl}/kick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(res.status).toBe(401);
  });

  it("should reject wrong method on /register", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ctx.joinToken}` },
    });
    expect(res.status).toBe(405);
  });

  it("should reject wrong method on /send", async () => {
    const res = await fetch(`${ctx.baseUrl}/send`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
  });

  it("should reject wrong method on /kick", async () => {
    const res = await fetch(`${ctx.baseUrl}/kick`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
  });

  it("should return 404 for unknown paths", async () => {
    const res = await fetch(`${ctx.baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  it("should allow public access to /users", async () => {
    const res = await fetch(`${ctx.baseUrl}/users`);
    expect(res.status).toBe(200);
  });

  it("should allow public access to /channels", async () => {
    const res = await fetch(`${ctx.baseUrl}/channels`);
    expect(res.status).toBe(200);
  });

  it("should reject /register with reserved name 'operator'", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "operator" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/reserved/);
  });

  it("should reject /register with reserved name 'operator'", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "operator" }),
    });
    expect(res.status).toBe(403);
  });

  it("should reject /register with reserved name 'referee'", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "referee" }),
    });
    expect(res.status).toBe(403);
  });

  it("should reject /register with case-variant of reserved name ('OPERATOR', 'Operator', ' referee ')", async () => {
    for (const name of ["OPERATOR", "Operator", " referee "]) {
      const res = await fetch(`${ctx.baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
        body: JSON.stringify({ name }),
      });
      expect(res.status).toBe(403);
    }
  });

  it("join-token /send cannot forge principal:true — body principal field is ignored", async () => {
    const senderToken = await registerUser(ctx, "spoof-sender");
    const recvReg = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "spoof-recv" }),
    });
    const { token: recvToken } = (await recvReg.json()) as { token: string };

    // Attempt to inject principal:true via the join-token /send path
    await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ to: "spoof-recv", content: "spoofed", principal: true }),
    });

    const inboxRes = await fetch(`${ctx.baseUrl}/inbox`, {
      headers: { Authorization: `Bearer ${recvToken}` },
    });
    expect(inboxRes.status).toBe(200);
    const inbox = (await inboxRes.json()) as { messages: Array<{ principal?: boolean }> };
    expect(inbox.messages.length).toBeGreaterThan(0);
    for (const m of inbox.messages) {
      expect(m.principal).toBeFalsy();
    }
  });

  it("admin-send messages carry principal:true in recipient inbox", async () => {
    // Register recipient via join-token path
    const regRes = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "auth-inbox-recv" }),
    });
    const { token } = (await regRes.json()) as { token: string };

    // Send via admin-token path
    await fetch(`${ctx.baseUrl}/admin-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ to: "auth-inbox-recv", content: "operator says go" }),
    });

    // Fetch inbox and verify principal flag
    const inboxRes = await fetch(`${ctx.baseUrl}/inbox`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(inboxRes.status).toBe(200);
    const inbox = (await inboxRes.json()) as { messages: Array<{ from: string; principal?: boolean }> };
    const msg = inbox.messages.find((m) => m.from === "operator");
    expect(msg?.principal).toBe(true);
  });
});
