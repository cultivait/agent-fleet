import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTmuxSession,
  planReap,
  reapBeltVerdict,
  classifyDispatch,
  escalateMessage,
  dedupeReaps,
  summarizeDryRun,
  executeReap,
  executeIntent,
  runOnce,
  flooredIdleWindowMs,
  resolveIntervalMs,
} from "./conductor-executor.mjs";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function row(p = {}) {
  return {
    session_id: "s1",
    spawn_id: "sp1",
    callsign: "linux-s1",
    node: "linux",
    status: "active",
    control_handle: "tmux:wt-sp1",
    started_at: NOW - 20 * MIN,
    last_standby_at: null,
    context_tokens: null,
    context_ts: null,
    ...p,
  };
}

// ── parseTmuxSession ──
test("parseTmuxSession strips the tmux: prefix", () => {
  assert.equal(parseTmuxSession("tmux:wt-abc", "abc"), "wt-abc");
});
test("parseTmuxSession falls back to wt-<spawnId>", () => {
  assert.equal(parseTmuxSession(null, "abc"), "wt-abc");
});
test("parseTmuxSession returns null with no derivable target", () => {
  assert.equal(parseTmuxSession(null, null), null);
  assert.equal(parseTmuxSession("tmux:", null), null);
});

// ── planReap ──
test("planReap builds the kill plan", () => {
  const p = planReap({ controlHandle: "tmux:wt-x", spawnId: "x", sessionId: "sX", requiresLock: "reap:sX" });
  assert.equal(p.ok, true);
  assert.equal(p.session, "wt-x");
  assert.deepEqual(p.killArgs, ["kill-session", "-t", "wt-x"]);
  assert.equal(p.lockKey, "reap:sX");
});
test("planReap fails with no derivable session", () => {
  assert.equal(planReap({ controlHandle: null, spawnId: null }).ok, false);
});

// ── reapBeltVerdict (the §6c state-check belt) ──
test("belt: vanished target → do not proceed", () => {
  assert.equal(reapBeltVerdict(undefined).proceed, false);
});
test("belt: already-retired target → do not proceed", () => {
  assert.equal(reapBeltVerdict(row({ status: "signed_off" })).proceed, false);
});
test("belt: row with no derivable control handle → do not proceed", () => {
  assert.equal(reapBeltVerdict(row({ control_handle: null, spawn_id: null })).proceed, false);
});
test("belt: live, targetable, active row → proceed", () => {
  assert.equal(reapBeltVerdict(row()).proceed, true);
});

// ── classifyDispatch ──
test("classifyDispatch routes each intent kind", () => {
  assert.deepEqual(classifyDispatch({ kind: "reap" }), { channel: "reap", destructive: true, needsLock: true });
  // #11 flag is its own NON-destructive, NO-lock channel — never "reap".
  assert.deepEqual(classifyDispatch({ kind: "flag" }), { channel: "flag", destructive: false, needsLock: false });
  assert.equal(classifyDispatch({ kind: "escalate" }).channel, "message");
  assert.equal(classifyDispatch({ kind: "requeue" }).channel, "task");
  assert.equal(classifyDispatch({ kind: "spawn" }).channel, "spawn");
  assert.equal(classifyDispatch({ kind: "weird" }).channel, "noop");
});

// ── message bodies ──
test("escalateMessage surfaces reason + task", () => {
  const m = escalateMessage({ reason: "verify failed 3x", taskId: "t9" });
  assert.match(m.content, /ESCALATE/);
  assert.match(m.content, /t9/);
});

// ── dedupeReaps ──
test("dedupeReaps drops a duplicate reap of the same session", () => {
  const out = dedupeReaps([
    { kind: "reap", sessionId: "a" },
    { kind: "reap", sessionId: "a" },
    { kind: "reap", sessionId: "b" },
    { kind: "escalate", sessionId: "a" },
  ]);
  assert.equal(out.filter((i) => i.kind === "reap").length, 2);
  assert.equal(out.length, 3); // both reaps' dupe removed, non-reap (escalate) kept
});

// ── executeReap (load-bearing; injected ctx fakes) ──
function fakeCtx(opts = {}) {
  const calls = { acquire: [], release: [], kill: [], signoff: [], registry: 0 };
  return {
    armed: opts.armed ?? false,
    ownerSid: "test-owner",
    reapLeaseMs: 60_000,
    now: NOW,
    _calls: calls,
    acquireLock: async (k, o, l) => {
      calls.acquire.push([k, o, l]);
      return opts.lock ?? { ok: true, status: 200 };
    },
    releaseLock: async (k, o) => {
      calls.release.push([k, o]);
    },
    getRegistry: async () => {
      calls.registry++;
      return { registry: opts.liveRows ?? [], now: NOW };
    },
    killSession: async (s) => {
      calls.kill.push(s);
      if (opts.killThrows) throw new Error("kill boom");
    },
    postSignedOff: async (p) => {
      calls.signoff.push(p);
    },
  };
}

const REAP_INTENT = {
  kind: "reap",
  sessionId: "s1",
  spawnId: "sp1",
  controlHandle: "tmux:wt-sp1",
  requiresLock: "reap:s1",
  reason: "idle",
};

test("executeReap: NOT armed → dry-run is TRULY INERT (no lock, no re-GET, no kill)", async () => {
  const ctx = fakeCtx({ armed: false, liveRows: [row()] });
  const r = await executeReap(REAP_INTENT, ctx);
  assert.equal(r.action, "dry-run");
  assert.equal(r.target, "wt-sp1");
  assert.equal(ctx._calls.acquire.length, 0); // never touches the hub lock table
  assert.equal(ctx._calls.registry, 0); // no re-GET
  assert.equal(ctx._calls.kill.length, 0);
  assert.equal(ctx._calls.signoff.length, 0);
  assert.equal(ctx._calls.release.length, 0);
});

test("executeReap: ARMED + lock DENIED → defer, no kill, no release", async () => {
  const ctx = fakeCtx({ armed: true, lock: { ok: false, status: 409 } });
  const r = await executeReap(REAP_INTENT, ctx);
  assert.equal(r.action, "defer");
  assert.equal(ctx._calls.kill.length, 0);
  assert.equal(ctx._calls.release.length, 0); // returned before the try block
});

test("executeReap: ARMED + belt says VANISHED → skip, no kill, lock released", async () => {
  const ctx = fakeCtx({ armed: true, liveRows: [] }); // target absent from live registry
  const r = await executeReap(REAP_INTENT, ctx);
  assert.equal(r.action, "skip");
  assert.equal(ctx._calls.kill.length, 0);
  assert.equal(ctx._calls.release.length, 1); // finally released
});

test("executeReap: ARMED + belt proceeds → lock + kill + signed_off(+session_id) + release", async () => {
  const ctx = fakeCtx({ armed: true, liveRows: [row()] });
  const r = await executeReap(REAP_INTENT, ctx);
  assert.equal(r.action, "reaped");
  assert.equal(ctx._calls.acquire.length, 1); // STEP-0 lock acquired
  assert.deepEqual(ctx._calls.kill, ["wt-sp1"]);
  assert.deepEqual(ctx._calls.signoff[0], { spawn_id: "sp1", session_id: "s1", node: "linux", status: "signed_off" });
  assert.equal(ctx._calls.release.length, 1);
});

test("executeReap: signed_off body carries session_id (6d41 fallback closes the null-spawn_id ghost-active edge)", async () => {
  // Anomalous row: spawn_id null but control_handle set → still targetable. The hub
  // handler 400-rejects a spawn_id-only body, so the body MUST carry session_id to
  // flip the row (findRegistryRowId keys spawn_id first, session_id fallback).
  const anomalous = row({ spawn_id: null, control_handle: "tmux:wt-sp1" });
  const intent = { kind: "reap", sessionId: "s1", spawnId: null, controlHandle: "tmux:wt-sp1", requiresLock: "reap:s1", reason: "idle" };
  const ctx = fakeCtx({ armed: true, liveRows: [anomalous] });
  const r = await executeReap(intent, ctx);
  assert.equal(r.action, "reaped");
  assert.equal(ctx._calls.signoff[0].session_id, "s1"); // present → handler can key on it
  assert.equal(ctx._calls.signoff[0].spawn_id, null);
});

test("executeReap: kill THROWS → lock still released in finally", async () => {
  const ctx = fakeCtx({ armed: true, liveRows: [row()], killThrows: true });
  await assert.rejects(() => executeReap(REAP_INTENT, ctx), /kill boom/);
  assert.equal(ctx._calls.release.length, 1); // finally ran despite the throw
});

// ── executeIntent ──
test("executeIntent: message intent defers when no transport wired", async () => {
  const ctx = fakeCtx({ armed: true });
  const r = await executeIntent({ kind: "escalate", reason: "verify failed 3x", taskId: "t9" }, ctx);
  assert.equal(r.action, "deferred-transport");
  assert.match(r.body.content, /ESCALATE/);
});
test("executeIntent: message sent when transport injected + armed", async () => {
  const sent = [];
  const ctx = { ...fakeCtx({ armed: true }), sendMessage: async (b) => sent.push(b) };
  const r = await executeIntent({ kind: "escalate", reason: "max retry" }, ctx);
  assert.equal(r.action, "sent");
  assert.equal(sent.length, 1);
});
test("executeIntent: spawn intent is an explicit documented noop (executor never spawns)", async () => {
  const ctx = fakeCtx({ armed: true });
  const r = await executeIntent({ kind: "spawn", reason: "cap room" }, ctx);
  assert.equal(r.action, "noop");
  assert.equal(r.kind, "spawn");
  assert.match(r.reason, /launcher/);
});
test("executeIntent: #11 FLAG is structurally NON-DESTRUCTIVE — flagged, no lock/kill/registry, even ARMED", async () => {
  // The airtight FLAG-only invariant (referee eyes-on #1): an idle flag must reach
  // NO kill path. Run it ARMED with a live row present and assert ZERO destructive I/O.
  const ctx = fakeCtx({ armed: true, liveRows: [row()] });
  const r = await executeIntent({ kind: "flag", sessionId: "s1", callsign: "linux-s1", reason: "idle-candidate: context_ts flat" }, ctx);
  assert.equal(r.action, "flagged");
  assert.equal(r.kind, "flag");
  assert.match(r.reason, /idle-candidate/);
  assert.equal(ctx._calls.acquire.length, 0); // no lock
  assert.equal(ctx._calls.kill.length, 0); // no kill — never executeReap
  assert.equal(ctx._calls.registry, 0); // no belt re-GET
  assert.equal(ctx._calls.signoff.length, 0); // no signed_off post
});

// ── runOnce ── (acts on the brain's intents only; no executor-side stuck-trigger)
test("runOnce: unarmed tick PERSISTS state (non-destructive bookkeeping) but fires NO destructive I/O", async () => {
  // Refined inertness (1d49/b37c): the #11 ring buffer is conductor-PRIVATE state
  // that MUST accumulate during the unarmed FLAG-only observe window — so saveState
  // DOES fire unarmed; only the destructive-5 stay gated. A flag goes to "flagged",
  // an unarmed reap stays "dry-run", and the lock table is never touched.
  let saved = "unset";
  const ctx = {
    ...fakeCtx({ armed: false, liveRows: [row({ session_id: "s3", spawn_id: "sp3", control_handle: "tmux:wt-sp3" })] }),
    exclude: [],
    busy: undefined,
    env: undefined,
    brainCfg: undefined,
    state: { rings: {}, epochStartedAt: null },
    loadBrain: async () => ({
      evaluateFleet: () => ({
        intents: [
          { kind: "flag", sessionId: "s3", callsign: "linux-s3", reason: "idle-candidate: context_ts flat" },
          { kind: "reap", sessionId: "s5", spawnId: "sp5", controlHandle: "tmux:wt-sp5", requiresLock: "reap:s5", reason: "idle" },
          { kind: "escalate", sessionId: "s9", callsign: "linux-s9", reason: "max retry" },
        ],
        nextState: { rings: { s3: { samples: [{ sampledAt: NOW, contextTs: 1, contextTokens: 10 }], firstSampleAt: NOW } }, epochStartedAt: NOW },
      }),
    }),
    saveState: async (s) => {
      saved = s;
    },
  };
  const out = await runOnce(ctx);
  assert.ok(out.results.some((r) => r.kind === "flag" && r.action === "flagged"));
  assert.ok(out.results.some((r) => r.kind === "reap" && r.action === "dry-run")); // unarmed reap stays inert
  assert.ok(out.results.some((r) => r.kind === "escalate" && r.action === "deferred-transport"));
  assert.notEqual(saved, "unset"); // bookkeeping persisted unarmed (the ring must fill)
  assert.equal(saved.epochStartedAt, NOW);
  assert.equal(ctx._calls.acquire.length, 0); // NO lock touched
  assert.equal(ctx._calls.kill.length, 0); // NO kill
});

// ── INERTNESS GATE: any DESTRUCTIVE I/O while unarmed must FAIL the test ──
// Refined model (1d49/b37c): NON-destructive bookkeeping (saveState → conductor-
// PRIVATE state) is ALLOWED unarmed (the ring must fill in observe-only); the
// DESTRUCTIVE-5 (acquireLock/releaseLock/killSession/postSignedOff/sendMessage)
// are booby-trapped and must NEVER fire unarmed, and the belt re-GET must not
// happen. A full unarmed tick over reap + flag + escalate must complete clean.
test("INERTNESS GATE: unarmed tick fires ZERO destructive I/O (saveState bookkeeping allowed; no belt re-GET)", async () => {
  const boom = (name) => async () => {
    throw new Error(`destructive I/O fired while WT_CONDUCTOR_ARMED unset: ${name}`);
  };
  let getCount = 0;
  let savedState = "unset";
  const ctx = {
    armed: false,
    ownerSid: "x",
    reapLeaseMs: 60_000,
    now: NOW,
    exclude: [],
    busy: undefined,
    env: undefined,
    brainCfg: undefined,
    state: { rings: {}, epochStartedAt: null },
    // The ONLY permitted read: the main snapshot. A second call = a belt re-GET, which must not happen unarmed.
    getRegistry: async () => {
      getCount += 1;
      if (getCount > 1) throw new Error("extra /registry GET while unarmed (belt re-GET fired)");
      return { registry: [], now: NOW };
    },
    loadBrain: async () => ({
      evaluateFleet: () => ({
        intents: [
          { kind: "reap", sessionId: "s3", spawnId: "sp3", controlHandle: "tmux:wt-sp3", requiresLock: "reap:s3", reason: "idle" },
          { kind: "flag", sessionId: "s7", callsign: "linux-s7", reason: "idle-candidate: flat" },
          { kind: "escalate", sessionId: "s9", callsign: "linux-s9", reason: "max retry" },
        ],
        nextState: { rings: {}, epochStartedAt: NOW },
      }),
    }),
    // DESTRUCTIVE-5 stay trapped — none may fire unarmed.
    acquireLock: boom("acquireLock"),
    releaseLock: boom("releaseLock"),
    killSession: boom("killSession"),
    postSignedOff: boom("postSignedOff"),
    sendMessage: boom("sendMessage"),
    // NON-destructive conductor-private bookkeeping → ALLOWED unarmed (recorded, not trapped).
    saveState: async (s) => {
      savedState = s;
    },
  };
  // Must NOT throw → proves no lock/post/kill/send and no belt re-GET fired unarmed.
  const out = await runOnce(ctx);
  assert.equal(getCount, 1); // exactly the one permitted snapshot read
  assert.notEqual(savedState, "unset"); // bookkeeping persisted (ring fills in observe-only)
  assert.ok(out.results.length >= 3); // reap + flag + escalate
  assert.ok(out.results.every((r) => r.action === "dry-run" || r.action === "flagged" || r.action === "deferred-transport"));
  assert.ok(!out.results.some((r) => r.action === "error")); // no swallowed I/O exception
});

// ── summarizeDryRun ──
test("summarizeDryRun reports would-reap counts", () => {
  const s = summarizeDryRun([
    { action: "dry-run", kind: "reap", target: "wt-a" },
    { action: "deferred-transport", kind: "escalate" },
  ]);
  assert.match(s, /WOULD reap 1/);
  assert.match(s, /WT_CONDUCTOR_ARMED=1/);
});
test("summarizeDryRun reports #11 idle FLAG candidates (no arm hint — flags are non-destructive)", () => {
  const s = summarizeDryRun([
    { action: "flagged", kind: "flag", callsign: "linux-x", sessionId: "sx" },
    { action: "flagged", kind: "flag", callsign: "linux-y", sessionId: "sy" },
  ]);
  assert.match(s, /FLAG 2 idle-candidate/);
  assert.match(s, /linux-x/);
  assert.doesNotMatch(s, /WT_CONDUCTOR_ARMED=1/); // flag-only line offers no arm hint
});

// ── A3: reapBeltVerdict pin-refuse (executor-refuse half, callsign-keyed) ──
test("reapBeltVerdict: PINNED callsign → refuse (kill-exempt) even when row is live+active", () => {
  const v = reapBeltVerdict(row({ callsign: "linux-warm" }), ["linux-warm"]);
  assert.equal(v.proceed, false);
  assert.match(v.reason, /PINNED/);
});
test("reapBeltVerdict: pin is callsign-keyed — a non-matching pin still proceeds", () => {
  assert.equal(reapBeltVerdict(row({ callsign: "linux-s1" }), ["someone-else"]).proceed, true);
});
test("reapBeltVerdict: accepts a Set of pins as well as an array", () => {
  assert.equal(reapBeltVerdict(row({ callsign: "linux-s1" }), new Set(["linux-s1"])).proceed, false);
});
test("reapBeltVerdict: a null-callsign row cannot be pinned → proceeds", () => {
  assert.equal(reapBeltVerdict(row({ callsign: null }), ["anything"]).proceed, true);
});
test("reapBeltVerdict: no pins arg (back-compat) → behaves as before", () => {
  assert.equal(reapBeltVerdict(row()).proceed, true);
});

// ── A3: executeReap belt-and-suspenders — fresh pin re-read blocks the kill ──
test("executeReap: ARMED + target callsign PINNED mid-flight (fresh re-read) → skip, lock released, NO kill", async () => {
  const ctx = { ...fakeCtx({ armed: true, liveRows: [row()] }), readPinned: async () => ["linux-s1"] };
  const r = await executeReap(REAP_INTENT, ctx);
  assert.equal(r.action, "skip");
  assert.match(r.reason, /PINNED/);
  assert.equal(ctx._calls.kill.length, 0); // never killed despite armed + live row
  assert.equal(ctx._calls.acquire.length, 1); // belt runs post-lock, so lock WAS acquired
  assert.equal(ctx._calls.release.length, 1); // released in finally
  assert.equal(ctx._calls.signoff.length, 0);
});
test("executeReap: ARMED + readPinned does NOT include target → proceeds to kill", async () => {
  const ctx = { ...fakeCtx({ armed: true, liveRows: [row()] }), readPinned: async () => ["linux-other"] };
  const r = await executeReap(REAP_INTENT, ctx);
  assert.equal(r.action, "reaped");
  assert.equal(ctx._calls.kill.length, 1);
});

// ── A2: runOnce honors paused (operator hard-stop, restart-free) ──
test("runOnce: PAUSED → evaluates nothing, no getRegistry, no saveState", async () => {
  let saved = false;
  const ctx = {
    paused: true,
    armed: true,
    state: { rings: { keep: 1 }, epochStartedAt: NOW },
    getRegistry: async () => {
      throw new Error("must not GET registry while paused");
    },
    saveState: async () => {
      saved = true;
    },
  };
  const out = await runOnce(ctx);
  assert.equal(out.paused, true);
  assert.deepEqual(out.intents, []);
  assert.equal(saved, false); // paused persists nothing → last observe set survives
  assert.deepEqual(out.nextState, { rings: { keep: 1 }, epochStartedAt: NOW });
});

// ── A4: runOnce persists lastEval {tickTs, flagged:[{callsign,reason}]} ──
test("runOnce: A4 persists lastEval from FLAG intents into nextState", async () => {
  let savedState = null;
  const flagIntents = [
    { kind: "flag", sessionId: "sa", callsign: "linux-a", reason: "idle a" },
    { kind: "flag", sessionId: "sb", callsign: "linux-b", reason: "idle b" },
  ];
  const ctx = {
    armed: false,
    now: NOW,
    exclude: [],
    pinned: [],
    state: { rings: {}, epochStartedAt: null },
    getRegistry: async () => ({ registry: [], now: NOW }),
    loadBrain: async () => ({
      DEFAULT_CONFIG: {},
      evaluateFleet: () => ({ intents: flagIntents, nextState: { rings: {}, epochStartedAt: NOW } }),
    }),
    saveState: async (s) => {
      savedState = s;
    },
  };
  await runOnce(ctx);
  assert.ok(savedState.lastEval, "lastEval persisted");
  assert.equal(savedState.lastEval.tickTs, NOW);
  assert.deepEqual(savedState.lastEval.flagged, [
    { callsign: "linux-a", reason: "idle a" },
    { callsign: "linux-b", reason: "idle b" },
  ]);
  // lastEval rides alongside the brain's ring state, not instead of it.
  assert.deepEqual(savedState.rings, {});
  assert.equal(savedState.epochStartedAt, NOW);
});

// ── A3: runOnce threads ctx.pinned into the brain snapshot (brain-skip source) ──
test("runOnce: threads ctx.pinned + ctx.exclude into the brain snapshot", async () => {
  let seenSnap = null;
  const ctx = {
    armed: false,
    now: NOW,
    exclude: ["sid-x"],
    pinned: ["linux-pinned"],
    state: { rings: {}, epochStartedAt: null },
    getRegistry: async () => ({ registry: [], now: NOW }),
    loadBrain: async () => ({
      DEFAULT_CONFIG: {},
      evaluateFleet: (snap) => {
        seenSnap = snap;
        return { intents: [], nextState: { rings: {}, epochStartedAt: NOW } };
      },
    }),
    saveState: async () => {},
  };
  await runOnce(ctx);
  assert.deepEqual(seenSnap.pinnedCallsigns, ["linux-pinned"]);
  assert.deepEqual(seenSnap.excludeSessionIds, ["sid-x"]);
});

// ── A2: idle-window floor is ARMED-conditional (preserves fast observe-validation) ──
test("flooredIdleWindowMs: ARMED clamps a below-floor window up to >=60000", () => {
  assert.equal(flooredIdleWindowMs(5_000, true), 60_000);
  assert.equal(flooredIdleWindowMs(120_000, true), 120_000); // above floor untouched
});
test("flooredIdleWindowMs: UNARMED leaves a short window alone (observe is non-destructive)", () => {
  assert.equal(flooredIdleWindowMs(5_000, false), 5_000);
});
test("flooredIdleWindowMs: null/undefined → null (caller falls back to env/default)", () => {
  assert.equal(flooredIdleWindowMs(null, true), null);
  assert.equal(flooredIdleWindowMs(undefined, false), null);
});

// ── A2: tick-cadence resolution + hot-loop floor (precedence control > flag > default) ──
test("resolveIntervalMs: control wins, then --interval flag, then 30s default", () => {
  assert.equal(resolveIntervalMs(15_000, 9_000), 15_000);
  assert.equal(resolveIntervalMs(null, 9_000), 9_000);
  assert.equal(resolveIntervalMs(null, null), 30_000);
});
test("resolveIntervalMs: floors to >=5000 so a bad control value can never hot-loop", () => {
  assert.equal(resolveIntervalMs(100, null), 5_000);
  assert.equal(resolveIntervalMs(0, null), 5_000);
});
