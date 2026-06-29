import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

interface ChannelRow {
  name: string;
  members: string[];
}

async function listChannels(): Promise<ChannelRow[]> {
  const res = await fetch(`${ctx.baseUrl}/channels`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { channels: ChannelRow[] }).channels;
}
const channelNames = async () => (await listChannels()).map((c) => c.name);

const RESERVED = ["#all", "#Agent Radio", "#Reserved"];

describe("channel delete — reserved hard-guard (server-side)", () => {
  it("rejects deletion of every reserved system channel with 400 (not 404/200)", async () => {
    for (const name of RESERVED) {
      const res = await adminPost("/admin-channel-delete", { name });
      expect(res.status, `delete ${name}`).toBe(400);
    }
  });

  it("requires the admin token (join token → 401)", async () => {
    const res = await adminPost("/admin-channel-delete", { name: "#whatever" }, ctx.joinToken);
    expect(res.status).toBe(401);
  });

  it("404s an unknown channel", async () => {
    const res = await adminPost("/admin-channel-delete", { name: "#does-not-exist" });
    expect(res.status).toBe(404);
  });

  it("deletes a real custom channel", async () => {
    expect((await adminPost("/admin-channel-create", { name: "#disposable" })).status).toBe(200);
    expect(await channelNames()).toContain("#disposable");
    expect((await adminPost("/admin-channel-delete", { name: "#disposable" })).status).toBe(200);
    expect(await channelNames()).not.toContain("#disposable");
  });
});

describe("channel rename — only #all is protected (server-side)", () => {
  it("rejects renaming #all AWAY (400); #all survives", async () => {
    const res = await adminPost("/admin-channel-rename", { from: "#all", to: "#hijacked" });
    expect(res.status, "rename-from #all").toBe(400);
    expect(await channelNames()).toContain("#all");
  });

  it("rejects renaming a custom channel INTO #all (400)", async () => {
    await adminPost("/admin-channel-create", { name: "#cloak" });
    const res = await adminPost("/admin-channel-rename", { from: "#cloak", to: "#all" });
    expect(res.status, "rename-to #all").toBe(400);
    expect(await channelNames()).toContain("#cloak"); // unchanged
  });

  it("ALLOWS renaming a formerly-reserved channel AWAY — only #all is special now", async () => {
    await adminPost("/admin-channel-create", { name: "#Agent Radio" });
    const res = await adminPost("/admin-channel-rename", { from: "#Agent Radio", to: "#radio-renamed" });
    expect(res.status, "non-#all reserved name is now renamable").toBe(200);
    const names = await channelNames();
    expect(names).toContain("#radio-renamed");
    expect(names).not.toContain("#Agent Radio");
  });

  it("ALLOWS renaming a custom channel INTO a formerly-reserved name when it's free", async () => {
    // #Agent Radio was freed by the previous test; renaming a custom channel into it is now allowed.
    await adminPost("/admin-channel-create", { name: "#radio-src" });
    const res = await adminPost("/admin-channel-rename", { from: "#radio-src", to: "#Agent Radio" });
    expect(res.status, "formerly-reserved target now allowed when free").toBe(200);
    expect(await channelNames()).toContain("#Agent Radio");
  });

  it("requires the admin token (join token → 401)", async () => {
    await adminPost("/admin-channel-create", { name: "#authcheck" });
    const res = await adminPost("/admin-channel-rename", { from: "#authcheck", to: "#authcheck2" }, ctx.joinToken);
    expect(res.status).toBe(401);
  });

  it("404s when the source channel does not exist", async () => {
    const res = await adminPost("/admin-channel-rename", { from: "#nope", to: "#nope2" });
    expect(res.status).toBe(404);
  });

  it("409s when the target name already exists", async () => {
    await adminPost("/admin-channel-create", { name: "#dup-a" });
    await adminPost("/admin-channel-create", { name: "#dup-b" });
    const res = await adminPost("/admin-channel-rename", { from: "#dup-a", to: "#dup-b" });
    expect(res.status).toBe(409);
  });

  it("renames a custom channel and preserves its membership under the new name", async () => {
    await adminPost("/admin-channel-create", { name: "#old-room" });
    const token = await registerUser(ctx, "renamer");
    const joinRes = await fetch(`${ctx.baseUrl}/channel-join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: "#old-room" }),
    });
    expect(joinRes.status).toBe(200);

    const res = await adminPost("/admin-channel-rename", { from: "#old-room", to: "#new-room" });
    expect(res.status).toBe(200);

    const rooms = await listChannels();
    expect(rooms.find((c) => c.name === "#old-room")).toBeUndefined();
    const renamed = rooms.find((c) => c.name === "#new-room");
    expect(renamed).toBeDefined();
    expect(renamed?.members).toContain("renamer"); // membership followed the rename
  });

  it("normalizes a target name without a leading # by prefixing it", async () => {
    await adminPost("/admin-channel-create", { name: "#raw" });
    const res = await adminPost("/admin-channel-rename", { from: "#raw", to: "plainish" });
    expect(res.status).toBe(200);
    const names = await channelNames();
    expect(names).toContain("#plainish");
    expect(names).not.toContain("plainish");
  });
});

describe("channel name validation — XSS hardening (server-side charset)", () => {
  const BAD = ["<img src=x onerror=alert(1)>", "a<b", 'qu"ote', "amp&er", "tag>here"];

  it("rejects creating a channel whose name carries HTML metacharacters (admin path, 400)", async () => {
    for (const name of BAD) {
      const res = await adminPost("/admin-channel-create", { name });
      expect(res.status, `create ${name}`).toBe(400);
    }
  });

  it("rejects an agent (join-token) creating an HTML-laden channel name (400)", async () => {
    const token = await registerUser(ctx, "xss-agent");
    const res = await fetch(`${ctx.baseUrl}/channel-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "<script>steal()</script>" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects renaming INTO a name with HTML metacharacters (400) and leaves the source intact", async () => {
    await adminPost("/admin-channel-create", { name: "#safe-src" });
    const res = await adminPost("/admin-channel-rename", { from: "#safe-src", to: "<script>evil</script>" });
    expect(res.status).toBe(400);
    expect(await channelNames()).toContain("#safe-src");
  });

  it("still accepts normal names (letters / digits / space / _ / -)", async () => {
    expect((await adminPost("/admin-channel-create", { name: "Team Alpha_1-2" })).status).toBe(200);
    expect(await channelNames()).toContain("#Team Alpha_1-2");
  });
});
