// Reflexion memory (Phase 5) — per-loop reflection memory persisted across retries.
//
// The hub does NOT run the agent's inner loop (see loops/store.ts). Each iteration the
// agent may record a short reflection ("what went wrong / what to try next"); on the
// next retry the hub feeds the recent reflections back so the agent learns within the
// run. This is the durable, cross-retry half of a Reflexion (Shinn et al.) loop.
//
// BOUNDED BY CONSTRUCTION: reflections are the kind of thing that grows without limit if
// left alone, so two caps are enforced on write — each reflection is truncated to
// MAX_REFLECTION_CHARS, and only the most recent MAX_REFLECTIONS_PER_LOOP rows per loop
// are retained (older ones are pruned in the same transaction as the insert). The DB
// footprint per loop is therefore O(cap), never O(iterations).
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface ReflectionRow {
  id: string;
  loop_id: string;
  agent_callsign: string;
  reflection: string;
  iteration: number | null;
  created_at: number;
}

// Retention caps. Small on purpose: reflexion feedback is most useful when it's the
// recent, salient lessons — not an ever-growing transcript.
export const MAX_REFLECTIONS_PER_LOOP = 25;
export const MAX_REFLECTION_CHARS = 4000;

let db: Database.Database;

export function initReflexionSchema(database: Database.Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_reflections (
      id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      agent_callsign TEXT NOT NULL,
      reflection TEXT NOT NULL,
      iteration INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loop_reflections_loop ON loop_reflections (loop_id, created_at)`);
}

function genId(): string {
  return `refl_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export interface AddReflectionInput {
  loop_id: string;
  agent_callsign: string;
  reflection: string;
  iteration?: number | null;
}

// Append a reflection and prune the loop back to the cap, atomically. Returns the
// retained count for the loop after pruning.
export function addReflection(input: AddReflectionInput): { id: string; count: number } {
  const txn = db.transaction((args: AddReflectionInput) => {
    const id = genId();
    const text = args.reflection.slice(0, MAX_REFLECTION_CHARS);
    db.prepare(
      `INSERT INTO loop_reflections (id, loop_id, agent_callsign, reflection, iteration, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, args.loop_id, args.agent_callsign, text, args.iteration ?? null, Date.now());

    // Prune: keep only the newest MAX_REFLECTIONS_PER_LOOP rows for this loop. Tie-break on
    // the monotonic rowid (insertion order), NOT the random-UUID id — multiple reflections
    // can share a created_at millisecond, and an id tiebreak would prune nondeterministically.
    db.prepare(
      `DELETE FROM loop_reflections
        WHERE loop_id = ?
          AND rowid NOT IN (
            SELECT rowid FROM loop_reflections
             WHERE loop_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
          )`,
    ).run(args.loop_id, args.loop_id, MAX_REFLECTIONS_PER_LOOP);

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM loop_reflections WHERE loop_id = ?").get(args.loop_id) as { n: number }
    ).n;
    return { id, count };
  });
  return txn(input);
}

// Most-recent-first reflections for a loop, capped. The default feedback limit is small
// so a tick response stays lean (it's polled every iteration).
export function listReflections(loopId: string, limit = MAX_REFLECTIONS_PER_LOOP): ReflectionRow[] {
  const n = Math.min(Math.max(limit, 1), MAX_REFLECTIONS_PER_LOOP);
  return db
    .prepare(
      `SELECT id, loop_id, agent_callsign, reflection, iteration, created_at
         FROM loop_reflections WHERE loop_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(loopId, n) as ReflectionRow[];
}

export function countReflections(loopId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM loop_reflections WHERE loop_id = ?").get(loopId) as { n: number }
  ).n;
}
