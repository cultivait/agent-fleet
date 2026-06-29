import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getRegisteredUsers } from "./auth.js";
import { initGeneralChannel } from "./channels.js";
import { initDB } from "./db.js";
import { closeAllSSEClients } from "./events.js";
import { autoLaunchAgents } from "./launcher.js";
import { closeAllPolls, reconcilePresenceFromRegistry } from "./polling.js";
import { enqueueAndDeliver, ensureQueue } from "./router.js";
import { createHubServer, ensureOperatorPresence } from "./server.js";

const port = parseInt(process.env.PORT ?? "9559", 10);

const joinToken = process.env.AGENT_FLEET_JOIN_TOKEN ?? process.env.WALKIE_TALKIE_JOIN_TOKEN;
const adminToken = process.env.AGENT_FLEET_ADMIN_TOKEN ?? process.env.WALKIE_TALKIE_ADMIN_TOKEN;
if (!joinToken || !adminToken) {
  const missing = [!joinToken ? "AGENT_FLEET_JOIN_TOKEN" : null, !adminToken ? "AGENT_FLEET_ADMIN_TOKEN" : null]
    .filter(Boolean)
    .join(", ");
  console.error(
    `Error: required token(s) unset: ${missing}\n\n` +
      `The hub needs a join token (agents authenticate with it) and an admin token\n` +
      `(operator / cockpit break-glass). Generate and export them, then restart:\n\n` +
      `  export AGENT_FLEET_JOIN_TOKEN=$(openssl rand -base64 32)\n` +
      `  export AGENT_FLEET_ADMIN_TOKEN=$(openssl rand -base64 32)\n\n` +
      `Or run the bootstrap installer, which generates, persists, and wires them\n` +
      `for you (hub + MCP + hooks). See QUICKSTART.md.`,
  );
  process.exit(1);
}

initDB();
initGeneralChannel();

const server = createHubServer(port, adminToken, joinToken);

// Startup reconcile pass (B3 offline-sweep + B4 dup-row reconcile): on an unclean
// reboot the in-memory presence set is empty, so every persisted registry callsign
// would read ONLINE (dead seats included) and wedge vacancy checks — e.g. a dead
// REFEREE row pinning fleet_claim_referee at 409 forever. Baseline every persisted
// callsign OFFLINE (dead until it re-polls), and signed_off the stale null-handle
// duplicate rows become_referee's in-memory-only shed leaves behind (only when a
// live-handle sibling proves the seat is still up). Runs AFTER createHubServer
// (handlePoll can reclaim a live seat on the next poll) and BEFORE ensureOperatorPresence
// (which re-asserts the persistent operator online — it is intentionally exempt from the sweep).
reconcilePresenceFromRegistry();

// Persistent operator presence: register "Operator" so `fleet_send to:@Operator` always
// resolves, messages addressed to him queue (and survive restart via rehydration),
// and the ghost-reaper / kick-all never sweep him. Bootstrapped in the production
// entrypoint (NOT inside createHubServer) so the test harness, which drives
// createHubServer directly, is unaffected.
ensureOperatorPresence();

// After the server is listening, open the dashboard and auto-launch agents
server.on("listening", () => {
  execFile("open", [`http://localhost:${port}`], (err) => {
    if (err) console.error(`[open] Failed to open browser: ${err.message}`);
  });
  autoLaunchAgents();
});

// Graceful shutdown
let shuttingDown = false;
function handleShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // Restore terminal to cooked mode if it was set to raw
  if (process.stdin.isTTY && process.stdin.isRaw) {
    process.stdin.setRawMode(false);
  }
  console.log("\n[shutdown] Notifying connected users...");
  // Send RADIO_KILLED to all connected users so they disconnect gracefully
  for (const name of getRegisteredUsers()) {
    ensureQueue(name);
    enqueueAndDeliver(name, {
      id: randomUUID(),
      from: "system",
      to: name,
      content: "RADIO_KILLED: Hub is shutting down.",
      channel: "#all",
      timestamp: Date.now(),
    });
  }
  closeAllSSEClients();
  closeAllPolls();
  server.close(() => {
    console.log("[shutdown] Hub stopped.");
    process.exit(0);
  });
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error("[shutdown] Force exit after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);
