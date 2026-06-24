#!/usr/bin/env node
// Agent Fleet meta-harness 4B: all-tools lease heartbeat.
//
// Registered as a PreToolUse hook with NO matcher, so it fires before EVERY tool.
// Firing PRE-tool (not post) is deliberate: a long-running single tool — e.g. a
// multi-minute subagent — renews this session's plan-task lease right BEFORE the
// gap, instead of only after it returns (by which point a short lease could already
// have expired and the hub reclaimed the task). It tells the hub "session <sid> is
// still alive": POST /plan-heartbeat renews the lease on every claimed/in_progress
// task this session owns (the hub scopes by owner_sid; review/blocked are parked and
// untouched). Throttled so a busy session doesn't hammer the hub, and silent on any
// failure — a heartbeat must never block or slow a tool.
//
// owner_sid == session_id == board sid: a claim made through the MCP server binds
// owner_sid to CLAUDE_CODE_SESSION_ID (the same id this hook reads from the payload),
// so the hub renews exactly the tasks this session holds.
const fs = require("node:fs");
const path = require("node:path");

const HUB = process.env.AGENT_FLEET_HUB_URL || process.env.WALKIE_TALKIE_HUB_URL || process.env.HUB_URL || "http://localhost:9559";
const TOKEN = process.env.AGENT_FLEET_JOIN_TOKEN || process.env.WALKIE_TALKIE_JOIN_TOKEN;
const STATE = path.join(__dirname, "state");

function seconds(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return (Number.isFinite(v) && v >= 0 ? v : dflt) * 1000;
}
// Renew well within the lease window (AF_PLAN_LEASE_SECONDS, 1800s post-deploy): a
// 120s throttle gives ~15 renewals per lease — cheap, with a wide safety margin.
const INTERVAL =
  Number.isFinite(parseInt(process.env.AF_PLAN_HEARTBEAT_INTERVAL, 10))
    ? seconds("AF_PLAN_HEARTBEAT_INTERVAL", 120)
    : seconds("WT_PLAN_HEARTBEAT_INTERVAL", 120);

function fresh(file, ms) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < ms;
  } catch {
    return false;
  }
}
function touch(file) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(file, "");
  } catch {}
}

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  if (!TOKEN) return;
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {}
  const sid = input.session_id;
  if (!sid || sid === "nosession") return;

  // Throttle: at most one heartbeat per INTERVAL per session. Marked before the
  // POST, so a transient hub blip costs at most one skipped tick (the lease has
  // ~15 ticks of slack), never a tight retry loop.
  const mark = path.join(STATE, `plan-heartbeat-${sid}`);
  if (fresh(mark, INTERVAL)) return;
  touch(mark);

  try {
    await fetch(`${HUB}/plan-heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ owner_sid: sid }),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    /* hub down or tunnel dropped: stay silent — the lease just isn't renewed this tick */
  }
});
