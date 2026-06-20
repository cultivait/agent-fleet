// scripts/fleet/conductor-control.test.mjs
// WS-A / A1 + A5 — control-file lib: precedence, type-tolerance, atomic IO.
// Green under node v18 (/usr/bin/node) AND v22.
//
// IO tests point CONTROL_FILE at a temp path by setting WT_CONDUCTOR_CONTROL_FILE
// BEFORE a dynamic import (the module reads it into a const at load time).

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, rm, readdir } from "node:fs/promises";

const CTL_PATH = join(tmpdir(), `wt-ctl-test-${process.pid}.json`);
process.env.WT_CONDUCTOR_CONTROL_FILE = CTL_PATH;

const { resolveControl, envFallbacks, readControl, writeControl, CONTROL_DEFAULTS, CONTROL_VERSION } =
  await import("./conductor-control.mjs");

const NO_ENV = { armed: null, idleWindowMs: null, pinned: [] };

// ── resolveControl: precedence (file > env > default) ─────────────────────────
test("resolveControl: file wins over env over default", () => {
  const env = { armed: false, idleWindowMs: 90_000, pinned: ["env-only"] };
  const v = resolveControl(
    { armed: true, idleWindowMs: 120_000, intervalMs: 15_000, pinned: ["alpha"] },
    env,
  );
  assert.equal(v.armed, true); // file true beats env false
  assert.equal(v.idleWindowMs, 120_000); // file beats env 90k
  assert.equal(v.intervalMs, 15_000);
  assert.deepEqual(v.pinned, ["alpha"]); // file beats env list
});

test("resolveControl: env fills when file field absent/null", () => {
  const env = { armed: true, idleWindowMs: 75_000, pinned: ["beta", "gamma"] };
  const v = resolveControl({ armed: null, idleWindowMs: null }, env);
  assert.equal(v.armed, true); // env armed
  assert.equal(v.idleWindowMs, 75_000); // env idle
  assert.deepEqual(v.pinned, ["beta", "gamma"]); // env pinned (file omitted)
});

test("resolveControl: defaults when neither file nor env", () => {
  const v = resolveControl({}, NO_ENV);
  assert.equal(v.armed, CONTROL_DEFAULTS.armed); // false
  assert.equal(v.paused, false);
  assert.equal(v.idleWindowMs, null);
  assert.equal(v.intervalMs, null);
  assert.deepEqual(v.pinned, []);
  assert.equal(v.version, CONTROL_VERSION);
});

// ── resolveControl: type tolerance (junk never crashes, falls back) ───────────
test("resolveControl: junk field types fall back to env/default", () => {
  const env = { armed: true, idleWindowMs: 80_000, pinned: ["envpin"] };
  const v = resolveControl(
    { armed: "yes", idleWindowMs: "abc", intervalMs: -5, pinned: "notarray" },
    env,
  );
  assert.equal(v.armed, true); // "yes" not bool → env true
  assert.equal(v.idleWindowMs, 80_000); // "abc" → NaN → env 80k
  assert.equal(v.intervalMs, null); // -5 not positive → default null
  assert.deepEqual(v.pinned, ["envpin"]); // "notarray" not array → env list
});

test("resolveControl: pinned array is cleaned (trim, drop empties/non-strings, dedupe)", () => {
  const v = resolveControl({ pinned: ["  alpha ", "", "beta", "alpha", 42, null, "beta"] }, NO_ENV);
  assert.deepEqual(v.pinned, ["alpha", "beta"]);
});

test("resolveControl: explicit empty file.pinned wins over env (operator cleared pins)", () => {
  const env = { armed: null, idleWindowMs: null, pinned: ["env-leftover"] };
  const v = resolveControl({ pinned: [] }, env);
  assert.deepEqual(v.pinned, []); // [] is present+array → file wins, env ignored
});

test("resolveControl: paused from file; default false", () => {
  assert.equal(resolveControl({ paused: true }, NO_ENV).paused, true);
  assert.equal(resolveControl({ paused: "x" }, NO_ENV).paused, false);
  assert.equal(resolveControl({}, NO_ENV).paused, false);
});

test("resolveControl: tolerates null/garbage fileObj without throwing", () => {
  assert.doesNotThrow(() => resolveControl(null, NO_ENV));
  assert.doesNotThrow(() => resolveControl("garbage", NO_ENV));
  assert.doesNotThrow(() => resolveControl(42, NO_ENV));
  assert.equal(resolveControl(null, NO_ENV).armed, false);
});

// ── envFallbacks: parses env correctly ────────────────────────────────────────
test("envFallbacks: parses armed / idle / pin from env object", () => {
  const e = envFallbacks({
    WT_CONDUCTOR_ARMED: "1",
    WT_CONDUCTOR_W_IDLE_MS: "65000",
    WT_CONDUCTOR_PIN: "alpha, beta ,,gamma",
  });
  assert.equal(e.armed, true);
  assert.equal(e.idleWindowMs, 65_000);
  assert.deepEqual(e.pinned, ["alpha", "beta", "gamma"]);
});

test("envFallbacks: unset/invalid env → nulls + empty pin", () => {
  const e = envFallbacks({});
  assert.equal(e.armed, null); // not "1"
  assert.equal(e.idleWindowMs, null);
  assert.deepEqual(e.pinned, []);
  assert.equal(envFallbacks({ WT_CONDUCTOR_ARMED: "0", WT_CONDUCTOR_W_IDLE_MS: "-3" }).armed, null);
  assert.equal(envFallbacks({ WT_CONDUCTOR_W_IDLE_MS: "-3" }).idleWindowMs, null);
});

// ── readControl / writeControl: atomic IO round-trip ──────────────────────────
test("readControl: missing file → defaults + source env-default", async () => {
  await rm(CTL_PATH, { force: true });
  const v = await readControl();
  assert.equal(v.source, "env-default");
  assert.equal(v.armed, false);
  assert.deepEqual(v.pinned, []);
});

test("writeControl → readControl round-trip; source=file", async () => {
  await rm(CTL_PATH, { force: true });
  const written = await writeControl(
    { armed: true, pinned: ["alpha", "beta"], idleWindowMs: 120_000 },
    { now: "2026-01-01T00:00:00.000Z", updatedBy: "test" },
  );
  assert.equal(written.armed, true);
  assert.equal(written.updatedBy, "test");
  assert.equal(written.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(written.version, CONTROL_VERSION);

  const v = await readControl();
  assert.equal(v.source, "file");
  assert.equal(v.armed, true);
  assert.deepEqual(v.pinned, ["alpha", "beta"]);
  assert.equal(v.idleWindowMs, 120_000);
});

test("writeControl: partial merge preserves untouched fields", async () => {
  await rm(CTL_PATH, { force: true });
  await writeControl({ armed: true, pinned: ["alpha"] }, { now: "2026-01-01T00:00:00.000Z" });
  await writeControl({ paused: true }, { now: "2026-01-02T00:00:00.000Z" });
  const v = await readControl();
  assert.equal(v.armed, true); // preserved
  assert.deepEqual(v.pinned, ["alpha"]); // preserved
  assert.equal(v.paused, true); // newly set
  assert.equal(v.updatedAt, "2026-01-02T00:00:00.000Z"); // restamped
});

test("writeControl: atomic — no leftover .tmp file", async () => {
  await rm(CTL_PATH, { force: true });
  await writeControl({ armed: true }, { now: "2026-01-01T00:00:00.000Z" });
  const dir = tmpdir();
  const leftovers = (await readdir(dir)).filter(
    (f) => f.startsWith(`wt-ctl-test-${process.pid}.json`) && f.endsWith(".tmp"),
  );
  assert.deepEqual(leftovers, []);
});

test("readControl: malformed JSON on disk → defaults, never throws", async () => {
  await writeFile(CTL_PATH, "{ this is not valid json ", "utf8");
  let v;
  await assert.doesNotReject(async () => {
    v = await readControl();
  });
  assert.equal(v.source, "env-default");
  assert.equal(v.armed, false);
  await rm(CTL_PATH, { force: true });
});

test("writeControl over malformed file → writes fresh valid control", async () => {
  await writeFile(CTL_PATH, "<<garbage>>", "utf8");
  await writeControl({ armed: true }, { now: "2026-01-01T00:00:00.000Z" });
  const raw = JSON.parse(await readFile(CTL_PATH, "utf8"));
  assert.equal(raw.armed, true);
  assert.equal(raw.version, CONTROL_VERSION);
  await rm(CTL_PATH, { force: true });
});
