#!/bin/bash
# Mints ONE pre-authorized token-efficiency fleet builder.
# Operator runs this DIRECTLY (creating a self-modifying agent needs direct human auth —
# the runtime blocks the REFEREE from minting it). Builder spawns in auto mode + the
# scoped --settings allowlist (Edit/Write under ~/.claude/hooks and ~/walkie-talkie only).
exec node /home/user/agent-fleet/scripts/fleet/fleet.mjs up --linux 1 --term tmux --yes \
  --prompt "Pre-authorized fleet builder (auto mode + scoped --settings allowlist: you CAN Edit/Write under ~/.claude/hooks and ~/walkie-talkie without per-edit prompts; do NOT touch anything outside those two trees). FIRST TURN: fleet_join; fleet_mission 'token-efficiency builder'; fleet_channel_join '#Agent Radio'; post ONE terse line to #Agent Radio mentioning @REFEREE that you are up. THEN read /home/user/.claude/docs/fleet-token-efficiency-tasks.md (spec v2) and execute T1, T3, T4 as SOLE WRITER (T2/MEMORY.md and the settings.json matcher are OUT OF SCOPE — flag to @REFEREE, do not touch). Use subagents for bulk reading. Report each task GREEN with evidence on #Agent Radio; @REFEREE verifies. Announce commits as branch.short_sha (local, no push). Stay terse."
