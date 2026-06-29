import { describe, expect, it } from "vitest";
import { getDashboardHTML } from "../dashboard.js";

// The cockpit client JS lives inside a server-side template literal, so tsc and the
// other vitest suites never parse it — a stray brace/paren there would ship unnoticed
// and only break in-browser. These guard the F1 Compact + F2 rename/delete controls:
// that the markup/wiring is present, and that the client script actually parses.
describe("dashboard client controls (F1 Compact + F2 channel rename/delete)", () => {
  const html = getDashboardHTML("test-token");

  it("emits the new controls + endpoints + SSE handler", () => {
    for (const marker of [
      "compact-btn",
      "compactAgent",
      "/admin-compact-agent",
      "channel-rename",
      "renameChannelPrompt",
      "/admin-channel-rename",
      'ev.type === "channel_rename"',
      "RESERVED_CHANNELS",
      "escapeHtml(ev.from)", // XSS hardening: rename event escapes channel names
    ]) {
      expect(html, `missing: ${marker}`).toContain(marker);
    }
  });

  it("the embedded client script parses as valid JavaScript", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    // isolate the block that carries our edits, so a pre-existing unrelated block
    // can't make this pass or fail spuriously
    const body = scripts.find((s) => s.includes("compactAgent") && s.includes("renameChannelPrompt"));
    expect(body, "could not locate the client script block").toBeTruthy();
    // new Function COMPILES (parses) without executing — throws SyntaxError on bad JS;
    // browser globals (document/fetch/EventSource) are never touched at parse time.
    expect(() => new Function(body as string)).not.toThrow();
  });
});
