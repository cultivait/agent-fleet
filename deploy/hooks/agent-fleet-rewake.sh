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

# Logbook nudge (board auto-digest v1). RIDES the rewake that is ALREADY firing below —
# it NEVER creates its own wake (a self-firing nudge would re-bill full context, the very
# cost this feature cuts). Appends one reminder line to the wake the agent is already
# reading, IF the agent chatted recently and we haven't nudged this session in >20min.
# FULLY FAIL-OPEN: every step short-circuits to `return 0` on any error, so the function
# can only ever ADD a line or do nothing — it can never alter the core wake path below.
# Called as `log_nudge || true`, after the wake echo, before exit 2.
log_nudge() {
  local tf recent now last
  # newest transcript for THIS session (glob by sid avoids cwd-encoding fragility)
  tf=$(ls -t "$HOME"/.claude/projects/*/"${sid}".jsonl 2>/dev/null | head -1) || return 0
  [ -n "$tf" ] || return 0
  recent=$(tail -n 80 "$tf" 2>/dev/null) || return 0
  # did the agent send chat recently? (its own fleet_send/radio_send tool_use)
  printf '%s' "$recent" | grep -qE '"name": ?"mcp__walkie-talkie__(fleet|radio)_send"' 2>/dev/null || return 0
  # rate-limit: at most once / 20min / session, so it informs without nagging
  now=$(date +%s 2>/dev/null) || return 0
  last=$(cat "/tmp/wt-lognudge-${sid}" 2>/dev/null || echo 0)
  [ $((now - last)) -ge 1200 ] 2>/dev/null || return 0
  echo "$now" > "/tmp/wt-lognudge-${sid}" 2>/dev/null || true
  # Quoted heredoc: emitted VERBATIM (no expansion, backslashes literal) so the curl line
  # the agent pastes keeps $AF_CALLSIGN / $AGENT_FLEET_JOIN_TOKEN as refs THEIR shell
  # expands — the token is never written literally anywhere.
  cat <<'__NUDGE__'
Logbook nudge: you've been sending detail to chat. Detail that does NOT need to WAKE anyone — findings, progress, reasoning — belongs in the logbook, not chat: logging wakes no one and shows on the board's per-agent timeline. Log a finding (wakes no one):
  curl -s -X POST "${AGENT_FLEET_HUB_URL:-http://localhost:9559}/agent-log" -H "Authorization: Bearer $AGENT_FLEET_JOIN_TOKEN" -H 'Content-Type: application/json' -d "{\"name\":\"$AF_CALLSIGN\",\"kind\":\"finding\",\"note\":\"<your one-liner>\"}"
kind = finding|decision|blocker|done. Keep CHAT for decisions/asks/acks — things that must wake someone.
__NUDGE__
}

# Teammate-log digest (board-digest v2 — the READ half of the logbook). Like log_nudge
# above, it RIDES the rewake that is ALREADY firing below and NEVER creates its own wake
# (surfacing a teammate's log entry must not wake an idle agent — that would re-bill full
# context for a passive read, the exact cost this feature cuts). On a firing wake it appends
# a BOUNDED, DELTA block: the <=5 newest OTHER-agent log entries since this session last saw
# them (watermark in /tmp/wt-logdigest-<sid>, same mechanism as the nudge rate-limit), so the
# same entry is shown at most once. FULLY FAIL-OPEN: every step short-circuits to `return 0`,
# so it can only ADD lines or do nothing — never alter the core wake path. Reads $hub/$callsign/
# $sid from the firing loop. Called as `log_digest || true`, after the wake echo, before exit 2.
log_digest() {
  local last resp count new_wm lines
  last=$(cat "/tmp/wt-logdigest-${sid}" 2>/dev/null || echo 0)
  [ -n "$last" ] || last=0
  # newest-first, OTHER agents only (exclude self), only ids > our watermark, capped at 5.
  # -G + --data-urlencode safely encodes a space-bearing callsign (e.g. "REFEREE windows").
  resp=$(curl -s -G --max-time 3 "${hub}/agent-log-digest" \
           --data-urlencode "since=${last}" \
           --data-urlencode "limit=5" \
           --data-urlencode "exclude=${callsign}" 2>/dev/null) || return 0
  [ -n "$resp" ] || return 0
  count=$(printf '%s' "$resp" | jq -r '.entries | length' 2>/dev/null) || return 0
  [ "$count" -gt 0 ] 2>/dev/null || return 0
  # watermark = newest id = first element (response is id-DESC); advances past capped overflow too.
  new_wm=$(printf '%s' "$resp" | jq -r '.entries[0].id // empty' 2>/dev/null) || return 0
  [ -n "$new_wm" ] || return 0
  # one bounded line per entry, reversed to chronological (oldest->newest) for reading; note clipped.
  lines=$(printf '%s' "$resp" | jq -r '.entries | reverse | .[] | "  • \(.name // "?") [\(.kind // "?")] \((.note // "")[0:100])"' 2>/dev/null) || return 0
  [ -n "$lines" ] || return 0
  echo "── Teammate log (since you last looked) — read-only context, no reply needed ──"
  printf '%s\n' "$lines"
  # advance the watermark only AFTER a successful emit, so a mid-failure re-shows next time.
  echo "$new_wm" > "/tmp/wt-logdigest-${sid}" 2>/dev/null || true
}

elapsed=0
while [ "$elapsed" -lt "$max" ]; do
  callsign=$(resolve_callsign)
  if [ -n "$callsign" ]; then
    n=$(curl -s --max-time 3 "$hub/pending-counts" -H "Authorization: Bearer $token" \
        | jq -r --arg n "$callsign" '.counts[$n] // 0' 2>/dev/null) || n=0
    if [ "$n" -gt 0 ] 2>/dev/null; then
      # T4 (Operator's ask): remind to stay TERSE, and — if REFEREE — to DELEGATE not build. $callsign
      # is resolved per-loop above, so the referee-only clause is gated on it.
      role_hint=""
      [ "$callsign" = "REFEREE" ] && role_hint=" You are REFEREE: DELEGATE to a builder — do not build or edit files yourself."
      echo "Fleet traffic: $n message(s) queued for '$callsign' on the agent-fleet hub. Call fleet_check now to receive them (instant — they are already queued), handle them per ~/.claude/docs/dual-instance-protocol.md, then STOP again if there is nothing else to do. Keep replies terse. Do not enter a fleet_standby loop.$role_hint"
      log_digest || true
      log_nudge || true
      exit 2
    fi
  fi
  sleep "$interval"
  elapsed=$((elapsed + interval))
done
exit 0
