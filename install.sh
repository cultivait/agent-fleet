#!/usr/bin/env bash
# ============================================================================
# Agent Fleet — one-command bootstrap (solo / single-machine, localhost).
#
#   git clone <repo> agent-fleet && cd agent-fleet && ./install.sh
#
# Idempotent (safe to re-run). Sets up a fresh machine end-to-end: tokens, the
# self-contained MCP config, the Claude Code hooks, builds + starts the hub, and
# verifies it. Multi-node (Tailscale / Cloudflare / tmux) is opt-in — see
# QUICKSTART.md. No secrets are hardcoded; tokens are generated locally.
#
# Flags:
#   --no-start              set everything up but do not launch the hub
#   --port N                hub port (default: PORT env / .env / 9559)
#   --hub-url URL           join an EXISTING remote hub instead of running one
#   --join-token TOKEN      that remote hub's join token (required with --hub-url)
#
# Client-only mode (join an existing hub on another machine, any OS):
#   ./install.sh --hub-url https://hub.example.com --join-token <REMOTE_TOKEN>
# In this mode the installer does NOT generate tokens, does NOT create an admin
# token, and does NOT start a local hub — it only points this machine's MCP +
# hooks at the remote hub and verifies it is reachable.
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# ---- pretty output --------------------------------------------------------
if [ -t 1 ]; then
  C_G=$'\033[1;32m'; C_Y=$'\033[1;33m'; C_R=$'\033[1;31m'; C_B=$'\033[1;34m'; C_0=$'\033[0m'
else
  C_G=""; C_Y=""; C_R=""; C_B=""; C_0=""
fi
log()  { printf '%s[fleet]%s %s\n' "$C_G" "$C_0" "$*"; }
info() { printf '%s[fleet]%s %s\n' "$C_B" "$C_0" "$*"; }
warn() { printf '%s[fleet]%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die()  { printf '%s[fleet] error:%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

# ---- flags ----------------------------------------------------------------
START_HUB=1
PORT_OVERRIDE=""
JOIN_HUB_URL=""
JOIN_TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-start) START_HUB=0 ;;
    --port) shift; PORT_OVERRIDE="${1:-}" ;;
    --hub-url) shift; JOIN_HUB_URL="${1:-}" ;;
    --join-token) shift; JOIN_TOKEN="${1:-}" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown flag: $1 (try --help)" ;;
  esac
  shift
done

# Client-only mode requires BOTH --hub-url and --join-token (guard half-specs).
if [ -n "$JOIN_HUB_URL" ] || [ -n "$JOIN_TOKEN" ]; then
  [ -n "$JOIN_HUB_URL" ] || die "--join-token requires --hub-url (join an existing hub with both)."
  [ -n "$JOIN_TOKEN" ]   || die "--hub-url requires --join-token (the remote hub's join token)."
  CLIENT_ONLY=1
else
  CLIENT_ONLY=0
fi

# ---- 1. Node preflight ----------------------------------------------------
# The hub's better-sqlite3 is compiled for Node 22's ABI; any other major crashes
# it. Reuse the repo's own preflight so the message + pin stay single-sourced.
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 22 (see .nvmrc), then re-run."
if [ -f scripts/check-node.mjs ]; then
  node scripts/check-node.mjs || die "Wrong Node version. Run: nvm install && nvm use (Node 22 per .nvmrc), then re-run ./install.sh"
else
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 22 ] || die "Node >= 22 required (found $(node -v)); better-sqlite3 needs Node 22's ABI."
fi
log "Node $(node -v) OK"

# ---- CLIENT-ONLY MODE: join an existing remote hub ------------------------
# When --hub-url + --join-token are given, this machine is a Tier-2 CLIENT: it
# does NOT generate tokens, does NOT create an admin token, and does NOT start a
# local hub. It points the MCP config + Claude Code hooks at the remote hub
# (reusing the same HUB_URL-driven code paths the solo path uses) and verifies
# the remote /board returns 200 BEFORE writing any config / declaring success.
if [ "$CLIENT_ONLY" -eq 1 ]; then
  HUB_URL="${JOIN_HUB_URL%/}"   # strip a trailing slash so "$HUB_URL/board" never becomes "//board" (stricter proxies/CF 404)
  log "Client-only mode: joining existing hub at $HUB_URL (no local hub will start)."

  # Probe the remote hub FIRST — fail fast with no half-written config.
  probe_remote_board() {
    code="$(curl -s -o /dev/null -w '%{http_code}' "$HUB_URL/board" 2>/dev/null || true)"
    [ "$code" = "200" ]
  }
  if ! probe_remote_board; then
    die "Could not reach the hub at $HUB_URL/board (expected HTTP 200). Check the URL is correct and reachable from this machine, then re-run."
  fi
  log "Remote hub reachable: $HUB_URL/board returns 200."

  # The MCP bundle ships COMMITTED + self-contained (esbuild, ZERO native deps —
  # no better-sqlite3). A Tier-2 client never runs a hub, so DON'T npm install /
  # build / bundle: that would needlessly force the hub's better-sqlite3 native
  # compile on a machine that will never use it (the cross-OS fragility this
  # project fought on Windows). Just verify the committed bundle is present.
  MCP_BUNDLE="$REPO_ROOT/plugin/dist/mcp-server.mjs"
  [ -f "$MCP_BUNDLE" ] || die "MCP bundle missing at $MCP_BUNDLE — is this a complete clone?"

  # Write .env (remote hub URL + remote join token only — NO tokens generated,
  # NO admin token, NO local hub). 0600 perms.
  ENV_FILE="$REPO_ROOT/.env"
  if [ -f "$ENV_FILE" ]; then
    warn ".env already exists — keeping it. Delete it and re-run to repoint at $HUB_URL."
  else
    log "Writing .env (client-only: remote hub URL + remote join token)…"
    umask 077
    cat > "$ENV_FILE" <<ENV
# Generated by install.sh (client-only / join existing hub). NEVER commit this file.
# This machine joins a REMOTE hub; the token below is the REMOTE hub's join token.
AGENT_FLEET_HUB_URL=$HUB_URL
AGENT_FLEET_JOIN_TOKEN=$JOIN_TOKEN
ENV
    chmod 600 "$ENV_FILE"
  fi

  # Vendored MCP config → remote URL + remote token (same writer as solo path).
  log "Writing vendored MCP config → .mcp.json (→ $HUB_URL)"
  MCP_BUNDLE="$MCP_BUNDLE" AGENT_FLEET_JOIN_TOKEN="$JOIN_TOKEN" AGENT_FLEET_HUB_URL="$HUB_URL" \
  REPO_ROOT="$REPO_ROOT" node <<'NODE'
const fs = require("fs"), path = require("path");
const p = process.env;
const out = path.join(p.REPO_ROOT, ".mcp.json");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(out, "utf8")); } catch { cfg = {}; }
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers["agent-fleet"] = {
  command: "node",
  args: [p.MCP_BUNDLE],
  env: { AGENT_FLEET_JOIN_TOKEN: p.AGENT_FLEET_JOIN_TOKEN, AGENT_FLEET_HUB_URL: p.AGENT_FLEET_HUB_URL },
};
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
NODE

  # Claude Code hooks: copy + wire settings.json to the REMOTE hub.
  CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  HOOKS_DIR="$CLAUDE_HOME/hooks"
  SETTINGS="$CLAUDE_HOME/settings.json"
  mkdir -p "$HOOKS_DIR/state"
  FLEET_HOOKS=(
    agent-fleet-sessionstart.sh
    agent-fleet-msgcheck.sh
    agent-fleet-rewake.sh
    agent-fleet-tabtitle.sh
    fleet-taskboard.js
    fleet-plan-heartbeat.js
    wt-lease-guard.js
    wt-context-gauge.cjs
  )
  log "Installing ${#FLEET_HOOKS[@]} hooks → $HOOKS_DIR"
  for h in "${FLEET_HOOKS[@]}"; do
    src="$REPO_ROOT/deploy/hooks/$h"
    [ -f "$src" ] || die "hook source missing: $src"
    cp "$src" "$HOOKS_DIR/$h"
    chmod +x "$HOOKS_DIR/$h"
  done
  # Ship the multi-instance protocol doc to ~/.claude/docs so the hook + SKILL
  # refs to ~/.claude/docs/dual-instance-protocol.md resolve on a fresh clone.
  PROTO_DOC="$REPO_ROOT/docs/dual-instance-protocol.md"
  [ -f "$PROTO_DOC" ] && { mkdir -p "$CLAUDE_HOME/docs"; cp "$PROTO_DOC" "$CLAUDE_HOME/docs/dual-instance-protocol.md"; }
  log "Wiring hooks into $SETTINGS (merge, non-destructive)…"
  FLEET_SETTINGS="$SETTINGS" FLEET_HOOKS_DIR="$HOOKS_DIR" \
  FLEET_JOIN_TOKEN="$JOIN_TOKEN" FLEET_HUB_URL="$HUB_URL" FLEET_PLATFORM=posix \
  node "$REPO_ROOT/scripts/install/wire-fleet-hooks.mjs"

  printf '\n'
  log "Joined existing hub at $HUB_URL. Open $HUB_URL in your browser; restart Claude Code, then fleet_join with a callsign."
  exit 0
fi

# ---- 2. .env (tokens + solo defaults), idempotent -------------------------
ENV_FILE="$REPO_ROOT/.env"
gen_token() { node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))'; }
env_port="${PORT_OVERRIDE:-${PORT:-9559}}"
if [ -f "$ENV_FILE" ]; then
  log ".env already exists — keeping it (re-run safe; delete it to regenerate tokens)."
else
  log "Generating .env (fresh tokens + solo localhost defaults)…"
  mkdir -p "$REPO_ROOT/data"
  join_token="$(gen_token)"
  admin_token="$(gen_token)"
  umask 077
  cat > "$ENV_FILE" <<ENV
# Generated by install.sh — solo / localhost. NEVER commit this file.
# Multi-node opts in here (set AGENT_FLEET_HUB_URL / CF_ACCESS_* — see .env.example).
AGENT_FLEET_JOIN_TOKEN=$join_token
AGENT_FLEET_ADMIN_TOKEN=$admin_token
PORT=$env_port
AGENT_FLEET_HUB_URL=http://localhost:$env_port
AGENT_FLEET_DB_PATH=$REPO_ROOT/data/agent-fleet.db
AF_OPERATOR_NAME=Operator
ENV
  chmod 600 "$ENV_FILE"
fi

# Load .env into this shell (export every assignment).
set -a; # shellcheck disable=SC1090
. "$ENV_FILE"; set +a
[ -n "${PORT_OVERRIDE}" ] && PORT="$PORT_OVERRIDE"
PORT="${PORT:-9559}"
HUB_URL="${AGENT_FLEET_HUB_URL:-http://localhost:$PORT}"
[ -n "${AGENT_FLEET_JOIN_TOKEN:-}" ] || die ".env is missing AGENT_FLEET_JOIN_TOKEN"
[ -n "${AGENT_FLEET_ADMIN_TOKEN:-}" ] || die ".env is missing AGENT_FLEET_ADMIN_TOKEN"

# ---- 3. Dependencies ------------------------------------------------------
log "Installing dependencies (npm install)…"
npm install --no-audit --no-fund

# ---- 3b. Guarantee the better-sqlite3 native binary loads ------------------
# The hub require()s better-sqlite3's compiled .node at runtime. This guard is a
# no-op on Linux/macOS (the binary loads after a normal install — matrix-proven
# on npm 10 and 11), but it makes failure LOUD instead of a cryptic hub crash:
# verify the load from the hub's own resolution context; if it fails, rebuild
# explicitly and re-verify; if it still fails, die with guidance. (npm 11.16+'s
# allow-scripts warning is advisory — scripts still run — so it is not the cause;
# we gate on whether the binary actually LOADS.)
loads_native() { ( cd "$REPO_ROOT/hub" && node -e 'require("better-sqlite3")' ) >/dev/null 2>&1; }
if loads_native; then
  log "Native deps OK (better-sqlite3 loads)."
else
  warn "better-sqlite3 did not load after npm install — rebuilding native deps (better-sqlite3, node-pty)…"
  npm rebuild better-sqlite3 node-pty --foreground-scripts || true
  if loads_native; then
    log "Native deps rebuilt (better-sqlite3 loads)."
  else
    die "better-sqlite3's native binary is missing/unloadable after npm install + npm rebuild. Inspect the rebuild output above (prebuild-install / node-gyp), then re-run ./install.sh"
  fi
fi

# ---- 4. Build hub + MCP bundle -------------------------------------------
log "Building hub + MCP bundle…"
npm run build
npm run bundle

# ---- 5. Vendored, self-contained MCP config (no marketplace round-trip) ----
# Claude Code loads project-level .mcp.json. Point it straight at the committed
# bundle so `git clone` has everything. The marketplace plugin remains an
# optional alternative (see QUICKSTART.md).
MCP_BUNDLE="$REPO_ROOT/plugin/dist/mcp-server.mjs"
[ -f "$MCP_BUNDLE" ] || die "MCP bundle missing at $MCP_BUNDLE (npm run bundle should have built it)."
log "Writing vendored MCP config → .mcp.json"
MCP_BUNDLE="$MCP_BUNDLE" AGENT_FLEET_JOIN_TOKEN="$AGENT_FLEET_JOIN_TOKEN" AGENT_FLEET_HUB_URL="$HUB_URL" \
REPO_ROOT="$REPO_ROOT" node <<'NODE'
const fs = require("fs"), path = require("path");
const p = process.env;
const out = path.join(p.REPO_ROOT, ".mcp.json");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(out, "utf8")); } catch { cfg = {}; }
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers["agent-fleet"] = {
  command: "node",
  args: [p.MCP_BUNDLE],
  env: { AGENT_FLEET_JOIN_TOKEN: p.AGENT_FLEET_JOIN_TOKEN, AGENT_FLEET_HUB_URL: p.AGENT_FLEET_HUB_URL },
};
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
NODE

# ---- 6. Claude Code hooks: copy + wire settings.json ----------------------
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HOOKS_DIR="$CLAUDE_HOME/hooks"
SETTINGS="$CLAUDE_HOME/settings.json"
mkdir -p "$HOOKS_DIR/state"

FLEET_HOOKS=(
  agent-fleet-sessionstart.sh
  agent-fleet-msgcheck.sh
  agent-fleet-rewake.sh
  agent-fleet-tabtitle.sh
  fleet-taskboard.js
  fleet-plan-heartbeat.js
  wt-lease-guard.js
  wt-context-gauge.cjs
)
log "Installing ${#FLEET_HOOKS[@]} hooks → $HOOKS_DIR"
for h in "${FLEET_HOOKS[@]}"; do
  src="$REPO_ROOT/deploy/hooks/$h"
  [ -f "$src" ] || die "hook source missing: $src"
  cp "$src" "$HOOKS_DIR/$h"
  chmod +x "$HOOKS_DIR/$h"
done

# Ship the multi-instance protocol doc to ~/.claude/docs so the hook + SKILL
# refs to ~/.claude/docs/dual-instance-protocol.md resolve on a fresh clone.
PROTO_DOC="$REPO_ROOT/docs/dual-instance-protocol.md"
[ -f "$PROTO_DOC" ] && { mkdir -p "$CLAUDE_HOME/docs"; cp "$PROTO_DOC" "$CLAUDE_HOME/docs/dual-instance-protocol.md"; }

# Merge the canonical fleet wiring into settings.json (preserve existing
# non-fleet hooks; idempotent — fleet entries are replaced, not duplicated).
log "Wiring hooks into $SETTINGS (merge, non-destructive)…"
FLEET_SETTINGS="$SETTINGS" FLEET_HOOKS_DIR="$HOOKS_DIR" \
FLEET_JOIN_TOKEN="$AGENT_FLEET_JOIN_TOKEN" FLEET_HUB_URL="$HUB_URL" FLEET_PLATFORM=posix \
node "$REPO_ROOT/scripts/install/wire-fleet-hooks.mjs"

# ---- 7. Start the hub + verify -------------------------------------------
verify_board() {
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/board" 2>/dev/null || true)"
    [ "$code" = "200" ] && return 0
    sleep 0.5
  done
  return 1
}

if [ "$START_HUB" -eq 1 ]; then
  if curl -s -o /dev/null "http://localhost:$PORT/board" 2>/dev/null; then
    warn "Something is already serving port $PORT — not starting a second hub. (Use --port N or stop it.)"
  else
    mkdir -p "$REPO_ROOT/logs"
    log "Starting the hub on port $PORT (background)…"
    PORT="$PORT" nohup npm start --silent >"$REPO_ROOT/logs/hub.log" 2>&1 &
    echo $! > "$REPO_ROOT/.hub.pid"
    if verify_board; then
      log "Hub is up: $HUB_URL/board returns 200."
    else
      die "Hub did not come up — see $REPO_ROOT/logs/hub.log"
    fi
  fi
else
  info "--no-start: skipped launching the hub. Start it later with: npm start"
fi

# ---- 8. Summary -----------------------------------------------------------
printf '\n'
log "Agent Fleet is set up."
cat <<SUMMARY
  Hub URL ........ $HUB_URL    (open this in your browser; auto-open is macOS-only)
  Dashboard ...... $HUB_URL/
  Tokens ......... $ENV_FILE   (join + admin; keep private, never commit)
  MCP config ..... $REPO_ROOT/.mcp.json   (loaded by Claude Code from this clone)
  Hooks .......... $HOOKS_DIR

  Next:
    1) Open $HUB_URL in your browser.
    2) Restart Claude Code so it loads the MCP server + hooks.
    3) In a session: fleet_join with a callsign, then fleet_send a message.

  Multi-node / public dashboard / cockpit terminal are opt-in — see QUICKSTART.md.
SUMMARY
