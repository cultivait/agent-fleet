import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setPersistent } from "../auth.js";
import { dbListRegistry, dbRegistryUpsert } from "../db.js";
import { isOnline, reconcilePresenceFromRegistry, reconcileRejoinDuplicates, setOnline } from "../polling.js";
import { deriveTmuxSession } from "../terminal.js";
import { ensureOperatorPresence } from "../server.js";
import { registerUser, startTestServer, stopTestServer, type TestContext } from "./helpers/server-harness.js";

// FIX B3 — startup stale-seat sweep. `isOnline` defaults ONLINE for any callsign not in
// the in-memory offline set, but that set is empty on a fresh process. So after an unclean
// reboot every persisted registry row reads ONLINE even though its session is dead — which
// pins fleet_claim_referee at 409 forever (a dead-but-persisted REFEREE seat the reaper
// never frees). reconcilePresenceFromRegistry() baselines every persisted callsign OFFLINE
// (dead until it re-polls), EXCEPT persistent users (the virtual operator). A live agent
// re-polls and handlePoll flips it back online within one cycle.
describe("rehydratePresenceFromRegistry (startup stale-seat sweep)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await startTestServer();
  });

  afterEach(async () => {
    await stopTestServer(ctx);
  });

  it("sweeps a persisted REFEREE + a normal agent OFFLINE, leaves the persistent operator ONLINE", () => {
    // The operator presence: persistent + principal + online (the production bootstrap).
    ensureOperatorPresence(); // registers "Operator" as persistent
    expect(isOnline("Operator")).toBe(true);

    // Seed the registry with the three callsigns a post-reboot hub would carry: a dead
    // REFEREE (principal but NON-persistent → the wedge bug), a normal agent, and the
    // operator. All read ONLINE by default before the sweep (offline set is empty).
    dbRegistryUpsert({ session_id: "ref-sess", spawn_id: "ref-spawn", callsign: "REFEREE", started_at: 3000 });
    dbRegistryUpsert({ session_id: "wt-sess", spawn_id: "wt-spawn", callsign: "wt-abc123", started_at: 2000 });
    dbRegistryUpsert({ session_id: "operator-sess", spawn_id: "operator-spawn", callsign: "Operator", started_at: 1000 });

    expect(isOnline("REFEREE")).toBe(true); // pre-sweep: phantom online — the bug
    expect(isOnline("wt-abc123")).toBe(true);

    reconcilePresenceFromRegistry();

    // The dead REFEREE seat is now offline → a claim can shed + re-seat it.
    expect(isOnline("REFEREE")).toBe(false);
    expect(isOnline("wt-abc123")).toBe(false);
    // The persistent operator is exempt from the sweep — stays reachable.
    expect(isOnline("Operator")).toBe(true);
  });

  it("de-dupes repeated callsigns across registry rows (one offline mark, no churn)", () => {
    // Multiple stale rows for one callsign (the prod '9 REFEREE rows' shape) must collapse.
    dbRegistryUpsert({ session_id: "dup-1", spawn_id: "dup-spawn-1", callsign: "REFEREE", started_at: 1000 });
    dbRegistryUpsert({ session_id: "dup-2", spawn_id: "dup-spawn-2", callsign: "REFEREE", started_at: 2000 });
    dbRegistryUpsert({ session_id: "dup-3", spawn_id: "dup-spawn-3", callsign: "REFEREE", started_at: 3000 });

    reconcilePresenceFromRegistry();

    expect(isOnline("REFEREE")).toBe(false);
  });

  it("a re-poll flips a swept agent back ONLINE within one cycle (live seat reclaimed)", async () => {
    // A real agent registers, then a reboot baseline sweeps it offline.
    const token = await registerUser(ctx, "wt-live");
    dbRegistryUpsert({ session_id: "live-sess", spawn_id: "live-spawn", callsign: "wt-live", started_at: 4000 });
    reconcilePresenceFromRegistry();
    expect(isOnline("wt-live")).toBe(false);

    // The agent re-polls. handlePoll holds the long-poll open but flips presence ONLINE
    // synchronously (no queued messages → the request hangs; we abort once online is set).
    const ac = new AbortController();
    const pollPromise = fetch(`${ctx.baseUrl}/poll`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    }).catch(() => undefined); // expected: aborted after the presence flip
    await new Promise((r) => setTimeout(r, 50)); // let the server process the request

    expect(isOnline("wt-live")).toBe(true);

    ac.abort();
    await pollPromise;
  });

  it("leaves an ENV-named persistent operator ONLINE even when it owns a registry row", () => {
    // The exemption keys on the persistent FLAG, not the literal "Operator".
    ensureOperatorPresence("Operator"); // a non-"Operator" persistent operator
    setPersistent("Operator", true);
    setOnline("Operator");
    dbRegistryUpsert({ session_id: "opr-sess", spawn_id: "opr-spawn", callsign: "Operator", started_at: 1000 });
    dbRegistryUpsert({ session_id: "ghost-sess", spawn_id: "ghost-spawn", callsign: "wt-ghost", started_at: 2000 });

    reconcilePresenceFromRegistry();

    expect(isOnline("Operator")).toBe(true); // persistent → exempt
    expect(isOnline("wt-ghost")).toBe(false); // control: a real seat IS swept
  });
});

// FIX B4 — duplicate-row reconcile, fused into the same startup pass as the B3 sweep.
// become_referee's in-memory-only shed leaves a STALE duplicate registry row behind (callsign
// REFEREE / spawn_id null / control_handle null) alongside the LIVE referee row. The reconcile
// signs off that null-handle ghost — but ONLY when a live-handle sibling proves the seat is still
// up (conservative: a full reboot with all handles dead must NOT signed_off anything; the
// offline-sweep alone applies). Liveness is injected (hasSession) so the suite stays tmux-free.
describe("reconcilePresenceFromRegistry (B4 duplicate-row reconcile)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await startTestServer();
  });

  afterEach(async () => {
    await stopTestServer(ctx);
  });

  it("signs off a null-handle duplicate when a live-handle sibling exists; leaves the live row active", () => {
    // The LIVE referee row (control_handle → a live tmux session) + the ghost become_referee's
    // in-memory-only shed leaves behind (control_handle null, spawn_id null) — the exact prod shape.
    dbRegistryUpsert({
      session_id: "ref-live",
      spawn_id: "ref-spawn",
      callsign: "REFEREE",
      control_handle: "tmux:wt-live-ref",
      started_at: 2000,
    });
    dbRegistryUpsert({ session_id: "ref-ghost", callsign: "REFEREE", started_at: 1000 });

    // Only wt-live-ref is a live tmux session.
    reconcilePresenceFromRegistry((session) => session === "wt-live-ref");

    const rows = dbListRegistry();
    expect(rows.find((r) => r.session_id === "ref-ghost")?.status).toBe("signed_off"); // dup reaped
    expect(rows.find((r) => r.session_id === "ref-live")?.status).toBe("active"); // live row untouched
  });

  it("all handles dead (full reboot) → NO signed_off, offline-sweep only", () => {
    // Two REFEREE rows, neither backed by a live tmux session — a dead-but-non-null handle and a
    // null handle. With no live sibling the reconcile must signed_off NOTHING.
    dbRegistryUpsert({
      session_id: "ref-a",
      spawn_id: "ref-spawn-a",
      callsign: "REFEREE",
      control_handle: "tmux:wt-dead",
      started_at: 2000,
    });
    dbRegistryUpsert({ session_id: "ref-b", callsign: "REFEREE", started_at: 1000 });

    reconcilePresenceFromRegistry(() => false); // nothing is live

    const rows = dbListRegistry();
    expect(rows.find((r) => r.session_id === "ref-a")?.status).toBe("active"); // dead handle NOT signed off
    expect(rows.find((r) => r.session_id === "ref-b")?.status).toBe("active"); // null handle NOT signed off
    expect(isOnline("REFEREE")).toBe(false); // …but the offline-sweep still applied
  });

  it("recognizes a spawn_id-derived live sibling (no tmux: handle yet) and reaps only the dead ghost", () => {
    // The live row has NO tmux: control_handle (enrich-POST not landed) — only a spawn_id whose
    // wt-<spawn_id> is live. The OLD tmux:-prefix-only gate missed this entirely (never reaped). The
    // unified derivation recognizes it AND spares the spawn_id-live row itself.
    dbRegistryUpsert({ session_id: "y-live", spawn_id: "yrid", callsign: "wt-y", started_at: 2000 }); // null handle, live via wt-yrid
    dbRegistryUpsert({ session_id: "y-ghost", callsign: "wt-y", started_at: 1000 }); // null handle, no spawn_id → dead

    reconcilePresenceFromRegistry((s) => s === "wt-yrid");

    const rows = dbListRegistry();
    expect(rows.find((r) => r.session_id === "y-ghost")?.status).toBe("signed_off");
    expect(rows.find((r) => r.session_id === "y-live")?.status).toBe("active"); // spawn_id-live row spared
  });
});

// reconcile-on-rejoin — retire the null-handle ghosts a callsign left behind on a PREVIOUS
// (regenerated-sid) registration the instant it re-registers a live row, instead of waiting for the
// next boot's B4 sweep. Same conservative rule as B4 (live-handle sibling required, null-handle only),
// plus: never the just-written row. This is the exact shape that left 6eafd7 with 2 lingering ghosts.
describe("reconcileRejoinDuplicates (reconcile-on-rejoin)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await startTestServer();
  });

  afterEach(async () => {
    await stopTestServer(ctx);
  });

  it("signs off a null-handle ghost when the rejoined row has a live tmux handle; leaves the live row", () => {
    // The freshly re-registered LIVE row (handle → live tmux) + the null-handle ghost the prior
    // (regenerated-sid) registration left behind, both under the same callsign.
    dbRegistryUpsert({ session_id: "new-sess", spawn_id: "new-spawn", callsign: "wt-x", control_handle: "tmux:wt-new", started_at: 3000 });
    dbRegistryUpsert({ session_id: "old-ghost", callsign: "wt-x", started_at: 1000 });

    const retired = reconcileRejoinDuplicates("wt-x", "new-sess", (s) => s === "wt-new");

    expect(retired.map((r) => r.session_id)).toEqual(["old-ghost"]);
    const rows = dbListRegistry();
    expect(rows.find((r) => r.session_id === "old-ghost")?.status).toBe("signed_off");
    expect(rows.find((r) => r.session_id === "new-sess")?.status).toBe("active"); // the live row is untouched
  });

  it("never retires the just-written row, nor a non-null (dead) handle row; only null-handle ghosts", () => {
    dbRegistryUpsert({ session_id: "keep", spawn_id: "keep-spawn", callsign: "wt-x", control_handle: "tmux:wt-live", started_at: 3000 });
    dbRegistryUpsert({ session_id: "dead-handle", callsign: "wt-x", control_handle: "tmux:wt-dead", started_at: 2000 });
    dbRegistryUpsert({ session_id: "ghost", callsign: "wt-x", started_at: 1000 });

    const retired = reconcileRejoinDuplicates("wt-x", "keep", (s) => s === "wt-live");

    expect(retired.map((r) => r.session_id)).toEqual(["ghost"]);
    const rows = dbListRegistry();
    expect(rows.find((r) => r.session_id === "keep")?.status).toBe("active"); // excluded by keepSessionId
    expect(rows.find((r) => r.session_id === "dead-handle")?.status).toBe("active"); // non-null handle left alone
    expect(rows.find((r) => r.session_id === "ghost")?.status).toBe("signed_off");
  });

  it("conservative: no live-handle sibling → signs off NOTHING (waits for the boot sweep)", () => {
    dbRegistryUpsert({ session_id: "a", callsign: "wt-x", started_at: 2000 });
    dbRegistryUpsert({ session_id: "b", callsign: "wt-x", started_at: 1000 });

    const retired = reconcileRejoinDuplicates("wt-x", "a", () => false);

    expect(retired).toEqual([]);
    const rows = dbListRegistry();
    expect(rows.find((r) => r.session_id === "b")?.status).toBe("active");
  });

  it("no-op for a first-time registration (a single row for the callsign)", () => {
    dbRegistryUpsert({ session_id: "solo", spawn_id: "solo-spawn", callsign: "wt-solo", control_handle: "tmux:wt-solo", started_at: 1000 });

    const retired = reconcileRejoinDuplicates("wt-solo", "solo", () => true);

    expect(retired).toEqual([]);
  });

  it("recognizes a spawn_id-derived live sibling (null handle, no tmux: prefix) — the old blind spot", () => {
    // Rejoined row is live ONLY via spawn_id (wt-liverid); it has no tmux: handle yet. The old
    // tmux:-prefix-only gate would have found no live sibling → reaped nothing. Now it reaps the ghost.
    dbRegistryUpsert({ session_id: "live", spawn_id: "liverid", callsign: "wt-x", started_at: 3000 }); // null handle
    dbRegistryUpsert({ session_id: "ghost", callsign: "wt-x", started_at: 1000 }); // null handle, no spawn_id

    const retired = reconcileRejoinDuplicates("wt-x", "live", (s) => s === "wt-liverid");

    expect(retired.map((r) => r.session_id)).toEqual(["ghost"]);
    const rows = dbListRegistry();
    expect(rows.find((r) => r.session_id === "live")?.status).toBe("active"); // spawn_id-live seat spared
    expect(rows.find((r) => r.session_id === "ghost")?.status).toBe("signed_off");
  });

  it("spares a spawn_id-live null-handle row even when a tmux:-handle sibling is also live (no over-reap)", () => {
    // Two independently-live rows — one via tmux: handle (wt-A), one via spawn_id only (wt-B) — plus a
    // dead ghost. The OLD code signed off ALL null-handle rows once any tmux: sibling was live → it
    // would have reaped the wt-B live row. The per-row liveness check spares it; only the dead ghost goes.
    dbRegistryUpsert({ session_id: "tmux-live", spawn_id: "A", callsign: "wt-x", control_handle: "tmux:wt-A", started_at: 3000 });
    dbRegistryUpsert({ session_id: "sid-live", spawn_id: "B", callsign: "wt-x", started_at: 2000 }); // null handle, live via wt-B
    dbRegistryUpsert({ session_id: "ghost", callsign: "wt-x", started_at: 1000 }); // null handle, no spawn_id → dead
    const live = new Set(["wt-A", "wt-B"]);

    const retired = reconcileRejoinDuplicates("wt-x", "tmux-live", (s) => live.has(s));

    expect(retired.map((r) => r.session_id)).toEqual(["ghost"]); // only the truly-dead ghost
    const rows = dbListRegistry();
    expect(rows.find((r) => r.session_id === "sid-live")?.status).toBe("active"); // spawn_id-live row SPARED
    expect(rows.find((r) => r.session_id === "ghost")?.status).toBe("signed_off");
  });
});

// deriveTmuxSession — the single derivation both the resolver and the reconcile sites route through.
describe("deriveTmuxSession (canonical row→tmux-session derivation)", () => {
  it("strips an explicit tmux: control_handle", () => {
    expect(deriveTmuxSession({ session_id: "s", callsign: "c", control_handle: "tmux:wt-abc" } as never)).toBe("wt-abc");
  });
  it("derives wt-<spawn_id> when there is no tmux: handle", () => {
    expect(deriveTmuxSession({ session_id: "s", callsign: "c", spawn_id: "abc" } as never)).toBe("wt-abc");
  });
  it("prefers the tmux: handle over the spawn_id derivation", () => {
    expect(deriveTmuxSession({ session_id: "s", callsign: "c", control_handle: "tmux:wt-handle", spawn_id: "spawn" } as never)).toBe("wt-handle");
  });
  it("returns null for an empty tmux: handle and no spawn_id, and for a non-tmux handle with no spawn_id", () => {
    expect(deriveTmuxSession({ session_id: "s", callsign: "c", control_handle: "tmux:" } as never)).toBe(null);
    expect(deriveTmuxSession({ session_id: "s", callsign: "c", control_handle: "ws:other" } as never)).toBe(null);
    expect(deriveTmuxSession({ session_id: "s", callsign: "c" } as never)).toBe(null);
  });
});
