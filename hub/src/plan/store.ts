// Meta-harness plan core — data layer (Option-C cleanly-bounded module).
// Owns the project/task graph tables + typed accessors. Receives the shared
// better-sqlite3 handle from initDB() (one-directional import; no circular dep
// on db.ts). If the fleet ever outgrows one box, this module lifts into a
// standalone orchestrator (Option B) without touching the comms core.
//
// SINGLE-WRITER INVARIANT (D1): this store assumes exactly ONE synchronous
// Node.js process issues writes. Correctness of compound mutations (transitionTask,
// claimTask, reclaimExpiredLeases and their cascades) depends on better-sqlite3's
// synchronous execution — no await, no connection pool, no worker threads. A
// multi-process fleet (e.g. a rolling deploy with two hub instances) must migrate
// to Postgres with row-level locks before relaxing this invariant.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ProjectRow {
  id: string;
  title: string;
  brief: string | null;
  status: string; // active | paused | done | abandoned
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null; // decomposition tree (subagent rows); orthogonal to deps
  title: string;
  detail: string | null;
  status: string; // see state machine (later cycle)
  owner: string | null;
  owner_sid: string | null;
  priority: number; // 0 critical .. 4 someday
  artifacts: string | null; // JSON array of { kind, uri, note }
  created_by: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  done_at: number | null;
  lease_expires_at: number | null; // server-clock ms; set on claim, renewed by heartbeat, cleared on release/reclaim
  rollup_signaled: number; // D3: 1 = parent rollup event already emitted (idempotent guard)
}

export interface TaskEventRow {
  id: number;
  task_id: string;
  ts: number;
  actor: string | null;
  kind: string; // create | transition | claim | comment | artifact | decompose
  from_status: string | null;
  to_status: string | null;
  note: string | null;
}

let db: Database.Database;

export function initPlanSchema(database: Database.Database): void {
  db = database;

  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      brief TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS task (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES task(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      owner TEXT,
      owner_sid TEXT,
      priority INTEGER NOT NULL DEFAULT 2,
      artifacts TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      claimed_at INTEGER,
      done_at INTEGER,
      lease_expires_at INTEGER,
      rollup_signaled INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_project_status ON task (project_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_parent ON task (parent_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      actor TEXT,
      kind TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      note TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_event_task ON task_event (task_id, id)`);
  // D3: covering index for kind-filtered reads (e.g. WHERE kind='handoff') and rollup guard
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_event_kind ON task_event (task_id, kind, id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dep (
      task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      blocks_on TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, blocks_on)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_dep_blocks_on ON task_dep (blocks_on)`);

  // For existing DBs created before FKs were added: SQLite cannot ALTER TABLE
  // ADD CONSTRAINT, so we rebuild the three plan tables in-place.
  migratePlanTablesAddFKs(db);

  // D3: idempotent migration — add rollup_signaled to existing DBs that were
  // created before this column existed.
  try {
    db.exec("ALTER TABLE task ADD COLUMN rollup_signaled INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
}

// Idempotent migration: adds FK constraints to existing plan tables that were
// created without them. Guarded by a foreign_key_list check so it's a no-op on
// fresh DBs (where CREATE TABLE IF NOT EXISTS already wrote the FK clauses).
function migratePlanTablesAddFKs(database: Database.Database): void {
  const hasFKs = (database.pragma("foreign_key_list(task)") as unknown[]).length > 0;
  if (hasFKs) return;

  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      // ── task ──────────────────────────────────────────────────────────────
      database.exec(`ALTER TABLE task RENAME TO _task_old`);
      database.exec(`
        CREATE TABLE task (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES task(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          detail TEXT,
          status TEXT NOT NULL DEFAULT 'proposed',
          owner TEXT,
          owner_sid TEXT,
          priority INTEGER NOT NULL DEFAULT 2,
          artifacts TEXT,
          created_by TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          claimed_at INTEGER,
          done_at INTEGER,
          lease_expires_at INTEGER,
          rollup_signaled INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Explicit column list — old table may lack rollup_signaled; supply 0 for all rows.
      database.exec(`
        INSERT INTO task
          (id, project_id, parent_id, title, detail, status, owner, owner_sid, priority,
           artifacts, created_by, created_at, updated_at, claimed_at, done_at, lease_expires_at,
           rollup_signaled)
        SELECT id, project_id, parent_id, title, detail, status, owner, owner_sid, priority,
               artifacts, created_by, created_at, updated_at, claimed_at, done_at, lease_expires_at,
               0
        FROM _task_old
      `);
      database.exec(`DROP TABLE _task_old`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_task_project_status ON task (project_id, status)`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_task_parent ON task (parent_id)`);

      // ── task_event ────────────────────────────────────────────────────────
      database.exec(`ALTER TABLE task_event RENAME TO _task_event_old`);
      database.exec(`
        CREATE TABLE task_event (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
          ts INTEGER NOT NULL,
          actor TEXT,
          kind TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT,
          note TEXT
        )
      `);
      database.exec(`INSERT INTO task_event SELECT * FROM _task_event_old`);
      database.exec(`DROP TABLE _task_event_old`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_task_event_task ON task_event (task_id, id)`);

      // ── task_dep ──────────────────────────────────────────────────────────
      database.exec(`ALTER TABLE task_dep RENAME TO _task_dep_old`);
      database.exec(`
        CREATE TABLE task_dep (
          task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
          blocks_on TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
          PRIMARY KEY (task_id, blocks_on)
        )
      `);
      database.exec(`INSERT INTO task_dep SELECT * FROM _task_dep_old`);
      database.exec(`DROP TABLE _task_dep_old`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_task_dep_blocks_on ON task_dep (blocks_on)`);

      // Verify no orphans were carried across; if any exist, throw so the
      // transaction rolls back rather than committing corrupted references.
      const violations = database.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`FK orphans found after plan table rebuild: ${violations.length} violation(s) — rolling back`);
      }
    })();
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

function genId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function createProject(title: string, brief: string | null, by: string | null): ProjectRow {
  const now = Date.now();
  const row: ProjectRow = {
    id: genId("proj"),
    title,
    brief,
    status: "active",
    created_by: by,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO project (id, title, brief, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.title, row.brief, row.status, row.created_by, row.created_at, row.updated_at);
  return row;
}

export function getProject(id: string): ProjectRow | undefined {
  return db.prepare("SELECT * FROM project WHERE id = ?").get(id) as ProjectRow | undefined;
}

// Cascade-delete a project and everything under it. With foreign_keys=ON (set in
// db.ts) a DELETE FROM project removes its tasks (task.project_id ON DELETE
// CASCADE), and each task removal cascades to task_event / task_dep. Returns
// whether a row was removed + the task count that went with it (for the
// operator's confirmation/audit log).
export function deleteProject(id: string): { deleted: boolean; tasks: number } {
  const tasks = (db.prepare("SELECT count(*) AS n FROM task WHERE project_id = ?").get(id) as { n: number }).n;
  const info = db.prepare("DELETE FROM project WHERE id = ?").run(id);
  return { deleted: info.changes > 0, tasks };
}

export function listTasksByProject(projectId: string): TaskRow[] {
  return db.prepare("SELECT * FROM task WHERE project_id = ? ORDER BY created_at").all(projectId) as TaskRow[];
}

// Subtasks of a decomposed parent (parent roll-up). Orthogonal to deps.
export function listChildren(parentId: string): TaskRow[] {
  return db.prepare("SELECT * FROM task WHERE parent_id = ?").all(parentId) as TaskRow[];
}

export interface LogEventOpts {
  actor?: string | null;
  kind: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  note?: string | null;
}

export function logEvent(taskId: string, opts: LogEventOpts): void {
  db.prepare(
    `INSERT INTO task_event (task_id, ts, actor, kind, from_status, to_status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    Date.now(),
    opts.actor ?? null,
    opts.kind,
    opts.fromStatus ?? null,
    opts.toStatus ?? null,
    opts.note ?? null,
  );
}

export function getTaskEvents(taskId: string): TaskEventRow[] {
  return db.prepare("SELECT * FROM task_event WHERE task_id = ? ORDER BY id").all(taskId) as TaskEventRow[];
}

// Existence check for a task_event of a given kind — backed by idx_task_event_kind
// (D3). Used for one-shot diagnostics that must fire at most once per task (e.g.
// the blocker_wedge surfacing in machine.signalWedgeIfDead).
export function hasEventOfKind(taskId: string, kind: string): boolean {
  return db.prepare("SELECT 1 FROM task_event WHERE task_id = ? AND kind = ? LIMIT 1").get(taskId, kind) !== undefined;
}

// Cockpit project picker: every project, newest first, with its task count.
export interface ProjectListRow extends ProjectRow {
  taskCount: number;
}
export function listProjects(): ProjectListRow[] {
  return db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM task t WHERE t.project_id = p.id) AS taskCount
       FROM project p ORDER BY p.created_at DESC`,
    )
    .all() as ProjectListRow[];
}

// Cockpit Feed backfill: the recent-N events across a project's tasks, returned
// CHRONOLOGICALLY (oldest→newest). Inner query takes the most-recent N by ts DESC
// then the outer re-sorts ASC — the recent-window-chronological shape (mirrors
// dbGetRecentMessages). Must NOT regress to an oldest-N LIMIT.
export function getRecentEvents(projectId: string, limit: number): TaskEventRow[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT e.* FROM task_event e
         JOIN task t ON e.task_id = t.id
         WHERE t.project_id = ?
         ORDER BY e.ts DESC, e.id DESC
         LIMIT ?
       ) ORDER BY ts ASC, id ASC`,
    )
    .all(projectId, limit) as TaskEventRow[];
}

// Durable handoff: structured context left on a task so the next claimant resumes
// without re-deriving. Stored as an append-only task_event (kind="handoff") — no
// separate table; the event log IS the audit trail. `system` marks the synthetic
// handoff the reclaim path leaves on a death-reclaim.
export interface HandoffPayload {
  summary: string;
  next_step?: string | null;
  blockers?: string[];
  system?: boolean;
}

export interface HandoffRecord {
  id: number;
  ts: number;
  actor: string | null;
  summary: string;
  next_step: string | null;
  blockers: string[];
  system: boolean;
}

export function addHandoff(taskId: string, actor: string | null, payload: HandoffPayload): void {
  logEvent(taskId, { actor, kind: "handoff", note: JSON.stringify(payload) });
}

// Parse one handoff row. Returns null on malformed JSON so a single bad row can't
// 500 the whole read (B1 belt-and-suspenders; the WHERE kind='handoff' filter is
// the real guard — other kinds' notes are plain strings that would throw).
function parseHandoffRow(row: TaskEventRow): HandoffRecord | null {
  try {
    const p = JSON.parse(row.note ?? "{}") as HandoffPayload;
    if (typeof p.summary !== "string") return null;
    return {
      id: row.id,
      ts: row.ts,
      actor: row.actor,
      summary: p.summary,
      next_step: p.next_step ?? null,
      blockers: Array.isArray(p.blockers) ? p.blockers : [],
      system: p.system === true,
    };
  } catch {
    return null;
  }
}

export function getHandoffs(taskId: string): HandoffRecord[] {
  const rows = db
    .prepare("SELECT * FROM task_event WHERE task_id = ? AND kind = 'handoff' ORDER BY id")
    .all(taskId) as TaskEventRow[];
  return rows.map(parseHandoffRow).filter((h): h is HandoffRecord => h !== null);
}

// Latest = highest task_event.id among handoffs (B2 — id, never ts; ts can tie).
export function getLatestHandoff(taskId: string): HandoffRecord | null {
  const row = db
    .prepare("SELECT * FROM task_event WHERE task_id = ? AND kind = 'handoff' ORDER BY id DESC LIMIT 1")
    .get(taskId) as TaskEventRow | undefined;
  return row ? parseHandoffRow(row) : null;
}

export interface CreateTaskOpts {
  title: string;
  detail?: string | null;
  parentId?: string | null;
  priority?: number;
  by?: string | null;
}

export function createTask(projectId: string, opts: CreateTaskOpts): TaskRow {
  const now = Date.now();
  const row: TaskRow = {
    id: genId("task"),
    project_id: projectId,
    parent_id: opts.parentId ?? null,
    title: opts.title,
    detail: opts.detail ?? null,
    status: "proposed",
    owner: null,
    owner_sid: null,
    priority: opts.priority ?? 2,
    artifacts: null,
    created_by: opts.by ?? null,
    created_at: now,
    updated_at: now,
    claimed_at: null,
    done_at: null,
    lease_expires_at: null,
    rollup_signaled: 0,
  };
  db.prepare(
    `INSERT INTO task
       (id, project_id, parent_id, title, detail, status, owner, owner_sid, priority, artifacts, created_by, created_at, updated_at, claimed_at, done_at)
     VALUES
       (@id, @project_id, @parent_id, @title, @detail, @status, @owner, @owner_sid, @priority, @artifacts, @created_by, @created_at, @updated_at, @claimed_at, @done_at)`,
  ).run(row);
  logEvent(row.id, { actor: opts.by ?? null, kind: "create", toStatus: "proposed" });
  return row;
}

export function getTask(id: string): TaskRow | undefined {
  return db.prepare("SELECT * FROM task WHERE id = ?").get(id) as TaskRow | undefined;
}

export interface DepRow {
  task_id: string;
  blocks_on: string;
}

export function addDep(taskId: string, blocksOn: string): void {
  db.prepare("INSERT OR IGNORE INTO task_dep (task_id, blocks_on) VALUES (?, ?)").run(taskId, blocksOn);
}

// Prerequisites of a task: the task is blocked until every one of these is done.
export function getBlockers(taskId: string): string[] {
  return (db.prepare("SELECT blocks_on FROM task_dep WHERE task_id = ?").all(taskId) as { blocks_on: string }[]).map(
    (r) => r.blocks_on,
  );
}

export function listDepsByProject(projectId: string): DepRow[] {
  return db
    .prepare(
      `SELECT d.task_id, d.blocks_on FROM task_dep d
       JOIN task t ON t.id = d.task_id
       WHERE t.project_id = ?`,
    )
    .all(projectId) as DepRow[];
}

// Tasks currently in the `ready` state. The hub maintains `ready` as an
// authoritative stored state (machine.ts promoteIfReady/demoteIfBlocked), so
// listing claimable work is a plain read — no on-read recomputation.
export function listReadyStatusTasks(): TaskRow[] {
  return db.prepare("SELECT * FROM task WHERE status = 'ready' ORDER BY priority, created_at").all() as TaskRow[];
}

// Ratified tasks across all projects — the scan surface for the dead-blocker wedge
// audit (Wave-4 d). A ratified task whose blocker is permanently unsatisfiable
// (missing/failed/abandoned) can never auto-promote (machine.allBlockersDone is
// fail-closed), so the hub surfaces it from this set instead of leaving it silent.
export function listRatifiedTasks(): TaskRow[] {
  return db.prepare("SELECT * FROM task WHERE status = 'ratified' ORDER BY priority, created_at").all() as TaskRow[];
}

// Tasks a session actively holds right now — post-claim and non-terminal. The
// board feeder keys off owner_sid (a session), not project, so this is its exact
// question: "what is THIS instance working on?" Released/terminal tasks drop out
// (release clears owner_sid; terminal states aren't listed).
export function listTasksByOwnerSid(ownerSid: string): TaskRow[] {
  return db
    .prepare(
      `SELECT * FROM task WHERE owner_sid = ? AND status IN ('claimed', 'in_progress', 'review', 'blocked')
       ORDER BY priority, created_at`,
    )
    .all(ownerSid) as TaskRow[];
}

// Every task ANY session currently holds, across all projects — the cross-project
// counterpart to listTasksByOwnerSid. The dashboard joins these onto board cards by
// owner_sid (3B), so it needs them all in one read, not a query per session. Newest
// claim first so a card showing one task shows the most recent.
export function listInflightTasks(): TaskRow[] {
  return db
    .prepare(
      `SELECT * FROM task WHERE status IN ('claimed', 'in_progress', 'review', 'blocked')
       ORDER BY claimed_at DESC`,
    )
    .all() as TaskRow[];
}

// Inverse of getBlockers: tasks that declare `taskId` as a prerequisite. Used to
// re-evaluate dependents' readiness when a blocker completes.
export function getDependents(taskId: string): string[] {
  return (db.prepare("SELECT task_id FROM task_dep WHERE blocks_on = ?").all(taskId) as { task_id: string }[]).map(
    (r) => r.task_id,
  );
}

// Lease window in ms (server-clock authority — build flag #4). Read per-call so a
// deploy can tune AF_PLAN_LEASE_SECONDS without a code change. MUST stay ≥ the
// longest single tool/subagent run, or a slow-but-alive owner gets false-reclaimed
// (residual N1; the ownerGate 403 on its return is the safety net).
export function leaseMs(): number {
  return (
    (parseInt(process.env.AF_PLAN_LEASE_SECONDS ?? process.env.WT_PLAN_LEASE_SECONDS ?? "1800", 10) || 1800) * 1000
  );
}

// Atomic claim: flip ready→claimed in a SINGLE conditional UPDATE and stamp the
// lease in the same statement. The race between instances grabbing the same task
// is resolved entirely by `WHERE status='ready'` — exactly one concurrent caller
// sees changes===1, the rest see 0 and must back off. NEVER select-then-update.
export function claimTaskAtomic(taskId: string, owner: string, ownerSid: string | null): boolean {
  const now = Date.now();
  const res = db
    .prepare(
      `UPDATE task SET status = 'claimed', owner = ?, owner_sid = ?, claimed_at = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'ready'`,
    )
    .run(owner, ownerSid, now, now + leaseMs(), now, taskId);
  return res.changes === 1;
}

// Renew/clear a task's lease. Renewal is SLIDING (callers pass now+leaseMs), never
// accumulative — the all-tools heartbeat fires far more often than the window, so
// adding would push expiry indefinitely and wedge a dead instance's task (C1).
export function setLeaseExpiry(taskId: string, expiresAt: number | null): void {
  db.prepare("UPDATE task SET lease_expires_at = ?, updated_at = ? WHERE id = ?").run(expiresAt, Date.now(), taskId);
}

// Expired-but-still-held tasks the lazy sweep should reclaim. Governs ONLY
// claimed + in_progress (the "death mid-work" case). review/blocked are PARKED
// states where the owner is legitimately idle, so they are never lease-reclaimed
// (R1) — stale parked work is surfaced to the operator instead.
export function listExpiredLeases(now: number): TaskRow[] {
  return db
    .prepare(
      `SELECT * FROM task WHERE status IN ('claimed', 'in_progress')
       AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    )
    .all(now) as TaskRow[];
}

export interface Artifact {
  kind: string;
  uri: string;
  note?: string | null;
}

// Append a deliverable to a task's artifacts JSON array; logs an artifact event.
export function addArtifact(taskId: string, art: Artifact, actor: string | null): TaskRow | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  const arr = task.artifacts ? (JSON.parse(task.artifacts) as Artifact[]) : [];
  arr.push({ kind: art.kind, uri: art.uri, note: art.note ?? null });
  db.prepare("UPDATE task SET artifacts = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(arr), Date.now(), taskId);
  logEvent(taskId, { actor, kind: "artifact", note: `${art.kind}:${art.uri}` });
  return getTask(taskId);
}

export interface SetTaskStatusExtra {
  owner?: string | null;
  ownerSid?: string | null;
  claimedAt?: number | null;
  doneAt?: number | null;
  leaseExpiresAt?: number | null;
}

// Low-level status write. Callers (machine.ts) own the legality decision;
// this only persists. updated_at is always bumped.
export function setTaskStatus(id: string, status: string, extra?: SetTaskStatusExtra): void {
  const fields = ["status = ?", "updated_at = ?"];
  const vals: unknown[] = [status, Date.now()];
  if (extra && "owner" in extra) {
    fields.push("owner = ?");
    vals.push(extra.owner ?? null);
  }
  if (extra && "ownerSid" in extra) {
    fields.push("owner_sid = ?");
    vals.push(extra.ownerSid ?? null);
  }
  if (extra && "claimedAt" in extra) {
    fields.push("claimed_at = ?");
    vals.push(extra.claimedAt ?? null);
  }
  if (extra && "doneAt" in extra) {
    fields.push("done_at = ?");
    vals.push(extra.doneAt ?? null);
  }
  if (extra && "leaseExpiresAt" in extra) {
    fields.push("lease_expires_at = ?");
    vals.push(extra.leaseExpiresAt ?? null);
  }
  vals.push(id);
  db.prepare(`UPDATE task SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
}

// Test/diagnostic helper: verify an index exists by name in sqlite_master.
export function dbIndexExists(indexName: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(indexName) !== undefined;
}

// D1: wrap any compound mutation (>1 write) in a single BEGIN/COMMIT block.
// better-sqlite3 uses SAVEPOINTs for nested calls so transitionTask → promoteIfReady
// cascades are safe to nest. Throws propagate as ROLLBACK.
export function planTransaction<T>(fn: () => T): T {
  return db.transaction(fn)() as T;
}

// D3: atomically mark a task's parent rollup as signaled. Must be called inside
// D1's terminal-transition transaction so the flag and the rollup event are atomic.
export function setRollupSignaled(taskId: string): void {
  db.prepare("UPDATE task SET rollup_signaled = 1 WHERE id = ?").run(taskId);
}
