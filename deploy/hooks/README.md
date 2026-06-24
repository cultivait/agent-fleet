# Operational hook scripts (version-controlled snapshot)

These are **verbatim snapshots** of the Claude Code hook scripts that run the
meta-harness coordination layer. They execute from each node's Claude home
(`~/.claude/hooks/`), which is **not** part of this repo — so a node loss (or a
fresh node bring-up) would otherwise lose them. This directory version-controls
the canonical copies; it is a snapshot for disaster-recovery + onboarding, not
the live execution path.

> **Source of truth at snapshot time:** `~/.claude/hooks/` on the Linux node.
> Snapshotted at commit-time on branch `wip/w4-ef` (Wave-4, task `(e)`).
> If you edit the live copy, re-snapshot here so the two don't drift.

## Files

| File | Role | Hub endpoint(s) |
|------|------|-----------------|
| `fleet-taskboard.js` | Feeds the hub's live per-agent **task board** (todos, harness tasks, activity heartbeat, subagent count, idle/sign-off). Pure plumbing — the model never calls it. | `POST /board-update` |
| `wt-lease-guard.js` | **C4 resource-lock guard** (PreToolUse, **fail-open**). Blocks `Edit`/`Write`/`Bash` against a guarded surface unless this session holds an active resource lock for it. | `GET /resource-lock-get` |
| `agent-fleet-sessionstart.sh` | **WS1 SessionStart self-register** (Linux). Computes/pins the callsign + injects the on-air context (as before), and now also self-registers this session's identity into the hub registry. Fire-and-forget, silent if the hub is down. | `GET /users`, `POST /session-register` |
| `wt-context-gauge.cjs` | **WS2 gauge producer** (Linux, PostToolUse, **fire-and-forget**). Computes this session's live context occupancy from its transcript (`input + cache_creation + cache_read`, backward-scan to the last assistant-with-usage line, excludes subagents) and POSTs it as `context_tokens` + a `context_ts` freshness-ts, so the conductor can see who is nearing the ≥400k compaction threshold. `.cjs` so it stays CommonJS under the repo's `"type":"module"`. | `POST /session-register` |

The `.js`/`.cjs` files are Node scripts (`#!/usr/bin/env node`), require Node ≥18
(global `fetch`, `AbortSignal.timeout`), and must be executable (`chmod +x`).

## Installed path

```
~/.claude/hooks/fleet-taskboard.js
~/.claude/hooks/wt-lease-guard.js
```

`fleet-taskboard.js` keeps small state files under `~/.claude/hooks/state/`
(`callsign-<sid>.txt`, `subagents-<sid>.txt`, `board-activity-<sid>`) and reads
the harness task store at `~/.claude/tasks/session-<first8>/` (newer Claude
Code) or `~/.claude/tasks/<sid>/` (older). On Linux it also reads the callsign
from `/tmp/wt-callsign-<sid>`.

## settings.json wiring

Registered in `~/.claude/settings.json` under `"hooks"` (live wiring on the
Linux node at snapshot time):

| Event | matcher | command | timeout |
|-------|---------|---------|---------|
| `PreToolUse` | `Edit\|Write\|Bash` | `wt-lease-guard.js` | 3 |
| `PreToolUse` | `Agent\|Task` | `fleet-taskboard.js` | 10 |
| `PostToolUse` | _(none — all tools)_ | `fleet-taskboard.js` | 10 |
| `PostToolUse` | _(none — all tools)_ | `wt-context-gauge.cjs` | 5 |
| `SubagentStop` | _(none)_ | `fleet-taskboard.js` | 10 |
| `Stop` | _(none)_ | `fleet-taskboard.js` | 10 |

`wt-context-gauge.cjs` is a **second** `PostToolUse` catch-all (no matcher),
co-resident with `fleet-taskboard.js`. One catch-all satisfies the frozen
contract's "fire on BOTH per-standby AND PostToolUse": `PostToolUse` fires after
*every* tool, and `fleet_standby` is itself a tool — so a heads-down agent that
climbs toward 400k between standbys is re-gauged on each tool call, and a polling
agent is re-gauged each standby. No dedicated standby event is needed.

`fleet_join` / `fleet_disconnect` board events are handled inside `fleet-taskboard.js`
by matching the tool name in the `PostToolUse` catch-all (no dedicated matcher).
The guarded-surface list is supplied via the `WT_GUARDED_SURFACES` env var in the
settings `"env"` block (see below), not in the matcher.

> Co-located in the same settings (not snapshotted here, different owners):
> `wt-lease-guard.js` shares the `Edit|Write|Bash` PreToolUse slot ordering with
> `block-destructive.py`; `fleet-plan-heartbeat.js`, `agent-fleet-msgcheck.sh`,
> `agent-fleet-tabtitle.sh`, and `agent-fleet-rewake.sh` are separate hooks.

## Required environment

Set in the settings `"env"` block (or the process env). The rebranded hooks read
the new `AGENT_FLEET_*` / `AF_*` names **first** and fall back to the legacy
`WALKIE_TALKIE_*` / `WT_*` names, so an env block carrying either set works during
the transition.

| Var | Used by | Purpose |
|-----|---------|---------|
| `AGENT_FLEET_JOIN_TOKEN` (legacy `WALKIE_TALKIE_JOIN_TOKEN`) | both | Bearer auth to the hub. **No token → both scripts no-op silently** (board) / fail-open (guard). |
| `AGENT_FLEET_HUB_URL` (legacy `WALKIE_TALKIE_HUB_URL`, or `HUB_URL`) | both | Hub base URL. Default `http://localhost:9559`. |
| `WT_GUARDED_SURFACES` | guard | JSON array of `{ "pattern": "<literal path prefix>", "resource_key": "<key>" }`. Empty/malformed → guard no-ops (fail-open). |
| `AF_NODE_NAME` (legacy `WT_NODE_NAME`) | board | Node label (`linux`/`mac`/`windows`). Defaults from `process.platform`. |
| `AF_BOARD_INTERVAL` (legacy `WT_BOARD_INTERVAL`) | board | Activity-heartbeat throttle seconds (default 15). |
| `AGENT_FLEET_JOIN_TOKEN`, `AGENT_FLEET_HUB_URL` (legacy `WALKIE_TALKIE_*`) | gauge | Same as board — no token → gauge no-ops silently. |
| `WT_SPAWN_ID` | gauge | Launcher-injected restart-stable id. Optional — when set, the gauge POST carries it so the gauge-only write merges onto the launcher/hook-seeded row; absent (human session) → keys on `session_id` alone. |

## Install (per node)

```sh
cp deploy/hooks/fleet-taskboard.js ~/.claude/hooks/fleet-taskboard.js
cp deploy/hooks/fleet-plan-heartbeat.js ~/.claude/hooks/fleet-plan-heartbeat.js
cp deploy/hooks/agent-fleet-sessionstart.sh ~/.claude/hooks/agent-fleet-sessionstart.sh
cp deploy/hooks/agent-fleet-msgcheck.sh ~/.claude/hooks/agent-fleet-msgcheck.sh
cp deploy/hooks/agent-fleet-rewake.sh ~/.claude/hooks/agent-fleet-rewake.sh
cp deploy/hooks/agent-fleet-tabtitle.sh ~/.claude/hooks/agent-fleet-tabtitle.sh
cp deploy/hooks/wt-lease-guard.js  ~/.claude/hooks/wt-lease-guard.js
cp deploy/hooks/wt-context-gauge.cjs ~/.claude/hooks/wt-context-gauge.cjs
chmod +x ~/.claude/hooks/fleet-taskboard.js ~/.claude/hooks/fleet-plan-heartbeat.js ~/.claude/hooks/agent-fleet-sessionstart.sh ~/.claude/hooks/agent-fleet-msgcheck.sh ~/.claude/hooks/agent-fleet-rewake.sh ~/.claude/hooks/agent-fleet-tabtitle.sh ~/.claude/hooks/wt-lease-guard.js ~/.claude/hooks/wt-context-gauge.cjs
```

`wt-context-gauge.cjs` is **deploy-gated** like the others: only install + wire it
once the hub's `POST /session-register` accepts `context_tokens` + `context_ts`
(this WS2 build). Fire-and-forget and silent on failure, so a premature install
won't break any tool call — it just won't post a gauge until the endpoint exists.
Its pure core is unit-tested standalone: `node --test deploy/hooks/wt-context-gauge.test.cjs`.

`agent-fleet-sessionstart.sh` is **deploy-gated** like `wt-lease-guard.js`: only
copy it to the live `~/.claude/hooks/` once the hub's `POST /session-register`
endpoint is live (WS1 deploy). The registration block is fire-and-forget and
silent on failure, so a premature install won't break session start — it just
won't register until the endpoint exists. (Its `SessionStart` wiring already
exists in `settings.json`; this snapshot only adds the registration POST to the
existing live script.)

Then add the `settings.json` wiring above and the env vars. `wt-lease-guard.js`
is **deploy-gated**: only install it once the hub's C4 resource-lock endpoint
(`/resource-lock-get`) is live. It fails open, so a premature install won't
block work — it just won't guard.

## Note — duplicate of `wt-lease-guard.js`

A byte-identical `wt-lease-guard.js` is already committed at the repo at
`deploy/wt-lease-guard.js` (root of `deploy/`, present at `cac6263`). This
`deploy/hooks/` directory is the consolidated home for both guard hooks; the
root copy is **superseded** by this one. Removing the root `deploy/wt-lease-guard.js`
is left as a follow-up — this task (`(e)`) is pure-add and does not edit/delete
existing tracked files. Until then, treat `deploy/hooks/wt-lease-guard.js` as
canonical.
