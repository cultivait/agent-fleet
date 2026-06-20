import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("C1: per-channel seq monotonicity", () => {
  it("messages carry monotonically increasing seq within a channel", async () => {
    const senderToken = await registerUser(ctx, "seq-sender");
    await registerUser(ctx, "seq-recv");

    // Send 3 messages on #all
    const sentIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${ctx.baseUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
        body: JSON.stringify({ to: "seq-recv", content: `seq-message-${i}`, channel: "#all" }),
      });
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };
      sentIds.push(id);
    }

    // Drain inbox and verify seq on delivered messages
    const inboxRes = await fetch(`${ctx.baseUrl}/inbox`, {
      headers: {
        Authorization: `Bearer ${await registerUser(ctx, "seq-recv-drain")}`,
      },
    });
    // Use admin history instead — inbox is per-user, recv already has messages
    const histRes = await fetch(
      `${ctx.baseUrl}/admin-channel-history?channel=${encodeURIComponent("#all")}&limit=20`,
      { headers: { Authorization: `Bearer ${ctx.adminToken}` } },
    );
    expect(histRes.status).toBe(200);
    const hist = (await histRes.json()) as { messages: Array<{ id: string; seq?: number }> };

    // Find our 3 sent messages in history order
    const sentMessages = hist.messages.filter((m) => sentIds.includes(m.id));
    expect(sentMessages).toHaveLength(3);

    // All must have seq defined and be strictly increasing
    for (const m of sentMessages) {
      expect(typeof m.seq).toBe("number");
    }
    const seqs = sentMessages.map((m) => m.seq as number);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it("seq in inbox matches seq in history (in-memory queue carries seq)", async () => {
    const senderToken = await registerUser(ctx, "seq-inbox-sender");
    const recvToken = await registerUser(ctx, "seq-inbox-recv");

    const sendRes = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ to: "seq-inbox-recv", content: "inbox-seq-check", channel: "#all" }),
    });
    const { id: msgId } = (await sendRes.json()) as { id: string };

    // Drain inbox
    const inboxRes = await fetch(`${ctx.baseUrl}/inbox`, {
      headers: { Authorization: `Bearer ${recvToken}` },
    });
    const inbox = (await inboxRes.json()) as { messages: Array<{ id: string; seq?: number }> };
    const delivered = inbox.messages.find((m) => m.id === msgId);
    expect(delivered).toBeDefined();
    expect(typeof delivered!.seq).toBe("number");
    expect(delivered!.seq).toBeGreaterThan(0);
  });
});

describe("C1: BLOCKING ack-wake", () => {
  it("BLOCKING message parks sender task; ack wakes it back to in_progress", async () => {
    const senderToken = await registerUser(ctx, "c1-sender");
    const recvToken = await registerUser(ctx, "c1-recv");

    // Link sender session to a synthetic sid via /board-update
    const senderSid = "test-sid-c1-blocking-001";
    await fetch(`${ctx.baseUrl}/board-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "c1-sender", sid: senderSid }),
    });

    // Create project + task
    const projRes = await fetch(`${ctx.baseUrl}/project-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ title: "C1 ack-wake test", by: "c1-sender" }),
    });
    const { project } = (await projRes.json()) as { project: { id: string } };

    const taskRes = await fetch(`${ctx.baseUrl}/task-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ project_id: project.id, title: "blocking-work", by: "c1-sender" }),
    });
    const { task } = (await taskRes.json()) as { task: { id: string; status: string } };
    expect(task.status).toBe("proposed");

    // proposed → ratified → auto-promotes to ready (no blockers)
    await fetch(`${ctx.baseUrl}/task-transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ task_id: task.id, to: "ratified", actor: "c1-sender" }),
    });

    // ready → claimed (via task-claim with our synthetic sid)
    await fetch(`${ctx.baseUrl}/task-claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ task_id: task.id, owner: "c1-sender", owner_sid: senderSid, actor: "c1-sender" }),
    });

    // claimed → in_progress
    await fetch(`${ctx.baseUrl}/task-transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ task_id: task.id, to: "in_progress", actor: "c1-sender" }),
    });

    // Sender sends BLOCKING message
    const sendRes = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ to: "c1-recv", content: "BLOCKING: need your input before proceeding", channel: "#all" }),
    });
    expect(sendRes.status).toBe(200);
    const { id: msgId } = (await sendRes.json()) as { id: string };

    // Verify: sender's task is now blocked
    const boardRes = await fetch(`${ctx.baseUrl}/plan-board?project_id=${project.id}`);
    const board = (await boardRes.json()) as { lanes: Record<string, Array<{ id: string }>> };
    const blockedIds = (board.lanes.blocked ?? []).map((t) => t.id);
    expect(blockedIds).toContain(task.id);

    // Receiver ACKs the message
    const ackRes = await fetch(`${ctx.baseUrl}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${recvToken}` },
      body: JSON.stringify({ msg_id: msgId }),
    });
    expect(ackRes.status).toBe(200);
    const ackBody = (await ackRes.json()) as { ok: boolean; msg_id: string; unblocked: string[] };
    expect(ackBody.ok).toBe(true);
    expect(ackBody.msg_id).toBe(msgId);
    expect(ackBody.unblocked).toContain(task.id);

    // Verify: sender's task is now in_progress again
    const boardRes2 = await fetch(`${ctx.baseUrl}/plan-board?project_id=${project.id}`);
    const board2 = (await boardRes2.json()) as { lanes: Record<string, Array<{ id: string }>> };
    const inProgressIds = (board2.lanes.in_progress ?? []).map((t) => t.id);
    expect(inProgressIds).toContain(task.id);
  });

  it("duplicate ack returns 404 (pending_ack row already deleted)", async () => {
    const senderToken = await registerUser(ctx, "c1-dup-sender");
    const recvToken = await registerUser(ctx, "c1-dup-recv");

    // Set up sender board sid
    const senderSid = "test-sid-c1-dup-001";
    await fetch(`${ctx.baseUrl}/board-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ name: "c1-dup-sender", sid: senderSid }),
    });

    // Create + start a task (fast path)
    const projRes = await fetch(`${ctx.baseUrl}/project-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ title: "C1 dup-ack test" }),
    });
    const { project } = (await projRes.json()) as { project: { id: string } };
    const taskRes = await fetch(`${ctx.baseUrl}/task-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ project_id: project.id, title: "dup-ack-work" }),
    });
    const { task } = (await taskRes.json()) as { task: { id: string } };
    await fetch(`${ctx.baseUrl}/task-transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ task_id: task.id, to: "ratified", actor: "c1-dup-sender" }),
    });
    await fetch(`${ctx.baseUrl}/task-claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ task_id: task.id, owner: "c1-dup-sender", owner_sid: senderSid }),
    });
    await fetch(`${ctx.baseUrl}/task-transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.joinToken}` },
      body: JSON.stringify({ task_id: task.id, to: "in_progress", actor: "c1-dup-sender" }),
    });

    // Sender sends BLOCKING
    const sendRes = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ to: "c1-dup-recv", content: "BLOCKING: one-time check", channel: "#all" }),
    });
    const { id: msgId } = (await sendRes.json()) as { id: string };

    // First ack — succeeds
    const ack1 = await fetch(`${ctx.baseUrl}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${recvToken}` },
      body: JSON.stringify({ msg_id: msgId }),
    });
    expect(ack1.status).toBe(200);

    // Second ack — 404 (row already gone)
    const ack2 = await fetch(`${ctx.baseUrl}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${recvToken}` },
      body: JSON.stringify({ msg_id: msgId }),
    });
    expect(ack2.status).toBe(404);
  });

  it("/ack on a non-BLOCKING message id returns 404", async () => {
    const senderToken = await registerUser(ctx, "c1-noblock-sender");
    const recvToken = await registerUser(ctx, "c1-noblock-recv");

    // Send a regular (non-BLOCKING) message
    const sendRes = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${senderToken}` },
      body: JSON.stringify({ to: "c1-noblock-recv", content: "just a regular message", channel: "#all" }),
    });
    const { id: msgId } = (await sendRes.json()) as { id: string };

    const ackRes = await fetch(`${ctx.baseUrl}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${recvToken}` },
      body: JSON.stringify({ msg_id: msgId }),
    });
    expect(ackRes.status).toBe(404);
  });
});
