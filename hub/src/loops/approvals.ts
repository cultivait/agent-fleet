// HITL approval queue (Phase 5) — the human-in-the-loop gate for escalated loops.
//
// MIRRORS THE OPERATOR GATE: when a loop's verifier returns recommendation:"escalate"
// (see loops/verdict.ts), the governor PAUSES the loop and opens a pending approval here
// instead of silently stopping or auto-continuing. Resolution is operator-gated exactly
// like the REFEREE / loop-admin-stop paths — it is reachable ONLY behind the admin token
// (adminRoutes in server.ts). There is no auto-approve: a paused-on-escalate loop stays
// parked until an operator approves (→ resume) or rejects (→ terminate).
//
// SINGLE-WRITER INVARIANT: like the rest of the hub this rides better-sqlite3's
// synchronous, single-writer execution. createApproval() is called from INSIDE
// tickLoop()'s transaction, so opening the queue item and pausing the loop commit
// atomically. Opening is idempotent per loop (one open item at a time) so a racing or
// repeated escalate tick can never fan out duplicate queue items.
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// Verdict comes from the canonical acyclic leaf (loops/verdict.ts), NOT store.ts — keeps the
// dep graph acyclic: verdict.ts ← approvals.ts ← store.ts (store also imports verdict.ts).
import type { AcceptanceCriteria, Verdict } from "./verdict.js";

export type ApprovalStatus = "pending" | "approved" | "rejected";

// Item 2 (loop-goal): distinguishes a PRE-RUN criteria gate (operator approves the
// Referee's proposed acceptance criteria before the loop runs) from the original in-run
// escalation gate (a running loop's verifier returned "escalate"). Same queue + widget.
export type ApprovalKind = "escalation_gate" | "criteria_gate";

export interface ApprovalRow {
  id: string;
  loop_id: string;
  reason: string;
  verdict: string | null; // JSON-encoded Verdict snapshot (escalation gate)
  status: ApprovalStatus;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
  kind: string; // Item 2: 'escalation_gate' (default) | 'criteria_gate'
  criteria: string | null; // Item 2: JSON AcceptanceCriteria proposed on a criteria_gate
}

// Parsed view returned to callers (verdict decoded).
export interface Approval {
  id: string;
  loop_id: string;
  reason: string;
  verdict: Verdict | null;
  status: ApprovalStatus;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
  kind: ApprovalKind;
  criteria: AcceptanceCriteria | null;
}

let db: Database.Database;

export function initApprovalSchema(database: Database.Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_approvals (
      id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      verdict TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      note TEXT,
      kind TEXT NOT NULL DEFAULT 'escalation_gate',
      criteria TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loop_approvals_status ON loop_approvals (status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_loop_approvals_loop ON loop_approvals (loop_id)`);

  // Item 2 (loop-goal): forward-compat for DBs created before the criteria-gate columns
  // existed (same guarded-ALTER idiom as the loops table).
  for (const col of ["kind TEXT NOT NULL DEFAULT 'escalation_gate'", "criteria TEXT"]) {
    try {
      db.exec(`ALTER TABLE loop_approvals ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
}

function genId(): string {
  return `appr_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function parseRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    loop_id: row.loop_id,
    reason: row.reason,
    verdict: row.verdict ? (JSON.parse(row.verdict) as Verdict) : null,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    note: row.note,
    kind: (row.kind as ApprovalKind) ?? "escalation_gate",
    criteria: row.criteria ? (JSON.parse(row.criteria) as AcceptanceCriteria) : null,
  };
}

export function getApproval(id: string): Approval | undefined {
  const row = db.prepare("SELECT * FROM loop_approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  return row ? parseRow(row) : undefined;
}

// The one open (pending) approval for a loop, if any. Used both for idempotent opening
// and to attach the pending item to a loop_get response.
export function getPendingApprovalForLoop(loopId: string): Approval | undefined {
  const row = db
    .prepare("SELECT * FROM loop_approvals WHERE loop_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
    .get(loopId) as ApprovalRow | undefined;
  return row ? parseRow(row) : undefined;
}

export interface CreateApprovalInput {
  loop_id: string;
  reason: string;
  verdict?: Verdict | null;
  // Item 2 (loop-goal): defaults to "escalation_gate". A "criteria_gate" carries the
  // Referee's proposed acceptance criteria for the operator to approve/edit/reject.
  kind?: ApprovalKind;
  criteria?: AcceptanceCriteria | null;
}

// Open a pending approval for a loop. Idempotent: if one is already open for the loop,
// returns it untouched rather than fanning out a duplicate.
export function createApproval(input: CreateApprovalInput): Approval {
  const existing = getPendingApprovalForLoop(input.loop_id);
  if (existing) return existing;
  const id = genId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO loop_approvals (id, loop_id, reason, verdict, status, created_at, decided_at, decided_by, note, kind, criteria)
     VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.loop_id,
    input.reason,
    input.verdict ? JSON.stringify(input.verdict) : null,
    now,
    input.kind ?? "escalation_gate",
    input.criteria ? JSON.stringify(input.criteria) : null,
  );
  return getApproval(id) as Approval;
}

// Item 2 (loop-goal): open the PRE-RUN criteria gate carrying the Referee's proposed
// acceptance bundle. Idempotent per loop (one open gate at a time). The server handler
// resolves it: approve → applyAcceptanceCriteria (→running), reject → revertLoopToDraft.
export function openCriteriaGate(loopId: string, criteria: AcceptanceCriteria, reason?: string): Approval {
  return createApproval({
    loop_id: loopId,
    reason: reason ?? "Operator approval of proposed acceptance criteria",
    kind: "criteria_gate",
    criteria,
  });
}

export function listApprovals(filter?: { status?: ApprovalStatus; loop_id?: string }): Approval[] {
  let sql = "SELECT * FROM loop_approvals";
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.loop_id) {
    where.push("loop_id = ?");
    params.push(filter.loop_id);
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY created_at DESC";
  return (db.prepare(sql).all(...params) as ApprovalRow[]).map(parseRow);
}

// Record an operator decision on a pending approval. Returns the updated row, or
// undefined if the id is unknown. Throws if the item is already decided (no re-deciding).
// NOTE: this only mutates the queue row; resuming/stopping the underlying loop is done by
// the caller (server handler) so loop-control stays in one place.
export function resolveApproval(
  id: string,
  decision: Exclude<ApprovalStatus, "pending">,
  decidedBy: string,
  note?: string,
): Approval | undefined {
  const current = getApproval(id);
  if (!current) return undefined;
  if (current.status !== "pending") {
    throw new Error(`Approval "${id}" already ${current.status}`);
  }
  db.prepare(
    "UPDATE loop_approvals SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?",
  ).run(decision, Date.now(), decidedBy, note ?? null, id);
  return getApproval(id);
}
