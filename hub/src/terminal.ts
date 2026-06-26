// ===========================================================================
// Interactive terminal (cockpit) — Linux-only v1
// ---------------------------------------------------------------------------
// Lets the operator click an agent in the cockpit roster and open a real
// terminal panel that MIRRORS that agent's live tmux session over a WebSocket,
// WRITABLE by default (full control) with an explicit "Release control" toggle
// that drops back to a read-only mirror.
//
// Trust model (locked):
//   * The WS is reachable ONLY with a valid, single-use, short-lived TICKET.
//     There is NO anonymous connect path. Tickets are minted by POST
//     /terminal-ticket, which is gated by the SAME browser gate as the cockpit
//     (a scoped cockpit token or the admin token). A ticket is bound to the
//     {callsign, resolved tmux session} verified live at mint time, expires in
//     ~60s, and is consumed (deleted) the instant a WS upgrade accepts it.
//   * Writable mode (the DEFAULT) attaches the bound session directly and
//     forwards client input to the pty; every write-mode input frame is audited
//     with the authenticated identity + callsign + timestamp. Release-control
//     kills the writable pty and re-attaches a read-only `tmux attach -r` client
//     that NEVER forwards input.
//   * To avoid resizing the agent's own pane, the mirror attaches to a GROUPED
//     read-only VIEW session (its own independent size) instead of the agent's
//     session directly. The view session is torn down on disconnect. Falls back
//     to a direct `attach -r` if a grouped view can't be created.
//
// Platform: Linux/macOS (tmux). Windows agents (ConPTY) are out of scope for v1.
// ===========================================================================

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
// node-pty is a native addon. Its VALUE is loaded LAZILY (loadPty(), below) the
// first time a terminal client connects — NOT at hub import. Eager boot loading
// left node-pty's Windows console handle attached to a non-interactive launcher
// (ssh/CI), so install.ps1's backgrounded hub never let the parent shell return;
// it also means a missing native build now degrades only the terminal feature
// instead of blocking hub boot. The type import is erased at compile time.
import type { IPty } from "node-pty";
import type { WebSocket } from "ws";
import { dbListRegistry } from "./db.js";
import type { RegistryEntry } from "./types.js";

// Lazy, cached, SYNCHRONOUS node-pty loader (see the import note above). require()
// keeps the load synchronous so spawnPty() stays sync; it runs only on the first
// terminal spawn, never at hub boot.
const requireCjs = createRequire(import.meta.url);
let _pty: typeof import("node-pty") | null = null;
function loadPty(): typeof import("node-pty") {
  if (_pty === null) _pty = requireCjs("node-pty") as typeof import("node-pty");
  return _pty;
}

// ---- ticket store ---------------------------------------------------------

const TICKET_TTL_MS = 60_000; // single-use, ~60s

export interface TerminalTicket {
  token: string;
  callsign: string;
  // The resolved tmux session name (NO "tmux:" prefix) — what the pty attaches.
  tmuxSession: string;
  // Identity that minted the ticket (for the input audit). "operator" when the
  // ticket was minted via the admin/cockpit browser gate (no per-user identity).
  identity: string;
  expiresAt: number;
}

const tickets = new Map<string, TerminalTicket>();

function pruneTickets(now: number): void {
  for (const [tok, t] of tickets) {
    if (t.expiresAt <= now) tickets.delete(tok);
  }
}

// Resolve the live tmux session backing a callsign, or null if none.
// Mirrors isRegistrySessionAlive's tmux derivation: explicit "tmux:<session>"
// control_handle, else derived "wt-<spawn_id>". Verified with `tmux has-session`
// so a stale registry row can never mint a ticket to a dead session.
export function resolveLiveTmuxSession(callsign: string, registry: RegistryEntry[] = dbListRegistry()): string | null {
  // Prefer an active row; fall back to any row for the callsign.
  const rows = registry.filter((r) => r.callsign === callsign);
  if (rows.length === 0) return null;
  const ordered = [...rows.filter((r) => r.status === "active"), ...rows.filter((r) => r.status !== "active")];
  for (const entry of ordered) {
    const session = entry.control_handle?.startsWith("tmux:")
      ? entry.control_handle.slice("tmux:".length)
      : entry.spawn_id
        ? `wt-${entry.spawn_id}`
        : null;
    if (!session) continue;
    if (tmuxHasSession(session)) return session;
  }
  return null;
}

function tmuxHasSession(session: string): boolean {
  const r = spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
  return r.error == null && r.status === 0;
}

// process.env with $TMUX stripped — so child tmux invocations never refuse to
// nest when the hub itself runs inside a tmux session.
function envNoTmux(): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "TMUX") env[k] = v;
  }
  return env;
}

// Mint a single-use, short-lived ticket bound to {callsign, tmuxSession}. The
// caller MUST have already passed the browser gate. Returns null if the callsign
// has no live tmux session (caller should 404/409).
export function mintTerminalTicket(
  callsign: string,
  identity: string,
  now: number = Date.now(),
): TerminalTicket | null {
  pruneTickets(now);
  const tmuxSession = resolveLiveTmuxSession(callsign);
  if (!tmuxSession) return null;
  const token = randomBytes(32).toString("hex");
  const ticket: TerminalTicket = { token, callsign, tmuxSession, identity, expiresAt: now + TICKET_TTL_MS };
  tickets.set(token, ticket);
  return ticket;
}

// Consume (one-time) a ticket: returns it and deletes it iff valid+unexpired.
// Any second use, an unknown token, or an expired token returns null.
export function consumeTerminalTicket(
  token: string | undefined | null,
  now: number = Date.now(),
): TerminalTicket | null {
  if (!token) return null;
  const t = tickets.get(token);
  if (!t) return null;
  tickets.delete(token); // one-time: gone whether or not it was expired
  if (t.expiresAt <= now) return null;
  return t;
}

// Test-only: clear the ticket store.
export function resetTerminalTickets(): void {
  tickets.clear();
}

// ---- audit ----------------------------------------------------------------

// Audit hook for write-mode input. Default logs a one-line, NON-content record
// (never the keystrokes themselves) to the hub log. Overridable for tests.
export type TerminalAuditFn = (event: {
  kind: "open" | "control_grant" | "input" | "close";
  identity: string;
  callsign: string;
  tmuxSession: string;
  bytes?: number;
  timestamp: number;
}) => void;

let auditFn: TerminalAuditFn = (e) => {
  if (e.kind === "input") {
    // Per-frame, write-mode only. Record size + identity, NEVER the bytes.
    console.log(
      `[terminal-audit] input identity=${e.identity} callsign=${e.callsign} session=${e.tmuxSession} bytes=${e.bytes} ts=${e.timestamp}`,
    );
  } else {
    console.log(
      `[terminal-audit] ${e.kind} identity=${e.identity} callsign=${e.callsign} session=${e.tmuxSession} ts=${e.timestamp}`,
    );
  }
};

export function setTerminalAuditFn(fn: TerminalAuditFn): void {
  auditFn = fn;
}

// ---- pty / tmux attach ----------------------------------------------------

interface Mode {
  readonly: boolean;
}

// One WS connection's terminal session: owns a pty (attached to a tmux view),
// can flip read-only ↔ writable, and cleans up the pty + any view session on
// teardown.
export class TerminalSession {
  private ws: WebSocket;
  private ticket: TerminalTicket;
  private ptyProc: IPty | null = null;
  // The grouped view session this pty attaches to (so the mirror has its own
  // size and never resizes the agent's pane). null ⇒ direct `attach -r` fallback.
  private viewSession: string | null = null;
  // Writable by default (full control). Release-control drops to read-only.
  private mode: Mode = { readonly: false };
  private cols = 80;
  private rows = 24;
  private closed = false;
  private isAlive = true;
  private missedPongs = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ws: WebSocket, ticket: TerminalTicket) {
    this.ws = ws;
    this.ticket = ticket;
  }

  // Begin: spawn the read-only pty and wire the ws.
  start(): void {
    auditFn({
      kind: "open",
      identity: this.ticket.identity,
      callsign: this.ticket.callsign,
      tmuxSession: this.ticket.tmuxSession,
      timestamp: Date.now(),
    });
    this.spawnPty(false);

    this.ws.on("message", (data: Buffer, isBinary: boolean) => this.onWsMessage(data, isBinary));
    this.ws.on("close", () => this.teardown());
    this.ws.on("error", () => this.teardown());

    // Ping/pong heartbeat: tolerate 2 consecutive missed pongs before terminating
    // to avoid false positives from momentary network hiccups.
    this.ws.on("pong", () => {
      this.isAlive = true;
      this.missedPongs = 0;
    });
    this.heartbeatTimer = setInterval(() => {
      if (!this.isAlive) {
        this.missedPongs++;
        if (this.missedPongs >= 2) {
          this.ws.terminate();
          return;
        }
      }
      this.isAlive = false;
      this.ws.ping();
    }, 30_000);

    // Tell the client which mode it's in (writable by default).
    this.sendControl({ type: "mode", readonly: false });
  }

  private onWsMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;
    // Control frames are small JSON text frames beginning with '{'. Everything
    // else (binary, or non-JSON text) is terminal INPUT.
    if (!isBinary) {
      const text = data.toString("utf8");
      if (text.length > 0 && text[0] === "{") {
        let msg: { type?: string; cols?: number; rows?: number } | null = null;
        try {
          msg = JSON.parse(text);
        } catch {
          msg = null;
        }
        if (msg && typeof msg.type === "string") {
          this.onControl(msg);
          return;
        }
      }
    }
    // INPUT path. In read-only mode this is DROPPED — it never reaches the pty.
    if (this.mode.readonly) return;
    if (!this.ptyProc) return;
    auditFn({
      kind: "input",
      identity: this.ticket.identity,
      callsign: this.ticket.callsign,
      tmuxSession: this.ticket.tmuxSession,
      bytes: data.length,
      timestamp: Date.now(),
    });
    this.ptyProc.write(data.toString("utf8"));
  }

  private onControl(msg: { type?: string; cols?: number; rows?: number }): void {
    switch (msg.type) {
      case "take-control":
        this.takeControl();
        break;
      case "release-control":
        this.releaseControl();
        break;
      case "resize":
        if (typeof msg.cols === "number" && typeof msg.rows === "number") {
          this.resize(msg.cols, msg.rows);
        }
        break;
    }
  }

  // Flip to writable: kill the read-only pty and re-attach writable.
  private takeControl(): void {
    if (!this.mode.readonly) return;
    this.mode = { readonly: false };
    auditFn({
      kind: "control_grant",
      identity: this.ticket.identity,
      callsign: this.ticket.callsign,
      tmuxSession: this.ticket.tmuxSession,
      timestamp: Date.now(),
    });
    this.respawnPty(false);
    this.sendControl({ type: "mode", readonly: false });
  }

  // Flip back to read-only.
  private releaseControl(): void {
    if (this.mode.readonly) return;
    this.mode = { readonly: true };
    this.respawnPty(true);
    this.sendControl({ type: "mode", readonly: true });
  }

  private resize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.min(1000, Math.floor(cols)));
    this.rows = Math.max(1, Math.min(1000, Math.floor(rows)));
    try {
      this.ptyProc?.resize(this.cols, this.rows);
    } catch {
      /* pty may have exited */
    }
  }

  // Kill the current pty (and view session) then spawn a fresh one in `readonly`.
  private respawnPty(readonly: boolean): void {
    this.killPty();
    this.spawnPty(readonly);
  }

  // Spawn node-pty running tmux attached to the bound session.
  // Read-only: attach a grouped VIEW session read-only (independent size) when a
  // view can be created; else `attach -r` direct. Writable: attach the bound
  // session directly with no -r (typing into a grouped session still drives the
  // agent's session, since grouped sessions share windows).
  private spawnPty(readonly: boolean): void {
    const target = this.ticket.tmuxSession;
    let attachTarget = target;
    this.viewSession = null;

    if (readonly) {
      // Try a grouped read-only view session so we don't resize the agent's pane.
      const view = `view-${target}-${randomBytes(3).toString("hex")}`;
      const created = spawnSync(
        "tmux",
        ["new-session", "-d", "-t", target, "-s", view, "-x", String(this.cols), "-y", String(this.rows)],
        { stdio: "ignore", env: envNoTmux() },
      );
      if (created.error == null && created.status === 0) {
        this.viewSession = view;
        attachTarget = view;
      }
      // else: fall back to attaching the bound session read-only directly.
    }

    const args = readonly ? ["attach-session", "-r", "-t", attachTarget] : ["attach-session", "-t", attachTarget];

    // Strip $TMUX so tmux does not refuse to nest when the hub itself runs inside
    // a tmux session (it usually does). Without this, `tmux attach` exits
    // immediately ("sessions should be nested with care") and the mirror dies.
    const proc = loadPty().spawn("tmux", args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: process.env.HOME,
      env: envNoTmux(),
    });
    this.ptyProc = proc;

    proc.onData((d: string) => {
      // Ignore data from a stale pty (a previous mode's attach being torn down).
      if (this.closed || proc !== this.ptyProc) return;
      try {
        this.ws.send(d);
      } catch {
        /* ws may be closing */
      }
    });
    proc.onExit(() => {
      // CRITICAL: only the CURRENT pty exiting closes the mirror. On a mode flip
      // we kill the old pty and spawn a new one; the old pty's async onExit must
      // NOT tear down the live session (that was the take-control regression).
      if (this.closed || proc !== this.ptyProc) return;
      this.teardown();
    });
  }

  private killPty(): void {
    if (this.ptyProc) {
      try {
        this.ptyProc.kill();
      } catch {
        /* already gone */
      }
      this.ptyProc = null;
    }
    if (this.viewSession) {
      // Kill ONLY the ephemeral view session — never the agent's real session.
      spawnSync("tmux", ["kill-session", "-t", this.viewSession], { stdio: "ignore", env: envNoTmux() });
      this.viewSession = null;
    }
  }

  private sendControl(obj: Record<string, unknown>): void {
    try {
      this.ws.send(JSON.stringify({ __ctl: true, ...obj }));
    } catch {
      /* ws closing */
    }
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    auditFn({
      kind: "close",
      identity: this.ticket.identity,
      callsign: this.ticket.callsign,
      tmuxSession: this.ticket.tmuxSession,
      timestamp: Date.now(),
    });
    this.killPty();
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

// Convenience: extract the ticket query param from an upgrade request URL.
export function ticketFromUpgrade(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    return url.searchParams.get("ticket");
  } catch {
    return null;
  }
}
