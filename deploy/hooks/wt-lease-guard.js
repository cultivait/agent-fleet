#!/usr/bin/env node
// C4: Resource-lock guard — PreToolUse hook (fail-open).
//
// Blocks Edit/Write/Bash targeting a surface tagged in WT_GUARDED_SURFACES
// unless this session holds an active resource lock for it on the hub.
// Fail-open by design: any hub error, timeout, or missing env var allows the
// tool through unchanged — a guard that randomly blocks is worse than no guard.
//
// INSTALLATION (deploy-gated — do NOT install until hub C4 is deployed):
//   cp deploy/wt-lease-guard.js ~/.claude/hooks/wt-lease-guard.js
//   chmod +x ~/.claude/hooks/wt-lease-guard.js
//   Then register in Claude settings.json under PreToolUse:
//     { "matcher": "Edit|Write|Bash", "hooks": [{ "type": "command",
//       "command": "/home/user/.claude/hooks/wt-lease-guard.js", "timeout": 3 }] }
//
// Tagging format (JSON array in WT_GUARDED_SURFACES env var):
//   [{"pattern": "/home/user/walkie-talkie/hub/src/server.ts", "resource_key": "hub:server.ts"}, ...]
// Pattern is a literal path prefix (no glob) for simplicity.
'use strict';

const HUB = process.env.WALKIE_TALKIE_HUB_URL || process.env.HUB_URL || 'http://localhost:9559';
const TOKEN = process.env.WALKIE_TALKIE_JOIN_TOKEN;

// Guards: array of { pattern: string, resource_key: string }
let GUARDS = [];
try {
  const raw = process.env.WT_GUARDED_SURFACES;
  if (raw) GUARDS = JSON.parse(raw);
} catch { /* malformed env — fail open */ }

function matchesGuard(toolName, toolInput) {
  if (!GUARDS.length) return null;

  const candidates = [];
  if (toolName === 'Edit' || toolName === 'Write') {
    if (toolInput.file_path) candidates.push(toolInput.file_path);
  } else if (toolName === 'Bash') {
    const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
    for (const g of GUARDS) {
      if (cmd.includes(g.pattern)) return g;
    }
    return null;
  }

  for (const candidate of candidates) {
    for (const g of GUARDS) {
      if (candidate === g.pattern || candidate.startsWith(g.pattern)) return g;
    }
  }
  return null;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(tid);
  }
}

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', async () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* allow */ }

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const sid = input.session_id;

  if (!['Edit', 'Write', 'Bash'].includes(toolName)) process.exit(0);
  if (!GUARDS.length) process.exit(0);
  if (!TOKEN) process.exit(0);

  const guard = matchesGuard(toolName, toolInput);
  if (!guard) process.exit(0);

  if (!sid) process.exit(0); // can't verify without session id — fail open

  try {
    const url = `${HUB}/resource-lock-get?resource_key=${encodeURIComponent(guard.resource_key)}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }, 2000);
    if (!res.ok) process.exit(0); // hub error — fail open
    const body = await res.json();
    const lock = body.lock;

    if (!lock) {
      // No lock row at all — block: caller must acquire first.
      console.error(
        `[wt-lease-guard] BLOCKED: '${guard.resource_key}' is a guarded surface. ` +
        `Acquire a lock first: radio_lock_acquire resource_key="${guard.resource_key}".`
      );
      process.exit(1);
    }

    if (lock.owner_sid !== sid) {
      const now = Date.now();
      if (lock.lease_expires_at < now) {
        // Expired — fail open (lazy reclaim will clear it on next hub read).
        process.exit(0);
      }
      console.error(
        `[wt-lease-guard] BLOCKED: '${guard.resource_key}' is locked by session ${lock.owner_sid} ` +
        `(expires in ${Math.round((lock.lease_expires_at - now) / 1000)}s). ` +
        `Wait for release or acquire after expiry.`
      );
      process.exit(1);
    }
    // This session holds a live lock — allow.
    process.exit(0);
  } catch {
    // Any error (timeout, network, parse) — fail open.
    process.exit(0);
  }
});
