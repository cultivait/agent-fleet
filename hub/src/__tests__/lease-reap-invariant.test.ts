import { describe, expect, it } from "vitest";
import { assertLeaseReapInvariant } from "../server.js";

// Wave-4 (b) — the D4 anti-zombie invariant: the plan lease MUST be strictly shorter
// than the board-reap horizon. If lease >= reap, a reclaimed-but-still-alive owner's
// board entry is reaped before its lease lapses, the reclaim goes unguarded, and the
// zombie window silently re-opens. createHubServer asserts this at boot; here we test
// the pure assertion directly (no server spin-up needed).
describe("D4/Wave-4 (b) — lease<board-reap startup invariant", () => {
  const REAP = 60 * 60_000; // 1h board-reap horizon (default WT_BOARD_REAP_MINUTES=60)

  it("accepts the deployed config (1800s lease < 3600s reap)", () => {
    expect(() => assertLeaseReapInvariant(1800 * 1000, REAP)).not.toThrow();
  });

  it("REJECTS lease == reap at the boundary (flips RED if the guard is weakened to >)", () => {
    // The discriminating case: a `>` guard would let this through. `>=` rejects it.
    expect(() => assertLeaseReapInvariant(REAP, REAP)).toThrow(/STRICTLY LESS THAN/);
  });

  it("REJECTS lease > reap", () => {
    expect(() => assertLeaseReapInvariant(2 * REAP, REAP)).toThrow(/anti-zombie window/);
  });

  it("accepts a lease just one ms under reap", () => {
    expect(() => assertLeaseReapInvariant(REAP - 1, REAP)).not.toThrow();
  });
});
