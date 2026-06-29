import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAcquireResourceLock, dbGetResourceLock, dbReleaseResourceLock, dbRenewResourceLock } from "../db.js";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// C4: resource_lock — atomic acquire, sliding renewal, lazy-reclaim on expiry.
// Tests run against the same in-memory DB initialized by startTestServer (which
// calls initDB(), creating the resource_lock table with C4's CREATE TABLE block).

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await stopTestServer(ctx);
});

describe("C4 — resource_lock: atomic acquire", () => {
  it("first acquirer gets the lock (changes=1)", () => {
    const now = Date.now();
    const ok = dbAcquireResourceLock("test:atomic-acquire", "sid-A", now + 60_000, now);
    expect(ok).toBe(true);
    const row = dbGetResourceLock("test:atomic-acquire");
    expect(row?.owner_sid).toBe("sid-A");
  });

  it("second acquirer is rejected while the lease is still valid (changes=0)", () => {
    const now = Date.now();
    // sid-A already holds a live lock from the previous test.
    const ok = dbAcquireResourceLock("test:atomic-acquire", "sid-B", now + 60_000, now);
    expect(ok).toBe(false);
    // Confirm the original holder is unchanged.
    const row = dbGetResourceLock("test:atomic-acquire");
    expect(row?.owner_sid).toBe("sid-A");
  });

  it("second acquirer succeeds after the lease expires (lazy-reclaim path)", () => {
    const past = Date.now() - 1; // already expired
    // Acquire with an expiry in the past so the row is stale immediately.
    dbAcquireResourceLock("test:lazy-reclaim", "sid-stale", past, Date.now() - 2);
    // Confirm stale holder is there.
    expect(dbGetResourceLock("test:lazy-reclaim")?.owner_sid).toBe("sid-stale");

    // New acquirer: now > stale lease_expires_at, so the ON CONFLICT WHERE fires.
    const now = Date.now();
    const ok = dbAcquireResourceLock("test:lazy-reclaim", "sid-new", now + 60_000, now);
    expect(ok).toBe(true);
    expect(dbGetResourceLock("test:lazy-reclaim")?.owner_sid).toBe("sid-new");
  });
});

describe("C4 — resource_lock: renew + release", () => {
  it("owner can renew their own lock", () => {
    const now = Date.now();
    dbAcquireResourceLock("test:renew", "sid-R", now + 1_000, now);
    const newExpiry = now + 120_000;
    const ok = dbRenewResourceLock("test:renew", "sid-R", newExpiry);
    expect(ok).toBe(true);
    expect(dbGetResourceLock("test:renew")?.lease_expires_at).toBe(newExpiry);
  });

  it("non-owner cannot renew (changes=0)", () => {
    const now = Date.now();
    const ok = dbRenewResourceLock("test:renew", "sid-X", now + 120_000);
    expect(ok).toBe(false);
  });

  it("owner can release their lock", () => {
    const now = Date.now();
    dbAcquireResourceLock("test:release", "sid-REL", now + 60_000, now);
    const ok = dbReleaseResourceLock("test:release", "sid-REL");
    expect(ok).toBe(true);
    expect(dbGetResourceLock("test:release")).toBeUndefined();
  });

  it("non-owner cannot release (changes=0)", () => {
    const now = Date.now();
    dbAcquireResourceLock("test:release-guard", "sid-OWNER", now + 60_000, now);
    const ok = dbReleaseResourceLock("test:release-guard", "sid-OTHER");
    expect(ok).toBe(false);
    expect(dbGetResourceLock("test:release-guard")?.owner_sid).toBe("sid-OWNER");
  });
});

describe("C4 — resource_lock: HTTP endpoints", () => {
  function post(path: string, body: unknown, token: string): Promise<Response> {
    return fetch(`${ctx.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  function get(path: string, token: string): Promise<Response> {
    return fetch(`${ctx.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it("acquire returns 200 with lock row", async () => {
    const res = await post(
      "/resource-lock-acquire",
      { resource_key: "http:acquire-test", owner_sid: "http-sid-A", lease_ms: 60_000 },
      ctx.joinToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lock: { owner_sid: string } };
    expect(body.lock.owner_sid).toBe("http-sid-A");
  });

  it("second acquire returns 409 when lock is held", async () => {
    const res = await post(
      "/resource-lock-acquire",
      { resource_key: "http:acquire-test", owner_sid: "http-sid-B", lease_ms: 60_000 },
      ctx.joinToken,
    );
    expect(res.status).toBe(409);
  });

  it("get returns the current lock row", async () => {
    const res = await get(`/resource-lock-get?resource_key=${encodeURIComponent("http:acquire-test")}`, ctx.joinToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lock: { owner_sid: string } | null };
    expect(body.lock?.owner_sid).toBe("http-sid-A");
  });

  it("release returns 200 and lock is gone", async () => {
    const res = await post(
      "/resource-lock-release",
      { resource_key: "http:acquire-test", owner_sid: "http-sid-A" },
      ctx.joinToken,
    );
    expect(res.status).toBe(200);
    const after = await get(
      `/resource-lock-get?resource_key=${encodeURIComponent("http:acquire-test")}`,
      ctx.joinToken,
    );
    const body = (await after.json()) as { lock: null };
    expect(body.lock).toBeNull();
  });
});

// ─── Wave-4 (a): lease_ms honored, clamped to a sane max, defaulted when absent ──
// The clamp lives in the HTTP handler (resolveResourceLeaseMs), not the db layer, so
// these go through the endpoint. Defaults under test env (no WT_* overrides):
//   RESOURCE_LOCK_DEFAULT_LEASE_MS = 300_000 (5min)
//   RESOURCE_LOCK_MAX_LEASE_MS     = 3_600_000 (1h = board-reap horizon)
describe("C4/Wave-4 (a) — resource_lock lease_ms honor + clamp + default", () => {
  const DEFAULT_MS = 300_000;
  const MAX_MS = 3_600_000;
  const SLOP = 10_000; // generous tolerance for server-clock + scheduling jitter

  function post(path: string, body: unknown, token: string): Promise<Response> {
    return fetch(`${ctx.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it("honors a positive lease_ms below the max (reflected in lease_expires_at)", async () => {
    const lease = 120_000; // 2min, under the 1h cap
    const t0 = Date.now();
    const res = await post(
      "/resource-lock-acquire",
      { resource_key: "w4a:honor", owner_sid: "w4a-sid", lease_ms: lease },
      ctx.joinToken,
    );
    expect(res.status).toBe(200);
    const { lock } = (await res.json()) as { lock: { lease_expires_at: number } };
    // serverNow >= t0, so expiry is in [t0+lease, t0+lease+SLOP].
    expect(lock.lease_expires_at).toBeGreaterThanOrEqual(t0 + lease - 1000);
    expect(lock.lease_expires_at).toBeLessThanOrEqual(t0 + lease + SLOP);
  });

  it("CLAMPS an over-max lease_ms down to the maximum (flips RED if the cap is removed)", async () => {
    const lease = 10 * MAX_MS; // 10h — wildly over the 1h cap
    const t0 = Date.now();
    const res = await post(
      "/resource-lock-acquire",
      { resource_key: "w4a:clamp", owner_sid: "w4a-sid", lease_ms: lease },
      ctx.joinToken,
    );
    expect(res.status).toBe(200);
    const { lock } = (await res.json()) as { lock: { lease_expires_at: number } };
    // Without the clamp this would be ~t0 + 36_000_000; the cap pins it near t0 + MAX_MS.
    expect(lock.lease_expires_at).toBeGreaterThanOrEqual(t0 + MAX_MS - 1000);
    expect(lock.lease_expires_at).toBeLessThanOrEqual(t0 + MAX_MS + SLOP);
  });

  it("falls back to the default lease when lease_ms is absent", async () => {
    const t0 = Date.now();
    const res = await post(
      "/resource-lock-acquire",
      { resource_key: "w4a:default", owner_sid: "w4a-sid" },
      ctx.joinToken,
    );
    expect(res.status).toBe(200);
    const { lock } = (await res.json()) as { lock: { lease_expires_at: number } };
    expect(lock.lease_expires_at).toBeGreaterThanOrEqual(t0 + DEFAULT_MS - 1000);
    expect(lock.lease_expires_at).toBeLessThanOrEqual(t0 + DEFAULT_MS + SLOP);
  });
});
