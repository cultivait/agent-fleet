import { beforeEach, describe, expect, it } from "vitest";
import { registerUser, resetAuthState } from "../auth.js";
import { initGeneralChannel, joinChannel, resetChannelState } from "../channels.js";
import { dbCreateChannel, initDB } from "../db.js";
import { ensureQueue, pendingCounts, resetRouterState, routeMessage } from "../router.js";

// OPERATOR-PING-ALL: a message from the HUMAN OPERATOR (Operator) wakes ALL members of
// the channel as if each were @-mentioned — so Operator never has to @-mention. The
// trigger is the SERVER-VERIFIED principal flag (C3, set on the routeMessage call by
// the verified send path) AND a reserved operator callsign ∈ {operator, operator}.
// The REFEREE is principal too but is EXCLUDED (keeps @all quiet). Normal agents and
// the referee retain their existing mention semantics. The wake signal is the
// per-recipient `counts` from pendingCounts() — a member is woken iff its callsign is
// in the message's `mentions`.

const TEAM = "#team";

function setupChannel(channel: string, members: string[]): void {
  dbCreateChannel(channel, "system");
  for (const m of members) {
    registerUser(m);
    ensureQueue(m);
    joinChannel(channel, m);
  }
}

beforeEach(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
  resetAuthState();
  resetChannelState();
  resetRouterState();
  initGeneralChannel();
});

describe("operator-ping-all (verified principal + reserved operator callsign)", () => {
  it("wakes EVERY channel member (except sender) when operator sends with no @-mention", () => {
    setupChannel(TEAM, ["operator", "alice", "bob", "carol"]);

    const msg = routeMessage("operator", "@all", "standup in 5", TEAM, undefined, true);

    // mentions expanded to all members minus the sender
    expect([...msg.mentions!].sort()).toEqual(["alice", "bob", "carol"]);
    expect(msg.mentions).not.toContain("operator");

    const { counts } = pendingCounts();
    expect(counts.alice).toBe(1);
    expect(counts.bob).toBe(1);
    expect(counts.carol).toBe(1);
    expect(counts.operator ?? 0).toBe(0); // sender is never pinged
  });

  it("also fires for the reserved 'operator' callsign", () => {
    setupChannel(TEAM, ["operator", "alice", "bob"]);

    routeMessage("operator", "@all", "heads up", TEAM, undefined, true);

    const { counts } = pendingCounts();
    expect(counts.alice).toBe(1);
    expect(counts.bob).toBe(1);
  });

  it("matches the operator callsign case-insensitively (normalized)", () => {
    setupChannel(TEAM, ["alice", "bob"]);

    // Operator's admin-send defaults from='Operator' — normalization must still trigger.
    routeMessage("Operator", "@all", "go", TEAM, undefined, true);

    const { counts } = pendingCounts();
    expect(counts.alice).toBe(1);
    expect(counts.bob).toBe(1);
  });

  it("pings ALL members even when operator directs the message to one @target", () => {
    setupChannel(TEAM, ["operator", "alice", "bob", "carol"]);

    routeMessage("operator", "@alice", "psst, everyone see this", TEAM, undefined, true);

    const { counts } = pendingCounts();
    expect(counts.alice).toBe(1);
    expect(counts.bob).toBe(1);
    expect(counts.carol).toBe(1);
  });

  it("is channel-scoped — members of OTHER channels are not woken", () => {
    setupChannel(TEAM, ["operator", "alice", "bob"]);
    dbCreateChannel("#other", "system");
    registerUser("dave");
    ensureQueue("dave");
    joinChannel("#other", "dave");

    routeMessage("operator", "@all", "team only", TEAM, undefined, true);

    const { counts } = pendingCounts();
    expect(counts.alice).toBe(1);
    expect(counts.bob).toBe(1);
    expect(counts.dave ?? 0).toBe(0);
  });

  it("wakes each member exactly once per message (no storm)", () => {
    setupChannel(TEAM, ["operator", "alice", "bob"]);

    routeMessage("operator", "@all", "once", TEAM, undefined, true);

    const { counts } = pendingCounts();
    expect(counts.alice).toBe(1);
    expect(counts.bob).toBe(1);
  });
});

describe("operator-ping-all exclusions (referee, normal agents, forgery)", () => {
  it("does NOT ping-all for the referee even though referee is principal", () => {
    setupChannel(TEAM, ["referee", "alice", "bob"]);

    const msg = routeMessage("referee", "@all", "carry on team", TEAM, undefined, true);

    // referee keeps normal mention semantics: no @-mention → nobody addressed
    expect(msg.mentions).toEqual([]);
    const { counts } = pendingCounts();
    expect(counts.alice ?? 0).toBe(0);
    expect(counts.bob ?? 0).toBe(0);
  });

  it("preserves normal @-mention semantics for the referee", () => {
    setupChannel(TEAM, ["referee", "alice", "bob"]);

    routeMessage("referee", "@all", "ping @alice only", TEAM, undefined, true);

    const { counts } = pendingCounts();
    expect(counts.alice).toBe(1);
    expect(counts.bob ?? 0).toBe(0); // bob not mentioned → not woken
  });

  it("does NOT ping-all for a normal agent (unchanged semantics)", () => {
    setupChannel(TEAM, ["agent1", "alice", "bob"]);

    routeMessage("agent1", "@all", "hi all", TEAM, undefined, undefined);

    const { counts } = pendingCounts();
    expect(counts.alice ?? 0).toBe(0);
    expect(counts.bob ?? 0).toBe(0);
  });

  it("FORGERY GUARD: a operator callsign WITHOUT the verified principal flag does NOT ping-all", () => {
    setupChannel(TEAM, ["operator", "alice", "bob"]);

    // principal omitted (not server-verified) → must fall back to normal semantics
    const msg = routeMessage("operator", "@all", "hi all", TEAM, undefined, undefined);

    expect(msg.mentions).toEqual([]);
    const { counts } = pendingCounts();
    expect(counts.alice ?? 0).toBe(0);
    expect(counts.bob ?? 0).toBe(0);
  });
});
