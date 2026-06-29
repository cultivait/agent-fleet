# Deploying the Agent Fleet hub

Operator/maintainer guide for building, running, and updating the hub. End users
setting up for the first time want the QUICKSTART, not this.

## Prerequisites — ONE Node version

The hub depends on `better-sqlite3`, a native addon compiled against **Node 22's ABI**
(`process.versions.modules === 127`). Running it under any other major crashes with an
opaque `NODE_MODULE_VERSION` / ABI error. Historically this bit us as a three-way split
(build under 22, pm2 CLI under 20, `ssh` shell under 18 — the last segfaults the hub).

Pinned so it can't recur:
- `.nvmrc` → `22.21.1`. Run `nvm install && nvm use` in the repo before anything.
- `package.json` `engines: node >=22 <23` + `.npmrc` `engine-strict=true` → `npm install`
  refuses a wrong Node with a clear message.
- `scripts/check-node.mjs` runs as `preflight`/`prebuild`/`prestart` → `npm run build` and
  `npm start` abort with a fix hint instead of crashing.

```bash
nvm install && nvm use        # Node 22 per .nvmrc
node scripts/check-node.mjs   # sanity: prints nothing + exits 0 on Node 22
```

## Build

```bash
npm install                   # all workspaces (hub, mcp-server, slack-bot)
npm run build                 # tsc each workspace -> dist/ (gitignored build artifact)
npm run bundle                # bundle the MCP server -> plugin/dist/mcp-server.mjs (TRACKED)
```
`dist/` is intentionally gitignored — it is rebuilt from committed `src/`. `plugin/dist/`
is committed so a clone has the MCP bundle without a build step.

## Run

Requires `AGENT_FLEET_JOIN_TOKEN` + `AGENT_FLEET_ADMIN_TOKEN` (hub exits 1 without them)
and an **absolute** `AGENT_FLEET_DB_PATH`. See `.env.example`.

```bash
npm start                     # foreground; runs the Node preflight first
```

### Under pm2 (long-running)
pm2's own CLI may live on a different Node — that does NOT matter, but the **interpreter
that runs the hub MUST be Node 22**, or better-sqlite3 crashes at import (before any
preflight can fire). Pin it:

```bash
# launch the hub explicitly with the Node 22 binary
pm2 start hub/dist/index.js --name agent-fleet-hub \
  --interpreter "$(nvm which 22)" --update-env

# update + restart after a rebuild (warn on-air first — see "Bounce" below)
pm2 restart agent-fleet-hub --update-env
```
Prefer an `ecosystem.config.cjs` that sets `interpreter` so the version can't drift.

## Bounce semantics

A hub restart sends `RADIO_KILLED` to every connected session and drops undelivered
queued messages — **all registrations are lost; clients must re-join** (same callsign).
Persistent state (the `board`, `registry`, `channels`, `messages`, `task`/`project`
tables in sqlite) **survives** a restart. So: announce on-air before bouncing, restart,
then re-join. In a shared/multi-instance setup, hold the bounce for the owner's go.

## Verify

```bash
curl -s localhost:9559/board        # 200 + JSON roster
curl -s localhost:9559/registry     # 200 + session ledger
curl -so /dev/null -w '%{http_code}\n' localhost:9559/   # cockpit: 403 (or 302 to Access) when CF gating is on
```

## Regression gates (already closed — keep green)

- **Test-DB isolation:** vitest is forced to `:memory:` + a hard guard throws if a test
  resolves a non-tmp DB path. The full suite must leave the prod DB byte-identical.
- **Registry GC:** `reapDeadRegistryRows` on the 30s sweep bounds the session ledger
  (no more unbounded growth / skewed context gauge). Runs independent of `AF_DISABLE_REAP`.

## Footgun checklist

- Wrong Node major → ABI crash. (Pinned above; never `ssh`-shell-run the hub on Node 18.)
- `AGENT_FLEET_DB_PATH` relative → orphaned/duplicate DBs by launch dir. Use an absolute path.
- `AF_OPERATOR_NAME` ships as `Operator` in the source deploy — set your own.
- The hub calls `open <url>` on listen to launch the dashboard — that's macOS-only; on
  Linux/Windows it just logs a failure (harmless; open the URL yourself).

## Cold-start smoke test (clone-and-go regression gate)

`scripts/cold-start-smoke.sh` proves a fresh clone of HEAD is clone-and-go: in throwaway
Docker containers it rejects a wrong Node major (the toolchain pin), runs `./install.sh`
(the one command), and asserts a first-timer can join + message + see the board with no
personal name leaked. Run it after any change to `install.sh`, the hooks, the Node pin,
or the operator parameterization:

```bash
scripts/cold-start-smoke.sh        # needs Docker; exit 0 = green
```

It clones via `git archive HEAD`, so it validates exactly what a `git clone` ships
(tracked files only). Containers are disposable; it never touches a live hub.
