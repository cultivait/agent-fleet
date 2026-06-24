import { afterEach, describe, expect, it } from "vitest";
import { consumeTerminalTicket, resetTerminalTickets, resolveLiveTmuxSession } from "../terminal.js";
import type { RegistryEntry } from "../types.js";

afterEach(() => {
  resetTerminalTickets();
});

// A minimal registry row factory.
function row(partial: Partial<RegistryEntry>): RegistryEntry {
  return {
    session_id: null,
    spawn_id: null,
    callsign: null,
    node: null,
    workdir: null,
    started_at: null,
    pid: null,
    control_handle: null,
    worktree_path: null,
    owned_branch: null,
    status: "active",
    last_standby_at: null,
    context_tokens: null,
    context_ts: null,
    ...partial,
  };
}

describe("terminal ticket store", () => {
  // resolveLiveTmuxSession verifies the session is live via `tmux has-session`,
  // which won't be true for fake names — so for the ticket-lifecycle tests we
  // exercise consume() directly with a hand-built ticket store entry by minting
  // against a row whose session we control. Since we can't guarantee tmux here,
  // these tests focus on the consume() invariants which DON'T require tmux.

  it("consume returns null for an unknown token", () => {
    expect(consumeTerminalTicket("nope")).toBeNull();
    expect(consumeTerminalTicket(undefined)).toBeNull();
    expect(consumeTerminalTicket(null)).toBeNull();
  });
});

describe("resolveLiveTmuxSession (registry → session name)", () => {
  it("returns null when no row matches the callsign", () => {
    const reg = [row({ callsign: "other", control_handle: "tmux:wt-x" })];
    expect(resolveLiveTmuxSession("missing", reg)).toBeNull();
  });

  it("returns null when a matching row has no tmux handle and no spawn_id", () => {
    const reg = [row({ callsign: "a", control_handle: null, spawn_id: null, pid: 1 })];
    // No derivable session name at all.
    expect(resolveLiveTmuxSession("a", reg)).toBeNull();
  });

  // NOTE: a positive (live) resolution requires a real tmux session; that path
  // is covered by the offline WS smoke test (scripts/ws smoke), not here, so the
  // unit suite stays tmux-free and hermetic.
});
