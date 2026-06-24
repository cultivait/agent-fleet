import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// T5 (hub-side): a re-register that is a CLEAN RECONNECT (oldToken matches the live
// token — e.g. an MCP process restart replaying its persisted token) must PRESERVE the
// recipient's pending message queue. A TAKEOVER (missing/wrong oldToken) still drains it.
// Before the fix, handleRegister called removeQueue() unconditionally, so every forced
// re-auth silently dropped in-flight messages (the message-loss half of the bug).

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

/** Enqueue one directed message for `recv` (who is not polling, so it queues). */
async function enqueueFor(senderToken: string, recv: string, content: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
    body: JSON.stringify({ to: recv, content, channel: "#all" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function reregister(name: string, oldToken: string | undefined): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
    body: JSON.stringify(oldToken === undefined ? { name } : { name, oldToken }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function inboxIds(token: string): Promise<string[]> {
  const res = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: Array<{ id: string }> }).messages.map((m) => m.id);
}

describe("POST /register — T5 queue preservation on clean reconnect", () => {
  it("clean reconnect (matching oldToken) PRESERVES the pending queue", async () => {
    const recvToken = await registerUser(ctx, "qp-recv");
    const senderToken = await registerUser(ctx, "qp-sender");
    const msgId = await enqueueFor(senderToken, "qp-recv", "keep-me");

    // MCP restart replays its persisted token as oldToken → clean reconnect.
    const newToken = await reregister("qp-recv", recvToken);
    expect(newToken).not.toBe(recvToken); // fresh token still minted

    const ids = await inboxIds(newToken);
    expect(ids).toContain(msgId); // queue survived the re-auth
  });

  it("takeover (wrong oldToken) still DRAINS the pending queue", async () => {
    const recvToken = await registerUser(ctx, "qp-recv2");
    const senderToken = await registerUser(ctx, "qp-sender2");
    const msgId = await enqueueFor(senderToken, "qp-recv2", "drop-me");

    const newToken = await reregister("qp-recv2", "wrong-token");
    expect(newToken).not.toBe(recvToken);

    const ids = await inboxIds(newToken);
    expect(ids).not.toContain(msgId); // takeover sheds the old slot's queue
  });

  it("takeover (no oldToken) still DRAINS the pending queue", async () => {
    const senderToken = await registerUser(ctx, "qp-sender3");
    await registerUser(ctx, "qp-recv3");
    const msgId = await enqueueFor(senderToken, "qp-recv3", "drop-me-too");

    const newToken = await reregister("qp-recv3", undefined);
    const ids = await inboxIds(newToken);
    expect(ids).not.toContain(msgId);
  });
});
