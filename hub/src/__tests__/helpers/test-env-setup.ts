// Vitest setupFile — runs in every test worker BEFORE any test module is imported.
//
// WHY THIS EXISTS:
// The prod hub and every spawned builder shell export
//   AGENT_FLEET_DB_PATH=/var/lib/storage/agent-fleet/agent-fleet.db
// (persisted in ~/.pm2/dump.pm2 and inherited by every Claude Code session that runs
// `vitest`). db.ts resolves the DB as
//   AGENT_FLEET_DB_PATH ?? WALKIE_TALKIE_DB_PATH ?? <cwd>/agent-fleet.db
// but the test suite only ever sets the LEGACY var (WALKIE_TALKIE_DB_PATH=":memory:").
// Because AGENT_FLEET_DB_PATH has higher precedence and is present in the environment,
// the suite's :memory: was silently ignored and every initDB() opened the PROD store —
// re-seeding junk channels/board rows on each run, which is why manual purges never
// stuck.
//
// THE FIX: strip BOTH inherited DB-path vars from the test process up front, then force
// the canonical in-memory default. Individual tests still override this (db-migration
// points at its own os.tmpdir() files), but no test can ever inherit a real shared path.
delete process.env.AGENT_FLEET_DB_PATH;
delete process.env.WALKIE_TALKIE_DB_PATH;
process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
