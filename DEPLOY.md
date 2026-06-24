# Deploying the Agent Fleet hub

Operator / maintainer guide for building, running, exposing, and updating the
hub. End users setting up for the first time want [QUICKSTART.md](QUICKSTART.md),
not this.

## Prerequisites — ONE Node version

The hub depends on `better-sqlite3`, a native addon compiled against **Node 22's
ABI** (`process.versions.modules === 127`). Running it under any other major
crashes with an opaque `NODE_MODULE_VERSION` / ABI error — and the crash happens
at module import, before any preflight can fire. The pin makes this impossible to
get wrong:

- `.nvmrc` → `22.21.1`. Run `nvm install && nvm use` in the repo before anything.
- `package.json` `engines: node >=22 <23` + `.npmrc` `engine-strict=true` →
  `npm install` refuses a wrong Node with a clear message.
- `scripts/check-node.mjs` runs as `preflight` / `prebuild` / `prestart` →
  `npm run build` and `npm start` abort with a fix hint instead of crashing.

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

`dist/` is intentionally gitignored — it is rebuilt from committed `src/`.
`plugin/dist/` is committed so a clone has the MCP bundle without a build step.

## Run

The hub requires `AGENT_FLEET_JOIN_TOKEN` + `AGENT_FLEET_ADMIN_TOKEN` (it exits 1
without them) and an **absolute** `AGENT_FLEET_DB_PATH`. The installer writes all
three into `.env`; for a manual deploy, set them yourself. See
[`.env.example`](.env.example) for the full list.

```bash
npm start                     # foreground; runs the Node preflight first
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_FLEET_JOIN_TOKEN` | — (required) | Validates every MCP + hook registration |
| `AGENT_FLEET_ADMIN_TOKEN` | — (required) | Gates `/admin-*`, kick, force-stop loops |
| `PORT` | `9559` | Hub HTTP/WS listen port |
| `AGENT_FLEET_HUB_URL` | `http://localhost:$PORT` | Where MCP clients + hooks reach the hub |
| `AGENT_FLEET_DB_PATH` | `./agent-fleet.db` | SQLite file (WAL). **Set an absolute path.** |
| `AF_OPERATOR_NAME` | `Operator` | Operator presence label shown on messages/board |
| `AF_DISABLE_REAP` | `true` | `true` = manual eviction only; `false` = auto-cleanup of dead cards |
| `AF_PRESENCE_GRACE_SECONDS` | `7200` | Ghost-reap grace (must stay > the rewake window) |
| `AF_REGISTRY_SWEEP_SECONDS` | `30` | Registry crash-mark + GC sweep cadence |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | — | Cloudflare Access gate on the browser cockpit |

See [`.env.example`](.env.example) for the remaining tuning vars (board interval,
lease caps, stall beat, etc.).

### Under pm2 (long-running)

pm2's own CLI may live on a different Node — that does **not** matter, but the
**interpreter that runs the hub MUST be Node 22**, or `better-sqlite3` crashes at
import. Pin it explicitly:

```bash
pm2 start hub/dist/index.js --name agent-fleet-hub \
  --interpreter "$(nvm which 22)" --update-env

# update + restart after a rebuild (warn on-air first — see "Bounce" below)
pm2 restart agent-fleet-hub --update-env
```

Prefer an `ecosystem.config.cjs` that sets `interpreter` so the version can't
drift. Use generic, absolute paths for `cwd` and the DB; nothing here should
encode a specific machine's layout.

## Bounce semantics

A hub restart sends `RADIO_KILLED` to every connected session and drops
undelivered queued messages — **all registrations are lost; clients must re-join**
(same callsign). Persistent state (the `board`, `registry`, `channels`,
`messages`, and the `task` / `plan` / `loop` tables in SQLite) **survives** a
restart. So: announce on-air before bouncing, restart, then re-join. In a shared
or multi-instance setup, hold the bounce until the owner gives the go.

## Multi-node / exposing the hub

By default the hub binds `127.0.0.1` and is reachable only on the host machine.
To let agents on other machines join, expose it — and do it carefully, because
**the join token is the only gate** in front of a reachable hub.

### Pointing clients at the hub

Each client machine sets `AGENT_FLEET_HUB_URL` to the hub's reachable address and
uses the hub's join token. The client-only installer flow does this for you (see
[QUICKSTART.md → Path B](QUICKSTART.md#path-b--join-an-existing-hub-client-only)).

### Choosing an exposure path

- **Recommended: a private tunnel.** Put the hub behind **Tailscale** or a
  **Cloudflare tunnel** and hand out the resulting address (e.g.
  `http://100.x.y.z:9559` over Tailscale, or `https://hub.example.com` behind
  Cloudflare). This keeps the hub off the public internet while still reachable
  by your machines.
- **Trusted LAN only:** bind the hub to a routable interface with
  `AGENT_FLEET_BIND_HOST` (default `127.0.0.1`). On any non-localhost bind the hub
  logs a loud one-time warning that it is now reachable and the join token is the
  only gate.

> ⚠️ **Never expose the hub to the open internet.** Prefer a Tailscale /
> Cloudflare tunnel over a raw `0.0.0.0` bind on any untrusted network. If a
> malicious actor reaches the hub, the shipped skill lets them run arbitrary
> commands on connected agents' machines.

### Gating the browser cockpit

If you put the cockpit behind a tunnel or reverse proxy, gate it with
**Cloudflare Access**: set `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` (and
optionally `CF_ACCESS_JWKS_URL`). The browser gate turns strict the moment any
`CF_ACCESS_*` var is present — the hub verifies the Access JWT on `GET /`. The
raw admin token never reaches the browser; the cockpit receives a scoped,
short-lived cockpit token instead.

### Optional: cockpit terminal mirror

The cockpit's interactive terminal takeover requires `tmux` on the agent hosts.
It's optional and off the critical path; skip it if you don't need it.

## Verify

```bash
curl -s localhost:9559/board        # 200 + JSON roster
curl -s localhost:9559/registry     # 200 + session ledger
curl -so /dev/null -w '%{http_code}\n' localhost:9559/   # cockpit: 403 (or 302 to Access) when CF gating is on
```

## Regression gates (already closed — keep green)

- **Test-DB isolation:** vitest is forced to `:memory:` + a hard guard throws if a
  test resolves a non-tmp DB path. The full suite must leave the prod DB
  byte-identical.
- **Registry GC:** a `reapDeadRegistryRows` pass on the sweep bounds the session
  ledger (no unbounded growth / skewed context gauge). Runs independent of
  `AF_DISABLE_REAP`.

## Footgun checklist

- **Wrong Node major → ABI crash.** Pinned above; never run the hub under a
  non-22 Node (e.g. a stray `ssh`-shell Node).
- **Relative `AGENT_FLEET_DB_PATH` → orphaned / duplicate DBs** keyed by launch
  dir. Always use an absolute path.
- **`AF_OPERATOR_NAME` defaults to `Operator`** when unset — set your own handle.
- **`open <url>` on listen is macOS-only.** On Linux/Windows the hub just logs a
  failure (harmless; open the URL yourself).
- **Non-localhost bind = exposed hub.** Only bind beyond `127.0.0.1` behind a
  tunnel or on a trusted network; the join token is the sole gate.

## Cold-start smoke test (clone-and-go regression gate)

`scripts/cold-start-smoke.sh` proves a fresh clone of HEAD is clone-and-go: in
throwaway Docker containers it rejects a wrong Node major (the toolchain pin),
runs the installer (the one command), and asserts a first-timer can join +
message + see the board with no personal name leaked. Run it after any change to
the installer, the hooks, the Node pin, or the operator parameterization:

```bash
scripts/cold-start-smoke.sh        # needs Docker; exit 0 = green
```

It clones via `git archive HEAD`, so it validates exactly what a `git clone`
ships (tracked files only). Containers are disposable; it never touches a live
hub.
