import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HubClient } from "./client.js";
import { resolveOwnerSid } from "./session.js";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function getMimeType(source: string): string {
  const ext = path.extname(source).toLowerCase();
  return MIME_TYPES[ext] ?? "image/png";
}

function fetchUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https") ? https : http;
    transport
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrl(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

const MAX_TODOS_SHOWN = 15;

function formatAge(updatedAt: number): string {
  const deltaMs = Math.max(0, Date.now() - updatedAt);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Images embedded in fleet messages are re-billed to every recipient's context
// on each turn. Cap delivery at 512KB base64 (~375KB raw) to prevent large
// screenshots from inflating context. Prefer point-to-point delivery over @all.
const MAX_IMAGE_B64_CHARS = 512 * 1024;

function imageBlock(
  img: { data: string; mimeType: string },
): { type: "image"; data: string; mimeType: string } | { type: "text"; text: string } {
  if (img.data.length > MAX_IMAGE_B64_CHARS) {
    const kb = Math.round(img.data.length / 1024);
    return {
      type: "text" as const,
      text: `[image omitted — ${kb}KB base64 exceeds the 512KB cap; send via point-to-point (@name) or reduce image size before sending]`,
    };
  }
  return { type: "image" as const, data: img.data, mimeType: img.mimeType };
}

function formatLease(leaseExpiresAt: number | null | undefined): string {
  if (leaseExpiresAt == null) return "";
  const msLeft = leaseExpiresAt - Date.now();
  if (msLeft <= 0) return " [lease expired]";
  const minsLeft = Math.ceil(msLeft / 60000);
  return ` [${minsLeft}m left]`;
}

type TerseTask = {
  id: string;
  project_id?: string | null;
  title: string;
  status: string;
  priority?: number | null;
  owner?: string | null;
  lease_expires_at?: number | null;
};

function terseTaskLine(t: TerseTask, showProject = false): string {
  const prio = t.priority != null ? `P${t.priority}` : "P?";
  const proj = showProject && t.project_id ? ` (${t.project_id})` : "";
  const lease = formatLease(t.lease_expires_at);
  const owner = t.owner ? ` [${t.owner}]` : "";
  return `[${t.status} ${prio}] ${t.id} — ${t.title}${owner}${lease}${proj}`;
}

let client: HubClient;
let joinToken: string;
let currentToken: string | null = null;
let currentName: string | null = null;

export function createMcpServer(hubUrl: string, joinTok: string): McpServer {
  client = new HubClient(hubUrl);
  joinToken = joinTok;

  const server = new McpServer({
    name: "agent-fleet",
    version: "1.0.0",
  });

  // Alias-transition: register the canonical fleet_* tool plus a hidden deprecated
  // radio_* alias delegating to the SAME handler, for one transition version.
  // schema/handler are typed `any`: server.tool is heavily overloaded and a
  // precise Parameters<> type resolves to the wrong (annotations) overload, so a
  // localized any keeps the 4-arg (name, description, schema, handler) form sound.
  const registerTool = (
    fleetName: string,
    description: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => any,
  ) => {
    server.tool(fleetName, description, schema, handler);
    const radioName = `radio_${fleetName.slice("fleet_".length)}`;
    server.tool(radioName, `(deprecated alias of ${fleetName}) ${description}`, schema, handler);
  };

  registerTool(
    "fleet_join",
    "Join the Agent Fleet hub with a display name. You must join before using other fleet tools.",
    { name: z.string().describe("Your display name for this session") },
    async ({ name }) => {
      try {
        const result = await client.register(name, joinToken, currentToken ?? undefined);
        currentToken = result.token;
        currentName = result.name;
        return {
          content: [
            {
              type: "text" as const,
              text: `Registered as "${currentName}". You are now in #all. You can now send and receive messages.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Registration failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // REFEREE: promote THIS session to the operator-identity callsign "REFEREE".
  // The normal fleet_join path can never register "referee" (RESERVED_NAMES → 403),
  // so this tool uses the admin-token /admin-register endpoint instead. It:
  //   - reads the admin token from AGENT_FLEET_ADMIN_TOKEN (back-compat: WALKIE_TALKIE_ADMIN_TOKEN), errors if absent,
  //   - sheds the agent's current auto-joined callsign (oldName=currentName),
  //   - aligns the registry row (sid=CLAUDE_CODE_SESSION_ID),
  //   - rebinds module-level currentToken/currentName so EVERY subsequent fleet
  //     tool in this session speaks as REFEREE.
  registerTool(
    "fleet_become_referee",
    "Promote this session to the operator-identity callsign 'REFEREE' (the join path cannot register reserved names). Requires AGENT_FLEET_ADMIN_TOKEN in the environment. After this, all your fleet messages send as REFEREE and carry [principal] for recipients.",
    { name: z.string().optional().describe("Callsign to take. Defaults to 'REFEREE'.") },
    async ({ name }) => {
      const targetName = name ?? "REFEREE";
      const adminToken = process.env.AGENT_FLEET_ADMIN_TOKEN ?? process.env.WALKIE_TALKIE_ADMIN_TOKEN;
      if (!adminToken) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Cannot become REFEREE: AGENT_FLEET_ADMIN_TOKEN is not set in this session's environment.",
            },
          ],
          isError: true,
        };
      }
      try {
        const sid = process.env.CLAUDE_CODE_SESSION_ID;
        const result = await client.adminRegister(targetName, adminToken, currentName ?? undefined, sid ?? undefined);
        currentToken = result.token;
        currentName = result.name;
        return {
          content: [
            {
              type: "text" as const,
              text: `You are now "${currentName}". All subsequent fleet tools speak as ${currentName}, and your messages carry [principal].`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Become-referee failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // Send verb. `fleet_send` is the clear, legible primary name; `fleet_over`
  // (whose name misleadingly reads like "yield/over" rather than "send") is kept
  // as a fully-functional canonical ALIAS routed to the SAME handler. Both
  // canonical names auto-derive their deprecated radio_* counterparts via
  // registerTool. Schema + handler are defined once and shared by both names.
  const radioSendDescription =
    "Send a message to a channel. Only members you @-mention are notified (nudged/woken); everyone else can read it later but is not interrupted. @-mention EVERY member the message affects by exact callsign in the body (e.g. '@pie @fieldbook ...') — naming only one leaves the rest uninformed. @all broadcasts to the channel for transcript/progress notes and notifies NO ONE, so never use it alone for anything urgent or needing a reply. Messages are scoped to a channel.";
  const radioSendSchema = {
    to: z
      .string()
      .describe(
        "Primary recipient: @name notifies that member; @all broadcasts to the channel and notifies no one. To notify several members, also @-mention each of them in the message body.",
      ),
    message: z.string().describe("Message content. @-mention (e.g. '@pie') every member this message affects so they are notified."),
    channel: z
      .string()
      .optional()
      .describe(
        "Channel to send to. IMPORTANT: Always reply in the same channel where you received the message. Defaults to #all if omitted.",
      ),
    image_data: z
      .string()
      .optional()
      .describe("Base64-encoded image data. Must be provided together with image_mime_type."),
    image_mime_type: z
      .string()
      .optional()
      .describe("MIME type of the image (e.g. 'image/png'). Must be provided together with image_data."),
  };
  const radioSendHandler = async ({
    to,
    message,
    channel,
    image_data,
    image_mime_type,
  }: {
    to: string;
    message: string;
    channel?: string;
    image_data?: string;
    image_mime_type?: string;
  }) => {
    if (!currentToken) {
      return {
        content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
        isError: true,
      };
    }
    try {
      const image = image_data && image_mime_type ? { data: image_data, mimeType: image_mime_type } : undefined;
      const result = await client.send(currentToken, to, message, channel, image);
      return {
        content: [
          {
            type: "text" as const,
            text: `Message sent to ${result.to} in ${channel || "#all"} (id: ${result.id})`,
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Send failed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  };

  // Primary: clear verb name. registerTool also derives radio_send.
  registerTool("fleet_send", radioSendDescription, radioSendSchema, radioSendHandler);
  // Canonical alias: same handler. registerTool also derives radio_over.
  registerTool(
    "fleet_over",
    `(alias of fleet_send — prefer fleet_send) ${radioSendDescription}`,
    radioSendSchema,
    radioSendHandler,
  );

  registerTool(
    "fleet_send_image",
    "Send an image from a local file path or URL. IMPORTANT: images are embedded as base64 and re-billed to every recipient's context each turn (~1.3MB base64 per 1MB PNG, multiplied by recipients). Keep images under 512KB raw; prefer point-to-point (@name) over @all to limit recipients. Images over the 512KB cap are dropped at delivery with a notice.",
    {
      to: z
        .string()
        .describe(
          "Primary recipient: @name notifies that member; @all broadcasts to the channel and notifies no one. @-mention every affected member in the message to notify them.",
        ),
      source: z.string().describe("Image file path or URL (http/https)"),
      message: z.string().optional().describe("Optional text message to accompany the image"),
      channel: z.string().optional().describe("Channel to send to (default: #all)"),
    },
    async ({ to, source, message, channel }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      try {
        let buf: Buffer;
        if (source.startsWith("http://") || source.startsWith("https://")) {
          buf = await fetchUrl(source);
        } else {
          buf = fs.readFileSync(source);
        }
        const data = buf.toString("base64");
        const mimeType = getMimeType(source);
        if (data.length > MAX_IMAGE_B64_CHARS) {
          const kb = Math.round(data.length / 1024);
          return {
            content: [{ type: "text" as const, text: `Image too large to send: ${kb}KB base64 (cap is 512KB). Resize the image before sending, or use a URL link in text instead.` }],
            isError: true,
          };
        }
        const result = await client.send(currentToken, to, message ?? "", channel, { data, mimeType });
        return {
          content: [
            {
              type: "text" as const,
              text: `Image sent to ${result.to} in ${channel || "#all"} (id: ${result.id})`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to send image: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_check",
    "Check for new messages immediately without waiting. Returns any queued messages instantly. Use this instead of fleet_standby when you want to poll periodically with sleep in between.",
    {},
    async () => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      try {
        const result = await client.inbox(currentToken);
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const killed = result.messages.find((m) => m.content.startsWith("RADIO_KILLED:"));
        if (killed) {
          currentToken = null;
          currentName = null;
          return {
            content: [
              {
                type: "text" as const,
                text: "RADIO_KILLED: You have been disconnected by the operator. Do NOT call any more fleet tools. Stop immediately.",
              },
            ],
            isError: true,
          };
        }
        const contentBlocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> =
          [];
        for (const m of result.messages) {
          if (m.image) {
            contentBlocks.push(imageBlock(m.image));
          }
          const imageTag = m.image ? " [image attached]" : "";
          const principalTag = m.principal ? " [principal]" : "";
          const line = `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.channel || "#all"} ${m.from}${principalTag} → ${m.to}: ${m.content}${imageTag}`;
          contentBlocks.push({ type: "text" as const, text: line });
        }
        const channels = [
          ...new Set(result.messages.filter((m) => m.channel && m.channel !== "#all").map((m) => m.channel)),
        ];
        if (channels.length > 0) {
          contentBlocks.push({
            type: "text" as const,
            text: `\nIMPORTANT: Reply in the same channel you received the message on. Use the channel parameter: ${channels.map((c) => `"${c}"`).join(", ")}`,
          });
        }
        return { content: contentBlocks };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Check failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // Wait/long-poll verb. `fleet_standby` reads acceptably ("standby" = wait),
  // so it stays the primary; but an agent scanning tool names for "wait for
  // messages" can miss "standby", so `fleet_wait` is added as a clearer,
  // fully-functional alias routed to the SAME handler. Both canonical names
  // auto-derive their deprecated radio_* counterparts via registerTool.
  const radioStandbyDescription =
    "Stand by for incoming messages using long polling. Blocks until a message arrives or up to ~1 hour (NOT 30 seconds — the connection stays open for the full long-poll window). Returns received messages, or a timeout notice if no messages arrive. Use fleet_check instead for an instant non-blocking peek at queued messages.";
  const radioStandbyHandler = async () => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      try {
        const result = await client.poll(currentToken);
        if (!result || result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages (poll timed out). Try again." }],
          };
        }
        // Check for kill signal from operator
        const killed = result.messages.find((m) => m.content.startsWith("RADIO_KILLED:"));
        if (killed) {
          currentToken = null;
          currentName = null;
          return {
            content: [
              {
                type: "text" as const,
                text: "RADIO_KILLED: You have been disconnected by the operator. Do NOT call any more fleet tools. Stop immediately.",
              },
            ],
            isError: true,
          };
        }
        const contentBlocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> =
          [];

        for (const m of result.messages) {
          if (m.image) {
            contentBlocks.push(imageBlock(m.image));
          }
          const imageTag = m.image ? " [image attached]" : "";
          const principalTag = m.principal ? " [principal]" : "";
          const line = `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.channel || "#all"} ${m.from}${principalTag} → ${m.to}: ${m.content}${imageTag}`;
          contentBlocks.push({ type: "text" as const, text: line });
        }

        // Remind the agent to reply in the same channel the message was received on
        const channels = [
          ...new Set(result.messages.filter((m) => m.channel && m.channel !== "#all").map((m) => m.channel)),
        ];
        const hint =
          channels.length > 0
            ? `\n\nIMPORTANT: Reply in the same channel you received the message on. Use the channel parameter: ${channels.map((c) => `"${c}"`).join(", ")}`
            : "";
        if (hint) {
          contentBlocks.push({ type: "text" as const, text: hint });
        }
        return {
          content: contentBlocks,
        };
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === "Unauthorized") {
          currentToken = null;
          currentName = null;
          return {
            content: [
              {
                type: "text" as const,
                text: "RADIO_KILLED: You have been disconnected by the operator. Do NOT call any more fleet tools. Stop immediately.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Poll failed: ${msg}` }],
          isError: true,
        };
      }
  };

  // Primary: "standby" reads acceptably. registerTool also derives radio_standby.
  registerTool("fleet_standby", radioStandbyDescription, {}, radioStandbyHandler);
  // Clearer alias for agents that look for a "wait" verb. Also derives radio_wait.
  registerTool(
    "fleet_wait",
    `Wait for incoming messages by long polling (clearer alias of fleet_standby). ${radioStandbyDescription}`,
    {},
    radioStandbyHandler,
  );

  registerTool(
    "fleet_channels",
    "List all currently connected users on the hub and available channels.",
    {},
    async () => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      try {
        const [users, channels] = await Promise.all([client.users(currentToken), client.listChannels(currentToken)]);
        const userText = users.length > 0 ? `Connected users: ${users.join(", ")}` : "No users connected.";
        const channelText =
          channels.length > 0
            ? `Channels: ${channels.map((c) => `${c.name} (${c.memberCount} members)`).join(", ")}`
            : "No channels.";
        return {
          content: [
            {
              type: "text" as const,
              text: `${userText}\n${channelText}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_board",
    "View the live task board: what every agent on the hub is working on (mission, current activity, todo progress). Fed automatically by hooks; read-only.",
    {},
    async () => {
      try {
        const board = await client.getBoard(currentToken ?? undefined);
        if (board.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Task board is empty — no agents reporting." }],
          };
        }
        const sorted = [...board].sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        });
        const blocks = sorted.map((entry) => {
          const node = entry.node ? ` [${entry.node}]` : "";
          const presence = entry.online ? "● online" : "○ offline";
          const lines = [`${entry.name}${node} ${presence} — ${entry.status} (updated ${formatAge(entry.updatedAt)})`];
          if (entry.mission) lines.push(`  mission: ${entry.mission}`);
          if (entry.subagents > 0) lines.push(`  subagents: ${entry.subagents} running`);
          if (entry.activity) lines.push(`  now: ${entry.activity}`);
          if (entry.todos && entry.todos.length > 0) {
            const done = entry.todos.filter((t) => t.status === "completed").length;
            lines.push(`  todos: ${done}/${entry.todos.length} done`);
            for (const todo of entry.todos.slice(0, MAX_TODOS_SHOWN)) {
              const mark = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]";
              lines.push(`    ${mark} ${todo.content}`);
            }
            if (entry.todos.length > MAX_TODOS_SHOWN) {
              lines.push(`    …and ${entry.todos.length - MAX_TODOS_SHOWN} more`);
            }
          }
          return lines.join("\n");
        });
        return {
          content: [{ type: "text" as const, text: blocks.join("\n\n") }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to fetch board: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_mission",
    "Set your one-line mission on the shared task board — a deliberate, concise statement of what you're working on (e.g. 'Hardening PIE estimate endpoints'). Visible to all agents and the operator. Set it right after fleet_join and update it whenever your task changes. Keep it free of secrets. Pass an empty string to clear it.",
    { mission: z.string().max(140).describe("One-line mission statement (max 140 chars). Empty string clears it.") },
    async ({ mission }) => {
      if (!currentToken || !currentName) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      const trimmed = mission.trim();
      try {
        await client.updateBoard(joinToken, { name: currentName, mission: trimmed || null, status: "active" });
        return {
          content: [{ type: "text" as const, text: trimmed ? `Mission set: ${trimmed}` : "Mission cleared." }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to set mission: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Meta-harness plan core — durable, shared task graph for coordinating Claude
  // instances around the same work. POST tools mutate the plan (join-token
  // authed, no fleet_join required); GET tools are public reads. Each returns
  // the hub's JSON response verbatim.
  // ---------------------------------------------------------------------------

  registerTool(
    "fleet_plan_create",
    "Meta-harness: create a new plan/project — the top-level container for a shared task graph other instances can drive.",
    {
      title: z.string().describe("Project title (required)."),
      brief: z.string().optional().describe("Optional one-paragraph brief describing the project's goal."),
      by: z.string().optional().describe("Optional actor/callsign recording who created the project."),
    },
    async ({ title, brief, by }) => {
      try {
        const result = await client.planCreate(joinToken, { title, brief, by });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Plan create failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_task_create",
    "Meta-harness: add a task to a project's plan. Tasks are the unit of durable work instances claim and drive through the lifecycle; optionally nest under a parent and declare dependencies.",
    {
      project_id: z.string().describe("ID of the project to add the task to (required)."),
      title: z.string().describe("Task title (required)."),
      detail: z.string().optional().describe("Optional longer description of the task."),
      parent_id: z.string().optional().describe("Optional parent task ID to nest this task under."),
      priority: z.number().optional().describe("Optional numeric priority (higher = more urgent)."),
      deps: z.array(z.string()).optional().describe("Optional list of task IDs this task is blocked on."),
      by: z.string().optional().describe("Optional actor/callsign recording who created the task."),
    },
    async ({ project_id, title, detail, parent_id, priority, deps, by }) => {
      try {
        const result = await client.taskCreate(joinToken, { project_id, title, detail, parent_id, priority, deps, by });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Task create failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_task_transition",
    "Meta-harness: move a task to a new lifecycle status (e.g. ratified, in_progress, review, done, blocked, failed, abandoned). Enforced by the hub's allow-list state machine.",
    {
      task_id: z.string().describe("ID of the task to transition (required)."),
      to: z.string().describe("Target status (required), e.g. ratified | in_progress | review | done | blocked | failed | abandoned."),
      actor: z.string().optional().describe("Optional actor/callsign recording who performed the transition."),
      note: z.string().optional().describe("Optional note explaining the transition."),
    },
    async ({ task_id, to, actor, note }) => {
      try {
        const result = await client.taskTransition(joinToken, { task_id, to, actor, note });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Task transition failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_task_claim",
    "Meta-harness: atomically claim a ready task so this instance owns the work. The lease binds to this instance's session automatically so heartbeats keep it alive. Returns the task plus its latest handoff (if any).",
    {
      task_id: z.string().describe("ID of the ready task to claim (required)."),
      owner: z.string().describe("Owner callsign/name taking the task (required)."),
      owner_sid: z
        .string()
        .optional()
        .describe(
          "Session id binding the claim's lease. Defaults to this instance's session (CLAUDE_CODE_SESSION_ID) so heartbeats auto-renew; pass explicitly only to claim on another session's behalf.",
        ),
      actor: z.string().optional().describe("Optional actor/callsign recording who claimed the task."),
    },
    async ({ task_id, owner, owner_sid, actor }) => {
      try {
        const sid = resolveOwnerSid(owner_sid, process.env.CLAUDE_CODE_SESSION_ID);
        const result = await client.taskClaim(joinToken, { task_id, owner, owner_sid: sid, actor });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Task claim failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_task_heartbeat",
    "Meta-harness: renew the lease on a task you own so it isn't reclaimed as stale. Call periodically while actively working a claimed/in_progress task.",
    {
      task_id: z.string().describe("ID of the task whose lease to renew (required)."),
      owner_sid: z
        .string()
        .optional()
        .describe("Session id that holds the lease. Defaults to this instance's session (CLAUDE_CODE_SESSION_ID)."),
    },
    async ({ task_id, owner_sid }) => {
      try {
        const sid = resolveOwnerSid(owner_sid, process.env.CLAUDE_CODE_SESSION_ID);
        if (!sid) {
          return {
            content: [
              { type: "text" as const, text: "Task heartbeat failed: no owner_sid (and CLAUDE_CODE_SESSION_ID unset)" },
            ],
            isError: true,
          };
        }
        const result = await client.taskHeartbeat(joinToken, { task_id, owner_sid: sid });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Task heartbeat failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_task_dep_add",
    "Meta-harness: add a dependency edge — declare that a task is blocked on another task and can't become ready until that one is done.",
    {
      task_id: z.string().describe("ID of the task that should be blocked (required)."),
      blocks_on: z.string().describe("ID of the task it must wait for (required)."),
    },
    async ({ task_id, blocks_on }) => {
      try {
        const result = await client.taskDepAdd(joinToken, { task_id, blocks_on });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Task dep add failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_task_artifact",
    "Meta-harness: attach a durable artifact (e.g. a commit, file path, URL, or report) to a task so its outputs are recorded on the shared plan.",
    {
      task_id: z.string().describe("ID of the task to attach the artifact to (required)."),
      kind: z.string().describe("Artifact kind (required), e.g. 'commit' | 'file' | 'url' | 'report'."),
      uri: z.string().describe("Artifact location/identifier (required), e.g. a path, URL, or commit sha."),
      note: z.string().optional().describe("Optional note describing the artifact."),
      actor: z.string().optional().describe("Optional actor/callsign recording who added the artifact."),
    },
    async ({ task_id, kind, uri, note, actor }) => {
      try {
        const result = await client.taskArtifact(joinToken, { task_id, kind, uri, note, actor });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Task artifact failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_task_handoff",
    "Meta-harness: write a durable, append-only handoff on a task — a resume note (summary, next step, blockers, artifacts) so the next instance can pick up without re-deriving context.",
    {
      task_id: z.string().describe("ID of the task to write the handoff for (required)."),
      actor: z.string().optional().describe("Optional actor/callsign recording who wrote the handoff."),
      summary: z.string().describe("What was done / current state (required)."),
      next_step: z.string().optional().describe("Optional explicit next step for whoever resumes."),
      blockers: z.array(z.string()).optional().describe("Optional list of blockers preventing progress."),
      artifacts: z
        .array(
          z.object({
            kind: z.string().describe("Artifact kind, e.g. 'commit' | 'file' | 'url'."),
            uri: z.string().describe("Artifact location/identifier."),
            note: z.string().optional().describe("Optional note describing the artifact."),
          }),
        )
        .optional()
        .describe("Optional artifacts to record alongside the handoff."),
    },
    async ({ task_id, actor, summary, next_step, blockers, artifacts }) => {
      try {
        const result = await client.taskHandoff(joinToken, { task_id, actor, summary, next_step, blockers, artifacts });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Task handoff failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_plan_get",
    "Meta-harness: read a project's full plan — its project record, all tasks, dependency edges, and child roll-up summaries. Returns compact text by default; pass verbose:true for raw JSON.",
    {
      project_id: z.string().describe("ID of the project to fetch (required)."),
      verbose: z.boolean().optional().describe("Return raw JSON instead of compact text (default: false)."),
    },
    async ({ project_id, verbose }) => {
      try {
        const result = await client.planGet(project_id) as {
          project?: { id: string; title: string };
          tasks?: TerseTask[];
          deps?: Array<{ task_id: string; blocks_on: string }>;
        };
        if (verbose) {
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        const proj = result.project;
        const tasks = result.tasks ?? [];
        const deps = result.deps ?? [];
        const header = proj ? `Project: ${proj.title} (${proj.id})` : `Project: ${project_id}`;
        const byStatus: Record<string, TerseTask[]> = {};
        for (const t of tasks) (byStatus[t.status] ??= []).push(t);
        const lines = [header, `${tasks.length} task(s):`];
        for (const [status, group] of Object.entries(byStatus)) {
          lines.push(`  ${status} (${group.length}):`);
          for (const t of group) lines.push(`    ${terseTaskLine(t)}`);
        }
        if (deps.length > 0) lines.push(`${deps.length} dep edge(s) (use verbose:true to see)`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Plan get failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_plan_board",
    "Meta-harness: read a project's plan projected into ordered status lanes (kanban view). Returns compact text by default; pass verbose:true for raw JSON.",
    {
      project_id: z.string().describe("ID of the project to fetch the board for (required)."),
      verbose: z.boolean().optional().describe("Return raw JSON instead of compact text (default: false)."),
    },
    async ({ project_id, verbose }) => {
      try {
        const result = await client.planBoard(project_id) as {
          project?: { id: string; title: string };
          lanes?: Record<string, TerseTask[]>;
          deps?: Array<{ task_id: string; blocks_on: string }>;
          now?: number;
        };
        if (verbose) {
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        const proj = result.project;
        const lanes = result.lanes ?? {};
        const header = proj ? `Project: ${proj.title} (${proj.id})` : `Project: ${project_id}`;
        const lines = [header];
        for (const [status, tasks] of Object.entries(lanes)) {
          if (!tasks || tasks.length === 0) continue;
          lines.push(`## ${status} (${tasks.length})`);
          for (const t of tasks) lines.push(`  ${terseTaskLine(t)}`);
        }
        if (lines.length === 1) lines.push("(all lanes empty)");
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Plan board failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_plan_owned",
    "Meta-harness: list the tasks a given session actively owns (claimed/in_progress), keyed on its owner_sid — what THIS instance should be working on. Returns compact text by default; pass verbose:true for raw JSON.",
    {
      owner_sid: z.string().describe("Session id whose owned tasks to list (required)."),
      verbose: z.boolean().optional().describe("Return raw JSON instead of compact text (default: false)."),
    },
    async ({ owner_sid, verbose }) => {
      try {
        const result = await client.planOwned(owner_sid) as { tasks?: TerseTask[] };
        if (verbose) {
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        const tasks = result.tasks ?? [];
        if (tasks.length === 0) {
          return { content: [{ type: "text" as const, text: "No owned tasks for this session." }] };
        }
        const lines = [`${tasks.length} owned task(s):`];
        for (const t of tasks) lines.push(`  ${terseTaskLine(t, true)}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Plan owned failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_tasks_ready",
    "Meta-harness: list all tasks across projects that are ready to be claimed — the global work queue an idle instance can pull from. Returns compact text by default; pass verbose:true for raw JSON.",
    {
      verbose: z.boolean().optional().describe("Return raw JSON instead of compact text (default: false)."),
    },
    async ({ verbose }) => {
      try {
        const result = await client.tasksReady() as { tasks?: TerseTask[] };
        if (verbose) {
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        const tasks = result.tasks ?? [];
        if (tasks.length === 0) {
          return { content: [{ type: "text" as const, text: "No ready tasks — queue is empty." }] };
        }
        const lines = [`${tasks.length} ready task(s):`];
        for (const t of tasks) lines.push(`  ${terseTaskLine(t, true)}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Tasks ready failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_task_handoffs",
    "Meta-harness: read a task's full append-only handoff history plus its recorded artifacts — the resume trail for picking up the work. Returns compact text by default; pass verbose:true for raw JSON.",
    {
      task_id: z.string().describe("ID of the task whose handoffs to fetch (required)."),
      verbose: z.boolean().optional().describe("Return raw JSON instead of compact text (default: false)."),
    },
    async ({ task_id, verbose }) => {
      try {
        const result = await client.taskHandoffs(task_id) as {
          handoffs?: Array<{ id: number; ts: number; actor: string | null; summary: string; next_step: string | null; blockers: string[]; system: boolean }>;
          artifacts?: Array<{ kind: string; uri: string; note?: string | null }>;
        };
        if (verbose) {
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        const handoffs = result.handoffs ?? [];
        const artifacts = result.artifacts ?? [];
        if (handoffs.length === 0 && artifacts.length === 0) {
          return { content: [{ type: "text" as const, text: "No handoffs or artifacts for this task." }] };
        }
        const lines: string[] = [];
        if (handoffs.length > 0) {
          lines.push(`${handoffs.length} handoff(s):`);
          for (const h of handoffs) {
            const who = h.actor ?? "?";
            const when = formatAge(h.ts);
            const sys = h.system ? " [system]" : "";
            lines.push(`  [${when}] ${who}${sys}: ${h.summary}`);
            if (h.next_step) lines.push(`    → next: ${h.next_step}`);
            if (h.blockers.length > 0) lines.push(`    ⛔ blockers: ${h.blockers.join(", ")}`);
          }
        }
        if (artifacts.length > 0) {
          lines.push(`${artifacts.length} artifact(s):`);
          for (const a of artifacts) {
            const note = a.note ? ` — ${a.note}` : "";
            lines.push(`  [${a.kind}] ${a.uri}${note}`);
          }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Task handoffs failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_channel_create",
    "Create a new channel on the hub. You will automatically join the channel.",
    { name: z.string().describe("Channel name (with or without # prefix)") },
    async ({ name }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      try {
        const result = await client.createChannel(currentToken, name);
        return {
          content: [
            {
              type: "text" as const,
              text: `Channel ${result.channel} created. You have been auto-joined.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to create channel: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_channel_join",
    "Join an existing channel to send and receive messages in it.",
    { channel: z.string().describe("Channel name to join (e.g. #my-channel)") },
    async ({ channel }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      try {
        await client.joinChannel(currentToken, channel);
        return {
          content: [
            {
              type: "text" as const,
              text: `Joined ${channel}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to join channel: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_channel_leave",
    "Leave a channel. You cannot leave #all.",
    { channel: z.string().describe("Channel name to leave") },
    async ({ channel }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      try {
        await client.leaveChannel(currentToken, channel);
        return {
          content: [
            {
              type: "text" as const,
              text: `Left ${channel}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to leave channel: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_channel_invite",
    "Invite another user to a channel. The user is automatically joined and notified via their next poll.",
    {
      channel: z.string().describe("Channel name to invite the user to"),
      user: z.string().describe("User to invite (e.g. @agent-name)"),
    },
    async ({ channel, user }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      try {
        await client.inviteToChannel(currentToken, channel, user);
        return {
          content: [
            {
              type: "text" as const,
              text: `Invited ${user} to ${channel}.`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Failed to invite: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "fleet_token",
    "Get the current session token, hub URL, and path to the fleet-wait.sh script. Use this to run the wait script in a terminal for real-time polling.",
    {},
    async () => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      const thisFile = fileURLToPath(import.meta.url);
      const waitScript = path.resolve(path.dirname(thisFile), "..", "bin", "fleet-wait.sh");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              hubUrl: client.getBaseUrl(),
              token: currentToken,
              waitScript,
            }),
          },
        ],
      };
    },
  );

  // C1: fleet_ack — acknowledge a BLOCKING message and wake the sender's task.
  registerTool(
    "fleet_ack",
    "Acknowledge a BLOCKING message — clears the pending-ack for msg_id and wakes the blocked sender's task (blocked → in_progress). Call this after you have completed the work a BLOCKING: message requested.",
    { msg_id: z.string().describe("ID of the BLOCKING message to acknowledge (required).") },
    async ({ msg_id }) => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
          isError: true,
        };
      }
      try {
        const result = await client.ack(currentToken, msg_id);
        const unblockedStr =
          result.unblocked.length > 0 ? ` Unblocked task(s): ${result.unblocked.join(", ")}.` : "";
        return {
          content: [{ type: "text" as const, text: `ACK sent for ${msg_id}.${unblockedStr}` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Ack failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // === C4: resource lock tools — APPENDED after all existing tools ===

  registerTool(
    "fleet_lock_acquire",
    "Meta-harness: acquire a named resource lock so this session is the sole permitted writer. Fails (409) if another session holds a live lease. Fail-open: if the hub is unreachable, the agent should proceed without the lock.",
    {
      resource_key: z.string().describe("Unique key for the contested surface, e.g. 'hub:server.ts' or 'db:piedb' (required)."),
      lease_ms: z
        .number()
        .optional()
        .describe("Lease duration in milliseconds. Defaults to 300000 (5 min)."),
      owner_sid: z
        .string()
        .optional()
        .describe("Session id to bind the lock to. Defaults to CLAUDE_CODE_SESSION_ID."),
    },
    async ({ resource_key, lease_ms, owner_sid }) => {
      try {
        const sid = resolveOwnerSid(owner_sid, process.env.CLAUDE_CODE_SESSION_ID);
        if (!sid) {
          return { content: [{ type: "text" as const, text: "Lock acquire failed: no owner_sid (and CLAUDE_CODE_SESSION_ID unset)" }], isError: true };
        }
        const result = await client.lockAcquire(joinToken, { resource_key, owner_sid: sid, lease_ms });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Lock acquire failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  registerTool(
    "fleet_lock_renew",
    "Meta-harness: extend a resource lock lease you already hold. Fails if the lock has expired or is held by another session.",
    {
      resource_key: z.string().describe("Key of the lock to renew (required)."),
      lease_ms: z.number().optional().describe("New lease duration in milliseconds. Defaults to 300000 (5 min)."),
      owner_sid: z.string().optional().describe("Session id that holds the lock. Defaults to CLAUDE_CODE_SESSION_ID."),
    },
    async ({ resource_key, lease_ms, owner_sid }) => {
      try {
        const sid = resolveOwnerSid(owner_sid, process.env.CLAUDE_CODE_SESSION_ID);
        if (!sid) {
          return { content: [{ type: "text" as const, text: "Lock renew failed: no owner_sid" }], isError: true };
        }
        const result = await client.lockRenew(joinToken, { resource_key, owner_sid: sid, lease_ms });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Lock renew failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  registerTool(
    "fleet_lock_release",
    "Meta-harness: release a resource lock you hold, making it immediately available to others.",
    {
      resource_key: z.string().describe("Key of the lock to release (required)."),
      owner_sid: z.string().optional().describe("Session id that holds the lock. Defaults to CLAUDE_CODE_SESSION_ID."),
    },
    async ({ resource_key, owner_sid }) => {
      try {
        const sid = resolveOwnerSid(owner_sid, process.env.CLAUDE_CODE_SESSION_ID);
        if (!sid) {
          return { content: [{ type: "text" as const, text: "Lock release failed: no owner_sid" }], isError: true };
        }
        const result = await client.lockRelease(joinToken, { resource_key, owner_sid: sid });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Lock release failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // === end C4 ===

  // Sign-off verb. `fleet_disconnect` is the clear primary name; `fleet_out`
  // (whose name misleadingly reads like "send out" rather than "sign off") is
  // kept as a fully-functional canonical ALIAS routed to the SAME handler. Both
  // canonical names auto-derive their deprecated radio_* counterparts.
  const radioDisconnectHandler = async () => {
    if (!currentToken) {
      return {
        content: [{ type: "text" as const, text: "Not registered." }],
      };
    }
    try {
      await client.unregister(currentToken);
      const name = currentName;
      currentToken = null;
      currentName = null;
      return {
        content: [{ type: "text" as const, text: `Unregistered "${name}". Disconnected from hub.` }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Unregister failed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  };

  // Primary: clear verb name. registerTool also derives radio_disconnect.
  registerTool("fleet_disconnect", "Sign off and disconnect from the hub.", {}, radioDisconnectHandler);
  // Canonical alias: same handler. registerTool also derives radio_out.
  registerTool(
    "fleet_out",
    "(alias of fleet_disconnect) Sign off and disconnect from the Agent Fleet hub. Over and out.",
    {},
    radioDisconnectHandler,
  );

  return server;
}
