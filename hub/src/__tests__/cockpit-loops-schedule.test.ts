import { describe, expect, it } from "vitest";
import { cockpitMarkup, cockpitScript, cockpitStyles } from "../cockpit-ui.js";

// The Phase-3 loops card is a self-contained ck-loops block inside the cockpit's
// browser script (a String.raw template). It can't be exercised in a DOM here, but
// these guards catch the failure modes that matter: a missing container/handler and
// — most importantly — a syntax break in the embedded browser JS after an edit.
describe("cockpit — Phase 3 governed-loops schedule card", () => {
  it("renders a self-contained ck-loops container, render fn, and /loops fetch", () => {
    expect(cockpitMarkup()).toContain('id="ck-loops"');
    const script = cockpitScript();
    expect(script).toContain("renderLoopsSchedule");
    expect(script).toContain('fetch("/loops")');
    expect(cockpitStyles()).toContain(".ck-loops");
  });

  it("keeps the embedded browser script syntactically valid (parses without executing)", () => {
    // new Function() compiles the source without running it — a broken edit to the
    // String.raw block (unbalanced brace/paren) throws here, failing the build's tests.
    expect(() => new Function(cockpitScript())).not.toThrow();
  });
});
