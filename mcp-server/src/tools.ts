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

// ── T5: persist this session's hub identity so an MCP reconnect / restart can re-auth
// WITHOUT a manual fleet_join. The per-session token otherwise lives only in this process's
// memory (currentToken), so any MCP respawn wipes it → the next hub call 401s with no recovery.
// We persist {token,name} keyed by the Claude session id, 0600 (it's a bearer token), and the
// reauth callback replays the token as oldToken so the hub takes the clean-reconnect branch
// instead of a takeover. Cleared on operator-kill and on sign-off so a killed/closed session
// can't be silently resurrected from a stale file.
const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID;
// T5 fix (#1 keying): the persisted-token FILE must survive a SESSION RESTART so a relaunched
// fleet agent recovers its hub identity and replays the saved token as oldToken (→ hub
// clean-reconnect branch → queue preserved by the hub-side gate) instead of re-registering as
// a takeover, which sheds its pending queue — the message-loss this whole change targets.
// CLAUDE_CODE_SESSION_ID is minted fresh on every (re)launch, so it stays correct for the hub
// REGISTRATION below (owner_sid at the register() call MUST remain the real session id — the
// rewake/msgcheck hooks resolve our callsign via /whoami?sid=<that id>) but it CANNOT key a
// cross-restart file. The fleet callsign (AF_CALLSIGN, exported by the fleet launcher) is
// identical across a launcher relaunch, so key the file on it; solo (non-fleet) sessions have
// no callsign and fall back to the session id (a solo restart loses its token exactly as
// before — no regression). NOTE: only a fleet-LAUNCHER relaunch (re-exports AF_CALLSIGN) is a
// supported recovery path; a bare `claude --continue` carries neither AF_CALLSIGN nor the old
// sid, so it stays unsupported by design. Exported for unit tests.
export function persistKey(): string | undefined {
  return process.env.AF_CALLSIGN || process.env.WT_CALLSIGN || SESSION_ID;
}
export function tokenFile(): string | null {
  const key = persistKey();
  // sanitize: callsigns may contain spaces (e.g. "REFEREE Field") and must be path-safe.
  return key ? `/tmp/wt-token-${key.replace(/[^A-Za-z0-9._@-]/g, "_")}` : null;
}
function persistIdentity(): void {
  const f = tokenFile();
  if (!f || !currentToken || !currentName) return;
  try {
    fs.writeFileSync(f, JSON.stringify({ token: currentToken, name: currentName }), { mode: 0o600 });
  } catch {
    /* best-effort: persistence is an optimization, never block a join on it */
  }
}
function loadPersistedIdentity(): void {
  const f = tokenFile();
  if (!f) return;
  try {
    const obj = JSON.parse(fs.readFileSync(f, "utf8")) as { token?: string; name?: string };
    if (obj.token) currentToken = obj.token;
    if (obj.name) currentName = obj.name;
  } catch {
    /* no/invalid file → first run or never joined; stay null */
  }
}
function clearPersistedToken(): void {
  const f = tokenFile();
  if (f) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}
// Operator-kill / hard-Unauthorized: drop the identity AND its persisted file so no reauth
// resurrects it. (Plain helper so the three kill branches stay one line each.)
function forgetIdentity(): void {
  currentToken = null;
  currentName = null;
  clearPersistedToken();
}

export function createMcpServer(hubUrl: string, joinTok: string): McpServer {
  client = new HubClient(hubUrl);
  joinToken = joinTok;
  // T5: restore a token persisted by a previous incarnation of this MCP process, then arm
  // transparent re-auth. On any 401 the hub no longer recognizes our token (reconnect lost it
  // or the hub restarted): re-register with the saved oldToken so the hub takes the clean-
  // reconnect branch, persist the fresh token, and let the failed call replay — no manual
  // fleet_join, no churn. Returns null (give up) if we never joined or were operator-killed.
  loadPersistedIdentity();
  client.onUnauthorized = async () => {
    if (!currentName) return null;
    try {
      const r = await client.register(currentName, joinToken, currentToken ?? undefined, SESSION_ID ?? undefined);
      currentToken = r.token;
      currentName = r.name;
      persistIdentity();
      return r.token;
    } catch {
      return null;
    }
  };

  const server = new McpServer({
    name: "agent-fleet",
    version: "1.0.0",
  });

  // Alias-transition: register the canonical fleet_* tool plus a hidden deprecated
  // radio_* alias delegating to the SAME handler, for one transition version.
  // See ~/.claude/docs/agent-fleet-rename-plan.md (Lane A).
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
    // radio_* aliases are gated behind AF_RADIO_ALIASES (default ON during the
    // walkie-talkie→agent-fleet rename transition, so behavior is unchanged).
    // Set AF_RADIO_ALIASES=0 once the rename cutover completes to drop them —
    // removes the duplicate tool-name injection + the double ToolSearch result
    // payload. Staged lever; see ~/.claude/docs/fleet-token-efficiency-tasks.md #5.
    if (process.env.AF_RADIO_ALIASES !== "0") {
      const radioName = `radio_${fleetName.slice("fleet_".length)}`;
      server.tool(radioName, `(deprecated alias of ${fleetName}) ${description}`, schema, handler);
    }
  };

  registerTool(
    "fleet_join",
    "Join the Agent Fleet hub with a display name. You must join before using other fleet tools.",
    { name: z.string().describe("Your display name for this session") },
    async ({ name }) => {
      try {
        // Pass the Claude session id so the hub stamps sid->callsign at join time —
        // makes GET /whoami (the rewake resolver) authoritative from the first beat.
        const sid = process.env.CLAUDE_CODE_SESSION_ID;
        const result = await client.register(name, joinToken, currentToken ?? undefined, sid ?? undefined);
        currentToken = result.token;
        currentName = result.name;
        persistIdentity(); // T5: survive an MCP reconnect without a manual re-join
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

  // REFEREE failover: member-gated + vacancy-gated claim (no admin token). The
  // privileged force path stays available as fleet_become_referee.
  registerTool(
    "fleet_claim_referee",
    "Claim the REFEREE coordinator seat — succeeds only when it is empty (e.g. the prior referee was killed/offline). No admin token required; gated on fleet membership + vacancy. If a live referee holds the seat, the claim is refused.",
    {},
    async () => {
      if (!currentToken) {
        return {
          content: [{ type: "text" as const, text: "Cannot claim REFEREE: not joined to the fleet (no session token). Call fleet_join first." }],
          isError: true,
        };
      }
      try {
        const sid = process.env.CLAUDE_CODE_SESSION_ID;
        const { status, data } = await client.claimReferee(currentToken, currentName ?? undefined, sid ?? undefined);
        if (status === 200 && data.token && data.name) {
          currentToken = data.token;
          currentName = data.name;
          return {
            content: [
              {
                type: "text" as const,
                text: `You are now "${currentName}". The REFEREE seat was vacant and you claimed it; all subsequent fleet tools speak as ${currentName} and carry [principal].`,
              },
            ],
          };
        }
        if (status === 409) {
          return {
            content: [
              {
                type: "text" as const,
                text: `REFEREE seat is held by a live referee (${data.holder ?? "REFEREE"}); not claiming. Use fleet_become_referee (admin token) only if you must force it.`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Claim-referee failed (${status}): ${data.error ?? "unknown error"}` }],
          isError: true,
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Claim-referee failed: ${(e as Error).message}` }],
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
    "Send a message to a channel. Only members you @-mention are notified (nudged/woken); everyone else can read it later but is not interrupted. @-mention EVERY member the message affects by exact callsign in the body (e.g. '@alice @bob ...') — naming only one leaves the rest uninformed. @all broadcasts to the channel for transcript/progress notes and notifies NO ONE, so never use it alone for anything urgent or needing a reply. Messages are scoped to a channel.";
  const radioSendSchema = {
    to: z
      .string()
      .describe(
        "Primary recipient: @name notifies that member; @all broadcasts to the channel and notifies no one. To notify several members, also @-mention each of them in the message body.",
      ),
    message: z.string().describe("Message content. @-mention (e.g. '@alice') every member this message affects so they are notified."),
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

  // Item 1 (fleet_dm): point-to-point direct message — never enters a channel, so no
  // third agent can read it on any wake. A DISTINCT tool (not a flag on fleet_send) and
  // with NO channel param, so a mis-set field can't fan a private note to a channel.
  const fleetDmDescription =
    "Send a PRIVATE direct message to a single member, point-to-point. Unlike fleet_send it has NO channel and never enters one: only the named recipient receives it (no third agent can read it on any wake). It IS visible to the operator's cockpit for oversight. Use for a 1:1 aside; use fleet_send for anything the channel should see.";
  const fleetDmSchema = {
    to: z.string().describe("Recipient callsign (with or without a leading @). The ONLY member who receives this DM."),
    message: z.string().describe("Direct message content."),
    image_data: z
      .string()
      .optional()
      .describe("Base64-encoded image data. Must be provided together with image_mime_type."),
    image_mime_type: z
      .string()
      .optional()
      .describe("MIME type of the image (e.g. 'image/png'). Must be provided together with image_data."),
  };
  const fleetDmHandler = async ({
    to,
    message,
    image_data,
    image_mime_type,
  }: {
    to: string;
    message: string;
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
      const result = await client.dm(currentToken, to, message, image);
      return {
        content: [{ type: "text" as const, text: `DM sent to ${result.to} (id: ${result.id})` }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `DM failed: ${(e as Error).message}` }],
        isError: true,
      };
    }
  };
  registerTool("fleet_dm", fleetDmDescription, fleetDmSchema, fleetDmHandler);

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
          forgetIdentity();
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
          // A DM has no channel — render it as a private aside, not a channel line.
          const line = m.dm
            ? `[DM] ${m.from}${principalTag} → you: ${m.content}${imageTag}`
            : `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.channel || "#all"} ${m.from}${principalTag} → ${m.to}: ${m.content}${imageTag}`;
          contentBlocks.push({ type: "text" as const, text: line });
        }
        // DMs are excluded from the channel-reply hint (they have no channel to reply in).
        const channels = [
          ...new Set(result.messages.filter((m) => !m.dm && m.channel && m.channel !== "#all").map((m) => m.channel)),
        ];
        if (channels.length > 0) {
          contentBlocks.push({
            type: "text" as const,
            text: `\nIMPORTANT: Reply in the same channel you received the message on. Use the channel parameter: ${channels.map((c) => `"${c}"`).join(", ")}`,
          });
        }
        const dmSenders = [...new Set(result.messages.filter((m) => m.dm).map((m) => m.from))];
        if (dmSenders.length > 0) {
          contentBlocks.push({
            type: "text" as const,
            text: `\nDirect message(s) from ${dmSenders.map((s) => `@${s}`).join(", ")} — reply privately with fleet_dm (these are NOT in any channel).`,
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
          forgetIdentity();
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
          forgetIdentity();
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
    "Set your one-line mission on the shared task board — a deliberate, concise statement of what you're working on (e.g. 'Hardening the auth endpoints'). Visible to all agents and the operator. Set it right after fleet_join and update it whenever your task changes. Keep it free of secrets. Pass an empty string to clear it.",
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
      resource_key: z.string().describe("Unique key for the contested surface, e.g. 'hub:server.ts' or 'db:appdb' (required)."),
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
      forgetIdentity(); // T5: sign-off clears the persisted token too
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

  // ── Loop governor (Phase 1): make loops first-class GOVERNED objects ───────────
  // The hub is the GOVERNOR, not the executor: your agent runs its own loop and calls
  // fleet_loop_tick each iteration to get a continue/stop decision. Stop-conditions are
  // a hard guardrail — the fleet rides a shared quota, so a runaway loop burns everyone's.
  const notOnAir = {
    content: [{ type: "text" as const, text: "Not on the air. Use fleet_join first." }],
    isError: true as const,
  };
  registerTool(
    "fleet_loop_create",
    "Loop governor: register a GOVERNED loop so iterative/autonomous work runs under enforceable stop-conditions. Returns the loop id; call fleet_loop_tick each iteration for a continue/stop decision. You become the loop's owner (only you or an operator may pause/resume/stop it).",
    {
      kind: z.string().describe("Loop kind, e.g. 'evaluator_optimizer' | 'autonomous' | 'generic'."),
      label: z.string().describe("Human-readable label for the loop."),
      config: z
        .object({
          max_iterations: z.number().optional().describe("Hard backstop on iterations."),
          token_budget: z.number().optional().describe("Stop when accumulated agent-reported tokens reach this."),
          wall_clock_timeout_ms: z.number().optional().describe("Stop when (now - created_at) reaches this."),
          completeness_threshold: z.number().optional().describe("Stop when reported completeness >= this (0..1)."),
          confidence_threshold: z.number().optional().describe("Stop when reported confidence >= this (0..1)."),
          diminishing_returns: z
            .object({ window: z.number(), min_improvement: z.number() })
            .optional()
            .describe("Stop when the last `window` improvements are all below min_improvement."),
          repetition: z
            .object({ window: z.number() })
            .optional()
            .describe("Stop when the last `window` reported signatures are all identical."),
          evaluator_optimizer: z
            .object({
              completeness_target: z
                .number()
                .optional()
                .describe("Accept (guardrail) when reported completeness >= this, even if the judge keeps saying retry."),
              plateau: z
                .object({ window: z.number(), epsilon: z.number() })
                .optional()
                .describe("Stop with 'plateau' when the last `window` completeness scores span <= epsilon."),
            })
            .optional()
            .describe("Evaluator-optimizer guardrails for kind:'evaluator_optimizer' loops (use with fleet_loop_verdict)."),
          fleet_pool: z.string().nullable().optional().describe("Seam for a future fleet-wide quota pool."),
        })
        .optional()
        .describe("Composable stop-conditions, all optional, evaluated OR-wise (first-trip-wins)."),
      interval_ms: z
        .number()
        .positive()
        .optional()
        .describe(
          "Phase 3: makes this a RECURRING loop firing every interval_ms. The hub re-arms the next fire off a wall-clock grid (anchor + N*interval), so a late tick never makes the schedule drift. Omit for a normal one-shot loop.",
        ),
      anchor_ms: z
        .number()
        .optional()
        .describe(
          "Phase 3: epoch-ms grid origin for a recurring loop (fires at anchor, anchor+interval, ...). Defaults to creation time. Only meaningful with interval_ms.",
        ),
    },
    async ({ kind, label, config, interval_ms, anchor_ms }) => {
      if (!currentToken) return notOnAir;
      try {
        const result = await client.loopCreate(currentToken, {
          kind,
          label,
          config,
          interval_ms,
          anchor_ms,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Loop create failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  registerTool(
    "fleet_loop_tick",
    "Loop governor — THE control point. Report this iteration's progress; the hub evaluates ALL stop-conditions and returns {continue, stop_reason?}. Call once per iteration; stop your loop when continue is false.",
    {
      id: z.string().describe("Loop id from fleet_loop_create."),
      iteration_delta: z.number().optional().describe("Iterations to add (default 1)."),
      tokens_delta: z.number().optional().describe("Tokens consumed this iteration (agent-reported; default 0)."),
      improvement: z.number().optional().describe("Progress delta this iteration (for diminishing-returns)."),
      completeness: z.number().optional().describe("Current completeness 0..1 (for completeness_threshold)."),
      confidence: z.number().optional().describe("Current confidence 0..1 (for confidence_threshold)."),
      signature: z.string().optional().describe("Opaque hash of this iteration's action (for repetition detection)."),
    },
    async ({ id, iteration_delta, tokens_delta, improvement, completeness, confidence, signature }) => {
      if (!currentToken) return notOnAir;
      try {
        const result = await client.loopTick(currentToken, {
          id,
          iteration_delta,
          tokens_delta,
          improvement,
          completeness,
          confidence,
          signature,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Loop tick failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  registerTool(
    "fleet_loop_verdict",
    "Loop governor (evaluator-optimizer): submit a JUDGE's structured verdict for this iteration. The hub records the completeness-score trajectory, then returns {result:{continue, stop_reason?}, loop}. stop_reason is 'accepted' (judge accepted, or completeness_target reached), 'escalated' (route to a human / HITL queue), or 'plateau' (scores stopped improving). Counts as one iteration. Bias mitigation: use a judge that did NOT produce the candidate, and pass its id as `judge`.",
    {
      id: z.string().describe("Loop id from fleet_loop_create."),
      verdict: z
        .object({
          status: z.enum(["complete", "partial", "incomplete"]).describe("Overall judgment of the candidate."),
          completeness: z.number().describe("How complete the result is, 0..1 (plotted as the score trajectory)."),
          missing: z.array(z.string()).optional().describe("Gaps the judge identified."),
          contradictions: z.array(z.string()).optional().describe("Internal inconsistencies the judge found."),
          recommendation: z
            .enum(["accept", "retry", "escalate"])
            .describe("The action: accept=done, retry=iterate, escalate=hand to a human."),
          rationale: z.string().optional().describe("Optional judge explanation (stored, never interpreted)."),
          judge: z.string().optional().describe("Optional judge id/model for provenance / bias audits."),
        })
        .describe("Structured ResultVerifier verdict for this iteration."),
      iteration_delta: z.number().optional().describe("Iterations to add (default 1)."),
      tokens_delta: z.number().optional().describe("Tokens consumed this iteration (agent-reported; default 0)."),
    },
    async ({ id, verdict, iteration_delta, tokens_delta }) => {
      if (!currentToken) return notOnAir;
      try {
        const result = await client.loopVerdict(currentToken, { id, verdict, iteration_delta, tokens_delta });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Loop verdict failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  registerTool(
    "fleet_loop_pause",
    "Loop governor: pause a loop you own (ticks return continue:false with stop_reason 'paused' until resumed).",
    { id: z.string().describe("Loop id.") },
    async ({ id }) => {
      if (!currentToken) return notOnAir;
      try {
        const result = await client.loopLifecycle(currentToken, "/loop-pause", { id });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Loop pause failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  registerTool(
    "fleet_loop_resume",
    "Loop governor: resume a paused loop you own.",
    { id: z.string().describe("Loop id.") },
    async ({ id }) => {
      if (!currentToken) return notOnAir;
      try {
        const result = await client.loopLifecycle(currentToken, "/loop-resume", { id });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Loop resume failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  registerTool(
    "fleet_loop_stop",
    "Loop governor: stop a loop you own (terminal). Operators force-stop any loop via fleet_loop_admin_stop.",
    {
      id: z.string().describe("Loop id."),
      reason: z.string().optional().describe("Optional stop reason (default external_terminate)."),
    },
    async ({ id, reason }) => {
      if (!currentToken) return notOnAir;
      try {
        const result = await client.loopLifecycle(currentToken, "/loop-stop", { id, reason });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Loop stop failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  registerTool(
    "fleet_loop_get",
    "Loop governor: fetch one loop's full record (status, config, accumulated state, stop_reason).",
    { id: z.string().describe("Loop id.") },
    async ({ id }) => {
      if (!currentToken) return notOnAir;
      try {
        const result = await client.loopGet(currentToken, id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Loop get failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  registerTool(
    "fleet_loop_list",
    "Loop governor: list loops, optionally filtered by status or owner_callsign (the cockpit reads this).",
    {
      status: z.string().optional().describe("Filter: running | paused | stopped | completed."),
      owner_callsign: z.string().optional().describe("Filter by owner callsign."),
    },
    async ({ status, owner_callsign }) => {
      if (!currentToken) return notOnAir;
      try {
        const result = await client.loopList(currentToken, { status, owner_callsign });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Loop list failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );
  registerTool(
    "fleet_loop_admin_stop",
    "Loop governor (operator): force-stop ANY loop regardless of owner. Requires AGENT_FLEET_ADMIN_TOKEN in the environment. Use to kill a runaway loop burning the shared quota.",
    {
      id: z.string().describe("Loop id to force-stop."),
      reason: z.string().optional().describe("Optional stop reason (default external_terminate)."),
    },
    async ({ id, reason }) => {
      const adminToken = process.env.AGENT_FLEET_ADMIN_TOKEN ?? process.env.WALKIE_TALKIE_ADMIN_TOKEN;
      if (!adminToken) {
        return {
          content: [{ type: "text" as const, text: "Cannot force-stop: AGENT_FLEET_ADMIN_TOKEN is not set in this session's environment." }],
          isError: true,
        };
      }
      try {
        const result = await client.loopAdminStop(adminToken, id, reason);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Loop admin-stop failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // Item 2 (loop-goal): operator authors a DRAFT goal loop from a one-sentence objective.
  registerTool(
    "fleet_loop_admin_create_draft",
    "Loop governor (operator): author a DRAFT goal-driven loop from a one-sentence objective. Requires AGENT_FLEET_ADMIN_TOKEN. The loop starts in 'draft' (nothing running) until a Referee binds it and its acceptance criteria are approved.",
    {
      goal: z.string().describe("The operator's one-sentence objective for the loop."),
      label: z.string().optional().describe("Optional short label (defaults to the goal)."),
      auto_approve: z
        .boolean()
        .optional()
        .describe("Skip the criteria-approval gate for this loop (trusted repeat runs)."),
    },
    async ({ goal, label, auto_approve }) => {
      const adminToken = process.env.AGENT_FLEET_ADMIN_TOKEN ?? process.env.WALKIE_TALKIE_ADMIN_TOKEN;
      if (!adminToken) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Cannot create draft loop: AGENT_FLEET_ADMIN_TOKEN is not set in this session's environment.",
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await client.loopAdminCreateDraft(adminToken, { goal, label, auto_approve });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Loop create-draft failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // Item 2 (loop-goal): a Referee binds a draft loop + proposes its acceptance criteria.
  registerTool(
    "fleet_loop_bind",
    "Loop governor (Referee): bind yourself to a DRAFT goal loop and propose its acceptance criteria. Ownership transfers to you and the loop moves to 'awaiting_approval' (or straight to 'running' if the loop's auto_approve is set). Then delegate the work via fleet_plan_create/fleet_task_create and judge each wave with fleet_loop_verdict.",
    {
      id: z.string().describe("Draft loop id to bind."),
      criteria: z
        .object({
          rubric: z
            .string()
            .describe("Qualitative rubric: how you (Referee-as-judge) will score each wave against the goal."),
          completeness_target: z
            .number()
            .optional()
            .describe("Accept guardrail: completeness (0..1) at which the loop is done."),
          plateau: z
            .object({ window: z.number(), epsilon: z.number() })
            .optional()
            .describe("Stop with 'plateau' when the last `window` scores span <= epsilon."),
        })
        .describe("The acceptance bundle proposed for operator approval (rubric + numeric guardrails)."),
      project_id: z.string().optional().describe("Optional: the Plan this loop will delegate to (append-wave)."),
    },
    async ({ id, criteria, project_id }) => {
      if (!currentToken) return notOnAir;
      try {
        const result = await client.loopBind(currentToken, { id, criteria, project_id });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Loop bind failed: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // Item 3 (+Referee dialog): the spawned referee reads its launch assignment.
  registerTool(
    "fleet_referee_spec",
    "Loop governor (Referee): read (and consume, one-shot) your launch assignment from the +Referee dialog — {channel, builder_count, loop_id}. Returns spec:null if you were not launched via the dialog. On a non-null spec: join the channel, then fleet_loop_bind the loop_id and propose its acceptance criteria.",
    {},
    async () => {
      if (!currentToken) return notOnAir;
      try {
        const result = await client.refereeSpec(currentToken);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Referee-spec fetch failed: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
