import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ProcDeps,
  conductorStatus,
  launchBuilders,
  launchReferee,
  readControlRaw,
  startConductor,
  stopConductor,
  validateConductorConfig,
  validateFleetMax,
  writeControlMerged,
  writeFleetMax,
} from "../operator-control.js";

// Point every file the module reads/writes at a throwaway temp dir.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocp-"));
  process.env.WT_CONDUCTOR_CONTROL_FILE = join(dir, "conductor-control.json");
  process.env.WT_CONDUCTOR_PID_FILE = join(dir, "conductor.pid");
  process.env.WT_OPERATOR_SETTINGS_FILE = join(dir, "operator-settings.json");
  process.env.WT_CONDUCTOR_STATE_FILE = join(dir, "conductor-state.json");
});
afterEach(() => {
  for (const k of [
    "WT_CONDUCTOR_CONTROL_FILE",
    "WT_CONDUCTOR_PID_FILE",
    "WT_OPERATOR_SETTINGS_FILE",
    "WT_CONDUCTOR_STATE_FILE",
    "WT_FLEET_SCRIPT",
    "WT_CONDUCTOR_SCRIPT",
    "WT_FLEET_NODE",
    "AF_REFEREE_LAUNCH_LOG",
  ]) {
    delete process.env[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── fake process deps ──
interface SpawnCall {
  cmd: string;
  args: string[];
  opts: SpawnOptions;
}
function fakeProc(opts: { pid?: number; alive?: number[]; cmdlineMatch?: boolean } = {}): {
  deps: ProcDeps;
  spawns: SpawnCall[];
  signals: Array<{ pid: number; sig: string }>;
  unrefs: number;
} {
  const spawns: SpawnCall[] = [];
  const signals: Array<{ pid: number; sig: string }> = [];
  let unrefs = 0;
  const alive = new Set(opts.alive ?? []);
  const cmdlineOk = opts.cmdlineMatch ?? true; // default: an alive pid IS our conductor
  const deps: ProcDeps = {
    spawn: (cmd, args, o) => {
      spawns.push({ cmd, args, opts: o });
      return { pid: opts.pid ?? 4242, unref: () => { unrefs++; }, on: () => undefined } as unknown as ChildProcess;
    },
    isAlive: (pid) => alive.has(pid),
    signal: (pid, sig) => { signals.push({ pid, sig }); },
    cmdlineMatches: (pid) => cmdlineOk && alive.has(pid),
  };
  return {
    deps,
    spawns,
    signals,
    get unrefs() { return unrefs; },
  };
}

describe("validateConductorConfig", () => {
  it("rejects non-objects", () => {
    expect(validateConductorConfig(null).ok).toBe(false);
    expect(validateConductorConfig(42).ok).toBe(false);
    expect(validateConductorConfig([]).ok).toBe(false);
  });

  it("rejects an empty patch (no recognized fields)", () => {
    expect(validateConductorConfig({}).ok).toBe(false);
    expect(validateConductorConfig({ bogus: 1 }).ok).toBe(false);
  });

  it("type-checks armed/paused", () => {
    expect(validateConductorConfig({ armed: "yes" }).ok).toBe(false);
    expect(validateConductorConfig({ paused: 1 }).ok).toBe(false);
    const r = validateConductorConfig({ armed: true, paused: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ armed: true, paused: false });
  });

  it("enforces the idleWindowMs floor (>=60000) and allows null", () => {
    expect(validateConductorConfig({ idleWindowMs: 59_999 }).ok).toBe(false);
    expect(validateConductorConfig({ idleWindowMs: 60_000 }).ok).toBe(true);
    expect(validateConductorConfig({ idleWindowMs: null }).ok).toBe(true);
    expect(validateConductorConfig({ idleWindowMs: "x" }).ok).toBe(false);
  });

  it("enforces the intervalMs floor (>=5000) and allows null", () => {
    expect(validateConductorConfig({ intervalMs: 4_999 }).ok).toBe(false);
    expect(validateConductorConfig({ intervalMs: 5_000 }).ok).toBe(true);
    expect(validateConductorConfig({ intervalMs: null }).ok).toBe(true);
  });

  it("validates, trims, and dedups pinned callsigns", () => {
    expect(validateConductorConfig({ pinned: "nope" }).ok).toBe(false);
    expect(validateConductorConfig({ pinned: [1, 2] }).ok).toBe(false);
    const r = validateConductorConfig({ pinned: [" linux-fleet ", "linux-fleet", "linux-6425", ""] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pinned).toEqual(["linux-fleet", "linux-6425"]);
  });

  it("rejects an over-long pinned list", () => {
    const many = Array.from({ length: 101 }, (_, i) => `a${i}`);
    expect(validateConductorConfig({ pinned: many }).ok).toBe(false);
  });
});

describe("validateFleetMax", () => {
  it("accepts 1..20 and floors decimals", () => {
    expect(validateFleetMax({ value: 1 })).toEqual({ ok: true, value: 1 });
    expect(validateFleetMax({ value: 20 })).toEqual({ ok: true, value: 20 });
    expect(validateFleetMax({ value: 5.9 })).toEqual({ ok: true, value: 5 });
  });
  it("rejects out-of-range and non-numbers", () => {
    expect(validateFleetMax({ value: 0 }).ok).toBe(false);
    expect(validateFleetMax({ value: 21 }).ok).toBe(false);
    expect(validateFleetMax({ value: "5" }).ok).toBe(false);
    expect(validateFleetMax({}).ok).toBe(false);
  });
});

describe("control file read/write (atomic, merge)", () => {
  it("returns defaults when no file exists", () => {
    const c = readControlRaw();
    expect(c).toMatchObject({ version: 1, armed: false, paused: false, pinned: [], idleWindowMs: null });
  });

  it("writes a validated partial and merges over prior state", () => {
    const first = writeControlMerged({ armed: true }, "2026-06-17T00:00:00.000Z");
    expect(first.armed).toBe(true);
    expect(first.updatedBy).toBe("operator");
    expect(first.updatedAt).toBe("2026-06-17T00:00:00.000Z");
    // file is valid JSON on disk (atomic write completed)
    const onDisk = JSON.parse(readFileSync(process.env.WT_CONDUCTOR_CONTROL_FILE as string, "utf8"));
    expect(onDisk.armed).toBe(true);

    const second = writeControlMerged({ pinned: ["linux-fleet"] }, "2026-06-17T00:01:00.000Z");
    expect(second.armed).toBe(true); // preserved from first write
    expect(second.pinned).toEqual(["linux-fleet"]);
    expect(readControlRaw().armed).toBe(true);
  });
});

describe("launchBuilders (item 3)", () => {
  it("spawns fleet.mjs up --linux N (no --referee); count is the only varying argv token", () => {
    const p = fakeProc();
    const r = launchBuilders(3, p.deps);
    expect(r.ok).toBe(true);
    expect(p.spawns).toHaveLength(1);
    const { args } = p.spawns[0];
    expect(args.slice(1)).toEqual(["up", "--linux", "3", "--windows", "0", "--yes", "--term", "tmux"]);
    expect(args).not.toContain("--referee"); // builders are least-privilege, no admin carve-out
    expect(p.unrefs).toBe(1);
  });

  it("is a no-op for count <= 0 (no spawn)", () => {
    const p = fakeProc();
    expect(launchBuilders(0, p.deps).ok).toBe(true);
    expect(launchBuilders(-2, p.deps).ok).toBe(true);
    expect(p.spawns).toHaveLength(0);
  });
});

describe("launchReferee", () => {
  it("spawns the canonical fleet.mjs with a FIXED argv (no request input), PIPES stdio, and unrefs", () => {
    const p = fakeProc();
    const r = launchReferee(p.deps);
    expect(r.ok).toBe(true);
    expect(p.spawns).toHaveLength(1);
    const { cmd, args, opts } = p.spawns[0];
    expect(cmd).toMatch(/node/); // process.execPath by default
    // exact fixed argv — referee lane, never any caller-supplied value
    expect(args.slice(1)).toEqual(["up", "--linux", "1", "--windows", "0", "--referee", "--yes", "--term", "tmux"]);
    expect(args[0]).toMatch(/scripts\/fleet\/fleet\.mjs$/);
    expect(opts.detached).toBe(true);
    // F1(b): stdout/stderr are PIPED (not "ignore") so a failed launch is no longer invisible.
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(p.unrefs).toBe(1);
  });

  it("threads the operator fleetMax setting into the spawn env", () => {
    writeFleetMax(12);
    const p = fakeProc();
    launchReferee(p.deps);
    expect((p.spawns[0].opts.env as NodeJS.ProcessEnv).WT_FLEET_MAX).toBe("12");
  });

  // ── F1(b) DE-SILENCE: piped stderr is teed to a log file and a non-zero exit is logged ──

  // A fake detached child that actually carries pipe streams + an emittable exit, so the tee
  // path (which the bare fakeProc child can't exercise) is driven end-to-end. `proc` IS the
  // child object (Object.assign mutates it) — emit "close"/"error" on it, and on stdout/stderr.
  // NOTE: the tee ends the log on "close" (not "exit") so the final buffered stdout can't be
  // truncated mid-flush; tests drive "close" to match the production wiring.
  function fakeChildWithStreams(pid = 7777): { child: ChildProcess; proc: EventEmitter; stdout: EventEmitter; stderr: EventEmitter } {
    const proc = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(proc, { pid, unref() {}, stdout, stderr }) as unknown as ChildProcess;
    return { child, proc, stdout, stderr };
  }
  function procWith(child: ChildProcess): ProcDeps {
    return {
      spawn: () => child,
      isAlive: () => false,
      signal: () => undefined,
      cmdlineMatches: () => false,
    };
  }
  async function readWhen(path: string, pred: (s: string) => boolean, ms = 1000): Promise<string> {
    const start = Date.now();
    for (;;) {
      const s = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (pred(s) || Date.now() - start > ms) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("TEES the launcher's stdout+stderr to the launch log (no longer discarded)", async () => {
    const logPath = join(dir, "launch-referee.log");
    process.env.AF_REFEREE_LAUNCH_LOG = logPath;
    const { child, proc, stdout, stderr } = fakeChildWithStreams();
    const r = launchReferee(procWith(child));
    expect(r.ok).toBe(true);

    stdout.emit("data", Buffer.from("up: spawning referee lane\n"));
    stderr.emit("data", Buffer.from("tmux: server not found\n"));
    proc.emit("close", 0, null); // closes the log stream (after stdio drains — flush-safe)

    const log = await readWhen(logPath, (s) => s.includes("tmux: server not found") && s.includes("up: spawning"));
    expect(log).toContain(`pid=${child.pid}`); // header
    expect(log).toContain("up: spawning referee lane"); // stdout teed
    expect(log).toContain("tmux: server not found"); // stderr teed
  });

  it("LOGS a stderr tail to the hub log on a NON-ZERO child exit", () => {
    process.env.AF_REFEREE_LAUNCH_LOG = join(dir, "launch-referee.log");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { child, proc, stderr } = fakeChildWithStreams();
      launchReferee(procWith(child));
      stderr.emit("data", Buffer.from("Error: Cannot find module 'node-pty'\n"));
      proc.emit("close", 1, null);

      const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("launch-referee child exit 1");
      expect(logged).toContain("Cannot find module 'node-pty'"); // the captured stderr tail
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does NOT log on a clean (zero) child exit", () => {
    process.env.AF_REFEREE_LAUNCH_LOG = join(dir, "launch-referee.log");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { child, proc, stderr } = fakeChildWithStreams();
      launchReferee(procWith(child));
      stderr.emit("data", Buffer.from("benign warning\n"));
      proc.emit("close", 0, null);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("launch-referee child"))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("conductor lifecycle (pidfile singleton, stale-safe)", () => {
  it("start spawns the CANONICAL executor and records the pid when not running", () => {
    const p = fakeProc({ pid: 9001 });
    const r = startConductor(p.deps);
    expect(r).toMatchObject({ ok: true, running: true, started: true });
    expect(p.spawns[0].args[0]).toMatch(/scripts\/fleet\/conductor-executor\.mjs$/);
    expect(p.spawns[0].args[0]).not.toMatch(/wt-c0b6/); // never the stray /tmp copy
    expect(p.spawns[0].args).toContain("--loop");
    const pidJson = JSON.parse(readFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, "utf8"));
    expect(pidJson.pid).toBe(9001);
  });

  it("start is a SINGLETON no-op when a live pid is already recorded", () => {
    writeFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, JSON.stringify({ pid: 555 }));
    const p = fakeProc({ alive: [555] });
    const r = startConductor(p.deps);
    expect(r.started).toBe(false);
    expect(r.running).toBe(true);
    expect(p.spawns).toHaveLength(0); // never spawned a second conductor
  });

  it("start cleans a STALE pidfile (dead pid) then spawns fresh", () => {
    writeFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, JSON.stringify({ pid: 777 }));
    const p = fakeProc({ pid: 9002, alive: [] }); // 777 not alive
    const r = startConductor(p.deps);
    expect(r.started).toBe(true);
    expect(p.spawns).toHaveLength(1);
    const pidJson = JSON.parse(readFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, "utf8"));
    expect(pidJson.pid).toBe(9002);
  });

  it("stop SIGTERMs a live conductor and removes the pidfile", () => {
    writeFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, JSON.stringify({ pid: 4321 }));
    const p = fakeProc({ alive: [4321] });
    const r = stopConductor(p.deps);
    expect(r).toMatchObject({ ok: true, running: false, stopped: true });
    expect(p.signals).toEqual([{ pid: 4321, sig: "SIGTERM" }]);
    expect(existsSync(process.env.WT_CONDUCTOR_PID_FILE as string)).toBe(false);
  });

  it("stop tolerates an already-dead conductor", () => {
    writeFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, JSON.stringify({ pid: 4321 }));
    const p = fakeProc({ alive: [] });
    const r = stopConductor(p.deps);
    expect(r.stopped).toBe(false);
    expect(r.running).toBe(false);
    expect(p.signals).toHaveLength(0);
    expect(existsSync(process.env.WT_CONDUCTOR_PID_FILE as string)).toBe(false);
  });

  it("status reports running + surfaces the observe set from conductor-state lastEval", () => {
    writeFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, JSON.stringify({ pid: 808 }));
    writeFileSync(
      process.env.WT_CONDUCTOR_STATE_FILE as string,
      JSON.stringify({ lastEval: { tickTs: 1700, flagged: [{ callsign: "linux-x", reason: "idle" }] } }),
    );
    writeFleetMax(7); // folded into status so the cockpit prefills the cap in one poll
    const p = fakeProc({ alive: [808] });
    const s = conductorStatus(p.deps);
    expect(s.running).toBe(true);
    expect(s.lastTick).toBe(1700);
    expect(s.flagged).toEqual([{ callsign: "linux-x", reason: "idle" }]);
    expect(s.fleetMax).toBe(7);
  });

  it("status reads not-running and cleans a stale pidfile", () => {
    writeFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, JSON.stringify({ pid: 909 }));
    const p = fakeProc({ alive: [] });
    const s = conductorStatus(p.deps);
    expect(s.running).toBe(false);
    expect(s.flagged).toEqual([]);
    expect(existsSync(process.env.WT_CONDUCTOR_PID_FILE as string)).toBe(false);
  });

  // F2: pid-reuse guard — an alive pid whose cmdline is NOT conductor-executor is an unrelated
  // process that inherited the conductor's old pid; never read it as running or signal it.
  it("start treats a pid-REUSED pidfile (alive but not our conductor) as not running and spawns fresh", () => {
    writeFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, JSON.stringify({ pid: 555 }));
    const p = fakeProc({ pid: 9100, alive: [555], cmdlineMatch: false });
    const r = startConductor(p.deps);
    expect(r.started).toBe(true);
    expect(p.spawns).toHaveLength(1);
    expect(JSON.parse(readFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, "utf8")).pid).toBe(9100);
  });

  it("stop NEVER signals a pid-REUSED process (alive but not our conductor)", () => {
    writeFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, JSON.stringify({ pid: 4321 }));
    const p = fakeProc({ alive: [4321], cmdlineMatch: false });
    const r = stopConductor(p.deps);
    expect(r.stopped).toBe(false);
    expect(p.signals).toHaveLength(0); // the unrelated process is left alone
    expect(existsSync(process.env.WT_CONDUCTOR_PID_FILE as string)).toBe(false);
  });

  it("status reads not-running when the pid was reused by an unrelated process", () => {
    writeFileSync(process.env.WT_CONDUCTOR_PID_FILE as string, JSON.stringify({ pid: 808 }));
    const p = fakeProc({ alive: [808], cmdlineMatch: false });
    expect(conductorStatus(p.deps).running).toBe(false);
  });
});
