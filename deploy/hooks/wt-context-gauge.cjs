#!/usr/bin/env node
"use strict";
// WS2 GAUGE PRODUCER (Linux node). Computes this session's live context
// occupancy from its transcript and POSTs it into the hub registry, so the
// conductor can see who is approaching the ≥400k compaction threshold.
//
// Wiring: a PostToolUse hook (catch-all, no matcher) — PostToolUse fires after
// EVERY tool call including radio_standby, so this satisfies the frozen
// contract's "fire on BOTH per-standby AND PostToolUse" with one hook. It is
// fire-and-forget and silent on any failure: it must never block, slow, or
// break a tool call (same discipline as radio-taskboard.js / the SessionStart
// probe). No token or no session_id → no-op.
//
// FROZEN CONTRACT (c0b6-ws5-conductor-design.md §5):
//   context_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
//   EXCLUDE output_tokens (proven double-count). usage at .message.usage.
//   Backward-scan to the LAST assistant-with-usage line (the EOF line is ~never
//   it). EXCLUDE subagents: glob */<sid>.jsonl skips the subagents/ subdir AND
//   isSidechain !== true belt (sidechain turns are inlined in the main
//   transcript with their own usage and must NOT be counted). missing field → 0.
//   null gauge → no write ("gauge pending"). Stamp a freshness-ts (context_ts) =
//   LIVENESS, not currency (advancing=live-but-quiet, stalled=frozen gauge).
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Pure core (unit-tested by wt-context-gauge.test.js). Returns the gauge integer,
// or null when no usage-bearing main-session line exists yet.
function computeGauge(transcriptText) {
  if (!transcriptText) return null;
  const lines = transcriptText.split("\n");
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // malformed/partial line — skip
    }
    if (!obj || typeof obj !== "object") continue;
    if (obj.isSidechain === true) continue; // subagent turn inlined in the main transcript — exclude
    const usage = obj.message && obj.message.usage; // usage lives at .message.usage, NOT top-level
    if (!usage || typeof usage !== "object") continue;
    return num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
  }
  return null;
}

// Locate the MAIN-session transcript: ~/.claude/projects/<cwd-enc>/<sid>.jsonl.
// We scan only ONE level under projects/ (each project dir directly), never the
// nested subagents/ subdir — so a subagent transcript (…/subagents/<hash>.jsonl)
// is excluded by PATH. Returns null if not found (→ no-op).
function findMainTranscript(projectsRoot, sessionId) {
  let entries;
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(projectsRoot, e.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8"); // hook payload on stdin
  } catch {
    raw = "";
  }
  let hook = {};
  try {
    hook = JSON.parse(raw);
  } catch {
    hook = {};
  }

  const sessionId = hook.session_id || process.env.CLAUDE_SESSION_ID || "";
  if (!sessionId) return; // can't key the registry row → no-op

  const token = process.env.WALKIE_TALKIE_JOIN_TOKEN || "";
  if (!token) return; // non-parallel session / hub auth absent → no-op
  const hub = process.env.WALKIE_TALKIE_HUB_URL || process.env.HUB_URL || "http://localhost:9559";

  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const transcriptPath = findMainTranscript(projectsRoot, sessionId);
  if (!transcriptPath) return;

  let text = "";
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return;
  }

  const gauge = computeGauge(text);
  if (gauge == null) return; // gauge pending — write nothing rather than a misleading 0

  // session_id is the stable key; include spawn_id (launcher-injected) so a
  // gauge-only POST merges onto the SAME row the launcher/hook seeded.
  const payload = { session_id: sessionId, context_tokens: gauge, context_ts: Date.now() };
  const spawnId = process.env.WT_SPAWN_ID || "";
  if (spawnId) payload.spawn_id = spawnId;

  try {
    fetch(`${hub}/session-register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {
    /* fetch unavailable / threw synchronously — silent */
  }
}

module.exports = { computeGauge, findMainTranscript };

if (require.main === module) main();
