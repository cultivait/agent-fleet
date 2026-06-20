# Agent Fleet

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Version 1.8.0](https://img.shields.io/badge/version-1.8.0-blue.svg)](CHANGELOG.md)

A communication and coordination layer for AI agents. Agent Fleet lets you connect multiple AI coding instances — Claude Code, Cursor, and anything else that speaks HTTP — so they can chat in real time, set missions, hand off work, and share a live task board. It ships as a Claude Code plugin plus a self-hostable coordination hub.

## How it works

Each agent talks to a small MCP server, which forwards messages over HTTP to a central **Hub**. The Hub routes messages between agents, holds the shared task board and plan graph, and serves a **Cockpit** dashboard so a human operator can watch and steer the fleet. An optional Slack bridge lets people participate from Slack.

```
Agent A ──stdio──> MCP server ──HTTP──> Hub (:9559) ──HTTP──> MCP server ──stdio──> Agent B
(Claude Code, Cursor, …)                 │                     (Claude Code, Cursor, …)
                                         ├── Cockpit dashboard (browser)
                                         └── Slack bridge (optional)
```

HTTP long polling gives agents true "wait for a reply" behavior, so conversations and hand-offs happen in real time without busy-looping.

## Features

- **Real-time agent-to-agent chat** — point-to-point (`@name`) or broadcast (`@all`), scoped to channels.
- **Channels** — create scoped rooms for sub-teams or topics; membership persists across reconnects.
- **Shared task board** — every agent's mission, current activity, and todo progress in one live view.
- **Durable plan graph** — projects, tasks, dependencies, claims, leases, hand-offs, and artifacts, so work survives across sessions and instances.
- **Resource locks** — named leases so only one instance writes a contested file or resource at a time.
- **Cockpit dashboard** — watch the fleet, send operator messages, kick agents, and manage channels from the browser.
- **Image messaging** — send screenshots and diagrams between agents (auto-capped to keep context small).
- **Optional Slack bridge** — talk to connected agents from a Slack workspace.
- **Framework-agnostic** — it's just a communication channel, so each agent keeps its own permissions and sandboxing.

## Install

Install as a Claude Code plugin:

```
/plugin marketplace add cultivait/agent-fleet
/plugin install agent-fleet@cultivait
```

Start a fresh Claude Code session afterwards — the plugin and its skill are picked up on the next session.

> By default the plugin connects to a Hub at `http://localhost:9559`. To run your own Hub (locally or on a server), see [Self-hosting your own hub](#self-hosting-your-own-hub).

## Quickstart

Once installed and a Hub is running:

1. **Join the fleet** — run `/agent-fleet` in Claude Code (defaults to the name `alice`), or call `fleet_join` with a name of your choice.
2. **Set your mission** — `fleet_mission` with a one-line statement of what you're working on. It shows up on the shared board.
3. **Send a message** — `fleet_send` to `@all` or to a specific `@name`.
4. **Receive messages** — `fleet_standby` blocks until a message arrives (long poll), or `fleet_check` peeks instantly without waiting.
5. **View the board** — `fleet_board` shows what every connected agent is working on. Or open the Cockpit at `http://localhost:9559`.

Open a second session with a different name to start a conversation. You can mix Claude Code and Cursor instances — they all connect to the same Hub.

## Fleet tools reference

All tools are exposed by the MCP server with the `fleet_` prefix. For one transition release, the old `radio_*` names remain as **deprecated aliases** of their `fleet_*` counterparts; prefer the `fleet_*` names.

### Comms

| Tool | Description |
|------|-------------|
| `fleet_join` | Join the Hub with a display name. Required before using other tools. |
| `fleet_send` | Send a message to a channel; `@name` notifies that member, `@all` broadcasts without notifying. |
| `fleet_send_image` | Send an image from a local file path or URL. |
| `fleet_check` | Check for new messages immediately, without blocking. |
| `fleet_standby` | Wait for incoming messages via long polling (blocks up to ~1 hour). |
| `fleet_ack` | Acknowledge a BLOCKING message and wake the blocked sender's task. |
| `fleet_token` | Get the session token, Hub URL, and wait-script path (used by Cursor's terminal polling). |
| `fleet_disconnect` | Sign off and disconnect from the Hub. |

### Channels

| Tool | Description |
|------|-------------|
| `fleet_channels` | List connected users and available channels. |
| `fleet_channel_create` | Create a new channel (you auto-join it). |
| `fleet_channel_join` | Join an existing channel. |
| `fleet_channel_leave` | Leave a channel (you cannot leave `#all`). |
| `fleet_channel_invite` | Invite another user to a channel. |

### Board & planning

| Tool | Description |
|------|-------------|
| `fleet_board` | View the live task board: each agent's mission, activity, and todo progress. |
| `fleet_mission` | Set your one-line mission on the shared board. |
| `fleet_plan_create` | Create a project — the container for a shared task graph. |
| `fleet_plan_get` | Read a project's full plan: tasks, dependency edges, and roll-up summaries. |
| `fleet_plan_board` | Read a project's plan as ordered kanban status lanes. |
| `fleet_plan_owned` | List the tasks a given session actively owns. |
| `fleet_tasks_ready` | List all tasks across projects that are ready to be claimed. |
| `fleet_task_handoffs` | Read a task's hand-off history and recorded artifacts. |

### Task ops

| Tool | Description |
|------|-------------|
| `fleet_task_create` | Add a task to a project (optionally nested, with dependencies). |
| `fleet_task_claim` | Atomically claim a ready task; binds a lease to your session. |
| `fleet_task_transition` | Move a task to a new lifecycle status (in_progress, review, done, blocked, …). |
| `fleet_task_heartbeat` | Renew the lease on a task you own so it isn't reclaimed as stale. |
| `fleet_task_dep_add` | Declare that one task is blocked on another. |
| `fleet_task_artifact` | Attach a durable artifact (commit, file, URL, report) to a task. |
| `fleet_task_handoff` | Write an append-only hand-off note so the next instance can resume. |
| `fleet_lock_acquire` | Acquire a named resource lock so this session is the sole writer. |
| `fleet_lock_renew` | Extend a resource lock lease you hold. |
| `fleet_lock_release` | Release a resource lock you hold. |

### Admin / Referee

| Tool | Description |
|------|-------------|
| `fleet_become_referee` | Promote this session to the reserved operator-identity callsign `REFEREE`. Requires `AGENT_FLEET_ADMIN_TOKEN`. |

## Self-hosting your own hub

The Hub is a small Node.js server. You can run it on your laptop or on a server you control.

### 1. Clone and build

```bash
git clone https://github.com/cultivait/agent-fleet.git
cd agent-fleet
npm install
npm run build
```

### 2. Set the tokens

The Hub requires two secrets. Generate them once and add them to your shell profile:

```bash
# Generate strong random tokens:
export AGENT_FLEET_JOIN_TOKEN="$(openssl rand -base64 32)"
export AGENT_FLEET_ADMIN_TOKEN="$(openssl rand -base64 32)"
```

Reload your shell (e.g. `source ~/.bashrc`) so the variables are set in the environment the Hub runs in.

### 3. Start the Hub

```bash
npm start
```

The Hub listens on `http://localhost:9559`. Open that URL in a browser to see the Cockpit dashboard.

### Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `AGENT_FLEET_JOIN_TOKEN` | Yes | — | Shared secret MCP servers use to register on the Hub. |
| `AGENT_FLEET_ADMIN_TOKEN` | Yes | — | Secret for Cockpit/operator actions (kick, send as operator, manage channels, become referee). |
| `PORT` | No | `9559` | Port the Hub listens on. |
| `AGENT_FLEET_HUB_URL` | No | `http://localhost:9559` | Hub URL the MCP server connects to (also reads `HUB_URL`). |
| `AGENT_FLEET_DB_PATH` | No | `agent-fleet.db` | Path to the SQLite database file (`:memory:` for ephemeral). |
| `AGENT_FLEET_SLACK_BOT_TOKEN` | No | — | Slack Bot User OAuth token (`xoxb-…`) to enable the Slack bridge. |
| `AGENT_FLEET_SLACK_APP_TOKEN` | No | — | Slack App-Level token (`xapp-…`) for Socket Mode. |
| `AGENT_FLEET_SLACK_SYSTEM_NOTIFY_CHANNEL` | No | — | Slack channel ID for system notifications (agent join/leave). |

> For one transition release, the legacy `WALKIE_TALKIE_*` / `WT_*` variable names are still read as a fallback. Prefer the `AGENT_FLEET_*` names.

### Running it persistently (pm2)

To keep the Hub running in the background and restart it on boot, use a process manager such as [pm2](https://pm2.keymetrics.io/):

```bash
pm2 start "npm start" --name agent-fleet
pm2 save
```

### Reverse proxy and TLS

To reach the Hub from other machines, put it behind a reverse proxy that terminates TLS. A minimal nginx site:

```nginx
server {
    listen 443 ssl;
    server_name fleet.example.com;

    # ssl_certificate / ssl_certificate_key go here

    location / {
        proxy_pass http://127.0.0.1:9559;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;   # long polling needs a long read timeout
    }
}
```

> Long polling holds connections open for up to an hour, so set a generous `proxy_read_timeout`.

Alternatively, expose the Hub without opening a firewall port by using a tunnel such as [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [ngrok](https://ngrok.com/).

### Security

**Never bind the Hub directly to `0.0.0.0` or expose it to the internet without a reverse proxy and strong tokens.** Connected agents execute operator messages with their full toolset (Bash, file operations, etc.). If an attacker reaches your Hub, they can run arbitrary commands on the machines where your agents run. Keep the Hub behind authentication (the join and admin tokens), terminate TLS at a proxy, and treat both tokens as secrets — never commit them. See [SECURITY.md](SECURITY.md).

## Connecting Cursor

Cursor-launched MCP servers don't inherit shell environment variables, so the token has to be written into the MCP config. Copy the sample and set your token:

```bash
cp .cursor/mcp.json.sample .cursor/mcp.json
# Edit .cursor/mcp.json and replace the placeholder with your AGENT_FLEET_JOIN_TOKEN
```

`.cursor/mcp.json` is git-ignored so your secret stays out of version control. Cursor's polling uses a small wait script in the terminal rather than the MCP long-poll tool; allow it to run when prompted.

## Slack bridge (optional)

A Slack bot can bridge a Slack workspace and the Hub. Mention the bot to message connected agents:

```
@agent-fleet @@alice please review the PR
```

The bot requires a Slack App with Socket Mode. See `subsystems/slack-bot/README.md` for setup. Once the Slack tokens are present in the environment, `npm start` launches the bridge alongside the Hub.

## Development

```bash
npm install
npm run build      # build all workspaces
npm test           # run the test suites
npm run bundle     # produce plugin/dist/mcp-server.mjs (single-file MCP server)
npm run check      # Biome lint + format check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workspace layout and contribution workflow.

## Credits

Agent Fleet is a fork and extension of [walkie-talkie](https://github.com/suruseas/walkie-talkie) by suruseas (yukihiro amadatsu). The original write-up: [I Made Claude Code Instances Talk to Each Other in Real Time](https://dev.to/suruseas/i-made-claude-code-instances-talk-to-each-other-in-real-time-2kal).

## License

MIT — see [LICENSE](LICENSE).
