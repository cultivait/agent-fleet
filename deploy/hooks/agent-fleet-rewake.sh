#!/bin/bash
# Stop hook (asyncRewake): after a session goes idle, poll the agent-fleet
# hub for messages queued to this session's callsign. Exit 2 wakes the model
# with instructions to receive them. Exits silently when the hub is down, the
# callsign isn't registered, or another poller already runs for this session.

input=$(cat)
hub="${AGENT_FLEET_HUB_URL:-$WALKIE_TALKIE_HUB_URL}"
[ -z "$hub" ] && hub="http://localhost:9559"
token="${AGENT_FLEET_JOIN_TOKEN:-$WALKIE_TALKIE_JOIN_TOKEN}"
[ -z "$token" ] && exit 0
interval="${AF_REWAKE_INTERVAL:-${WT_REWAKE_INTERVAL:-10}}"
max="${AF_REWAKE_MAX_SECS:-${WT_REWAKE_MAX_SECS:-1800}}"

sid=$(echo "$input" | jq -r '.session_id // "nosession"' 2>/dev/null)

# Gate — "did this session ever JOIN a fleet identity?" The callsign file is written
# ONLY on fleet_join / fleet_become_referee / fleet_claim_referee (agent-fleet-tabtitle.sh)
# and removed on fleet_out, so its EXISTENCE is a reliable on-the-radio marker that
# survives identity renames (unlike its CONTENTS, which a rename leaves stale). Solo
# sessions that never joined — even though they self-register at SessionStart — have
# no file, so they get no rewake polling at all (zero context cost, as before).
[ -s "/tmp/wt-callsign-${sid}" ] || exit 0

# One poller per session, ever — the lock dies with the process.
exec 9>"/tmp/wt-rewake-${sid}.lock"
flock -n 9 || exit 0

# Best-effort sweep of lock files orphaned by sessions that exited long ago (a poller
# lives at most $max ≈ 30min, so a lock untouched for >2h belongs to a dead session).
# The wide margin guarantees we never unlink a LIVE poller's lock — doing so would let
# a second poller for the same sid acquire a fresh inode and double-wake. Keeps /tmp
# from accruing thousands of 0-byte locks.
find /tmp -maxdepth 1 -name 'wt-rewake-*.lock' -mmin +120 -delete 2>/dev/null || true

# Resolve THIS session's CURRENT callsign. The hub registry (sid->callsign, stamped on
# every identity op: join / become_referee / claim_referee) is AUTHORITATIVE via
# GET /whoami; the static file is only the fallback for when the hub is unreachable.
# Re-resolved each loop so a rename WHILE the session is idle — the exact
# rewake-reliability bug — moves the poller onto the new callsign instead of stranding
# it on a dead queue. The old "must appear in /users by name" presence gate is GONE:
# the wake decision is the QUEUE depth for the resolved callsign, not whether a card is
# on the roster (an identity split sheds the card while messages stay queued — which is
# exactly what used to suppress wakes silently).
resolve_callsign() {
  local who cs=""
  who=$(curl -s --max-time 2 "$hub/whoami?sid=${sid}" 2>/dev/null) \
    && cs=$(printf '%s' "$who" | jq -r '.name // empty' 2>/dev/null)
  [ -z "$cs" ] && cs=$(cat "/tmp/wt-callsign-${sid}" 2>/dev/null)
  printf '%s' "$cs"
}

elapsed=0
while [ "$elapsed" -lt "$max" ]; do
  callsign=$(resolve_callsign)
  if [ -n "$callsign" ]; then
    n=$(curl -s --max-time 3 "$hub/pending-counts" -H "Authorization: Bearer $token" \
        | jq -r --arg n "$callsign" '.counts[$n] // 0' 2>/dev/null) || n=0
    if [ "$n" -gt 0 ] 2>/dev/null; then
      echo "Fleet traffic: $n message(s) queued for '$callsign' on the agent-fleet hub. Call fleet_check now to receive them (instant — they are already queued), handle them per ~/.claude/docs/dual-instance-protocol.md (stay terse), then STOP again if there is nothing else to do. Do not enter a fleet_standby loop."
      exit 2
    fi
  fi
  sleep "$interval"
  elapsed=$((elapsed + interval))
done
exit 0
