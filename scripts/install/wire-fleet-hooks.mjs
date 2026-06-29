#!/usr/bin/env node
// ============================================================================
// wire-fleet-hooks.mjs — single source of truth for the Agent Fleet hook wiring.
//
// Used by BOTH install.sh (posix) and install.ps1 (windows) so the canonical
// settings.json wiring can never drift between platforms. Merges the fleet hooks
// into the user's Claude Code settings.json:
//   - non-destructive: a user's own hooks (e.g. block-destructive.py) are kept
//   - idempotent: re-running replaces the fleet entries, never duplicates them
//
// The wiring itself was sourced from the live deployment (the deploy/hooks README
// documents only a subset; the messaging hooks — rewake/sessionstart/msgcheck —
// are wired here too, or a fresh install would never wake on messages).
//
// Inputs (env):
//   FLEET_SETTINGS    absolute path to the target settings.json
//   FLEET_HOOKS_DIR   absolute path to the installed hooks dir (~/.claude/hooks)
//   FLEET_JOIN_TOKEN  join token to place in settings.env (for the hooks)
//   FLEET_HUB_URL     hub base URL for the hooks (default http://localhost:9559)
//   FLEET_PLATFORM    "posix" (default) | "windows"
//
// Platform difference: on posix the hook command is the bare script path (the
// shebang + exec bit pick the interpreter). Windows has no shebang/exec bit, so
// each command is interpreter-prefixed: `bash "<path>.sh"` and `node "<path>.js"`
// / `node "<path>.cjs"`, with forward-slash paths (accepted by both Git Bash and
// node on Windows).
// ============================================================================
import fs from "node:fs";
import path from "node:path";

const SETTINGS = req("FLEET_SETTINGS");
const HOOKS_DIR = req("FLEET_HOOKS_DIR");
const JOIN_TOKEN = req("FLEET_JOIN_TOKEN");
const HUB_URL = process.env.FLEET_HUB_URL || "http://localhost:9559";
const PLATFORM = process.env.FLEET_PLATFORM === "windows" ? "windows" : "posix";

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`wire-fleet-hooks: missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

const toFwd = (p) => p.replace(/\\/g, "/");
// Windows: the bash that runs the .sh hooks. install.ps1 passes the detected
// Git-Bash path (it may not be on PATH); fall back to a bare `bash`.
const BASH = process.env.FLEET_BASH ? toFwd(process.env.FLEET_BASH) : "bash";

// Build the settings.json command string for a hook file, interpreter-aware.
function command(file) {
  if (PLATFORM === "posix") return path.join(HOOKS_DIR, file); // shebang handles it
  const p = toFwd(path.join(HOOKS_DIR, file));
  return file.endsWith(".sh") ? `"${BASH}" "${p}"` : `node "${p}"`; // .js / .cjs → node
}

const entry = (file, timeout, extra = {}) => ({ type: "command", command: command(file), timeout, ...extra });

// The complete working fleet wiring (event → list of {matcher?, hooks:[...]}).
const WIRING = {
  SessionStart: [{ hooks: [entry("agent-fleet-sessionstart.sh", 10)] }],
  Stop: [
    { hooks: [entry("agent-fleet-rewake.sh", 1860, { rewakeSummary: "Radio traffic waiting" })] },
    { hooks: [entry("fleet-taskboard.js", 10)] },
  ],
  SubagentStop: [{ hooks: [entry("fleet-taskboard.js", 10)] }],
  PostToolUse: [
    { hooks: [entry("agent-fleet-msgcheck.sh", 10)] },
    { matcher: "mcp__.*__(radio|fleet)_.*", hooks: [entry("agent-fleet-tabtitle.sh", 10)] },
    { hooks: [entry("fleet-taskboard.js", 10)] },
    { hooks: [entry("wt-context-gauge.cjs", 5)] },
  ],
  PreToolUse: [
    { matcher: "Edit|Write|Bash", hooks: [entry("wt-lease-guard.js", 3)] },
    { matcher: "Agent|Task", hooks: [entry("fleet-taskboard.js", 10)] },
    { hooks: [entry("fleet-plan-heartbeat.js", 10)] },
    // Same gauge as PostToolUse:72 — bracket every tool call on both sides so the
    // board's context-token figure is never >1 tool-call stale during active work.
    // (No periodic/timer writer: an idle/standby agent's context isn't growing, so a
    // steady gauge there is correct, not stale.)
    { hooks: [entry("wt-context-gauge.cjs", 5)] },
  ],
};

// A fleet-owned hook command (so re-runs replace, never duplicate, and a user's
// own hooks are never touched). Match by basename anywhere in the command string
// (covers both the bare-path posix form and the `bash "..."`/`node "..."` form).
const FLEET_BASENAMES = [
  "agent-fleet-sessionstart.sh", "agent-fleet-msgcheck.sh", "agent-fleet-rewake.sh",
  "agent-fleet-tabtitle.sh", "fleet-taskboard.js", "fleet-plan-heartbeat.js",
  "wt-lease-guard.js", "wt-context-gauge.cjs",
];
const isFleetGroup = (g) =>
  Array.isArray(g?.hooks) &&
  g.hooks.some((h) => typeof h?.command === "string" && FLEET_BASENAMES.some((b) => h.command.includes(b)));

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
} catch {
  settings = {};
}
if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + ".bak");

settings.env = settings.env || {};
settings.env.AGENT_FLEET_JOIN_TOKEN = JOIN_TOKEN;
settings.env.AGENT_FLEET_HUB_URL = HUB_URL;

settings.hooks = settings.hooks || {};
for (const [event, groups] of Object.entries(WIRING)) {
  const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const kept = existing.filter((g) => !isFleetGroup(g)); // drop stale fleet entries
  settings.hooks[event] = [...kept, ...groups]; // re-add canonical fleet wiring
}

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
console.log(`  settings.json updated (${PLATFORM}; backup: settings.json.bak)`);
