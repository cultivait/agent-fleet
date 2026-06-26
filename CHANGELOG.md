# Changelog

## v1.10.1 (2026-06-26)

### Fixes
- **Terminal reconnect resilience** — the cockpit terminal now tolerates two consecutive missed ping/pong heartbeats before terminating the socket, eliminating false-positive disconnects caused by momentary network hiccups.
- **Orphaned-websocket guards** — message and close handlers from a superseded terminal connection are discarded once a fresh socket is established, preventing a stale handler from triggering a spurious reconnect loop.

## v1.10.0 (2026-06-26)

### Features
- **Self-healing terminals** — cockpit agent terminals auto-reconnect after a hub restart, machine sleep, or network drop, re-attaching the live tmux session with no page refresh.
- **Per-plan delete** — a two-tap "Delete" control on the plan picker removes the selected plan and its tasks (`POST /admin-project-delete`, admin-gated).
- **Board auto-digest** — teammates' findings and progress surface on the shared board automatically: agents append a log entry when a task is finished or blocked (write half), and recent teammate entries ride the session wake hook (read half, `GET /agent-log-digest`).

### Changes
- Removed the built-in sample/demo plan; the cockpit now opens to your first real plan.

## v1.8.0 (2026-06-19)

### Breaking — Rename: Walkie-Talkie → Agent Fleet
The project, plugin/MCP server, tools, hub process, database, config dir, env vars, public URL, hooks, and skills are renamed from the "walkie-talkie"/"radio" brand to **Agent Fleet** / "fleet".

- **Tools:** `radio_*` → `fleet_*` (e.g. `radio_join`→`fleet_join`, `radio_over`→`fleet_send`, `radio_out`→`fleet_disconnect`, `radio_standby`→`fleet_standby`). The `radio_*` names are retained as **deprecated aliases for this transition version only** and are removed in the next release.
- **Plugin / MCP server / npm packages:** `walkie-talkie` → `agent-fleet`, `@walkie-talkie/*` → `@agent-fleet/*`.
- **Env vars:** `WALKIE_TALKIE_*`/`WT_*` → `AGENT_FLEET_*`/`AF_*`. The old names are still read as a fallback for back-compat this transition version.
- **Process / data:** hub `walkie-talkie-hub` → `agent-fleet-hub`; tunnel `walkie-tunnel-win` → `agent-fleet-tunnel-win`; database `walkie-talkie.db` → `agent-fleet.db` (the old file is copied over on first boot if only it exists); config dir `~/.config/walkie-talkie` → `~/.config/agent-fleet`.
- **URL / UI:** your public cockpit URL moves from the old `radio` host to the new `fleet` host; cockpit title → "Agent Fleet".
- **Skills:** `/walkie-talkie` → `/agent-fleet`; `radio-board` → `fleet-board`.


## v1.7.0 (2026-03-09)

### Features
- Add client role (agent/bridge) for relay services (#96)
- Add system notifications for bridge clients (#98)
- Add agent launcher with iTerm2 integration and dashboard UI (#109)
- Add launcher docs to README and handle missing iTerm2 gracefully (#115)

### Fixes
- Fix misleading trigger description in comparison table (#91)
- Use @@ prefix for agent targeting in Slack bot (#103)
- Show @@ prefix in agent reply display name (#105)
- Show user-friendly error when port is already in use (#110)
- Restore terminal to cooked mode on shutdown (#111)
- Remove Claude-specific hints from agent launcher (#113)

### Other
- Add Slack bot integration section to README (#85)
- Add Cursor Automations comparison to README (#87)
- Move slack-bot to subsystems/ and co-launch with npm start (#94)
- Document 'Always Show My Bot as Online' Slack setting (#100)


## v1.6.0 (2026-03-09)

### Features
- Add client role (agent/bridge) for relay services (#96)
- Add system notifications for bridge clients (#98)
- Add agent launcher with iTerm2 integration and dashboard UI (#109)
- Add launcher docs to README and handle missing iTerm2 gracefully (#115)

### Fixes
- Fix misleading trigger description in comparison table (#91)
- Use @@ prefix for agent targeting in Slack bot (#103)
- Show @@ prefix in agent reply display name (#105)
- Show user-friendly error when port is already in use (#110)
- Restore terminal to cooked mode on shutdown (#111)
- Remove Claude-specific hints from agent launcher (#113)

### Other
- Add Slack bot integration section to README (#85)
- Add Cursor Automations comparison to README (#87)
- Move slack-bot to subsystems/ and co-launch with npm start (#94)
- Document 'Always Show My Bot as Online' Slack setting (#100)


## v1.6.0 (2026-03-08)

### Features
- Add client role (agent/bridge) for relay services (#96)
- Add system notifications for bridge clients (#98)

### Fixes
- Fix misleading trigger description in comparison table (#91)

### Other
- Add Slack bot integration section to README (#85)
- Add Cursor Automations comparison to README (#87)
- Move slack-bot to subsystems/ and co-launch with npm start (#94)


## v1.5.0 (2026-03-07)

### Features
- Add Cursor Agent support (#2)
- Highlight operator messages and add filter toggle (#6)
- Add channel support for scoped conversations (#8)
- Allow admin token to be configured via env var (#14)
- Add comparison with multi-agent frameworks to README (#16)
- Add comparison with agent platforms (OpenClaw) to README (#18)
- Add typing indicator and response detection to dashboard (#35)
- Replace dropdown selects with @mention and #channel autocomplete (#42)
- Persist channel membership and auto-rejoin on reconnect (#44)
- Persist channel messages in SQLite and restore on dashboard refresh (#46)
- Move member info from sidebar badge to channel header (#50)
- Rename Stop All to Kick all agents and exclude operator (#52)
- Add image sending from Operator dashboard to Agent (#60)
- Support image sending from Agent to Operator via radio_over (#66)
- Add radio_send_image tool for fast file-based image sending (#68)
- Add Slack bot integration (Socket Mode) (#73)

### Fixes
- Add SSE heartbeat to prevent idle connection drops (#4)
- Remove redundant 'All' entry from channel sidebar (#10)
- Fix channel member count showing incorrect numbers (#12)
- Update README tagline to reflect broader agent support (#20)
- Fix KICK broadcasting RADIO_KILLED to all agents (#23)
- Allow reconnection with the same username (#25)
- Require WALKIE_TALKIE_ADMIN_TOKEN environment variable (#27)
- Show offline status for disconnected agents on dashboard (#29)
- Instruct agents to call radio_out on interrupt (#31)
- Add TYPING step directly into the conversation loop (#37)
- Show typing indicator in message area and fix TYPING response (#39)
- Scope typing indicator to the active channel (#56)
- Fix agent replying in wrong channel (#58)
- Fix image content blocks not reaching Agent via radio_standby (#62)
- Rebuild plugin bundle to include image support in radio_standby (#64)

### Other
- Add /create-pr Claude Code skill (#48)
- Introduce Biome for lint/format and add hub test suite (#54)
- Add Cursor workaround for slash command in README (#71)
- Bump version to v1.4.0 (#74)
- Fix Cursor setup instructions in README (#77)
- Add tests for image sending feature (#79)


## v1.4.0 (2026-03-06)

### Features
- Add Slack bot integration via Socket Mode (#72)
- Add radio_send_image tool for fast file-based image sending (#68)

### Docs
- Add Cursor workaround for slash command in README (#70)

## v1.3.0 (2026-03-05)

### Features
- Add Cursor Agent support (#2)
- Highlight operator messages and add filter toggle (#6)
- Add channel support for scoped conversations (#8)
- Allow admin token to be configured via env var (#14)
- Add comparison with multi-agent frameworks to README (#16)
- Add comparison with agent platforms (OpenClaw) to README (#18)
- Add typing indicator and response detection to dashboard (#35)
- Replace dropdown selects with @mention and #channel autocomplete (#42)
- Persist channel membership and auto-rejoin on reconnect (#44)
- Persist channel messages in SQLite and restore on dashboard refresh (#46)
- Move member info from sidebar badge to channel header (#50)
- Rename Stop All to Kick all agents and exclude operator (#52)
- Add image sending from Operator dashboard to Agent (#60)
- Support image sending from Agent to Operator via radio_over (#66)

### Fixes
- Add SSE heartbeat to prevent idle connection drops (#4)
- Remove redundant 'All' entry from channel sidebar (#10)
- Fix channel member count showing incorrect numbers (#12)
- Update README tagline to reflect broader agent support (#20)
- Fix KICK broadcasting RADIO_KILLED to all agents (#23)
- Allow reconnection with the same username (#25)
- Require WALKIE_TALKIE_ADMIN_TOKEN environment variable (#27)
- Show offline status for disconnected agents on dashboard (#29)
- Instruct agents to call radio_out on interrupt (#31)
- Add TYPING step directly into the conversation loop (#37)
- Show typing indicator in message area and fix TYPING response (#39)
- Scope typing indicator to the active channel (#56)
- Fix agent replying in wrong channel (#58)
- Fix image content blocks not reaching Agent via radio_standby (#62)
- Rebuild plugin bundle to include image support in radio_standby (#64)

### Other
- Add /create-pr Claude Code skill (#48)
- Introduce Biome for lint/format and add hub test suite (#54)


## v1.2.0 (2026-03-04)

### Features
- Add Cursor Agent support (#2)
- Highlight operator messages and add filter toggle (#6)
- Add channel support for scoped conversations (#8)
- Allow admin token to be configured via env var (#14)
- Add comparison with multi-agent frameworks to README (#16)
- Add comparison with agent platforms (OpenClaw) to README (#18)
- Add typing indicator and response detection to dashboard (#35)

### Fixes
- Add SSE heartbeat to prevent idle connection drops (#4)
- Remove redundant 'All' entry from channel sidebar (#10)
- Fix channel member count showing incorrect numbers (#12)
- Update README tagline to reflect broader agent support (#20)
- Fix KICK broadcasting RADIO_KILLED to all agents (#23)
- Allow reconnection with the same username (#25)
- Require WALKIE_TALKIE_ADMIN_TOKEN environment variable (#27)
- Show offline status for disconnected agents on dashboard (#29)
- Instruct agents to call radio_out on interrupt (#31)
- Add TYPING step directly into the conversation loop (#37)


## v1.1.0 (2026-03-03)

### Features
- Add Cursor Agent support (#2)
- Highlight operator messages and add filter toggle (#6)
- Add channel support for scoped conversations (#8)
- Allow admin token to be configured via env var (#14)
- Add comparison with multi-agent frameworks to README (#16)
- Add comparison with agent platforms (OpenClaw) to README (#18)

### Fixes
- Add SSE heartbeat to prevent idle connection drops (#4)
- Remove redundant 'All' entry from channel sidebar (#10)
- Fix channel member count showing incorrect numbers (#12)
