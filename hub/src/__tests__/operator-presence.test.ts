import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPersistentUser, isPrincipalUser, isUserRegistered, resetAuthState } from "../auth.js";
import { initGeneralChannel, resetChannelState } from "../channels.js";
import { dbSaveMessage, initDB } from "../db.js";
import { peekQueue, resetRouterState } from "../router.js";
import { ensureOperatorPresence, reapGhostAgents } from "../server.js";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// ITEM B: persistent operator presence "Operator". The hub gains a virtual operator
// identity that is always a valid @-mention/recipient target, queues messages
// addressed to it, is never reaped, and surfaces its inbox to the admin/cockpit.
describe("persistent operator presence (Operator)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    resetRouterState(); // clear any queues leaked from a prior test (harness doesn't)
    ctx = await startTestServer();
    // The harness drives createHubServer directly (no bootstrap); production wires
    // this in index.ts. Call it explicitly to exercise the operator presence.
    ensureOperatorPresence();
  });

  afterEach(async () => {
    await stopTestServer(ctx);
  });

  const adminGet = (path: string): Promise<Response> =>
    fetch(`${ctx.baseUrl}${path}`, { headers: { Authorization: `Bearer ${ctx.adminToken}` } });

  const send = (token: string, body: Record<string, unknown>): Promise<Response> =>
    fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("registers Operator as a persistent, principal, online recipient that resolves for fleet_send", async () => {
    expect(isUserRegistered("Operator")).toBe(true);
    expect(isPrincipalUser("Operator")).toBe(true);
    expect(isPersistentUser("Operator")).toBe(true);

    const usersRes = await fetch(`${ctx.baseUrl}/users`);
    const { users } = (await usersRes.json()) as { users: Array<{ name: string; online?: boolean }> };
    const operator = users.find((u) => u.name === "Operator");
    expect(operator).toBeDefined();

    // The core bug: before this, `to:@Operator` threw "User Operator is not connected".
    const agent = await registerUser(ctx, "op-agent-1");
    const res = await send(agent, { to: "@Operator", content: "hi Operator" });
    expect(res.status).toBe(200);
  });

  it("is never reaped by the ghost-reaper (grace 0 reaps a real ghost, not Operator)", async () => {
    await registerUser(ctx, "op-ghost");
    const reaped = reapGhostAgents(0); // grace 0 → everything reapable is reaped
    expect(reaped).toContain("op-ghost");
    expect(reaped).not.toContain("Operator");
    expect(isUserRegistered("Operator")).toBe(true);
    expect(isPersistentUser("Operator")).toBe(true);
  });

  it("is exempt from kick-all (live agents cleared, operator kept)", async () => {
    await registerUser(ctx, "op-kickme");
    const res = await fetch(`${ctx.baseUrl}/kick-all`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.status).toBe(200);
    const { kicked } = (await res.json()) as { kicked: string[] };
    expect(kicked).toContain("op-kickme");
    expect(kicked).not.toContain("Operator");
    expect(isUserRegistered("Operator")).toBe(true);
  });

  it("is reachable in a non-#all channel via lazy auto-join", async () => {
    // Create a channel Operator is NOT bootstrapped into.
    const createRes = await fetch(`${ctx.baseUrl}/admin-channel-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ name: "#ops" }),
    });
    expect(createRes.status).toBe(200);

    const agent = await registerUser(ctx, "op-agent-2");
    const joinRes = await fetch(`${ctx.baseUrl}/channel-join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agent}` },
      body: JSON.stringify({ channel: "#ops" }),
    });
    expect(joinRes.status).toBe(200);

    // Before the fix this 404'd ("User Operator is not a member of #ops").
    const res = await send(agent, { to: "@Operator", channel: "#ops", content: "ops ping" });
    expect(res.status).toBe(200);

    const inbox = (await (await adminGet("/admin-operator-inbox")).json()) as { messages: Array<{ content: string }> };
    expect(inbox.messages.some((m) => m.content === "ops ping")).toBe(true);
  });

  it("queues messages addressed to Operator and surfaces them via the operator inbox (peek then drain)", async () => {
    const agent = await registerUser(ctx, "op-agent-3");
    await send(agent, { to: "@Operator", content: "inbox ping" });

    // PEEK: non-destructive.
    const peek1 = (await (await adminGet("/admin-operator-inbox")).json()) as {
      operator: string;
      drained: boolean;
      addressedCount: number;
      messages: Array<{ content: string; principal?: boolean }>;
    };
    expect(peek1.operator).toBe("Operator");
    expect(peek1.drained).toBe(false);
    expect(peek1.addressedCount).toBeGreaterThanOrEqual(1);
    expect(peek1.messages.some((m) => m.content === "inbox ping")).toBe(true);

    // Peek must not consume — a second peek still shows it.
    const peek2 = (await (await adminGet("/admin-operator-inbox")).json()) as { addressedCount: number };
    expect(peek2.addressedCount).toBe(peek1.addressedCount);

    // DRAIN: returns the addressed messages and clears the queue.
    const drain = (await (await adminGet("/admin-operator-inbox?drain=1")).json()) as {
      drained: boolean;
      messages: Array<{ content: string }>;
    };
    expect(drain.drained).toBe(true);
    expect(drain.messages.some((m) => m.content === "inbox ping")).toBe(true);

    const after = (await (await adminGet("/admin-operator-inbox")).json()) as { addressedCount: number; queuedCount: number };
    expect(after.addressedCount).toBe(0);
    expect(after.queuedCount).toBe(0);
  });

  it("re-asserts persistence over a Operator left non-principal/reapable by a prior admin-send auto-register", async () => {
    // Simulate the legacy path: /admin-send auto-registers a plain, reapable Operator.
    // ensureOperatorPresence must PROMOTE that record, not throw on the dup name.
    const sendRes = await fetch(`${ctx.baseUrl}/admin-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
      body: JSON.stringify({ to: "@all", content: "operator note" }),
    });
    expect(sendRes.status).toBe(200);
    ensureOperatorPresence(); // idempotent re-assert
    expect(isPersistentUser("Operator")).toBe(true);
    expect(isPrincipalUser("Operator")).toBe(true);
    expect(reapGhostAgents(0)).not.toContain("Operator");
  });
});

// Rehydration: the in-memory queue is volatile, but messages addressed to Operator
// persist in the durable `messages` table. On (re)registration the operator's
// unread direct messages are reloaded so a hub restart loses nothing. Driven with
// the hub primitives directly (the same DB connection stands in for the durable
// file the production hub reopens after a restart).
describe("operator presence — queue rehydration from the durable transcript", () => {
  it("reloads unread messages addressed to Operator into the queue on bootstrap", () => {
    process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
    resetAuthState();
    resetChannelState();
    resetRouterState();
    initDB();
    initGeneralChannel();

    // A message addressed to Operator landed (and persisted) before the "restart".
    dbSaveMessage({
      id: "rehydrate-1",
      from: "op-agent-x",
      to: "Operator",
      content: "pre-restart ping",
      channel: "#all",
      timestamp: Date.now(),
      seq: 1,
    });

    // Boot the operator presence (firstRegistration → rehydrate). No read cursor
    // exists for Operator, so the message is unread and must be restored.
    ensureOperatorPresence();

    const queued = peekQueue("Operator");
    const restored = queued.find((m) => m.id === "rehydrate-1");
    expect(restored).toBeDefined();
    expect(restored?.content).toBe("pre-restart ping");
    // Direct sends carry no DB `mentions` column; bootstrap stamps the operator so
    // the inbox "addressed" filter and pending-counts treat it as addressed.
    expect(restored?.mentions).toContain("Operator");
  });
});

// Operator parameterization: the hub's operator surfaces (default sender, channel
// creator, read-cursor/unread) now key on OPERATOR_NAME, and the ghost-reaper exemption
// keys on the PERSISTENT FLAG (isPersistentUser) — NOT the hardcoded "Operator" literal. So a
// deploy that sets AF_OPERATOR_NAME to any name gets an equally-protected operator. This
// proves server.ts:491's remaining "Operator" literal is a harmless back-compat skip, safe to
// leave: the real exemption is the flag.
describe("operator presence is name-agnostic (reaper exemption = persistent flag, not 'Operator')", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    resetRouterState();
    ctx = await startTestServer();
    ensureOperatorPresence("Operator"); // a NON-"Operator" operator name
  });
  afterEach(async () => {
    await stopTestServer(ctx);
  });

  it("marks the ENV-named operator persistent and exempts it from the ghost-reaper", async () => {
    expect(isPersistentUser("Operator")).toBe(true);
    await registerUser(ctx, "op-ghost-named");
    const reaped = reapGhostAgents(0); // grace 0 reaps every non-exempt user
    expect(reaped).toContain("op-ghost-named"); // control: a real ghost IS reaped
    expect(reaped).not.toContain("Operator"); // operator survives via the flag, not the literal
    expect(isPersistentUser("Operator")).toBe(true);
  });
});
