import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  authenticateCockpitToken,
  authenticateRequest,
  cfAccessConfigured,
  getRegisteredUsers,
  getUserRole,
  getUserToken,
  isPersistentUser,
  isPrincipalUser,
  isUserRegistered,
  mintCockpitToken,
  registerUser,
  setPersistent,
  setPrincipal,
  unregisterUser,
  verifyCfAccessJwt,
} from "./auth.js";
import {
  ensureChannelMembership,
  getChannelMemberCounts,
  getChannelMembers,
  isChannelMember,
  joinChannel,
  leaveChannel,
  removeChannel,
} from "./channels.js";
import { STALL_BEAT_MS } from "./constants.js";
import { getDashboardHTML } from "./dashboard.js";
import {
  type BoardRow,
  type ResourceLockRow,
  dbAcquireResourceLock,
  dbCreateAgentConfig,
  dbCreateChannel,
  dbDeleteAgentConfig,
  dbDeleteBoardEntry,
  dbDeleteChannel,
  dbDeleteChannelMessages,
  dbDeletePendingAck,
  dbDeleteReadCursorsForChannel,
  dbGetAgentConfig,
  dbGetBoardEntry,
  dbGetChannel,
  dbGetChannelMessages,
  dbGetChannelMessagesBefore,
  dbGetPendingAck,
  dbGetRecentMessages,
  dbGetRegistryCallsign,
  dbGetResourceLock,
  dbGetUnreadCounts,
  dbGetUserChannels,
  dbListAgentConfigs,
  dbDeleteRegistryRow,
  dbListBoard,
  dbListChannels,
  dbListRegistry,
  dbInsertLog,
  dbListLog,
  dbListLatestLogPerAgent,
  dbListLogSince,
  dbPutBoardEntry,
  dbRegistryUpsert,
  dbReleaseResourceLock,
  dbRenewResourceLock,
  dbSetRegistryStatusBySession,
  dbSetRegistryStatusBySpawn,
  dbStampRegistryCallsign,
  dbUpdateAgentConfig,
  dbUpdateReadCursor,
  dbGetUnreadMessagesTo,
} from "./db.js";
import { addSSEClient, broadcast } from "./events.js";
import { launchAgent } from "./launcher.js";
import {
  claimTask,
  demoteIfBlocked,
  forceTransition,
  heartbeatByOwnerSid,
  heartbeatTask,
  isTerminal,
  listReadyTasks,
  reclaimExpiredLeases,
  setOnTaskReadyHook,
  STATUS_ORDER,
  transitionTask,
  unblockOnAck,
  wedgedTasks,
  wouldCreateCycle,
} from "./plan/machine.js";
import type { TaskRow } from "./plan/store.js";
import {
  addArtifact,
  addDep,
  addHandoff,
  createProject,
  createTask,
  deleteProject,
  getHandoffs,
  getLatestHandoff,
  getProject,
  getRecentEvents,
  getTask,
  leaseMs as planLeaseMs,
  listDepsByProject,
  listInflightTasks,
  listProjects,
  listTasksByOwnerSid,
  listTasksByProject,
} from "./plan/store.js";
import {
  createLoop,
  getLoop,
  listLoops,
  pauseLoop,
  resumeLoop,
  stopLoop,
  submitVerdict,
  tickLoop,
  type LoopConfig,
  type LoopStatus,
  type StopReason,
  type Verdict,
} from "./loops/store.js";
import { summarizeLoopSchedule } from "./loops/schedule.js";
import { addReflection, listReflections } from "./loops/reflexion.js";
import {
  getApproval,
  getPendingApprovalForLoop,
  listApprovals,
  resolveApproval,
  type ApprovalStatus,
} from "./loops/approvals.js";
import {
  addPoll,
  clearLastSeen,
  getLastSeen,
  hasOpenPoll,
  isOnline,
  onPollDisconnect,
  removePoll,
  setOffline,
  setOnline,
  touchLastSeen,
} from "./polling.js";
import { drainQueue, enqueueAndDeliver, ensureQueue, notifyBridges, peekQueue, pendingCounts, removeQueue, routeMessage } from "./router.js";
import { consumeTerminalTicket, mintTerminalTicket, TerminalSession, ticketFromUpgrade } from "./terminal.js";
import type { RegisterRequest, RegistryEntry, RouteHandler, SendRequest, UserRole } from "./types.js";
import {
  conductorStatus,
  launchReferee,
  startConductor,
  stopConductor,
  validateConductorConfig,
  validateFleetMax,
  writeControlMerged,
  writeFleetMax,
} from "./operator-control.js";

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

// C3: names the hub treats as operator identities. Registering one via the
// join-token path would let any agent impersonate the operator — block it.
// These names are still registerable via the admin-token path (/admin-send
// auto-registers the sender, and a future /admin-register endpoint can too).
// Stored lowercase so the check is case- and whitespace-insensitive, preventing
// look-alike registrations (" operator ", "REFEREE", etc.).
const RESERVED_NAMES = new Set(["operator", "referee"]);

// The canonical persistent operator identity. The configured operator name is the
// de-facto operator name across the hub (admin-send's default `from`, the kick-all
// exemption, and the read-cursor surfaces all key on it), so the persistent
// presence reuses it. Overridable for non-default deployments via AF_OPERATOR_NAME;
// the default keeps it consistent with those existing operator-name surfaces.
const OPERATOR_NAME = (process.env.AF_OPERATOR_NAME ?? process.env.WT_OPERATOR_NAME ?? "Operator").trim() || "Operator";

// Network bind host for the hub's HTTP/WS listener. Defaults to localhost-only
// (127.0.0.1) — the hub is NOT reachable off-box unless this is set explicitly.
// Opting into a non-localhost bind (e.g. a Tailscale IP, or 0.0.0.0) lets Tier-2
// clients on other machines join; the join token is then the only gate, so prefer
// a Tailscale/Cloudflare tunnel over raw 0.0.0.0 on untrusted networks. See
// .env.example ([multi-node] AGENT_FLEET_BIND_HOST).
const BIND_HOST = (process.env.AGENT_FLEET_BIND_HOST ?? "127.0.0.1").trim() || "127.0.0.1";

// Bootstrap (and re-assert) the persistent operator presence. Called from
// the production entrypoint (index.ts) AFTER initDB so the operator is always a
// valid mention/recipient target, queues messages addressed to it, and is exempt
// from the ghost-reaper / kick-all. Idempotent: safe to call repeatedly and on a
// hub already carrying an operator auto-registered by /admin-send — it only (re)asserts
// the principal + persistent capability, online presence, and #all membership.
// On FIRST registration it rehydrates the in-memory queue from the durable
// messages table so a hub restart does not drop messages addressed to the operator.
//
// Returns the operator's token (callers generally ignore it; the cockpit reads the
// operator inbox via the admin-token surface, not this token).
export function ensureOperatorPresence(name: string = OPERATOR_NAME): string {
  const firstRegistration = !isUserRegistered(name);
  if (firstRegistration) {
    registerUser(name);
  }
  // Re-assert capabilities every call (a prior /admin-send auto-register would have
  // created a NON-principal, NON-persistent, reapable operator — promote it here).
  setPrincipal(name, true);
  setPersistent(name, true);
  ensureQueue(name);
  setOnline(name);
  try {
    joinChannel("#all", name);
  } catch {
    /* already joined */
  }
  // Seed presence so any reaper that does not yet honor the persistent flag still
  // sees a fresh lastSeen (belt-and-suspenders alongside the flag exemption).
  touchLastSeen(name);

  if (firstRegistration) {
    // Restore anything addressed to the operator that had not yet been read before a restart.
    const pending = dbGetUnreadMessagesTo(name);
    for (const msg of pending) {
      // The DB row carries no `mentions` column; a direct send (to == name) is by
      // definition addressed to the operator, so stamp it so the operator-inbox
      // "addressed" filter and pending-counts treat it correctly.
      enqueueAndDeliver(name, { ...msg, mentions: [name] });
    }
    if (pending.length > 0) {
      console.log(`[operator-presence] rehydrated ${pending.length} message(s) addressed to ${name}`);
    }
  }
  broadcast({ type: "join", name, timestamp: Date.now() });
  console.log(`[operator-presence] ${name} online (persistent, principal)`);
  return getUserToken(name) ?? "";
}

const handleRegister: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as RegisterRequest;
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  // C3: reserved names are operator identities — reject on the join-token path.
  // Normalize to catch case variants and surrounding whitespace.
  if (RESERVED_NAMES.has(body.name.trim().toLowerCase())) {
    return sendError(res, 403, `Name "${body.name}" is reserved for operator use`);
  }
  try {
    // Durable identity: a re-join of an already-registered callsign TAKES OVER the
    // slot — newest claimant wins — instead of the old 409 "already registered" wall
    // that forced a manual /kick before a dropped-but-alive session could reclaim its
    // own name (the other half of the operator's "constantly rejoin" pain). A matching
    // oldToken is the clean-reconnect fast path; a missing/wrong one no longer blocks
    // the reclaim. Safe here: the join token is shared across the trusted single-
    // operator fleet, and this mirrors admin-register's oldName shed. Reserved
    // operator names are already rejected above, so this never reseats the operator/REFEREE.
    if (isUserRegistered(body.name)) {
      const existingToken = getUserToken(body.name);
      const cleanReconnect = body.oldToken != null && body.oldToken === existingToken;
      console.log(`[register] ${body.name} ${cleanReconnect ? "reconnect (token match)" : "takeover (re-bind)"}`);
      removePoll(body.name);
      // T5: only a TAKEOVER drains the pending queue. A clean reconnect (oldToken matches the
      // live token — e.g. an MCP process restart replaying its persisted token) must PRESERVE
      // the queue, else every forced re-auth silently drops in-flight messages (the message-loss
      // half of the hub re-auth bug). unregisterUser only rebinds the token map (+ channels); it
      // never touches messageQueues, and registerUser→ensureQueue below keeps the existing queue,
      // so skipping removeQueue here is sufficient to carry the pending messages across the re-auth.
      if (!cleanReconnect) removeQueue(body.name);
      unregisterUser(body.name);
    }
    // Cancel grace timer if reconnecting
    const graceTimer = staleTimers.get(body.name);
    if (graceTimer) {
      clearTimeout(graceTimer);
      staleTimers.delete(body.name);
    }
    const role = body.role === "bridge" ? "bridge" : "agent";
    const user = registerUser(body.name, role);
    ensureQueue(body.name);
    setOnline(body.name);
    // Auto-join #all
    try {
      joinChannel("#all", body.name);
    } catch {
      /* already joined or channel issue */
    }
    // Restore previous channel memberships from DB
    const previousChannels = dbGetUserChannels(body.name);
    for (const ch of previousChannels) {
      if (ch === "#all") continue;
      try {
        joinChannel(ch, body.name);
        broadcast({ type: "channel_join", channel: ch, userName: body.name, timestamp: Date.now() });
        console.log(`[auto-rejoin] ${body.name} -> ${ch}`);
      } catch {
        /* channel may no longer exist */
      }
    }
    touchLastSeen(body.name); // seed presence so the ghost-reaper grace starts now
    broadcast({ type: "join", name: body.name, timestamp: Date.now() });
    // Make GET /whoami authoritative from the first beat of a join: stamp the
    // registry row (created by the SessionStart self-register hook) with the
    // confirmed callsign now, rather than waiting for the first board-update. No-op
    // if the row doesn't exist yet (a board-update will stamp it when it lands).
    if (body.sid) {
      dbStampRegistryCallsign(body.sid, user.name);
    }
    console.log(`[register] ${body.name}`);

    if (role === "agent") {
      notifyBridges(`USER_JOINED: ${body.name}`);
    } else if (role === "bridge") {
      // Send current agent list to the newly connected bridge (even if empty)
      const agents = getRegisteredUsers().filter((n) => n !== body.name && getUserRole(n) === "agent");
      enqueueAndDeliver(body.name, {
        id: randomUUID(),
        from: "system",
        to: body.name,
        content: agents.length > 0 ? `CONNECTED_USERS: ${agents.join(", ")}` : "CONNECTED_USERS: (none)",
        channel: "#all",
        timestamp: Date.now(),
      });
    }

    sendJson(res, 200, { token: user.token, name: user.name });
  } catch (e) {
    sendError(res, 409, (e as Error).message);
  }
};

const handleSend: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as SendRequest;
  if (!body.to || (!body.content && !body.image)) {
    return sendError(res, 400, "Missing 'to' or 'content' field");
  }
  // Typing indicator: broadcast typing event without routing to chat log
  if (body.content === "TYPING") {
    const channel = body.channel || "#all";
    dbUpdateReadCursor(userName!, channel);
    broadcast({ type: "typing", name: userName!, channel, timestamp: Date.now() });
    console.log(`[typing] ${userName}`);
    return sendJson(res, 200, { id: "typing", to: body.to });
  }
  const content = body.content || "";
  const channel = body.channel || "#all";
  // C1: look up sender's session id from board entry for BLOCKING detect.
  // If the board entry is absent or has no sid, BLOCKING messages still send
  // but task parking is skipped (graceful degradation).
  const senderSid = dbGetBoardEntry(userName!)?.sid ?? undefined;
  // REFEREE: stamp principal ONLY from the SENDER'S server-side user record
  // (set via /admin-register). NEVER from the request body — `body` is a
  // SendRequest and carries no principal field; a join-token user therefore
  // cannot forge principal:true. A normal agent's record has isPrincipal=false,
  // so this stamps undefined for them (forgery guard).
  const senderPrincipal = isPrincipalUser(userName!) ? true : undefined;
  try {
    const message = routeMessage(userName!, body.to, content, channel, body.image, senderPrincipal, senderSid);
    // C1: if BLOCKING prefix and we have a sid, park the sender's active task.
    if (content.startsWith("BLOCKING:") && senderSid) {
      for (const t of listTasksByOwnerSid(senderSid)) {
        if (t.status === "in_progress" || t.status === "claimed") {
          const parkResult = transitionTask(t.id, "blocked", userName!);
          if (parkResult.ok) {
            emitPlanUpdate(parkResult.task.project_id, parkResult.task.id, "transition");
          }
        }
      }
    }
    broadcast({
      type: "message",
      id: message.id,
      from: message.from,
      to: message.to,
      content: message.content,
      channel: message.channel,
      timestamp: message.timestamp,
      image: message.image,
    });
    console.log(`[send] ${userName} -> ${body.to} (${channel}): ${content}${body.image ? " [+image]" : ""}`);
    sendJson(res, 200, { id: message.id, to: message.to });
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
};

const handleInbox: RouteHandler = async (_req, res, userName) => {
  const messages = drainQueue(userName!);
  sendJson(res, 200, { messages });
};

// === C1: /ack — clear a pending_ack row and wake the blocked sender ===
const handleAck: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { msg_id?: string };
  if (!body.msg_id || typeof body.msg_id !== "string") {
    return sendError(res, 400, "Missing 'msg_id' field");
  }
  const row = dbGetPendingAck(body.msg_id);
  if (!row) {
    return sendError(res, 404, `No pending ACK for msg_id "${body.msg_id}"`);
  }
  dbDeletePendingAck(body.msg_id);
  const unblockedIds = unblockOnAck(row.sender_sid, userName ?? null);
  for (const taskId of unblockedIds) {
    const t = getTask(taskId);
    if (t) emitPlanUpdate(t.project_id, taskId, "transition");
  }
  console.log(`[ack] ${userName} acked ${body.msg_id} — unblocked tasks: ${unblockedIds.join(", ") || "(none)"}`);
  sendJson(res, 200, { ok: true, msg_id: body.msg_id, unblocked: unblockedIds });
};

const handlePoll: RouteHandler = async (req, res, userName) => {
  const wasOffline = !isOnline(userName!);
  addPoll(userName!, req, res);
  if (wasOffline) {
    setOnline(userName!);
    broadcast({ type: "status", name: userName!, online: true, timestamp: Date.now() });
  }
};

const handleUsers: RouteHandler = async (_req, res) => {
  const users = getRegisteredUsers().map((name) => ({
    name,
    online: isOnline(name),
    role: getUserRole(name) ?? "agent",
  }));
  sendJson(res, 200, { users });
};

const handleUnregister: RouteHandler = async (_req, res, userName) => {
  const role = getUserRole(userName!);
  removePoll(userName!);
  removeQueue(userName!);
  unregisterUser(userName!);
  retireBoardEntry(userName!);
  broadcast({ type: "leave", name: userName!, timestamp: Date.now() });
  if (role === "agent") {
    notifyBridges(`USER_LEFT: ${userName}`);
  }
  console.log(`[unregister] ${userName}`);
  sendJson(res, 200, { ok: true });
};

function kickUser(name: string): boolean {
  if (!getRegisteredUsers().includes(name)) return false;
  const role = getUserRole(name);
  // Send a termination message directly to the target user's queue only
  ensureQueue(name);
  enqueueAndDeliver(name, {
    id: randomUUID(),
    from: "system",
    to: name,
    content: "RADIO_KILLED: You have been disconnected by the operator.",
    channel: "#all",
    timestamp: Date.now(),
  });
  removePoll(name);
  removeQueue(name);
  unregisterUser(name);
  retireBoardEntry(name);
  broadcast({ type: "leave", name, timestamp: Date.now() });
  if (role === "agent") {
    notifyBridges(`USER_LEFT: ${name}`);
  }
  console.log(`[kick] ${name}`);
  return true;
}

const handleKick: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name) {
    return sendError(res, 400, "Missing 'name' field");
  }
  if (kickUser(body.name)) {
    sendJson(res, 200, { ok: true, kicked: body.name });
  } else {
    sendError(res, 404, `User "${body.name}" not found`);
  }
};

const handleKickAll: RouteHandler = async (_req, res) => {
  // Keep the operator-name skip for back-compat AND exempt any persistent operator
  // presence — kick-all clears live agents, never the virtual operator identity.
  const agents = [...getRegisteredUsers()].filter((name) => name !== OPERATOR_NAME && !isPersistentUser(name));
  for (const name of agents) {
    kickUser(name);
  }
  sendJson(res, 200, { ok: true, kicked: agents });
};

const handleAdminSend: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    from?: string;
    to?: string;
    content?: string;
    channel?: string;
    image?: { data: string; mimeType: string };
  };
  const from = body.from || OPERATOR_NAME;
  if (!body.to || (!body.content && !body.image)) {
    return sendError(res, 400, "Missing 'to' or 'content' field");
  }
  const content = body.content || "";
  const channel = body.channel || "#all";
  // Auto-register the admin sender so agents can reply
  if (!isUserRegistered(from)) {
    try {
      registerUser(from);
      ensureQueue(from);
      try {
        joinChannel("#all", from);
      } catch {
        /* already joined */
      }
      broadcast({ type: "join", name: from, timestamp: Date.now() });
      console.log(`[auto-register] ${from}`);
    } catch {
      /* already registered */
    }
  }
  // Ensure operator is in target channel
  try {
    joinChannel(channel, from);
  } catch {
    /* already joined or channel issue */
  }
  try {
    // C3: admin-token path → stamp principal:true so recipients can verify
    const message = routeMessage(from, body.to, content, channel, body.image, true);
    broadcast({
      type: "message",
      id: message.id,
      from: message.from,
      to: message.to,
      content: message.content,
      channel: message.channel,
      timestamp: message.timestamp,
      image: message.image,
    });
    console.log(`[admin-send] ${from} -> ${body.to} (${channel}): ${content}${body.image ? " [+image]" : ""}`);
    sendJson(res, 200, { id: message.id, to: message.to });
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
};

// REFEREE: admin-token-gated registration that BYPASSES the RESERVED_NAMES block
// (the whole point — it mints an operator-identity callsign like "REFEREE" that
// the join-token /register path refuses). Admin auth is enforced by the
// adminRoutes dispatcher (Bearer adminToken) exactly like /admin-send, so a 401
// is returned before this handler runs if the admin token is missing/wrong.
//
// Behavior:
//   1. (auth — handled by dispatcher)
//   2. bypass RESERVED_NAMES (no reserved-name check here at all)
//   3. if `oldName` is provided AND registered, kickUser(oldName) first — sheds
//      the auto-joined callsign the agent registered under before the rename.
//   4. registerUser(name, role); mark the new user as a principal when
//      `principal===true` OR when the name is a RESERVED_NAME (operator identity
//      — "operator"/"referee" are always principals so their /send
//      messages stamp principal:true without the caller having to remember the
//      flag).
//   5. if `sid` provided, dbStampRegistryCallsign(sid, name) to align the
//      registry row's callsign with the renamed identity.
//   6. return { token, name } like /register.
const handleAdminRegister: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    name?: string;
    oldName?: string;
    sid?: string;
    role?: UserRole;
    principal?: boolean;
  };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  const name = body.name;
  const role: UserRole = body.role === "bridge" ? "bridge" : "agent";

  // (3) Shed the previous (auto-joined) callsign if the caller named one.
  if (body.oldName && body.oldName !== name && isUserRegistered(body.oldName)) {
    kickUser(body.oldName);
  }

  try {
    // (2) NO reserved-name check — that is the entire reason this endpoint exists.
    // (4) Register, then mark principal. Reserved operator identities are always
    // principal; otherwise honor the explicit flag.
    const isReserved = RESERVED_NAMES.has(name.trim().toLowerCase());
    const makePrincipal = body.principal === true || isReserved;

    // Allow re-registration of the same name (e.g. a retried become-referee):
    // shed the existing record first so registerUser doesn't throw 409.
    if (isUserRegistered(name)) {
      removePoll(name);
      removeQueue(name);
      unregisterUser(name);
    }

    const user = registerUser(name, role);
    // Set the principal capability via the dedicated setter (admin path only).
    if (makePrincipal) {
      setPrincipal(name, true);
    }
    ensureQueue(name);
    setOnline(name);
    try {
      joinChannel("#all", name);
    } catch {
      /* already joined or channel issue */
    }
    touchLastSeen(name);
    broadcast({ type: "join", name, timestamp: Date.now() });
    if (role === "agent") {
      notifyBridges(`USER_JOINED: ${name}`);
    }

    // (5) Align the registry callsign with the renamed identity.
    if (body.sid) {
      dbStampRegistryCallsign(body.sid, name);
    }

    console.log(`[admin-register] ${body.oldName ? `${body.oldName} -> ` : ""}${name} (principal=${makePrincipal})`);
    // (6) Same shape as /register.
    sendJson(res, 200, { token: user.token, name: user.name });
  } catch (e) {
    sendError(res, 409, (e as Error).message);
  }
};

// REFEREE FAILOVER: member-gated + vacancy-gated claim of the REFEREE seat.
// Unlike /admin-register (admin token, force), this lets ANY valid member promote
// itself to REFEREE *only when the seat is empty* — so a killed referee's natural
// successor can take over without the admin token. The target name is HARDCODED to
// REFEREE: the endpoint takes no name parameter, so there is no path here to mint
// the operator identity. The vacancy check and registration run in ONE synchronous critical
// section (no `await` after readBody) so, under Node's single thread, two concurrent
// claims on a vacant seat resolve to exactly one winner.
const handleClaimReferee: RouteHandler = async (req, res, userName) => {
  if (!userName) return sendError(res, 401, "Unauthorized");
  const body = JSON.parse(await readBody(req)) as { oldName?: string; sid?: string };
  const TARGET = "REFEREE";

  // ----- critical section: no `await` below this line -----
  // Vacancy = NOT (registered AND online). Mirrors the board's liveness check
  // (isUserRegistered(name) && isOnline(name)); a live referee is never usurped.
  if (isUserRegistered(TARGET) && isOnline(TARGET)) {
    return sendJson(res, 409, { error: "referee_seat_occupied", holder: TARGET });
  }

  try {
    // Seat is empty or held by a stale/offline record — shed any stale record.
    if (isUserRegistered(TARGET)) {
      removePoll(TARGET);
      removeQueue(TARGET);
      unregisterUser(TARGET);
    }
    // Shed the caller's current callsign so the SAME session becomes REFEREE.
    const oldName = body.oldName ?? userName;
    if (oldName && oldName !== TARGET && isUserRegistered(oldName)) {
      kickUser(oldName);
    }

    const user = registerUser(TARGET, "agent");
    setPrincipal(TARGET, true); // REFEREE is always a principal identity.
    ensureQueue(TARGET);
    setOnline(TARGET);
    try {
      joinChannel("#all", TARGET);
    } catch {
      /* already joined or channel issue */
    }
    touchLastSeen(TARGET);
    broadcast({ type: "join", name: TARGET, timestamp: Date.now() });
    notifyBridges(`USER_JOINED: ${TARGET}`);

    if (body.sid) {
      dbStampRegistryCallsign(body.sid, TARGET);
    }

    console.log(`[claim-referee] ${userName} -> ${TARGET} (vacancy claim)`);
    // Same shape as /register and /admin-register.
    sendJson(res, 200, { token: user.token, name: user.name });
  } catch (e) {
    sendError(res, 409, (e as Error).message);
  }
};

// Channel endpoints
const handleChannelCreate: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  const channelName = body.name.startsWith("#") ? body.name : `#${body.name}`;
  if (dbGetChannel(channelName)) {
    return sendError(res, 409, `Channel "${channelName}" already exists`);
  }
  try {
    dbCreateChannel(channelName, userName!);
    ensureChannelMembership(channelName);
    // Auto-join the creator
    joinChannel(channelName, userName!);
    broadcast({ type: "channel_create", name: channelName, timestamp: Date.now() });
    broadcast({ type: "channel_join", channel: channelName, userName: userName!, timestamp: Date.now() });
    console.log(`[channel-create] ${channelName} by ${userName}`);
    sendJson(res, 200, { ok: true, channel: channelName });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
};

const handleChannelJoin: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  try {
    joinChannel(body.channel, userName!);
    broadcast({ type: "channel_join", channel: body.channel, userName: userName!, timestamp: Date.now() });
    console.log(`[channel-join] ${userName} -> ${body.channel}`);
    sendJson(res, 200, { ok: true, channel: body.channel });
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
};

const handleChannelLeave: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  if (body.channel === "#all") {
    return sendError(res, 400, "Cannot leave #all");
  }
  leaveChannel(body.channel, userName!);
  broadcast({ type: "channel_leave", channel: body.channel, userName: userName!, timestamp: Date.now() });
  console.log(`[channel-leave] ${userName} <- ${body.channel}`);
  sendJson(res, 200, { ok: true, channel: body.channel });
};

const handleChannelInvite: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string; user?: string };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  if (!body.user || typeof body.user !== "string") {
    return sendError(res, 400, "Missing or invalid 'user' field");
  }
  const targetName = body.user.startsWith("@") ? body.user.slice(1) : body.user;
  if (!isUserRegistered(targetName)) {
    return sendError(res, 404, `User "${targetName}" is not connected`);
  }
  try {
    joinChannel(body.channel, targetName);
    broadcast({ type: "channel_join", channel: body.channel, userName: targetName, timestamp: Date.now() });
    // Notify the invited user via a system message in the channel
    routeMessage("system", `@${targetName}`, `You have been invited to ${body.channel} by ${userName}`, body.channel);
    console.log(`[channel-invite] ${userName} invited ${targetName} to ${body.channel}`);
    sendJson(res, 200, { ok: true, channel: body.channel, user: targetName });
  } catch (e) {
    sendError(res, 400, (e as Error).message);
  }
};

const handleListChannels: RouteHandler = async (_req, res) => {
  const channels = dbListChannels();
  const memberCounts = getChannelMemberCounts();
  const result = channels.map((ch) => ({
    name: ch.name,
    createdBy: ch.created_by,
    createdAt: ch.created_at,
    memberCount: memberCounts.get(ch.name) ?? 0,
    members: getChannelMembers(ch.name),
  }));
  sendJson(res, 200, { channels: result });
};

// Rolling live-window (filter-on-read). The dashboard + agent history loads only
// surface the last AF_LIVE_WINDOW_HOURS (default 16h); the window rolls forward
// with wall-clock time on every read. Messages are NEVER deleted — older history
// stays in the DB and is retrievable via GET /messages. Boundary is computed in
// absolute epoch-ms (Date.now()), so it is timezone-safe. A non-positive or
// non-numeric env value falls back to the 16h default rather than disabling reads.
const rawLiveWindowHours = parseInt(process.env.AF_LIVE_WINDOW_HOURS ?? process.env.WT_LIVE_WINDOW_HOURS ?? "16", 10);
const LIVE_WINDOW_HOURS = Number.isFinite(rawLiveWindowHours) && rawLiveWindowHours > 0 ? rawLiveWindowHours : 16;
const LIVE_WINDOW_MS = LIVE_WINDOW_HOURS * 60 * 60 * 1000;
function liveWindowSince(): number {
  return Date.now() - LIVE_WINDOW_MS;
}

const handleChannelHistory: RouteHandler = async (req, res, userName) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const channel = url.searchParams.get("channel");
  if (!channel) {
    return sendError(res, 400, "Missing 'channel' query parameter");
  }
  if (!isChannelMember(channel, userName!)) {
    return sendError(res, 403, `You are not a member of ${channel}`);
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  const messages = dbGetChannelMessages(channel, limit, liveWindowSince());
  sendJson(res, 200, { messages });
};

// History retrieval beyond the live-window. The live loads (handleChannelHistory /
// handleAdminChannelHistory) only show the last AF_LIVE_WINDOW_HOURS; this endpoint
// lets members page back through OLDER history on demand. Same auth + channel-scoping
// as /channel-history (user-token + membership). Returns messages with timestamp <
// `before` (defaults to now), newest-first, capped by `limit` (default 200).
const handleMessages: RouteHandler = async (req, res, userName) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const channel = url.searchParams.get("channel");
  if (!channel) {
    return sendError(res, 400, "Missing 'channel' query parameter");
  }
  if (!isChannelMember(channel, userName!)) {
    return sendError(res, 403, `You are not a member of ${channel}`);
  }
  const beforeRaw = url.searchParams.get("before");
  const beforeParsed = beforeRaw !== null ? parseInt(beforeRaw, 10) : Number.NaN;
  const before = Number.isFinite(beforeParsed) ? beforeParsed : Date.now();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1), 500);
  const messages = dbGetChannelMessagesBefore(channel, before, limit);
  sendJson(res, 200, { messages });
};

const handleAdminChannelCreate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  const channelName = body.name.startsWith("#") ? body.name : `#${body.name}`;
  if (dbGetChannel(channelName)) {
    return sendError(res, 409, `Channel "${channelName}" already exists`);
  }
  try {
    dbCreateChannel(channelName, OPERATOR_NAME);
    ensureChannelMembership(channelName);
    broadcast({ type: "channel_create", name: channelName, timestamp: Date.now() });
    console.log(`[admin-channel-create] ${channelName}`);
    sendJson(res, 200, { ok: true, channel: channelName });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
};

const handleAdminChannelHistory: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const channel = url.searchParams.get("channel");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1), 500);
  const since = liveWindowSince();
  if (channel) {
    const messages = dbGetChannelMessages(channel, limit, since);
    sendJson(res, 200, { messages });
  } else {
    const messages = dbGetRecentMessages(limit, since);
    sendJson(res, 200, { messages });
  }
};

const handleAdminChannelDelete: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  if (body.name === "#all") {
    return sendError(res, 400, "Cannot delete #all");
  }
  if (!dbGetChannel(body.name)) {
    return sendError(res, 404, `Channel "${body.name}" not found`);
  }
  dbDeleteChannel(body.name);
  dbDeleteChannelMessages(body.name);
  dbDeleteReadCursorsForChannel(body.name);
  removeChannel(body.name);
  broadcast({ type: "channel_delete", name: body.name, timestamp: Date.now() });
  console.log(`[admin-channel-delete] ${body.name}`);
  sendJson(res, 200, { ok: true, channel: body.name });
};

// Local patch: task board — operator removal of stale/ghost entries.
const handleAdminBoardDelete: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { name?: string };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  if (!dbDeleteBoardEntry(body.name)) {
    return sendError(res, 404, `Board entry "${body.name}" not found`);
  }
  broadcast({ type: "board_delete", name: body.name, timestamp: Date.now() });
  console.log(`[admin-board-delete] ${body.name}`);
  sendJson(res, 200, { ok: true, name: body.name });
};

const handleAdminMarkRead: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { channel?: string; timestamp?: number };
  if (!body.channel || typeof body.channel !== "string") {
    return sendError(res, 400, "Missing or invalid 'channel' field");
  }
  const ts = body.timestamp ?? Date.now();
  dbUpdateReadCursor(OPERATOR_NAME, body.channel, ts);
  broadcast({ type: "read_update", userName: OPERATOR_NAME, channel: body.channel, timestamp: ts });
  sendJson(res, 200, { ok: true });
};

const handleAdminUnreadCounts: RouteHandler = async (_req, res) => {
  const counts = dbGetUnreadCounts(OPERATOR_NAME);
  sendJson(res, 200, { counts });
};

// Operator inbox: surface the messages queued for the persistent operator presence
// so the cockpit / admin surface can show what is waiting for the operator without
// holding a poll. Admin-token gated (adminRoutes).
//   GET /admin-operator-inbox          → PEEK (non-destructive); returns the queued
//                                         messages addressed to the operator + queue depth.
//   GET /admin-operator-inbox?drain=1  → DRAIN: clears the operator's in-memory queue and
//                                         advances the per-channel read cursor to now
//                                         (so /admin-unread-counts resets), then
//                                         returns the addressed messages that were
//                                         drained. The full DB transcript is untouched.
// "addressed" = messages whose `mentions` include the operator (a direct `to:@operator` send or
// an @operator mention) — the traffic that actually warrants the operator's attention,
// as opposed to @all chatter merely overheard in the operator's channels.
const handleAdminOperatorInbox: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const drain = url.searchParams.get("drain") === "1";
  const queued = drain ? drainQueue(OPERATOR_NAME) : peekQueue(OPERATOR_NAME);
  const addressed = queued.filter((m) => m.mentions?.includes(OPERATOR_NAME));
  if (drain && queued.length > 0) {
    const now = Date.now();
    for (const channel of new Set(queued.map((m) => m.channel))) {
      dbUpdateReadCursor(OPERATOR_NAME, channel, now);
      broadcast({ type: "read_update", userName: OPERATOR_NAME, channel, timestamp: now });
    }
  }
  sendJson(res, 200, {
    operator: OPERATOR_NAME,
    drained: drain,
    addressedCount: addressed.length,
    queuedCount: queued.length,
    messages: addressed,
  });
};

// Agent config endpoints
const handleAdminAgentConfigs: RouteHandler = async (_req, res) => {
  const configs = dbListAgentConfigs();
  const result = configs.map((c) => ({
    id: c.id,
    name: c.name,
    workDir: c.work_dir,
    command: c.command,
    autoStart: c.auto_start === 1,
    envVars: c.env_vars ? JSON.parse(c.env_vars) : {},
    createdAt: c.created_at,
    online: isUserRegistered(c.name) && isOnline(c.name),
  }));
  sendJson(res, 200, { configs: result });
};

const handleAdminAgentConfigCreate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    name?: string;
    workDir?: string;
    command?: string;
    autoStart?: boolean;
    envVars?: Record<string, string>;
  };
  if (!body.name || typeof body.name !== "string") {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  if (!AGENT_NAME_RE.test(body.name)) {
    return sendError(res, 400, "Agent name must contain only a-z, 0-9, hyphen, underscore");
  }
  if (!body.workDir || typeof body.workDir !== "string") {
    return sendError(res, 400, "Missing or invalid 'workDir' field");
  }
  try {
    const id = randomUUID();
    const config = dbCreateAgentConfig(
      id,
      body.name,
      body.workDir,
      body.command || "",
      body.autoStart ?? false,
      body.envVars,
    );
    broadcast({ type: "agent_config_create", id: config.id, name: config.name, timestamp: Date.now() });
    console.log(`[agent-config-create] ${config.name}`);
    sendJson(res, 200, { ok: true, id: config.id });
  } catch (e) {
    sendError(res, 409, (e as Error).message);
  }
};

const handleAdminAgentConfigUpdate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    id?: string;
    name?: string;
    workDir?: string;
    autoStart?: boolean;
    envVars?: Record<string, string> | null;
  };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  if (body.name && !AGENT_NAME_RE.test(body.name)) {
    return sendError(res, 400, "Agent name must contain only a-z, 0-9, hyphen, underscore");
  }
  const config = dbGetAgentConfig(body.id);
  if (!config) {
    return sendError(res, 404, "Agent config not found");
  }
  if (isUserRegistered(config.name)) {
    return sendError(res, 409, "Agent is currently online. Kick it first.");
  }
  dbUpdateAgentConfig(body.id, {
    name: body.name,
    workDir: body.workDir,
    autoStart: body.autoStart,
    envVars: body.envVars,
  });
  const name = body.name ?? config.name;
  broadcast({ type: "agent_config_update", id: body.id, name, timestamp: Date.now() });
  console.log(`[agent-config-update] ${name}`);
  sendJson(res, 200, { ok: true });
};

const handleAdminAgentConfigDelete: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { id?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const configToDelete = dbGetAgentConfig(body.id);
  if (!configToDelete) {
    return sendError(res, 404, "Agent config not found");
  }
  if (isUserRegistered(configToDelete.name)) {
    return sendError(res, 409, "Agent is currently online. Kick it first.");
  }
  if (!dbDeleteAgentConfig(body.id)) {
    return sendError(res, 404, "Agent config not found");
  }
  broadcast({ type: "agent_config_delete", id: body.id, timestamp: Date.now() });
  console.log(`[agent-config-delete] ${body.id}`);
  sendJson(res, 200, { ok: true });
};

const handleAdminAgentStart: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { id?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const config = dbGetAgentConfig(body.id);
  if (!config) {
    return sendError(res, 404, "Agent config not found");
  }
  try {
    await launchAgent(config);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
};

// Local patch: task board — per-agent live status fed automatically by hooks.
// Updates are join-token gated (hooks hold AGENT_FLEET_JOIN_TOKEN); reads are public.
const BOARD_TEXT_MAX = 300;
const BOARD_TODOS_MAX = 50;

// undefined = field absent (keep current), null = explicit clear
function boardField(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, BOARD_TEXT_MAX) : null;
}

// Live subagent count: undefined = absent (keep current), null = reset to 0,
// a finite number = set (clamped to a sane non-negative range).
const BOARD_SUBAGENTS_MAX = 999;
function boardCount(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (v === null) return 0;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(BOARD_SUBAGENTS_MAX, Math.floor(v)));
}

// One live board card per session. When a session rejoins under a new callsign
// (rename), its prior card — same sid, different name — is a stale duplicate;
// drop it so the board doesn't show the same instance twice.
function dropRenamedBoardDuplicates(sid: string, keepName: string): void {
  for (const row of dbListBoard()) {
    if (row.sid === sid && row.name !== keepName) {
      dbDeleteBoardEntry(row.name);
      broadcast({ type: "board_delete", name: row.name, timestamp: Date.now() });
      console.log(`[board-dedup] dropped ${row.name} — same session as ${keepName}`);
    }
  }
}

const handleBoardUpdate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    name?: string;
    node?: string | null;
    status?: string | null;
    mission?: string | null;
    activity?: string | null;
    todos?: Array<{ content?: string; status?: string }> | null;
    subagents?: number | null;
    sid?: string | null;
  };
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  const name = body.name.trim().slice(0, BOARD_TEXT_MAX);
  // The taskboard hook posts here on every tool use — treat it as a liveness
  // heartbeat so a working agent (not in the standby poll loop) isn't ghost-reaped.
  touchLastSeen(name);
  const row: BoardRow = dbGetBoardEntry(name) ?? {
    name,
    node: null,
    status: "active",
    mission: null,
    activity: null,
    todos: null,
    subagents: 0,
    sid: null,
    updated_at: 0,
  };
  const node = boardField(body.node);
  if (node !== undefined) row.node = node;
  const status = boardField(body.status);
  if (status !== undefined) row.status = status ?? "active";
  const mission = boardField(body.mission);
  if (mission !== undefined) row.mission = mission;
  const activity = boardField(body.activity);
  if (activity !== undefined) row.activity = activity;
  if (body.todos !== undefined) {
    if (body.todos === null) {
      row.todos = null;
    } else if (Array.isArray(body.todos)) {
      const todos = body.todos
        .filter((t) => t && typeof t.content === "string" && t.content.trim())
        .slice(0, BOARD_TODOS_MAX)
        .map((t) => ({
          content: (t.content as string).trim().slice(0, BOARD_TEXT_MAX),
          status: typeof t.status === "string" ? t.status.slice(0, 20) : "pending",
        }));
      row.todos = JSON.stringify(todos);
    } else {
      return sendError(res, 400, "'todos' must be an array or null");
    }
  }
  const subagents = boardCount(body.subagents);
  if (subagents !== undefined) row.subagents = subagents;
  const rawSid = boardField(body.sid);
  if (rawSid !== undefined) row.sid = rawSid === "nosession" ? null : rawSid;
  row.updated_at = Date.now();
  dbPutBoardEntry(row);
  if (row.sid) dropRenamedBoardDuplicates(row.sid, row.name);
  // WS1: a board-update carries the CONFIRMED callsign (name) + its sid, so stamp
  // it onto the registry row for that session — overriding the SessionStart hook's
  // computed callsign with the actual joined name. No-op if no registry row yet.
  if (row.sid) dbStampRegistryCallsign(row.sid, row.name);
  broadcast({
    type: "board_update",
    name: row.name,
    node: row.node,
    status: row.status,
    mission: row.mission,
    activity: row.activity,
    todos: row.todos ? JSON.parse(row.todos) : null,
    subagents: row.subagents,
    sid: row.sid,
    timestamp: row.updated_at,
  });
  if (mission !== undefined || body.todos !== undefined) {
    console.log(`[board] ${row.name}: ${row.status}${row.mission ? ` — ${row.mission}` : ""}`);
  }
  sendJson(res, 200, { ok: true });
};

const handleBoard: RouteHandler = async (_req, res) => {
  const now = Date.now();
  // WS2 display half: join the identity registry's context gauge onto the board
  // by session_id so each card can render a live context-token reading. Built
  // once per request; the registry is tiny (one row per live/recent session).
  const ctxBySid = new Map<string, { context_tokens: number | null; context_ts: number | null }>();
  // Fallback join key: some board rows carry no bound sid (e.g. the reserved
  // REFEREE identity taken via radio_become_referee), so also index context by
  // callsign and fall back to it. Freshest reading wins on a duplicate callsign.
  const ctxByCallsign = new Map<string, { context_tokens: number | null; context_ts: number | null }>();
  for (const e of dbListRegistry()) {
    const ctx = { context_tokens: e.context_tokens, context_ts: e.context_ts };
    if (e.session_id) ctxBySid.set(e.session_id, ctx);
    if (e.callsign) {
      const prev = ctxByCallsign.get(e.callsign);
      if (!prev || (e.context_ts ?? 0) >= (prev.context_ts ?? 0)) ctxByCallsign.set(e.callsign, ctx);
    }
  }
  // Board auto-digest: one latest log headline per agent, joined by callsign.
  // The full last-5 is fetched lazily by the dashboard on card-expand; the board
  // payload carries only the single freshest line to keep it glanceable + small.
  const logByName = new Map<string, { ts: number; kind: string; note: string }>();
  for (const l of dbListLatestLogPerAgent()) {
    logByName.set(l.name, { ts: l.ts, kind: l.kind, note: l.note });
  }
  const board = dbListBoard().map((r) => {
    const online = isUserRegistered(r.name) && isOnline(r.name);
    const lastSeenAt = getLastSeen(r.name);
    // Ghost detection: registered + not explicitly offline, but no recent heartbeat.
    // Uses the same PRESENCE_GRACE_MS threshold as the ghost-reaper sweep so the
    // cockpit and the reaper agree on what "stale" means.
    const stale = online && lastSeenAt > 0 && now - lastSeenAt > PRESENCE_GRACE_MS;
    // Context gauge: join by bound sid, else fall back to callsign (REFEREE etc.).
    const ctxRow = r.sid && ctxBySid.has(r.sid) ? ctxBySid.get(r.sid)! : ctxByCallsign.get(r.name);
    return {
      name: r.name,
      node: r.node,
      status: r.status,
      mission: r.mission,
      activity: r.activity,
      todos: r.todos ? (JSON.parse(r.todos) as Array<{ content: string; status: string }>) : null,
      subagents: r.subagents ?? 0,
      updatedAt: r.updated_at,
      online,
      lastSeenAt,
      stale,
      // Owning session id — lets the cockpit Right-Now rail resolve a task's
      // owner_sid to a live callsign + online dot (presence join). Internal id,
      // only served on the Access-gated dashboard.
      sid: r.sid ?? null,
      // WS2 context gauge, joined from the registry by session_id. null when the
      // session has not reported a reading yet ("gauge pending"). context_ts is a
      // LIVENESS stamp — the card greys the reading when it stops advancing.
      contextTokens: ctxRow?.context_tokens ?? null,
      contextTs: ctxRow?.context_ts ?? null,
      // Board auto-digest: the single freshest logbook line for this agent
      // (null until it emits its first fleet_log). The card renders it as the
      // "latest log" headline; expand fetches the last 5 via /agent-log?name=.
      recentLog: logByName.get(r.name) ?? null,
    };
  });
  // Server clock mirrors /plan-board so cockpit computes one shared clock offset.
  sendJson(res, 200, { board, now });
};

// === Board auto-digest: agent_log endpoints ===
// The structural fix for comms-verbosity decay: detail (findings/decisions/
// progress) belongs in a logbook that's READ, not a chat message that WAKES.
// A fleet_log emit posts here — it never @-mentions, so it wakes no one; the
// dashboard reads it. Mirrors /board-update's join-token gate + heartbeat.
const AGENT_LOG_KINDS = new Set(["finding", "decision", "blocker", "done"]);
const AGENT_LOG_TAIL_MAX = 20;

const handleAgentLog: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    name?: string;
    kind?: string;
    note?: string;
  };
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return sendError(res, 400, "Missing or invalid 'name' field");
  }
  if (!body.note || typeof body.note !== "string" || !body.note.trim()) {
    return sendError(res, 400, "Missing or invalid 'note' field");
  }
  const name = body.name.trim().slice(0, BOARD_TEXT_MAX);
  const kind = typeof body.kind === "string" && AGENT_LOG_KINDS.has(body.kind) ? body.kind : "finding";
  const note = body.note.trim().slice(0, BOARD_TEXT_MAX);
  // Emitting a log entry proves the agent is alive — same liveness beat as a
  // board-update, so a working (non-polling) agent isn't ghost-reaped.
  touchLastSeen(name);
  const entry = dbInsertLog(name, kind, note);
  // SSE so the dashboard updates the card's latest-log headline live, with no
  // wake to any agent (browser-only stream; deliverMessage is never called).
  broadcast({
    type: "agent_log",
    name: entry.name,
    entry: { id: entry.id, ts: entry.ts, kind: entry.kind, note: entry.note },
    timestamp: entry.ts,
  });
  console.log(`[log] ${name} [${kind}]: ${note}`);
  sendJson(res, 200, { ok: true, entry });
};

const handleAgentLogTail: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const name = url.searchParams.get("name");
  if (!name || !name.trim()) return sendError(res, 400, "Missing 'name' query param");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "5", 10) || 5, 1), AGENT_LOG_TAIL_MAX);
  sendJson(res, 200, { name, log: dbListLog(name.trim().slice(0, BOARD_TEXT_MAX), limit) });
};

// board-digest v2 read-half: recent OTHER-agent log entries since a watermark id,
// newest-first, bounded. Public read (like /agent-log-tail). The rewake Stop-hook
// pulls this on a wake that's ALREADY firing to surface teammate findings;
// entries[0].id is the caller's next watermark (no separate maxId needed).
const handleAgentLogDigest: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "5", 10) || 5, 1), AGENT_LOG_TAIL_MAX);
  const exclude = (url.searchParams.get("exclude") ?? "").trim();
  sendJson(res, 200, { entries: dbListLogSince(since, exclude || null, limit) });
};

// Local patch: task board lifecycle — when the hub unregisters an agent
// (radio_out, kick, stale poll timeout) its entry is retired to signed-off so
// the last known state stays readable, then a periodic sweep deletes retired
// or abandoned entries after a grace period. Hub restarts do not retire
// anything (the shutdown path never unregisters), so the board survives them.
const BOARD_REAP_MINUTES = parseInt(process.env.AF_BOARD_REAP_MINUTES ?? process.env.WT_BOARD_REAP_MINUTES ?? "60", 10);
const BOARD_REAP_SWEEP_MS = 5 * 60_000;

// Wave-4 (b) — D4 ANTI-ZOMBIE INVARIANT: the plan-lease window MUST stay strictly
// SHORTER than the board-reap horizon. D4's heartbeat fail-open is only non-exploitable
// because a reclaimed-but-still-alive owner is caught by the ownerGate (403 on its
// return) BEFORE the board reaps its entry. If the plan lease (AF_PLAN_LEASE_SECONDS) is
// >= the board-reap horizon (AF_BOARD_REAP_MINUTES), the board entry is deleted before
// the lease lapses, the reclaim goes unguarded, and the zombie window silently re-opens.
// Asserted at startup (createHubServer) so a misconfig fails LOUD, not silently. Same
// invariant family as (a)'s resource-lock clamp: NO LEASE OUTLIVES ITS RECLAIM WINDOW.
export function assertLeaseReapInvariant(planLeaseMs: number, boardReapMs: number): void {
  if (planLeaseMs >= boardReapMs) {
    throw new Error(
      `Config invariant violated: plan lease (AF_PLAN_LEASE_SECONDS=${Math.round(planLeaseMs / 1000)}s) ` +
        `must be STRICTLY LESS THAN the board-reap horizon ` +
        `(AF_BOARD_REAP_MINUTES=${boardReapMs / 60_000}m=${Math.round(boardReapMs / 1000)}s). ` +
        `A lease >= board-reap re-opens the D4 anti-zombie window — lower AF_PLAN_LEASE_SECONDS ` +
        `or raise AF_BOARD_REAP_MINUTES.`,
    );
  }
}
// How long an agent may go with no open poll and no hub activity before it's
// judged a dead session. A live agent heads-down on a task (not in the standby
// poll loop) proves liveness via the taskboard hook's /board-update heartbeat
// (fired every <=15s on tool use) — see touchLastSeen in handleBoardUpdate.
// Grace MUST exceed two real silent windows or it false-reaps LIVE sessions:
//   1. a single long tool call (esp. a subagent the parent is blocked on) emits
//      NO /board-update between its start and finish — minutes of silence;
//   2. the async-rewake Stop hook (AF_REWAKE_MAX_SECS, default 1800s) listens
//      for teammate traffic by polling /pending-counts, which does NOT touch
//      lastSeen — so a member waiting on teammates looks idle the whole time.
// This deployment defaults to 7200s (2h) so long-lived agent sessions aren't
// false-reaped (upstream general default is 2400s/40min). It outlasts the rewake
// window and gives long subagents headroom; a true ghost still clears within it.
// Keep AF_PRESENCE_GRACE_SECONDS > AF_REWAKE_MAX_SECS.
const PRESENCE_GRACE_MS = parseInt(process.env.AF_PRESENCE_GRACE_SECONDS ?? process.env.WT_PRESENCE_GRACE_SECONDS ?? "7200", 10) * 1000;

function retireBoardEntry(name: string): void {
  const row = dbGetBoardEntry(name);
  if (!row || row.status === "signed-off") return;
  row.status = "signed-off";
  row.activity = null;
  row.subagents = 0;
  row.updated_at = Date.now();
  dbPutBoardEntry(row);
  broadcast({
    type: "board_update",
    name: row.name,
    node: row.node,
    status: row.status,
    mission: row.mission,
    activity: row.activity,
    todos: row.todos ? JSON.parse(row.todos) : null,
    subagents: row.subagents,
    sid: row.sid,
    timestamp: row.updated_at,
  });
  console.log(`[board-retire] ${name}`);
}

// Ghost reaper: a session that dies between polls leaves no socket to drop, so
// onPollDisconnect never fires and it lingers "online" forever. Sweep agents
// that hold no open poll AND haven't been seen within the grace window, and
// unregister them exactly as the stale-poll path does. Agents actively holding
// a poll are alive by definition and always skipped. Bridges are exempt (they
// may maintain liveness differently). Returns the names reaped.
export function reapGhostAgents(graceMs: number): string[] {
  const now = Date.now();
  const reaped: string[] = [];
  for (const name of getRegisteredUsers()) {
    if (getUserRole(name) === "bridge") continue;
    // Persistent operator presence is a virtual identity with no session —
    // it never holds a poll and would otherwise always look stale. Never reap it.
    if (isPersistentUser(name)) continue;
    if (hasOpenPoll(name)) continue;
    if (now - getLastSeen(name) < graceMs) continue;
    removePoll(name);
    removeQueue(name);
    setOffline(name);
    clearLastSeen(name);
    unregisterUser(name);
    retireBoardEntry(name);
    broadcast({ type: "leave", name, timestamp: now });
    notifyBridges(`USER_LEFT: ${name}`);
    reaped.push(name);
  }
  if (reaped.length > 0) console.log(`[ghost-reap] ${reaped.join(", ")}`);
  return reaped;
}

export function reapStaleBoardEntries(maxAgeMs: number): string[] {
  const cutoff = Date.now() - maxAgeMs;
  const reaped: string[] = [];
  for (const row of dbListBoard()) {
    if (row.updated_at >= cutoff) continue;
    if (isUserRegistered(row.name) && isOnline(row.name)) continue;
    dbDeleteBoardEntry(row.name);
    broadcast({ type: "board_delete", name: row.name, timestamp: Date.now() });
    reaped.push(row.name);
  }
  if (reaped.length > 0) console.log(`[board-reap] removed ${reaped.join(", ")}`);
  return reaped;
}

// === WS1: session registry (identity + lifecycle) ===
// A new POST /session-register write surface. Two partial writers — the SessionStart
// self-register hook (HOOK subset) and the fleet launcher (LAUNCHER subset) — merge
// order-independently on spawn_id (session_id fallback). The hub stamps the confirmed
// callsign from /board-update and runs a liveness sweep for silent deaths.
const REGISTRY_TEXT_MAX = 512;

function regStr(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  return v.slice(0, REGISTRY_TEXT_MAX);
}

function regNum(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v;
}

const handleSessionRegister: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
  const partial: Partial<RegistryEntry> = {};
  const bag = partial as unknown as Record<string, unknown>;
  const assignStr = (key: string, raw: unknown): void => {
    const v = regStr(raw);
    if (v !== undefined) bag[key] = v;
  };
  const assignNum = (key: string, raw: unknown): void => {
    const v = regNum(raw);
    if (v !== undefined) bag[key] = v;
  };
  assignStr("session_id", body.session_id);
  assignStr("spawn_id", body.spawn_id);
  // A row MUST be keyed by at least one of session_id / spawn_id, or it can never
  // be merged or targeted — reject all-null payloads.
  if (!partial.session_id && !partial.spawn_id) {
    return sendError(res, 400, "session-register requires a non-empty session_id or spawn_id");
  }
  assignStr("callsign", body.callsign);
  assignStr("node", body.node);
  assignStr("workdir", body.workdir);
  assignStr("control_handle", body.control_handle);
  assignStr("worktree_path", body.worktree_path);
  assignStr("owned_branch", body.owned_branch);
  const status = regStr(body.status);
  if (status) partial.status = status;
  assignNum("started_at", body.started_at);
  assignNum("pid", body.pid);
  assignNum("last_standby_at", body.last_standby_at);
  assignNum("context_tokens", body.context_tokens);
  assignNum("context_ts", body.context_ts);

  const entry = dbRegistryUpsert(partial);
  broadcast({
    type: "registry_update",
    session_id: entry.session_id,
    spawn_id: entry.spawn_id,
    callsign: entry.callsign,
    node: entry.node,
    status: entry.status,
    timestamp: Date.now(),
  });
  // A signed_off POST is the launcher's deliberate-kill signal (it holds only the
  // spawn_id; the hub resolves the merged row's callsign). Reconcile the roster in
  // the same pass so a killed agent doesn't linger "online" for the 40min ghost
  // grace — this is the hub half of "kill-ALL = one registry pass".
  if (entry.status === "signed_off") retirePresenceForCallsign(entry.callsign);
  sendJson(res, 200, { ok: true, entry });
};

const handleRegistry: RouteHandler = async (_req, res) => {
  sendJson(res, 200, { registry: dbListRegistry(), now: Date.now() });
};

// Liveness probe for one registry row — ALIVE if ANY available signal says alive
// (a session is only crashed when every signal we can read agrees it's dead).
// Signals:
//   1. pid → process.kill(pid,0). A live pid is definitive proof of life and wins
//      over a stale tmux name (an agent that restarted under a new pid keeps its
//      tmux session). pids are only ever written by the local Linux launcher, so
//      they are always local-checkable. ESRCH ⇒ dead; fall through to tmux.
//   2. tmux session — explicit "tmux:<session>" control_handle, ELSE DERIVED from
//      spawn_id: the launcher names every spawned session `wt-<rid>` and
//      spawn_id == rid, so `tmux has-session -t wt-<spawn_id>` works even before the
//      launcher's enrich-POST lands. The robust signal for conductor-spawned agents.
// Returns null when no signal is readable (no pid, no tmux, tmux unavailable) — those
// rows are left to the board ghost-reaper's heartbeat-staleness sweep (by callsign).
function isRegistrySessionAlive(entry: RegistryEntry): boolean | null {
  let sawSignal = false;
  if (entry.pid != null) {
    sawSignal = true;
    try {
      process.kill(entry.pid, 0);
      return true; // process exists ⇒ alive
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") return true; // EPERM etc. ⇒ exists
      // ESRCH ⇒ pid dead; fall through — tmux may still say alive (restart-under-new-pid).
    }
  }
  const tmuxSession = entry.control_handle?.startsWith("tmux:")
    ? entry.control_handle.slice("tmux:".length)
    : entry.spawn_id
      ? `wt-${entry.spawn_id}`
      : null;
  if (tmuxSession) {
    const r = spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "ignore" });
    // tmux missing (spawn error / no exit status) → not a readable signal.
    if (r.error == null && typeof r.status === "number") {
      sawSignal = true;
      if (r.status === 0) return true; // tmux session alive
    }
  }
  return sawSignal ? false : null;
}

// Reconcile the ROSTER (in-memory presence + board entry) when the registry has
// PROVEN a session gone — a launcher signed_off POST or the crash sweep below.
// The registry row and the roster are separate stores: marking a row crashed/
// signed_off leaves the radio_join presence "online" until reapGhostAgents clears
// it at PRESENCE_GRACE_MS (40min) — far too slow for a deliberate kill, and the
// exact stale "online" ghost that otherwise needs a manual admin /kick. The
// launcher CANNOT do this itself: /kick is keyed by callsign and the launcher
// only ever holds spawn_id; only the hub links spawn_id→row→callsign. So we do it
// here, mirroring reapGhostAgents' retire sequence but acting IMMEDIATELY — the
// death is already proven, so no grace gate and no open-poll skip. A no-op when
// the callsign is null or absent from the roster (e.g. a session killed before it
// ever radio_joined has a registry row but no presence to retire).
function retirePresenceForCallsign(callsign: string | null, hard = true): void {
  if (!callsign || !isUserRegistered(callsign)) return;
  const role = getUserRole(callsign);
  if (!hard) {
    // Manual-eviction-only: a proven-dead session DIMS (so the board is honest that
    // it crashed) but keeps its roster membership + token + board entry until a manual
    // /kick — a returning agent re-lights without re-joining. Only soft signals here.
    setOffline(callsign);
    broadcast({ type: "status", name: callsign, online: false, timestamp: Date.now() });
    console.log(`[presence-dim] ${callsign} (reaping-disabled: crashed, kept on roster)`);
    return;
  }
  removePoll(callsign);
  removeQueue(callsign);
  setOffline(callsign);
  clearLastSeen(callsign);
  unregisterUser(callsign);
  retireBoardEntry(callsign);
  broadcast({ type: "leave", name: callsign, timestamp: Date.now() });
  if (role === "agent") notifyBridges(`USER_LEFT: ${callsign}`);
  console.log(`[presence-retire] ${callsign}`);
}

// Registry liveness sweep. A session can die SILENTLY outside any lifecycle verb
// (crash, host kill, OOM), leaving its row stuck "active" forever and (for a
// conductor-spawned slot) its claimed task wedged. Mark provably-dead rows
// status="crashed" + broadcast, so the conductor can requeue. Returns the keys
// (session_id, or spawn_id when session_id is null) it crashed.
// `retirePresence` (default true) also retires the dead session's roster presence.
// The hub's auto-sweep passes false under REAPING_DISABLED: a crash still marks
// the registry row crashed + broadcasts (board honesty), but the member stays on the
// roster until a manual /kick — so a transient probe-miss can't evict a live agent.
export function reapCrashedSessions(retirePresence = true): string[] {
  const crashed: string[] = [];
  for (const entry of dbListRegistry()) {
    if (entry.status === "crashed" || entry.status === "signed_off") continue;
    if (isRegistrySessionAlive(entry) !== false) continue; // alive OR undeterminable → leave
    const key = entry.session_id ?? entry.spawn_id;
    if (!key) continue;
    if (entry.session_id) dbSetRegistryStatusBySession(entry.session_id, "crashed");
    else dbSetRegistryStatusBySpawn(entry.spawn_id as string, "crashed");
    broadcast({
      type: "registry_update",
      session_id: entry.session_id,
      spawn_id: entry.spawn_id,
      callsign: entry.callsign,
      node: entry.node,
      status: "crashed",
      timestamp: Date.now(),
    });
    // A crashed session's radio_join presence is also dead — retire it now rather than
    // wait out the ghost grace, so /registry and the roster agree. Under
    // reaping-disabled (retirePresence=false) this DIMS instead of removing: the
    // row is marked crashed + the presence goes offline, but the member stays on the
    // roster until a manual /kick, so a transient probe-miss can't evict a live agent.
    retirePresenceForCallsign(entry.callsign, retirePresence);
    crashed.push(key);
  }
  if (crashed.length > 0) console.log(`[registry-crash] ${crashed.join(", ")}`);
  return crashed;
}

// Registry GC. reapCrashedSessions only MARKS rows "crashed"; nothing ever deletes them,
// so the session ledger grows without bound — every dead session and every role re-claim
// (e.g. each Claude that becomes REFEREE) leaves a permanent row. Left unchecked this both
// bloats the table and skews the cockpit context-gauge, which reads dbListRegistry() keyed
// by callsign: with N stale "REFEREE" rows the last-wins map can surface a long-dead
// session's token count instead of the live one. This sweep DELETES rows that are provably
// done while never removing the one row that backs a currently-connected identity.
//
// Runs INDEPENDENT of REAPING_DISABLED. That flag governs ROSTER eviction — keeping live
// (even quiet/dimmed) members on the board under manual-eviction-only so a reconnect needs
// no re-join. Registry GC touches only the dead ledger: it never evicts a roster member,
// never dims presence, and never deletes the live identity row, so gating it on no-reap
// would just let the ledger rot. Two hard guards keep it safe:
//   (1) a row whose session is provably ALIVE (pid/tmux probe) is never touched;
//   (2) the NEWEST row of a callsign that is currently registered on the roster is never
//       touched — that row is the live identity and the /whoami source the rewake hooks
//       depend on, even when its own liveness probe is undeterminable (heads-down session).
// A row is deletable when MALFORMED (no started_at — partial writes and test fixtures like
// "who-B", which never reflect a real running session), or when it is OLD (past graceMs)
// AND one of: SUPERSEDED (a newer row for the callsign exists, so deletion can't orphan a
// /whoami mapping), TERMINAL (status crashed/signed_off), or PROVEN DEAD (pid ESRCH / tmux
// gone). Critically, the NEWEST row of a callsign is NEVER reaped on age alone when its
// liveness is merely UNDETERMINABLE (pid-less, handle-less): after a hub bounce a live-but-
// idle session stays un-rejoined (its rewake only fires on queued traffic), so "unregistered
// + old" is NOT proof of death — reaping it there would churn a live session's identity.
// Returns the number of rows deleted.
export function reapDeadRegistryRows(graceMs: number): number {
  const now = Date.now();
  const rows = dbListRegistry(); // started_at DESC ⇒ the first row seen per callsign is its newest
  const seenCallsign = new Set<string>();
  let removed = 0;
  for (const entry of rows) {
    const callsign = entry.callsign;
    const isNewest = callsign == null || !seenCallsign.has(callsign);
    if (callsign != null) seenCallsign.add(callsign);

    if (isRegistrySessionAlive(entry) === true) continue; // (1) alive ⇒ sacrosanct
    if (isNewest && callsign != null && isUserRegistered(callsign)) continue; // (2) live identity row

    const malformed = entry.started_at == null; // partial write / fixture (e.g. "who-B")
    const old = entry.started_at != null && now - entry.started_at > graceMs;
    const terminal = entry.status === "crashed" || entry.status === "signed_off";
    const dead = isRegistrySessionAlive(entry) === false; // pid ESRCH / tmux gone — proven dead
    // Newest-but-undeterminable rows fail every disjunct below ⇒ kept (no false-positive reap).
    const deletable = malformed || (old && (!isNewest || terminal || dead));
    if (!deletable) continue;

    if (dbDeleteRegistryRow(entry)) removed++;
  }
  if (removed > 0) console.log(`[registry-gc] pruned ${removed} dead registry row(s)`);
  return removed;
}

// Local patch: meta-harness plan core. Thin HTTP glue — domain logic lives in
// ./plan/store.js (Option-C module boundary). Step 1: project + task read/create.

// Step 3: every plan mutation pings the live board over the same SSE stream the
// dashboard already listens on. Coarse-but-correct — viewers refetch /plan-board
// for the full cascade (auto-unblock, demote, rollup) rather than us enumerating it.
function emitPlanUpdate(projectId: string, taskId: string | null, kind: string): void {
  broadcast({ type: "plan_update", projectId, taskId, kind, timestamp: Date.now() });
}

// Step 4: lazy lease-guard. Reclaim expired held tasks and announce each on the
// board. Called at the top of the plan READ/claim endpoints so ownership is
// always current at the moment it matters — no background timer (flag #2).
function reclaimAndEmit(): void {
  for (const r of reclaimExpiredLeases(Date.now())) emitPlanUpdate(r.projectId, r.id, "lease_expired");
}

// Parent roll-up read model — per-parent child counts (total/terminal/done).
// Shared by /plan-get and /plan-board so the two never disagree.
function computeChildSummaries(tasks: TaskRow[]): Record<string, { total: number; terminal: number; done: number }> {
  const summaries: Record<string, { total: number; terminal: number; done: number }> = {};
  for (const t of tasks) {
    if (!t.parent_id) continue;
    const s = (summaries[t.parent_id] ??= { total: 0, terminal: 0, done: 0 });
    s.total += 1;
    if (isTerminal(t.status)) s.terminal += 1;
    if (t.status === "done") s.done += 1;
  }
  return summaries;
}

const handleProjectCreate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { title?: string; brief?: string | null; by?: string | null };
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return sendError(res, 400, "Missing or invalid 'title' field");
  }
  const project = createProject(body.title.trim(), body.brief ?? null, body.by ?? null);
  emitPlanUpdate(project.id, null, "project_create");
  sendJson(res, 200, { project });
};

// Admin-gated project delete. Cascade-removes the project's tasks/events/deps
// (FK ON DELETE CASCADE). 404 if it doesn't exist, so a double-tap is harmless.
const handleProjectDelete: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { id?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const project = getProject(body.id);
  if (!project) {
    return sendError(res, 404, `Project "${body.id}" not found`);
  }
  const { tasks } = deleteProject(body.id);
  emitPlanUpdate(body.id, null, "project_delete");
  console.log(`[admin-project-delete] ${body.id} ("${project.title}") + ${tasks} task(s)`);
  sendJson(res, 200, { ok: true, id: body.id, title: project.title, tasks });
};

const handlePlanGet: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const projectId = url.searchParams.get("project_id");
  if (!projectId) {
    return sendError(res, 400, "Missing 'project_id' query param");
  }
  const project = getProject(projectId);
  if (!project) {
    return sendError(res, 404, `Project "${projectId}" not found`);
  }
  const tasks = listTasksByProject(projectId);
  const deps = listDepsByProject(projectId);
  sendJson(res, 200, { project, tasks, deps, childSummaries: computeChildSummaries(tasks) });
};

// Step 3: board-as-view. Projects a project's tasks into ordered status lanes —
// a stable read model over the same task graph, with deps + roll-up summaries.
const handlePlanBoard: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const projectId = url.searchParams.get("project_id");
  if (!projectId) {
    return sendError(res, 400, "Missing 'project_id' query param");
  }
  const project = getProject(projectId);
  if (!project) {
    return sendError(res, 404, `Project "${projectId}" not found`);
  }
  reclaimAndEmit();
  const tasks = listTasksByProject(projectId);
  const lanes: Record<string, TaskRow[]> = {};
  for (const status of STATUS_ORDER) lanes[status] = [];
  for (const t of tasks) (lanes[t.status] ??= []).push(t);
  sendJson(res, 200, {
    project,
    lanes,
    deps: listDepsByProject(projectId),
    childSummaries: computeChildSummaries(tasks),
    // Server clock so the cockpit renders lease countdowns against the authority,
    // not the (possibly skewed) client clock. Cockpit computes one offset at fetch.
    now: Date.now(),
  });
};

// Cockpit project picker. Public read — every project + task count, newest first.
const handlePlanProjects: RouteHandler = async (_req, res) => {
  sendJson(res, 200, { projects: listProjects() });
};

// Cockpit Feed backfill. Public read — recent task_event rows for a project,
// chronological. Unknown/garbage project_id yields an empty feed (200), never a
// 404, so a freshly-opened cockpit degrades to "no activity yet" rather than error.
const handlePlanEvents: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const projectId = url.searchParams.get("project_id");
  if (!projectId) {
    return sendError(res, 400, "Missing 'project_id' query param");
  }
  const rawLimit = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;
  sendJson(res, 200, { events: getRecentEvents(projectId, limit) });
};

// Step 3: the board feeder's question — "what does THIS session actively own?"
// Keyed on owner_sid (a session), it powers projecting an instance's claimed
// plan tasks onto its board card (step 3B). Public read.
const handlePlanOwned: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const ownerSid = url.searchParams.get("owner_sid");
  if (!ownerSid) {
    return sendError(res, 400, "Missing 'owner_sid' query param");
  }
  reclaimAndEmit();
  const tasks = listTasksByOwnerSid(ownerSid).map((t) => ({
    id: t.id,
    project_id: t.project_id,
    title: t.title,
    status: t.status,
    owner: t.owner,
    priority: t.priority,
    lease_expires_at: t.lease_expires_at,
  }));
  sendJson(res, 200, { tasks });
};

const handleTaskCreate: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    project_id?: string;
    title?: string;
    detail?: string | null;
    parent_id?: string | null;
    priority?: number;
    deps?: string[];
    by?: string | null;
  };
  if (!body.project_id || typeof body.project_id !== "string") {
    return sendError(res, 400, "Missing or invalid 'project_id' field");
  }
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return sendError(res, 400, "Missing or invalid 'title' field");
  }
  if (!getProject(body.project_id)) {
    return sendError(res, 404, `Project "${body.project_id}" not found`);
  }
  if (body.parent_id && !getTask(body.parent_id)) {
    return sendError(res, 404, `Parent task "${body.parent_id}" not found`);
  }
  // Validate dep targets BEFORE creating the task, so a bogus id 404s instead of
  // silently leaving the new task permanently un-ready (referee F3).
  if (Array.isArray(body.deps)) {
    for (const dep of body.deps) {
      if (typeof dep !== "string" || !getTask(dep)) {
        return sendError(res, 404, `Dependency task "${String(dep)}" not found`);
      }
    }
  }
  const task = createTask(body.project_id, {
    title: body.title.trim(),
    detail: body.detail ?? null,
    parentId: body.parent_id ?? null,
    priority: typeof body.priority === "number" ? body.priority : undefined,
    by: body.by ?? null,
  });
  if (Array.isArray(body.deps)) {
    for (const dep of body.deps as string[]) {
      if (!wouldCreateCycle(task.id, dep)) {
        addDep(task.id, dep);
      }
    }
  }
  emitPlanUpdate(task.project_id, task.id, "task_create");
  sendJson(res, 200, { task });
};

const handleTaskDepAdd: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { task_id?: string; blocks_on?: string };
  if (!body.task_id || typeof body.task_id !== "string") {
    return sendError(res, 400, "Missing or invalid 'task_id' field");
  }
  if (!body.blocks_on || typeof body.blocks_on !== "string") {
    return sendError(res, 400, "Missing or invalid 'blocks_on' field");
  }
  if (!getTask(body.task_id)) {
    return sendError(res, 404, `Task "${body.task_id}" not found`);
  }
  if (!getTask(body.blocks_on)) {
    return sendError(res, 404, `Task "${body.blocks_on}" not found`);
  }
  if (wouldCreateCycle(body.task_id, body.blocks_on)) {
    return sendError(res, 409, "Dependency would create a cycle");
  }
  addDep(body.task_id, body.blocks_on);
  // A late blocker on an already-`ready` task must knock it back to ratified so
  // status never claims ready while a prerequisite is unfinished (F1 invariant).
  demoteIfBlocked(body.task_id);
  emitPlanUpdate(getTask(body.task_id)?.project_id ?? "", body.task_id, "dep_add");
  sendJson(res, 200, { ok: true });
};

const handleTasksReady: RouteHandler = async (_req, res) => {
  reclaimAndEmit();
  const tasks = listReadyTasks().map((t) => ({
    id: t.id,
    project_id: t.project_id,
    title: t.title,
    status: t.status,
    priority: t.priority,
  }));
  sendJson(res, 200, { tasks });
};

const handleTaskClaim: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    task_id?: string;
    owner?: string;
    owner_sid?: string | null;
    actor?: string | null;
  };
  if (!body.task_id || typeof body.task_id !== "string") {
    return sendError(res, 400, "Missing or invalid 'task_id' field");
  }
  if (!body.owner || typeof body.owner !== "string" || !body.owner.trim()) {
    return sendError(res, 400, "Missing or invalid 'owner' field");
  }
  // Reclaim expired leases first so a stale-held target is freed before we try it.
  reclaimAndEmit();
  const result = claimTask(body.task_id, body.owner.trim(), body.owner_sid ?? null, body.actor ?? null);
  if (!result.ok) {
    return sendError(res, result.code, result.error);
  }
  emitPlanUpdate(result.task.project_id, result.task.id, "claim");
  // Step 5: hand the new owner the latest handoff atomically with ownership, so
  // they resume without re-deriving (null when the task has no handoff yet).
  sendJson(res, 200, { task: result.task, handoff: getLatestHandoff(result.task.id) });
};

const handleTaskHeartbeat: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { task_id?: string; owner_sid?: string };
  if (!body.task_id || typeof body.task_id !== "string") {
    return sendError(res, 400, "Missing or invalid 'task_id' field");
  }
  if (!body.owner_sid || typeof body.owner_sid !== "string") {
    return sendError(res, 400, "Missing or invalid 'owner_sid' field");
  }
  const result = heartbeatTask(body.task_id, body.owner_sid);
  if (!result.ok) {
    return sendError(res, result.code, result.error);
  }
  sendJson(res, 200, { task: result.task });
};

// C5 stall radar threshold — canonical definition + rationale live in
// hub/src/constants.ts (STALL_BEAT_MS, env-tunable via AF_STALL_BEAT_SECONDS). Used just
// below to flag a quiet-but-still-leased owner as a likely dead agent.

// Step 3B: every plan task any session currently holds, across all projects, for
// the dashboard to join onto board cards by owner_sid. Sweep expired leases first
// (same lazy-reclaim as the other reads) so a dead instance's task drops out instead
// of showing as still-claimed. Lean projection — no detail/artifacts on the wire.
const handlePlanInflight: RouteHandler = async (_req, res) => {
  reclaimAndEmit();
  const now = Date.now();
  // C5: resolve a task's owner_sid → board name → last heartbeat. Build the sid→name
  // map once (board rows carry both), then look up getLastSeen(name) per task.
  const nameBySid = new Map<string, string>();
  for (const b of dbListBoard()) if (b.sid) nameBySid.set(b.sid, b.name);
  const tasks = listInflightTasks().map((t) => {
    const governed = t.status === "claimed" || t.status === "in_progress";
    const name = t.owner_sid ? nameBySid.get(t.owner_sid) : undefined;
    const lastSeenAt = name ? getLastSeen(name) : 0;
    // Beat age only meaningful for a lease-governed task with a known, still-valid lease.
    const leaseValid = t.lease_expires_at != null && t.lease_expires_at - now > 0;
    const lastBeatAgeMs =
      governed && leaseValid && lastSeenAt > 0 ? Math.max(0, now - lastSeenAt) : null;
    const stalled = lastBeatAgeMs != null && lastBeatAgeMs > STALL_BEAT_MS;
    return {
      id: t.id,
      project_id: t.project_id,
      title: t.title,
      status: t.status,
      owner: t.owner,
      owner_sid: t.owner_sid,
      claimed_at: t.claimed_at,
      lease_expires_at: t.lease_expires_at,
      // C5 dead-agent radar — last heartbeat age and a derived stall flag.
      last_seen_at: lastSeenAt > 0 ? lastSeenAt : null,
      last_beat_age_ms: lastBeatAgeMs,
      stalled,
    };
  });
  sendJson(res, 200, { now, tasks });
};

// Wave-4.1 (a): surface the Wave-4 (d) dead-blocker wedge to the operator. A ratified
// task whose blocker is failed/abandoned/missing waits FOREVER (allBlockersDone is
// fail-closed by design) — (d) logs a one-shot blocker_wedge event but nothing showed
// it. This read returns every currently-wedged task with its dead blockers so the
// cockpit can flag them. CALL-only into machine.wedgedTasks() (machine.ts is 3b92's
// W4.1-c surface — not written here). Reclaim-sweep first, like the other plan reads,
// so a just-reclaimed blocker is reflected. Global (all projects); the cockpit filters
// to its project, mirroring /plan-inflight.
const handlePlanWedged: RouteHandler = async (_req, res) => {
  reclaimAndEmit();
  sendJson(res, 200, { tasks: wedgedTasks() });
};

// Step 4B: session-scoped lease renewal for the all-tools heartbeat hook. The hook
// knows only the session id (not task ids), so this renews EVERY lease-governed
// task the session holds in one call. No SSE emit — the cockpit ticks lease
// countdowns locally via setInterval from lease_expires_at + server clock offset,
// so a heartbeat push would only trigger an unnecessary full /plan-board refetch.
// The new lease_expires_at reaches the cockpit on the next real plan_update (a
// transition, claim, etc.) which always follows eventually.
// D4: anti-zombie liveness gate. Uses the board registry (same source as GET /board)
// to look up which agent name is bound to the posted owner_sid. If a board entry
// carries that sid but the named agent is no longer registered (unregistered/dead),
// the renewal is silently skipped and reclaim reaps the task normally — preventing a
// zombie from holding tasks indefinitely via rogue heartbeats. Sids with NO board
// entry are allowed through unchanged (fail-open / backward compat) because the
// heartbeatByOwnerSid call already returns [] when no tasks match the sid.
const handlePlanHeartbeat: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { owner_sid?: string };
  if (!body.owner_sid || typeof body.owner_sid !== "string") {
    return sendError(res, 400, "Missing or invalid 'owner_sid' field");
  }
  // D4: look up the board entry bound to this sid. Only skip when the entry EXISTS
  // and the bound agent is no longer registered — an unregistered/dead instance
  // whose tasks should be reclaimed, not refreshed.
  const boundEntry = dbListBoard().find((b) => b.sid === body.owner_sid);
  if (boundEntry && !isUserRegistered(boundEntry.name)) {
    console.log(
      `[plan-heartbeat] D4: skip renewal — sid ${body.owner_sid} bound to unregistered "${boundEntry.name}"`,
    );
    return sendJson(res, 200, { ok: true, renewed: 0, skipped: true });
  }
  const renewed = heartbeatByOwnerSid(body.owner_sid);
  sendJson(res, 200, { ok: true, renewed: renewed.length });
};

const handleTaskArtifact: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    task_id?: string;
    kind?: string;
    uri?: string;
    note?: string | null;
    actor?: string | null;
  };
  if (!body.task_id || typeof body.task_id !== "string") {
    return sendError(res, 400, "Missing or invalid 'task_id' field");
  }
  if (!body.kind || typeof body.kind !== "string") {
    return sendError(res, 400, "Missing or invalid 'kind' field");
  }
  if (!body.uri || typeof body.uri !== "string") {
    return sendError(res, 400, "Missing or invalid 'uri' field");
  }
  const task = addArtifact(body.task_id, { kind: body.kind, uri: body.uri, note: body.note ?? null }, body.actor ?? null);
  if (!task) {
    return sendError(res, 404, `Task "${body.task_id}" not found`);
  }
  emitPlanUpdate(task.project_id, task.id, "artifact");
  sendJson(res, 200, { task });
};

// Step 5: write a durable handoff (append-only). join-token + recorded actor,
// NOT owner-gated — a reviewer/operator leaving resume notes is valid and the
// append-only log protects prior notes (B4). Never touches the lease (B3).
const handleTaskHandoff: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    task_id?: string;
    actor?: string | null;
    summary?: string;
    next_step?: string | null;
    blockers?: string[];
    artifacts?: Array<{ kind?: string; uri?: string; note?: string | null }>;
  };
  if (!body.task_id || typeof body.task_id !== "string") {
    return sendError(res, 400, "Missing or invalid 'task_id' field");
  }
  if (!body.summary || typeof body.summary !== "string" || !body.summary.trim()) {
    return sendError(res, 400, "Missing or invalid 'summary' field");
  }
  const task = getTask(body.task_id);
  if (!task) {
    return sendError(res, 404, `Task "${body.task_id}" not found`);
  }
  const blockers = Array.isArray(body.blockers) ? body.blockers.filter((b) => typeof b === "string") : [];
  addHandoff(body.task_id, body.actor ?? null, {
    summary: body.summary.trim(),
    next_step: typeof body.next_step === "string" ? body.next_step : null,
    blockers,
  });
  // Artifacts ride the existing append-only artifact array.
  if (Array.isArray(body.artifacts)) {
    for (const a of body.artifacts) {
      if (a && typeof a.kind === "string" && typeof a.uri === "string") {
        addArtifact(body.task_id, { kind: a.kind, uri: a.uri, note: a.note ?? null }, body.actor ?? null);
      }
    }
  }
  emitPlanUpdate(task.project_id, body.task_id, "handoff");
  sendJson(res, 200, { handoff: getLatestHandoff(body.task_id) });
};

const handleTaskHandoffs: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const taskId = url.searchParams.get("task_id");
  if (!taskId) {
    return sendError(res, 400, "Missing 'task_id' query param");
  }
  const task = getTask(taskId);
  if (!task) {
    return sendError(res, 404, `Task "${taskId}" not found`);
  }
  const artifacts = task.artifacts ? (JSON.parse(task.artifacts) as unknown[]) : [];
  sendJson(res, 200, { handoffs: getHandoffs(taskId), artifacts });
};

const handleAdminTaskForce: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { task_id?: string; to?: string; actor?: string | null };
  if (!body.task_id || typeof body.task_id !== "string") {
    return sendError(res, 400, "Missing or invalid 'task_id' field");
  }
  if (!body.to || typeof body.to !== "string") {
    return sendError(res, 400, "Missing or invalid 'to' field");
  }
  const result = forceTransition(body.task_id, body.to, body.actor ?? null);
  if (!result.ok) {
    return sendError(res, result.code, result.error);
  }
  emitPlanUpdate(result.task.project_id, result.task.id, "force");
  sendJson(res, 200, { task: result.task });
};

const handleTaskTransition: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    task_id?: string;
    to?: string;
    actor?: string | null;
    note?: string | null;
  };
  if (!body.task_id || typeof body.task_id !== "string") {
    return sendError(res, 400, "Missing or invalid 'task_id' field");
  }
  if (!body.to || typeof body.to !== "string") {
    return sendError(res, 400, "Missing or invalid 'to' field");
  }
  const result = transitionTask(body.task_id, body.to, body.actor ?? null, body.note ?? null);
  if (!result.ok) {
    return sendError(res, result.code, result.error);
  }
  emitPlanUpdate(result.task.project_id, result.task.id, "transition");
  // Board auto-digest v1: auto-seed a logbook row when a task reaches a terminal
  // OUTCOME (done/blocked) — the WHAT/WHEN timeline, attributed by the hub itself
  // (zero agent action, no MCP bump, broadcast wakes no one). NARROW by design:
  // ONLY these two real outcomes, never the routine claimed/in_progress/review
  // churn (already current-state on the card), so the last-5 view stays
  // findings-first, not flip-spam. The note prefix marks it as an auto task-row,
  // distinct from a free-form manual finding. (Converged plan: 15a985 + REFEREE.)
  maybeAutoSeedTaskLog(result.task, body.actor ?? null, body.note ?? null);
  sendJson(res, 200, { task: result.task });
};

// Auto-seed mapping: only terminal outcomes become a log row, and they reuse the
// existing kind vocabulary (done → "done", blocked → "blocker") so the dashboard
// chips render unchanged. Any other status is intentionally a no-op.
const AUTO_LOG_KIND_BY_STATUS: Record<string, string> = { done: "done", blocked: "blocker" };

function maybeAutoSeedTaskLog(task: { id: string; title: string; status: string; owner: string | null }, actor: string | null, note: string | null): void {
  const kind = AUTO_LOG_KIND_BY_STATUS[task.status];
  if (!kind) return;
  // Attribute to the task OWNER (whose work it is), not the transition actor: a
  // review→done is driven by a different APPROVER, but the completion belongs on
  // the owner's timeline. Fall back to the actor (e.g. owner-driven block), and
  // skip entirely when neither is set (e.g. an unclaimed parent auto-completing
  // on child rollup — that's a graph event, not an agent's outcome).
  const name = (task.owner && task.owner.trim()) || (actor && actor.trim());
  if (!name) return;
  const title = (task.title || task.id).trim();
  const extra = note && note.trim() ? ` — ${note.trim()}` : "";
  const text = `Task ${task.status}: ${title}${extra}`.slice(0, BOARD_TEXT_MAX);
  const entry = dbInsertLog(name, kind, text);
  broadcast({
    type: "agent_log",
    name: entry.name,
    entry: { id: entry.id, ts: entry.ts, kind: entry.kind, note: entry.note },
    timestamp: entry.ts,
  });
  console.log(`[log:auto] ${name} [${kind}]: ${text}`);
}

// === C4: resource_lock endpoints ===
// Default lease: 5 minutes. Callers override via lease_ms.
const RESOURCE_LOCK_DEFAULT_LEASE_MS = 5 * 60 * 1000;
// Wave-4 (a): upper clamp on a caller-supplied lease. Resource locks have NO
// time-based reaper — an expired lock is reclaimed lazily, only when a RIVAL tries to
// acquire (dbAcquireResourceLock's `ON CONFLICT … WHERE lease_expires_at < now`). So
// an unbounded lease_ms lets a buggy or dead holder pin a contended surface for an
// arbitrary TTL with nothing to free it. Cap it. Same invariant family as (b)'s
// plan-lease<board-reap guard: NO LEASE OUTLIVES ITS RECLAIM WINDOW. Default ceiling is
// the board-reap horizon (1h); tune via AF_RESOURCE_LOCK_MAX_LEASE_SECONDS.
const RESOURCE_LOCK_MAX_LEASE_MS = parseInt(process.env.AF_RESOURCE_LOCK_MAX_LEASE_SECONDS ?? process.env.WT_RESOURCE_LOCK_MAX_LEASE_SECONDS ?? "3600", 10) * 1000;

// Resolve the effective lease for acquire/renew: honor a positive caller lease_ms,
// clamp it down to the sane maximum, and fall back to the default when absent/invalid.
function resolveResourceLeaseMs(requested: number | undefined): number {
  if (typeof requested !== "number" || !(requested > 0)) return RESOURCE_LOCK_DEFAULT_LEASE_MS;
  return Math.min(requested, RESOURCE_LOCK_MAX_LEASE_MS);
}

const handleResourceLockAcquire: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    resource_key?: string;
    owner_sid?: string;
    lease_ms?: number;
  };
  if (!body.resource_key || typeof body.resource_key !== "string") {
    return sendError(res, 400, "Missing or invalid 'resource_key' field");
  }
  if (!body.owner_sid || typeof body.owner_sid !== "string") {
    return sendError(res, 400, "Missing or invalid 'owner_sid' field");
  }
  const now = Date.now();
  const leaseMs = resolveResourceLeaseMs(body.lease_ms);
  const acquired = dbAcquireResourceLock(body.resource_key, body.owner_sid, now + leaseMs, now);
  if (!acquired) {
    const existing = dbGetResourceLock(body.resource_key);
    return sendError(res, 409, `Resource '${body.resource_key}' is locked by another session (expires ${existing?.lease_expires_at ?? "?"})`);
  }
  const lock = dbGetResourceLock(body.resource_key) as ResourceLockRow;
  sendJson(res, 200, { lock });
};

const handleResourceLockRenew: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    resource_key?: string;
    owner_sid?: string;
    lease_ms?: number;
  };
  if (!body.resource_key || typeof body.resource_key !== "string") {
    return sendError(res, 400, "Missing or invalid 'resource_key' field");
  }
  if (!body.owner_sid || typeof body.owner_sid !== "string") {
    return sendError(res, 400, "Missing or invalid 'owner_sid' field");
  }
  const leaseMs = resolveResourceLeaseMs(body.lease_ms);
  const renewed = dbRenewResourceLock(body.resource_key, body.owner_sid, Date.now() + leaseMs);
  if (!renewed) {
    return sendError(res, 404, `No active lock on '${body.resource_key}' held by this session`);
  }
  const lock = dbGetResourceLock(body.resource_key) as ResourceLockRow;
  sendJson(res, 200, { lock });
};

const handleResourceLockRelease: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { resource_key?: string; owner_sid?: string };
  if (!body.resource_key || typeof body.resource_key !== "string") {
    return sendError(res, 400, "Missing or invalid 'resource_key' field");
  }
  if (!body.owner_sid || typeof body.owner_sid !== "string") {
    return sendError(res, 400, "Missing or invalid 'owner_sid' field");
  }
  const released = dbReleaseResourceLock(body.resource_key, body.owner_sid);
  if (!released) {
    return sendError(res, 404, `No active lock on '${body.resource_key}' held by this session`);
  }
  sendJson(res, 200, { released: true });
};

const handleResourceLockGet: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const key = url.searchParams.get("resource_key");
  if (!key) {
    return sendError(res, 400, "Missing 'resource_key' query param");
  }
  const lock = dbGetResourceLock(key);
  sendJson(res, 200, { lock: lock ?? null });
};
// === end C4 ===

// Rewake resolver: map a Claude session id (sid) -> its CURRENT callsign from the
// registry row. The rewake/msgcheck Stop hooks call this instead of trusting the
// static /tmp/wt-callsign-<sid> file, which goes stale on an identity rename
// (become_referee / claim_referee / operator re-register) and then strands the
// poller on a dead callsign. No-auth, like /users: it returns only a name the
// caller already owns by sid, and the hooks must read it with zero token plumbing.
// 404 when no registry row maps to that sid.
const handleWhoami: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const sid = url.searchParams.get("sid");
  if (!sid) return sendError(res, 400, "Missing 'sid' query parameter");
  const name = dbGetRegistryCallsign(sid);
  if (!name) return sendError(res, 404, "no registry row for sid");
  sendJson(res, 200, { name });
};

// ── Loop governor (Phase 1): registry + stop-condition engine ──────────────────
// Owner ops (create/tick/pause/resume/stop/get/list) are PROTECTED routes so the
// hub authenticates the caller per-session. pause/resume/stop additionally require
// caller === owner. Operator force-stop is a separate admin-token route below.
const handleLoopCreate: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as {
    kind?: string;
    label?: string;
    owner_sid?: string | null;
    config?: LoopConfig;
    // Phase 3: set interval_ms to register a RECURRING loop; anchor_ms is the
    // optional wall-clock grid origin (defaults to the creation time).
    interval_ms?: number | null;
    anchor_ms?: number | null;
  };
  if (!body.kind || typeof body.kind !== "string") {
    return sendError(res, 400, "Missing or invalid 'kind' field");
  }
  if (!body.label || typeof body.label !== "string") {
    return sendError(res, 400, "Missing or invalid 'label' field");
  }
  let loop;
  try {
    loop = createLoop({
      kind: body.kind,
      label: body.label,
      owner_callsign: userName as string,
      owner_sid: body.owner_sid ?? null,
      config: body.config ?? {},
      interval_ms: body.interval_ms ?? null,
      anchor_ms: body.anchor_ms ?? null,
    });
  } catch (e) {
    // computeNextFire rejects a non-positive interval_ms.
    return sendError(res, 400, (e as Error).message);
  }
  sendJson(res, 200, { loop });
};

const handleLoopTick: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    id?: string;
    iteration_delta?: number;
    tokens_delta?: number;
    improvement?: number;
    completeness?: number;
    confidence?: number;
    signature?: string;
    verdict?: Verdict;
  };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  if (!getLoop(body.id)) return sendError(res, 404, `Loop "${body.id}" not found`);
  const result = tickLoop(body.id, {
    iteration_delta: body.iteration_delta,
    tokens_delta: body.tokens_delta,
    improvement: body.improvement,
    completeness: body.completeness,
    confidence: body.confidence,
    signature: body.signature,
    verdict: body.verdict,
  });
  // Phase 5: an escalate verdict opens a HITL approval and parks the loop — fan a live
  // signal to the cockpit (additive SSE event; no cockpit-ui.ts edit) so the operator's
  // approval queue lights up without a poll.
  if (result.approval_id) {
    broadcast({
      type: "loop_approval",
      loop_id: body.id,
      approval_id: result.approval_id,
      status: "pending",
      timestamp: Date.now(),
    });
  }
  // Phase 5: feed the loop's recent reflexion memory back on each tick so the agent gets
  // its prior reflections without a second round-trip. Only attached when present, so a
  // loop with no reflections still returns the bare {continue:...} contract.
  const reflections = listReflections(body.id, 10);
  const payload: Record<string, unknown> = { ...result };
  if (reflections.length) payload.reflections = reflections;
  sendJson(res, 200, payload);
};

// Phase 4 — evaluator-optimizer: submit a judge's structured verdict for this iteration.
// Any member may submit (like /loop-tick — running the loop, not controlling its lifecycle).
// Returns {result, loop} so the caller (and the cockpit) sees the updated score trajectory.
const handleLoopVerdict: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    id?: string;
    verdict?: unknown;
    iteration_delta?: number;
    tokens_delta?: number;
  };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  if (body.verdict === undefined) return sendError(res, 400, "Missing 'verdict' field");
  if (!getLoop(body.id)) return sendError(res, 404, `Loop "${body.id}" not found`);
  let result: ReturnType<typeof submitVerdict>;
  try {
    result = submitVerdict(body.id, body.verdict, {
      iteration_delta: body.iteration_delta,
      tokens_delta: body.tokens_delta,
    });
  } catch (e) {
    return sendError(res, 400, (e as Error).message);
  }
  sendJson(res, 200, { result, loop: getLoop(body.id) });
};

// Shared owner-gated lifecycle (pause/resume/stop): only the loop owner may control it.
async function handleLoopOwnerOp(
  req: IncomingMessage,
  res: ServerResponse,
  userName: string | undefined,
  action: (id: string, reason?: StopReason) => unknown,
): Promise<void> {
  const body = JSON.parse(await readBody(req)) as { id?: string; reason?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const loop = getLoop(body.id);
  if (!loop) return sendError(res, 404, `Loop "${body.id}" not found`);
  if (loop.owner_callsign !== userName) {
    return sendError(res, 403, "Only the loop owner can control this loop");
  }
  const updated = action(body.id, body.reason as StopReason | undefined);
  sendJson(res, 200, { loop: updated });
}

const handleLoopPause: RouteHandler = (req, res, userName) =>
  handleLoopOwnerOp(req, res, userName, (id) => pauseLoop(id));
const handleLoopResume: RouteHandler = (req, res, userName) =>
  handleLoopOwnerOp(req, res, userName, (id) => resumeLoop(id));
const handleLoopStop: RouteHandler = (req, res, userName) =>
  handleLoopOwnerOp(req, res, userName, (id, reason) => stopLoop(id, reason ?? "external_terminate"));

const handleLoopGet: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { id?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  const loop = getLoop(body.id);
  if (!loop) return sendError(res, 404, `Loop "${body.id}" not found`);
  // Phase 5: surface the open HITL approval (if any) alongside the loop so the owner can
  // see it's parked awaiting an operator decision.
  const pending = getPendingApprovalForLoop(body.id);
  sendJson(res, 200, pending ? { loop, pending_approval: pending } : { loop });
};

const handleLoopList: RouteHandler = async (req, res) => {
  const raw = await readBody(req);
  const body = (raw ? JSON.parse(raw) : {}) as { status?: string; owner_callsign?: string };
  const loops = listLoops({
    status: body.status as LoopStatus | undefined,
    owner_callsign: body.owner_callsign,
  });
  sendJson(res, 200, { loops });
};

// Phase 3 read route (PUBLIC, like /board): the scheduled-vs-actual fire view the
// cockpit's loops card renders. Each entry is the shared loop DTO from
// summarizeLoopSchedule (schedule fields are null on non-recurring loops). `now` is
// the server clock so the cockpit computes one shared offset for overdue/aging.
// P2's admin /loop-admin-list returns this same per-loop object as a superset.
const handleLoops: RouteHandler = async (_req, res) => {
  const now = Date.now();
  const loops = listLoops().map((l) => summarizeLoopSchedule(l, now));
  sendJson(res, 200, { loops, now });
};

// ── Reflexion memory (Phase 5): per-loop reflections fed back across retries ──────
// Owner-authenticated like the rest of the loop routes; the caller's callsign is
// recorded as the reflecting agent. Anyone who can tick can reflect.
const handleLoopReflect: RouteHandler = async (req, res, userName) => {
  const body = JSON.parse(await readBody(req)) as {
    loop_id?: string;
    reflection?: string;
    iteration?: number;
  };
  if (!body.loop_id || typeof body.loop_id !== "string") {
    return sendError(res, 400, "Missing or invalid 'loop_id' field");
  }
  if (!body.reflection || typeof body.reflection !== "string" || !body.reflection.trim()) {
    return sendError(res, 400, "Missing or invalid 'reflection' field");
  }
  if (!getLoop(body.loop_id)) return sendError(res, 404, `Loop "${body.loop_id}" not found`);
  const { id, count } = addReflection({
    loop_id: body.loop_id,
    agent_callsign: userName as string,
    reflection: body.reflection,
    iteration: body.iteration,
  });
  sendJson(res, 200, { ok: true, id, count });
};

const handleLoopReflections: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { loop_id?: string; limit?: number };
  if (!body.loop_id || typeof body.loop_id !== "string") {
    return sendError(res, 400, "Missing or invalid 'loop_id' field");
  }
  if (!getLoop(body.loop_id)) return sendError(res, 404, `Loop "${body.loop_id}" not found`);
  sendJson(res, 200, { reflections: listReflections(body.loop_id, body.limit) });
};

// Operator force-stop (admin-token): terminate ANY loop regardless of owner.
const handleLoopAdminStop: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as { id?: string; reason?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  if (!getLoop(body.id)) return sendError(res, 404, `Loop "${body.id}" not found`);
  const updated = stopLoop(body.id, (body.reason as StopReason) ?? "external_terminate");
  sendJson(res, 200, { loop: updated });
};

// ── Operator loop visibility + override controls (Phase 2, admin-token) ────────
// The cockpit holds only the admin token (never a per-session member token), so it
// reads/controls loops through these admin routes — mirroring /loop-admin-stop:
// operator override, NO owner check. All three are pure pass-throughs to the
// Phase-1 engine (listLoops/pauseLoop/resumeLoop), zero semantic change.
const handleLoopAdminList: RouteHandler = async (_req, res) => {
  // `now` lets the cockpit compute the wall-clock cap locally against a server clock
  // (same contract as /board and /plan-board).
  sendJson(res, 200, { loops: listLoops(), now: Date.now() });
};

async function handleLoopAdminOp(
  req: IncomingMessage,
  res: ServerResponse,
  action: (id: string) => unknown,
): Promise<void> {
  const body = JSON.parse(await readBody(req)) as { id?: string };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  if (!getLoop(body.id)) return sendError(res, 404, `Loop "${body.id}" not found`);
  sendJson(res, 200, { loop: action(body.id) });
}

const handleLoopAdminPause: RouteHandler = (req, res) =>
  handleLoopAdminOp(req, res, (id) => pauseLoop(id));
const handleLoopAdminResume: RouteHandler = (req, res) =>
  handleLoopAdminOp(req, res, (id) => resumeLoop(id));

// ── HITL approval queue (Phase 5) — operator-gated, mirrors the REFEREE/admin gate ──
// List approvals (default: only pending — the live work queue). Optional ?status= and
// ?loop_id= filters. Admin-token route: this is an operator-facing surface.
const handleLoopApprovals: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const statusRaw = url.searchParams.get("status");
  const status = (statusRaw ?? "pending") as ApprovalStatus | "all";
  const loopId = url.searchParams.get("loop_id") ?? undefined;
  const approvals = listApprovals({
    status: status === "all" ? undefined : (status as ApprovalStatus),
    loop_id: loopId,
  });
  sendJson(res, 200, { approvals });
};

// Operator decision on a pending approval. approve → resume the parked loop; reject →
// terminate it. NO auto-approve exists anywhere — a paused-on-escalate loop only moves
// from here. Admin-token gated (adminRoutes), mirroring /loop-admin-stop and the REFEREE
// direct-auth pattern.
const handleLoopApprovalResolve: RouteHandler = async (req, res) => {
  const body = JSON.parse(await readBody(req)) as {
    id?: string;
    decision?: string;
    by?: string;
    note?: string;
  };
  if (!body.id || typeof body.id !== "string") {
    return sendError(res, 400, "Missing or invalid 'id' field");
  }
  if (body.decision !== "approve" && body.decision !== "reject") {
    return sendError(res, 400, "Field 'decision' must be 'approve' or 'reject'");
  }
  const approval = getApproval(body.id);
  if (!approval) return sendError(res, 404, `Approval "${body.id}" not found`);
  if (approval.status !== "pending") {
    return sendError(res, 409, `Approval "${body.id}" already ${approval.status}`);
  }
  const decidedBy = body.by ?? "operator";
  const status: ApprovalStatus = body.decision === "approve" ? "approved" : "rejected";
  // Act on the loop first, then record the decision — so a missing loop fails before we
  // mark the queue item decided.
  const loop =
    body.decision === "approve"
      ? resumeLoop(approval.loop_id)
      : stopLoop(approval.loop_id, "external_terminate");
  const resolved = resolveApproval(body.id, status, decidedBy, body.note);
  broadcast({
    type: "loop_approval",
    loop_id: approval.loop_id,
    approval_id: body.id,
    status,
    timestamp: Date.now(),
  });
  sendJson(res, 200, { approval: resolved, loop });
};

// Vendored cockpit assets directory. The compiled server runs from hub/dist/, so
// the static dir is one level up (hub/static). Resolved from this module's URL so
// it works regardless of cwd.
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static", "vendor");
const VENDOR_MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
async function serveVendorFile(urlPath: string, res: ServerResponse): Promise<void> {
  // urlPath is like "/vendor/xterm.js". Strip the prefix and resolve under
  // VENDOR_DIR with a traversal guard (the resolved path MUST stay inside).
  const rel = urlPath.slice("/vendor/".length);
  const resolved = normalize(join(VENDOR_DIR, rel));
  if (!resolved.startsWith(VENDOR_DIR + "/") && resolved !== VENDOR_DIR) {
    sendError(res, 403, "Forbidden");
    return;
  }
  try {
    const st = await stat(resolved);
    if (!st.isFile()) {
      sendError(res, 404, "Not found");
      return;
    }
    const ext = resolved.slice(resolved.lastIndexOf("."));
    res.writeHead(200, {
      "Content-Type": VENDOR_MIME[ext] ?? "application/octet-stream",
      // Vendored libs are immutable for a given build; allow caching.
      "Cache-Control": "public, max-age=86400",
    });
    createReadStream(resolved).pipe(res);
  } catch {
    sendError(res, 404, "Not found");
  }
}

// Interactive terminal — mint a single-use, short-lived ticket for a WS attach to
// a target callsign's live tmux session. Gated by the SAME browser gate as the
// cockpit (admin token OR scoped cockpit token — it lives in adminRoutes). The
// ticket is the ONLY auth the WS endpoint accepts; minted ONLY when the callsign
// has a verified-live tmux session (so a stale registry row can't open a tunnel).
const handleTerminalTicket: RouteHandler = async (req, res) => {
  const raw = await readBody(req);
  let body: { callsign?: unknown };
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return sendError(res, 400, "Invalid JSON body");
  }
  const callsign = typeof body.callsign === "string" ? body.callsign.trim() : "";
  if (!callsign) return sendError(res, 400, "callsign is required");
  // The browser gate proved this request is the operator; we have no per-user
  // identity on the cockpit lane, so audit under "operator".
  const ticket = mintTerminalTicket(callsign, "operator");
  if (!ticket) {
    return sendError(res, 409, `No live tmux session for callsign "${callsign}"`);
  }
  sendJson(res, 200, { ticket: ticket.token, callsign: ticket.callsign, expiresAt: ticket.expiresAt });
};

const publicRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/users": { method: "GET", handler: handleUsers },
  "/whoami": { method: "GET", handler: handleWhoami },
  "/loops": { method: "GET", handler: handleLoops },
  "/channels": { method: "GET", handler: handleListChannels },
  "/board": { method: "GET", handler: handleBoard },
  "/agent-log-tail": { method: "GET", handler: handleAgentLogTail },
  "/agent-log-digest": { method: "GET", handler: handleAgentLogDigest },
  "/registry": { method: "GET", handler: handleRegistry },
  "/plan-get": { method: "GET", handler: handlePlanGet },
  "/plan-board": { method: "GET", handler: handlePlanBoard },
  "/plan-owned": { method: "GET", handler: handlePlanOwned },
  "/plan-projects": { method: "GET", handler: handlePlanProjects },
  "/plan-events": { method: "GET", handler: handlePlanEvents },
  "/plan-inflight": { method: "GET", handler: handlePlanInflight },
  "/plan-wedged": { method: "GET", handler: handlePlanWedged },
  "/tasks-ready": { method: "GET", handler: handleTasksReady },
  "/task-handoffs": { method: "GET", handler: handleTaskHandoffs },
};

// Local patch: per-recipient pending counts (join-token auth). Returns
// { counts, queued } — `counts` = messages each recipient is directly addressed
// in (drives ping/wake hooks); `queued` = raw queue depth incl. @all broadcasts.
const handlePendingCounts: RouteHandler = async (_req, res) => {
  sendJson(res, 200, pendingCounts());
};

const joinRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/register": { method: "POST", handler: handleRegister },
  "/session-register": { method: "POST", handler: handleSessionRegister },
  "/pending-counts": { method: "GET", handler: handlePendingCounts },
  "/board-update": { method: "POST", handler: handleBoardUpdate },
  "/agent-log": { method: "POST", handler: handleAgentLog },
  "/project-create": { method: "POST", handler: handleProjectCreate },
  "/task-create": { method: "POST", handler: handleTaskCreate },
  "/task-transition": { method: "POST", handler: handleTaskTransition },
  "/task-dep-add": { method: "POST", handler: handleTaskDepAdd },
  "/task-claim": { method: "POST", handler: handleTaskClaim },
  "/task-heartbeat": { method: "POST", handler: handleTaskHeartbeat },
  "/plan-heartbeat": { method: "POST", handler: handlePlanHeartbeat },
  "/task-handoff": { method: "POST", handler: handleTaskHandoff },
  "/task-artifact": { method: "POST", handler: handleTaskArtifact },
  // === C4: resource lock endpoints ===
  "/resource-lock-acquire": { method: "POST", handler: handleResourceLockAcquire },
  "/resource-lock-renew": { method: "POST", handler: handleResourceLockRenew },
  "/resource-lock-release": { method: "POST", handler: handleResourceLockRelease },
  "/resource-lock-get": { method: "GET", handler: handleResourceLockGet },
};

// ── Operator Control Panel (WS-B) — zero-terminal fleet ops, bearer-gated ──
// Thin handlers over ./operator-control.js; all logic + validation lives there.

const handleLaunchReferee: RouteHandler = async (_req, res) => {
  sendJson(res, 200, launchReferee());
};

const handleConductorConfig: RouteHandler = async (req, res) => {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendError(res, 400, "Invalid JSON body");
  }
  const v = validateConductorConfig(body);
  if (!v.ok) return sendError(res, 400, v.error);
  const control = writeControlMerged(v.value, new Date().toISOString());
  sendJson(res, 200, { ok: true, control });
};

const handleConductorStatus: RouteHandler = async (_req, res) => {
  sendJson(res, 200, { ok: true, ...conductorStatus() });
};

const handleConductorStart: RouteHandler = async (_req, res) => {
  sendJson(res, 200, startConductor());
};

const handleConductorStop: RouteHandler = async (_req, res) => {
  sendJson(res, 200, stopConductor());
};

const handleFleetMax: RouteHandler = async (req, res) => {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendError(res, 400, "Invalid JSON body");
  }
  const v = validateFleetMax(body);
  if (!v.ok) return sendError(res, 400, v.error);
  sendJson(res, 200, { ok: true, settings: writeFleetMax(v.value) });
};

const adminRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/kick": { method: "POST", handler: handleKick },
  "/kick-all": { method: "POST", handler: handleKickAll },
  "/admin-send": { method: "POST", handler: handleAdminSend },
  "/admin-register": { method: "POST", handler: handleAdminRegister },
  "/admin-channel-create": { method: "POST", handler: handleAdminChannelCreate },
  "/admin-channel-delete": { method: "POST", handler: handleAdminChannelDelete },
  "/admin-channel-history": { method: "GET", handler: handleAdminChannelHistory },
  "/admin-board-delete": { method: "POST", handler: handleAdminBoardDelete },
  "/admin-mark-read": { method: "POST", handler: handleAdminMarkRead },
  "/admin-unread-counts": { method: "GET", handler: handleAdminUnreadCounts },
  "/admin-operator-inbox": { method: "GET", handler: handleAdminOperatorInbox },
  "/admin-agent-configs": { method: "GET", handler: handleAdminAgentConfigs },
  "/admin-agent-config-create": { method: "POST", handler: handleAdminAgentConfigCreate },
  "/admin-agent-config-update": { method: "POST", handler: handleAdminAgentConfigUpdate },
  "/admin-agent-config-delete": { method: "POST", handler: handleAdminAgentConfigDelete },
  "/admin-agent-start": { method: "POST", handler: handleAdminAgentStart },
  "/admin-task-force": { method: "POST", handler: handleAdminTaskForce },
  // Operator Control Panel (WS-B)
  "/admin-launch-referee": { method: "POST", handler: handleLaunchReferee },
  "/admin-conductor-config": { method: "POST", handler: handleConductorConfig },
  "/admin-conductor-status": { method: "GET", handler: handleConductorStatus },
  "/admin-conductor-start": { method: "POST", handler: handleConductorStart },
  "/admin-conductor-stop": { method: "POST", handler: handleConductorStop },
  "/admin-fleet-max": { method: "POST", handler: handleFleetMax },
  // Cockpit "+ New Plan": admin-bearer alias of /project-create so the operator can
  // create a project from the UI, which holds only the admin token (the join-token
  // /project-create is not reachable from the browser). Same handler — auth differs
  // by route table: this one is gated on adminToken, broadcasts project_create, and
  // the cockpit's onPlanUpdate refreshes the picker live.
  "/admin-project-create": { method: "POST", handler: handleProjectCreate },
  "/admin-project-delete": { method: "POST", handler: handleProjectDelete },
  // Loop governor — operator force-stop: terminate any loop regardless of owner.
  "/loop-admin-stop": { method: "POST", handler: handleLoopAdminStop },
  // Loop governor — operator visibility + override (cockpit, Phase 2): admin-token
  // read of all loops + override pause/resume (no owner check), same guard as -stop.
  "/loop-admin-list": { method: "GET", handler: handleLoopAdminList },
  "/loop-admin-pause": { method: "POST", handler: handleLoopAdminPause },
  "/loop-admin-resume": { method: "POST", handler: handleLoopAdminResume },
  // Loop Phase 5 (HITL) — operator-gated approval queue: list + approve/reject.
  "/loop-approvals": { method: "GET", handler: handleLoopApprovals },
  "/loop-approval-resolve": { method: "POST", handler: handleLoopApprovalResolve },
  // Interactive terminal — mint a single-use WS ticket for a callsign's tmux session.
  "/terminal-ticket": { method: "POST", handler: handleTerminalTicket },
};

const protectedRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/send": { method: "POST", handler: handleSend },
  "/poll": { method: "GET", handler: handlePoll },
  "/inbox": { method: "GET", handler: handleInbox },
  "/ack": { method: "POST", handler: handleAck },
  "/unregister": { method: "POST", handler: handleUnregister },
  "/claim-referee": { method: "POST", handler: handleClaimReferee },
  "/channel-create": { method: "POST", handler: handleChannelCreate },
  "/channel-join": { method: "POST", handler: handleChannelJoin },
  "/channel-leave": { method: "POST", handler: handleChannelLeave },
  "/channel-invite": { method: "POST", handler: handleChannelInvite },
  "/channel-history": { method: "GET", handler: handleChannelHistory },
  "/messages": { method: "GET", handler: handleMessages },
  // Loop governor — owner-authenticated (per-session token). pause/resume/stop
  // additionally enforce caller === owner inside the handler.
  "/loop-create": { method: "POST", handler: handleLoopCreate },
  "/loop-tick": { method: "POST", handler: handleLoopTick },
  "/loop-verdict": { method: "POST", handler: handleLoopVerdict },
  "/loop-pause": { method: "POST", handler: handleLoopPause },
  "/loop-resume": { method: "POST", handler: handleLoopResume },
  "/loop-stop": { method: "POST", handler: handleLoopStop },
  "/loop-get": { method: "POST", handler: handleLoopGet },
  "/loop-list": { method: "POST", handler: handleLoopList },
  // Loop Phase 5 — reflexion memory: any member who can tick may record/read reflections.
  "/loop-reflect": { method: "POST", handler: handleLoopReflect },
  "/loop-reflections": { method: "POST", handler: handleLoopReflections },
};

function authenticateBearer(req: IncomingMessage, expected: string): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const [scheme, token] = auth.split(" ");
  return scheme === "Bearer" && token === expected;
}

const STALE_GRACE_MS = 30_000; // 30 seconds before auto-unregister
const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Operator directive: agents leave the roster ONLY on a manual /kick (or a voluntary
// fleet_disconnect) — NEVER via automatic staleness/crash eviction, so piloting the
// fleet from one platform doesn't mean constantly re-joining quiet agents. When on
// (the default), the three auto-eviction paths are neutered: the 60s ghost-reaper
// sweep, the stale-poll grace timer, and the registry crash-sweep's presence retire.
// Each still DIMS presence / marks registry status (the board stays honest about who
// is idle/crashed) but KEEPS the membership + token, so a returning agent is still
// registered and needs no re-join. The reaper functions themselves are unchanged and
// still evict when called directly (manual /kick, tests). Set
// AF_DISABLE_REAP=false to restore the automatic reapers.
const REAPING_DISABLED =
  (process.env.AF_DISABLE_REAP ?? process.env.WT_DISABLE_REAP ?? "true").toLowerCase() !== "false";

export function createHubServer(port: number, adminToken: string, joinToken: string): import("node:http").Server {
  // D4 (b): refuse to boot with a lease>=reap misconfig that would re-open the
  // anti-zombie window. Fail loud here, before any wiring. See assertLeaseReapInvariant.
  assertLeaseReapInvariant(planLeaseMs(), BOARD_REAP_MINUTES * 60_000);

  // When a poll connection drops unexpectedly, mark user offline and start grace timer
  onPollDisconnect((userName) => {
    if (!isUserRegistered(userName)) return;
    // The persistent operator presence never holds a poll, but guard anyway: it must
    // never be marked offline or auto-unregistered by the stale-poll grace timer.
    if (isPersistentUser(userName)) return;
    setOffline(userName);
    broadcast({ type: "status", name: userName, online: false, timestamp: Date.now() });
    // Manual-eviction-only: dim presence on socket loss but NEVER auto-unregister —
    // only a manual /kick removes. Keeps the agent registered so a reconnect needs no re-join.
    if (REAPING_DISABLED) {
      console.log(`[offline] ${userName} (reaping-disabled: kept on roster)`);
      return;
    }
    console.log(`[offline] ${userName} (grace period ${STALE_GRACE_MS / 1000}s)`);

    // Clear any existing grace timer
    const existing = staleTimers.get(userName);
    if (existing) clearTimeout(existing);

    staleTimers.set(
      userName,
      setTimeout(() => {
        staleTimers.delete(userName);
        if (isUserRegistered(userName) && !isOnline(userName)) {
          const role = getUserRole(userName);
          removePoll(userName);
          removeQueue(userName);
          setOffline(userName);
          unregisterUser(userName);
          retireBoardEntry(userName);
          broadcast({ type: "leave", name: userName, timestamp: Date.now() });
          if (role === "agent") {
            notifyBridges(`USER_LEFT: ${userName}`);
          }
          console.log(`[auto-unregister] ${userName} (stale)`);
        }
      }, STALE_GRACE_MS),
    );
  });

  // C2: work-steal auto-wake. When tasks auto-promote to ready (ratify→ready or
  // done→propagateUnblock→ready cascade), synthesize ONE system message addressed
  // to the dispatcher (WORK_STEAL_DISPATCHER env) or any eligible online agent.
  // Coalesced via microtask so a cascade unblock doesn't storm with N messages.
  {
    const pendingReadyTasks: Array<{ taskId: string; projectId: string }> = [];
    let flushScheduled = false;

    function flushWorkStealNotification(): void {
      flushScheduled = false;
      if (process.env.WORK_STEAL_NOTIFY === "false") { pendingReadyTasks.length = 0; return; }
      const batch = pendingReadyTasks.splice(0);
      if (batch.length === 0) return;

      // Pick target: configured dispatcher (if registered+online) else first online agent
      const dispatcher = process.env.WORK_STEAL_DISPATCHER ?? "";
      let target: string | null = null;
      if (dispatcher && isUserRegistered(dispatcher) && isOnline(dispatcher)) {
        target = dispatcher;
      } else {
        const candidates = getRegisteredUsers().filter((u) => isOnline(u) && getUserRole(u) === "agent");
        target = candidates[0] ?? null;
      }
      if (!target) return; // no eligible recipient — work will surface on next /tasks-ready poll

      const ids = batch.map((t) => t.taskId).join(", ");
      const noun = batch.length === 1 ? "task" : "tasks";
      try {
        routeMessage("system", `@${target}`,
          `[work-steal] ${batch.length} ${noun} now ready: ${ids}`,
          "#all",
        );
      } catch {
        // target may have disconnected between hook fire and flush — safe to ignore
      }
    }

    setOnTaskReadyHook((taskId, projectId) => {
      pendingReadyTasks.push({ taskId, projectId });
      if (!flushScheduled) {
        flushScheduled = true;
        Promise.resolve().then(flushWorkStealNotification);
      }
    });
  }

  // A2-a: browser-route gate. Passes iff the request carries a valid CF Access
  // JWT OR a valid scoped cockpit token. Used ONLY for `GET /` and `GET /events`.
  // Never throws; the verify path itself fails closed on missing config / bad
  // token. The cockpit-token check is cheap and synchronous, so try it first to
  // skip the JWKS round-trip on in-TTL reloads (A2-a clause b).
  async function passesBrowserGate(req: IncomingMessage): Promise<boolean> {
    // Solo / single-machine deploy: when Cloudflare Access is NOT configured the
    // hub is a localhost-only deployment (it binds 127.0.0.1), so the browser
    // dashboard must be reachable without a token — otherwise a fresh clone 403s
    // its own dashboard. CF Access is the gate for tunneled / exposed / multi-node
    // deploys; when it IS configured this falls through and the existing
    // CF-JWT / cockpit-token / admin checks below apply UNCHANGED (a prod hub that
    // sets CF_ACCESS_* sees no behavior change). Exposing the hub beyond localhost
    // without CF Access leaves the dashboard open — documented in QUICKSTART.
    if (!cfAccessConfigured()) return true;
    if (authenticateCockpitToken(req)) return true;
    // Break-glass recovery: the real admin token always passes the browser gate
    // so an operator can still reach the cockpit (and have it mint a scoped
    // token) if CF Access config misfires — fail-closed would otherwise 403
    // everyone, the operator included. The admin token is NEVER embedded in the served
    // page (A3-a), so this opens no anonymous path: only a holder of the secret
    // admin token can use it.
    if (authenticateBearer(req, adminToken)) return true;
    try {
      return await verifyCfAccessJwt(req);
    } catch {
      return false;
    }
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Dashboard & SSE — BROWSER routes (A2-a). These are the only routes that
    // accept Cloudflare Access JWT auth; every other route below keeps its
    // existing machine-lane / public behavior UNCHANGED. A request passes iff it
    // carries EITHER a valid CF Access JWT OR a valid scoped cockpit token; else
    // 403. The decision is async (JWT verify may hit the JWKS), so it runs in a
    // promise and the dispatcher returns immediately.
    if (path === "/" && req.method === "GET") {
      void passesBrowserGate(req).then((ok) => {
        if (!ok) {
          sendError(res, 403, "Forbidden");
          return;
        }
        // The dashboard HTML is regenerated per request (it embeds a fresh
        // scoped cockpit token and ships the current build). Without no-store,
        // browsers + the CF edge heuristically cache it and serve a STALE
        // dashboard — AND would pin a stale/expired cockpit token. Force
        // revalidation so a new build + a fresh token are always picked up.
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        });
        // A3-a: embed a freshly-minted scoped cockpit token, NOT the raw admin
        // token. The raw admin token never reaches the browser. Also thread the
        // configured operator name so the dashboard tags operator messages without
        // a hardcoded handle.
        res.end(getDashboardHTML(mintCockpitToken(), OPERATOR_NAME));
      }).catch(() => {
        sendError(res, 403, "Forbidden");
      });
      return;
    }
    if (path === "/events" && req.method === "GET") {
      void passesBrowserGate(req).then((ok) => {
        if (!ok) {
          sendError(res, 403, "Forbidden");
          return;
        }
        addSSEClient(res);
      }).catch(() => {
        sendError(res, 403, "Forbidden");
      });
      return;
    }

    // Vendored cockpit assets (xterm.js + fit addon + css). Static, public files
    // (just open-source libs); served from disk so the cockpit never depends on a
    // CDN. <script src>/<link href> can't carry a Bearer header, so these are not
    // browser-gated — they leak no operator data. Path-traversal-guarded.
    if (path.startsWith("/vendor/") && req.method === "GET") {
      void serveVendorFile(path, res);
      return;
    }

    // Public routes
    const publicRoute = publicRoutes[path];
    if (publicRoute) {
      if (req.method !== publicRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      publicRoute.handler(req, res).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    // Join routes (require join token)
    const joinRoute = joinRoutes[path];
    if (joinRoute) {
      if (req.method !== joinRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      if (!authenticateBearer(req, joinToken)) {
        sendError(res, 401, "Join token required");
        return;
      }
      joinRoute.handler(req, res).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    // Admin routes (require admin token OR a valid scoped cockpit token).
    // A3-a: the cockpit browser no longer holds the raw admin token — it holds a
    // short-lived scoped cockpit token minted on an authenticated GET /. Accept
    // EITHER here so the cockpit's admin POSTs work, while the real adminToken
    // (used by the CLI / other tools) keeps working unchanged. Both are Bearer
    // tokens in the Authorization header; neither is ever logged.
    const adminRoute = adminRoutes[path];
    if (adminRoute) {
      if (req.method !== adminRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      if (!authenticateBearer(req, adminToken) && !authenticateCockpitToken(req)) {
        sendError(res, 401, "Admin token required");
        return;
      }
      adminRoute.handler(req, res).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    // User-protected routes (require user token)
    const protectedRoute = protectedRoutes[path];
    if (protectedRoute) {
      if (req.method !== protectedRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      const userName = authenticateRequest(req);
      if (!userName) {
        sendError(res, 401, "Unauthorized");
        return;
      }
      // Any authenticated request proves the agent is alive
      touchLastSeen(userName);
      if (!isOnline(userName)) {
        setOnline(userName);
        broadcast({ type: "status", name: userName, online: true, timestamp: Date.now() });
      }
      protectedRoute.handler(req, res, userName).catch((e) => {
        sendError(res, 500, (e as Error).message);
      });
      return;
    }

    sendError(res, 404, "Not found");
  }

  // Reap retired/abandoned board entries past the grace period. Gated by
  // REAPING_DISABLED too: under no-reap a member persists (possibly dimmed offline),
  // so its board CARD must persist with it — otherwise the card vanishes at
  // AF_BOARD_REAP_MINUTES while the roster keeps the member, and board/roster
  // disagree (undercutting "pilot from one platform"). The function is unchanged when
  // called directly; only the auto-sweep is gated.
  setInterval(() => {
    if (!REAPING_DISABLED) reapStaleBoardEntries(BOARD_REAP_MINUTES * 60_000);
  }, BOARD_REAP_SWEEP_MS).unref();

  // Reap ghost agents (died between polls, no socket drop) every 60s.
  // C5: also run an unconditional lease reclaim on the same tick. Reclaim was
  // previously on-read only, so a lease could sit expired-but-unreclaimed until
  // someone next polled a plan read — leaving a dead agent's task looking held.
  // reclaimExpiredLeases is idempotent and already runs demoteIfBlocked per task
  // (so it does NOT regress the S2-1 hazard: a blocker added while claimed still
  // demotes on release). A no-op when nothing is expired; emits a board update per
  // reclaimed task so live viewers see the release without waiting for a read.
  setInterval(() => {
    // Manual-eviction-only suppresses the staleness sweep (quiet agents are never
    // auto-removed); the lease reclaim is unrelated to presence and always runs.
    if (!REAPING_DISABLED) reapGhostAgents(PRESENCE_GRACE_MS);
    reclaimAndEmit();
  }, 60_000).unref();

  // WS1: registry liveness sweep — detect silently-dead sessions (crash/kill) that
  // no lifecycle verb retired and mark them crashed, so the conductor can requeue a
  // wedged task. Read-only probe (tmux has-session / kill -0); fires nothing itself.
  const REGISTRY_SWEEP_MS = parseInt(process.env.AF_REGISTRY_SWEEP_SECONDS ?? process.env.WT_REGISTRY_SWEEP_SECONDS ?? "30", 10) * 1000;
  // Grace before a dead/superseded registry row is hard-deleted by the GC. A freshly
  // crashed row lingers this long so the conductor can read its "crashed" status and
  // requeue, then it's pruned. Default 1h. Malformed rows (no started_at) ignore grace.
  const REGISTRY_REAP_GRACE_MS =
    parseInt(process.env.AF_REGISTRY_REAP_GRACE_SECONDS ?? process.env.WT_REGISTRY_REAP_GRACE_SECONDS ?? "3600", 10) * 1000;
  setInterval(() => {
    reapCrashedSessions(!REAPING_DISABLED);
    // GC runs unconditionally (see reapDeadRegistryRows): it prunes only the dead ledger,
    // never a live member's presence, so REAPING_DISABLED must NOT gate it or the table rots.
    reapDeadRegistryRows(REGISTRY_REAP_GRACE_MS);
  }, REGISTRY_SWEEP_MS).unref();

  const server = createServer(handleRequest);
  // Interactive terminal WS — attached to the SAME :PORT via HTTP 'upgrade'.
  // noServer mode: WE decide whether to accept each upgrade. The ONLY accepted
  // path is /terminal, and ONLY with a valid single-use ticket (query param).
  // No ticket / invalid / expired → reject the upgrade (no socket is ever
  // handed to ws). This is the sole auth path: there is NO anonymous connect.
  const terminalWss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/terminal") {
      // Unknown WS path — refuse cleanly.
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    // Consume the ticket BEFORE the handshake — one-time, bound to {callsign,
    // tmux session}. Reject (401) if missing/invalid/expired/already-used.
    const ticket = consumeTerminalTicket(ticketFromUpgrade(req));
    if (!ticket) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      const session = new TerminalSession(ws, ticket);
      session.start();
    });
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Error: Port ${port} is already in use. Is another Hub instance running?`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, BIND_HOST, () => {
    console.log(`Agent Fleet Hub listening on http://localhost:${port}`);
    // LOUD one-time guardrail: a non-localhost bind exposes the hub off-box.
    if (!["127.0.0.1", "::1", "localhost"].includes(BIND_HOST)) {
      console.warn(
        `[agent-fleet] WARNING: Hub now reachable on ${BIND_HOST}:${port}. The join token is the only gate — prefer a Tailscale/Cloudflare tunnel over raw 0.0.0.0 on untrusted networks.`,
      );
    }
  });
  return server;
}
