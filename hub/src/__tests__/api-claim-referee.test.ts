import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setOffline } from "../polling.js";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// REFEREE failover: tests for the MEMBER-gated + VACANCY-gated POST /claim-referee
// endpoint. Unlike /admin-register (admin token, force), this lets any valid member
// promote itself to REFEREE ONLY when the seat is empty (no REFEREE, or a
// stale/offline REFEREE record). The REFEREE seat is a singleton, so each test gets
// a fresh hub via beforeEach/afterEach to stay independent.

let ctx: TestContext;

beforeEach(async () => {
  ctx = await startTestServer();
});

afterEach(async () => {
  await stopTestServer(ctx);
});

function adminRegister(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${ctx.baseUrl}/admin-register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.adminToken}` },
    body: JSON.stringify(body),
  });
}

function claimReferee(token: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${ctx.baseUrl}/claim-referee`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function userNames(): Promise<string[]> {
  const res = await fetch(`${ctx.baseUrl}/users`);
  return ((await res.json()) as { users: { name: string }[] }).users.map((u) => u.name);
}

describe("POST /claim-referee", () => {
  it("rejects an unauthenticated caller (401)", async () => {
    const res = await fetch(`${ctx.baseUrl}/claim-referee`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("(1) vacant seat: a member claims REFEREE, becomes principal, old callsign shed", async () => {
    const token = await registerUser(ctx, "cr-claimant");
    const res = await claimReferee(token, { oldName: "cr-claimant" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("REFEREE");
    expect(body.token).toBeTruthy();

    const names = await userNames();
    expect(names).toContain("REFEREE");
    expect(names).not.toContain("cr-claimant");

    // The new REFEREE is principal: its /send stamps principal:true.
    const recvToken = await registerUser(ctx, "cr-recv");
    const sendRes = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ to: "cr-recv", content: "referee here" }),
    });
    expect(sendRes.status).toBe(200);
    const inboxRes = await fetch(`${ctx.baseUrl}/inbox`, { headers: { Authorization: `Bearer ${recvToken}` } });
    const inbox = (await inboxRes.json()) as { messages: Array<{ from: string; principal?: boolean }> };
    expect(inbox.messages.find((m) => m.from === "REFEREE")?.principal).toBe(true);
  });

  it("(2) live REFEREE present: claim is refused with 409 and the caller is unchanged", async () => {
    // A live REFEREE holds the seat (admin-registered => registered + online).
    const liveRes = await adminRegister({ name: "REFEREE" });
    expect(liveRes.status).toBe(200);

    const token = await registerUser(ctx, "cr-loser");
    const res = await claimReferee(token, { oldName: "cr-loser" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; holder?: string };
    expect(body.error).toBe("referee_seat_occupied");
    expect(body.holder).toBe("REFEREE");

    // The caller is untouched — still registered under its own callsign and usable.
    const names = await userNames();
    expect(names).toContain("cr-loser");
    const stillWorks = await fetch(`${ctx.baseUrl}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: "@all", content: "still me" }),
    });
    expect(stillWorks.status).toBe(200);
  });

  it("(3) stale/offline REFEREE record present: claim succeeds, sheds the stale record", async () => {
    // A prior REFEREE registered then went offline (killed poll) without unregistering.
    const staleRes = await adminRegister({ name: "REFEREE" });
    expect(staleRes.status).toBe(200);
    const { token: staleToken } = (await staleRes.json()) as { token: string };
    setOffline("REFEREE");

    const token = await registerUser(ctx, "cr-successor");
    const res = await claimReferee(token, { oldName: "cr-successor" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; name: string };
    expect(body.name).toBe("REFEREE");
    // A brand-new token was minted; the stale token is shed.
    expect(body.token).not.toBe(staleToken);

    const names = await userNames();
    expect(names).toContain("REFEREE");
    expect(names).not.toContain("cr-successor");
  });

  it("(4) two simultaneous claims on a vacant seat: exactly one wins, the other gets 409", async () => {
    const tokenA = await registerUser(ctx, "cr-raceA");
    const tokenB = await registerUser(ctx, "cr-raceB");

    const [resA, resB] = await Promise.all([
      claimReferee(tokenA, { oldName: "cr-raceA" }),
      claimReferee(tokenB, { oldName: "cr-raceB" }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Exactly one REFEREE exists.
    const names = await userNames();
    expect(names.filter((n) => n === "REFEREE")).toHaveLength(1);
  });

  it("(6) endpoint only ever mints REFEREE — no path to claim operator/operator", async () => {
    const token = await registerUser(ctx, "cr-sneaky");
    // Even if the body smuggles a name, it is ignored — the endpoint hardcodes REFEREE.
    const res = await claimReferee(token, { name: "operator", oldName: "cr-sneaky" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("REFEREE");

    const names = await userNames();
    expect(names).not.toContain("operator");
    expect(names).not.toContain("operator");
    expect(names).toContain("REFEREE");
  });
});
