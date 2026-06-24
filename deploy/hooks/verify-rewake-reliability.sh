#!/bin/bash
# Manual verification recipe for the rewake-reliability fix.
#
# Proves the core property: after an identity RENAME, with the static
# /tmp/wt-callsign-<sid> file left STALE (pointing at the OLD callsign), the Stop
# hook (agent-fleet-rewake.sh) still wakes the session for traffic queued to the
# NEW callsign — because it resolves the callsign via the hub GET /whoami?sid=
# resolver, not the stale file.
#
# Boots a THROWAWAY hub on a spare port with a temp DB (never touches the live hub
# on :9559, no gated deploy). Requires a prior `npm run build` in hub/ (uses dist/).
#
# Usage:  bash deploy/hooks/verify-rewake-reliability.sh
# Exit 0 = all assertions passed.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HUB_DIST="$REPO/hub/dist"
REWAKE="$REPO/deploy/hooks/agent-fleet-rewake.sh"

VPORT=9560
VURL="http://localhost:${VPORT}"
JOIN="verify-join-token"
ADM="verify-admin-token"
SID="rewake-verify-sid-1"
DBP="$(mktemp -u /tmp/rewake-verify-XXXX.db)"
BOOT="$(mktemp /tmp/rewake-verify-boot-XXXX.mjs)"
CALLSIGN_FILE="/tmp/wt-callsign-${SID}"
LOCK_FILE="/tmp/wt-rewake-${SID}.lock"

fail() { echo "FAIL: $*" >&2; cleanup; exit 1; }
cleanup() {
  [ -n "${HUB_PID:-}" ] && kill "$HUB_PID" 2>/dev/null
  rm -f "$DBP" "$BOOT" "$CALLSIGN_FILE" "$LOCK_FILE" "$DBP-journal" "$DBP-wal" "$DBP-shm" 2>/dev/null
}
trap cleanup EXIT

[ -f "$HUB_DIST/server.js" ] || fail "hub not built — run 'npm run build' in hub/ first"

# --- boot a throwaway hub via the library (skips index.js listening side-effects) ---
cat > "$BOOT" <<'EOF'
import { pathToFileURL } from "node:url";
const dist = process.env.HUB_DIST;
const { initDB } = await import(pathToFileURL(dist + "/db.js").href);
const { initGeneralChannel } = await import(pathToFileURL(dist + "/channels.js").href);
const { createHubServer } = await import(pathToFileURL(dist + "/server.js").href);
initDB();
initGeneralChannel();
const s = createHubServer(Number(process.env.PORT), process.env.ADM, process.env.JOIN);
s.on("listening", () => console.log("HUB_UP"));
EOF

WALKIE_TALKIE_DB_PATH="$DBP" HUB_DIST="$HUB_DIST" PORT="$VPORT" ADM="$ADM" JOIN="$JOIN" \
  node "$BOOT" &
HUB_PID=$!

# wait for readiness
for _ in $(seq 1 50); do
  curl -s --max-time 1 "$VURL/users" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -s --max-time 1 "$VURL/users" >/dev/null 2>&1 || fail "throwaway hub did not come up"

post() { curl -s --max-time 3 -X POST "$VURL$1" -H "Content-Type: application/json" -H "Authorization: Bearer $2" -d "$3"; }
getj() { curl -s --max-time 3 "$VURL$1"; }                                   # no-auth (public routes)
getauth() { curl -s --max-time 3 "$VURL$1" -H "Authorization: Bearer $JOIN"; } # join-token routes

# 1) SessionStart self-registers a registry row with a COMPUTED callsign.
post /session-register "$JOIN" "{\"session_id\":\"$SID\",\"callsign\":\"linux-old\",\"node\":\"linux\",\"workdir\":\"/x\"}" >/dev/null
who=$(getj "/whoami?sid=$SID" | jq -r '.name // empty')
[ "$who" = "linux-old" ] || fail "whoami after session-register: expected linux-old, got '$who'"
echo "ok: /whoami resolves the initial callsign (linux-old)"

# 2) A sender joins so we can queue traffic.
btok=$(post /register "$JOIN" '{"name":"builder1"}' | jq -r '.token // empty')
[ -n "$btok" ] || fail "could not register sender builder1"

# 3) RENAME: promote this sid to REFEREE (admin path == become_referee).
post /admin-register "$ADM" "{\"name\":\"REFEREE\",\"oldName\":\"builder0\",\"sid\":\"$SID\"}" >/dev/null
who=$(getj "/whoami?sid=$SID" | jq -r '.name // empty')
[ "$who" = "REFEREE" ] || fail "whoami after rename: expected REFEREE, got '$who'"
echo "ok: /whoami follows the rename (REFEREE)"

# 4) Simulate the BUG'S STALE STATE: the static file still names the OLD callsign.
printf '%s' "linux-old" > "$CALLSIGN_FILE"
echo "ok: stale file simulated -> $(cat "$CALLSIGN_FILE")"

# 5) Queue a message to the NEW callsign. (/pending-counts is join-token gated —
#    the same token the rewake hook itself sends.)
post /send "$btok" '{"to":"REFEREE","content":"@REFEREE verify ping","channel":"#all"}' >/dev/null
cnt=$(getauth "/pending-counts" | jq -r '.counts["REFEREE"] // 0')
[ "$cnt" -ge 1 ] 2>/dev/null || fail "expected >=1 queued for REFEREE, got '$cnt'"
old_cnt=$(getauth "/pending-counts" | jq -r '.counts["linux-old"] // 0')
echo "ok: queued counts -> REFEREE=$cnt, linux-old=$old_cnt (the stale name has none)"

# 6) Run the REAL Stop hook. Despite the stale file, it must resolve REFEREE via
#    /whoami, see the queued message, and wake (exit 2) naming REFEREE.
rm -f "$LOCK_FILE"
out=$(printf '{"session_id":"%s","cwd":"/x"}' "$SID" | \
  AGENT_FLEET_HUB_URL="$VURL" AGENT_FLEET_JOIN_TOKEN="$JOIN" AF_REWAKE_INTERVAL=1 AF_REWAKE_MAX_SECS=4 \
  bash "$REWAKE")
rc=$?

echo "--- rewake output ---"; echo "$out"; echo "--- exit $rc ---"
[ "$rc" -eq 2 ] || fail "rewake did not wake (exit $rc); the fix should wake despite the stale file"
echo "$out" | grep -q "REFEREE" || fail "rewake woke for the wrong callsign (stale file leaked through)"
echo "$out" | grep -q "linux-old" && fail "rewake used the STALE callsign linux-old — resolver not honored"

echo
echo "PASS: rename + stale file -> rewake resolved the CURRENT callsign via /whoami and woke for REFEREE."
cleanup
trap - EXIT
exit 0
