#!/bin/bash
# PostToolUse hook (matcher: mcp__plugin_agent-fleet_agent-fleet__(fleet|radio)_.*):
# keep the terminal tab title equal to the on-air callsign. On fleet_join,
# record the joined name and set the title; on other fleet calls, re-assert it
# (built-in topic titling can otherwise overwrite it); on fleet_disconnect, clean up.
# Matches BOTH radio_* (legacy alias) and fleet_* (new) tool names so it works
# during the alias-transition window.

input=$(cat)

tool=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null)
sid=$(echo "$input" | jq -r '.session_id // "nosession"' 2>/dev/null)
state="/tmp/wt-callsign-${sid}"

case "$tool" in
  *__radio_join|*__fleet_join)
    callsign=$(echo "$input" | jq -r '.tool_input.name // empty' 2>/dev/null)
    [ -n "$callsign" ] && printf '%s' "$callsign" > "$state"
    ;;
  *__radio_become_referee|*__fleet_become_referee)
    # Operator-identity promotion: become_referee does not go through
    # fleet_join, so without this case the callsign file is never written
    # and agent-fleet-rewake.sh has no name to poll — REFEREE traffic
    # then queues forever, never re-waking the session. Default to REFEREE.
    callsign=$(echo "$input" | jq -r '.tool_input.name // "REFEREE"' 2>/dev/null)
    [ -n "$callsign" ] && printf '%s' "$callsign" > "$state"
    ;;
  *__radio_claim_referee|*__fleet_claim_referee)
    # Vacancy claim of the REFEREE seat — like become_referee, it renames this
    # session (always to REFEREE; the hub hardcodes the target) without going
    # through fleet_join. Refresh the file so rewake/msgcheck poll the new
    # callsign. (The hub /whoami resolver makes rewake robust regardless, but
    # keep the file fresh for tabtitle/sessionstart and as the offline fallback.)
    callsign="REFEREE"
    printf '%s' "$callsign" > "$state"
    ;;
  *__radio_out|*__radio_disconnect|*__fleet_out|*__fleet_disconnect)
    rm -f "$state"
    exit 0
    ;;
  *)
    callsign=$(cat "$state" 2>/dev/null)
    ;;
esac

[ -z "$callsign" ] && exit 0

# OSC 0 sets both window title and tab name; BEL terminates.
jq -n --arg t "$callsign" '{suppressOutput: true, terminalSequence: ("\u001b]0;" + $t + "\u0007")}'
