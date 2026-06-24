import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("POST /register", () => {
  it("should register a new user and return a token", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-alice" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("reg-alice");
    expect(body.token).toBeTruthy();
  });

  it("re-registers an existing callsign as a takeover (newest claimant wins, no 409 wall)", async () => {
    const first = await registerUser(ctx, "reg-dup");
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-dup" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("reg-dup");
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(first); // a fresh token is minted; the old slot is shed
    // exactly one "reg-dup" on the roster — took over the slot, not duplicated
    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const users = (await usersRes.json()) as { users: { name: string }[] };
    expect(users.users.filter((u) => u.name === "reg-dup")).toHaveLength(1);
  });

  it("should allow reconnect with old token", async () => {
    const token = await registerUser(ctx, "reg-reconnect");
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-reconnect", oldToken: token }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("reg-reconnect");
    // New token should be different
    expect(body.token).toBeTruthy();
  });

  it("re-binds on a missing/wrong old token (reclaim without /kick) and invalidates the old token", async () => {
    const oldToken = await registerUser(ctx, "reg-wrongtoken");
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({ name: "reg-wrongtoken", oldToken: "wrong" }),
    });
    expect(res.status).toBe(200); // takeover, not the old 409 wall
    const body = (await res.json()) as { token: string };
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(oldToken);
    // the shed old token no longer authenticates
    const inbox = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${oldToken}` } });
    expect(inbox.status).toBe(401);
  });

  it("should reject missing name", async () => {
    const res = await fetch(`${ctx.baseUrl}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.joinToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /unregister", () => {
  it("should unregister an authenticated user", async () => {
    const token = await registerUser(ctx, "reg-unreg");
    const res = await fetch(`${ctx.baseUrl}/unregister`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    // Should no longer appear in users list
    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const usersBody = (await usersRes.json()) as { users: { name: string }[] };
    expect(usersBody.users.map((u) => u.name)).not.toContain("reg-unreg");
  });

  it("should reject unregister without token", async () => {
    const res = await fetch(`${ctx.baseUrl}/unregister`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});
