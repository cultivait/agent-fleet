import http from "node:http";
import https from "node:https";

interface RequestOptions {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

interface HubResponse<T = unknown> {
  status: number;
  data: T;
}

export class HubClient {
  private baseUrl: URL;

  constructor(hubUrl: string) {
    this.baseUrl = new URL(hubUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl.toString().replace(/\/$/, "");
  }

  private request<T>(options: RequestOptions): Promise<HubResponse<T>> {
    return new Promise((resolve, reject) => {
      const isHttps = this.baseUrl.protocol === "https:";
      const transport = isHttps ? https : http;

      const headers: Record<string, string> = {};
      if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
      }

      let bodyStr: string | undefined;
      if (options.body !== undefined) {
        bodyStr = JSON.stringify(options.body);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
      }

      const req = transport.request(
        {
          hostname: this.baseUrl.hostname,
          port: this.baseUrl.port,
          path: options.path,
          method: options.method,
          headers,
          timeout: options.timeoutMs ?? 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            const status = res.statusCode ?? 0;
            if (status === 204 || raw.length === 0) {
              resolve({ status, data: {} as T });
              return;
            }
            try {
              resolve({ status, data: JSON.parse(raw) as T });
            } catch {
              reject(new Error(`Invalid JSON response: ${raw}`));
            }
          });
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async register(name: string, joinToken: string, oldToken?: string): Promise<{ token: string; name: string }> {
    const body: { name: string; oldToken?: string } = { name };
    if (oldToken) body.oldToken = oldToken;
    const res = await this.request<{ token: string; name: string }>({
      method: "POST",
      path: "/register",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Registration failed");
    }
    return res.data;
  }

  // REFEREE: admin-token-gated registration that mints an operator-identity
  // callsign (e.g. "REFEREE") which the normal join-token /register path refuses.
  // `oldName` sheds the agent's auto-joined callsign; `sid` aligns the registry
  // row's callsign with the renamed identity. Authenticated with the ADMIN token.
  async adminRegister(
    name: string,
    adminToken: string,
    oldName?: string,
    sid?: string,
  ): Promise<{ token: string; name: string }> {
    const body: { name: string; oldName?: string; sid?: string } = { name };
    if (oldName) body.oldName = oldName;
    if (sid) body.sid = sid;
    const res = await this.request<{ token: string; name: string }>({
      method: "POST",
      path: "/admin-register",
      token: adminToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Admin registration failed");
    }
    return res.data;
  }

  async unregister(token: string): Promise<void> {
    await this.request({
      method: "POST",
      path: "/unregister",
      token,
    });
  }

  async send(
    token: string,
    to: string,
    content: string,
    channel?: string,
    image?: { data: string; mimeType: string },
  ): Promise<{ id: string; to: string }> {
    const body: { to: string; content: string; channel?: string; image?: { data: string; mimeType: string } } = {
      to,
      content,
    };
    if (channel) body.channel = channel;
    if (image) body.image = image;
    const res = await this.request<{ id: string; to: string }>({
      method: "POST",
      path: "/send",
      token,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Send failed");
    }
    return res.data;
  }

  async poll(token: string): Promise<{
    messages: Array<{
      id: string;
      from: string;
      to: string;
      content: string;
      channel: string;
      timestamp: number;
      image?: { data: string; mimeType: string };
      principal?: boolean;
    }>;
  } | null> {
    const res = await this.request<{
      messages: Array<{
        id: string;
        from: string;
        to: string;
        content: string;
        channel: string;
        timestamp: number;
        image?: { data: string; mimeType: string };
        principal?: boolean;
      }>;
    }>({
      method: "GET",
      path: "/poll",
      token,
      timeoutMs: 3_660_000, // 1 hour + 60s margin
    });
    if (res.status === 204) return null;
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Poll failed");
    }
    return res.data;
  }

  async inbox(token: string): Promise<{
    messages: Array<{
      id: string;
      from: string;
      to: string;
      content: string;
      channel: string;
      timestamp: number;
      image?: { data: string; mimeType: string };
      principal?: boolean;
    }>;
  }> {
    const res = await this.request<{
      messages: Array<{
        id: string;
        from: string;
        to: string;
        content: string;
        channel: string;
        timestamp: number;
        image?: { data: string; mimeType: string };
        principal?: boolean;
      }>;
    }>({
      method: "GET",
      path: "/inbox",
      token,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Inbox fetch failed");
    }
    return res.data;
  }

  async users(token: string): Promise<string[]> {
    const res = await this.request<{ users: string[] }>({
      method: "GET",
      path: "/users",
      token,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to get users");
    }
    return res.data.users;
  }

  async listChannels(token: string): Promise<Array<{ name: string; memberCount: number; createdBy: string }>> {
    const res = await this.request<{ channels: Array<{ name: string; memberCount: number; createdBy: string }> }>({
      method: "GET",
      path: "/channels",
      token,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to list channels");
    }
    return res.data.channels;
  }

  async getBoard(token?: string): Promise<
    Array<{
      name: string;
      node: string | null;
      status: "active" | "idle" | "signed-off";
      mission: string | null;
      activity: string | null;
      todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | null;
      subagents: number;
      updatedAt: number;
      online: boolean;
    }>
  > {
    const res = await this.request<{
      board: Array<{
        name: string;
        node: string | null;
        status: "active" | "idle" | "signed-off";
        mission: string | null;
        activity: string | null;
        todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | null;
        subagents: number;
        updatedAt: number;
        online: boolean;
      }>;
    }>({
      method: "GET",
      path: "/board",
      token,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to fetch board");
    }
    return res.data.board;
  }

  async updateBoard(
    joinToken: string,
    body: { name: string; mission?: string | null; status?: string | null },
  ): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/board-update",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Board update failed");
    }
  }

  async createChannel(token: string, name: string): Promise<{ channel: string }> {
    const res = await this.request<{ ok: boolean; channel: string }>({
      method: "POST",
      path: "/channel-create",
      token,
      body: { name },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to create channel");
    }
    return { channel: res.data.channel };
  }

  async joinChannel(token: string, channel: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-join",
      token,
      body: { channel },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to join channel");
    }
  }

  async leaveChannel(token: string, channel: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-leave",
      token,
      body: { channel },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to leave channel");
    }
  }

  async inviteToChannel(token: string, channel: string, user: string): Promise<void> {
    const res = await this.request({
      method: "POST",
      path: "/channel-invite",
      token,
      body: { channel, user },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Failed to invite user to channel");
    }
  }

  // ---------------------------------------------------------------------------
  // Meta-harness plan core. POST endpoints are join-token authed (joinRoutes on
  // the hub, same path /board-update uses); GET endpoints are public (no token).
  // Each method returns the hub's JSON response verbatim to the caller.
  // ---------------------------------------------------------------------------

  async planCreate(
    joinToken: string,
    body: { title: string; brief?: string; by?: string },
  ): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/project-create",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Project create failed");
    }
    return res.data;
  }

  async taskCreate(
    joinToken: string,
    body: {
      project_id: string;
      title: string;
      detail?: string;
      parent_id?: string;
      priority?: number;
      deps?: string[];
      by?: string;
    },
  ): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/task-create",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Task create failed");
    }
    return res.data;
  }

  async taskTransition(
    joinToken: string,
    body: { task_id: string; to: string; actor?: string; note?: string },
  ): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/task-transition",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Task transition failed");
    }
    return res.data;
  }

  async taskClaim(
    joinToken: string,
    body: { task_id: string; owner: string; owner_sid?: string; actor?: string },
  ): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/task-claim",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Task claim failed");
    }
    return res.data;
  }

  async taskHeartbeat(joinToken: string, body: { task_id: string; owner_sid: string }): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/task-heartbeat",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Task heartbeat failed");
    }
    return res.data;
  }

  async taskDepAdd(joinToken: string, body: { task_id: string; blocks_on: string }): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/task-dep-add",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Task dep add failed");
    }
    return res.data;
  }

  async taskArtifact(
    joinToken: string,
    body: { task_id: string; kind: string; uri: string; note?: string; actor?: string },
  ): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/task-artifact",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Task artifact failed");
    }
    return res.data;
  }

  async taskHandoff(
    joinToken: string,
    body: {
      task_id: string;
      actor?: string;
      summary: string;
      next_step?: string;
      blockers?: string[];
      artifacts?: Array<{ kind: string; uri: string; note?: string }>;
    },
  ): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/task-handoff",
      token: joinToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Task handoff failed");
    }
    return res.data;
  }

  async planGet(projectId: string): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "GET",
      path: `/plan-get?project_id=${encodeURIComponent(projectId)}`,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Plan get failed");
    }
    return res.data;
  }

  async planBoard(projectId: string): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "GET",
      path: `/plan-board?project_id=${encodeURIComponent(projectId)}`,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Plan board failed");
    }
    return res.data;
  }

  async planOwned(ownerSid: string): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "GET",
      path: `/plan-owned?owner_sid=${encodeURIComponent(ownerSid)}`,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Plan owned failed");
    }
    return res.data;
  }

  async tasksReady(): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "GET",
      path: "/tasks-ready",
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Tasks ready failed");
    }
    return res.data;
  }

  async taskHandoffs(taskId: string): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "GET",
      path: `/task-handoffs?task_id=${encodeURIComponent(taskId)}`,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Task handoffs failed");
    }
    return res.data;
  }

  // C1: acknowledge a BLOCKING message — clears the pending_ack row and wakes
  // the blocked sender's task (blocked → in_progress).
  async ack(token: string, msgId: string): Promise<{ ok: boolean; msg_id: string; unblocked: string[] }> {
    const res = await this.request<{ ok: boolean; msg_id: string; unblocked: string[] }>({
      method: "POST",
      path: "/ack",
      token,
      body: { msg_id: msgId },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Ack failed");
    }
    return res.data;
  }

  // === C4: resource lock methods ===
  async lockAcquire(
    joinToken: string,
    body: { resource_key: string; owner_sid: string; lease_ms?: number },
  ): Promise<unknown> {
    const res = await this.request<unknown>({ method: "POST", path: "/resource-lock-acquire", token: joinToken, body });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Lock acquire failed");
    }
    return res.data;
  }

  async lockRenew(
    joinToken: string,
    body: { resource_key: string; owner_sid: string; lease_ms?: number },
  ): Promise<unknown> {
    const res = await this.request<unknown>({ method: "POST", path: "/resource-lock-renew", token: joinToken, body });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Lock renew failed");
    }
    return res.data;
  }

  async lockRelease(
    joinToken: string,
    body: { resource_key: string; owner_sid: string },
  ): Promise<unknown> {
    const res = await this.request<unknown>({ method: "POST", path: "/resource-lock-release", token: joinToken, body });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Lock release failed");
    }
    return res.data;
  }

  async lockGet(resourceKey: string): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "GET",
      path: `/resource-lock-get?resource_key=${encodeURIComponent(resourceKey)}`,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Lock get failed");
    }
    return res.data;
  }
}
