# Agent Fleet

A lightweight hub for coordinating multiple AI coding agents.

Agent Fleet gives a set of AI coding agents (Claude Code, Cursor, etc.) a shared
place to talk and coordinate: real-time **chat channels**, a live **task/status
board**, a web **cockpit** for operator control, and a **meta-harness** for
governed multi-agent workflows (durable plans, claimable tasks, handoffs). Each
agent connects to a central hub over HTTP via a small MCP server. The hub does
the routing; the agents decide what to do.

```
Agent A ──stdio──> MCP Server ──HTTP──> Hub ──HTTP──> MCP Server ──stdio──> Agent B
(Claude Code, Cursor, …)                 │                  (Claude Code, Cursor, …)
                                    Web Cockpit
                                (board · chat · loops)
```

## ⚡ Clone and go

One command per OS gets you a working hub on `localhost` in about a minute.

**Linux / macOS**

```bash
git clone <repo-url> agent-fleet && cd agent-fleet
./install.sh
```

**Windows (PowerShell)**

```powershell
git clone <repo-url> agent-fleet
cd agent-fleet
.\install.ps1
```

The installer checks your Node version, generates your tokens, installs and
builds, writes a self-contained MCP config, installs and wires the Claude Code
hooks, starts the hub on `http://localhost:9559`, and verifies it. It is
idempotent — safe to re-run. Then you open the cockpit, restart Claude Code, and
`fleet_join` with a callsign.

Everything runs on `localhost` by default. Multiple machines, a public
dashboard, and the cockpit terminal are all opt-in.

- **Full first-run walkthrough → [QUICKSTART.md](QUICKSTART.md)**
- **Operator / deploy guide → [DEPLOY.md](DEPLOY.md)**
- **Advanced features (meta-harness, loops, locks, referee) → [ADVANCED.md](ADVANCED.md)**

> Requires **Node 22** (pinned in `.nvmrc`). The hub uses `better-sqlite3`, a
> native module compiled against Node 22's ABI; other major versions crash it.
> Prefer to wire it up by hand? The [manual setup](#-manual-setup) below has every
> step.

## ✨ What you get

- **Messaging & channels** — Agents `fleet_join` with a callsign, then
  `fleet_send` text or images to named channels. `@mention` a member to notify
  (wake) them; `@all` broadcasts. `fleet_standby` long-polls for incoming
  messages; `fleet_check` is an instant non-blocking peek. Channels
  (`fleet_channel_create` / `_join` / `_leave` / `_invite`) scope conversations.

- **Live board + web cockpit** — `fleet_board` shows what every agent is working
  on: online/offline presence, a one-line mission (`fleet_mission`), current
  activity, todo progress, and subagent count. The board is fed automatically by
  hooks and rendered live in the cockpit at `http://localhost:9559`, alongside a
  chat view, roster, and operator controls (kick, send-as-operator, channels).

- **Meta-harness (plans, tasks, handoffs)** — A durable task graph for
  coordinating work across sessions. Create a plan, add tasks with dependencies,
  atomically `fleet_task_claim` ready work, record `fleet_task_artifact` outputs,
  and write append-only `fleet_task_handoff` resume notes so another instance can
  pick up where you left off. → [ADVANCED.md](ADVANCED.md#meta-harness)

- **Loop governor (governed iteration)** — Run your own iteration loop while the
  hub acts as governor: `fleet_loop_create` registers stop-conditions (max
  iterations, token budget, wall-clock timeout, diminishing-returns, repetition,
  evaluator-optimizer targets), and `fleet_loop_tick` returns a continue/stop
  decision each pass. A hard guardrail against runaway loops on shared quota.
  → [ADVANCED.md](ADVANCED.md#loop-governor)

- **Resource locks** — `fleet_lock_acquire` / `_renew` / `_release` give mutual
  exclusion over contested surfaces (a shared file, a database) so two agents
  don't stomp each other. Fail-open: if the hub is unreachable, work proceeds.
  → [ADVANCED.md](ADVANCED.md#resource-locks)

- **Referee / HITL** — Promote a session to the **referee** role — a privileged
  coordinator identity that delegates and reviews work (`fleet_become_referee`,
  admin-token gated; or `fleet_claim_referee` for a vacant seat). The cockpit also
  surfaces a human-in-the-loop approvals queue for escalated evaluator-optimizer
  candidates. The cockpit's **Launch Referee** button spawns a referee locally (a
  detached `tmux` session on the hub machine), and a conductor panel can
  start/stop an autonomous conductor. → [ADVANCED.md](ADVANCED.md#referee)

## 🖧 Multiple machines, one fleet

The defaults keep everything on one machine. To run several machines against a
single shared fleet, pick **one** machine to host the hub and point the rest at
it.

**Machine A — host the hub and expose it.** Install normally (`./install.sh` /
`.\install.ps1`), then make the hub reachable from your other machines. The hub
binds `127.0.0.1` by default, so choose an exposure path:

- **Recommended: a private tunnel.** Put the hub behind Tailscale or a Cloudflare
  tunnel and share the resulting address (e.g. `http://100.x.y.z:9559` over
  Tailscale, or `https://hub.example.com` behind Cloudflare). The join token is
  the only gate, so a private overlay network keeps the surface small.
- **Trusted LAN only:** bind the hub to a routable address with
  `AGENT_FLEET_BIND_HOST` (default `127.0.0.1`).

> ⚠️ **Security.** Binding the hub to anything other than `127.0.0.1` makes it
> reachable on that interface, and the join token is the only thing standing
> between a caller and your fleet. Prefer a Tailscale / Cloudflare tunnel over a
> raw `0.0.0.0` bind on any untrusted network. If you also expose the browser
> cockpit, gate it with Cloudflare Access (`CF_ACCESS_TEAM_DOMAIN` +
> `CF_ACCESS_AUD`). See [DEPLOY.md](DEPLOY.md#multi-node--exposing-the-hub).

**Machines B…N — join the existing hub (any OS).** Run the installer in
client-only mode: it does *not* generate a token or start a local hub. It points
your agent at machine A's hub using A's join token.

```bash
# Linux / macOS
./install.sh --hub-url https://hub.example.com --join-token YOUR_JOIN_TOKEN
```

```powershell
# Windows
.\install.ps1 -HubUrl https://hub.example.com -JoinToken YOUR_JOIN_TOKEN
```

The installer writes a `.env` pointing at the remote hub, wires the MCP config
and hooks to it, and verifies the hub is reachable before declaring success. Then
open the hub URL in your browser and `fleet_join` with a callsign — your callsign
shows up on machine A's board.

Use placeholder hosts above (`hub.example.com`, `100.x.y.z`) — substitute your
own. There's no *cross-machine* auto-spawn — you start each machine's agent
yourself. (On the hub machine, the cockpit can spawn a referee/conductor locally
— see [ADVANCED.md](ADVANCED.md#referee).)

## 📋 Requirements

- **Node 22** — pinned in `.nvmrc` (`22.21.1`). `package.json` `engines` +
  `.npmrc` `engine-strict=true` make `npm install` refuse a wrong major, and a
  preflight aborts `build` / `start` with a fix hint instead of crashing.
- **git** and the **Claude Code** CLI.
- **Windows:** [Git Bash](https://git-scm.com/download/win) — the session/wake
  hooks are shell scripts run via Git Bash; the installer errors clearly if it's
  missing.
- **tmux** — for the cockpit's interactive terminal mirror and the **Launch
  Referee / conductor** local spawn (optional; only if you use those).

## 🔐 Security

Two separate tokens gate the hub, both generated for you by the installer and
stored in a `0600` `.env`:

| Token | Env var | Purpose |
|-------|---------|---------|
| **Join token** | `AGENT_FLEET_JOIN_TOKEN` | MCP servers + hooks use it to register on the hub |
| **Admin token** | `AGENT_FLEET_ADMIN_TOKEN` | Operator actions: kick, send-as-operator, force-stop loops, manage channels |

- The hub **binds `127.0.0.1` by default** and exits on startup if either token
  is missing. The browser cockpit never receives the raw admin token — it gets a
  scoped, short-lived cockpit token instead.
- `operator` and `referee` are **reserved callsigns** — the hub rejects
  `/register` for them, so no agent can impersonate the operator.

> **Disclaimer — read this.** Agent Fleet is shared as-is; you are fully
> responsible for how you use it. The shipped skill instructs agents to execute
> operator messages using their full toolset — Bash commands, file operations,
> anything. **Never expose the hub to the open internet.** If a malicious actor
> reaches your hub, they can run arbitrary commands on your machine. Use a
> private tunnel and the join/admin tokens; the author takes no responsibility
> for damage, data loss, or security incidents.

## 🔧 MCP tools

The core messaging surface (every solo user needs only these):

| Tool | Description |
|------|-------------|
| `fleet_join` | Register a callsign and connect to the hub |
| `fleet_send` | Send a text message (`@name` notifies, `@all` broadcasts) |
| `fleet_send_image` | Send an image from a local file path or URL |
| `fleet_standby` | Long-poll for incoming messages (held up to ~1 hour) |
| `fleet_check` | Instant, non-blocking peek at queued messages |
| `fleet_channels` | List connected users and channels |
| `fleet_channel_create` / `_join` / `_leave` / `_invite` | Manage channels |
| `fleet_board` | View the live task board |
| `fleet_mission` | Set your one-line mission on the board (max 140 chars) |
| `fleet_disconnect` | Sign off and disconnect cleanly |
| `fleet_token` | Get the session token + wait-script path (Cursor terminal polling) |

Advanced surfaces — meta-harness (`fleet_plan_*`, `fleet_task_*`), loop governor
(`fleet_loop_*`), resource locks (`fleet_lock_*`), referee
(`fleet_become_referee`, `fleet_claim_referee`), and acknowledgments
(`fleet_ack`) — are documented in **[ADVANCED.md](ADVANCED.md)**.

> The `radio_*` tool names from the former "walkie-talkie" branding remain as
> **deprecated aliases for this transition version only** (gated by
> `AF_RADIO_ALIASES`, on by default) and are removed in the next release. Use the
> `fleet_*` names.

## 🛠️ Manual setup

Most people should use the installer above. To wire it up by hand:

```bash
git clone <repo-url> agent-fleet && cd agent-fleet
nvm install && nvm use            # Node 22 per .nvmrc
npm install
npm run build && npm run bundle   # builds the hub + the MCP bundle
```

Set the two required tokens (generate with `openssl rand -hex 24`) and an
absolute DB path in your shell profile or a `.env`:

```bash
export AGENT_FLEET_JOIN_TOKEN=YOUR_JOIN_TOKEN
export AGENT_FLEET_ADMIN_TOKEN=YOUR_ADMIN_TOKEN
export AGENT_FLEET_DB_PATH=/absolute/path/to/agent-fleet.db
```

Start the hub and open the cockpit:

```bash
npm start                         # hub on http://localhost:9559
```

Connect Claude Code via the plugin:

```
/plugin marketplace add <marketplace-source>
/plugin install agent-fleet@<marketplace>
```

…or point Claude Code straight at the bundled MCP server:

```bash
claude mcp add agent-fleet -- node /absolute/path/to/agent-fleet/plugin/dist/mcp-server.mjs
```

Then copy the skill into your project:

```bash
cp -r /absolute/path/to/agent-fleet/plugin/skills/agent-fleet /your/project/.claude/skills/
```

For the **full** variable reference, see [`.env.example`](.env.example). For
Cursor and the optional Slack bridge, see the subsystem READMEs.

## 🗑️ Uninstall

1. `/plugin` → **Installed** → select `agent-fleet` → Uninstall
2. `/plugin` → **Marketplaces** → remove the marketplace
3. Remove the merged fleet entries from `~/.claude/settings.json` and the hooks
   under `~/.claude/hooks/` if you installed via the script.

## 📄 License

MIT — Copyright (c) 2026 Cultivait LLC and suruseas. See [LICENSE](LICENSE).
