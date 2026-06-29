import http from "node:http";
import https from "node:https";

interface RequestOptions {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
  // T5 (internal): _retried caps transparent re-auth at a single retry; _noReauth opts a
  // call out of the 401→re-register→replay loop (the register/unregister calls themselves,
  // so a failed (re)register can't recurse into another re-auth).
  _retried?: boolean;
  _noReauth?: boolean;
}

interface HubResponse<T = unknown> {
  status: number;
  data: T;
}

export class HubClient {
  private baseUrl: URL;

  // T5: set by tools.ts. On a 401 (hub no longer recognizes our token — MCP reconnect
  // dropped it, or the hub restarted), request() calls this to re-register with the saved
  // oldToken and returns a fresh token; the original request then replays once with it.
  // Returns null to give up (never joined / operator-killed) so the 401 surfaces normally.
  onUnauthorized?: () => Promise<string | null>;

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
            // T5 transparent re-auth: a 401 means the hub no longer knows our token. Ask the
            // owner to re-register (returns a fresh token), then replay THIS request once with
            // it. _retried caps it at one retry; _noReauth exempts the (un)register calls so a
            // failed re-register can't recurse. On give-up the 401 falls through to the caller.
            if (status === 401 && this.onUnauthorized && !options._retried && !options._noReauth) {
              this.onUnauthorized()
                .then((newToken) => {
                  if (newToken) {
                    this.request<T>({ ...options, token: newToken, _retried: true }).then(resolve, reject);
                  } else {
                    resolve({ status, data: {} as T });
                  }
                })
                .catch(() => resolve({ status, data: {} as T }));
              return;
            }
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

  async register(
    name: string,
    joinToken: string,
    oldToken?: string,
    sid?: string,
  ): Promise<{ token: string; name: string }> {
    const body: { name: string; oldToken?: string; sid?: string } = { name };
    if (oldToken) body.oldToken = oldToken;
    // sid lets the hub stamp the registry row's callsign at join time so GET /whoami
    // (which the rewake hooks use) is authoritative immediately, not only after the
    // first board-update.
    if (sid) body.sid = sid;
    const res = await this.request<{ token: string; name: string }>({
      method: "POST",
      path: "/register",
      token: joinToken,
      body,
      _noReauth: true, // T5: register IS the re-auth path — never recurse into it
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

  // REFEREE failover: claim the REFEREE seat using the session's normal MEMBER
  // token (NO admin token). The hub mints REFEREE only when the seat is vacant
  // (no referee, or a stale/offline one); a live referee yields 409. The status is
  // returned raw so the caller can distinguish 200 (claimed) from 409 (occupied)
  // from other failures. `oldName` sheds the caller's current callsign; `sid`
  // aligns the registry row.
  async claimReferee(
    token: string,
    oldName?: string,
    sid?: string,
  ): Promise<{ status: number; data: { token?: string; name?: string; error?: string; holder?: string } }> {
    const body: { oldName?: string; sid?: string } = {};
    if (oldName) body.oldName = oldName;
    if (sid) body.sid = sid;
    const res = await this.request<{ token?: string; name?: string; error?: string; holder?: string }>({
      method: "POST",
      path: "/claim-referee",
      token,
      body,
    });
    return { status: res.status, data: res.data };
  }

  async unregister(token: string): Promise<void> {
    await this.request({
      method: "POST",
      path: "/unregister",
      token,
      _noReauth: true, // T5: sign-off is terminal — don't re-auth just to unregister
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

  // Item 1 (fleet_dm): point-to-point direct message. Mirrors send() but hits /dm and
  // carries no channel — the hub delivers it only to the recipient's queue.
  async dm(
    token: string,
    to: string,
    content: string,
    image?: { data: string; mimeType: string },
  ): Promise<{ id: string; to: string }> {
    const body: { to: string; content: string; image?: { data: string; mimeType: string } } = { to, content };
    if (image) body.image = image;
    const res = await this.request<{ id: string; to: string }>({
      method: "POST",
      path: "/dm",
      token,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "DM failed");
    }
    return res.data;
  }

  // ── Loop governor (Phase 1) ──────────────────────────────────────────────────
  async loopCreate(
    token: string,
    body: {
      kind: string;
      label: string;
      owner_sid?: string | null;
      config?: unknown;
      // Phase 3: recurring-loop schedule (optional; omit for a normal loop).
      interval_ms?: number | null;
      anchor_ms?: number | null;
    },
  ): Promise<unknown> {
    const res = await this.request<unknown>({ method: "POST", path: "/loop-create", token, body });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Loop create failed");
    }
    return res.data;
  }

  async loopTick(
    token: string,
    body: {
      id: string;
      iteration_delta?: number;
      tokens_delta?: number;
      improvement?: number;
      completeness?: number;
      confidence?: number;
      signature?: string;
    },
  ): Promise<{ continue: boolean; stop_reason?: string }> {
    const res = await this.request<{ continue: boolean; stop_reason?: string }>({
      method: "POST",
      path: "/loop-tick",
      token,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Loop tick failed");
    }
    return res.data;
  }

  async loopVerdict(
    token: string,
    body: {
      id: string;
      verdict: unknown;
      iteration_delta?: number;
      tokens_delta?: number;
    },
  ): Promise<{ result: { continue: boolean; stop_reason?: string }; loop?: unknown }> {
    const res = await this.request<{ result: { continue: boolean; stop_reason?: string }; loop?: unknown }>({
      method: "POST",
      path: "/loop-verdict",
      token,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Loop verdict failed");
    }
    return res.data;
  }

  async loopLifecycle(
    token: string,
    path: "/loop-pause" | "/loop-resume" | "/loop-stop",
    body: { id: string; reason?: string },
  ): Promise<unknown> {
    const res = await this.request<unknown>({ method: "POST", path, token, body });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Loop lifecycle op failed");
    }
    return res.data;
  }

  async loopGet(token: string, id: string): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/loop-get",
      token,
      body: { id },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Loop get failed");
    }
    return res.data;
  }

  async loopList(token: string, filter?: { status?: string; owner_callsign?: string }): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/loop-list",
      token,
      body: filter ?? {},
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Loop list failed");
    }
    return res.data;
  }

  async loopAdminStop(adminToken: string, id: string, reason?: string): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/loop-admin-stop",
      token: adminToken,
      body: { id, reason },
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Loop admin-stop failed");
    }
    return res.data;
  }

  // Item 2 (loop-goal): operator authors a draft goal loop (admin-token).
  async loopAdminCreateDraft(
    adminToken: string,
    body: { label?: string; goal: string; auto_approve?: boolean },
  ): Promise<unknown> {
    const res = await this.request<unknown>({
      method: "POST",
      path: "/loop-admin-create-draft",
      token: adminToken,
      body,
    });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Loop create-draft failed");
    }
    return res.data;
  }

  // Item 2 (loop-goal): a Referee binds a draft loop + proposes acceptance criteria.
  async loopBind(
    token: string,
    body: {
      id: string;
      criteria: { rubric: string; completeness_target?: number; plateau?: { window: number; epsilon: number } };
      project_id?: string;
    },
  ): Promise<unknown> {
    const res = await this.request<unknown>({ method: "POST", path: "/loop-bind", token, body });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Loop bind failed");
    }
    return res.data;
  }

  // Item 3 (+Referee dialog): the spawned referee reads (one-shot consumes) its launch
  // assignment {channel, builder_count, loop_id}, or null if there's no pending spec.
  async refereeSpec(
    token: string,
  ): Promise<{ spec: { id: string; channel: string; builder_count: number; loop_id: string | null } | null }> {
    const res = await this.request<{
      spec: { id: string; channel: string; builder_count: number; loop_id: string | null } | null;
    }>({ method: "GET", path: "/referee-spec", token });
    if (res.status !== 200) {
      throw new Error((res.data as { error?: string }).error ?? "Referee-spec fetch failed");
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
      dm?: boolean;
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
      dm?: boolean;
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
