import { describe, expect, it } from "vitest";
import { buildCompactSend, compactAgent, sendCompactToSession } from "../terminal.js";
import type { RegistryEntry } from "../types.js";

// A minimal registry row factory (mirrors terminal-ticket.test.ts).
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

describe("buildCompactSend — two full /compact submissions (real compaction in one click)", () => {
  it("types /compact + Enter TWICE: the first absorbs the upstream instant no-op, the second runs for real", () => {
    const steps = buildCompactSend("wt-sp1");
    expect(steps).toEqual([
      // submission #1 — the spurious instant no-op the CLI resolves trivially
      { args: ["send-keys", "-t", "wt-sp1", "-l", "/compact"], delayAfterMs: 150 },
      { args: ["send-keys", "-t", "wt-sp1", "Enter"], delayAfterMs: 700 },
      // submission #2 — the REAL compaction
      { args: ["send-keys", "-t", "wt-sp1", "-l", "/compact"], delayAfterMs: 150 },
      { args: ["send-keys", "-t", "wt-sp1", "Enter"], delayAfterMs: 0 },
    ]);
  });

  it("sends the literal command exactly twice and an Enter after each", () => {
    const steps = buildCompactSend("wt-x");
    const literals = steps.filter((s) => s.args.includes("-l") && s.args.includes("/compact"));
    const enters = steps.filter((s) => s.args.at(-1) === "Enter");
    expect(literals).toHaveLength(2);
    expect(enters).toHaveLength(2);
  });

  it("targets the given session by name only (never a tmux-wide sweep)", () => {
    for (const step of buildCompactSend("wt-other")) {
      expect(step.args).toContain("-t");
      expect(step.args).toContain("wt-other");
    }
  });
});

describe("sendCompactToSession — ordered I/O with injected deps", () => {
  it("runs the four send-keys in order, awaiting the non-zero delays between them", async () => {
    const trace: string[] = [];
    await sendCompactToSession("wt-sp1", {
      run: (args) => trace.push(`run:${args.join(" ")}`),
      delay: async (ms) => {
        trace.push(`delay:${ms}`);
      },
    });
    expect(trace).toEqual([
      "run:send-keys -t wt-sp1 -l /compact",
      "delay:150",
      "run:send-keys -t wt-sp1 Enter",
      "delay:700",
      "run:send-keys -t wt-sp1 -l /compact",
      "delay:150",
      "run:send-keys -t wt-sp1 Enter",
      // trailing 0ms delay is skipped (delayAfterMs > 0 guard)
    ]);
  });
});

describe("compactAgent — resolve callsign → live tmux session, then fire", () => {
  it("returns null (→ 409) and sends nothing when the callsign has no row", async () => {
    let ran = 0;
    const result = await compactAgent("missing", { run: () => ran++ }, []);
    expect(result).toBeNull();
    expect(ran).toBe(0);
  });

  it("returns null (→ 409) and sends nothing when the resolved session is not live", async () => {
    // A derivable but non-existent session name: resolveLiveTmuxSession verifies via
    // `tmux has-session`, which fails for this random name, so it resolves to null.
    let ran = 0;
    const reg = [row({ callsign: "ghost", control_handle: "tmux:wt-nonexistent-zzz-9183745" })];
    const result = await compactAgent("ghost", { run: () => ran++ }, reg);
    expect(result).toBeNull();
    expect(ran).toBe(0);
  });
});
