#!/usr/bin/env bash
# Release acceptance: Tier-2 cross-machine client-join + the genericized LOCAL Launch-Referee
# spawn. Throwaway Docker (2 containers on a private net). Exit 0 = all green.
set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SRC="${1:-$(git -C "$SELF_DIR" rev-parse --show-toplevel)}"   # HEAD of this repo (committed tree), via git archive
NET="af-acc-net-$$"; HUB="af-acc-hub-$$"; CLI="af-acc-cli-$$"
PASS(){ echo "  PASS $1"; }
FAIL(){ echo "  FAIL $1"; echo "  -- diag --"; docker exec "$HUB" bash -lc 'tmux ls 2>&1; echo ---; cat /tmp/claude-stub.log 2>/dev/null; echo ---; tail -5 agent-fleet/logs/hub.log 2>/dev/null' 2>/dev/null || true; exit 1; }
CLEANUP(){ docker rm -f "$HUB" "$CLI" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap CLEANUP EXIT
clone_into(){ git -C "$REPO_SRC" archive --format=tar HEAD | docker exec -i "$1" bash -lc 'mkdir -p agent-fleet && tar -x -C agent-fleet'; }

echo "== Release acceptance (HEAD $(git -C "$REPO_SRC" rev-parse --short HEAD)) =="
docker network create "$NET" >/dev/null || FAIL "docker network create"

# --- HUB: full install, bound 0.0.0.0 so a remote client can reach it ---
docker run -d --name "$HUB" --network "$NET" -e AGENT_FLEET_BIND_HOST=0.0.0.0 -w /root node:22 sleep 2400 >/dev/null
clone_into "$HUB"
echo "  -- installing hub (full Tier-1, ~1-2min) --"
docker exec -e AGENT_FLEET_BIND_HOST=0.0.0.0 "$HUB" bash -lc 'cd agent-fleet && ./install.sh' >/dev/null 2>&1 && PASS "hub install.sh exit 0" || FAIL "hub install failed"
docker exec "$HUB" bash -lc 'for i in $(seq 1 90); do curl -sf localhost:9559/board >/dev/null && exit 0; sleep 0.5; done; exit 1' && PASS "hub up (GET /board 200)" || FAIL "hub never up"
JT="$(docker exec "$HUB" bash -lc 'cd agent-fleet && grep "^AGENT_FLEET_JOIN_TOKEN=" .env | cut -d= -f2-' | tr -d "\r")"
ADM="$(docker exec "$HUB" bash -lc 'cd agent-fleet && grep "^AGENT_FLEET_ADMIN_TOKEN=" .env | cut -d= -f2-' | tr -d "\r")"
{ [ -n "$JT" ] && [ -n "$ADM" ]; } && PASS "captured hub join + admin tokens" || FAIL "missing tokens in hub .env"
docker exec "$HUB" bash -lc 'test -f "$HOME/.claude/docs/dual-instance-protocol.md"' && PASS "install placed ~/.claude/docs/dual-instance-protocol.md (no dangling hook ref)" || FAIL "dual-instance-protocol.md not placed by install"

# ===================== Tier-2: client joins the existing hub =====================
docker run -d --name "$CLI" --network "$NET" -w /root node:22 sleep 2400 >/dev/null
clone_into "$CLI"
docker exec "$CLI" bash -lc "cd agent-fleet && ./install.sh --hub-url http://$HUB:9559 --join-token '$JT'" && PASS "client install.sh --hub-url/--join-token exit 0" || FAIL "client install failed"
docker exec "$CLI" bash -lc 'cd agent-fleet && test ! -d node_modules' && PASS "client ran NO npm install (zero native build)" || FAIL "client unexpectedly built native deps"
docker exec "$CLI" bash -lc "cd agent-fleet && grep -q '^AGENT_FLEET_HUB_URL=http://$HUB:9559\$' .env && grep -q '^AGENT_FLEET_JOIN_TOKEN=$JT\$' .env" && PASS "client .env → remote hub + token" || FAIL "client .env wrong"
docker exec "$CLI" bash -lc "curl -sf http://$HUB:9559/board >/dev/null" && PASS "client reaches hub over net (BIND_HOST honored)" || FAIL "client cannot reach hub"
docker exec "$CLI" bash -lc "curl -sf -X POST http://$HUB:9559/register -H 'Content-Type: application/json' -H 'Authorization: Bearer $JT' -d '{\"name\":\"client-node\",\"sid\":\"acc-cli\"}' | node -e 'process.exit(JSON.parse(require(\"fs\").readFileSync(0)).token?0:1)'" && PASS "client registered on remote hub" || FAIL "client /register failed"
docker exec "$HUB" bash -lc 'curl -sf localhost:9559/users | grep -q client-node' && PASS "client appears on HUB roster (cross-node join)" || FAIL "client not on hub roster"
code="$(docker exec "$CLI" bash -lc "curl -s -o /dev/null -w '%{http_code}' -X POST http://$HUB:9559/register -H 'Content-Type: application/json' -H 'Authorization: Bearer WRONG' -d '{\"name\":\"evil\",\"sid\":\"e\"}'")"
{ [ "$code" = 401 ] || [ "$code" = 403 ]; } && PASS "wrong join token rejected ($code)" || FAIL "wrong token NOT rejected ($code)"

# ===================== Launch-Referee: genericized LOCAL portable spawn =====================
echo "  -- launch-referee: tmux + PATH-stub claude --"
docker exec "$HUB" bash -lc 'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq tmux >/dev/null 2>&1' && PASS "tmux installed (hub)" || FAIL "tmux install failed"
# Stub `claude` on PATH: when fleet.mjs spawns it, register on the hub under its AF_CALLSIGN, then idle.
docker exec "$HUB" bash -lc 'cat > /usr/local/bin/claude << "STUB"
#!/usr/bin/env bash
set -a; . /root/agent-fleet/.env 2>/dev/null || true; set +a
H="${AGENT_FLEET_HUB_URL:-http://localhost:9559}"; T="${AGENT_FLEET_JOIN_TOKEN:-}"; N="${AF_CALLSIGN:-launch-probe}"
curl -s -X POST "$H/register" -H "Content-Type: application/json" -H "Authorization: Bearer $T" -d "{\"name\":\"$N\",\"sid\":\"launchref-$N\"}" >>/tmp/claude-stub.log 2>&1
echo "stub claude fired AF_CALLSIGN=$N AF_ROLE=${AF_ROLE:-?}" >>/tmp/claude-stub.log
sleep 60
STUB
chmod +x /usr/local/bin/claude && command -v claude' >/dev/null && PASS "PATH-stub claude installed" || FAIL "stub claude failed"
# admin-gating: no token → 401/403
code="$(docker exec "$HUB" bash -lc "curl -s -o /dev/null -w '%{http_code}' -X POST localhost:9559/admin-launch-referee")"
{ [ "$code" = 401 ] || [ "$code" = 403 ]; } && PASS "/admin-launch-referee gated w/o admin token ($code)" || FAIL "launch-referee NOT admin-gated ($code)"
# fire it with admin token
code="$(docker exec "$HUB" bash -lc "curl -s -o /dev/null -w '%{http_code}' -X POST localhost:9559/admin-launch-referee -H 'Authorization: Bearer $ADM'")"
echo "$code" | grep -qE '^(200|201|202)$' && PASS "/admin-launch-referee accepted w/ admin token ($code)" || FAIL "launch-referee rejected admin ($code)"
# spawn fired → detached wt-* tmux session
docker exec "$HUB" bash -lc 'for i in $(seq 1 30); do tmux ls 2>/dev/null | grep -q "^wt-" && exit 0; sleep 0.5; done; exit 1' && PASS "detached wt-* tmux session spawned (fleet.mjs portable spawn fired)" || FAIL "no wt-* tmux session"
# spawned session reached the PATH claude → registered on the hub (proves portability end-to-end)
docker exec "$HUB" bash -lc 'for i in $(seq 1 40); do curl -sf localhost:9559/users | grep -qE "linux-|launch-probe" && exit 0; sleep 0.5; done; exit 1' && PASS "spawned session registered on hub (PATH claude reached → portable spawn proven)" || FAIL "spawned session never registered"
docker exec "$HUB" bash -lc 'curl -sf localhost:9559/board >/dev/null' && PASS "hub survived the spawn" || FAIL "hub died after spawn"

echo "== ACCEPTANCE GREEN: Tier-2 cross-machine join (zero native build) + genericized LOCAL Launch-Referee spawns portably; bad token rejected, hub survives =="
