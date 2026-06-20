#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./tools.js";

const args = process.argv.slice(2);
// Env back-compat (alias-transition): read AGENT_FLEET_* first, fall back to the
// legacy WALKIE_TALKIE_*/bare names for one transition version.
let hubUrl = process.env.AGENT_FLEET_HUB_URL || process.env.HUB_URL || "http://localhost:9559";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--hub" && args[i + 1]) {
    hubUrl = args[i + 1];
    i++;
  }
}

const joinToken = process.env.AGENT_FLEET_JOIN_TOKEN ?? process.env.WALKIE_TALKIE_JOIN_TOKEN;
if (!joinToken) {
  console.error("Error: AGENT_FLEET_JOIN_TOKEN environment variable is required");
  process.exit(1);
}

const server = createMcpServer(hubUrl, joinToken);
const transport = new StdioServerTransport();
await server.connect(transport);
