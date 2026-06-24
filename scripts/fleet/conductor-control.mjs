#!/usr/bin/env node
// scripts/fleet/conductor-control.mjs
//
// OPERATOR CONTROL FILE lib for the WS5 conductor (Operator Control Panel, WS-A).
//
// The operator (cockpit UI → hub admin endpoints, WS-B) WRITES this file; the
// conductor daemon (conductor-executor.mjs, WS-A) READS it at the TOP of every tick.
// It is the live, restart-free source of truth for arm/observe, pause, the live
// tunables (idleWindowMs / intervalMs), and the kill-exempt PIN set (by callsign).
//
// SEPARATE from conductor-state.json (the brain's own idle-reap ring buffer). This
// file is OPERATOR-authored; that file is CONDUCTOR-authored. Never conflate them.
//
// Precedence per field: control-file (valid, non-null) > env var > hardcoded default.
//   armed        ← file.armed        ?? (WT_CONDUCTOR_ARMED==="1")    ?? false
//   paused       ← file.paused       ??                                  false
//   idleWindowMs ← file.idleWindowMs ?? WT_CONDUCTOR_W_IDLE_MS        ?? null (brain default)
//   intervalMs   ← file.intervalMs   ??                                  null (--interval/30s)
//   pinned       ← file.pinned       ?? WT_CONDUCTOR_PIN (callsigns)  ?? []
//
// NOTE on pinned's env fallback: `pinned` is keyed on CALLSIGN (stable, operator-
// facing; sid churns on reconnect — b37c, load-bearing). The pre-existing
// WT_CONDUCTOR_EXCLUDE is SID-keyed and stays in its own exclude path untouched —
// it is a DIFFERENT identifier space, so the env fallback here is the new
// callsign-keyed WT_CONDUCTOR_PIN, NOT WT_CONDUCTOR_EXCLUDE (deviation from plan §1
// literal text, flagged to lead — sid≠callsign).
//
// readControl() is TOLERANT: missing file → defaults; junk JSON / bad field types →
// fall back to env/default for that field, NEVER throw (a bad file must not crash the
// tick loop). writeControl(partial) is ATOMIC: write a unique *.tmp + rename, so a
// concurrent tick never reads a torn file.
//
// SAFETY FLOORS (intervalMs ≥ 5000, idleWindowMs ≥ 60000) are NOT applied here — they
// are enforced authoritatively by the backend write endpoint (WS-B, 400 on bad) and
// defensively at the CONSUMER (executor A2). readControl returns raw-but-typed values.
//
// Pure module (only node:fs/os/path); exported for `node --test` and imported by the
// hub backend (WS-B) as the single schema/IO authority — do not re-implement there.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const CONTROL_FILE =
  process.env.AF_CONDUCTOR_CONTROL_FILE ||
  process.env.WT_CONDUCTOR_CONTROL_FILE ||
  join(homedir(), ".config", "agent-fleet", "conductor-control.json");

export const CONTROL_VERSION = 1;

/** Lowest-precedence hardcoded defaults. */
export const CONTROL_DEFAULTS = Object.freeze({
  version: CONTROL_VERSION,
  armed: false,
  paused: false,
  idleWindowMs: null,
  intervalMs: null,
  pinned: [],
});

// ── type-tolerant coercion helpers ───────────────────────────────────────────

/** boolean or null (null = "field absent / not a bool"). */
function asBoolOrNull(v) {
  return typeof v === "boolean" ? v : null;
}

/** positive finite number, else null (null = "defer to env/default"). */
function asPosNumOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** array → deduped non-empty trimmed strings; non-array → null (field absent). */
function asStringArrayOrNull(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    if (typeof x === "string") {
      const s = x.trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/**
 * Extract the env-derived fallbacks (parsed). Pure given an env object.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function envFallbacks(env = process.env) {
  const idle = Number(env.WT_CONDUCTOR_W_IDLE_MS);
  return {
    armed: env.WT_CONDUCTOR_ARMED === "1" ? true : null, // null = unset
    idleWindowMs: Number.isFinite(idle) && idle > 0 ? idle : null,
    pinned: (env.WT_CONDUCTOR_PIN || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * PURE merge: control-file object (or null) + env fallbacks → resolved view.
 * Precedence per field: file (valid, non-null) > env > default. Never throws.
 *
 * @param {object|null} fileObj  parsed control-file JSON (null/garbage → {} treated)
 * @param {ReturnType<typeof envFallbacks>} env  env-derived fallbacks
 * @returns {{version:number,armed:boolean,paused:boolean,idleWindowMs:number|null,
 *           intervalMs:number|null,pinned:string[],updatedAt:string|null,
 *           updatedBy:string|null}}
 */
export function resolveControl(fileObj, env) {
  const f = fileObj && typeof fileObj === "object" ? fileObj : {};

  const fileArmed = asBoolOrNull(f.armed);
  const fileIdle = asPosNumOrNull(f.idleWindowMs);
  const fileInterval = asPosNumOrNull(f.intervalMs);
  const filePinned = asStringArrayOrNull(f.pinned);

  return {
    version: Number.isInteger(f.version) ? f.version : CONTROL_DEFAULTS.version,
    armed: fileArmed ?? env.armed ?? CONTROL_DEFAULTS.armed,
    paused: asBoolOrNull(f.paused) ?? CONTROL_DEFAULTS.paused,
    idleWindowMs: fileIdle ?? env.idleWindowMs ?? CONTROL_DEFAULTS.idleWindowMs,
    intervalMs: fileInterval ?? CONTROL_DEFAULTS.intervalMs,
    // file array (even []) wins when present; else env list (if any); else default [].
    pinned: filePinned ?? (env.pinned && env.pinned.length ? env.pinned : CONTROL_DEFAULTS.pinned),
    updatedAt: typeof f.updatedAt === "string" ? f.updatedAt : null,
    updatedBy: typeof f.updatedBy === "string" ? f.updatedBy : null,
  };
}

/** Read the raw on-disk control object (or null if absent/garbage). Never throws. */
async function readRaw() {
  try {
    const parsed = JSON.parse(await readFile(CONTROL_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // ENOENT or bad JSON → caller degrades to env/default
  }
}

/**
 * Read + merge the operator control file with env + defaults.
 * Precedence per field: control-file (valid) > env > default. NEVER throws.
 * @returns resolved view + `source` ("file" when a parseable file was found).
 */
export async function readControl() {
  const raw = await readRaw();
  const view = resolveControl(raw, envFallbacks());
  return { ...view, source: raw ? "file" : "env-default" };
}

/**
 * Atomically merge `partial` over the CURRENT on-disk file and persist it.
 * Only keys present in `partial` are changed (partial-merge); types are normalized
 * so a direct caller cannot persist garbage. Range VALIDATION is the backend's job
 * (WS-B, 400 on bad) — this trusts already-validated input. Atomic temp+rename.
 *
 * @param {Partial<{armed:boolean,paused:boolean,idleWindowMs:number|null,
 *                  intervalMs:number|null,pinned:string[]}>} partial
 * @param {{updatedBy?:string, now?:string}} [opts]  now = ISO override for tests
 * @returns {Promise<object>} the full control object written to disk.
 */
export async function writeControl(partial = {}, opts = {}) {
  const cur = (await readRaw()) || {};

  const next = {
    version: CONTROL_VERSION,
    armed: ("armed" in partial ? asBoolOrNull(partial.armed) : asBoolOrNull(cur.armed)) ?? CONTROL_DEFAULTS.armed,
    paused: ("paused" in partial ? asBoolOrNull(partial.paused) : asBoolOrNull(cur.paused)) ?? CONTROL_DEFAULTS.paused,
    idleWindowMs: "idleWindowMs" in partial ? asPosNumOrNull(partial.idleWindowMs) : asPosNumOrNull(cur.idleWindowMs),
    intervalMs: "intervalMs" in partial ? asPosNumOrNull(partial.intervalMs) : asPosNumOrNull(cur.intervalMs),
    pinned: ("pinned" in partial ? asStringArrayOrNull(partial.pinned) : asStringArrayOrNull(cur.pinned)) ?? [],
    updatedAt: opts.now ?? new Date().toISOString(),
    updatedBy: typeof opts.updatedBy === "string" && opts.updatedBy ? opts.updatedBy : "operator",
  };

  await mkdir(dirname(CONTROL_FILE), { recursive: true });
  // Unique tmp per process so two writers never clobber each other's temp file;
  // rename is atomic on the same filesystem → a reader never sees a torn JSON.
  const tmp = `${CONTROL_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await rename(tmp, CONTROL_FILE);
  return next;
}
