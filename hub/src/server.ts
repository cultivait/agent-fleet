import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  authenticateRequest,
  getRegisteredUsers,
  getUserRole,
  getUserToken,
  isPrincipalUser,
  isUserRegistered,
  registerUser,
  setPrincipal,
  unregisterUser,
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
  dbGetResourceLock,
  dbGetUnreadCounts,
  dbGetUserChannels,
  dbListAgentConfigs,
  dbListBoard,
  dbListChannels,
  dbListRegistry,
  dbPutBoardEntry,
  dbRegistryUpsert,
  dbReleaseResourceLock,
  dbRenewResourceLock,
  dbSetRegistryStatusBySession,
  dbSetRegistryStatusBySpawn,
  dbStampRegistryCallsign,
  dbUpdateAgentConfig,
  dbUpdateReadCursor,
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
import { drainQueue, enqueueAndDeliver, ensureQueue, notifyBridges, pendingCounts, removeQueue, routeMessage } from "./router.js";
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
// look-alike registrations ("OPERATOR", " operator ", etc.).
const RESERVED_NAMES = new Set(["operator", "referee"]);

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
    // Allow reconnection only if the caller proves ownership with the old token
    if (isUserRegistered(body.name)) {
      const existingToken = getUserToken(body.name);
      if (!body.oldToken || body.oldToken !== existingToken) {
        return sendError(res, 409, `User "${body.name}" is already registered`);
      }
      removePoll(body.name);
      removeQueue(body.name);
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
  const agents = [...getRegisteredUsers()].filter((name) => name !== "operator");
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
  const from = body.from || "operator";
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
    dbCreateChannel(channelName, "operator");
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
  dbUpdateReadCursor("operator", body.channel, ts);
  broadcast({ type: "read_update", userName: "operator", channel: body.channel, timestamp: ts });
  sendJson(res, 200, { ok: true });
};

const handleAdminUnreadCounts: RouteHandler = async (_req, res) => {
  const counts = dbGetUnreadCounts("operator");
  sendJson(res, 200, { counts });
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
    };
  });
  // Server clock mirrors /plan-board so cockpit computes one shared clock offset.
  sendJson(res, 200, { board, now });
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
// Default 2400s (40min) clears both: it outlasts the 30min rewake window and
// gives long subagents headroom. A true ghost (no heartbeat AND no poll) still
// clears within this window. Keep AF_PRESENCE_GRACE_SECONDS > AF_REWAKE_MAX_SECS.
const PRESENCE_GRACE_MS = parseInt(process.env.AF_PRESENCE_GRACE_SECONDS ?? process.env.WT_PRESENCE_GRACE_SECONDS ?? "2400", 10) * 1000;

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
function retirePresenceForCallsign(callsign: string | null): void {
  if (!callsign || !isUserRegistered(callsign)) return;
  const role = getUserRole(callsign);
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
export function reapCrashedSessions(): string[] {
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
    // A crashed session's radio_join presence is also dead — retire it now rather
    // than wait out the 40min ghost grace, so /registry and the roster agree.
    retirePresenceForCallsign(entry.callsign);
    crashed.push(key);
  }
  if (crashed.length > 0) console.log(`[registry-crash] ${crashed.join(", ")}`);
  return crashed;
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
  sendJson(res, 200, { task: result.task });
};

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

const publicRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/users": { method: "GET", handler: handleUsers },
  "/channels": { method: "GET", handler: handleListChannels },
  "/board": { method: "GET", handler: handleBoard },
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
};

const protectedRoutes: Record<string, { method: string; handler: RouteHandler }> = {
  "/send": { method: "POST", handler: handleSend },
  "/poll": { method: "GET", handler: handlePoll },
  "/inbox": { method: "GET", handler: handleInbox },
  "/ack": { method: "POST", handler: handleAck },
  "/unregister": { method: "POST", handler: handleUnregister },
  "/channel-create": { method: "POST", handler: handleChannelCreate },
  "/channel-join": { method: "POST", handler: handleChannelJoin },
  "/channel-leave": { method: "POST", handler: handleChannelLeave },
  "/channel-invite": { method: "POST", handler: handleChannelInvite },
  "/channel-history": { method: "GET", handler: handleChannelHistory },
  "/messages": { method: "GET", handler: handleMessages },
};

function authenticateBearer(req: IncomingMessage, expected: string): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const [scheme, token] = auth.split(" ");
  return scheme === "Bearer" && token === expected;
}

const STALE_GRACE_MS = 30_000; // 30 seconds before auto-unregister
const staleTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function createHubServer(port: number, adminToken: string, joinToken: string): import("node:http").Server {
  // D4 (b): refuse to boot with a lease>=reap misconfig that would re-open the
  // anti-zombie window. Fail loud here, before any wiring. See assertLeaseReapInvariant.
  assertLeaseReapInvariant(planLeaseMs(), BOARD_REAP_MINUTES * 60_000);

  // When a poll connection drops unexpectedly, mark user offline and start grace timer
  onPollDisconnect((userName) => {
    if (!isUserRegistered(userName)) return;
    setOffline(userName);
    broadcast({ type: "status", name: userName, online: false, timestamp: Date.now() });
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

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Dashboard & SSE
    if (path === "/" && req.method === "GET") {
      // The dashboard HTML is regenerated per request (it embeds the admin token
      // and ships the current build). Without this, browsers + the CF edge
      // heuristically cache it and serve a STALE dashboard after a deploy. Force
      // revalidation so a new build is always picked up on the next load.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(getDashboardHTML(adminToken));
      return;
    }
    if (path === "/events" && req.method === "GET") {
      addSSEClient(res);
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

    // Admin routes (require admin token)
    const adminRoute = adminRoutes[path];
    if (adminRoute) {
      if (req.method !== adminRoute.method) {
        sendError(res, 405, "Method not allowed");
        return;
      }
      if (!authenticateBearer(req, adminToken)) {
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

  // Reap retired/abandoned board entries past the grace period
  setInterval(() => reapStaleBoardEntries(BOARD_REAP_MINUTES * 60_000), BOARD_REAP_SWEEP_MS).unref();

  // Reap ghost agents (died between polls, no socket drop) every 60s.
  // C5: also run an unconditional lease reclaim on the same tick. Reclaim was
  // previously on-read only, so a lease could sit expired-but-unreclaimed until
  // someone next polled a plan read — leaving a dead agent's task looking held.
  // reclaimExpiredLeases is idempotent and already runs demoteIfBlocked per task
  // (so it does NOT regress the S2-1 hazard: a blocker added while claimed still
  // demotes on release). A no-op when nothing is expired; emits a board update per
  // reclaimed task so live viewers see the release without waiting for a read.
  setInterval(() => {
    reapGhostAgents(PRESENCE_GRACE_MS);
    reclaimAndEmit();
  }, 60_000).unref();

  // WS1: registry liveness sweep — detect silently-dead sessions (crash/kill) that
  // no lifecycle verb retired and mark them crashed, so the conductor can requeue a
  // wedged task. Read-only probe (tmux has-session / kill -0); fires nothing itself.
  const REGISTRY_SWEEP_MS = parseInt(process.env.AF_REGISTRY_SWEEP_SECONDS ?? process.env.WT_REGISTRY_SWEEP_SECONDS ?? "30", 10) * 1000;
  setInterval(() => reapCrashedSessions(), REGISTRY_SWEEP_MS).unref();

  const server = createServer(handleRequest);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Error: Port ${port} is already in use. Is another Hub instance running?`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Agent Fleet Hub listening on http://localhost:${port}`);
  });
  return server;
}
