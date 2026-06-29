#!/usr/bin/env node
// Task board hook: feeds the agent-fleet hub's live per-agent task board.
// Pure plumbing — the model never interacts with this.
//   PostToolUse -> TodoWrite: forward the todo list verbatim (instant)
//                  any other tool: throttled "current activity" heartbeat
//                  fleet_join: create board entry (resets subagent count to 0)
//                  fleet_disconnect: mark signed-off
//   PreToolUse  -> Agent/Task: increment the live subagent count (matcher-gated)
//   SubagentStop-> decrement the live subagent count (>=0)
//   Stop        -> mark idle (subagent count left intact: bg agents may run on)
// The mission line is NOT set here: agents set it intentionally via the
// fleet_mission MCP tool (prompt text is never auto-published — Operator's call,
// 2026-06-12, after user flagged the leak vector).
// Auth: AGENT_FLEET_JOIN_TOKEN (same join token the msgcheck hook uses).
// Exits silently when this session never joined the fleet or the hub is down.
'use strict';
const fs = require('fs');
const path = require('path');

const STATE = path.join(__dirname, 'state');
const HUB = process.env.AGENT_FLEET_HUB_URL || process.env.WALKIE_TALKIE_HUB_URL || process.env.HUB_URL || 'http://localhost:9559';
const TOKEN = process.env.AGENT_FLEET_JOIN_TOKEN || process.env.WALKIE_TALKIE_JOIN_TOKEN;
const NODE_NAME =
  process.env.AF_NODE_NAME || process.env.WT_NODE_NAME || { win32: 'windows', linux: 'linux', darwin: 'mac' }[process.platform] || 'node';

function seconds(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return (Number.isFinite(v) && v >= 0 ? v : dflt) * 1000;
}
const ACTIVITY_INTERVAL =
  Number.isFinite(parseInt(process.env.AF_BOARD_INTERVAL, 10))
    ? seconds('AF_BOARD_INTERVAL', 15)
    : seconds('WT_BOARD_INTERVAL', 15);

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
    fs.writeFileSync(file, '');
  } catch {}
}
function readState(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Windows convention: hooks/state/callsign-<sid>.txt; linux convention: /tmp/wt-callsign-<sid>
function readCallsign(sid) {
  return readState(path.join(STATE, `callsign-${sid}.txt`)) || readState(`/tmp/wt-callsign-${sid}`);
}

// Live subagent count per session: a tiny integer counter file, incremented when
// an Agent/Task tool spawns a subagent (PreToolUse) and decremented when one
// finishes (SubagentStop). Clamped at >=0. Keyed by session id so a fresh
// session starts at zero. The hub clears a stale count on (re)join and on
// retire, so a killed session can't leave a ghost badge.
function countFile(sid) {
  return path.join(STATE, `subagents-${sid}.txt`);
}
function readCount(sid) {
  const v = parseInt(readState(countFile(sid)) || '0', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function writeCount(sid, n) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(countFile(sid), String(Math.max(0, n)));
  } catch {}
}

// Harness-native task list (TaskCreate/TaskUpdate) is stored one JSON file per
// task at <claude_home>/tasks/<sid>/<id>.json. The hook lives in
// <claude_home>/hooks, so the store is ../tasks/<sid>. Read the whole dir and
// return the list as board todos, sorted by numeric id. Returns null if absent.
const TASKS_DIR = path.join(__dirname, '..', 'tasks');
function readHarnessTasks(sid) {
  // Store dir naming drifted across Claude Code versions: newer builds write
  // session-<first8>/, older builds used the full <session-id>/. Resolve whichever
  // exists (new convention first). This kept board todos from rendering after the
  // harness flipped to the session-<short> layout — the reader still globbed the
  // old full-id dir and silently returned null. (fixed 2026-06-16)
  let dir = null;
  let files = null;
  const candidates = [path.join(TASKS_DIR, `session-${String(sid).slice(0, 8)}`), path.join(TASKS_DIR, sid)];
  for (const c of candidates) {
    try {
      files = fs.readdirSync(c).filter((f) => f.endsWith('.json'));
      dir = c;
      break;
    } catch {
      /* try next candidate */
    }
  }
  if (!dir) return null;
  const tasks = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (t && t.subject && t.status !== 'deleted') tasks.push(t);
    } catch {
      /* skip partial/locked file */
    }
  }
  if (tasks.length === 0) return null;
  tasks.sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0));
  return tasks.map((t) => ({ content: oneline(t.subject, 200), status: t.status || 'pending' }));
}

// Session id of the current hook invocation, injected into every post so the
// hub can tie a board card to its owning session and drop the stale card a
// session leaves behind when it rejoins under a new callsign (rename).
let CURRENT_SID = null;

async function post(patch) {
  try {
    await fetch(`${HUB}/board-update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: NODE_NAME, sid: CURRENT_SID, ...patch }),
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    /* hub down or tunnel dropped: stay silent */
  }
}

function oneline(s, n) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
}

function describe(tool, ti) {
  ti = ti || {};
  switch (tool) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return ti.file_path ? `${tool} ${oneline(ti.file_path, 90)}` : tool;
    case 'Bash':
    case 'PowerShell':
      return `${tool}: ${oneline(ti.description || ti.command || '', 90)}`;
    case 'Grep':
    case 'Glob':
      return `${tool}: ${oneline(ti.pattern || '', 60)}`;
    case 'Agent':
    case 'Task':
      return `Subagent: ${oneline(ti.description || ti.prompt || '', 90)}`;
    case 'WebFetch':
      return `WebFetch: ${oneline(ti.url || '', 90)}`;
    case 'WebSearch':
      return `WebSearch: ${oneline(ti.query || '', 90)}`;
    case 'Skill':
      return `Skill: ${oneline(ti.skill || '', 60)}`;
    default:
      return tool;
  }
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', async () => {
  if (!TOKEN) return;
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {}
  const sid = input.session_id || 'nosession';
  CURRENT_SID = sid;
  const event = input.hook_event_name || '';
  const callsign = readCallsign(sid);

  if (event === 'Stop') {
    if (!callsign) return;
    // Leave the subagent count untouched: background subagents may still be
    // working while the main loop idles, and we want the badge to reflect that.
    await post({ name: callsign, status: 'idle', activity: null });
    return;
  }

  // A subagent is being spawned (registered with matcher Agent|Task) — bump the
  // live count. Maintain the counter even if this session never joined.
  if (event === 'PreToolUse') {
    const tool = input.tool_name || '';
    if (tool === 'Agent' || tool === 'Task') {
      const n = readCount(sid) + 1;
      writeCount(sid, n);
      if (callsign) await post({ name: callsign, status: 'active', subagents: n });
    }
    return;
  }

  // A subagent finished — drop the live count (never below zero).
  if (event === 'SubagentStop') {
    const n = Math.max(0, readCount(sid) - 1);
    writeCount(sid, n);
    if (callsign) await post({ name: callsign, subagents: n });
    return;
  }

  if (event !== 'PostToolUse') return;
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};

  if (/__(radio|fleet)_join$/.test(tool)) {
    const name = ti.name;
    if (!name) return;
    // Reset the live subagent badge: a fresh (or rejoined) session has none
    // running yet, and this clears any ghost count left by a prior session
    // that reused this callsign.
    writeCount(sid, 0);
    await post({ name, status: 'active', subagents: 0 });
    return;
  }
  if (/__(radio|fleet)_(out|disconnect)$/.test(tool)) {
    if (callsign) await post({ name: callsign, status: 'signed-off', activity: null });
    return;
  }
  if (tool.includes('walkie-talkie') || tool.includes('agent-fleet')) return; // standby/check chatter is not activity
  if (!callsign) return;

  if (tool === 'TodoWrite') {
    const todos = Array.isArray(ti.todos) ? ti.todos.map((t) => ({ content: t.content, status: t.status })) : [];
    await post({ name: callsign, status: 'active', todos });
    return;
  }

  // Harness-native task list: republish the full list on every create/update.
  if (tool === 'TaskCreate' || tool === 'TaskUpdate') {
    const todos = readHarnessTasks(sid);
    if (todos) await post({ name: callsign, status: 'active', todos });
    return;
  }

  const mark = path.join(STATE, `board-activity-${sid}`);
  if (fresh(mark, ACTIVITY_INTERVAL)) return;
  touch(mark);
  await post({ name: callsign, status: 'active', activity: describe(tool, ti) });
});
