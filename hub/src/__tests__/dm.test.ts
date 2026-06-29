import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

interface Msg {
  id: string;
  from: string;
  to: string;
  content: string;
  channel?: string;
  dm?: boolean;
}

function dm(token: string, to: string, content: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}/dm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, content }),
  });
}

async function inbox(token: string): Promise<Msg[]> {
  const res = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: Msg[] }).messages;
}

function adminGet(path: string, token?: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token ?? ctx.adminToken}` } });
}

describe("direct messages (fleet_dm) — delivery + isolation", () => {
  it("delivers a DM to the recipient only, never to a third agent", async () => {
    const alice = await registerUser(ctx, "dm-alice");
    await registerUser(ctx, "dm-bob");
    const bob = await registerUser(ctx, "dm-bob-tok");
    const carol = await registerUser(ctx, "dm-carol");

    const sent = await dm(alice, "dm-bob-tok", "secret for bob only");
    expect(sent.status).toBe(200);

    const bobMsgs = await inbox(bob);
    const got = bobMsgs.find((m) => m.content === "secret for bob only");
    expect(got, "recipient received the DM").toBeDefined();
    expect(got?.from).toBe("dm-alice");
    expect(got?.to).toBe("dm-bob-tok");
    expect(got?.dm, "received message is flagged as a DM so the client can distinguish it").toBe(true);

    const carolMsgs = await inbox(carol);
    expect(carolMsgs.find((m) => m.content === "secret for bob only"), "third agent must NOT see the DM").toBeUndefined();
  });

  it("never lets a DM enter any channel history (/admin-channel-history)", async () => {
    const alice = await registerUser(ctx, "iso-alice");
    const bob = await registerUser(ctx, "iso-bob");
    expect((await dm(alice, "iso-bob", "channel-invisible payload")).status).toBe(200);
    // drain bob so the message is delivered/persisted exactly as a real run would
    await inbox(bob);

    const allHist = await (await adminGet("/admin-channel-history")).json();
    const inAll = (allHist.messages as Msg[]).some((m) => m.content === "channel-invisible payload");
    expect(inAll, "DM absent from cross-channel history").toBe(false);

    const allChan = await (await adminGet("/admin-channel-history?channel=%23all")).json();
    const inHashAll = (allChan.messages as Msg[]).some((m) => m.content === "channel-invisible payload");
    expect(inHashAll, "DM absent from #all").toBe(false);
  });
});

describe("direct messages (fleet_dm) — operator audit store", () => {
  it("persists to a DM thread listed in /admin-dms and readable in /admin-dm-history", async () => {
    const alice = await registerUser(ctx, "store-alice");
    await registerUser(ctx, "store-bob");
    expect((await dm(alice, "store-bob", "thread line one")).status).toBe(200);

    const pair = ["store-alice", "store-bob"].sort().join("|");

    const threads = (await (await adminGet("/admin-dms")).json()) as { threads: Array<{ pair: string }> };
    expect(threads.threads.some((t) => t.pair === pair), "thread listed in /admin-dms").toBe(true);

    const hist = (await (await adminGet(`/admin-dm-history?pair=${encodeURIComponent(pair)}`)).json()) as {
      messages: Msg[];
    };
    expect(hist.messages.some((m) => m.content === "thread line one"), "DM readable in /admin-dm-history").toBe(true);
  });

  it("keys both directions onto the same thread (canonical sorted pair)", async () => {
    const a = await registerUser(ctx, "bi-a");
    const b = await registerUser(ctx, "bi-b");
    expect((await dm(a, "bi-b", "a-to-b")).status).toBe(200);
    expect((await dm(b, "bi-a", "b-to-a")).status).toBe(200);

    const pair = ["bi-a", "bi-b"].sort().join("|");
    const hist = (await (await adminGet(`/admin-dm-history?pair=${encodeURIComponent(pair)}`)).json()) as {
      messages: Msg[];
    };
    const contents = hist.messages.map((m) => m.content);
    expect(contents).toContain("a-to-b");
    expect(contents).toContain("b-to-a");
  });

  it("requires the admin token for the audit routes (join token → 401)", async () => {
    expect((await adminGet("/admin-dms", ctx.joinToken)).status).toBe(401);
    expect((await adminGet("/admin-dm-history?pair=x%7Cy", ctx.joinToken)).status).toBe(401);
  });
});
