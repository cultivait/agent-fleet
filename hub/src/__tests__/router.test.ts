import { beforeEach, describe, expect, it } from "vitest";
import { registerUser, resetAuthState } from "../auth.js";
import { initGeneralChannel, joinChannel, resetChannelState } from "../channels.js";
import { dbCreateChannel, initDB } from "../db.js";
import { drainQueue, ensureQueue, pendingCounts, removeQueue, resetRouterState, routeMessage } from "../router.js";

beforeEach(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
  resetAuthState();
  resetChannelState();
  resetRouterState();
  initGeneralChannel();
});

describe("queue management", () => {
  it("should create and drain a queue", () => {
    ensureQueue("alice");
    const msgs = drainQueue("alice");
    expect(msgs).toEqual([]);
  });

  it("should return empty array for non-existent queue", () => {
    expect(drainQueue("nobody")).toEqual([]);
  });

  it("should remove a queue", () => {
    ensureQueue("alice");
    removeQueue("alice");
    expect(drainQueue("alice")).toEqual([]);
  });
});

describe("routeMessage", () => {
  it("should broadcast @all to all channel members except sender", () => {
    const alice = registerUser("alice");
    const bob = registerUser("bob");
    ensureQueue(alice.name);
    ensureQueue(bob.name);
    joinChannel("#all", "alice");
    joinChannel("#all", "bob");

    const msg = routeMessage("alice", "@all", "hello");
    expect(msg.from).toBe("alice");
    expect(msg.to).toBe("@all");
    expect(msg.channel).toBe("#all");

    // Bob should have the message queued
    const bobMsgs = drainQueue("bob");
    expect(bobMsgs).toHaveLength(1);
    expect(bobMsgs[0].content).toBe("hello");

    // Alice (sender) should NOT have it
    const aliceMsgs = drainQueue("alice");
    expect(aliceMsgs).toHaveLength(0);
  });

  it("should deliver DM to target user", () => {
    registerUser("alice");
    registerUser("bob");
    ensureQueue("alice");
    ensureQueue("bob");
    joinChannel("#all", "alice");
    joinChannel("#all", "bob");

    const msg = routeMessage("alice", "@bob", "hi bob");
    expect(msg.to).toBe("bob");

    const bobMsgs = drainQueue("bob");
    expect(bobMsgs).toHaveLength(1);
  });

  it("should throw when target user is not registered", () => {
    registerUser("alice");
    ensureQueue("alice");
    joinChannel("#all", "alice");

    expect(() => routeMessage("alice", "@nobody", "hi")).toThrow("not connected");
  });

  it("should throw when target is not in the channel", () => {
    registerUser("alice");
    registerUser("bob");
    ensureQueue("alice");
    joinChannel("#all", "alice");
    // bob not joined to #all

    expect(() => routeMessage("alice", "@bob", "hi")).toThrow("not a member");
  });

  it("should route messages in custom channels", () => {
    registerUser("alice");
    registerUser("bob");
    ensureQueue("alice");
    ensureQueue("bob");
    dbCreateChannel("#room", "alice");
    joinChannel("#room", "alice");
    joinChannel("#room", "bob");

    const msg = routeMessage("alice", "@all", "room msg", "#room");
    expect(msg.channel).toBe("#room");

    const bobMsgs = drainQueue("bob");
    expect(bobMsgs).toHaveLength(1);
    expect(bobMsgs[0].channel).toBe("#room");
  });

  it("should include image in routed message", () => {
    registerUser("alice");
    registerUser("bob");
    ensureQueue("alice");
    ensureQueue("bob");
    joinChannel("#all", "alice");
    joinChannel("#all", "bob");

    const image = { data: "iVBORw0KGgo=", mimeType: "image/png" };
    const msg = routeMessage("alice", "@all", "check this", "#all", image);
    expect(msg.image).toEqual(image);

    const bobMsgs = drainQueue("bob");
    expect(bobMsgs).toHaveLength(1);
    expect(bobMsgs[0].image).toEqual(image);
  });
});

describe("pendingCounts — ping/wake addressing", () => {
  function threeMembers() {
    for (const name of ["alice", "bob", "carol"]) {
      registerUser(name);
      ensureQueue(name);
      joinChannel("#all", name);
    }
  }

  it("@all with no @-mentions addresses no one: delivered (queued) but never pings", () => {
    threeMembers();

    routeMessage("alice", "@all", "progress update: shipped the bundle, transcript only");

    const { counts, queued } = pendingCounts();
    // Broadcast reaches everyone's queue (transcript / standby) ...
    expect(queued.bob).toBe(1);
    expect(queued.carol).toBe(1);
    // ... but pings no one.
    expect(counts.bob ?? 0).toBe(0);
    expect(counts.carol ?? 0).toBe(0);
    expect(counts.alice ?? 0).toBe(0); // sender unaffected
  });

  it("@all that @-mentions specific members pings exactly those members", () => {
    threeMembers();

    routeMessage("alice", "@all", "@bob @carol the /map API contract changed — re-read it");

    const { counts, queued } = pendingCounts();
    expect(counts.bob).toBe(1);
    expect(counts.carol).toBe(1);
    expect(queued.bob).toBe(1);
    expect(queued.carol).toBe(1);
  });

  it("an un-mentioned member still receives the broadcast but is not pinged", () => {
    threeMembers();

    routeMessage("alice", "@all", "@bob heads up");

    const { counts, queued } = pendingCounts();
    expect(counts.bob).toBe(1);
    expect(counts.carol ?? 0).toBe(0); // not addressed → no ping
    expect(queued.carol).toBe(1); // but still delivered (transcript)
  });

  it("a directed message pings its recipient", () => {
    threeMembers();

    routeMessage("alice", "@bob", "direct ping, no body mentions");

    const { counts } = pendingCounts();
    expect(counts.bob).toBe(1);
    expect(counts.carol ?? 0).toBe(0);
  });

  it("a directed message that also @-mentions others pings every addressed member", () => {
    threeMembers();

    routeMessage("alice", "@bob", "@carol you both need to know about this");

    const { counts } = pendingCounts();
    expect(counts.bob).toBe(1);
    expect(counts.carol).toBe(1);
  });

  it("ignores the @all keyword and unknown names when parsing mentions", () => {
    threeMembers();

    routeMessage("alice", "@all", "@all @ghost nothing addressable here");

    const { counts } = pendingCounts();
    expect(counts.bob ?? 0).toBe(0);
    expect(counts.carol ?? 0).toBe(0);
  });
});

describe("operator @all is scoped to the active channel's members", () => {
  it("operator-ping-all in a specific channel pings only that channel's members, not hub-wide", () => {
    for (const name of ["alice", "bob", "carol"]) {
      registerUser(name);
      ensureQueue(name);
      joinChannel("#all", name); // everyone is in the global channel
    }
    // #room has only alice + bob; carol is a hub member (#all) but NOT in #room.
    dbCreateChannel("#room", "alice");
    joinChannel("#room", "alice");
    joinChannel("#room", "bob");

    // The verified human operator (principal=true, callsign "Operator") broadcasts @all
    // in #room — operator-ping-all addresses every channel member without an @mention.
    const msg = routeMessage("Operator", "@all", "status check", "#room", undefined, true);
    expect(msg.channel).toBe("#room");

    const { counts } = pendingCounts();
    // #room's members are pinged ...
    expect(counts.alice).toBe(1);
    expect(counts.bob).toBe(1);
    // ... but carol (in #all, NOT in #room) is never pinged: @all stays channel-scoped.
    expect(counts.carol ?? 0).toBe(0);
  });
});
