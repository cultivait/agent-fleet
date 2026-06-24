// hub/src/conductor.ts
//
// WS5 conductor — pure decision module (the "brain").
//
// The conductor DECIDES and EMITS intents; it executes nothing. A non-agent
// executor (fleet.mjs / cron / pm2) carries out the intents. This split is
// load-bearing: a Claude conductor cannot autonomously execute ring-2 ops when
// authorization arrives over radio (a tool RESULT) rather than a user turn —
// the auto-mode classifier wall, witnessed 2026-06-17 (see WS5 design doc §6).
// Keeping this module pure (no I/O, `now` passed in) makes the entire state
// machine deterministic and unit-testable, and lets either a skill-following
// Claude conductor OR a non-agent daemon consume the same decisions.
//
// Cross-refs: WS5 design doc c0b6-ws5-conductor-design.md §3/§4/§6/§6c/§9;
// #11 temporal-liveness doc c0b6-ws11-temporal-liveness-design.md (this file
// implements the SHIP half: idle-reap FLAG-ONLY).
//
// #11 IDLE-REAP (this increment) — the SHIP-now, FLAG-ONLY half:
//   • SIGNAL is Δ-ACROSS-RING-SAMPLES on context_ts (change-detection), NEVER
//     `now − context_ts` (that re-introduces the snapshot-staleness bug that
//     killed born-stuck, and breaks under 3-node clock skew). The executor
//     samples the registry each tick into a per-session ring; this module reads
//     the ring and asks only "did context_ts CHANGE between our samples?".
//   • A FLAG is NON-DESTRUCTIVE — it surfaces an idle CANDIDATE to the operator,
//     kills nothing. There is NO kill path here. Auto-kill is DEFERRED behind an
//     operator-gated hook (PreToolUse bracket) + a held/pinned concept (doc §4/§10).
//   • (a) flat-Δ over W_idle is the core; (b) "no open task" is DEMOTED to
//     corroboration (vacuous for this fleet — ~all working agents claim no
//     radio_task); (c) "no open bracket" is a PLUGGABLE input, ABSENT until the
//     bracket hook lands → today it flags on (a) alone, which DELIBERATELY flags
//     held-reserves + long-foreground agents: that observe-only signal is the
//     evidence that (c) + a held concept are required before any kill arms.
//   • UNKNOWN is a first-class verdict: warm-up, producer-less, sparse window,
//     and compact/restart straddle all read UNKNOWN ⇒ no flag. Absence of data
//     is NEVER evidence of idle.

import type { RegistryEntry } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Envelope — the operator's sanctioned limits. One of the TWO places the envelope lives
// (§7): the policy numbers here, the permission-mode allowlist at the executor.
// ─────────────────────────────────────────────────────────────────────────────
export interface Envelope {
  /** CAP — max concurrent autonomous spawns (counted from registry active rows). */
  cap: number;
  /** AUTO-COMPACT trigger — ABSOLUTE token count, not a model-limit %. */
  autoCompactTokens: number;
  /** MAX-RETRY — after this many failed attempts, escalate to the operator (never silently drop). */
  maxRetry: number;
}

export const DEFAULT_ENVELOPE: Envelope = {
  cap: 5,
  autoCompactTokens: 400_000,
  maxRetry: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// Conductor tuning — separate from the operator's envelope (these are mechanism, not policy).
// #11 idle-reap parameters (doc §8). W_idle is a NOISE knob, not a safety
// mechanism — the safety guard is FLAG-ONLY + handle-gating (doc §3.1/§4).
// ─────────────────────────────────────────────────────────────────────────────
export interface ConductorConfig {
  /** Idle flat window: context_ts must be UNCHANGED across samples spanning ≥ this. */
  wIdleMs: number;
  /** Minimum self-observed ring samples before any flat verdict (warm-up floor). */
  minSamples: number;
  /** Ring retention margin — evict samples older than wIdleMs + this. */
  ringMarginMs: number;
  /** Hard cap on ring length (memory bound; keeps newest). */
  maxRingSamples: number;
  /**
   * Straddle heuristic (Gap B): a single-sample context_tokens DROP ≥ this ⇒
   * probable /compact ⇒ reset the session's ring to warm-up (fail-safe → UNKNOWN).
   */
  compactDropTokens: number;
}

export const DEFAULT_CONFIG: ConductorConfig = {
  wIdleMs: 60 * 60_000, // 60 min — noise knob; idle-reap is non-urgent (doc §8).
  minSamples: 3,
  ringMarginMs: 10 * 60_000,
  maxRingSamples: 512,
  compactDropTokens: 50_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Lock keys for §6c single-executor election. The executor MUST radio_lock_acquire
// the relevant key as STEP-0 before any mutation, and release in a `finally`.
// (No flag intent needs a lock — flagging is non-destructive. Locks matter only
// when the armed reap trigger lands.)
// ─────────────────────────────────────────────────────────────────────────────
export const LOCK_DEPLOY_HUB = "deploy:fleet-hub";
export const LOCK_SPAWN_FLEET = "spawn:fleet";
/** Per-target reap lock so two conductors never reap the same agent (§6c). */
export function lockKeyForReap(sessionId: string): string {
  return `reap:${sessionId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intents — the conductor's only output. Classifier/lock metadata is inline so
// the executor can mechanically decide how to act (or refuse) per §6/§6c.
// "flag" is the #11 SHIP-now idle-reap output: NON-DESTRUCTIVE, classifierRisk
// "none", no lock — the executor surfaces it and kills nothing. "reap" stays in
// the union (the executor still handles it) for the future armed reap trigger.
// ─────────────────────────────────────────────────────────────────────────────
export type IntentKind = "reap" | "spawn" | "requeue" | "escalate" | "flag";

export type ClassifierRisk = "none" | "low" | "high" | "always-blocked";

export interface Intent {
  kind: IntentKind;
  reason: string;
  // Target identity — registry-driven + TARGETED (§9), never a sweep.
  sessionId?: string | null;
  spawnId?: string | null;
  callsign?: string | null;
  controlHandle?: string | null; // e.g. "tmux:wt-<rid>" — exactly what the executor kills.
  taskId?: string | null;
  // §6 decision/execution split + §6c single-executor election (machine-readable).
  classifierRisk: ClassifierRisk;
  /** resource_key to radio_lock_acquire as STEP-0 before mutating; null = no lock needed. */
  requiresLock: string | null;
  /** true = the TARGET self-executes on its own session (e.g. /compact) — no executor mutation. */
  cooperativeSelf: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conductor state — carried between evaluations. #11 threads a per-session ring
// buffer of (sampledAt, context_ts, context_tokens) here. The executor PERSISTS
// this EVERY tick (even unarmed) because the ring is non-destructive bookkeeping
// that must accumulate during the FLAG-only observe window (1d49 base-author
// catch) — only the destructive ACTIONS stay ARMED-gated.
// ─────────────────────────────────────────────────────────────────────────────
export interface RingSample {
  /** OUR observation time (the executor/brain wall clock at GET /registry). */
  sampledAt: number;
  /** context_ts as reported by the registry (client gauge clock), or null. */
  contextTs: number | null;
  /** context_tokens at that sample, or null (used only for the straddle heuristic). */
  contextTokens: number | null;
}

export interface SessionRing {
  samples: RingSample[];
  /** When we FIRST observed this session — the warm-up basis (with epochStartedAt). */
  firstSampleAt: number;
}

export interface ConductorState {
  /** Per-session_id ring buffer. */
  rings: Record<string, SessionRing>;
  /** Daemon/brain epoch boot marker — restart zeroes the self-observed window (doc §5/#6). */
  epochStartedAt: number | null;
}

export const EMPTY_STATE: ConductorState = { rings: {}, epochStartedAt: null };

// ─────────────────────────────────────────────────────────────────────────────
// Ring maintenance (pure) — append the current sample, evict, and detect a
// compact/restart straddle (Gap B). Exported for unit test.
// ─────────────────────────────────────────────────────────────────────────────
export function appendSample(
  prior: SessionRing | undefined,
  sample: RingSample,
  cfg: ConductorConfig = DEFAULT_CONFIG,
): SessionRing {
  if (!prior || prior.samples.length === 0) {
    return { samples: [sample], firstSampleAt: sample.sampledAt };
  }
  // Straddle (Gap B): a large context_tokens DROP ⇒ probable /compact ⇒ reset the
  // ring to a single fresh sample so the session re-enters warm-up (fail-safe → UNKNOWN).
  const prev = prior.samples[prior.samples.length - 1];
  if (
    prev.contextTokens != null &&
    sample.contextTokens != null &&
    prev.contextTokens - sample.contextTokens >= cfg.compactDropTokens
  ) {
    return { samples: [sample], firstSampleAt: sample.sampledAt };
  }
  const horizon = sample.sampledAt - (cfg.wIdleMs + cfg.ringMarginMs);
  const kept = prior.samples.filter((s) => s.sampledAt >= horizon);
  kept.push(sample);
  const trimmed = kept.length > cfg.maxRingSamples ? kept.slice(kept.length - cfg.maxRingSamples) : kept;
  return { samples: trimmed, firstSampleAt: prior.firstSampleAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Idle verdict (pure) — HEALTHY / HEALTHY-IDLE / UNKNOWN from the ring + corroborators.
// CHANGE-DETECTION ONLY: context_ts is compared to its OWN prior sampled value;
// the window is measured in sampledAt deltas. There is ZERO `now − context_ts`
// math anywhere — that is the non-negotiable Gap-E rule (doc §2).
// bracketOpen: true = inside a tool (not idle); false = confirmed not-in-tool;
// null = the bracket signal is UNWIRED → flag on (a) alone with a note (doc §3.2).
// ─────────────────────────────────────────────────────────────────────────────
export type IdleVerdict = "HEALTHY" | "HEALTHY-IDLE" | "UNKNOWN";

export interface VerdictResult {
  verdict: IdleVerdict;
  reason: string;
}

export function idleVerdict(
  ring: SessionRing | undefined,
  now: number,
  epochStartedAt: number | null,
  cfg: ConductorConfig = DEFAULT_CONFIG,
  opts: { busy?: boolean; bracketOpen?: boolean | null } = {},
): VerdictResult {
  const samples = ring?.samples ?? [];

  // Warm-up gate (cold-start + post-restart, doc §5/#6,#7): require ≥ minSamples
  // AND ≥ wIdleMs of SELF-OBSERVED time since the later of (epoch boot, first sample).
  const observedSince = Math.max(epochStartedAt ?? now, ring?.firstSampleAt ?? now);
  if (samples.length < cfg.minSamples || now - observedSince < cfg.wIdleMs) {
    return { verdict: "UNKNOWN", reason: "warm-up: insufficient self-observed history" };
  }

  // Window = samples within wIdleMs of now (measured purely in sampledAt — one clock).
  const windowStart = now - cfg.wIdleMs;
  const win = samples.filter((s) => s.sampledAt >= windowStart);
  if (win.length < cfg.minSamples) {
    return { verdict: "UNKNOWN", reason: "sparse window: too few samples within W_idle" };
  }

  const nonNull = win.filter((s) => s.contextTs != null).map((s) => s.contextTs as number);
  if (nonNull.length < 2) {
    return { verdict: "UNKNOWN", reason: "producer-less: no context_ts gauge (null) — never inferred idle" };
  }

  // CHANGE-DETECTION: any inequality vs the first non-null value ⇒ advancing ⇒ HEALTHY.
  // (Inequality, not strict-increase — a backward NTP jump still proves the hook fired.)
  const advancing = nonNull.some((v) => v !== nonNull[0]);
  if (advancing) {
    return { verdict: "HEALTHY", reason: "context_ts advanced within W_idle (active)" };
  }

  // Flat. Corroborators that DEMOTE to UNKNOWN (never flag), in priority order:
  if (opts.busy === true) {
    return { verdict: "UNKNOWN", reason: "flat but has an open claimed task — not idle (b: corroboration)" };
  }
  if (opts.bracketOpen === true) {
    return { verdict: "UNKNOWN", reason: "flat but inside a tool (open bracket) — not idle (c)" };
  }

  const flatMin = Math.round((now - win[0].sampledAt) / 60_000);
  const bracketNote =
    opts.bracketOpen == null ? " [bracket signal UNWIRED — flagged on (a) alone; held-reserve/foreground may appear here]" : "";
  return {
    verdict: "HEALTHY-IDLE",
    reason: `idle-candidate: context_ts flat ~${flatMin}m across ${win.length} samples; no open task${bracketNote}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent-lifecycle evaluation (§3a, §4) + #11 idle-reap (FLAG-only).
// ─────────────────────────────────────────────────────────────────────────────
export interface FleetSnapshot {
  registry: RegistryEntry[];
  now: number;
  /**
   * session_ids with an open claimed/in_progress task. #11 DEMOTES this to
   * corroboration (doc §3.3): a known task forces a flat session to UNKNOWN
   * (adds caution), but its ABSENCE never blocks a flag — safety rests on
   * (a) Δ-flat + (c) bracket + handle-gating, not on this near-vacuous signal.
   */
  busySessionIds?: string[];
  /**
   * (c) — session_ids currently INSIDE a tool (open PreToolUse bracket). UNWIRED
   * until the bracket hook lands; when undefined, the brain flags on (a) alone
   * and notes the absence. A session in this set is never flagged idle.
   */
  openBracketSessionIds?: string[];
  /** Never flag/reap these (the conductor's own session, the operator's session). */
  excludeSessionIds?: string[];
  /**
   * A3 kill-exempt PIN set — by CALLSIGN (operator-facing + stable; sid churns on
   * reconnect). The operator pins via the control file; the executor threads it here.
   * Pinned sessions are still SAMPLED (history accrues, like exclude) but NEVER flagged,
   * so they are never reaped. This is the LOAD-BEARING half of belt-and-suspenders
   * (the executor refuses too); both keyed on callsign.
   */
  pinnedCallsigns?: string[];
}

export interface EvalResult {
  intents: Intent[];
  nextState: ConductorState;
  activeCount: number; // registry status === "active" — the §9 CAP basis.
  capRemaining: number;
}

function isActive(e: RegistryEntry): boolean {
  return e.status === "active";
}

export function evaluateFleet(
  snap: FleetSnapshot,
  state: ConductorState = EMPTY_STATE,
  env: Envelope = DEFAULT_ENVELOPE,
  cfg: ConductorConfig = DEFAULT_CONFIG,
): EvalResult {
  const { registry, now } = snap;
  const exclude = new Set(snap.excludeSessionIds ?? []);
  const pinned = new Set(snap.pinnedCallsigns ?? []); // A3: callsign-keyed kill-exempt
  const busy = snap.busySessionIds ? new Set(snap.busySessionIds) : null;
  const bracket = snap.openBracketSessionIds ? new Set(snap.openBracketSessionIds) : null;

  const intents: Intent[] = [];
  const active = registry.filter(isActive);
  const activeCount = active.length;
  const capRemaining = Math.max(0, env.cap - activeCount);

  // Thread + update the ring buffer (defensive against an empty/legacy state file).
  const epochStartedAt = state?.epochStartedAt ?? now;
  const rings: Record<string, SessionRing> = { ...(state?.rings ?? {}) };
  const activeSids = new Set<string>();

  for (const e of active) {
    const sid = e.session_id;
    if (!sid) continue; // cannot track/target a session with no id.
    activeSids.add(sid);

    // Always sample (history accrues even for excluded sessions); flag only non-excluded.
    rings[sid] = appendSample(
      rings[sid],
      { sampledAt: now, contextTs: e.context_ts ?? null, contextTokens: e.context_tokens ?? null },
      cfg,
    );
    if (exclude.has(sid)) continue;
    // A3 (load-bearing): pinned callsigns are kill-exempt — sampled above (history
    // accrues for an eventual unpin) but never flagged, so the brain never proposes
    // a reap for them. callsign may be null (unjoined) → cannot be pinned.
    if (e.callsign && pinned.has(e.callsign)) continue;

    const v = idleVerdict(rings[sid], now, epochStartedAt, cfg, {
      busy: busy ? busy.has(sid) : false,
      bracketOpen: bracket ? bracket.has(sid) : null,
    });
    if (v.verdict === "HEALTHY-IDLE") {
      intents.push(flagIntent(e, v.reason));
    }
  }

  // Prune rings for sessions no longer active (signed_off / left the registry).
  for (const sid of Object.keys(rings)) {
    if (!activeSids.has(sid)) delete rings[sid];
  }

  return {
    intents,
    nextState: { rings, epochStartedAt },
    activeCount,
    capRemaining,
  };
}

/** #11 idle FLAG — NON-DESTRUCTIVE: surfaced to the operator, kills nothing, needs no lock. */
function flagIntent(e: RegistryEntry, reason: string): Intent {
  return {
    kind: "flag",
    reason,
    sessionId: e.session_id,
    spawnId: e.spawn_id,
    callsign: e.callsign,
    controlHandle: e.control_handle,
    classifierRisk: "none",
    requiresLock: null,
    cooperativeSelf: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn CAP gate (§9 / §5) — count registry ACTIVE rows, NOT local tmux. The
// fleet launcher currently counts local `wt-*` sessions, which is only correct
// for a single launcher; this is the node-agnostic basis.
// ─────────────────────────────────────────────────────────────────────────────
export interface SpawnGate {
  allowed: number; // how many of `requested` may spawn under CAP.
  denied: number;
  capRemaining: number;
}

export function gateSpawn(
  requested: number,
  activeCount: number,
  env: Envelope = DEFAULT_ENVELOPE,
): SpawnGate {
  const capRemaining = Math.max(0, env.cap - activeCount);
  const allowed = Math.max(0, Math.min(requested, capRemaining));
  return { allowed, denied: Math.max(0, requested - allowed), capRemaining };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task-lifecycle (§3b) — the verify gate. `review` IS the verify slot; work is
// not `done` until an independent check passes. On verify-fail: requeue while
// under MAX-RETRY, escalate at MAX-RETRY (never silently drop).
// ─────────────────────────────────────────────────────────────────────────────
export interface TaskSnapshot {
  taskId: string;
  status: string; // "ready" | "claimed" | "in_progress" | "review" | "done"
  verifyFailures: number; // times this task has failed the review/verify gate.
}

export function evaluateTaskRetries(tasks: TaskSnapshot[], env: Envelope = DEFAULT_ENVELOPE): Intent[] {
  const intents: Intent[] = [];
  for (const t of tasks) {
    if (t.verifyFailures <= 0) continue; // hasn't failed verify → nothing to do.
    if (t.verifyFailures < env.maxRetry) {
      intents.push({
        kind: "requeue",
        reason: `verify failed ${t.verifyFailures}× (< ${env.maxRetry}) → requeue to ready`,
        taskId: t.taskId,
        classifierRisk: "none",
        requiresLock: null,
        cooperativeSelf: false,
      });
    } else {
      intents.push({
        kind: "escalate",
        reason: `verify failed ${t.verifyFailures}× (≥ MAX_RETRY ${env.maxRetry}) — escalate to the operator, do not silently drop`,
        taskId: t.taskId,
        classifierRisk: "none",
        requiresLock: null,
        cooperativeSelf: false,
      });
    }
  }
  return intents;
}
