import { beforeEach, describe, expect, it } from "vitest";
import {
  getChannelMembers,
  initGeneralChannel,
  joinChannel,
  renameChannel,
  resetChannelState,
} from "../channels.js";
import {
  dbCreateChannel,
  dbGetChannel,
  dbGetChannelMessages,
  dbGetUserChannels,
  dbNextChannelSeq,
  dbRenameChannel,
  dbSaveMessage,
  initDB,
} from "../db.js";

beforeEach(() => {
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
  resetChannelState();
  initGeneralChannel();
});

describe("dbRenameChannel — atomic cascade across every channel-keyed table", () => {
  it("re-keys the channel row, members, messages, and the seq counter; old name gone", () => {
    dbCreateChannel("#old", "Operator");
    joinChannel("#old", "alice"); // writes channel_members
    const seq = dbNextChannelSeq("#old"); // seeds channel_seq for #old (→ 1)
    dbSaveMessage({ id: "m1", from: "alice", to: "#old", content: "hi", channel: "#old", timestamp: 1, seq });

    expect(dbRenameChannel("#old", "#new")).toBe(true);

    // channels row moved
    expect(dbGetChannel("#new")).toBeDefined();
    expect(dbGetChannel("#old")).toBeUndefined();
    // membership moved (DB side)
    expect(dbGetUserChannels("alice")).toContain("#new");
    expect(dbGetUserChannels("alice")).not.toContain("#old");
    // message history preserved under the new name, none under the old
    expect(dbGetChannelMessages("#new").map((m) => m.id)).toEqual(["m1"]);
    expect(dbGetChannelMessages("#old")).toEqual([]);
    // monotonic seq carried over (continues from #old, not reset to 1)
    expect(dbNextChannelSeq("#new")).toBe(seq + 1);
  });

  it("returns false (no-op) when the source channel does not exist", () => {
    expect(dbRenameChannel("#ghost", "#whatever")).toBe(false);
    expect(dbGetChannel("#whatever")).toBeUndefined();
  });

  it("returns false when the target already exists (never clobbers)", () => {
    dbCreateChannel("#a", "Operator");
    dbCreateChannel("#b", "Operator");
    expect(dbRenameChannel("#a", "#b")).toBe(false);
    expect(dbGetChannel("#a")).toBeDefined(); // both untouched
    expect(dbGetChannel("#b")).toBeDefined();
  });

  it("returns false when from === to", () => {
    dbCreateChannel("#same", "Operator");
    expect(dbRenameChannel("#same", "#same")).toBe(false);
  });

  it("carries the seq over a stale orphan channel_seq row for the target name", () => {
    // A channel previously named #target was deleted (delete does NOT clear
    // channel_seq), leaving an orphan {#target: N}. Renaming into #target must not
    // collide on the channel_seq PK.
    dbNextChannelSeq("#target"); // orphan row {#target: 1}
    dbCreateChannel("#src", "Operator");
    dbNextChannelSeq("#src"); // {#src: 1}
    expect(dbRenameChannel("#src", "#target")).toBe(true);
    expect(dbGetChannel("#target")).toBeDefined();
  });
});

describe("renameChannel — in-memory membership re-key", () => {
  it("moves the member set to the new key, preserving members", () => {
    dbCreateChannel("#proj", "Operator");
    joinChannel("#proj", "bob");
    expect(getChannelMembers("#proj")).toContain("bob");

    renameChannel("#proj", "#proj2");
    expect(getChannelMembers("#proj2")).toContain("bob");
    expect(getChannelMembers("#proj")).toEqual([]); // old key emptied
  });

  it("creates an empty set for the new name when the old name had no tracked members", () => {
    renameChannel("#never-tracked", "#fresh");
    expect(getChannelMembers("#fresh")).toEqual([]);
  });
});
