import { describe, expect, it } from "vitest";
import { createMcpServer } from "../tools.js";

// The 35 canonical fleet verbs (alias-transition: each also registered under
// its radio_* counterpart, sharing the identical schema + handler).
const FLEET_NAMES = [
  "fleet_join",
  "fleet_become_referee",
  "fleet_send",
  "fleet_over",
  "fleet_send_image",
  "fleet_check",
  "fleet_standby",
  "fleet_wait",
  "fleet_channels",
  "fleet_board",
  "fleet_mission",
  "fleet_plan_create",
  "fleet_task_create",
  "fleet_task_transition",
  "fleet_task_claim",
  "fleet_task_heartbeat",
  "fleet_task_dep_add",
  "fleet_task_artifact",
  "fleet_task_handoff",
  "fleet_plan_get",
  "fleet_plan_board",
  "fleet_plan_owned",
  "fleet_tasks_ready",
  "fleet_task_handoffs",
  "fleet_channel_create",
  "fleet_channel_join",
  "fleet_channel_leave",
  "fleet_channel_invite",
  "fleet_token",
  "fleet_ack",
  "fleet_lock_acquire",
  "fleet_lock_renew",
  "fleet_lock_release",
  "fleet_disconnect",
  "fleet_out",
];

describe("createMcpServer tool registration (alias-transition)", () => {
  const server = createMcpServer("http://127.0.0.1:9559", "test-token");
  const reg = (server as unknown as { _registeredTools: Record<string, { callback: unknown }> })._registeredTools;
  const names = Object.keys(reg);

  it("registers all 35 canonical fleet_* tools", () => {
    for (const fleetName of FLEET_NAMES) {
      expect(names, `missing canonical tool ${fleetName}`).toContain(fleetName);
    }
  });

  it("registers all 35 deprecated radio_* aliases", () => {
    for (const fleetName of FLEET_NAMES) {
      const radioName = `radio_${fleetName.slice("fleet_".length)}`;
      expect(names, `missing radio alias ${radioName}`).toContain(radioName);
    }
  });

  it("each radio_* alias shares the exact handler of its fleet_* canonical", () => {
    // Representative sample: a plain tool, plus each of the three alias-pair
    // seconds (over/wait/out) that share a primary's handler.
    const sample = ["join", "send", "over", "standby", "wait", "disconnect", "out", "task_claim", "lock_acquire"];
    for (const verb of sample) {
      expect(reg[`radio_${verb}`].callback, `radio_${verb} handler mismatch`).toBe(reg[`fleet_${verb}`].callback);
    }
  });

  it("registers exactly 70 tools total (35 fleet × 2)", () => {
    expect(names.length).toBe(70);
  });
});
