import { randomUUID } from "node:crypto";
import { getUserRole, getUsersByRole, isUserRegistered } from "./auth.js";
import { getChannelMembers, isChannelMember } from "./channels.js";
import { dbCreatePendingAck, dbNextChannelSeq, dbSaveMessage } from "./db.js";
import { deliverMessage } from "./polling.js";
import type { Message, MessageImage } from "./types.js";

const messageQueues = new Map<string, Message[]>();

export function ensureQueue(name: string): void {
  if (!messageQueues.has(name)) {
    messageQueues.set(name, []);
  }
}

export function removeQueue(name: string): void {
  messageQueues.delete(name);
}

// Test helper: clear all in-memory queues so tests start from a clean slate
// (mirrors resetAuthState / resetChannelState).
export function resetRouterState(): void {
  messageQueues.clear();
}

// Local patch: parse @callsign mentions out of message content, keeping only
// tokens that name a current member of the channel. Used to decide who a message
// actually addresses. "@all" is NOT a mention — it is the broadcast keyword and
// must never ping anyone; an unknown name is ignored.
function resolveMentions(content: string, members: string[]): string[] {
  const found = new Set<string>();
  const re = /@([A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    if (name !== "all" && members.includes(name)) found.add(name);
  }
  return [...found];
}

// Operator-ping-all: a message from the HUMAN OPERATOR addresses EVERY
// member of the channel, so the operator never has to @-mention. Gated on the
// SERVER-VERIFIED principal flag (set by the verified send path — never a
// client-settable field) AND a reserved operator callsign. The referee is also a
// principal but is intentionally EXCLUDED here so @all stays quiet for it; the
// referee keeps normal @-mention semantics.
const OPERATOR_PING_CALLSIGNS = new Set(["operator"]);
function isOperatorPingAll(from: string, principal?: boolean): boolean {
  return principal === true && OPERATOR_PING_CALLSIGNS.has(from.trim().toLowerCase());
}

// Local patch: per-recipient counts for the hook-based ping/wake.
// `counts` = messages a recipient is DIRECTLY ADDRESSED IN (its callsign is in
// the message's `mentions`: the `to` recipient or an @-mention in the body).
// These are the ONLY messages that should nudge/wake a session. `queued` = raw
// queue depth — every message awaiting that recipient, including @all broadcasts
// and traffic merely overheard — kept for dashboard/debug visibility. @all with
// no @-mentions addresses no one, so it never increments `counts`.
export function pendingCounts(): {
  counts: Record<string, number>;
  queued: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const queued: Record<string, number> = {};
  for (const [name, queue] of messageQueues) {
    queued[name] = queue.length;
    counts[name] = queue.filter((m) => m.mentions?.includes(name)).length;
  }
  return { counts, queued };
}

export function drainQueue(name: string): Message[] {
  const queue = messageQueues.get(name);
  if (!queue || queue.length === 0) return [];
  const messages = [...queue];
  queue.length = 0;
  return messages;
}

export function routeMessage(
  from: string,
  to: string,
  content: string,
  channel = "#all",
  image?: MessageImage,
  principal?: boolean,
  senderSid?: string,
): Message {
  const members = getChannelMembers(channel);
  // C1: assign a monotonic per-channel seq before building the message so both
  // the @all and @name paths carry the same seq on the persisted + queued copy.
  const seq = dbNextChannelSeq(channel);
  // Operator-ping-all: when the verified human operator posts, address every
  // member (minus the sender) so all get woken — one entry per member, no storm.
  const pingAll = isOperatorPingAll(from, principal);
  const allMembersButSender = members.filter((u) => u !== from);

  if (to === "@all") {
    const message: Message = {
      id: randomUUID(),
      from,
      to: "@all",
      content,
      channel,
      timestamp: Date.now(),
      image,
      seq,
      // @all is broadcast-for-transcript; only members @-mentioned in the body
      // are actually addressed (and thus pinged) — unless the verified operator is
      // posting, in which case every member is addressed (operator-ping-all).
      mentions: pingAll ? allMembersButSender : resolveMentions(content, members),
      ...(principal ? { principal: true as const } : {}),
    };

    dbSaveMessage(message);

    // C1: BLOCKING detect — create durable pending_ack so /ack can wake sender.
    if (content.startsWith("BLOCKING:") && senderSid) {
      dbCreatePendingAck(message.id, senderSid, channel);
    }

    const senderRole = getUserRole(from);

    // Deliver to all channel members except sender.
    // When a bridge sends @all, skip other bridges to avoid relay loops.
    for (const user of members) {
      if (user === from) continue;
      if (senderRole === "bridge" && getUserRole(user) === "bridge") continue;
      enqueueAndDeliver(user, message);
    }
    return message;
  }

  const targetName = to.startsWith("@") ? to.slice(1) : to;

  if (!isUserRegistered(targetName)) {
    throw new Error(`User "${targetName}" is not connected`);
  }

  if (!isChannelMember(channel, targetName)) {
    throw new Error(`User "${targetName}" is not a member of ${channel}`);
  }

  const message: Message = {
    id: randomUUID(),
    from,
    to: targetName,
    content,
    channel,
    timestamp: Date.now(),
    image,
    seq,
    // The named recipient is always addressed; any extra members @-mentioned in
    // the body are addressed too, so a sender can ping everyone a message affects.
    // The verified operator addresses every member (operator-ping-all).
    mentions: pingAll ? allMembersButSender : [...new Set([targetName, ...resolveMentions(content, members)])],
    ...(principal ? { principal: true as const } : {}),
  };

  dbSaveMessage(message);

  // C1: BLOCKING detect — create durable pending_ack so /ack can wake sender.
  if (content.startsWith("BLOCKING:") && senderSid) {
    dbCreatePendingAck(message.id, senderSid, channel);
  }

  // Deliver to all channel members except sender
  for (const user of members) {
    if (user !== from) {
      enqueueAndDeliver(user, message);
    }
  }
  return message;
}

export function enqueueAndDeliver(targetName: string, message: Message): void {
  ensureQueue(targetName);
  const queue = messageQueues.get(targetName)!;
  queue.push(message);
  deliverMessage(targetName);
}

export function notifyBridges(content: string): void {
  const bridges = getUsersByRole("bridge");
  const message: Message = {
    id: randomUUID(),
    from: "system",
    to: "@bridges",
    content,
    channel: "#all",
    timestamp: Date.now(),
  };
  for (const bridge of bridges) {
    enqueueAndDeliver(bridge, message);
  }
}
