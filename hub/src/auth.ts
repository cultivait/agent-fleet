import { createPublicKey, type JsonWebKey as CryptoJsonWebKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { removeUserFromAllChannels } from "./channels.js";
import type { User, UserRole } from "./types.js";

const users = new Map<string, User>();
const tokenToName = new Map<string, string>();

// ===========================================================================
// Cockpit browser auth (A2-a / A3-a)
// ---------------------------------------------------------------------------
// Two independent mechanisms, used ONLY to gate the browser routes (`GET /`,
// `GET /events`). They do NOT touch the machine lane (join/admin/protected
// bearer tokens) or the public routes — those keep their existing checks.
//
//   A2-a  verifyCfAccessJwt(req): true iff the request carries a valid
//         Cloudflare Access JWT (RS256, signed by the team's JWKS, with the
//         expected aud/iss and a live exp). FAILS CLOSED when the required
//         env config is unset.
//
//   A3-a  scoped cockpit tokens: short-lived, random, in-memory grants minted
//         on an authenticated `GET /`. Embedded in the served page IN PLACE OF
//         the raw admin token, and accepted as authorization on the admin
//         routes the cockpit calls (alongside the still-valid real adminToken).
// ===========================================================================

// ---- A3-a: scoped cockpit token store ------------------------------------
const COCKPIT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h
interface CockpitGrant {
  scope: "cockpit";
  expiresAt: number;
}
const cockpitTokens = new Map<string, CockpitGrant>();

function pruneCockpitTokens(now: number): void {
  for (const [tok, grant] of cockpitTokens) {
    if (grant.expiresAt <= now) cockpitTokens.delete(tok);
  }
}

// Mint a fresh scoped cockpit token (random 32-byte hex). Returns the raw
// token string to embed in the served page. Never log this value.
export function mintCockpitToken(now: number = Date.now()): string {
  pruneCockpitTokens(now);
  const token = randomBytes(32).toString("hex");
  cockpitTokens.set(token, { scope: "cockpit", expiresAt: now + COCKPIT_TOKEN_TTL_MS });
  return token;
}

// True iff `token` is a currently-valid (unexpired) scoped cockpit token.
// Expired entries are pruned on access. Constant-time compare is unnecessary
// here: the token is a 256-bit random value looked up by Map key, not compared
// byte-by-byte against a server secret.
export function isValidCockpitToken(token: string | undefined | null, now: number = Date.now()): boolean {
  if (!token) return false;
  const grant = cockpitTokens.get(token);
  if (!grant) return false;
  if (grant.expiresAt <= now) {
    cockpitTokens.delete(token);
    return false;
  }
  return true;
}

// Extract a Bearer token from the Authorization header (no validation).
function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

// True iff the request carries a valid scoped cockpit token in its
// Authorization: Bearer header.
export function authenticateCockpitToken(req: IncomingMessage, now: number = Date.now()): boolean {
  return isValidCockpitToken(bearerToken(req), now);
}

// Test-only: clear the scoped cockpit token store.
export function resetCockpitTokens(): void {
  cockpitTokens.clear();
}

// ---- A2-a: Cloudflare Access JWT verification ----------------------------
// Required deploy-time config. If EITHER is unset, JWT verification FAILS
// CLOSED (verifyCfAccessJwt returns false) — the cockpit is then reachable
// ONLY via a valid scoped cockpit token, which can itself only be minted from
// an already-authenticated GET /. In practice that means: with these unset,
// the browser routes are effectively locked until config is supplied.
//   CF_ACCESS_TEAM_DOMAIN  e.g. "yourteam.cloudflareaccess.com"
//   CF_ACCESS_AUD          the Access application's Audience (AUD) tag
// CF_ACCESS_JWKS_URL overrides the JWKS endpoint (for offline testing); when
// unset it is derived from the team domain.
function cfTeamDomain(): string | undefined {
  return process.env.CF_ACCESS_TEAM_DOMAIN || undefined;
}
function cfAud(): string | undefined {
  return process.env.CF_ACCESS_AUD || undefined;
}
function cfJwksUrl(): string | undefined {
  const explicit = process.env.CF_ACCESS_JWKS_URL;
  if (explicit) return explicit;
  const domain = cfTeamDomain();
  if (!domain) return undefined;
  return `https://${domain}/cdn-cgi/access/certs`;
}

// True iff ANY Cloudflare Access config signal is present (team domain, aud, or
// an explicit JWKS url). This is intentionally OR, not AND: a deploy that sets
// even one CF var clearly INTENDS gated access, so it must keep the strict
// browser gate (verifyCfAccessJwt then fails CLOSED on the missing piece) — a
// partial / misconfigured CF setup must never fall open. Only a deploy with ZERO
// CF signal is treated as single-machine / localhost: the hub binds 127.0.0.1,
// so the browser routes open without a token and a fresh clone does not 403 its
// own dashboard. Setting CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD turns the full
// gate on for tunneled / exposed / multi-node deployments.
export function cfAccessConfigured(): boolean {
  return Boolean(cfTeamDomain() || cfAud() || process.env.CF_ACCESS_JWKS_URL);
}

interface Jwk {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  [k: string]: unknown;
}

// In-memory JWKS cache with a TTL. Refetched on a cache miss for an unknown
// kid (so a key rotation is picked up without waiting out the TTL).
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function fetchJwks(url: string): Promise<Jwk[]> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  const body = (await resp.json()) as { keys?: Jwk[] };
  return Array.isArray(body.keys) ? body.keys : [];
}

async function getSigningKey(kid: string, now: number): Promise<Jwk | null> {
  const url = cfJwksUrl();
  if (!url) return null;
  // Serve from cache if fresh and the kid is present.
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    const hit = jwksCache.keys.find((k) => k.kid === kid);
    if (hit) return hit;
  }
  // Cache miss / stale / unknown kid → refetch once.
  try {
    const keys = await fetchJwks(url);
    jwksCache = { keys, fetchedAt: now };
    return keys.find((k) => k.kid === kid) ?? null;
  } catch {
    // Refetch failed — fall back to any cached key for this kid (may be null).
    return jwksCache?.keys.find((k) => k.kid === kid) ?? null;
  }
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function decodeJwtSegment(seg: string): Record<string, unknown> | null {
  try {
    return JSON.parse(b64urlToBuffer(seg).toString("utf8"));
  } catch {
    return null;
  }
}

// Verify a Cloudflare Access JWT taken from the Cf-Access-Jwt-Assertion header.
// Returns true ONLY when: required env config is present; the token is a
// well-formed RS256 JWT; its signature verifies against the team JWKS key for
// its kid; aud includes CF_ACCESS_AUD; iss === https://<team domain>; and exp
// is in the future. Any failure (including missing config) returns false —
// fail closed. Never throws to the caller; never logs the token.
export async function verifyCfAccessJwt(req: IncomingMessage, now: number = Date.now()): Promise<boolean> {
  const domain = cfTeamDomain();
  const aud = cfAud();
  // Fail CLOSED when required config is unset.
  if (!domain || !aud) return false;

  const raw = req.headers["cf-access-jwt-assertion"];
  const jwt = Array.isArray(raw) ? raw[0] : raw;
  if (!jwt || typeof jwt !== "string") return false;

  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [headerSeg, payloadSeg, sigSeg] = parts;

  const header = decodeJwtSegment(headerSeg);
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") return false;

  const payload = decodeJwtSegment(payloadSeg);
  if (!payload) return false;

  // Claim checks (do these before the network call only where cheap; signature
  // is still required below, so claims alone never grant access).
  // iss must be exactly the team domain.
  if (payload.iss !== `https://${domain}`) return false;
  // aud must include the configured AUD (CF Access aud is a string or array).
  const audClaim = payload.aud;
  const audList = Array.isArray(audClaim) ? audClaim : typeof audClaim === "string" ? [audClaim] : [];
  if (!audList.includes(aud)) return false;
  // exp must be in the future (exp is in seconds).
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return false;

  // Resolve the signing key for this kid and verify the RS256 signature over
  // "<header>.<payload>".
  let jwk: Jwk | null;
  try {
    jwk = await getSigningKey(header.kid, now);
  } catch {
    return false;
  }
  if (!jwk || jwk.kty !== "RSA") return false;

  try {
    const keyObject = createPublicKey({ key: jwk as unknown as CryptoJsonWebKey, format: "jwk" });
    const signingInput = Buffer.from(`${headerSeg}.${payloadSeg}`, "utf8");
    const signature = b64urlToBuffer(sigSeg);
    return cryptoVerify("RSA-SHA256", signingInput, keyObject, signature);
  } catch {
    return false;
  }
}

// Test-only: clear the JWKS cache so a test can swap mock keys between cases.
export function resetCfAccessJwksCache(): void {
  jwksCache = null;
}

export function getUserToken(name: string): string | null {
  return users.get(name)?.token ?? null;
}

export function registerUser(name: string, role: UserRole = "agent", isPrincipal = false): User {
  if (users.has(name)) {
    throw new Error(`User "${name}" is already registered`);
  }
  const token = randomBytes(32).toString("hex");
  const user: User = { name, token, role, registeredAt: Date.now(), isPrincipal, persistent: false };
  users.set(name, user);
  tokenToName.set(token, name);
  return user;
}

export function unregisterUser(name: string): void {
  const user = users.get(name);
  if (user) {
    tokenToName.delete(user.token);
    users.delete(name);
    removeUserFromAllChannels(name);
  }
}

export function authenticateRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return tokenToName.get(token) ?? null;
}

export function getRegisteredUsers(): string[] {
  return Array.from(users.keys());
}

export function getUserRole(name: string): UserRole | null {
  return users.get(name)?.role ?? null;
}

export function getUsersByRole(role: UserRole): string[] {
  return Array.from(users.values())
    .filter((u) => u.role === role)
    .map((u) => u.name);
}

export function isUserRegistered(name: string): boolean {
  return users.has(name);
}

// REFEREE: principal capability — set ONLY via the admin-token /admin-register
// path. routeMessage stamps message.principal:true when the SENDER is a principal
// user, so recipients can treat the message as operator-authenticated. The flag
// lives ONLY in the server-side user record; it is never read from a client body,
// so a join-token user cannot forge it.
export function isPrincipalUser(name: string): boolean {
  return users.get(name)?.isPrincipal === true;
}

// Setter used ONLY by the admin-register path. No-op (returns false) if the user
// is not registered.
export function setPrincipal(name: string, isPrincipal: boolean): boolean {
  const user = users.get(name);
  if (!user) return false;
  user.isPrincipal = isPrincipal;
  return true;
}

// Operator presence: a persistent user is a virtual operator identity ("Operator")
// with no live session, bootstrapped server-side. The ghost-reaper and kick-all
// skip persistent users so the operator is never swept like a dead agent. Set
// ONLY by the server-side bootstrap (ensureOperatorPresence) — never a client body.
export function isPersistentUser(name: string): boolean {
  return users.get(name)?.persistent === true;
}

export function setPersistent(name: string, persistent: boolean): boolean {
  const user = users.get(name);
  if (!user) return false;
  user.persistent = persistent;
  return true;
}

export function resetAuthState(): void {
  users.clear();
  tokenToName.clear();
}
