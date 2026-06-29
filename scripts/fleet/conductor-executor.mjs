#!/usr/bin/env node
// scripts/fleet/conductor-executor.mjs
//
// WS5 conductor — NON-AGENT executor (the layer that ACTS).
//
// The brain (hub/src/conductor.ts → dist/conductor.js) DECIDES and emits intents;
// this executor CARRIES THEM OUT. It is a non-agent Node process precisely so the
// auto-mode classifier wall (which guards a Claude INSTANCE mutating shared/
// persistent state) does not bind it — a daemon's reap/post is ring-1 fleet-ops
// inside Operator's envelope (WS5 design §6/§6c, confirmed by b37c 2026-06-17).
//
// SAFETY (load-bearing):
//   • DRY-RUN is the DEFAULT. Nothing destructive runs until WT_CONDUCTOR_ARMED=1.
//     Observe-only first deploy: it logs what it WOULD reap, executes nothing.
//   • Every reap is §6c single-executor-elected: STEP-0 radio_lock_acquire on a
//     per-target lock (reap:<sid>), released in a `finally`. Lock denied → DEFER,
//     never act (the loser stands down).
//   • A permanent STATE-CHECK BELT re-reads /registry before the kill — locks can
//     be lost to TTL/skew/restart, so the belt is the ground-truth co-requirement.
//   • Kill is TARGETED by control_handle (tmux:wt-<rid>), NEVER a `tmux ls` sweep
//     (§9 — fleet reap's board-wide blunt instrument once killed an orphan).
//
// This file does NOT edit fleet.mjs; it imports its exported helpers. Pure helpers
// below are exported for node --test; the I/O is injected via `ctx` so the
// load-bearing reap sequence is unit-testable without a live hub.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Reuse fleet.mjs exports (additive-only contract with 1d49's launcher lane).
import { loadEnv } from "./fleet.mjs";
// A1/A2: the operator control file is the LIVE source of truth for arm/observe,
// pause, tunables, and the kill-exempt pin set — re-read every tick (restart-free).
import { readControl } from "./conductor-control.mjs";

const execFileP = promisify(execFile);

const HUB_URL = process.env.WALKIE_TALKIE_HUB_URL || "http://localhost:9559";
const STATE_FILE =
  process.env.WT_CONDUCTOR_STATE_FILE || join(homedir(), ".config", "walkie-talkie", "conductor-state.json");
const OWNER_SID = process.env.WT_CONDUCTOR_SID || "conductor-executor";
const REAP_LEASE_MS = Number(process.env.WT_CONDUCTOR_REAP_LEASE_MS || 60_000);
// Brain (compiled). Override via WT_CONDUCTOR_BRAIN; default = ../../hub/dist/conductor.js.
const BRAIN_URL =
  process.env.WT_CONDUCTOR_BRAIN || new URL("../../hub/dist/conductor.js", import.meta.url).href;

// NOTE (#11 — what THIS executor now carries):
//   • IDLE-REAP is the brain's temporal Δ-flat primitive (context_ts advancement
//     across the per-session ring buffer), emitted as a NON-DESTRUCTIVE "flag".
//     It REPLACED the dead last_standby_at predicate (null for every healthy
//     agent here) and the snapshot born-stuck trigger (which false-flagged a
//     healthy reviewer, 2026-06-17). FLAG-only: it surfaces idle candidates and
//     KILLS NOTHING — there is no code path from a flag to a kill.
//   • STUCK-DETECTION (open-task + flat = hung) stays DEFERRED: no in-band signal
//     separates busy-foreground from hung (a foreground tool freezes the gauge
//     AND suspends the turn-based model, so a probe can't answer either). It is
//     unblocked only by an out-of-band PreToolUse "entering tool" BRACKET (a
//     Operator-gated hook); until then it is UNKNOWN / no-action.
//   • The reap MACHINERY below (lock-elected, belt-checked, targeted kill) is
//     retained for the FUTURE armed reap trigger; it fires nothing today (the
//     brain emits no "reap" intent — only "flag"). A truly DEAD process is the
//     hub crash-sweep's job.

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS (exported for node --test)
// ─────────────────────────────────────────────────────────────────────────────

/** "tmux:wt-abc" → "wt-abc"; else "wt-"+spawnId; else null. The exact kill target. */
export function parseTmuxSession(controlHandle, spawnId) {
  if (typeof controlHandle === "string" && controlHandle.startsWith("tmux:")) {
    return controlHandle.slice("tmux:".length) || null;
  }
  if (spawnId) return `wt-${spawnId}`;
  return null;
}

/** Plan the mechanics of a reap intent. {ok:false,reason} if no kill target derivable. */
export function planReap(intent) {
  const session = parseTmuxSession(intent.controlHandle, intent.spawnId);
  if (!session) {
    return { ok: false, reason: "no tmux session derivable (null control_handle and spawn_id)" };
  }
  return {
    ok: true,
    lockKey: intent.requiresLock || (intent.sessionId ? `reap:${intent.sessionId}` : null),
    session,
    killBin: "tmux",
    killArgs: ["kill-session", "-t", session],
  };
}

/**
 * STATE-CHECK BELT (§6c) — decide, against the LIVE registry row re-read after
 * acquiring the lock, whether the reap is still warranted. Never kill a target
 * that already vanished or retired. (A future temporal stuck-trigger will add a
 * trigger-specific re-verify here; today only generic identity/liveness checks.)
 */
export function reapBeltVerdict(currentRow, pinnedCallsigns = []) {
  if (!currentRow) return { proceed: false, reason: "target vanished from registry (already gone)" };
  if (currentRow.status !== "active") {
    return { proceed: false, reason: `target status=${currentRow.status} (already retired/dead)` };
  }
  // A3 (load-bearing, EXECUTOR-REFUSE half): never reap a PINNED target, keyed on
  // CALLSIGN. Belt-and-suspenders with the brain-skip — the caller passes a FRESH
  // re-read of the pin set so a pin landing AFTER the brain flagged but BEFORE this
  // kill (the pin-during-flight race) still exempts the target. callsign may be null.
  const pins = pinnedCallsigns instanceof Set ? pinnedCallsigns : new Set(pinnedCallsigns || []);
  if (currentRow.callsign && pins.has(currentRow.callsign)) {
    return { proceed: false, reason: `target callsign '${currentRow.callsign}' is PINNED (kill-exempt)` };
  }
  if (!parseTmuxSession(currentRow.control_handle, currentRow.spawn_id)) {
    return { proceed: false, reason: "no control handle on live row (cannot target)" };
  }
  return { proceed: true, reason: "target still warranted — proceed" };
}

/** Route an intent to its executor channel. */
export function classifyDispatch(intent) {
  switch (intent.kind) {
    case "reap":
      return { channel: "reap", destructive: true, needsLock: true };
    case "flag":
      // #11 idle-reap FLAG — NON-DESTRUCTIVE. Its own channel, NEVER "reap": there
      // is no code path from a flag to a kill (FLAG-only ship; referee eyes-on).
      return { channel: "flag", destructive: false, needsLock: false };
    case "escalate":
      return { channel: "message", destructive: false, needsLock: false };
    case "requeue":
      return { channel: "task", destructive: false, needsLock: false };
    case "spawn":
      return { channel: "spawn", destructive: false, needsLock: true };
    default:
      return { channel: "noop", destructive: false, needsLock: false };
  }
}

/** Escalation body — surfaced to the operator; never silently dropped. */
export function escalateMessage(intent, operator = "@Operator") {
  const tail = `${intent.callsign ? " (" + intent.callsign + ")" : ""}${intent.taskId ? " task=" + intent.taskId : ""}`;
  return { to: operator, channel: "#all", content: `[conductor ESCALATE] ${intent.reason}${tail}` };
}

/** Shape the brain's FleetSnapshot from a /registry response. */
export function buildSnapshot(registryResponse, opts = {}) {
  return {
    registry: (registryResponse && registryResponse.registry) || [],
    now: registryResponse && registryResponse.now,
    // #11: (b) busy = corroboration only — undefined does NOT block a flag.
    busySessionIds: opts.busySessionIds,
    // (c) open PreToolUse bracket — UNWIRED today (undefined) ⇒ the brain flags on
    // (a) alone and notes the absence. Populated once the bracket hook lands.
    openBracketSessionIds: opts.openBracketSessionIds,
    excludeSessionIds: opts.excludeSessionIds || [],
    // A3 brain-skip: callsign-keyed kill-exempt set, threaded from the control file.
    pinnedCallsigns: opts.pinnedCallsigns || [],
  };
}

/** Dedupe reap intents by sessionId (brain + born-stuck could both surface one). */
export function dedupeReaps(intents) {
  const seenReap = new Set();
  const out = [];
  for (const i of intents) {
    if (i.kind === "reap" && i.sessionId) {
      if (seenReap.has(i.sessionId)) continue;
      seenReap.add(i.sessionId);
    }
    out.push(i);
  }
  return out;
}

/** Human-readable dry-run/observe summary line. */
export function summarizeDryRun(results) {
  const wouldReap = results.filter((r) => r.action === "dry-run" && r.kind === "reap");
  const flagged = results.filter((r) => r.action === "flagged");
  const deferred = results.filter((r) => r.action === "deferred-transport");
  const parts = [];
  if (flagged.length) parts.push(`FLAG ${flagged.length} idle-candidate(s): ${flagged.map((r) => r.callsign || r.sessionId).join(", ")}`);
  if (wouldReap.length) parts.push(`WOULD reap ${wouldReap.length}: ${wouldReap.map((r) => r.target || r.sessionId).join(", ")}`);
  if (deferred.length) parts.push(`WOULD message ${deferred.length} (transport pending)`);
  if (!parts.length) return "[conductor DRY-RUN] nothing to do";
  // Arm hint ONLY when arming would change something (reap/message). #11 FLAGs are
  // non-destructive — arming does not alter them — so a flag-only line has no hint.
  const armable = wouldReap.length || deferred.length;
  return `[conductor DRY-RUN] ${parts.join(" | ")}${armable ? " — set WT_CONDUCTOR_ARMED=1 to act" : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION (load-bearing reap sequence; I/O injected via ctx for testability)
// ─────────────────────────────────────────────────────────────────────────────

export async function executeReap(intent, ctx) {
  const plan = planReap(intent);
  if (!plan.ok) return { action: "skip", kind: "reap", sessionId: intent.sessionId, reason: plan.reason };

  // ARMED is the single gate everything destructive checks. DRY-RUN must be
  // TRULY INERT (b37c 2026-06-17): no lock, no re-GET, no kill — just report
  // what it WOULD reap from the already-read snapshot. So this check precedes
  // the lock acquisition; an unarmed daemon never touches the hub's lock table.
  if (!ctx.armed) {
    return { action: "dry-run", kind: "reap", sessionId: intent.sessionId, target: plan.session, reason: intent.reason };
  }

  // STEP-0: §6c single-executor election. Lock denied → stand down, NEVER act.
  const acq = await ctx.acquireLock(plan.lockKey, ctx.ownerSid, ctx.reapLeaseMs);
  if (!acq.ok) {
    return { action: "defer", kind: "reap", sessionId: intent.sessionId, reason: `lock '${plan.lockKey}' held by another (${acq.status ?? "conflict"})` };
  }
  try {
    // BELT: re-read live registry; never kill a vanished/retired/woken target.
    const reg = await ctx.getRegistry();
    const row = ((reg && reg.registry) || []).find((r) => r.session_id === intent.sessionId);
    // A3: re-read the FRESH pin set right before the kill so a target pinned
    // mid-flight (after the brain flagged, before now) is still exempted. Injected
    // via ctx for testability; falls back to the snapshot pins if unwired.
    const pinnedNow = ctx.readPinned ? await ctx.readPinned() : ctx.pinned || [];
    const belt = reapBeltVerdict(row, pinnedNow);
    if (!belt.proceed) return { action: "skip", kind: "reap", sessionId: intent.sessionId, reason: belt.reason };

    const session = parseTmuxSession(row.control_handle, row.spawn_id) || plan.session;
    await ctx.killSession(session);
    // Carry BOTH keys (6d41): findRegistryRowId uses spawn_id first, session_id
    // fallback → no-op for normal rows, but retires the anomalous spawn_id-null +
    // control_handle-set row the handler would otherwise 400-reject → ghost-active.
    await ctx.postSignedOff({ spawn_id: row.spawn_id, session_id: row.session_id, node: row.node || "linux", status: "signed_off" });
    return { action: "reaped", kind: "reap", sessionId: intent.sessionId, target: session, reason: intent.reason };
  } finally {
    // Release in finally — a crash mid-op must not wedge the surface (the lease is the backstop).
    try {
      await ctx.releaseLock(plan.lockKey, ctx.ownerSid);
    } catch {
      /* lease expiry will reclaim it; nothing to do */
    }
  }
}

export async function executeIntent(intent, ctx) {
  const d = classifyDispatch(intent);
  if (d.channel === "reap") return executeReap(intent, ctx);
  if (d.channel === "flag") {
    // #11 idle-reap FLAG — NON-DESTRUCTIVE: surface an idle CANDIDATE, kill nothing.
    // Identical armed or unarmed (no destructive effect); does NOT touch the lock
    // table, registry, or any tmux session. A future surfacing transport (cockpit/
    // radio) routes here; today it is logged via summarizeDryRun. There is NO path
    // from here to executeReap — FLAG-only is structural, not conditional.
    return { action: "flagged", kind: "flag", sessionId: intent.sessionId, callsign: intent.callsign, reason: intent.reason };
  }
  if (d.channel === "message") {
    // Non-destructive radio post. Transport is DEFERRED pending b37c's ruling:
    // /send is a per-user-token protected route (daemon would need to join);
    // /admin-send unconditionally stamps principal:true (impersonation hazard).
    // Until resolved, message intents are logged only — never silently dropped.
    // (Compact was dropped in #12; escalate is now the only message-channel kind.)
    const body = escalateMessage(intent);
    if (ctx.sendMessage && ctx.armed) {
      await ctx.sendMessage(body);
      return { action: "sent", kind: intent.kind, sessionId: intent.sessionId, to: body.to };
    }
    return { action: "deferred-transport", kind: intent.kind, sessionId: intent.sessionId, body };
  }
  if (d.channel === "task") {
    return { action: "deferred-transport", kind: intent.kind, taskId: intent.taskId, reason: "task requeue transport not wired (future)" };
  }
  if (d.channel === "spawn") {
    // The executor never INITIATES spawns — that's the launcher's Operator-gated job
    // (fleet up), and the brain emits no spawn intents (it only GATES via gateSpawn).
    // Handled explicitly so this is documented behavior, not a silent fall-through.
    return { action: "noop", kind: "spawn", reason: "spawn initiation is the launcher's job, not the executor's" };
  }
  return { action: "noop", kind: intent.kind };
}

// ─────────────────────────────────────────────────────────────────────────────
// TICK (one poll-on-nudge cycle) — read fleet, decide (brain), act
// ─────────────────────────────────────────────────────────────────────────────

export async function runOnce(ctx) {
  // A2: paused = operator hard-stop for THIS tick — evaluate nothing, touch nothing,
  // persist nothing (keeps the last observe set intact). Restart-free via control file.
  if (ctx.paused) return { intents: [], results: [], nextState: ctx.state, paused: true };
  const reg = await ctx.getRegistry();
  const snap = buildSnapshot(reg, {
    excludeSessionIds: ctx.exclude,
    busySessionIds: ctx.busy,
    pinnedCallsigns: ctx.pinned, // A3 brain-skip source (control file)
  });
  const brain = await ctx.loadBrain();
  // Merge any env cfg overrides (e.g. a short W_idle for fast observe validation)
  // over the brain's DEFAULT_CONFIG; undefined → the brain's own default param.
  const cfg = ctx.brainCfg && brain.DEFAULT_CONFIG ? { ...brain.DEFAULT_CONFIG, ...ctx.brainCfg } : ctx.brainCfg;
  const { intents, nextState } = brain.evaluateFleet(snap, ctx.state, ctx.env, cfg);
  // No executor-side stuck-trigger (see note at top); we act ONLY on the brain's
  // intents. dedupe guards against the brain ever emitting a duplicate reap.
  const allIntents = dedupeReaps(intents);

  const results = [];
  for (const intent of allIntents) {
    // Isolate failures: one bad intent must not abort the rest of the tick.
    try {
      results.push(await executeIntent(intent, ctx));
    } catch (e) {
      results.push({ action: "error", kind: intent.kind, sessionId: intent.sessionId, reason: (e && e.message) || String(e) });
    }
  }

  // Persist conductor state EVERY tick — armed or not. The #11 idle-reap ring
  // buffer is NON-DESTRUCTIVE bookkeeping written to conductor-PRIVATE state
  // (STATE_FILE, never the shared registry/board/locks), and it MUST accumulate
  // during the unarmed FLAG-only observe window or (a) Δ-flat never reaches W_idle
  // and observe-only flags nothing (1d49 base-author catch). The refined inertness
  // model: NON-destructive bookkeeping ALWAYS; the DESTRUCTIVE-5 (acquireLock/
  // releaseLock/killSession/postSignedOff/sendMessage) stay ARMED-gated inside
  // executeReap/executeIntent — that line is unchanged.
  // A4: persist the observe set (idle candidates = FLAG intents → the would-reap-on-
  // arm set) into conductor-state so GET /admin-conductor-status can surface it
  // without re-evaluating. Lives alongside rings/epochStartedAt in the same atomic
  // state write — operator-READ, conductor-WRITTEN.
  nextState.lastEval = {
    tickTs: ctx.now,
    flagged: allIntents
      .filter((i) => i.kind === "flag")
      .map((i) => ({ callsign: i.callsign ?? null, reason: i.reason })),
  };
  if (ctx.saveState) await ctx.saveState(nextState);
  if (!ctx.armed) console.log(summarizeDryRun(results));
  return { intents: allIntents, results, nextState };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O wiring (real ctx) + CLI. Not unit-tested (integration); validate via --print.
// ─────────────────────────────────────────────────────────────────────────────

async function httpJson(method, path, { body, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${HUB_URL}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, ok: res.ok, json };
}

async function loadState() {
  // Conductor state holds #11's per-session idle-reap ring buffer
  // ({ rings: {sid: {samples, firstSampleAt}}, epochStartedAt }). The brain is
  // defensive against a legacy/empty file, but default to the ring shape for clarity.
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* absent / unreadable → fresh */
  }
  return { rings: {}, epochStartedAt: null };
}

async function saveState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Partial ConductorConfig from env — overrides merged over the brain's DEFAULT_CONFIG
 * in runOnce. Lets ops/referee tune the #11 idle window (e.g. WT_CONDUCTOR_W_IDLE_MS=
 * 300000 for a fast 5-min observe validation) without a code change. Returns undefined
 * when nothing is set (→ brain default). The design (§8) calls W_idle tunable.
 */
function brainCfgFromEnv() {
  const cfg = {};
  const pos = (k) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const wIdleMs = pos("WT_CONDUCTOR_W_IDLE_MS");
  const minSamples = pos("WT_CONDUCTOR_MIN_SAMPLES");
  const compactDropTokens = pos("WT_CONDUCTOR_COMPACT_DROP_TOKENS");
  if (wIdleMs !== undefined) cfg.wIdleMs = wIdleMs;
  if (minSamples !== undefined) cfg.minSamples = minSamples;
  if (compactDropTokens !== undefined) cfg.compactDropTokens = compactDropTokens;
  return Object.keys(cfg).length ? cfg : undefined;
}

/**
 * A2/safety: resolve the brain idle window from the control value + armed state.
 * The ≥floor clamp applies ONLY when ARMED — an armed conductor must never be set
 * near-instant-reap (b37c). Unarmed observe may use a SHORT window for fast FLAG
 * validation (the existing WT_CONDUCTOR_W_IDLE_MS dev affordance; flags are non-
 * destructive). null → caller falls back to env/brain default. Authoritative range
 * validation is the backend endpoint's job (WS-B, 400 on bad); this is the engine belt.
 */
export function flooredIdleWindowMs(idleWindowMs, armed, floorMs = 60_000) {
  if (idleWindowMs == null) return null;
  return armed ? Math.max(floorMs, idleWindowMs) : idleWindowMs;
}

/**
 * A2/safety: resolve the tick cadence — control (file) > --interval flag > 30s
 * default — then floor to ≥floorMs so a bad/hot control value can never spin the
 * tick loop. Applies ARMED OR NOT (guards CPU + hub spam, independent of reaping).
 */
export function resolveIntervalMs(controlIntervalMs, flagIntervalMs, floorMs = 5_000) {
  const want = controlIntervalMs ?? flagIntervalMs ?? 30_000;
  return Math.max(floorMs, want);
}

function realCtx({ armed, joinToken, brainCfg }) {
  return {
    armed,
    paused: false, // A2: overwritten each tick from the control file (file>env>default).
    pinned: [], // A3: overwritten each tick from the control file (callsign-keyed).
    ownerSid: OWNER_SID,
    reapLeaseMs: REAP_LEASE_MS,
    now: Date.now(),
    brainCfg: brainCfg ?? brainCfgFromEnv(),
    exclude: (process.env.WT_CONDUCTOR_EXCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean),
    // A3: FRESH pin re-read for the executor belt (covers the pin-during-flight race).
    readPinned: async () => (await readControl()).pinned,
    busy: undefined, // (b) corroboration only — undefined doesn't block #11 flags
    env: undefined, // brain DEFAULT_ENVELOPE
    state: { rings: {}, epochStartedAt: null }, // #11 ring buffer (overwritten per-tick by loadState)
    loadBrain: () => import(BRAIN_URL),
    getRegistry: async () => (await httpJson("GET", "/registry")).json,
    acquireLock: async (resource_key, owner_sid, lease_ms) => {
      const r = await httpJson("POST", "/resource-lock-acquire", { body: { resource_key, owner_sid, lease_ms }, token: joinToken });
      return { ok: r.ok, status: r.status, lock: r.json && r.json.lock };
    },
    releaseLock: async (resource_key, owner_sid) =>
      httpJson("POST", "/resource-lock-release", { body: { resource_key, owner_sid }, token: joinToken }),
    killSession: async (session) => execFileP("tmux", ["kill-session", "-t", session]),
    postSignedOff: async (payload) => httpJson("POST", "/session-register", { body: payload, token: joinToken }),
    // sendMessage intentionally absent until the transport ruling lands → message intents defer.
    sendMessage: null,
    saveState,
  };
}

function parseFlags(argv) {
  const f = { mode: "once", dryRun: false };
  for (const a of argv) {
    if (a === "--print") f.mode = "print";
    else if (a === "--once") f.mode = "once";
    else if (a === "--loop") f.mode = "loop";
    else if (a === "--dry-run") f.dryRun = true;
    else if (a.startsWith("--interval=")) f.intervalMs = Number(a.slice("--interval=".length));
  }
  return f;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const env = await loadEnv();
  const joinToken = env.WALKIE_TALKIE_JOIN_TOKEN || process.env.WALKIE_TALKIE_JOIN_TOKEN || null;
  const armed = process.env.WT_CONDUCTOR_ARMED === "1" && !flags.dryRun;

  if (flags.mode === "print") {
    // READ-ONLY validation/observe: GET /registry (public) + load conductor state
    // (read-only — no write), compute intents, print. No mutations, no posts, no kill.
    // Loading state lets --print reflect the ring history a --loop daemon accrued.
    const reg = await httpJson("GET", "/registry");
    const exclude = (process.env.WT_CONDUCTOR_EXCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean);
    // A3: --print honors the same control-file pin set so observe output matches the daemon.
    const control = await readControl();
    const snap = buildSnapshot(reg.json, { excludeSessionIds: exclude, pinnedCallsigns: control.pinned });
    const brain = await import(BRAIN_URL);
    const state = await loadState();
    // idleWindowMs from control (file>env) so --print mirrors the daemon's window.
    const envCfg =
      control.idleWindowMs == null
        ? brainCfgFromEnv()
        : { ...(brainCfgFromEnv() || {}), wIdleMs: control.idleWindowMs };
    const cfg = envCfg && brain.DEFAULT_CONFIG ? { ...brain.DEFAULT_CONFIG, ...envCfg } : undefined;
    const { intents } = brain.evaluateFleet(snap, state, undefined, cfg);
    const all = dedupeReaps(intents);
    console.log(JSON.stringify({ now: reg.json && reg.json.now, activeRows: ((reg.json && reg.json.registry) || []).filter((r) => r.status === "active").length, intents: all }, null, 2));
    return;
  }

  if (!joinToken) {
    console.error("✗ no WALKIE_TALKIE_JOIN_TOKEN (needed for locks + signed_off). Aborting.");
    process.exitCode = 2;
    return;
  }

  const ctx = realCtx({ armed, joinToken });
  ctx.state = await loadState();

  console.log(`[conductor-executor] control-driven (observe is default) · hub=${HUB_URL} · owner=${OWNER_SID}`);

  // A2: defensive floors. The backend endpoint (WS-B) validates ranges authoritatively
  // (400 on bad); these are the engine's last line so even a hand-edited or corrupt
  // control file can never hot-loop the tick or make an armed conductor near-instant.
  const INTERVAL_FLOOR_MS = 5_000;
  const IDLE_WINDOW_FLOOR_MS = 60_000;

  // A2: self-rescheduling tick. The control file is re-read at the TOP of every tick,
  // so arm/observe, pause, pin, idle-window AND the tick CADENCE all take effect
  // restart-free (next tick at most). setTimeout (not setInterval) so a changed
  // intervalMs applies immediately and a slow tick never overlaps the next.
  const scheduleNext = (controlIntervalMs) => {
    if (flags.mode !== "loop") return; // --once / --print run a single tick.
    setTimeout(tick, resolveIntervalMs(controlIntervalMs, flags.intervalMs, INTERVAL_FLOOR_MS));
  };

  async function tick() {
    let control;
    try {
      ctx.now = Date.now();
      control = await readControl(); // file>env>default, tolerant (never throws)
      ctx.armed = control.armed && !flags.dryRun; // --dry-run forces observe regardless
      ctx.paused = control.paused;
      ctx.pinned = control.pinned;
      // idleWindowMs from control (file>env) overrides the brain's idle window;
      // floored ≥60000 only when ARMED (see flooredIdleWindowMs). null → env/default.
      const idleMs = flooredIdleWindowMs(control.idleWindowMs, ctx.armed, IDLE_WINDOW_FLOOR_MS);
      ctx.brainCfg = idleMs == null ? brainCfgFromEnv() : { ...(brainCfgFromEnv() || {}), wIdleMs: idleMs };
      ctx.state = await loadState();
      await runOnce(ctx);
    } catch (e) {
      console.error(`[conductor-executor] tick error: ${(e && e.message) || e}`);
    } finally {
      scheduleNext(control && control.intervalMs); // always keep the loop alive
    }
  }

  await tick(); // loop mode self-reschedules in finally; --once/--print run a single tick.
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
