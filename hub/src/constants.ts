// Shared hub constants — single source of truth for values that were otherwise
// duplicated across modules. (C5: the stall-radar threshold had drifted into four
// separate copies; this collapses them to one canonical, env-tunable definition.)

// STALL_BEAT_MS — C5 stall radar. A claimed/in_progress task whose owning session has
// gone quiet (no heartbeat/board-update) for longer than this, WHILE its lease is still
// valid, is a likely dead agent the board would otherwise hide until the lease lapses
// (default 30min). Distinct from — and firing before — the A3 expired-lease reclaim chip.
// Tunable via AF_STALL_BEAT_SECONDS; defaults to 240s (~2x a conservative 2min beat
// cadence) so a single long tool call / blocked subagent doesn't false-alarm.
//
// CANONICAL definition: server.ts and cockpit-lease.ts (the tested pure module) import
// it directly; the two browser copies (cockpit-ui.ts / dashboard.ts) INJECT this value
// into their template strings at build time — browser JS can't import a TS const, but it
// can receive the canonical number, so all four sites stay in lockstep by construction.
export const STALL_BEAT_MS = parseInt(process.env.AF_STALL_BEAT_SECONDS ?? process.env.WT_STALL_BEAT_SECONDS ?? "240", 10) * 1000;
