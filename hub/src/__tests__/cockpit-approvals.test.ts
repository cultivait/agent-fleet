import { describe, expect, it } from "vitest";
import { cockpitMarkup, cockpitScript, cockpitStyles } from "../cockpit-ui.js";

// The Phase-5 HITL approvals panel is a self-contained ck-appr block inside the cockpit's
// browser script (a String.raw template). It can't be exercised in a DOM here, but these
// guards catch the failure modes that matter at integration: a missing container/wiring
// and — most importantly — a syntax break in the embedded browser JS after the edit.
describe("cockpit — Phase 5 HITL approvals panel (integration)", () => {
  it("renders a self-contained ck-appr container, render/poll fns, and the admin endpoints", () => {
    expect(cockpitMarkup()).toContain('id="ck-appr"');
    expect(cockpitMarkup()).toContain('id="ck-appr-list"');
    const script = cockpitScript();
    expect(script).toContain("renderAppr");
    expect(script).toContain("loadAppr");
    expect(script).toContain('fetch("/loop-approvals?status=pending"');
    expect(script).toContain('fetch("/loop-approval-resolve"');
    // approve/reject decisions wired
    expect(script).toContain('apprResolve(id, "approve"');
    expect(script).toContain('apprResolve(id, "reject"');
    expect(cockpitStyles()).toContain(".ck-appr");
  });

  it("wires the loop_approval SSE hook for instant refresh", () => {
    expect(cockpitScript()).toContain("onLoopApproval");
  });

  it("keeps the embedded browser script syntactically valid (parses without executing)", () => {
    // new Function() compiles the source without running it — a broken edit to the
    // String.raw block (unbalanced brace/paren) throws here, failing the build's tests.
    expect(() => new Function(cockpitScript())).not.toThrow();
  });

  it("surfaces stop_reason on a paused (escalated) loop in the ck-lctl badge", () => {
    // the paused-badge nit: an escalate-paused loop reads "escalated", not "paused"
    expect(cockpitScript()).toContain('(l.status === "stopped" || l.status === "paused") && l.stop_reason');
  });
});
