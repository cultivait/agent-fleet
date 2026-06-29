import type { IncomingMessage, ServerResponse } from "node:http";

export interface MessageImage {
  data: string; // base64 (no data-URI prefix)
  mimeType: string; // e.g. "image/png"
}

export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  channel: string;
  timestamp: number;
  image?: MessageImage;
  // Local patch: registered callsigns this message directly ADDRESSES — the
  // `to` recipient plus any @callsign mentions in the content. Drives the
  // ping/wake hooks via /pending-counts: only addressed members are notified.
  // An @all broadcast with no @-mentions addresses no one. Lives only on the
  // in-memory queued copy; not a DB column.
  mentions?: string[];
  // C3: true only on messages sent via the admin-token path (/admin-send).
  // Lets recipients distinguish operator-authenticated messages from join-token
  // messages that merely claim a reserved sender name. Rendered as [principal]
  // by the MCP tools so instances can act on it as in-session authorization.
  principal?: boolean;
  // Item 1 (fleet_dm): true only on a point-to-point direct message. Set on the
  // in-memory queued copy delivered to the recipient so the MCP client can render it
  // as a DM (not a channel message). DMs are stored in the separate dm_messages table
  // (never the messages table) and never fan out to a channel — see router.sendDm.
  dm?: boolean;
  // C1: monotonic per-channel sequence number — assigned by routeMessage at send
  // time so recipients can detect supersession (a later message on the same
  // channel always has a higher seq than an earlier one). Lives in both the
  // in-memory queue and the persisted messages row.
  seq?: number;
}

// C1: row type for the pending_ack durable table.
export interface PendingAckRow {
  msg_id: string;
  sender_sid: string;
  channel: string;
  created_at: number;
}

export type UserRole = "agent" | "bridge";

export interface User {
  name: string;
  token: string;
  role: UserRole;
  registeredAt: number;
  // REFEREE: true only when set via the admin-token /admin-register path. Drives
  // routeMessage's principal stamp on this user's /send messages. Never derived
  // from a client-supplied body — the server is the sole source of this flag.
  isPrincipal: boolean;
  // Operator presence: true only for the persistent operator identity ("Operator"),
  // bootstrapped server-side at hub start. A persistent user is a VIRTUAL presence
  // (no live Claude session backing it), so it is EXEMPT from the ghost-reaper /
  // kick-all (which exist to clear dead sessions). Distinct from isPrincipal: the
  // REFEREE is a principal but a REAL session, so it is NOT persistent and IS
  // reaped when it dies. Never read from a client body.
  persistent: boolean;
}

export interface RegisterRequest {
  name: string;
  oldToken?: string;
  role?: UserRole;
  // Claude session id (CLAUDE_CODE_SESSION_ID) when the joining client knows it.
  // Lets /register stamp the registry row's callsign at join time so GET /whoami is
  // authoritative from the first beat of a join (not only after the first board-update).
  sid?: string;
}

export interface RegisterResponse {
  token: string;
  name: string;
}

export interface SendRequest {
  to: string;
  content: string;
  channel?: string;
  image?: MessageImage;
}

export interface Channel {
  name: string;
  createdBy: string;
  createdAt: number;
}

// WS1: session registry — one logical row per spawned/joined session. Written by
// the SessionStart self-register hook (the HOOK subset) and the fleet launcher
// (the LAUNCHER subset), merged order-independently on spawn_id (session_id is the
// fallback key for human-launched sessions, where spawn_id is null). The hub
// maintains status / last_standby_at / context_tokens and runs a liveness sweep.
// Complements the board (live on-air status keyed by callsign); the registry is
// the durable identity + lifecycle record keyed by session.
export interface RegistryEntry {
  session_id: string | null; // stable identity — survives /compact, dies on /exit+respawn
  spawn_id: string | null; // restart-stable slot id (launcher's WT_SPAWN_ID); null = human-launched
  callsign: string | null; // computed at SessionStart, then stamped with the confirmed join name
  node: string | null;
  workdir: string | null;
  started_at: number | null;
  pid: number | null; // launcher-written (the hook is a child, can't self-report claude's pid)
  control_handle: string | null; // e.g. "tmux:wt-<rid>" on Linux — drives liveness + lifecycle verbs
  worktree_path: string | null;
  owned_branch: string | null;
  status: string; // "active" | "crashed" | "signed_off"
  last_standby_at: number | null;
  context_tokens: number | null; // hub-maintained from the transcript gauge (WS3)
  context_ts: number | null; // freshness-ts of the gauge write (epoch ms): LIVENESS not currency — advancing=live-but-quiet, stalled=frozen gauge
}

export interface SendResponse {
  id: string;
  to: string;
}

export interface PollResponse {
  messages: Message[];
}

export interface UsersResponse {
  users: string[];
}

export interface ErrorResponse {
  error: string;
}

export type PendingPoll = {
  userName: string;
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
};

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, userName?: string) => Promise<void>;
