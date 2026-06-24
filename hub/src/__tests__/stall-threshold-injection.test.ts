import { describe, expect, it } from "vitest";
import { STALL_BEAT_MS } from "../constants.js";
import { cockpitScript } from "../cockpit-ui.js";
import { getDashboardHTML } from "../dashboard.js";

// Wave-4 (c): the C5 stall threshold now has ONE source of truth — constants.STALL_BEAT_MS.
// server.ts and cockpit-lease.ts import it; the two browser templates (cockpit-ui +
// dashboard) can't import a TS const, so they INJECT the canonical value via ${} at build
// time. These assertions prove the injection is render-SAFE (no leftover "${...}" leaks
// into the shipped browser JS) and that every emitted copy equals the canonical value —
// i.e. the four-way drift this ticket removes can't silently reappear.
describe("C5/Wave-4 (c) — stall threshold single source of truth", () => {
  it("canonical default is 3600000ms (3600s / 1h), env-tunable via AF_STALL_BEAT_SECONDS", () => {
    // This deployment defaults the stall radar to 1h to keep the cockpit quiet for
    // long-lived agent sessions (constants.ts; upstream general default is 240s).
    expect(STALL_BEAT_MS).toBe(3_600_000);
  });

  it("cockpit-ui browser script injects the canonical value with no literal ${} leak", () => {
    const script = cockpitScript();
    expect(script).toContain(`var STALL_BEAT_MS = ${STALL_BEAT_MS};`);
    expect(script).not.toContain("${"); // no un-interpolated template expression survived
  });

  it("dashboard HTML injects the canonical value with no literal ${STALL_BEAT_MS} leak", () => {
    const html = getDashboardHTML("test-admin-token");
    expect(html).toContain(`const STALL_BEAT_MS = ${STALL_BEAT_MS};`);
    expect(html).not.toContain("${STALL_BEAT_MS}");
  });
});
