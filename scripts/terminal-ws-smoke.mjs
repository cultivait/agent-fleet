// Offline WS smoke test for the cockpit interactive terminal.
// Runs the hub on a THROWAWAY port (9610), never :9559. Creates its OWN
// uniquely-named throwaway tmux session and only ever kills that one.
//
// Asserts:
//   (a) unauth ticket request -> rejected (401)
//   (b) WS with no/invalid ticket -> rejected
//   (c) read-only mode: input sent over WS does NOT reach the pty (the tmux
//       session content is unchanged)
//   + main path: a valid ticket -> WS -> receive tmux pane output.
//   + (P3) take-control: write-mode input DOES reach the pty and is audited.
//
// Run from the repo root (so the `ws` dep resolves) after `npm run build`:
//   node scripts/terminal-ws-smoke.mjs
// Requires: tmux on PATH, the hub built to hub/dist. Never touches :9559.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// Default to this repo's hub/dist; override with HUB_DIST if needed.
const DEFAULT_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "hub", "dist");
const HUB = "file://" + (process.env.HUB_DIST || DEFAULT_DIST) + "/";
const { createHubServer } = await import(HUB + "server.js");
const { initDB, dbRegistryUpsert } = await import(HUB + "db.js");
const { initGeneralChannel } = await import(HUB + "channels.js");
const { mintCockpitToken } = await import(HUB + "auth.js");
const { setTerminalAuditFn } = await import(HUB + "terminal.js");

// Default audit just logs; null restores it. Custom fn captures events for asserts.
function setAudit(fn) {
  if (fn) {
    setTerminalAuditFn(fn);
  } else {
    setTerminalAuditFn((e) => {
      if (e.kind === "input") console.log(`[terminal-audit] input identity=${e.identity} callsign=${e.callsign} bytes=${e.bytes}`);
      else console.log(`[terminal-audit] ${e.kind} identity=${e.identity} callsign=${e.callsign}`);
    });
  }
}

const PORT = 9610;
const ADMIN = "smoke-admin-token";
const JOIN = "smoke-join-token";
const BASE = `http://127.0.0.1:${PORT}`;
const CALLSIGN = "smoke-agent";
const SESSION = "wt-smoke-" + randomBytes(3).toString("hex"); // throwaway, unique
const SPAWN_ID = "smoke-" + randomBytes(3).toString("hex");

const results = [];
function rec(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} :: ${name}${detail ? " :: " + detail : ""}`);
}

function tmux(args) {
  return spawnSync("tmux", args, { encoding: "utf8" });
}
function capturePane(session) {
  const r = tmux(["capture-pane", "-p", "-t", session]);
  return r.status === 0 ? r.stdout : "";
}

// Accumulate ALL pane output over the window (the first frame is just the
// xterm init/clear sequence; real pane content follows). Resolve early once the
// marker is seen, else resolve at the timeout with whatever accumulated.
async function recvPaneOutput(ws, marker, timeoutMs) {
  return new Promise((resolve) => {
    let got = "";
    const timer = setTimeout(() => resolve(got), timeoutMs);
    ws.on("message", (data) => {
      const s = data.toString("utf8");
      if (s.startsWith('{"__ctl"')) return; // skip our control frames
      got += s;
      if (got.includes(marker)) {
        clearTimeout(timer);
        resolve(got);
      }
    });
  });
}

let server;
async function main() {
  // ---- hub on throwaway port ----
  process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
  initDB();
  initGeneralChannel();
  server = createHubServer(PORT, ADMIN, JOIN);
  await new Promise((res) => server.on("listening", res));

  // ---- throwaway tmux session running a visible loop ----
  // A self-driving loop that writes the marker line repeatedly so capture-pane
  // and the WS stream both have content without needing a client to type.
  const created = tmux([
    "new-session", "-d", "-s", SESSION,
    "sh", "-c", "i=0; while :; do echo SMOKE_LINE_$i; i=$((i+1)); sleep 0.5; done",
  ]);
  if (created.status !== 0) throw new Error("could not create throwaway tmux session: " + created.stderr);

  // ---- register a fake live registry row: callsign -> tmux session ----
  dbRegistryUpsert({
    spawn_id: SPAWN_ID,
    callsign: CALLSIGN,
    node: "linux",
    control_handle: "tmux:" + SESSION,
    status: "active",
    started_at: Date.now(),
  });

  // Let the loop print a few lines.
  await sleep(1200);

  // ===== (a) unauth ticket request -> rejected =====
  {
    const res = await fetch(`${BASE}/terminal-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // NO Authorization
      body: JSON.stringify({ callsign: CALLSIGN }),
    });
    rec("(a) unauth ticket request rejected", res.status === 401, `status=${res.status}`);
  }

  // Mint a valid cockpit token so we can authenticate the ticket request the way
  // a real authenticated browser would (admin token also works).
  const cockpitToken = mintCockpitToken();

  // ===== ticket request for a callsign with NO live session -> 409 =====
  {
    const res = await fetch(`${BASE}/terminal-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cockpitToken}` },
      body: JSON.stringify({ callsign: "no-such-agent" }),
    });
    rec("(a2) ticket for dead/unknown callsign rejected", res.status === 409, `status=${res.status}`);
  }

  // ===== (b) WS with NO ticket -> rejected =====
  {
    const rejected = await wsConnectExpectFail(`ws://127.0.0.1:${PORT}/terminal`);
    rec("(b1) WS with no ticket rejected", rejected, "");
  }
  // ===== (b) WS with INVALID ticket -> rejected =====
  {
    const rejected = await wsConnectExpectFail(`ws://127.0.0.1:${PORT}/terminal?ticket=deadbeefdeadbeef`);
    rec("(b2) WS with invalid ticket rejected", rejected, "");
  }

  // ===== main path: valid ticket -> WS -> receive tmux pane output =====
  let mainOk = false;
  {
    const res = await fetch(`${BASE}/terminal-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cockpitToken}` },
      body: JSON.stringify({ callsign: CALLSIGN }),
    });
    const body = await res.json();
    const ticket = body.ticket;
    rec("ticket minted for live callsign", res.status === 200 && !!ticket, `status=${res.status}`);

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/terminal?ticket=${ticket}`);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("ws open timeout")), 5000);
    });
    const out = await recvPaneOutput(ws, "SMOKE_LINE_", 5000);
    mainOk = /SMOKE_LINE_/.test(out);
    rec("main: WS streams tmux pane output", mainOk, `received ${out.length}B, marker=${/SMOKE_LINE_/.test(out)}`);

    // ===== single-use: reusing the SAME ticket must be rejected =====
    const reuseRejected = await wsConnectExpectFail(`ws://127.0.0.1:${PORT}/terminal?ticket=${ticket}`);
    rec("ticket is single-use (reuse rejected)", reuseRejected, "");

    // ===== (c) read-only: input over WS does NOT reach the pty =====
    // Snapshot the pane, send a unique marker as INPUT, wait, re-snapshot.
    // In read-only mode the marker must NOT appear in the session.
    const marker = "RO_INPUT_" + randomBytes(2).toString("hex");
    const before = capturePane(SESSION);
    ws.send(marker + "\r"); // INPUT (not a JSON control frame)
    await sleep(1500);
    const after = capturePane(SESSION);
    const leaked = after.includes(marker) || before.includes(marker);
    rec("(c) read-only input does NOT reach pty", !leaked, `marker_in_session=${leaked}`);

    ws.close();
    await sleep(800); // let the server-side teardown kill the grouped view session

    // ===== cleanup: closing the WS must leave NO grouped view session =====
    const sessions = tmux(["ls"]).stdout || "";
    const leakedView = sessions.split("\n").some((l) => l.startsWith("view-" + SESSION));
    rec("WS close tears down grouped view session", !leakedView, leakedView ? "view leaked" : "");
  }

  // ===== (P3) take-control: input DOES reach the pty in write mode + is audited =====
  {
    // A dedicated interactive shell session we can drive deterministically.
    const SESSION2 = "wt-smoke-ctl-" + randomBytes(3).toString("hex");
    const SPAWN2 = "smoke-ctl-" + randomBytes(3).toString("hex");
    const callsign2 = "smoke-ctl";
    const markerFile = `/tmp/wt-smoke-ctl-${randomBytes(3).toString("hex")}`;
    tmux(["new-session", "-d", "-s", SESSION2, "bash", "--norc", "-i"]);
    dbRegistryUpsert({
      spawn_id: SPAWN2,
      callsign: callsign2,
      control_handle: "tmux:" + SESSION2,
      status: "active",
      started_at: Date.now(),
    });
    await sleep(600);

    // Capture audit events to assert the input frame is audited under identity+callsign.
    const audited = [];
    setAudit((e) => audited.push(e));

    const res = await fetch(`${BASE}/terminal-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cockpitToken}` },
      body: JSON.stringify({ callsign: callsign2 }),
    });
    const { ticket } = await res.json();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/terminal?ticket=${ticket}`);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("ws open timeout")), 5000);
    });
    await sleep(500);

    // Flip to write mode, then type a command that creates a marker file.
    ws.send(JSON.stringify({ type: "take-control" }));
    await sleep(500);
    ws.send(`touch ${markerFile}\r`);
    await sleep(1500);

    const fileExists = spawnSync("test", ["-f", markerFile]).status === 0;
    rec("(P3) take-control input reaches pty", fileExists, `markerFile_created=${fileExists}`);

    const inputAudits = audited.filter((e) => e.kind === "input" && e.callsign === callsign2 && e.identity === "operator");
    rec("(P3) write-mode input is audited (identity+callsign)", inputAudits.length > 0, `input_audit_events=${inputAudits.length}`);

    setAudit(null); // restore default audit
    ws.close();
    await sleep(800);
    spawnSync("rm", ["-f", markerFile]);
    tmux(["kill-session", "-t", SESSION2]);
  }

  // ---- teardown: kill ONLY our throwaway session ----
  tmux(["kill-session", "-t", SESSION]);
  await new Promise((res) => server.close(res));

  const allPass = results.every((r) => r.pass);
  console.log("\n=== SMOKE SUMMARY: " + (allPass ? "ALL PASS" : "FAILURES PRESENT") + " ===");
  process.exit(allPass ? 0 : 1);
}

async function wsConnectExpectFail(url) {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);
    const done = (rejected) => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch {}
      resolve(rejected);
    };
    ws.on("open", () => done(false)); // opened => NOT rejected => test fails
    ws.on("error", () => done(true)); // handshake error => rejected => good
    ws.on("unexpected-response", () => done(true));
    setTimeout(() => done(false), 4000);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e);
  // best-effort cleanup
  try { tmux(["kill-session", "-t", SESSION]); } catch {}
  try { server && server.close(); } catch {}
  process.exit(2);
});
