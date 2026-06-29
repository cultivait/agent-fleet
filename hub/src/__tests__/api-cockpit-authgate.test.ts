import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetCfAccessJwksCache } from "../auth.js";
import { startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// A2-a / A3-a — cockpit browser auth gate.
//
// Gates ONLY the browser routes (GET /, GET /events). A request passes iff it
// carries EITHER a valid CF Access JWT OR a valid scoped cockpit token. The
// served page embeds a SCOPED cockpit token, never the raw admin token, and the
// admin routes accept that scoped token in addition to the real admin token.
//
// This suite spins up a tiny local mock JWKS from a self-generated RSA keypair,
// points CF_ACCESS_JWKS_URL at it, and mints test JWTs with that key.

const TEAM_DOMAIN = "test-team.cloudflareaccess.test";
const AUD = "test-aud-tag-123";
const KID = "test-kid-1";

// Self-signed RSA keypair for the mock JWKS.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
jwk.kid = KID;
jwk.alg = "RS256";
jwk.use = "sig";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(payload: Record<string, unknown>, kid = KID): string {
  const header = { alg: "RS256", typ: "JWT", kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(privateKey).toString("base64url");
  return `${signingInput}.${sig}`;
}

function validClaims(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    iss: `https://${TEAM_DOMAIN}`,
    aud: [AUD],
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "operator@cultivait.co",
    ...over,
  };
}

let ctx: TestContext;
let jwks: Server;
let jwksUrl: string;

beforeAll(async () => {
  // Mock JWKS endpoint.
  jwks = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  const addr = jwks.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  jwksUrl = `http://127.0.0.1:${port}/certs`;

  process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
  process.env.CF_ACCESS_AUD = AUD;
  process.env.CF_ACCESS_JWKS_URL = jwksUrl;

  ctx = await startTestServer();
});

afterEach(() => {
  // Restore the canonical test config after cases that mutate env.
  process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
  process.env.CF_ACCESS_AUD = AUD;
  process.env.CF_ACCESS_JWKS_URL = jwksUrl;
  resetCfAccessJwksCache();
});

afterAll(async () => {
  await stopTestServer(ctx);
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
  delete process.env.CF_ACCESS_TEAM_DOMAIN;
  delete process.env.CF_ACCESS_AUD;
  delete process.env.CF_ACCESS_JWKS_URL;
});

describe("A2-a — browser route gate", () => {
  it("GET / with no auth → 403", async () => {
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(403);
  });

  it("GET /events with no auth → 403", async () => {
    const res = await fetch(`${ctx.baseUrl}/events`);
    expect(res.status).toBe(403);
  });

  it("GET / with a valid CF Access JWT → 200, raw admin token ABSENT, scoped token present", async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { "Cf-Access-Jwt-Assertion": signJwt(validClaims()) },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // The raw admin token must NOT appear anywhere in the served page.
    expect(body).not.toContain(ctx.adminToken);
    // A scoped cockpit token IS embedded (64 hex chars in ADMIN_TOKEN = "...").
    const m = body.match(/ADMIN_TOKEN\s*=\s*"([0-9a-f]{64})"/);
    expect(m).not.toBeNull();
  });

  it("GET / with a valid scoped cockpit token (clause b) → 200", async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { Authorization: `Bearer ${ctx.cockpitToken}` },
    });
    expect(res.status).toBe(200);
  });

  it("break-glass: GET / with the real admin token → 200 (recovery if CF config misfires)", async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.status).toBe(200);
  });

  it("does NOT fail open: GET / with a wrong/arbitrary bearer token → 403", async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { Authorization: "Bearer not-a-real-token-deadbeef" },
    });
    expect(res.status).toBe(403);
  });

  it("GET /events with a valid CF Access JWT → 200 stream", async () => {
    const ac = new AbortController();
    const res = await fetch(`${ctx.baseUrl}/events`, {
      headers: { "Cf-Access-Jwt-Assertion": signJwt(validClaims()) },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    ac.abort();
  });

  it("rejects a JWT with wrong aud → 403", async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { "Cf-Access-Jwt-Assertion": signJwt(validClaims({ aud: ["other-aud"] })) },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a JWT with wrong iss → 403", async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { "Cf-Access-Jwt-Assertion": signJwt(validClaims({ iss: "https://evil.example" })) },
    });
    expect(res.status).toBe(403);
  });

  it("rejects an expired JWT → 403", async () => {
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: {
        "Cf-Access-Jwt-Assertion": signJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 10 })),
      },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a JWT signed by an unknown key (bad signature) → 403", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = { alg: "RS256", typ: "JWT", kid: KID };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(validClaims()))}`;
    const signer = createSign("RSA-SHA256");
    signer.update(input);
    signer.end();
    const forged = `${input}.${signer.sign(other.privateKey).toString("base64url")}`;
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { "Cf-Access-Jwt-Assertion": forged },
    });
    expect(res.status).toBe(403);
  });

  it("FAILS CLOSED when CF_ACCESS_AUD is unset (valid JWT no longer passes)", async () => {
    delete process.env.CF_ACCESS_AUD;
    resetCfAccessJwksCache();
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { "Cf-Access-Jwt-Assertion": signJwt(validClaims()) },
    });
    expect(res.status).toBe(403);
  });

  it("FAILS CLOSED when CF_ACCESS_TEAM_DOMAIN is unset (valid JWT no longer passes)", async () => {
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    resetCfAccessJwksCache();
    const res = await fetch(`${ctx.baseUrl}/`, {
      headers: { "Cf-Access-Jwt-Assertion": signJwt(validClaims()) },
    });
    expect(res.status).toBe(403);
  });

  // M3 solo defaults: a single-machine deploy with NO Cloudflare Access config at
  // all (zero signal) is localhost-only (the hub binds 127.0.0.1), so the browser
  // dashboard must open without a token — otherwise a fresh clone 403s its own
  // dashboard. This is distinct from the partial-config cases above, which keep
  // the strict fail-closed gate because a CF signal is still present.
  it("solo mode — GET / with NO CF Access config opens without a token → 200", async () => {
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    delete process.env.CF_ACCESS_AUD;
    delete process.env.CF_ACCESS_JWKS_URL;
    resetCfAccessJwksCache();
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(200);
  });
});

describe("A3-a — admin route accepts scoped cockpit token", () => {
  it("machine lane: public route stays public (GET /board → 200, no auth)", async () => {
    const res = await fetch(`${ctx.baseUrl}/board`);
    expect(res.status).toBe(200);
  });

  it("machine lane: join route still requires the join token (POST /session-register w/o token → 401)", async () => {
    const res = await fetch(`${ctx.baseUrl}/session-register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("admin route accepts the real admin token (GET /admin-conductor-status → not 401)", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-conductor-status`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("admin route accepts a valid scoped cockpit token (GET /admin-conductor-status → not 401)", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-conductor-status`, {
      headers: { Authorization: `Bearer ${ctx.cockpitToken}` },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("admin route rejects a bogus/unknown token → 401", async () => {
    const res = await fetch(`${ctx.baseUrl}/admin-conductor-status`, {
      headers: { Authorization: `Bearer ${randomBytes(32).toString("hex")}` },
    });
    expect(res.status).toBe(401);
  });
});
