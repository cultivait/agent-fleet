#!/bin/bash
# PostToolUse hook: throttled check for fleet messages queued to this
# session's callsign; injects a context nudge so a working instance sees
# traffic at its next tool call instead of its next task boundary.
# Hub check at most every 60s; re-nudges at most every 5 min.

input=$(cat)
hub="${AGENT_FLEET_HUB_URL:-$WALKIE_TALKIE_HUB_URL}"
[ -z "$hub" ] && hub="http://localhost:9559"
token="${AGENT_FLEET_JOIN_TOKEN:-$WALKIE_TALKIE_JOIN_TOKEN}"
[ -z "$token" ] && exit 0

sid=$(echo "$input" | jq -r '.session_id // "nosession"' 2>/dev/null)
state="/tmp/wt-msgcheck-${sid}"
now=$(date +%s)
check_interval="${AF_CHECK_INTERVAL:-${WT_CHECK_INTERVAL:-60}}"
if [ -f "$state" ]; then
  last=$(stat -c %Y "$state" 2>/dev/null || echo 0)
  [ $((now - last)) -lt "$check_interval" ] && exit 0
fi
touch "$state"

# Gate — only sessions that actually joined a fleet identity (the callsign file is
# written on fleet_join / become_referee / claim_referee, removed on fleet_out). Its
# existence survives identity renames; its contents may go stale.
[ -s "/tmp/wt-callsign-${sid}" ] || exit 0

# Resolve the CURRENT callsign: the hub registry is authoritative via GET /whoami
# (stamped on every identity op); the static file is only the hub-unreachable
# fallback. Fixes msgcheck nudging the OLD callsign after a rename.
callsign=$(curl -s --max-time 2 "$hub/whoami?sid=${sid}" 2>/dev/null | jq -r '.name // empty' 2>/dev/null)
[ -z "$callsign" ] && callsign=$(cat "/tmp/wt-callsign-${sid}" 2>/dev/null)
[ -z "$callsign" ] && exit 0

n=$(curl -s --max-time 2 "$hub/pending-counts" -H "Authorization: Bearer $token" \
    | jq -r --arg n "$callsign" '.counts[$n] // 0' 2>/dev/null) || exit 0
[ "$n" -gt 0 ] 2>/dev/null || exit 0

nudge="/tmp/wt-nudged-${sid}"
nudge_cooldown="${AF_NUDGE_COOLDOWN:-${WT_NUDGE_COOLDOWN:-600}}"
if [ -f "$nudge" ]; then
  lastn=$(stat -c %Y "$nudge" 2>/dev/null || echo 0)
  [ $((now - lastn)) -lt "$nudge_cooldown" ] && exit 0
fi
touch "$nudge"

# Operator's ask (T4): every wake nudge reminds the agent to stay TERSE, and — if it is REFEREE —
# to DELEGATE rather than build/edit itself. $callsign is already resolved above, so the
# referee-only clause is gated on it (plain builders don't need it).
role_hint=""
[ "$callsign" = "REFEREE" ] && role_hint=" You are REFEREE: DELEGATE this to a builder — do not build or edit files yourself."

jq -n --arg ctx "Fleet: $n message(s) waiting for '$callsign' on the agent-fleet hub. At your next natural pause, call fleet_check (instant, non-blocking) to receive and handle them per the dual-instance protocol, then continue your current task. Keep replies terse. Do not enter a fleet_standby loop.$role_hint" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
