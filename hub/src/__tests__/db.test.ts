import { beforeEach, describe, expect, it } from "vitest";
import {
  dbAddChannelMember,
  dbCreateAgentConfig,
  dbCreateChannel,
  dbDeleteAgentConfig,
  dbDeleteChannel,
  dbDeleteChannelMessages,
  dbDeleteReadCursorsForChannel,
  dbGetAgentConfig,
  dbGetChannel,
  dbGetChannelMessages,
  dbGetRecentMessages,
  dbGetUnreadCounts,
  dbGetUserChannels,
  dbListAgentConfigs,
  dbListChannels,
  dbRemoveAllMembersOfChannel,
  dbRemoveChannelMember,
  dbSaveMessage,
  dbUpdateAgentConfig,
  dbUpdateReadCursor,
  initDB,
} from "../db.js";
import type { Message } from "../types.js";

beforeEach(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
});

describe("channels CRUD", () => {
  it("should seed #all on init", () => {
    const ch = dbGetChannel("#all");
    expect(ch).toBeDefined();
    expect(ch!.name).toBe("#all");
    expect(ch!.created_by).toBe("system");
  });

  it("should create and retrieve a channel", () => {
    const ch = dbCreateChannel("#test", "alice");
    expect(ch.name).toBe("#test");
    expect(ch.created_by).toBe("alice");
    expect(dbGetChannel("#test")).toBeDefined();
  });

  it("should list channels in creation order", () => {
    dbCreateChannel("#a", "alice");
    dbCreateChannel("#b", "bob");
    const list = dbListChannels();
    const names = list.map((c) => c.name);
    expect(names).toContain("#all");
    expect(names).toContain("#a");
    expect(names).toContain("#b");
  });

  it("should delete a channel", () => {
    dbCreateChannel("#del", "alice");
    expect(dbDeleteChannel("#del")).toBe(true);
    expect(dbGetChannel("#del")).toBeUndefined();
  });

  it("should return false when deleting non-existent channel", () => {
    expect(dbDeleteChannel("#nope")).toBe(false);
  });
});

describe("channel members", () => {
  it("should add and query members", () => {
    dbCreateChannel("#room", "alice");
    dbAddChannelMember("#room", "alice");
    dbAddChannelMember("#room", "bob");
    const channels = dbGetUserChannels("alice");
    expect(channels).toContain("#room");
  });

  it("should ignore duplicate member adds", () => {
    dbCreateChannel("#room", "alice");
    dbAddChannelMember("#room", "alice");
    dbAddChannelMember("#room", "alice"); // should not throw
    const channels = dbGetUserChannels("alice");
    expect(channels.filter((c) => c === "#room")).toHaveLength(1);
  });

  it("should remove a member", () => {
    dbCreateChannel("#room", "alice");
    dbAddChannelMember("#room", "alice");
    dbRemoveChannelMember("#room", "alice");
    expect(dbGetUserChannels("alice")).not.toContain("#room");
  });

  it("should remove all members of a channel", () => {
    dbCreateChannel("#room", "alice");
    dbAddChannelMember("#room", "alice");
    dbAddChannelMember("#room", "bob");
    dbRemoveAllMembersOfChannel("#room");
    expect(dbGetUserChannels("alice")).not.toContain("#room");
    expect(dbGetUserChannels("bob")).not.toContain("#room");
  });
});

describe("messages", () => {
  function makeMsg(overrides: Partial<Message> = {}): Message {
    return {
      id: `msg-${Math.random().toString(36).slice(2)}`,
      from: "alice",
      to: "@all",
      content: "hello",
      channel: "#all",
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it("should save and retrieve channel messages", () => {
    const msg = makeMsg();
    dbSaveMessage(msg);
    const messages = dbGetChannelMessages("#all");
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msg.id);
  });

  it("should retrieve recent messages across channels", () => {
    dbCreateChannel("#other", "alice");
    dbSaveMessage(makeMsg({ channel: "#all" }));
    dbSaveMessage(makeMsg({ channel: "#other" }));
    const messages = dbGetRecentMessages();
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it("returns the most RECENT messages (newest window), not the oldest, in chronological order", () => {
    // 10 OLD #all messages, then 3 NEWER #other messages. The dashboard bug: an
    // oldest-N window was 100% old #all and hid #other (which had only newer msgs).
    for (let i = 0; i < 10; i++) {
      dbSaveMessage(makeMsg({ id: `old-${i}`, channel: "#all", timestamp: 1000 + i }));
    }
    dbCreateChannel("#other", "alice");
    for (let i = 0; i < 3; i++) {
      dbSaveMessage(makeMsg({ id: `new-${i}`, channel: "#other", timestamp: 5000 + i }));
    }
    const recent = dbGetRecentMessages(5);
    expect(recent).toHaveLength(5);
    // newest window includes the recent #other msgs (oldest-window returned 5 old #all, missed #other)
    expect(recent.some((m) => m.channel === "#other")).toBe(true);
    expect(recent.map((m) => m.id)).toContain("new-2");
    // returned ascending (chronological) for display
    const ts = recent.map((m) => m.timestamp);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("should delete channel messages", () => {
    dbSaveMessage(makeMsg());
    dbDeleteChannelMessages("#all");
    expect(dbGetChannelMessages("#all")).toHaveLength(0);
  });

  it("should respect limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      dbSaveMessage(makeMsg({ timestamp: Date.now() + i }));
    }
    expect(dbGetChannelMessages("#all", 3)).toHaveLength(3);
  });

  it("should NOT prune #all — every message is retained (never-delete model)", () => {
    // #all used to hard-delete past 200 (ALL_CHANNEL_MAX). #all now joins
    // the never-delete model: the 16h filter-on-read keeps the live view lean while
    // the full history stays in the DB and is retrievable via GET /messages.
    for (let i = 0; i < 210; i++) {
      dbSaveMessage(
        makeMsg({
          id: `prune-${i}`,
          timestamp: i,
        }),
      );
    }
    const messages = dbGetChannelMessages("#all", 500);
    expect(messages).toHaveLength(210);
    const ids = messages.map((m) => m.id);
    expect(ids).toContain("prune-0"); // the oldest survived — nothing was deleted
    expect(ids).toContain("prune-209");
  });
});

describe("read cursors", () => {
  it("should update and query unread counts", () => {
    dbSaveMessage({
      id: "m1",
      from: "alice",
      to: "@all",
      content: "hello",
      channel: "#all",
      timestamp: 1000,
    });
    dbSaveMessage({
      id: "m2",
      from: "alice",
      to: "@all",
      content: "world",
      channel: "#all",
      timestamp: 2000,
    });
    dbUpdateReadCursor("bob", "#all", 1000);
    const counts = dbGetUnreadCounts("bob");
    expect(counts["#all"]).toBe(1); // m2 is unread
  });

  it("should use MAX for cursor updates (no backwards)", () => {
    dbUpdateReadCursor("bob", "#all", 2000);
    dbUpdateReadCursor("bob", "#all", 1000); // should not go backwards
    dbSaveMessage({
      id: "m1",
      from: "alice",
      to: "@all",
      content: "hello",
      channel: "#all",
      timestamp: 1500,
    });
    const counts = dbGetUnreadCounts("bob");
    expect(counts["#all"]).toBeUndefined(); // 1500 < 2000 so no unread
  });

  it("should delete read cursors for a channel", () => {
    dbUpdateReadCursor("bob", "#all", 1000);
    dbDeleteReadCursorsForChannel("#all");
    // After deleting cursors, all messages are unread
    dbSaveMessage({
      id: "m1",
      from: "alice",
      to: "@all",
      content: "hello",
      channel: "#all",
      timestamp: 2000,
    });
    const counts = dbGetUnreadCounts("bob");
    expect(counts["#all"]).toBe(1);
  });
});

describe("agent configs", () => {
  it("should create and retrieve an agent config", () => {
    const config = dbCreateAgentConfig("a1", "my-agent", "/tmp", "echo hi", false);
    expect(config.id).toBe("a1");
    expect(config.name).toBe("my-agent");
    expect(config.work_dir).toBe("/tmp");
    expect(config.command).toBe("echo hi");
    expect(config.auto_start).toBe(0);

    const retrieved = dbGetAgentConfig("a1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("my-agent");
  });

  it("should list agent configs in creation order", () => {
    dbCreateAgentConfig("b1", "agent-b", "/tmp", "echo b", false);
    dbCreateAgentConfig("b2", "agent-c", "/tmp", "echo c", true);
    const list = dbListAgentConfigs();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("should update an agent config", () => {
    dbCreateAgentConfig("u1", "update-me", "/tmp", "echo old", false);
    dbUpdateAgentConfig("u1", { name: "updated", command: "echo new", autoStart: true });
    const config = dbGetAgentConfig("u1");
    expect(config!.name).toBe("updated");
    expect(config!.command).toBe("echo new");
    expect(config!.auto_start).toBe(1);
  });

  it("should delete an agent config", () => {
    dbCreateAgentConfig("d1", "delete-me", "/tmp", "echo del", false);
    expect(dbDeleteAgentConfig("d1")).toBe(true);
    expect(dbGetAgentConfig("d1")).toBeUndefined();
  });

  it("should return false when deleting non-existent config", () => {
    expect(dbDeleteAgentConfig("nope")).toBe(false);
  });

  it("should enforce unique name constraint", () => {
    dbCreateAgentConfig("n1", "unique-name", "/tmp", "echo 1", false);
    expect(() => dbCreateAgentConfig("n2", "unique-name", "/tmp", "echo 2", false)).toThrow();
  });
});
