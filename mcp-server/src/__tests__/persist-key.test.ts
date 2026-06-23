import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistKey, tokenFile } from "../tools.js";

// T5 (#1 keying): the token-persist file must be keyed on a value that survives a fleet
// LAUNCHER relaunch — a new process with a fresh CLAUDE_CODE_SESSION_ID but the SAME
// AF_CALLSIGN. The original code keyed on CLAUDE_CODE_SESSION_ID, which is minted fresh on
// every (re)launch, so a relaunched agent never found its prior token and re-registered as a
// takeover (shedding its queue — the message-loss this change targets). These tests pin the
// key precedence (AF_CALLSIGN > WT_CALLSIGN > session id) and the path sanitization so a
// future edit can't silently regress to the volatile session id.

const SAVED = {
  AF_CALLSIGN: process.env.AF_CALLSIGN,
  WT_CALLSIGN: process.env.WT_CALLSIGN,
};

beforeEach(() => {
  delete process.env.AF_CALLSIGN;
  delete process.env.WT_CALLSIGN;
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("persistKey — stable token-file key across a launcher relaunch", () => {
  it("prefers AF_CALLSIGN (set by the fleet launcher, identical across a relaunch)", () => {
    process.env.AF_CALLSIGN = "linux-8ced45";
    process.env.WT_CALLSIGN = "should-be-ignored";
    expect(persistKey()).toBe("linux-8ced45");
  });

  it("falls back to WT_CALLSIGN when AF_CALLSIGN is absent", () => {
    process.env.WT_CALLSIGN = "linux-d0d25b";
    expect(persistKey()).toBe("linux-d0d25b");
  });

  it("falls back to the session id for a solo (non-fleet) session with no callsign", () => {
    // No callsign env → the volatile session id (module-load CLAUDE_CODE_SESSION_ID). A solo
    // restart still loses its token as before — accepted, no regression vs. the prior behavior.
    expect(persistKey()).toBe(process.env.CLAUDE_CODE_SESSION_ID);
  });
});

describe("tokenFile — path safety", () => {
  it("keys the file on the callsign under /tmp", () => {
    process.env.AF_CALLSIGN = "linux-8ced45";
    expect(tokenFile()).toBe("/tmp/wt-token-linux-8ced45");
  });

  it("sanitizes a callsign containing spaces (e.g. 'REFEREE Field') to a path-safe name", () => {
    process.env.AF_CALLSIGN = "REFEREE Field";
    expect(tokenFile()).toBe("/tmp/wt-token-REFEREE_Field");
  });
});
