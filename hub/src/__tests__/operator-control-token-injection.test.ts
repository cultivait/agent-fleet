import ts from "typescript";
import { describe, expect, it } from "vitest";
import { cockpitScript } from "../cockpit-ui.js";
import { getDashboardHTML } from "../dashboard.js";

// WS-C Operator Control Panel: the cockpit's admin POSTs (launch-referee, conductor
// config/start/stop, fleet-max, pin) must be Bearer-gated with the SAME admin token as the
// dashboard. cockpitScript(adminToken) threads it into the cockpit's own IIFE scope. These
// assertions prove: (1) the real token reaches the browser script, (2) the no-arg/default
// path is fail-SAFE (empty Bearer → 401, never fail-open), (3) the PROD call-site in
// getDashboardHTML actually forwards the token end-to-end, (4) a token value can't leak a
// live ${...} template expression into the shipped JS, and that a $-bearing token is
// inserted verbatim (function-replacer, not a string-pattern replace).
describe("WS-C — operator-control admin token injection", () => {
  it("injects the real token into the cockpit script's ADMIN_TOKEN + adminHeaders", () => {
    const script = cockpitScript("tok-abc123");
    expect(script).toContain('var ADMIN_TOKEN = "tok-abc123";');
    expect(script).toContain('"Authorization": "Bearer " + ADMIN_TOKEN');
    expect(script).not.toContain("__WT_ADMIN_TOKEN__"); // sentinel fully replaced
  });

  it("no-arg call is fail-SAFE: empty token, never fail-open, no template leak", () => {
    const script = cockpitScript();
    expect(script).toContain('var ADMIN_TOKEN = "";');
    expect(script).not.toContain("__WT_ADMIN_TOKEN__");
    expect(script).not.toContain("${"); // no un-interpolated template expression survived
  });

  it("PROD call-site getDashboardHTML threads the token end-to-end into the cockpit script", () => {
    const html = getDashboardHTML("prod-token-xyz");
    // dashboard script's own token (existing behavior)
    expect(html).toContain('const ADMIN_TOKEN = "prod-token-xyz";');
    // cockpit script's threaded token — proves dashboard.ts call-site passes the REAL token, not ""
    expect(html).toContain('var ADMIN_TOKEN = "prod-token-xyz";');
  });

  it("a $-bearing token is inserted verbatim (function-replacer, no $-pattern interpretation)", () => {
    const script = cockpitScript("a$&b$1c");
    expect(script).toContain('var ADMIN_TOKEN = "a$&b$1c";');
  });

  it("the generated cockpit browser script is syntactically valid JS (parses clean)", () => {
    // tsc does NOT type-check the JS inside the String.raw COCKPIT_SCRIPT template, so the
    // hand-written operator-control handlers (launch-referee, conductor card, pin) are
    // otherwise unguarded against syntax errors that would only surface at render time.
    // Parse (don't execute) the emitted script with the TS scanner and assert zero syntax
    // diagnostics — a real syntax gate with no eval/new-Function/execution surface.
    const result = ts.transpileModule(cockpitScript("tok"), {
      reportDiagnostics: true,
      compilerOptions: { allowJs: true, checkJs: false, target: ts.ScriptTarget.ES2017 },
    });
    const syntaxErrors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    expect(syntaxErrors).toHaveLength(0);
  });
});
