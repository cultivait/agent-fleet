import { describe, expect, it } from "vitest";
import {
  appendSample,
  type ConductorConfig,
  DEFAULT_CONFIG,
  DEFAULT_ENVELOPE,
  EMPTY_STATE,
  evaluateFleet,
  evaluateTaskRetries,
  type FleetSnapshot,
  gateSpawn,
  idleVerdict,
  type SessionRing,
} from "../conductor.js";
import type { RegistryEntry } from "../types.js";

const NOW = 1_700_000_000_000;
const W = DEFAULT_CONFIG.wIdleMs; // 60 min
const FRESH_TS = NOW - 1_000;

function mkEntry(p: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    session_id: "s1",
    spawn_id: "sp1",
    callsign: "linux-s1",
    node: "linux",
    workdir: null,
    started_at: null,
    pid: null,
    control_handle: "tmux:wt-sp1",
    worktree_path: null,
    owned_branch: null,
    status: "active",
    last_standby_at: null,
    context_tokens: null,
    context_ts: null,
    ...p,
  };
}

function snap(registry: RegistryEntry[], extra: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return { registry, now: NOW, ...extra };
}

function ring(
  samples: { sampledAt: number; contextTs: number | null; contextTokens?: number | null }[],
  firstSampleAt?: number,
): SessionRing {
  return {
    samples: samples.map((s) => ({
      sampledAt: s.sampledAt,
      contextTs: s.contextTs,
      contextTokens: s.contextTokens ?? null,
    })),
    firstSampleAt: firstSampleAt ?? samples[0].sampledAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// idleVerdict — the temporal Δ-flat liveness core (#11). CHANGE-DETECTION ONLY;
// NEVER now − context_ts (Gap E). UNKNOWN is first-class.
// ─────────────────────────────────────────────────────────────────────────────
describe("idleVerdict — temporal Δ-flat liveness (#11)", () => {
  const epoch = NOW - W; // observed since before the window (warm-up satisfied)
  const flatRing = (ts: number | null): SessionRing =>
    ring(
      [
        { sampledAt: NOW - W, contextTs: ts, contextTokens: 100 },
        { sampledAt: NOW - W / 2, contextTs: ts, contextTokens: 100 },
        { sampledAt: NOW, contextTs: ts, contextTokens: 100 },
      ],
      NOW - W,
    );

  it("flat + bracket ABSENT (null) → HEALTHY-IDLE, flags on (a) alone with the UNWIRED note", () => {
    const v = idleVerdict(flatRing(1000), NOW, epoch, DEFAULT_CONFIG, { busy: false, bracketOpen: null });
    expect(v.verdict).toBe("HEALTHY-IDLE");
    expect(v.reason).toMatch(/UNWIRED/);
  });

  it("flat + bracket CLOSED (false) → HEALTHY-IDLE, no note", () => {
    const v = idleVerdict(flatRing(1000), NOW, epoch, DEFAULT_CONFIG, { busy: false, bracketOpen: false });
    expect(v.verdict).toBe("HEALTHY-IDLE");
    expect(v.reason).not.toMatch(/UNWIRED/);
  });

  it("flat + bracket OPEN (true) → UNKNOWN (inside a tool — not idle)", () => {
    const v = idleVerdict(flatRing(1000), NOW, epoch, DEFAULT_CONFIG, { busy: false, bracketOpen: true });
    expect(v.verdict).toBe("UNKNOWN");
  });

  it("flat + busy (true) → UNKNOWN (has an open claimed task; (b) corroboration demotes)", () => {
    const v = idleVerdict(flatRing(1000), NOW, epoch, DEFAULT_CONFIG, { busy: true, bracketOpen: null });
    expect(v.verdict).toBe("UNKNOWN");
  });

  it("advancing context_ts → HEALTHY (active, never idle)", () => {
    const r = ring(
      [
        { sampledAt: NOW - W, contextTs: 1000 },
        { sampledAt: NOW - W / 2, contextTs: 2000 },
        { sampledAt: NOW, contextTs: 3000 },
      ],
      NOW - W,
    );
    expect(idleVerdict(r, NOW, epoch, DEFAULT_CONFIG, { bracketOpen: null }).verdict).toBe("HEALTHY");
  });

  it("backward NTP jump still counts as advancing (inequality, not strict-increase)", () => {
    const r = ring(
      [
        { sampledAt: NOW - W, contextTs: 5000 },
        { sampledAt: NOW - W / 2, contextTs: 5000 },
        { sampledAt: NOW, contextTs: 4000 }, // jumped BACKWARD — still proves the hook fired
      ],
      NOW - W,
    );
    expect(idleVerdict(r, NOW, epoch, DEFAULT_CONFIG, { bracketOpen: null }).verdict).toBe("HEALTHY");
  });

  it("Δ-ONLY GUARD: advancing values that are ANCIENT by age → still HEALTHY (never now−context_ts)", () => {
    // If the code used now − context_ts staleness, these far-past timestamps would
    // read 'stale → idle'. Change-detection sees them CHANGING → alive → HEALTHY.
    const ancient = NOW - 10 * W;
    const r = ring(
      [
        { sampledAt: NOW - W, contextTs: ancient },
        { sampledAt: NOW - W / 2, contextTs: ancient + 1000 },
        { sampledAt: NOW, contextTs: ancient + 2000 },
      ],
      NOW - W,
    );
    expect(idleVerdict(r, NOW, epoch, DEFAULT_CONFIG, { bracketOpen: null }).verdict).toBe("HEALTHY");
  });

  it("Δ-ONLY GUARD: an ANCIENT but UNCHANGING gauge → HEALTHY-IDLE (flatness, not age, decides)", () => {
    const ancient = NOW - 10 * W;
    expect(idleVerdict(flatRing(ancient), NOW, epoch, DEFAULT_CONFIG, { bracketOpen: null }).verdict).toBe(
      "HEALTHY-IDLE",
    );
  });

  it("producer-less (all context_ts null) → UNKNOWN, NEVER idle", () => {
    const v = idleVerdict(flatRing(null), NOW, epoch, DEFAULT_CONFIG, { bracketOpen: null });
    expect(v.verdict).toBe("UNKNOWN");
    expect(v.reason).toMatch(/producer-less/);
  });

  it("warm-up: too few samples → UNKNOWN", () => {
    const r = ring([{ sampledAt: NOW, contextTs: 1000 }], NOW - W);
    const v = idleVerdict(r, NOW, epoch, DEFAULT_CONFIG, { bracketOpen: null });
    expect(v.verdict).toBe("UNKNOWN");
    expect(v.reason).toMatch(/warm-up/);
  });

  it("warm-up: enough samples but observed < W_idle → UNKNOWN (never infer flatness we didn't watch)", () => {
    const recent = NOW - 10 * 60_000; // first seen only 10 min ago
    const r = ring(
      [
        { sampledAt: recent, contextTs: 1000 },
        { sampledAt: recent + 60_000, contextTs: 1000 },
        { sampledAt: NOW, contextTs: 1000 },
      ],
      recent,
    );
    const v = idleVerdict(r, NOW, recent, DEFAULT_CONFIG, { bracketOpen: null });
    expect(v.verdict).toBe("UNKNOWN");
    expect(v.reason).toMatch(/warm-up/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// appendSample — ring maintenance + compact/restart straddle (Gap B).
// ─────────────────────────────────────────────────────────────────────────────
describe("appendSample — ring maintenance + straddle (#11 Gap B)", () => {
  it("appends to a fresh ring and seeds firstSampleAt", () => {
    const r = appendSample(undefined, { sampledAt: NOW, contextTs: 1, contextTokens: 10 }, DEFAULT_CONFIG);
    expect(r.samples).toHaveLength(1);
    expect(r.firstSampleAt).toBe(NOW);
  });

  it("evicts samples older than wIdleMs + margin", () => {
    const old = { sampledAt: NOW - (W + DEFAULT_CONFIG.ringMarginMs + 1000), contextTs: 1, contextTokens: 10 };
    const prior: SessionRing = { samples: [old], firstSampleAt: old.sampledAt };
    const r = appendSample(prior, { sampledAt: NOW, contextTs: 1, contextTokens: 10 }, DEFAULT_CONFIG);
    expect(r.samples).toHaveLength(1);
    expect(r.samples[0].sampledAt).toBe(NOW);
  });

  it("straddle: a large context_tokens DROP resets the ring to warm-up (fail-safe → UNKNOWN)", () => {
    const prior: SessionRing = {
      samples: [{ sampledAt: NOW - 1000, contextTs: 5, contextTokens: 200_000 }],
      firstSampleAt: NOW - 1000,
    };
    const r = appendSample(prior, { sampledAt: NOW, contextTs: 6, contextTokens: 100_000 }, DEFAULT_CONFIG); // −100k ≥ 50k
    expect(r.samples).toHaveLength(1);
    expect(r.firstSampleAt).toBe(NOW); // reset → re-warm-up
  });

  it("a small token decrease does NOT reset (normal fluctuation)", () => {
    const prior: SessionRing = {
      samples: [{ sampledAt: NOW - 1000, contextTs: 5, contextTokens: 200_000 }],
      firstSampleAt: NOW - 1000,
    };
    const r = appendSample(prior, { sampledAt: NOW, contextTs: 6, contextTokens: 199_000 }, DEFAULT_CONFIG); // −1k < 50k
    expect(r.samples).toHaveLength(2);
    expect(r.firstSampleAt).toBe(NOW - 1000);
  });

  it("caps ring length at maxRingSamples", () => {
    const cfg: ConductorConfig = { ...DEFAULT_CONFIG, maxRingSamples: 3, ringMarginMs: 1_000_000_000 };
    let r = appendSample(undefined, { sampledAt: NOW, contextTs: 1, contextTokens: 10 }, cfg);
    for (let i = 1; i < 6; i++) r = appendSample(r, { sampledAt: NOW + i, contextTs: 1, contextTokens: 10 }, cfg);
    expect(r.samples).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateFleet — idle-reap FLAG-only, end-to-end across ticks (#11).
// ─────────────────────────────────────────────────────────────────────────────
describe("evaluateFleet — idle-reap FLAG-only end-to-end (#11)", () => {
  // Feed `count` ticks across ≥ W_idle, threading nextState; return the last result.
  function ticks(reg: (now: number) => RegistryEntry[], opts: Partial<FleetSnapshot> = {}, count = 5) {
    let state = EMPTY_STATE;
    let res!: ReturnType<typeof evaluateFleet>;
    const step = W / (count - 1);
    for (let i = 0; i < count; i++) {
      const now = NOW + i * step;
      res = evaluateFleet({ registry: reg(now), now, ...opts }, state);
      state = res.nextState;
    }
    return res;
  }

  it("FLAGS a flat, not-busy agent after W_idle of unchanging context_ts — NON-destructive, NO kill path", () => {
    const r = ticks(
      () => [mkEntry({ session_id: "sx", control_handle: "tmux:wt-spx", context_ts: 5000, context_tokens: 100 })],
      {
        busySessionIds: [],
      },
    );
    const flags = r.intents.filter((i) => i.kind === "flag");
    expect(flags).toHaveLength(1);
    expect(flags[0].sessionId).toBe("sx");
    expect(flags[0].classifierRisk).toBe("none"); // non-destructive
    expect(flags[0].requiresLock).toBeNull(); // no lock
    expect(r.intents.some((i) => i.kind === "reap")).toBe(false); // FLAG-only: zero kill path
  });

  it("does NOT flag while context_ts keeps advancing (active agent)", () => {
    const r = ticks((now) => [mkEntry({ session_id: "sx", context_ts: now, context_tokens: 100 })], {
      busySessionIds: [],
    });
    expect(r.intents.filter((i) => i.kind === "flag")).toHaveLength(0);
  });

  it("does NOT flag a busy (corroboration) agent even when flat", () => {
    const r = ticks(() => [mkEntry({ session_id: "sx", context_ts: 5000, context_tokens: 100 })], {
      busySessionIds: ["sx"],
    });
    expect(r.intents.filter((i) => i.kind === "flag")).toHaveLength(0);
  });

  it("does NOT flag an excluded session even when flat", () => {
    const r = ticks(() => [mkEntry({ session_id: "self", context_ts: 5000, context_tokens: 100 })], {
      busySessionIds: [],
      excludeSessionIds: ["self"],
    });
    expect(r.intents.filter((i) => i.kind === "flag")).toHaveLength(0);
  });

  it("does NOT flag before W_idle (single tick = warm-up)", () => {
    const r = evaluateFleet(
      snap([mkEntry({ session_id: "sx", context_ts: 5000, context_tokens: 100 })], { busySessionIds: [] }),
      EMPTY_STATE,
    );
    expect(r.intents).toHaveLength(0);
  });

  it("threads + accumulates the ring buffer through nextState", () => {
    const e = mkEntry({ session_id: "sx", context_ts: 5000, context_tokens: 100 });
    const r1 = evaluateFleet(snap([e], { busySessionIds: [] }), EMPTY_STATE);
    expect(r1.nextState.rings.sx.samples).toHaveLength(1);
    const r2 = evaluateFleet({ registry: [e], now: NOW + 1000, busySessionIds: [] }, r1.nextState);
    expect(r2.nextState.rings.sx.samples).toHaveLength(2);
  });

  it("prunes the ring when a session leaves the registry", () => {
    const e = mkEntry({ session_id: "sx", context_ts: 5000, context_tokens: 100 });
    const r1 = evaluateFleet(snap([e], { busySessionIds: [] }), EMPTY_STATE);
    expect(r1.nextState.rings.sx).toBeTruthy();
    const r2 = evaluateFleet(
      {
        registry: [mkEntry({ session_id: "sy", context_ts: 1, context_tokens: 1 })],
        now: NOW + 1000,
        busySessionIds: [],
      },
      r1.nextState,
    );
    expect(r2.nextState.rings.sx).toBeUndefined();
  });

  it("compact straddle (token drop) re-warms-up → no flag, ring reset", () => {
    let state = EMPTY_STATE;
    let res!: ReturnType<typeof evaluateFleet>;
    for (let i = 0; i < 5; i++) {
      const now = NOW + i * (W / 4);
      const tokens = i < 4 ? 300_000 : 100_000; // compaction on the last tick (−200k)
      res = evaluateFleet(
        {
          registry: [mkEntry({ session_id: "sx", context_ts: 5000, context_tokens: tokens })],
          now,
          busySessionIds: [],
        },
        state,
      );
      state = res.nextState;
    }
    expect(res.intents.filter((i) => i.kind === "flag")).toHaveLength(0); // reset → warm-up
    expect(res.nextState.rings.sx.samples).toHaveLength(1); // ring reset to the post-compact sample
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #12 crossover — over-budget is neither reap-exempt nor a reap-trigger; the
// compact intent is gone (not even a valid IntentKind). #11 judges over-budget
// on the SAME idle signal as any agent.
// ─────────────────────────────────────────────────────────────────────────────
describe("evaluateFleet — over-budget is neither reap-exempt nor a reap-trigger (#12 crossover)", () => {
  function flatTicks(entry: (now: number) => RegistryEntry[], opts: Partial<FleetSnapshot> = {}, count = 5) {
    let state = EMPTY_STATE;
    let res!: ReturnType<typeof evaluateFleet>;
    for (let i = 0; i < count; i++) {
      const now = NOW + i * (W / (count - 1));
      res = evaluateFleet({ registry: entry(now), now, ...opts }, state);
      state = res.nextState;
    }
    return res;
  }

  it("an over-budget but quiet agent (no history) emits nothing — warm-up; no compact path exists", () => {
    const e = mkEntry({ context_tokens: 999_000, context_ts: FRESH_TS });
    const r = evaluateFleet(snap([e], { busySessionIds: [] }), EMPTY_STATE);
    expect(r.intents).toHaveLength(0);
  });

  it("an over-budget FLAT agent is FLAGGED like any idle agent (no compact exemption)", () => {
    const r = flatTicks(() => [mkEntry({ session_id: "sx", context_tokens: 420_000, context_ts: 5000 })], {
      busySessionIds: [],
    });
    const flags = r.intents.filter((i) => i.kind === "flag");
    expect(flags).toHaveLength(1);
    expect(flags[0].sessionId).toBe("sx");
  });

  it("an over-budget but ADVANCING agent triggers nothing (over-budget is not a reap-trigger)", () => {
    const r = flatTicks((now) => [mkEntry({ session_id: "sx", context_tokens: 500_000, context_ts: now })], {
      busySessionIds: [],
    });
    expect(r.intents).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAP basis + id hygiene (§9) — unchanged by #11.
// ─────────────────────────────────────────────────────────────────────────────
describe("evaluateFleet — CAP basis and id hygiene (§9)", () => {
  it("activeCount and capRemaining count only status === 'active'", () => {
    const reg = [
      mkEntry({ session_id: "a", status: "active" }),
      mkEntry({ session_id: "b", status: "active" }),
      mkEntry({ session_id: "c", status: "crashed" }),
      mkEntry({ session_id: "d", status: "signed_off" }),
    ];
    const r = evaluateFleet(snap(reg), EMPTY_STATE);
    expect(r.activeCount).toBe(2);
    expect(r.capRemaining).toBe(DEFAULT_ENVELOPE.cap - 2);
  });

  it("skips rows with a null session_id (cannot track/target) but still counts them toward CAP", () => {
    const e = mkEntry({ session_id: null, context_tokens: 500_000, context_ts: FRESH_TS });
    const r = evaluateFleet(snap([e]), EMPTY_STATE);
    expect(r.intents).toHaveLength(0);
    expect(r.activeCount).toBe(1);
  });
});

describe("gateSpawn — CAP from registry active rows (§9/§5)", () => {
  it("allows up to the remaining cap", () => {
    expect(gateSpawn(2, 1)).toEqual({ allowed: 2, denied: 0, capRemaining: 4 });
  });
  it("clamps a request that would exceed the cap", () => {
    expect(gateSpawn(4, 3)).toEqual({ allowed: 2, denied: 2, capRemaining: 2 });
  });
  it("allows nothing at the cap", () => {
    expect(gateSpawn(3, 5)).toEqual({ allowed: 0, denied: 3, capRemaining: 0 });
  });
  it("never goes negative past the cap", () => {
    expect(gateSpawn(1, 8)).toEqual({ allowed: 0, denied: 1, capRemaining: 0 });
  });
});

describe("evaluateTaskRetries — verify gate (§3b)", () => {
  it("ignores tasks that have not failed verify", () => {
    expect(evaluateTaskRetries([{ taskId: "t1", status: "review", verifyFailures: 0 }])).toHaveLength(0);
  });
  it("requeues while under MAX_RETRY", () => {
    const r = evaluateTaskRetries([{ taskId: "t1", status: "review", verifyFailures: 1 }]);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("requeue");
    expect(r[0].taskId).toBe("t1");
  });
  it("escalates AT MAX_RETRY (never silently drops)", () => {
    const r = evaluateTaskRetries([{ taskId: "t1", status: "review", verifyFailures: DEFAULT_ENVELOPE.maxRetry }]);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("escalate");
  });
  it("escalates past MAX_RETRY too", () => {
    const r = evaluateTaskRetries([{ taskId: "t1", status: "review", verifyFailures: 9 }]);
    expect(r[0].kind).toBe("escalate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3 — callsign-keyed PIN (kill-exempt). The LOAD-BEARING brain-skip half: a pinned
// callsign is sampled (history accrues, like exclude) but NEVER flagged → the brain
// never proposes a reap for it. Keyed on CALLSIGN (stable), not session_id (churns).
// ─────────────────────────────────────────────────────────────────────────────
describe("evaluateFleet — A3 callsign-keyed pin (kill-exempt)", () => {
  // Feed `count` ticks across ≥ W_idle, threading nextState; return the last result.
  function ticks(reg: (now: number) => RegistryEntry[], opts: Partial<FleetSnapshot> = {}, count = 5) {
    let state = EMPTY_STATE;
    let res!: ReturnType<typeof evaluateFleet>;
    const step = W / (count - 1);
    for (let i = 0; i < count; i++) {
      const now = NOW + i * step;
      res = evaluateFleet({ registry: reg(now), now, ...opts }, state);
      state = res.nextState;
    }
    return res;
  }

  const flat = (_now: number) => [
    mkEntry({
      session_id: "sx",
      callsign: "linux-sx",
      control_handle: "tmux:wt-spx",
      context_ts: 5000,
      context_tokens: 100,
    }),
  ];

  it("baseline: the flat agent DOES flag when NOT pinned (control)", () => {
    const r = ticks(flat, { busySessionIds: [] });
    expect(r.intents.filter((i) => i.kind === "flag")).toHaveLength(1);
  });

  it("does NOT flag a PINNED (by callsign) session even when flat", () => {
    const r = ticks(flat, { busySessionIds: [], pinnedCallsigns: ["linux-sx"] });
    expect(r.intents.filter((i) => i.kind === "flag")).toHaveLength(0);
    expect(r.intents.some((i) => i.kind === "reap")).toBe(false);
  });

  it("pin is keyed on CALLSIGN, not session_id (pinning the SID does NOT exempt)", () => {
    // pin the session_id string — must NOT match, because the gate is callsign-keyed.
    const r = ticks(flat, { busySessionIds: [], pinnedCallsigns: ["sx"] });
    expect(r.intents.filter((i) => i.kind === "flag")).toHaveLength(1);
  });

  it("still SAMPLES a pinned session (ring accrues for an eventual unpin)", () => {
    const r = ticks(flat, { busySessionIds: [], pinnedCallsigns: ["linux-sx"] });
    expect(r.nextState.rings.sx).toBeTruthy();
    expect(r.nextState.rings.sx.samples.length).toBeGreaterThan(1);
  });

  it("unpinning resumes flagging from the accrued history (no warm-up reset)", () => {
    // 5 pinned ticks across W_idle (history accrues, no flag), then ONE unpinned tick
    // → flags immediately off the accrued ring, proving the pin only gated flagging.
    let state = EMPTY_STATE;
    let res!: ReturnType<typeof evaluateFleet>;
    const step = W / 4;
    for (let i = 0; i < 5; i++) {
      const now = NOW + i * step;
      res = evaluateFleet({ registry: flat(now), now, busySessionIds: [], pinnedCallsigns: ["linux-sx"] }, state);
      state = res.nextState;
    }
    expect(res.intents.filter((i) => i.kind === "flag")).toHaveLength(0); // pinned → no flag
    const after = evaluateFleet({ registry: flat(NOW + 5 * step), now: NOW + 5 * step, busySessionIds: [] }, state);
    expect(after.intents.filter((i) => i.kind === "flag")).toHaveLength(1); // unpinned → flags
  });

  it("a null-callsign session cannot be pinned (still flags when flat)", () => {
    const nullCs = (_now: number) => [
      mkEntry({
        session_id: "sx",
        callsign: null,
        control_handle: "tmux:wt-spx",
        context_ts: 5000,
        context_tokens: 100,
      }),
    ];
    const r = ticks(nullCs, { busySessionIds: [], pinnedCallsigns: ["linux-sx"] });
    expect(r.intents.filter((i) => i.kind === "flag")).toHaveLength(1);
  });
});
