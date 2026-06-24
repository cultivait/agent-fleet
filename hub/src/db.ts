import { copyFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { initPlanSchema } from "./plan/store.js";
import { initLoopSchema } from "./loops/store.js";
import { initReflexionSchema } from "./loops/reflexion.js";
import { initApprovalSchema } from "./loops/approvals.js";
import type { Message, MessageImage, PendingAckRow, RegistryEntry } from "./types.js";

export interface AgentConfigRow {
  id: string;
  name: string;
  work_dir: string;
  command: string;
  auto_start: number;
  env_vars: string | null;
  created_at: number;
}

export interface ChannelRow {
  name: string;
  created_by: string;
  created_at: number;
}

// Local patch: task board — per-agent live status fed automatically by hooks.
export interface BoardRow {
  name: string;
  node: string | null;
  status: string;
  mission: string | null;
  activity: string | null;
  todos: string | null; // JSON array of { content, status }
  subagents: number; // count of subagents this instance currently has running
  sid: string | null; // owning session id — lets a rename drop its stale card
  updated_at: number;
}

let db: Database.Database;

export function initDB(): void {
  const dbPath =
    process.env.AGENT_FLEET_DB_PATH ??
    process.env.WALKIE_TALKIE_DB_PATH ??
    path.join(process.cwd(), "agent-fleet.db");

  // === TEST SAFETY GUARD — regression-proof test isolation ===
  // Under a test runner the DB must NEVER resolve to a real, shared store — above all
  // the prod hub file. History: the rename added AGENT_FLEET_DB_PATH at HIGHER
  // precedence than the legacy WALKIE_TALKIE_DB_PATH, and the process manager exports the
  // prod path (e.g. /var/lib/agent-fleet/agent-fleet.db) into every builder shell. The test suite
  // only ever neutralizes the LEGACY var (WALKIE_TALKIE_DB_PATH=":memory:"), so the
  // inherited AGENT_FLEET_DB_PATH won this `??` chain and every initDB() opened PROD —
  // re-seeding fixtures into the live store on each `vitest` run. The vitest setupFile
  // now drops the inherited var so :memory: actually takes effect; this guard makes the
  // failure mode IMPOSSIBLE to reintroduce: under VITEST / NODE_ENV=test, the only
  // allowed targets are ":memory:" or a file inside the OS temp dir (where db-migration
  // tests legitimately write). Anything else — the prod DB file, a repo-local
  // agent-fleet.db — throws loudly instead of silently polluting a real database.
  const underTest = Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
  if (underTest && dbPath !== ":memory:") {
    const resolved = path.resolve(dbPath);
    const tmpRoot = path.resolve(os.tmpdir());
    const inTmp = resolved === tmpRoot || resolved.startsWith(tmpRoot + path.sep);
    if (!inTmp) {
      throw new Error(
        `[db] TEST SAFETY GUARD tripped: refusing to open a real DB file while under test.\n` +
          `  resolved path : ${resolved}\n` +
          `  allowed values: ":memory:" or any file inside ${tmpRoot}\n` +
          `  Set WALKIE_TALKIE_DB_PATH=":memory:" (or a temp path) for this test. This guard\n` +
          `  exists because the suite once polluted the PROD hub store when an inherited\n` +
          `  AGENT_FLEET_DB_PATH overrode the test's :memory: setting.`,
      );
    }
  }

  // Agent Fleet rename transition: when resolving the DEFAULT location (no explicit
  // *_DB_PATH override), if the new agent-fleet.db doesn't exist yet but a legacy
  // walkie-talkie.db sits beside it, carry the data over on first boot. Checkpoint the
  // legacy WAL into its main file so a single-file copy is complete, then COPY (never
  // move) — the old file stays put as a rollback safety net for the Lane F cutover.
  if (process.env.AGENT_FLEET_DB_PATH === undefined && process.env.WALKIE_TALKIE_DB_PATH === undefined) {
    const legacyPath = path.join(process.cwd(), "walkie-talkie.db");
    if (!existsSync(dbPath) && existsSync(legacyPath)) {
      const legacy = new Database(legacyPath);
      try {
        legacy.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        legacy.close();
      }
      copyFileSync(legacyPath, dbPath);
      console.log(`[db] Agent Fleet migration: copied legacy ${legacyPath} -> ${dbPath}`);
    }
  }
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      name TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_members (
      channel TEXT NOT NULL,
      user_name TEXT NOT NULL,
      PRIMARY KEY (channel, user_name)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      content TEXT NOT NULL,
      channel TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp
    ON messages (channel, timestamp)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS read_cursors (
      user_name TEXT NOT NULL,
      channel TEXT NOT NULL,
      last_read_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_name, channel)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      work_dir TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      auto_start INTEGER NOT NULL DEFAULT 0,
      env_vars TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // Local patch: task board table
  db.exec(`
    CREATE TABLE IF NOT EXISTS board (
      name TEXT PRIMARY KEY,
      node TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      mission TEXT,
      activity TEXT,
      todos TEXT,
      subagents INTEGER NOT NULL DEFAULT 0,
      sid TEXT,
      updated_at INTEGER NOT NULL
    )
  `);

  try {
    db.exec("ALTER TABLE agent_configs ADD COLUMN env_vars TEXT");
  } catch {
    /* column already exists */
  }

  try {
    db.exec("ALTER TABLE messages ADD COLUMN image TEXT");
  } catch {
    /* column already exists */
  }

  try {
    db.exec("ALTER TABLE board ADD COLUMN subagents INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }

  try {
    db.exec("ALTER TABLE board ADD COLUMN sid TEXT");
  } catch {
    /* column already exists */
  }

  try {
    db.exec("ALTER TABLE messages ADD COLUMN seq INTEGER");
  } catch {
    /* column already exists */
  }

  // === C1: pending_ack — durable table for BLOCKING-message acknowledgement ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_ack (
      msg_id TEXT PRIMARY KEY,
      sender_sid TEXT NOT NULL,
      channel TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // === C1: channel_seq — monotonic per-channel message sequence counter ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_seq (
      channel TEXT PRIMARY KEY,
      seq INTEGER NOT NULL DEFAULT 0
    )
  `);

  // === C4: resource_lock ===
  // Durable resource-lock table. One row per contested surface; the holder's
  // lease_expires_at drives lazy-reclaim (same pattern as task leases).
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_lock (
      resource_key TEXT PRIMARY KEY,
      owner_sid    TEXT NOT NULL,
      lease_expires_at INTEGER NOT NULL
    )
  `);

  // === WS1: session registry ===
  // One logical row per session. session_id is the stable identity (survives
  // /compact, dies on /exit+respawn); spawn_id is the restart-stable slot id that
  // BOTH the launcher and the SessionStart hook carry, so their two PARTIAL writes
  // merge onto one row regardless of arrival order. Implicit rowid PK + partial
  // unique indexes (SQLite treats NULLs as distinct) let a launcher-first row exist
  // with a null session_id until the hook fills it, and a human session exist with
  // a null spawn_id — without either key colliding.
  db.exec(`
    CREATE TABLE IF NOT EXISTS registry (
      session_id TEXT,
      spawn_id TEXT,
      callsign TEXT,
      node TEXT,
      workdir TEXT,
      started_at INTEGER,
      pid INTEGER,
      control_handle TEXT,
      worktree_path TEXT,
      owned_branch TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_standby_at INTEGER,
      context_tokens INTEGER,
      context_ts INTEGER
    )
  `);
  // Forward-migration for a registry table created before context_ts existed
  // (e.g. a hub that already ran an earlier WS1 build — the deploy-onto-running-hub
  // case). Explicit column-presence check rather than a try/catch on ALTER: no
  // error-swallowing (a real ALTER failure surfaces) and no dependence on
  // better-sqlite3's "duplicate column" message text. Idempotent either way.
  const registryCols = db.prepare("PRAGMA table_info(registry)").all() as { name: string }[];
  if (!registryCols.some((c) => c.name === "context_ts")) {
    db.exec("ALTER TABLE registry ADD COLUMN context_ts INTEGER");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_session ON registry (session_id) WHERE session_id IS NOT NULL",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_spawn ON registry (spawn_id) WHERE spawn_id IS NOT NULL",
  );

  // Local patch: meta-harness plan core (Option-C module owns its own schema)
  initPlanSchema(db);

  // Loop governor (Phase 1): registry + stop-condition engine owns its own schema
  initLoopSchema(db);

  // Loop Phase 5: reflexion memory + HITL approval queue each own their own schema.
  initReflexionSchema(db);
  initApprovalSchema(db);

  // Seed #all if it doesn't exist
  const existing = db.prepare("SELECT name FROM channels WHERE name = ?").get("#all");
  if (!existing) {
    db.prepare("INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)").run(
      "#all",
      "system",
      Date.now(),
    );
  }
}

export function dbCreateChannel(name: string, createdBy: string): ChannelRow {
  const now = Date.now();
  db.prepare("INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)").run(name, createdBy, now);
  return { name, created_by: createdBy, created_at: now };
}

export function dbDeleteChannel(name: string): boolean {
  const result = db.prepare("DELETE FROM channels WHERE name = ?").run(name);
  return result.changes > 0;
}

export function dbListChannels(): ChannelRow[] {
  return db.prepare("SELECT name, created_by, created_at FROM channels ORDER BY created_at").all() as ChannelRow[];
}

export function dbGetChannel(name: string): ChannelRow | undefined {
  return db.prepare("SELECT name, created_by, created_at FROM channels WHERE name = ?").get(name) as
    | ChannelRow
    | undefined;
}

export function dbAddChannelMember(channel: string, userName: string): void {
  db.prepare("INSERT OR IGNORE INTO channel_members (channel, user_name) VALUES (?, ?)").run(channel, userName);
}

export function dbRemoveChannelMember(channel: string, userName: string): void {
  db.prepare("DELETE FROM channel_members WHERE channel = ? AND user_name = ?").run(channel, userName);
}

export function dbRemoveAllMembersOfChannel(channel: string): void {
  db.prepare("DELETE FROM channel_members WHERE channel = ?").run(channel);
}

export function dbGetUserChannels(userName: string): string[] {
  const rows = db.prepare("SELECT channel FROM channel_members WHERE user_name = ?").all(userName) as {
    channel: string;
  }[];
  return rows.map((r) => r.channel);
}

export function dbSaveMessage(msg: Message): void {
  db.prepare(
    `INSERT INTO messages (id, "from", "to", content, channel, timestamp, image, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.from,
    msg.to,
    msg.content,
    msg.channel,
    msg.timestamp,
    msg.image ? JSON.stringify(msg.image) : null,
    msg.seq ?? null,
  );
}

function parseMessageRow(row: Record<string, unknown>): Message {
  const imageStr = row.image as string | null;
  return {
    id: row.id as string,
    from: row.from as string,
    to: row.to as string,
    content: row.content as string,
    channel: row.channel as string,
    timestamp: row.timestamp as number,
    image: imageStr ? (JSON.parse(imageStr) as MessageImage) : undefined,
    seq: row.seq != null ? (row.seq as number) : undefined,
  };
}

export function dbGetChannelMessages(channel: string, limit = 50, sinceMs?: number): Message[] {
  // Take the most RECENT `limit` messages in the channel (DESC), then re-sort ASC
  // for display — same fix as dbGetRecentMessages. A plain `ORDER BY timestamp ASC
  // LIMIT` returns the OLDEST `limit` and drops the newest once a channel exceeds
  // `limit` messages (e.g. an active #Agent Radio session within the window), so
  // the live view would silently show stale messages instead of the latest.
  // `sinceMs`, when given, applies the rolling live-window (filter-on-read): only
  // messages with timestamp >= sinceMs are considered. Nothing is deleted; omitting
  // sinceMs returns the unwindowed channel history.
  const rows =
    sinceMs === undefined
      ? (db
          .prepare(
            `SELECT id, "from", "to", content, channel, timestamp, image, seq FROM (
               SELECT id, "from", "to", content, channel, timestamp, image, seq FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?
             ) ORDER BY timestamp ASC`,
          )
          .all(channel, limit) as Record<string, unknown>[])
      : (db
          .prepare(
            `SELECT id, "from", "to", content, channel, timestamp, image, seq FROM (
               SELECT id, "from", "to", content, channel, timestamp, image, seq FROM messages WHERE channel = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?
             ) ORDER BY timestamp ASC`,
          )
          .all(channel, sinceMs, limit) as Record<string, unknown>[]);
  return rows.map(parseMessageRow);
}

export function dbGetRecentMessages(limit = 200, sinceMs?: number): Message[] {
  // Take the most RECENT `limit` messages (DESC), then re-sort ASC for display.
  // A plain `ORDER BY timestamp ASC LIMIT` returned the OLDEST `limit` — so once
  // #all alone exceeded the window, newer non-#all channels (#Agent Radio, etc.)
  // fell entirely outside it and their history loaded empty on the dashboard.
  // `sinceMs`, when given, applies the rolling live-window (filter-on-read): only
  // messages with timestamp >= sinceMs are considered. Nothing is deleted.
  const rows =
    sinceMs === undefined
      ? (db
          .prepare(
            `SELECT id, "from", "to", content, channel, timestamp, image, seq FROM (
               SELECT id, "from", "to", content, channel, timestamp, image, seq FROM messages ORDER BY timestamp DESC LIMIT ?
             ) ORDER BY timestamp ASC`,
          )
          .all(limit) as Record<string, unknown>[])
      : (db
          .prepare(
            `SELECT id, "from", "to", content, channel, timestamp, image, seq FROM (
               SELECT id, "from", "to", content, channel, timestamp, image, seq FROM messages WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?
             ) ORDER BY timestamp ASC`,
          )
          .all(sinceMs, limit) as Record<string, unknown>[]);
  return rows.map(parseMessageRow);
}

export function dbGetChannelMessagesBefore(channel: string, beforeMs: number, limit = 200): Message[] {
  // History retrieval beyond the live-window: returns messages OLDER than
  // `beforeMs` (timestamp < beforeMs), newest-first, channel-scoped. This is how
  // agents pull >16h history on demand via GET /messages. Nothing is deleted;
  // this only reads. #all is no longer capped (never-delete model), so its full
  // history is retrievable here too.
  const rows = db
    .prepare(
      `SELECT id, "from", "to", content, channel, timestamp, image, seq FROM messages WHERE channel = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(channel, beforeMs, limit) as Record<string, unknown>[];
  return rows.map(parseMessageRow);
}

export function dbDeleteChannelMessages(channel: string): void {
  db.prepare("DELETE FROM messages WHERE channel = ?").run(channel);
}

export function dbUpdateReadCursor(userName: string, channel: string, timestamp?: number): void {
  const ts = timestamp ?? Date.now();
  db.prepare(
    `INSERT INTO read_cursors (user_name, channel, last_read_at) VALUES (?, ?, ?)
     ON CONFLICT(user_name, channel) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
  ).run(userName, channel, ts);
}

export function dbGetUnreadCounts(userName: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT m.channel, COUNT(*) as cnt
     FROM messages m
     LEFT JOIN read_cursors rc ON rc.user_name = ? AND rc.channel = m.channel
     WHERE m.timestamp > COALESCE(rc.last_read_at, 0)
     GROUP BY m.channel`,
    )
    .all(userName) as { channel: string; cnt: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.channel] = row.cnt;
  }
  return result;
}

export function dbDeleteReadCursorsForChannel(channel: string): void {
  db.prepare("DELETE FROM read_cursors WHERE channel = ?").run(channel);
}

// Operator presence: messages directly addressed to `name` (the "to" column) that
// the operator has NOT read yet (newer than its per-channel read cursor), oldest
// first. Used by ensureOperatorPresence to REHYDRATE the operator's in-memory queue
// after a hub restart so nothing addressed to the operator is lost across a restart — the
// in-memory queue is volatile but the messages row + read cursor are durable.
// Note: only direct sends (to == name) are recoverable from the DB; @-mentions
// inside an @all broadcast are not a persisted column, so they are not rehydrated.
export function dbGetUnreadMessagesTo(name: string, limit = 200): Message[] {
  const rows = db
    .prepare(
      `SELECT m.id, m."from", m."to", m.content, m.channel, m.timestamp, m.image, m.seq
       FROM messages m
       LEFT JOIN read_cursors rc ON rc.user_name = ? AND rc.channel = m.channel
       WHERE m."to" = ? AND m.timestamp > COALESCE(rc.last_read_at, 0)
       ORDER BY m.timestamp ASC LIMIT ?`,
    )
    .all(name, name, limit) as Record<string, unknown>[];
  return rows.map(parseMessageRow);
}

// Local patch: task board CRUD
export function dbGetBoardEntry(name: string): BoardRow | undefined {
  return db.prepare("SELECT * FROM board WHERE name = ?").get(name) as BoardRow | undefined;
}

export function dbPutBoardEntry(row: BoardRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO board (name, node, status, mission, activity, todos, subagents, sid, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.name, row.node, row.status, row.mission, row.activity, row.todos, row.subagents, row.sid, row.updated_at);
}

export function dbListBoard(): BoardRow[] {
  return db.prepare("SELECT * FROM board ORDER BY updated_at DESC").all() as BoardRow[];
}

export function dbDeleteBoardEntry(name: string): boolean {
  const result = db.prepare("DELETE FROM board WHERE name = ?").run(name);
  return result.changes > 0;
}

// Agent config CRUD
export function dbCreateAgentConfig(
  id: string,
  name: string,
  workDir: string,
  command: string,
  autoStart: boolean,
  envVars?: Record<string, string>,
): AgentConfigRow {
  const now = Date.now();
  const envJson = envVars ? JSON.stringify(envVars) : null;
  db.prepare(
    "INSERT INTO agent_configs (id, name, work_dir, command, auto_start, env_vars, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, name, workDir, command, autoStart ? 1 : 0, envJson, now);
  return { id, name, work_dir: workDir, command, auto_start: autoStart ? 1 : 0, env_vars: envJson, created_at: now };
}

export function dbListAgentConfigs(): AgentConfigRow[] {
  return db.prepare("SELECT * FROM agent_configs ORDER BY created_at").all() as AgentConfigRow[];
}

export function dbGetAgentConfig(id: string): AgentConfigRow | undefined {
  return db.prepare("SELECT * FROM agent_configs WHERE id = ?").get(id) as AgentConfigRow | undefined;
}

export function dbUpdateAgentConfig(
  id: string,
  updates: {
    name?: string;
    workDir?: string;
    command?: string;
    autoStart?: boolean;
    envVars?: Record<string, string> | null;
  },
): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.workDir !== undefined) {
    fields.push("work_dir = ?");
    values.push(updates.workDir);
  }
  if (updates.command !== undefined) {
    fields.push("command = ?");
    values.push(updates.command);
  }
  if (updates.autoStart !== undefined) {
    fields.push("auto_start = ?");
    values.push(updates.autoStart ? 1 : 0);
  }
  if (updates.envVars !== undefined) {
    fields.push("env_vars = ?");
    values.push(updates.envVars ? JSON.stringify(updates.envVars) : null);
  }
  if (fields.length === 0) return false;
  values.push(id);
  const result = db.prepare(`UPDATE agent_configs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function dbDeleteAgentConfig(id: string): boolean {
  const result = db.prepare("DELETE FROM agent_configs WHERE id = ?").run(id);
  return result.changes > 0;
}

// === C1: pending_ack CRUD ===

export function dbCreatePendingAck(msgId: string, senderSid: string, channel: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO pending_ack (msg_id, sender_sid, channel, created_at) VALUES (?, ?, ?, ?)",
  ).run(msgId, senderSid, channel, Date.now());
}

export function dbGetPendingAck(msgId: string): PendingAckRow | undefined {
  return db.prepare("SELECT msg_id, sender_sid, channel, created_at FROM pending_ack WHERE msg_id = ?").get(
    msgId,
  ) as PendingAckRow | undefined;
}

export function dbDeletePendingAck(msgId: string): boolean {
  const result = db.prepare("DELETE FROM pending_ack WHERE msg_id = ?").run(msgId);
  return result.changes > 0;
}

// === C1: channel_seq — next monotonic seq for a channel ===
// Atomically increments the counter and returns the new value (starts at 1).
// SQLite's single-writer guarantee makes the increment+read safe without a transaction.
export function dbNextChannelSeq(channel: string): number {
  db.prepare(
    `INSERT INTO channel_seq (channel, seq) VALUES (?, 1)
     ON CONFLICT(channel) DO UPDATE SET seq = seq + 1`,
  ).run(channel);
  return (db.prepare("SELECT seq FROM channel_seq WHERE channel = ?").get(channel) as { seq: number }).seq;
}

// === C4: resource_lock CRUD ===

export interface ResourceLockRow {
  resource_key: string;
  owner_sid: string;
  lease_expires_at: number;
}

// Atomic acquire: INSERT the lock if no row exists OR the existing lease has
// expired (lease_expires_at < now). The ON CONFLICT ... WHERE clause makes this
// a single conditional write — changes=1 means acquired, changes=0 means the
// lock is currently held by another session.
export function dbAcquireResourceLock(
  resourceKey: string,
  ownerSid: string,
  leaseExpiresAt: number,
  now: number,
): boolean {
  const result = db
    .prepare(
      `INSERT INTO resource_lock (resource_key, owner_sid, lease_expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(resource_key) DO UPDATE SET
         owner_sid = excluded.owner_sid,
         lease_expires_at = excluded.lease_expires_at
       WHERE resource_lock.lease_expires_at < ?`,
    )
    .run(resourceKey, ownerSid, leaseExpiresAt, now);
  return result.changes > 0;
}

// Sliding renewal: only renews if the caller still owns the lock.
export function dbRenewResourceLock(
  resourceKey: string,
  ownerSid: string,
  leaseExpiresAt: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE resource_lock SET lease_expires_at = ?
       WHERE resource_key = ? AND owner_sid = ?`,
    )
    .run(leaseExpiresAt, resourceKey, ownerSid);
  return result.changes > 0;
}

// Release: only the current owner can release.
export function dbReleaseResourceLock(resourceKey: string, ownerSid: string): boolean {
  const result = db
    .prepare(`DELETE FROM resource_lock WHERE resource_key = ? AND owner_sid = ?`)
    .run(resourceKey, ownerSid);
  return result.changes > 0;
}

export function dbGetResourceLock(resourceKey: string): ResourceLockRow | undefined {
  return db
    .prepare(`SELECT resource_key, owner_sid, lease_expires_at FROM resource_lock WHERE resource_key = ?`)
    .get(resourceKey) as ResourceLockRow | undefined;
}

// === WS1: session registry CRUD ===

const REGISTRY_COLS = [
  "session_id",
  "spawn_id",
  "callsign",
  "node",
  "workdir",
  "started_at",
  "pid",
  "control_handle",
  "worktree_path",
  "owned_branch",
  "status",
  "last_standby_at",
  "context_tokens",
  "context_ts",
] as const;

function rowToRegistryEntry(row: Record<string, unknown>): RegistryEntry {
  return {
    session_id: (row.session_id as string) ?? null,
    spawn_id: (row.spawn_id as string) ?? null,
    callsign: (row.callsign as string) ?? null,
    node: (row.node as string) ?? null,
    workdir: (row.workdir as string) ?? null,
    started_at: (row.started_at as number) ?? null,
    pid: (row.pid as number) ?? null,
    control_handle: (row.control_handle as string) ?? null,
    worktree_path: (row.worktree_path as string) ?? null,
    owned_branch: (row.owned_branch as string) ?? null,
    status: (row.status as string) ?? "active",
    last_standby_at: (row.last_standby_at as number) ?? null,
    context_tokens: (row.context_tokens as number) ?? null,
    context_ts: (row.context_ts as number) ?? null,
  };
}

export function dbListRegistry(): RegistryEntry[] {
  const rows = db.prepare("SELECT * FROM registry ORDER BY started_at DESC").all() as Record<string, unknown>[];
  return rows.map(rowToRegistryEntry);
}

// Resolve the rowid of the logical row a partial write targets: spawn_id first
// (the restart-stable merge key), then session_id (human-session fallback).
function findRegistryRowId(partial: Partial<RegistryEntry>): number | undefined {
  if (partial.spawn_id) {
    const r = db.prepare("SELECT rowid FROM registry WHERE spawn_id = ?").get(partial.spawn_id) as
      | { rowid: number }
      | undefined;
    if (r) return r.rowid;
  }
  if (partial.session_id) {
    const r = db.prepare("SELECT rowid FROM registry WHERE session_id = ?").get(partial.session_id) as
      | { rowid: number }
      | undefined;
    if (r) return r.rowid;
  }
  return undefined;
}

// Order-independent partial merge. Overlays only the provided non-null/non-undefined
// fields onto the existing row (or a fresh default), keyed by spawn_id then
// session_id — so a launcher-first write and a SessionStart-first write converge on
// ONE row, and a later partial never wipes a field it omits.
export function dbRegistryUpsert(partial: Partial<RegistryEntry>): RegistryEntry {
  const rowid = findRegistryRowId(partial);
  const existing =
    rowid !== undefined
      ? (db.prepare("SELECT * FROM registry WHERE rowid = ?").get(rowid) as Record<string, unknown>)
      : undefined;
  const merged: RegistryEntry = existing
    ? rowToRegistryEntry(existing)
    : {
        session_id: null,
        spawn_id: null,
        callsign: null,
        node: null,
        workdir: null,
        started_at: null,
        pid: null,
        control_handle: null,
        worktree_path: null,
        owned_branch: null,
        status: "active",
        last_standby_at: null,
        context_tokens: null,
        context_ts: null,
      };
  for (const col of REGISTRY_COLS) {
    const v = (partial as unknown as Record<string, unknown>)[col];
    if (v !== undefined && v !== null) (merged as unknown as Record<string, unknown>)[col] = v;
  }
  const args = [
    merged.session_id,
    merged.spawn_id,
    merged.callsign,
    merged.node,
    merged.workdir,
    merged.started_at,
    merged.pid,
    merged.control_handle,
    merged.worktree_path,
    merged.owned_branch,
    merged.status,
    merged.last_standby_at,
    merged.context_tokens,
    merged.context_ts,
  ];
  if (rowid !== undefined) {
    db.prepare(
      `UPDATE registry SET session_id=?, spawn_id=?, callsign=?, node=?, workdir=?, started_at=?, pid=?, control_handle=?, worktree_path=?, owned_branch=?, status=?, last_standby_at=?, context_tokens=?, context_ts=? WHERE rowid=?`,
    ).run(...args, rowid);
  } else {
    db.prepare(
      `INSERT INTO registry (session_id, spawn_id, callsign, node, workdir, started_at, pid, control_handle, worktree_path, owned_branch, status, last_standby_at, context_tokens, context_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...args);
  }
  return merged;
}

// Stamp the CONFIRMED callsign (from a /board-update carrying name+sid) onto the
// registry row for that session, overriding the SessionStart hook's computed
// callsign. No-op if no row exists for the sid yet.
export function dbStampRegistryCallsign(sessionId: string, callsign: string): boolean {
  return db.prepare("UPDATE registry SET callsign = ? WHERE session_id = ?").run(callsign, sessionId).changes > 0;
}

// Resolve the CURRENT callsign for a session by its sid. The rewake/msgcheck Stop
// hooks query this (via GET /whoami) instead of trusting the static
// /tmp/wt-callsign-<sid> file, which goes stale on an identity rename
// (become_referee / claim_referee / operator re-register). The registry row is the
// source of truth: its callsign is stamped on every identity op. Returns null when
// no row maps to the sid (a session that never registered).
export function dbGetRegistryCallsign(sessionId: string): string | null {
  const row = db.prepare("SELECT callsign FROM registry WHERE session_id = ?").get(sessionId) as
    | { callsign: string | null }
    | undefined;
  return row?.callsign ?? null;
}

export function dbSetRegistryStatusBySession(sessionId: string, status: string): boolean {
  return db.prepare("UPDATE registry SET status = ? WHERE session_id = ?").run(status, sessionId).changes > 0;
}

export function dbSetRegistryStatusBySpawn(spawnId: string, status: string): boolean {
  return db.prepare("UPDATE registry SET status = ? WHERE spawn_id = ?").run(status, spawnId).changes > 0;
}

// Hard-delete a registry row, keyed by session_id then spawn_id (the same identity keys
// dbRegistryUpsert merges on). Used by the registry GC sweep (reapDeadRegistryRows) to
// prune dead/superseded/fixture rows so the session ledger doesn't grow without bound —
// reapCrashedSessions only MARKS rows "crashed", it never removes them. No-op (returns
// false) for a row carrying neither key.
export function dbDeleteRegistryRow(entry: { session_id?: string | null; spawn_id?: string | null }): boolean {
  if (entry.session_id != null)
    return db.prepare("DELETE FROM registry WHERE session_id = ?").run(entry.session_id).changes > 0;
  if (entry.spawn_id != null)
    return db.prepare("DELETE FROM registry WHERE spawn_id = ?").run(entry.spawn_id).changes > 0;
  return false;
}
