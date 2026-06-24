#!/usr/bin/env node
"use strict";
// Standalone node:test suite for the WS2 gauge producer's PURE core.
// Deliberately NOT a vitest test: the hook is a CommonJS node script outside the
// hub TS project, so keeping its test standalone preserves the hub's tsc/vitest
// gate. .cjs (not .js) so it stays CommonJS under the repo root's
// "type":"module" AND in the no-type-module deploy dir.
// Run: `node --test deploy/hooks/wt-context-gauge.test.cjs`.
//
// Asserts every HARD requirement of the frozen WS2 contract (§5):
//   gauge = input + cache_creation + cache_read (EXCLUDE output_tokens);
//   backward-scan to the LAST assistant-with-usage line (EOF line is ~never it);
//   EXCLUDE subagents (isSidechain !== true belt — sidechain turns are inlined in
//   the main transcript and must NOT be counted); usage at .message.usage;
//   missing field → 0; no usage line anywhere → null ("gauge pending").
const { test } = require("node:test");
const assert = require("node:assert");
const { computeGauge } = require("./wt-context-gauge.cjs");

const usageLine = (usage, extra) =>
  JSON.stringify(Object.assign({ type: "assistant", message: { role: "assistant", usage } }, extra || {}));

test("sums input + cache_creation + cache_read, EXCLUDES output_tokens", () => {
  const t = usageLine({
    input_tokens: 1000,
    cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 50000,
    output_tokens: 500,
  });
  assert.strictEqual(computeGauge(t), 53000); // 1000+2000+50000, output excluded
});

test("backward-scans past a non-usage EOF line to the last assistant-with-usage", () => {
  const t = [
    usageLine({ input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 52000 }),
    JSON.stringify({ type: "user", message: { role: "user", content: "next" } }),
    JSON.stringify({ type: "user", toolUseResult: { ok: true } }), // typical non-usage EOF line
    "", // trailing newline artifact
  ].join("\n");
  assert.strictEqual(computeGauge(t), 53000);
});

test("EXCLUDES subagent sidechain turns even when one is the last line", () => {
  const t = [
    usageLine({ input_tokens: 3000, cache_creation_input_tokens: 0, cache_read_input_tokens: 50000 }), // main
    usageLine({ input_tokens: 999999, cache_read_input_tokens: 999999 }, { isSidechain: true }), // subagent — ignore
  ].join("\n");
  assert.strictEqual(computeGauge(t), 53000); // lands on the main turn, not the sidechain
});

test("treats missing usage fields as 0", () => {
  const t = usageLine({ input_tokens: 1000 }); // no cache_* fields
  assert.strictEqual(computeGauge(t), 1000);
});

test("returns null when no line carries .message.usage (gauge pending)", () => {
  const t = [
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "summary", summary: "x" }),
  ].join("\n");
  assert.strictEqual(computeGauge(t), null);
});

test("skips blank + malformed-JSON lines without throwing", () => {
  const t = [
    "",
    "{ this is not valid json",
    usageLine({ input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 100 }),
    "   ",
  ].join("\n");
  assert.strictEqual(computeGauge(t), 300);
});

test("ignores top-level .usage — only .message.usage counts", () => {
  // a stray top-level usage (wrong location) must not be read
  const t = [
    JSON.stringify({ type: "assistant", usage: { input_tokens: 777777 } }), // top-level → ignored
    usageLine({ input_tokens: 500, cache_read_input_tokens: 1500 }),
  ].join("\n");
  assert.strictEqual(computeGauge(t), 2000);
});
