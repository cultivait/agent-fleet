#!/usr/bin/env node
// fleet.mjs — D5 cross-platform fleet launcher (Linux + Windows).
//
// Standalone Node v22 ESM orchestrator. Built OUTSIDE the hub: NO hub restart,
// NO hook changes, NO MCP bundle. Spawns N detached Claude Code sessions per
// node; each self-joins the agent-fleet hub via its SessionStart hook.
//
// Model (Operator's calls, 2026-06-16): detached attachable sessions; Linux + Windows
// only (Mac dropped); v1 callsigns self-assigned, reconciled by roster diff.
//   Linux   → detached tmux session (holds claude) + a Ghostty window attached to it
//             (--term ghostty|tmux|auto); env via Approach B (source ~/.config/agent-fleet/env, back-compat ~/.config/walkie-talkie)
//   Windows → PowerShell Start-Process detached, token already in settings.json (Approach C)
//
// Linux terminal modes (Operator's call: Ghostty-wraps-tmux hybrid):
//   ghostty → tmux session + a Ghostty window running `tmux attach` (visible+interactive AND
//             persistent/reattachable; window opens on the box's physical :1 display)
//   tmux    → headless detached tmux only (best when driving remotely over SSH)
//   auto    → ghostty if a graphical session is detected, else tmux (default)
//
// Contract + grounded facts: ~/.claude/docs/meta-harness-overhaul/d5-build-plan.md
//
// Usage:
//   fleet up --linux N --windows M [--work-dir DIR] [--term ghostty|tmux|auto] [--referee] [--yes]
//   fleet status
//   fleet down [--yes]                                        (v1: local tmux reap only)
//
// SAFETY: `up` previews (spawns nothing) unless --yes is passed. Real spawns join
// the LIVE hub and consume API tokens — Operator-gated.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync, realpathSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIN_SSH_ALIAS, preflightWindows, spawnWindows } from './windows.mjs'; // Lane B (D5-W), owner linux-b37c

const execFileP = promisify(execFile);

const HUB_URL = process.env.AGENT_FLEET_HUB_URL || process.env.WALKIE_TALKIE_HUB_URL || 'http://localhost:9559';
// Config dir back-compat across the rename: honor AF_CONFIG_DIR (canonical) ?? legacy
// WT_WALKIE_CONFIG_DIR, else prefer the new ~/.config/agent-fleet once it exists
// (post-cutover) and fall back to the pre-cutover ~/.config/walkie-talkie — so the
// launcher sources the right env file on BOTH sides of the dir rename (Lane B owns the cutover).
const CONFIG_DIR = process.env.AF_CONFIG_DIR
  || process.env.WT_WALKIE_CONFIG_DIR
  || (existsSync(join(homedir(), '.config', 'agent-fleet', 'env'))
        ? join(homedir(), '.config', 'agent-fleet')
        : join(homedir(), '.config', 'walkie-talkie'));
const ENV_FILE = join(CONFIG_DIR, 'env');
const AUDIT_FILE = join(CONFIG_DIR, 'fleet-audit.jsonl');
// Pre-authorization for fleet BUILDERS (Operator 2026-06-22 "Pre-authorize builders"): a SCOPED
// --settings allowlist (Edit/Write on the trusted fleet trees) layered on the default AUTO
// mode, so a builder can self-modify hooks/launcher/mcp/MEMORY WITHOUT a per-edit prompt while
// still joining the fleet normally. NOTE: --permission-mode acceptEdits is NOT usable here — it
// prompts for every MCP call, so the builder hangs before fleet_join. The REFEREE lane never
// gets this (it coordinates, never edits). Lives next to the launcher so the path tracks the dir rename.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BUILDER_SETTINGS = join(SCRIPT_DIR, 'fleet-builder-settings.json');
// T3 strict-mcp-config (Variant B): fleet BUILDERS spawn with `--strict-mcp-config --mcp-config FLEET_MCP`
// so they load ONLY the walkie-talkie MCP — dropping the ~9 local mcpServers (fs/pg/sqlite/figma/…) and the
// claude.ai connectors that bloat every spawn's context. --strict-mcp-config ALONE also kills walkie-talkie
// (the agent can't join), so FLEET_MCP RE-DECLARES it. The config's plugin path is resolved DYNAMICALLY from
// installed_plugins.json (never a hardcoded …/1.7.0/…) and regenerated on every `up`, so a plugin upgrade
// can't silently break spawns. REFEREE lane is exempt (keeps full tools to coordinate). Path tracks the dir rename.
const FLEET_MCP = join(SCRIPT_DIR, 'fleet-mcp.json');
const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const JOIN_TIMEOUT_MS = Number(process.env.AF_FLEET_JOIN_TIMEOUT_MS || process.env.WT_FLEET_JOIN_TIMEOUT_MS || 45000);
const POLL_INTERVAL_MS = 3000;

// The reserved operator-identity callsign a --referee spawn promotes itself to via
// fleet_become_referee (the hub reserves it; the join path refuses reserved names). The
// roster-diff reconciler keys on this to recognize a referee self-join (it never shows as linux-<rid>).
const REFEREE_CALLSIGN = 'REFEREE';

// Hard concurrency ceiling for `fleet up` (current live local fleet + requested must not exceed it).
// Overridable via AF_FLEET_MAX (primarily for tests). A safety rail: real spawns join the LIVE hub
// and burn API tokens, so an accidental `--linux 50` must be refused, not honored.
const MAX_CONCURRENT_FLEET = 20; // WS-D(2): Operator wants headroom for multiple concurrent projects (was 5)

// A bare `claude` boots and sits idle at the prompt — the SessionStart hook injects the
// "call fleet_join" instruction but the agent only acts on it when it takes a turn. So every
// spawned teammate needs an INITIAL PROMPT to fire that first turn (→ join → stay interactive).
// Overridable per-run via --prompt, or globally via AF_FLEET_PROMPT.
const DEFAULT_PROMPT = process.env.AF_FLEET_PROMPT || process.env.WT_FLEET_PROMPT
  || 'You are a fleet teammate launched by the fleet launcher. Run your startup now: call fleet_join to join the agent-fleet, set a one-line mission with fleet_mission, then STOP — end your turn. Do NOT sit in a fleet_standby loop. A Stop-hook re-wakes you when work is queued for your callsign; only then call fleet_check ONCE to receive it, handle it, and stop again. Keep all comms terse.';

// REFEREE startup prompt. The --referee lane sets AF_ROLE/WT_ROLE=referee and the
// SessionStart hook INJECTS a "call fleet_become_referee" instruction — but the
// agent's actual turn-prompt is what it acts on, and DEFAULT_PROMPT explicitly says
// "call fleet_join", which pre-empts the hook: the referee registers via the member
// join path and keeps its default linux-XXXX callsign (the reserved-name register is
// never attempted). Fix at the source: a referee spawn is handed THIS prompt instead,
// so its startup action is fleet_become_referee (the admin path that mints the reserved
// REFEREE seat). Overridable: an explicit --prompt still wins (see buildSpawnInner).
const REFEREE_PROMPT = process.env.AF_REFEREE_PROMPT || process.env.WT_REFEREE_PROMPT
  || 'You are the fleet REFEREE — the operator-identity coordinator launched by the fleet launcher. Run your startup now: call fleet_become_referee to take the reserved REFEREE seat (it promotes this session via the admin token; the join path refuses reserved names, so do NOT call fleet_join). Then set a one-line mission with fleet_mission, then STOP — end your turn. Do NOT sit in a fleet_standby loop. A Stop-hook re-wakes you when work is queued for your callsign; only then call fleet_check ONCE to receive it, handle it, and stop again. Keep all comms terse.';

// ───────────────────────────── pure helpers (unit-tested) ─────────────────────────────

/** Parse argv (after `node fleet.mjs`) into a normalized command object. */
export function parseArgs(argv) {
  const out = { cmd: argv[0] || 'help', linux: 0, windows: 0, yes: false, dryRun: false, workDir: null, term: 'auto', prompt: DEFAULT_PROMPT, referee: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--linux') out.linux = Number(argv[++i]);
    else if (a === '--windows') out.windows = Number(argv[++i]);
    else if (a === '--work-dir') out.workDir = argv[++i];
    else if (a === '--term') out.term = argv[++i];
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--yes') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    // --referee: birth an operator-identity REFEREE (AF_ROLE/WT_ROLE=referee + the admin token reaches
    // this spawn ONLY). Least-privilege: every OTHER spawn has the admin token unset (see buildSpawnInner).
    else if (a === '--referee') out.referee = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.prompt || !String(out.prompt).trim()) throw new Error('--prompt must be a non-empty string (a bare claude never self-joins)');
  if (!Number.isInteger(out.linux) || out.linux < 0) throw new Error('--linux must be a non-negative integer');
  if (!Number.isInteger(out.windows) || out.windows < 0) throw new Error('--windows must be a non-negative integer');
  if (!['auto', 'ghostty', 'tmux'].includes(out.term)) throw new Error(`--term must be auto|ghostty|tmux (got ${out.term})`);
  // A REFEREE is a single operator identity (the hub reserves the 'referee' callsign and admin-register
  // sheds any prior holder) — refuse a multi-spawn that would birth colliding referees, and keep it on
  // the wired Linux path (the Windows lane does not carry --referee yet).
  if (out.referee && (out.linux !== 1 || out.windows !== 0)) {
    throw new Error('--referee births a single REFEREE identity — use it with exactly `--linux 1` and no --windows');
  }
  return out;
}

/** Parse a KEY=VALUE env file (ignores blanks/comments). Returns {KEY: VALUE}. */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

/** Map a hub callsign to its node. SessionStart hooks name sessions `<platform>-<suffix>`. */
export function classifyName(name) {
  if (name.startsWith('linux-')) return 'linux';
  if (name.startsWith('windows-')) return 'windows';
  if (name.startsWith('mac-')) return 'mac';
  return 'other';
}

/**
 * Reconcile a before/after roster snapshot against what was requested.
 * v1 is self-join: we can't predict exact callsigns, so we diff the roster and
 * count NEW names per node. This is the silent-failure detector (design §3.1 step 3).
 */
export function reconcile(before, after, expected) {
  const beforeSet = new Set(before);
  const newNames = after.filter((n) => !beforeSet.has(n));
  const joinedByNode = { linux: 0, windows: 0 };
  for (const n of newNames) {
    // A --referee spawn RENAMES itself to the reserved 'REFEREE' callsign via
    // fleet_become_referee, so it never appears as linux-<rid>. classifyName('REFEREE')
    // is 'other' → it would read as a shortfall and exit 1 on a successful launch. When
    // the lane is a referee, count REFEREE's appearance as the (single) linux self-join.
    const node = expected.referee && n === REFEREE_CALLSIGN ? 'linux' : classifyName(n);
    if (node === 'linux' || node === 'windows') joinedByNode[node]++;
  }
  const shortfall = {
    linux: Math.max(0, (expected.linux || 0) - joinedByNode.linux),
    windows: Math.max(0, (expected.windows || 0) - joinedByNode.windows),
  };
  return { requested: { ...expected }, joinedByNode, newNames, shortfall, ok: shortfall.linux === 0 && shortfall.windows === 0 };
}

/** Resilient v22 nvm bin glob for the spawn PATH (hooks need node >=20). */
export function v22PathPrefixSnippet() {
  // Prepend any installed nvm v22.* bin so spawned hooks resolve node>=20, not /usr/bin/node v18.
  return 'for d in "$HOME"/.config/nvm/versions/node/v22.*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; export PATH;';
}

// ───────────────────────────── I/O ─────────────────────────────

export async function loadEnv() {
  try {
    return parseEnvFile(await readFile(ENV_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Append ONE JSON line to the append-only audit log. Best-effort: never throws into a spawn/reap. */
function appendAudit(record) {
  try {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n');
  } catch { /* audit is best-effort; a failed write must never block a spawn or reap */ }
}

/**
 * Best-effort fire-and-forget POST to ${HUB_URL}/session-register (joinToken auth, SAME as /board-update:
 * `Authorization: Bearer <AGENT_FLEET_JOIN_TOKEN>`). The token is read from the sourced env file and
 * NEVER logged/inlined. ANY failure — including endpoint-not-found, it isn't live yet — is swallowed and
 * never blocks or fails the spawn. Short 2s timeout so a wedged hub can't stall the launcher.
 */
function fireRegister(payload, token) {
  if (!token) return Promise.resolve(); // no join token in env → skip silently (never throws)
  return fetch(`${HUB_URL}/session-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2000),
  }).catch(() => { /* best-effort: endpoint may be absent/unreachable; swallow */ });
}

/** List live local fleet tmux sessions (wt-*). Empty array if tmux is absent or there are none. */
async function listFleetSessions() {
  const { stdout } = await execFileP('bash', ['-lc', "tmux ls 2>/dev/null | grep '^wt-' || true"]).catch(() => ({ stdout: '' }));
  return parseTmuxSessions(stdout);
}

async function hubGet(path) {
  const res = await fetch(`${HUB_URL}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res;
}

/** Online callsigns on the hub. */
export async function roster() {
  const res = await hubGet('/users');
  const body = await res.json();
  const users = Array.isArray(body) ? body : body.users || [];
  return users.filter((u) => u.online !== false).map((u) => u.name);
}

async function preflightHub() {
  try {
    await roster();
    return { ok: true };
  } catch (e) {
    return { ok: false, err: `hub unreachable at ${HUB_URL}: ${e.message}` };
  }
}

function rid() {
  return Math.random().toString(16).slice(2, 8);
}

function fmtArgs(args) {
  return args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/** POSIX single-quote a string for safe embedding in the bash -lc payload. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * Pure: build the `bash -lc` payload that sets up a spawned session's env and execs claude.
 * The env file is SOURCED (Approach B) so no token VALUE ever lands on a command line.
 *
 * LEAST-PRIVILEGE (task #3): the env file carries BOTH the join AND the admin token, but a plain
 * builder must never hold the admin token. So the DEFAULT lane `unset`s AGENT_FLEET_ADMIN_TOKEN
 * (and the legacy WALKIE_TALKIE_ADMIN_TOKEN) right after the source — and because this is the
 * `bash -lc` payload (runs after ALL shell startup), it clears the admin token whether it came from
 * the file source OR was inherited from the launcher's own environment. The join token is kept (the
 * spawn must self-join the hub).
 *
 * The --referee lane is the ONE spawn that legitimately needs the admin token (its session promotes
 * itself to the reserved REFEREE callsign via fleet_become_referee). It KEEPS the admin token and
 * exports AF_ROLE/WT_ROLE=referee, which the live SessionStart hook keys on to birth the REFEREE identity.
 */
/** Sanitize a remote-control / radio callsign to the hub-safe charset [A-Za-z0-9-]. */
export function sanitizeCallsign(s) {
  return String(s).replace(/[^A-Za-z0-9-]/g, "");
}

// ── T3 strict-mcp-config (Variant B): resolve the installed walkie-talkie plugin dynamically ──

/**
 * Pure: given the parsed ~/.claude/plugins/installed_plugins.json, return the installPath for the
 * walkie-talkie plugin (any `walkie-talkie@<marketplace>` key), or null if absent. This is the
 * VERSION-AGNOSTIC source of truth — Claude Code rewrites installPath on every plugin upgrade, so
 * reading it (instead of hardcoding …/1.7.0/…) means an upgrade can never silently break spawns.
 */
export function pickPluginInstallPath(installedJson, name = 'walkie-talkie') {
  const plugins = installedJson && installedJson.plugins;
  if (!plugins || typeof plugins !== 'object') return null;
  const key = Object.keys(plugins).find((k) => k === name || k.startsWith(`${name}@`));
  if (!key) return null;
  const entries = plugins[key];
  const entry = Array.isArray(entries) ? entries[0] : entries;
  return (entry && typeof entry.installPath === 'string' && entry.installPath) || null;
}

/**
 * Pure: build the Variant-B MCP config object for a resolved plugin dir. ONLY walkie-talkie is
 * declared (re-declared because --strict-mcp-config alone also drops it). No env block — the
 * token + hub URL reach the MCP child from the sourced env file already in claude's environment.
 */
export function buildFleetMcpConfig(pluginDir) {
  return {
    mcpServers: {
      'walkie-talkie': { command: 'node', args: [join(pluginDir, 'dist', 'mcp-server.mjs')] },
    },
  };
}

/**
 * I/O: resolve the walkie-talkie plugin dir, newest-first. Order: explicit CLAUDE_PLUGIN_ROOT env →
 * installed_plugins.json installPath → glob the cache for the newest version dir that actually has
 * dist/mcp-server.mjs. Returns the plugin ROOT dir (the one containing dist/), or null if none found.
 */
export function resolvePluginDir(env = process.env) {
  const hasServer = (dir) => dir && existsSync(join(dir, 'dist', 'mcp-server.mjs'));
  // 1) explicit override
  if (hasServer(env.CLAUDE_PLUGIN_ROOT)) return env.CLAUDE_PLUGIN_ROOT;
  // 2) the canonical registry
  try {
    const installed = JSON.parse(readFileSync(join(PLUGINS_DIR, 'installed_plugins.json'), 'utf8'));
    const p = pickPluginInstallPath(installed);
    if (hasServer(p)) return p;
  } catch {}
  // 3) glob the cache: ~/.claude/plugins/cache/<marketplace>/walkie-talkie/<version>/
  try {
    const cache = join(PLUGINS_DIR, 'cache');
    const candidates = [];
    for (const market of readdirSync(cache)) {
      const wt = join(cache, market, 'walkie-talkie');
      if (!existsSync(wt)) continue;
      for (const ver of readdirSync(wt)) {
        const dir = join(wt, ver);
        if (hasServer(dir)) candidates.push(dir);
      }
    }
    // newest installed wins (mtime is the safe cross-version sort; semver strings don't compare cleanly)
    candidates.sort((a, b) => statMtime(b) - statMtime(a));
    if (candidates.length) return candidates[0];
  } catch {}
  return null;
}

function statMtime(dir) {
  try { return Number(statSync(dir).mtimeMs); } catch { return 0; }
}

/**
 * I/O: regenerate FLEET_MCP (fleet-mcp.json) from the freshly-resolved plugin dir and return its path.
 * Called on every `up` so the config tracks plugin upgrades. Throws if the plugin can't be resolved —
 * a builder spawned against a missing MCP would fail to join, so fail LOUD here rather than spawn-dead.
 */
export function writeFleetMcpConfig(env = process.env) {
  const pluginDir = resolvePluginDir(env);
  if (!pluginDir) throw new Error(`cannot resolve walkie-talkie plugin dir under ${PLUGINS_DIR} (installed_plugins.json + cache glob both missed)`);
  writeFileSync(FLEET_MCP, JSON.stringify(buildFleetMcpConfig(pluginDir), null, 2) + '\n');
  return FLEET_MCP;
}

/**
 * POSITIVE env allowlist for spawned sessions (post-outage hardening, incident 2026-06-28).
 *
 * The tmux server inherits the launcher's FULL environment. When `fleet up` is run from inside a
 * claude session (e.g. an operator re-seating a REFEREE), that session's per-session identity vars —
 * notably CLAUDE_CODE_SESSION_ID — leak into the server env, so EVERY pane on it boots forced to the
 * launcher's sid. A spawned builder then collides on the sid, regenerates to a fresh one, and that
 * rejoin orphans null-handle "ghost" rows on the hub.
 *
 * A denylist (`unset CLAUDE_CODE_SESSION_ID; …`) cannot win this: it already MISSED the var that bit
 * us, and it will miss the NEXT identity var Claude Code adds. So we build the child env POSITIVELY —
 * keep ONLY an explicit allowlist (system/login essentials, the fleet's own var prefixes, and the
 * non-identity Claude config/feature flags + tool keys a builder legitimately uses) and drop
 * everything else. Anything new and unrecognized — including a future CLAUDE_CODE_SESSION_UUID — is
 * dropped by default. Deliberate spawn config belongs in the sourced env file (the way
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE already does), not in ambient inheritance.
 *
 * NOTE: this governs only what may be INHERITED. The canonical env file is sourced AFTER this filter
 * (re-adding the join/admin tokens), and the role/callsign/spawn-id lines export the fleet vars
 * explicitly — so the filter can never starve a spawn of its credentials. Least-privilege admin-token
 * shedding still happens after the source (see buildSpawnInner).
 */
export const SPAWN_ENV_ALLOW = {
  keys: [
    // shell / login / system
    'HOME', 'PATH', 'SHELL', 'TERM', 'TERMINFO', 'COLORTERM', 'USER', 'LOGNAME', 'PWD', 'OLDPWD',
    'SHLVL', '_', 'HOSTNAME', 'HOSTTYPE', 'OSTYPE', 'MACHTYPE', 'TZ', 'TMPDIR', 'MANPATH', 'INFOPATH',
    'NODE_PATH', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY',
    'DBUS_SESSION_BUS_ADDRESS',
    // locale
    'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY',
    'LC_MESSAGES', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
    // node / nvm (the v22 PATH prefix re-derives bin, but keep nvm's own vars)
    'NVM_DIR', 'NVM_BIN', 'NVM_INC', 'NVM_CD_FLAGS',
    // XDG base dirs + session
    'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'XDG_CURRENT_DESKTOP', 'XDG_MENU_PREFIX', 'XDG_SESSION_CLASS',
    'XDG_SESSION_DESKTOP', 'XDG_SESSION_TYPE',
    // Claude NON-identity config/feature flags (the identity vars CLAUDE_CODE_SESSION_ID,
    // CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_EXECPATH, CLAUDECODE are
    // deliberately ABSENT here → dropped → a fresh claude mints its own) + tool keys a builder may
    // delegate to (gemini-agent etc.)
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_ENABLE_TELEMETRY',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_ROOT', 'GEMINI_API_KEY',
  ],
  // the fleet's own vars all share these prefixes (callsign/role/spawn-id/tokens/hub url/guarded surfaces)
  prefixes: ['AF_', 'WT_', 'AGENT_FLEET_', 'WALKIE_TALKIE_'],
};

/**
 * Pure: the bash snippet that enforces SPAWN_ENV_ALLOW. Drops every exported var NOT on the allowlist,
 * then returns so the payload can source the env file + export the fleet vars. Runs under `bash -lc`
 * (compgen is a bash builtin). Var names are [A-Za-z_][A-Za-z0-9_]* so they are safe in `case` patterns.
 */
export function spawnEnvAllowlistSnippet(allow = SPAWN_ENV_ALLOW) {
  const pats = [...allow.keys, ...allow.prefixes.map((p) => `${p}*`)].join('|');
  return `for __af_v in $(compgen -e); do case "$__af_v" in ${pats}) ;; *) unset "$__af_v" 2>/dev/null ;; esac; done; `;
}

export function buildSpawnInner({ envFile, id, prompt, referee = false }) {
  // Inserted AFTER the source: default sheds admin (least-privilege), referee marks the role + keeps admin.
  // Non-referee also sheds any leaked AF_ROLE/WT_ROLE — a parent/operator shell carrying *_ROLE=referee
  // must NOT ride into a plain builder, else the SessionStart hook would self-promote it to the reserved
  // REFEREE identity. The referee lane keeps AF_ROLE/WT_ROLE=referee as its deliberate identity driver.
  // TRANSITION: export BOTH the new (AF_*) and old (WT_*) role names, and unset BOTH admin-token names,
  // so a spawned agent's hooks work whether they read the new or the legacy variable.
  const roleLine = referee
    ? 'export AF_ROLE=referee; export WT_ROLE=referee; '
    : 'unset AGENT_FLEET_ADMIN_TOKEN; unset WALKIE_TALKIE_ADMIN_TOKEN; unset AF_ROLE; unset WT_ROLE; ';
  // WS-D(1) remote-control: align tmux session id = fleet callsign = Desktop/mobile name. The
  // non-referee callsign is linux-<rid> (matches the wt-<rid> session); export AF_CALLSIGN/WT_CALLSIGN so
  // the SessionStart hook adopts it, AND pass it to `--remote-control`. The REFEREE lane keeps
  // AF_ROLE/WT_ROLE=referee as the identity driver (fleet promotes it to the reserved REFEREE callsign)
  // and must NOT set the callsign vars — it only labels the remote-control target REFEREE.
  const callsign = referee ? REFEREE_CALLSIGN : sanitizeCallsign(`linux-${id}`);
  const callsignLine = referee ? '' : `export AF_CALLSIGN=${callsign}; export WT_CALLSIGN=${callsign}; `;
  // Referee gets the become-referee startup prompt, NOT the generic "call fleet_join"
  // DEFAULT_PROMPT (which would pre-empt the hook and keep the linux-XXXX callsign). An
  // explicit per-run --prompt (anything other than the default) is still honored.
  const effectivePrompt = referee && prompt === DEFAULT_PROMPT ? REFEREE_PROMPT : prompt;
  // Builders carry the scoped --settings allowlist (see BUILDER_SETTINGS) so they can self-mod
  // the trusted trees under auto mode without per-edit prompts. REFEREE lane stays unflagged.
  const settingsFlag = referee ? '' : `--settings ${shQuote(BUILDER_SETTINGS)} `;
  // T3 strict-mcp-config (Variant B): builders load ONLY the walkie-talkie MCP (see FLEET_MCP) — dropping
  // the ~9 local mcpServers + claude.ai connectors that bloat every spawn. --strict-mcp-config alone also
  // drops walkie-talkie, so FLEET_MCP re-declares it. REFEREE keeps full tools to coordinate → no mcpFlag.
  // The launcher regenerates FLEET_MCP (writeFleetMcpConfig) before spawning so the plugin path is fresh.
  const mcpFlag = referee ? '' : `--strict-mcp-config --mcp-config ${shQuote(FLEET_MCP)} `;
  // --no-chrome: fleet agents are headless tmux sessions with no browser-automation
  // role, but the Claude-in-Chrome integration is on by default and opens a new Chrome
  // tab per spawned session (the operator's "a tab opens every time an agent spawns").
  // Disable it here — independent of and fully compatible with --remote-control, which
  // is a session server that opens no tab on its own.
  // Sanitize the INHERITED env (positive allowlist) BEFORE sourcing the file, so a launcher-leaked
  // CLAUDE_CODE_SESSION_ID (and any future identity var) can never ride into the spawned claude and
  // trigger a sid collision → ghost rows. The source re-adds the tokens; the role line still sheds admin.
  return `${spawnEnvAllowlistSnippet()}set -a; . "${envFile}"; set +a; ${roleLine}${callsignLine}${v22PathPrefixSnippet()} export AF_SPAWN_ID=${id}; export WT_SPAWN_ID=${id}; exec claude --no-chrome ${settingsFlag}${mcpFlag}--remote-control ${callsign} ${shQuote(effectivePrompt)}`;
}

/** Build the exact tmux command for one Linux instance (no execution). `opts.referee` births a REFEREE. */
export function linuxSpawnCmd(workDir, prompt = DEFAULT_PROMPT, opts = {}) {
  const id = rid();
  const session = `wt-${id}`;
  // Approach B: source the canonical env file so the join token never hits a command line.
  // The positional prompt keeps claude INTERACTIVE (only -p is headless) but fires a first turn,
  // so the SessionStart join instruction actually runs — a bare `claude` would sit idle and never join.
  // AF_SPAWN_ID/WT_SPAWN_ID carries the SAME rid that names the session into the spawned env BEFORE exec
  // claude, so claude's SessionStart hook (a child process) inherits it and can correlate back to this spawn.
  const inner = buildSpawnInner({ envFile: ENV_FILE, id, prompt, referee: opts.referee === true });
  const args = ['new-session', '-d', '-s', session, '-c', workDir, 'bash', '-lc', inner];
  return { session, rid: id, bin: 'tmux', args };
}

/** Pure: parse `tmux ls` output (filtered to wt-* lines) into bare session names. */
export function parseTmuxSessions(stdout) {
  return String(stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(':')[0])
    .filter((s) => s.startsWith('wt-'));
}

/**
 * Pure: the tmux command that prints a session's pane-leader pid. The pane runs `bash -lc`
 * which ends in `exec claude`; exec replaces the shell IN PLACE (same pid), so pane_pid is the
 * durable Claude Code process pid — the value the hub needs for a direct kill(0) liveness probe
 * (vs. its tmux has-session fallback). Reading it right after new-session is safe: pane_pid is
 * fixed across the exec, so the value is the eventual claude pid even before exec lands.
 */
export function panePidCmd(session) {
  return { bin: 'tmux', args: ['display-message', '-p', '-t', session, '#{pane_pid}'] };
}

/** Pure: parse `tmux display-message '#{pane_pid}'` output → positive integer pid, or null. */
export function parsePanePid(stdout) {
  const n = parseInt(String(stdout || '').trim().split('\n')[0], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Pure: the on-disk path where a session's pipe-pane capture lands. Co-located with the launcher's
 * other CONFIG_DIR artifacts (env, fleet-audit.jsonl) so it tracks the dir rename and NEVER hardcodes
 * /var/lib. One file per session, keyed on the wt-<rid> name.
 */
export function sessionLogPath(session) {
  return join(CONFIG_DIR, 'session-logs', `${session}.log`);
}

/**
 * Pure: the tmux command that mirrors a session's pane output to a logfile. claude can die INSIDE the
 * wt-<rid> pty, where the launcher's own stderr never sees it — pipe-pane captures that pane stream for
 * prod visibility + a recurrence artifact. `-o` toggles the pipe on; the `cat >> file` arg is run by tmux
 * via /bin/sh so the redirect appends. Same 'tmux' bin + default socket as new-session/panePidCmd, so it
 * targets the SAME server the session was just created on (no stale-socket override).
 */
export function pipePaneCmd(session, logfile) {
  return { bin: 'tmux', args: ['pipe-pane', '-t', session, '-o', `cat >> ${shQuote(logfile)}`] };
}

/** Pure: kill-ALL plan — one `tmux kill-session -t <session>` command per fleet session. */
export function reapPlan(sessionNames) {
  return sessionNames.map((session) => ({ session, bin: 'tmux', args: ['kill-session', '-t', session] }));
}

/**
 * Pure: hard concurrency ceiling for `fleet up`. Refuse when the would-be total
 * (current live local fleet + requested) exceeds the cap.
 */
export function enforceCap(currentLive, requested, cap) {
  const total = currentLive + requested;
  if (total > cap) {
    return {
      allowed: false,
      reason: `fleet cap exceeded: ${currentLive} live + ${requested} requested = ${total} > ${cap} `
        + `(MAX_CONCURRENT_FLEET / AF_FLEET_MAX). Reap with \`fleet reap --yes\` or lower the request.`,
    };
  }
  return { allowed: true, reason: `within cap: ${currentLive} live + ${requested} requested = ${total} <= ${cap}` };
}

/** Pure: one append-only audit row. ts defaults to now but is injectable for deterministic tests. */
export function auditRecord({ action, spawnId, session, workdir = null, node = 'linux', ts = new Date().toISOString() }) {
  return { ts, action, spawn_id: spawnId, session, node, workdir };
}

/**
 * Pure: the launcher's subset of the /session-register body. Omits pid/owned_branch when unknown.
 * control_handle is `tmux:wt-<rid>` so the hub can reach the session back through tmux.
 */
export function launcherRegisterPayload({ spawnId, workDir, pid, ownedBranch }) {
  const payload = {
    spawn_id: spawnId,
    node: 'linux',
    control_handle: `tmux:wt-${spawnId}`,
    worktree_path: workDir,
  };
  if (pid != null) payload.pid = pid;
  if (ownedBranch != null) payload.owned_branch = ownedBranch;
  return payload;
}

/**
 * Pure: the launcher's /session-register body to RETIRE a reaped session — marks the registry row
 * `signed_off` keyed on spawn_id (the hub merges partial bodies on spawn_id). A killed agent can't
 * fleet_disconnect, so without this the row shows active until the ≤30s crash-sweep; firing it makes
 * kill-ALL one *registry* pass. NOTE: this retires the sqlite REGISTRY row, NOT the in-memory
 * presence/roster (a separate hub reaper) — the live-hub "online" ghost is a scoped fast-follow.
 */
export function reapRegisterPayload({ spawnId }) {
  return { spawn_id: spawnId, node: 'linux', status: 'signed_off' };
}

/** Pure: the Ghostty command that opens a window attached to an existing tmux session. */
export function ghosttyAttachCmd(session, display, xauthority, bin = 'ghostty') {
  return {
    bin,
    args: [`--title=${session}`, '-e', 'tmux', 'attach', '-t', session],
    env: { DISPLAY: display, XAUTHORITY: xauthority },
  };
}

/** Locate a usable Ghostty binary (snap-first), or null. */
function resolveGhostty() {
  for (const p of [process.env.AF_GHOSTTY_BIN, process.env.WT_GHOSTTY_BIN, '/snap/bin/ghostty', '/usr/bin/ghostty', '/usr/local/bin/ghostty']) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve the local graphical session (DISPLAY + XAUTHORITY) so a window can open on
 * the box's physical seat even though `fleet` runs in a headless pts. Returns null when
 * no graphical session is available (→ headless tmux fallback). AF_FLEET_NO_GUI (legacy WT_FLEET_NO_GUI) forces null.
 */
export function resolveDisplay(env = process.env) {
  if (env.AF_FLEET_NO_GUI || env.WT_FLEET_NO_GUI) return null;
  let display = env.AF_FLEET_DISPLAY || env.WT_FLEET_DISPLAY || env.DISPLAY;
  if (!display) {
    try {
      const sock = readdirSync('/tmp/.X11-unix').find((f) => /^X\d+$/.test(f));
      if (sock) display = ':' + sock.slice(1);
    } catch {}
  }
  if (!display) return null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const xauthority = [env.AF_FLEET_XAUTHORITY, env.WT_FLEET_XAUTHORITY, env.XAUTHORITY, `/run/user/${uid}/gdm/Xauthority`, `${homedir()}/.Xauthority`]
    .find((p) => p && existsSync(p));
  if (!xauthority) return null;
  return { display, xauthority };
}

/** Pure: decide the effective Linux terminal mode from the --term request + environment. */
export function resolveTermMode(term, disp, ghosttyBin) {
  if (term === 'tmux') return 'tmux';
  const canGhostty = !!disp && !!ghosttyBin;
  if (term === 'ghostty') return canGhostty ? 'ghostty' : 'tmux-fallback';
  return canGhostty ? 'ghostty' : 'tmux'; // auto
}

function launchGhostty(winCmd) {
  const child = spawn(winCmd.bin, winCmd.args, { env: { ...process.env, ...winCmd.env }, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

/**
 * Lane A: spawn `count` detached Claude Code sessions on Linux.
 * Always creates a detached tmux session (holds claude, persistent). In ghostty mode also
 * opens a Ghostty window attached to that session — closing the window leaves claude running.
 */
export async function spawnLinux(count, ctx) {
  const disp = ctx.term === 'tmux' ? null : resolveDisplay();
  const ghosttyBin = ctx.term === 'tmux' ? null : resolveGhostty();
  const mode = resolveTermMode(ctx.term || 'auto', disp, ghosttyBin);
  const spawned = [];
  for (let i = 0; i < count; i++) {
    const { session, rid: spawnId, bin, args } = linuxSpawnCmd(ctx.workDir, ctx.prompt, { referee: ctx.referee === true });
    const winCmd = mode === 'ghostty' ? ghosttyAttachCmd(session, disp.display, disp.xauthority, ghosttyBin) : null;
    const ppc = panePidCmd(session);
    const logfile = sessionLogPath(session);
    const pp = pipePaneCmd(session, logfile);
    if (ctx.dryRun) {
      const lines = [
        `${bin} ${fmtArgs(args)}`,
        `${ppc.bin} ${fmtArgs(ppc.args)}  # capture durable claude pid`,
        `${pp.bin} ${fmtArgs(pp.args)}  # mirror pane → ${logfile}`,
      ];
      if (winCmd) lines.push(`DISPLAY=${disp.display} XAUTHORITY=${disp.xauthority} ${winCmd.bin} ${fmtArgs(winCmd.args)}`);
      else if (ctx.term === 'ghostty') lines.push('(ghostty requested but no graphical session/binary → headless tmux only)');
      spawned.push({ handle: session, ok: true, dryRun: true, cmd: lines.join('\n              ') });
      continue;
    }
    try {
      await execFileP(bin, args, { timeout: 15000 }); // create detached tmux (holds claude)
      // Best-effort: mirror the pane to a session-log so a claude that dies INSIDE the wt-<rid> pty
      // leaves a recurrence artifact the launcher's own stderr never sees. mkdir the dir, then pipe.
      // A failure here must NEVER break the spawn (same best-effort pattern as the pane-pid read).
      try { mkdirSync(dirname(logfile), { recursive: true }); await execFileP(pp.bin, pp.args, { timeout: 5000 }); } catch {}
      // Best-effort: read the pane-leader pid (= the exec'd claude) so the registry row carries a
      // real pid for hub-side liveness. Failure → pid stays null and the hub degrades to has-session.
      let pid = null;
      try { pid = parsePanePid((await execFileP(ppc.bin, ppc.args, { timeout: 5000 })).stdout); } catch {}
      let windowed = false;
      if (winCmd) { try { launchGhostty(winCmd); windowed = true; } catch {} }
      spawned.push({ handle: session, ok: true, windowed, spawnId, pid });
      // Append-only audit + best-effort hub registration AFTER the session is up (never on dry-run).
      appendAudit(auditRecord({ action: 'spawn', spawnId, session, workdir: ctx.workDir }));
      fireRegister(launcherRegisterPayload({ spawnId, workDir: ctx.workDir, pid }), ctx.joinToken);
    } catch (e) {
      spawned.push({ handle: session, ok: false, err: e.message.split('\n')[0] });
    }
  }
  return { node: 'linux', requested: count, spawned, mode };
}

/** Poll the roster until the expected number of new names appear, or timeout. */
export async function waitForJoins(before, expectedTotal, timeoutMs = JOIN_TIMEOUT_MS) {
  const beforeSet = new Set(before);
  const start = Date.now();
  let after = before;
  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_INTERVAL_MS);
    after = await roster();
    const newCount = after.filter((n) => !beforeSet.has(n)).length;
    if (newCount >= expectedTotal) break;
  }
  return after;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ───────────────────────────── commands ─────────────────────────────

async function cmdStatus() {
  const names = await roster();
  const groups = { linux: [], windows: [], mac: [], other: [] };
  for (const n of names) groups[classifyName(n)].push(n);
  console.log(`Hub: ${HUB_URL}  (${names.length} online)`);
  for (const node of ['linux', 'windows', 'mac', 'other']) {
    if (groups[node].length) console.log(`  ${node.padEnd(8)} ${groups[node].join(', ')}`);
  }
}

async function cmdUp(opts) {
  const total = opts.linux + opts.windows;
  if (total === 0) { console.log('Nothing to launch (--linux 0 --windows 0).'); return; }
  const willSpawn = opts.yes && !opts.dryRun;
  const ctx = { workDir: opts.workDir || homedir(), dryRun: !willSpawn, term: opts.term, prompt: opts.prompt, referee: opts.referee === true };

  // Preflight
  const hub = await preflightHub();
  if (!hub.ok) { console.error(`✗ preflight: ${hub.err}`); process.exitCode = 1; return; }
  console.log(`✓ hub reachable (${HUB_URL})`);
  if (opts.windows > 0) {
    const win = await preflightWindows();
    if (!win.ok) {
      console.error(`✗ preflight Windows: ${win.err}`);
      console.error('  → skipping Windows node; re-run without --windows or fix the tunnel.');
      opts.windows = 0;
      if (opts.linux === 0) { process.exitCode = 1; return; }
    } else {
      console.log(`✓ Windows reachable (ssh ${WIN_SSH_ALIAS} + reverse tunnel up)`);
    }
  }

  // T3: regenerate the builder MCP config (fleet-mcp.json) from the freshly-resolved plugin dir before
  // any Linux spawn. Done in BOTH preview and real paths so a missing/moved plugin fails LOUD here (a
  // builder spawned against a dead MCP can't join). Windows lane (Approach C) doesn't use this file.
  if (opts.linux > 0) {
    try {
      const p = writeFleetMcpConfig();
      console.log(`✓ builder MCP config → ${p} (walkie-talkie only, strict)`);
    } catch (e) {
      console.error(`✗ ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!willSpawn) {
    console.log(`\n── PREVIEW (no --yes; nothing will be spawned) ──`);
    console.log(`Requested: linux=${opts.linux} windows=${opts.windows}  term=${opts.term}`);
    console.log(`Prompt: ${opts.prompt.length > 88 ? opts.prompt.slice(0, 85) + '…' : opts.prompt}`);
    if (opts.referee) console.log(`REFEREE birth: AF_ROLE/WT_ROLE=referee + admin token reaches THIS spawn only (all other spawns shed the admin token).`);
    const lin = await spawnLinux(opts.linux, { ...ctx, dryRun: true });
    if (opts.linux > 0) console.log(`  Linux mode → ${lin.mode}${lin.mode === 'tmux-fallback' ? ' (ghostty unavailable; headless)' : ''}`);
    for (const s of lin.spawned) console.log(`  [linux]   ${s.cmd}`);
    if (opts.windows > 0) {
      const win = await spawnWindows(opts.windows, { ...ctx, dryRun: true });
      for (const s of win.spawned) console.log(`  [windows] ${s.err || s.cmd}`);
    }
    console.log(`\nRe-run with --yes to actually spawn (joins the LIVE hub).`);
    return;
  }

  // HARD CAP: refuse if this `up` would push the live local fleet over the ceiling. "current live" =
  // count of live local wt-* tmux sessions (a local proxy for fleet size). Cap = AF_FLEET_MAX || 5.
  const cap = Number(process.env.AF_FLEET_MAX || process.env.WT_FLEET_MAX || MAX_CONCURRENT_FLEET);
  const currentLive = (await listFleetSessions()).length;
  const decision = enforceCap(currentLive, opts.linux + opts.windows, cap);
  if (!decision.allowed) { console.error(`✗ ${decision.reason}`); process.exitCode = 1; return; }

  // Real spawn (Operator-gated). Load the join token from the sourced env file for best-effort /session-register.
  const env = await loadEnv();
  ctx.joinToken = env.AGENT_FLEET_JOIN_TOKEN || env.WALKIE_TALKIE_JOIN_TOKEN || null;
  const before = await roster();
  console.log(`\nRoster before: ${before.length} online`);
  const results = [];
  if (opts.linux > 0) results.push(await spawnLinux(opts.linux, ctx));
  if (opts.windows > 0) results.push(await spawnWindows(opts.windows, ctx));
  for (const r of results) {
    const okN = r.spawned.filter((s) => s.ok).length;
    const modeNote = r.mode ? ` [${r.mode}]` : '';
    const windowed = r.spawned.filter((s) => s.windowed).length;
    const winNote = r.mode === 'ghostty' ? ` (${windowed} window${windowed === 1 ? '' : 's'} opened on :1)` : '';
    // Log the success handles (tmux session name / pid:<n>) so spawns are reapable + correlatable (b37c/wcf gap).
    const okHandles = r.spawned.filter((s) => s.ok).map((s) => s.pid ? `${s.handle} (pid:${s.pid})` : s.handle).join(', ');
    console.log(`  spawned ${node(r)} ${okN}/${r.requested}${modeNote}${winNote}${okHandles ? ` → ${okHandles}` : ''}`
      + r.spawned.filter((s) => !s.ok).map((s) => `\n    ✗ ${s.handle}: ${s.err}`).join(''));
  }

  // Recompute the expected count AFTER any preflight-skip (e.g. Windows tunnel down → opts.windows=0),
  // so we don't wait on joins that were never spawned and burn the full JOIN_TIMEOUT (caught by linux-b37c).
  const want = opts.linux + opts.windows;
  console.log(`\nWaiting for self-join (up to ${JOIN_TIMEOUT_MS / 1000}s)…`);
  const after = await waitForJoins(before, want);
  // The referee lane self-renames to REFEREE, so reconcile must count that callsign as the
  // single linux self-join — otherwise a SUCCESSFUL launch reads as a shortfall and exits 1.
  const rec = reconcile(before, after, { linux: opts.linux, windows: opts.windows, referee: opts.referee === true });
  console.log(`\n── REPORT ──`);
  console.log(`Requested: linux=${rec.requested.linux} windows=${rec.requested.windows}`);
  console.log(`Joined:    linux=${rec.joinedByNode.linux} windows=${rec.joinedByNode.windows}`);
  console.log(`New callsigns: ${rec.newNames.join(', ') || '(none)'}`);
  if (!rec.ok) {
    console.error(`✗ shortfall: linux=${rec.shortfall.linux} windows=${rec.shortfall.windows} — these did NOT join (token/tunnel/spawn failure). NOT a healthy fleet.`);
    process.exitCode = 1;
  } else if (opts.referee) {
    console.log(`✓ REFEREE realized (took the reserved seat).`);
  } else {
    console.log(`✓ fleet realized as requested.`);
  }
}

function node(r) { return r.node.padEnd(8); }

async function cmdDown(opts) {
  // v1: local tmux reap only. Full cross-node teardown/reaping = 2nd-builder lane.
  const sessions = await listFleetSessions();
  if (!sessions.length) { console.log('No local wt-* tmux sessions.'); return; }
  console.log(`Local fleet tmux sessions:\n  ${sessions.join('\n  ')}`);
  if (!opts.yes) { console.log('\nRe-run `fleet down --yes` to kill them (Linux only; Windows reap deferred to D5 teardown lane).'); return; }
  for (const s of sessions) {
    await execFileP('tmux', ['kill-session', '-t', s]).then(() => console.log(`  killed ${s}`)).catch((e) => console.error(`  ✗ ${s}: ${e.message}`));
  }
  console.log('Note: killed local sessions do not fleet_disconnect cleanly; stale callsigns may need POST /kick (admin token). Full reap = D5 teardown lane.');
}

/**
 * `fleet reap`         — preview: list live local fleet tmux sessions (wt-*).
 * `fleet reap --yes`   — the envelope's single-call kill-ALL: `tmux kill-session -t <s>` for EVERY wt-* session.
 * Each successful kill appends ONE append-only audit line.
 */
async function cmdReap(opts) {
  const sessions = await listFleetSessions();
  if (!sessions.length) { console.log('No local wt-* tmux sessions to reap.'); return; }
  console.log(`Local fleet tmux sessions (${sessions.length}):\n  ${sessions.join('\n  ')}`);
  if (!opts.yes) { console.log('\nRe-run `fleet reap --yes` to kill ALL of them (one tmux kill-session each).'); return; }
  const env = await loadEnv();
  const token = env.AGENT_FLEET_JOIN_TOKEN || env.WALKIE_TALKIE_JOIN_TOKEN || null;
  const plan = reapPlan(sessions);
  let killed = 0;
  const signoffs = [];
  for (const p of plan) {
    try {
      await execFileP(p.bin, p.args);
      const spawnId = p.session.replace(/^wt-/, '');
      appendAudit(auditRecord({ action: 'reap', spawnId, session: p.session, workdir: null }));
      // Retire the registry row immediately so kill-ALL is one registry pass, not a ≤30s-delayed
      // crash-sweep. Collected and awaited below so the fire-and-forget POST lands before the CLI exits.
      signoffs.push(fireRegister(reapRegisterPayload({ spawnId }), token));
      console.log(`  killed ${p.session}`);
      killed++;
    } catch (e) {
      console.error(`  ✗ ${p.session}: ${e.message.split('\n')[0]}`);
    }
  }
  await Promise.allSettled(signoffs); // let the best-effort signed_off POSTs finish (2s cap) before exit
  console.log(`Reaped ${killed}/${plan.length} session(s); registry rows marked signed_off. (In-memory roster presence is a separate reaper — a live-hub callsign may still show online until its sweep / POST /kick.)`);
}

function usage() {
  console.log(`fleet — D5 cross-platform fleet launcher (Linux + Windows)

  fleet up --linux N --windows M [--work-dir DIR] [--term ghostty|tmux|auto] [--prompt TEXT] [--referee] [--yes]
      Preview (default) or spawn (--yes) N+M detached Claude Code sessions that join the hub.
      --term ghostty  tmux session + a Ghostty window attached (visible + persistent; window on :1)
      --term tmux     headless detached tmux only (best for driving remotely over SSH)
      --term auto     ghostty if a graphical session is detected, else tmux (default)
      --prompt TEXT   initial prompt each teammate is launched with (REQUIRED for it to take a
                      first turn and join — a bare claude sits idle). Default: join, set mission, then stop (rewake-driven, no standby loop).
      --referee       Birth ONE operator-identity REFEREE: AF_ROLE=referee (the SessionStart hook
                      promotes it to the reserved REFEREE callsign) + the admin token reaches THIS
                      spawn only. Requires exactly --linux 1 (no --windows). Every non-referee spawn
                      has the admin token unset (least-privilege).
  fleet status            Show the current hub roster grouped by node.
  fleet down [--yes]      List (or with --yes, kill) local fleet tmux sessions. Full reap = future lane.
  fleet reap [--yes]      Preview (or with --yes, single-call kill-ALL) every local wt-* tmux session.

  Concurrency: \`fleet up\` refuses when (live local wt-* sessions + requested) > ${MAX_CONCURRENT_FLEET}
       (override via AF_FLEET_MAX). Spawns + reaps append to ~/.config/agent-fleet/fleet-audit.jsonl.

  Env: AGENT_FLEET_HUB_URL (default ${HUB_URL}), AF_WIN_SSH_ALIAS (default ${WIN_SSH_ALIAS}),
       AF_FLEET_NO_GUI (force headless), AF_GHOSTTY_BIN / AF_FLEET_DISPLAY / AF_FLEET_XAUTHORITY,
       AF_FLEET_MAX (concurrency cap override).
       (old WALKIE_TALKIE_*/WT_* names still read for back-compat.)
  Plan: ~/.claude/docs/meta-harness-overhaul/d5-build-plan.md`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    usage();
    process.exitCode = 2;
    return;
  }
  switch (opts.cmd) {
    case 'up': return cmdUp(opts);
    case 'status': return cmdStatus();
    case 'down': return cmdDown(opts);
    case 'reap': return cmdReap(opts);
    case 'help': case '--help': case '-h': default: return usage();
  }
}

// Run only when invoked directly (not when imported by tests) — including via a symlink on
// PATH (e.g. ~/.local/bin/fleet). import.meta.url already resolves symlinks but process.argv[1]
// does not, so realpath both sides; a bare string compare silently skips main() via the symlink.
let invokedPath = '';
try { invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : ''; } catch { /* argv[1] gone */ }
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
