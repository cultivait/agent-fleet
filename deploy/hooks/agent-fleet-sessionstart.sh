#!/bin/bash
# SessionStart hook: if the agent-fleet hub is up, tell the new instance
# its callsign and who's already on air. Silent (exit 0, no output) when the
# hub is down so non-parallel sessions pay zero context cost.

input=$(cat)
hub="${AGENT_FLEET_HUB_URL:-$WALKIE_TALKIE_HUB_URL}"
[ -z "$hub" ] && hub="http://localhost:9559"

resp=$(curl -s --max-time 2 "$hub/users") || exit 0
[ -z "$resp" ] && exit 0

online=$(echo "$resp" | jq -r '[.users[] | select(.online and .role == "agent") | .name] | join(", ")' 2>/dev/null) || exit 0

cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd="$PWD"
# Unique suffix for sessions: a bare basename collides when several sessions
# share a cwd (e.g. multiple home-dir sessions would all join under the same
# name, and the hub treats same-name joins as one user). The suffix keeps each
# session distinct while the basename keeps the callsign human-readable.
sid=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
suffix="${sid:0:4}"
[ -z "$suffix" ] && suffix="$$"
# Sticky callsign: reuse the name this session already joined under (recorded
# by agent-fleet-tabtitle.sh on fleet_join) instead of recomputing from cwd.
# SessionStart re-fires on resume/compact; without this, a session that cd's
# into a different tree gets renamed mid-life on its next compaction, orphaning
# its old registration and colliding sessions onto one name. Honors a manual
# override too. Cleared on fleet_disconnect, so a genuinely fresh start re-derives
# from cwd.
pinned=""
[ -n "$sid" ] && pinned=$(cat "/tmp/wt-callsign-${sid}" 2>/dev/null)
# Launcher-assigned callsign: the fleet launcher (fleet.mjs) exports AF_CALLSIGN at
# spawn so the radio callsign, tmux session id, and Claude --remote-control name all
# align (the launcher cannot know the session-id-derived suffix in advance). Takes
# precedence over cwd derivation; backward-compatible (human sessions set no AF_CALLSIGN).
# The AF_ROLE=referee override below still wins (operator identity is authoritative).
# Env reads are back-compat: new AF_* first, fall back to legacy WT_*.
callsign_env="${AF_CALLSIGN:-$WT_CALLSIGN}"
if [ -n "$callsign_env" ]; then
  callsign="$callsign_env"
elif [ -n "$pinned" ]; then
  callsign="$pinned"
else
  # Generic derivation: use the working-directory basename plus a per-session
  # suffix so concurrent sessions in the same tree stay distinct. Set AF_CALLSIGN
  # (or pin via the tabtitle hook) to override.
  base=$(basename "$cwd")
  [ -z "$base" ] || [ "$base" = "/" ] && base="session"
  callsign="${base}-${suffix}"
fi

# REFEREE lane: a referee session always presents as "REFEREE" on the board.
# Overrides any cwd-derived or pinned callsign so the session-register payload
# below carries callsign=REFEREE from the first beat (auto-rename support).
role_env="${AF_ROLE:-$WT_ROLE}"
if [ "$role_env" = "referee" ]; then
  callsign="REFEREE"
fi

# WS1: self-register this session into the hub's identity registry. Fire-and-forget,
# silent on any failure — must never block or slow session start (same discipline as
# the /users probe above). The hub MERGES this HOOK subset with the launcher's subset
# on spawn_id (AF_SPAWN_ID, injected at spawn); a human-launched session sends no
# spawn_id and keys on session_id. The CONFIRMED callsign is stamped later by the
# board-update on fleet_join, so the callsign sent here is only the initial value.
token="${AGENT_FLEET_JOIN_TOKEN:-$WALKIE_TALKIE_JOIN_TOKEN}"
if [ -n "$token" ] && [ -n "$sid" ]; then
  node="${AF_NODE_NAME:-${WT_NODE_NAME:-linux}}"
  spawn_id="${AF_SPAWN_ID:-$WT_SPAWN_ID}"
  started_at=$(date +%s%3N 2>/dev/null) || started_at=$(( $(date +%s) * 1000 ))
  reg_payload=$(jq -n \
    --arg session_id "$sid" \
    --arg spawn_id "$spawn_id" \
    --arg callsign "$callsign" \
    --arg node "$node" \
    --arg workdir "$cwd" \
    --argjson started_at "$started_at" \
    '{session_id: $session_id, callsign: $callsign, node: $node, workdir: $workdir, started_at: $started_at}
       + (if $spawn_id == "" then {} else {spawn_id: $spawn_id} end)' 2>/dev/null)
  if [ -n "$reg_payload" ]; then
    curl -s --max-time 2 -X POST "$hub/session-register" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" \
      -d "$reg_payload" >/dev/null 2>&1 || true
  fi
fi

if [ -n "$online" ]; then
  partners="Currently on air: $online."
else
  partners="Nobody else is on air yet — join anyway so partners starting later can find you."
fi

# REFEREE lane gets the admin-gated promote instruction instead of fleet_join
# (the join path refuses reserved names); the rest of the protocol is shared.
if [ "$role_env" = "referee" ]; then
  join_instruction="Become the referee now: call fleet_become_referee (it promotes this session to the operator-identity callsign 'REFEREE' via the admin token; the normal fleet_join cannot register reserved names). After that, all your fleet messages send as REFEREE and carry [principal] so instances can treat your direction as operator-authenticated."
else
  join_instruction="Join the fleet now: call fleet_join with the name '$callsign'."
fi

context="Agent Fleet hub is running (localhost:9559). $partners A parallel Claude Code instance may be (or become) active on this machine. $join_instruction Immediately after joining, call fleet_mission with a deliberate one-line summary of what you are working on (max 140 chars, no secrets, no verbatim prompt text) and update it whenever your task changes; your activity and todos reach the shared task board automatically via hooks. COMMS DISCIPLINE (every token is re-billed each turn — protect everyone's context): keep BOTH fleet messages and in-session replies terse and factual — lead with the answer, no preamble, no restating the question, no status theater; a few lines beats a few paragraphs. DO NOT SIT IN A STANDBY LOOP: fleet_standby is a ONE-SHOT drain, never a resting state. After you set your mission (and whenever you finish handling traffic), just STOP — end your turn. A Stop-hook re-wakes you when messages are actually queued for your callsign; only then call fleet_check ONCE to receive them, handle them, and stop again. Never block in a fleet_standby long-poll waiting for work — it freezes the session from receiving new fleet AND operator messages. Follow ~/.claude/docs/dual-instance-protocol.md: check for messages at task boundaries, announce on the fleet before touching shared surfaces (shared API contracts, databases, shared container/service restarts), and never edit the other instance's repo. MESSAGING ETIQUETTE: to make a member SEE and act on a message, @-mention their exact callsign (e.g. '@web @api ...'). Only @-mentioned members are notified/woken, so @-mention EVERY member your message affects. @all is for transcript/coordination notes ONLY — it notifies NO ONE, so never use @all for anything urgent or needing a response. A hook renames the terminal tab and session title to match your callsign — do not rename them yourself."

jq -n --arg ctx "$context" --arg cs "$callsign" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx, sessionTitle: $cs}}'
