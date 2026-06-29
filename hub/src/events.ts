import type { ServerResponse } from "node:http";

export type HubEvent =
  | {
      type: "message";
      // Message id — lets the dashboard dedup live messages against lazy-loaded
      // channel history (skip rows already rendered).
      id: string;
      from: string;
      to: string;
      content: string;
      channel: string;
      timestamp: number;
      image?: { data: string; mimeType: string };
    }
  | { type: "join"; name: string; timestamp: number }
  | { type: "leave"; name: string; timestamp: number }
  | { type: "channel_create"; name: string; timestamp: number }
  | { type: "channel_join"; channel: string; userName: string; timestamp: number }
  | { type: "channel_leave"; channel: string; userName: string; timestamp: number }
  | { type: "channel_delete"; name: string; timestamp: number }
  | { type: "channel_rename"; from: string; to: string; timestamp: number }
  // Item 1 (fleet_dm): a direct message was sent. Browser-only stream (SSE) — it
  // wakes NO agent (deliverMessage is never called for SSE), so DMs stay invisible to
  // every agent but the recipient (who gets it via their own queue). The cockpit folds
  // it into the operator-only Direct Messages pane, keyed by the canonical pair.
  | { type: "dm"; from: string; to: string; pair: string; content: string; timestamp: number; image?: { data: string; mimeType: string } }
  | { type: "status"; name: string; online: boolean; timestamp: number }
  | { type: "typing"; name: string; channel: string; timestamp: number }
  | { type: "read_update"; userName: string; channel: string; timestamp: number }
  | {
      type: "board_update";
      name: string;
      node: string | null;
      status: string;
      mission: string | null;
      activity: string | null;
      todos: Array<{ content: string; status: string }> | null;
      subagents: number;
      sid: string | null;
      timestamp: number;
    }
  | { type: "board_delete"; name: string; timestamp: number }
  // Board auto-digest: a new agent_log entry was appended. Browser-only stream —
  // it wakes NO agent (deliverMessage is never called for SSE). The dashboard
  // folds entry into the emitting card's latest-log headline + last-5 tail.
  | {
      type: "agent_log";
      name: string;
      entry: { id: number; ts: number; kind: string; note: string };
      timestamp: number;
    }
  | { type: "agent_config_create"; id: string; name: string; timestamp: number }
  | { type: "agent_config_update"; id: string; name: string; timestamp: number }
  | { type: "agent_config_delete"; id: string; timestamp: number }
  // Meta-harness plan board: any mutation to the task graph. Carries enough to
  // route the refresh (which project/task, what kind) — viewers refetch
  // /plan-board for the full, cascade-correct truth.
  | { type: "plan_update"; projectId: string; taskId: string | null; kind: string; timestamp: number }
  // WS1: session-registry mutation (register / partial-merge / liveness crash).
  // Carries enough to route a refresh; viewers refetch /registry for the full row set.
  | {
      type: "registry_update";
      session_id: string | null;
      spawn_id: string | null;
      callsign: string | null;
      node: string | null;
      status: string;
      timestamp: number;
    }
  // Loop Phase 5 (HITL): a loop's approval-queue item changed (opened on escalate, or
  // resolved by the operator). Carries enough to route a refresh; the cockpit refetches
  // /loop-approvals for the full queue.
  | {
      type: "loop_approval";
      loop_id: string;
      approval_id: string;
      status: "pending" | "approved" | "rejected";
      timestamp: number;
    };

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

const clients = new Set<ServerResponse>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      client.write(":\n\n");
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer && clients.size === 0) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function addSSEClient(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  clients.add(res);
  startHeartbeat();
  res.on("close", () => {
    clients.delete(res);
    stopHeartbeat();
  });
}

export function closeAllSSEClients(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const client of clients) {
    client.end();
  }
  clients.clear();
}

export function broadcast(event: HubEvent): void {
  const data = JSON.stringify(event);
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
}
