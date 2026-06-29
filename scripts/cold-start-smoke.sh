#!/usr/bin/env bash
# ============================================================================
# Agent Fleet — cold-start smoke test  (clone-and-go regression gate)
# ============================================================================
# Proves THIS repo, freshly cloned into a THROWAWAY container, comes up with the
# ONE documented command and lets a first-timer join + message + see the board —
# zero tribal knowledge — across an npm MATRIX.
#
# WHY the matrix: npm 11.5+ DEFERS dependency install scripts by default
# ("allow-scripts"), which SKIPS native builds (better-sqlite3) → the hub can't
# require() it → it never starts. A CI pinned to one npm-10 image silently
# FALSE-GREENS this class (it shipped a Windows + npm-11 break past byte-diffs).
# So we run the full cold start under BOTH the image's npm (10.x) AND npm@latest
# (11.5+). Both legs must pass.
#
# Usage:   scripts/cold-start-smoke.sh [REPO_SRC]
#   REPO_SRC defaults to this repo's root (HEAD is the tree under test, via
#   `git archive` — validates exactly what a `git clone` ships). Requires Docker.
#   Per-run container + temp names are unique ($$) so concurrent runs never collide.
#   Exit 0 = every matrix leg green.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SRC="${1:-$(git -C "$SELF_DIR" rev-parse --show-toplevel)}"
HUBPORT="${HUBPORT:-9559}"
NPM_MATRIX=("image" "latest")   # image = node:22's bundled npm (10.x); latest = npm 11.5+
PASS() { echo "  ✓ $1"; }
FAIL() { echo "  ✗ $1"; exit 1; }
CIDS=()
cleanup() { for c in "${CIDS[@]:-}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT
clone_into() { git -C "$REPO_SRC" archive --format=tar HEAD | docker exec -i "$1" bash -lc 'mkdir -p agent-fleet && tar -x -C agent-fleet'; }

echo "== Agent Fleet cold-start smoke (HEAD $(git -C "$REPO_SRC" rev-parse --short HEAD)) =="

# (1) Toolchain pin REJECTS a wrong Node major in a clean env (no opaque ABI crash).
C20="af-cs-n20-$$"; CIDS+=("$C20")
docker run -d --name "$C20" -w /root node:20 sleep 600 >/dev/null
clone_into "$C20"
if docker exec "$C20" bash -lc 'cd agent-fleet && node scripts/check-node.mjs' >/dev/null 2>&1; then
  FAIL "preflight did NOT reject Node 20 (toolchain pin broken)"
else
  docker exec "$C20" bash -lc 'cd agent-fleet && node scripts/check-node.mjs 2>&1 | grep -q "Node 22"' \
    && PASS "wrong-node (20) rejected with a clear message" || FAIL "preflight non-zero but no clear Node-22 hint"
fi

# (2) Full cold start under each npm in the matrix.
for SEL in "${NPM_MATRIX[@]}"; do
  C="af-cs-$SEL-$$"; CIDS+=("$C")
  docker run -d --name "$C" -w /root node:22 sleep 1800 >/dev/null
  clone_into "$C"
  [ "$SEL" = "image" ] || docker exec "$C" bash -lc "npm i -g npm@$SEL >/dev/null 2>&1" || FAIL "[$SEL] npm upgrade failed"
  NPMV="$(docker exec "$C" bash -lc 'npm -v')"
  echo "  -- matrix leg: npm $NPMV --"
  docker exec "$C" bash -lc 'test -f agent-fleet/package.json' || FAIL "[npm $NPMV] fresh clone extract failed"
  docker exec "$C" bash -lc 'cd agent-fleet && ./install.sh' && PASS "[npm $NPMV] ./install.sh exit 0" || FAIL "[npm $NPMV] install.sh failed"
  docker exec "$C" bash -lc "for i in \$(seq 1 60); do curl -sf localhost:$HUBPORT/board >/dev/null && exit 0; sleep 0.5; done; exit 1" \
    && PASS "[npm $NPMV] hub up (GET /board 200)" \
    || FAIL "[npm $NPMV] hub never came up (native dep build skipped under npm 11.5+ allow-scripts?)"
  docker exec "$C" bash -lc '
    set -e
    cd agent-fleet && set -a && . ./.env && set +a
    REG=$(curl -sf -X POST "$AGENT_FLEET_HUB_URL/register" -H "Content-Type: application/json" \
          -H "Authorization: Bearer $AGENT_FLEET_JOIN_TOKEN" -d "{\"name\":\"newcomer\",\"sid\":\"cs-newcomer\"}")
    MTOK=$(printf "%s" "$REG" | node -e "process.stdout.write(JSON.parse(require(\"fs\").readFileSync(0)).token||\"\")")
    [ -n "$MTOK" ] || { echo "  /register no token"; exit 1; }
    printf "%s" "$(curl -sf -X POST "$AGENT_FLEET_HUB_URL/send" -H "Content-Type: application/json" \
          -H "Authorization: Bearer $MTOK" -d "{\"to\":\"@all\",\"content\":\"hi\",\"channel\":\"#all\"}")" \
      | node -e "JSON.parse(require(\"fs\").readFileSync(0)).id||process.exit(1)"
    curl -sf "$AGENT_FLEET_HUB_URL/users" | grep -q newcomer
  ' && PASS "[npm $NPMV] first-timer joined + messaged + sees roster" || FAIL "[npm $NPMV] round-trip failed"
  docker exec "$C" bash -lc 'curl -sf localhost:'"$HUBPORT"'/users | grep -qi "\"operator\"" && exit 1 || exit 0' \
    && PASS "[npm $NPMV] no personal name leaked" || FAIL "[npm $NPMV] personal name leaked"
done

echo "== COLD-START GREEN: clone → one command → working fleet, pinned toolchain, no personal name, across npm 10 + 11.5+ =="
