// Operator Control Panel — backend helpers (WS-B).
//
// Pure, unit-testable logic for the cockpit's zero-terminal fleet controls:
//   - launchReferee()        spawn a detached referee via fleet.mjs (fixed argv, no shell)
//   - validate/write control  conductor-control.json (operator → conductor, schema = plan §1)
//   - conductor lifecycle     pidfile-based start/stop/status (singleton, stale-safe)
//   - operator settings       operator-settings.json (e.g. fleetMax)
//
// SECURITY NOTES (for review):
//   * launchReferee builds a FIXED argv array and spawns WITHOUT a shell — no request
//     input is ever interpolated into the command, so there is zero injection surface.
//   * validateConductorConfig enforces type + range floors and rejects anything else,
//     so an armed conductor can never be tuned to a hot loop or near-instant reap.
//   * all writes are atomic (write temp + rename) so a concurrent conductor read at the
//     top of its tick never observes a half-written file.
//
// COUPLING: this module shares only the control-file SCHEMA with the conductor engine
// (WS-A) — it does NOT import conductor-control.mjs. B owns writes + raw reads here; A
// owns the merge-read (file > env > default) inside the conductor. The one A→B data
// seam is conductor-state.json `lastEval` (read-only here, for status).

import { spawn as realSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── paths (env-overridable; resolved per call so tests can point at a temp dir) ──

function configDir(): string {
  const explicit = process.env.AF_CONFIG_DIR || process.env.WT_WALKIE_CONFIG_DIR;
  if (explicit) return explicit;
  const newDir = join(homedir(), ".config", "agent-fleet");
  const legacyDir = join(homedir(), ".config", "walkie-talkie");
  // Agent Fleet rename transition: prefer the new config dir, but if it doesn't
  // exist yet and the legacy one does, keep reading the legacy dir until the Lane F
  // cutover physically moves it — so operator settings / conductor state aren't lost.
  if (!existsSync(newDir) && existsSync(legacyDir)) return legacyDir;
  return newDir;
}
function controlFile(): string {
  return process.env.AF_CONDUCTOR_CONTROL_FILE || process.env.WT_CONDUCTOR_CONTROL_FILE || join(configDir(), "conductor-control.json");
}
function pidFile(): string {
  return process.env.AF_CONDUCTOR_PID_FILE || process.env.WT_CONDUCTOR_PID_FILE || join(configDir(), "conductor.pid");
}
function settingsFile(): string {
  return process.env.AF_OPERATOR_SETTINGS_FILE || process.env.WT_OPERATOR_SETTINGS_FILE || join(configDir(), "operator-settings.json");
}
function stateFile(): string {
  return process.env.AF_CONDUCTOR_STATE_FILE || process.env.WT_CONDUCTOR_STATE_FILE || join(configDir(), "conductor-state.json");
}

// Repo root: this module compiles to <repo>/hub/dist/operator-control.js, so the repo
// root is two directories up. Used to resolve the CANONICAL fleet/conductor scripts —
// never a /tmp worktree copy.
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // <repo>/hub/dist
  return resolve(here, "..", "..");
}
function fleetScript(): string {
  return process.env.AF_FLEET_SCRIPT || process.env.WT_FLEET_SCRIPT || join(repoRoot(), "scripts", "fleet", "fleet.mjs");
}
function conductorScript(): string {
  return process.env.AF_CONDUCTOR_SCRIPT || process.env.WT_CONDUCTOR_SCRIPT || join(repoRoot(), "scripts", "fleet", "conductor-executor.mjs");
}
// The node binary used to run the .mjs orchestrators. Defaults to the hub's own node
// (process.execPath); AF_FLEET_NODE lets ops pin a >=20 binary if the hub runs older.
function nodeBin(): string {
  return process.env.AF_FLEET_NODE || process.env.WT_FLEET_NODE || process.execPath;
}

// ── tiny fs helpers ──

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null; // tolerate ENOENT / malformed — caller falls back to defaults
  }
}

// Atomic write: temp file in the same dir + rename (rename is atomic on the same fs).
function atomicWriteJson(path: string, obj: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Unique-ish temp name without Math.random/Date.now (unavailable in some runtimes):
  // pid + monotonic counter is sufficient because writes here are not high-frequency.
  const tmp = `${path}.tmp.${process.pid}.${tmpCounter++}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}
let tmpCounter = 0;

// ── control-file schema (plan §1) ──

export interface ConductorControl {
  version: number;
  armed: boolean;
  paused: boolean;
  idleWindowMs: number | null;
  intervalMs: number | null;
  pinned: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export const CONTROL_DEFAULT: ConductorControl = {
  version: 1,
  armed: false,
  paused: false,
  idleWindowMs: null,
  intervalMs: null,
  pinned: [],
  updatedAt: null,
  updatedBy: null,
};

// Range floors (plan §8 hardening).
export const INTERVAL_MS_FLOOR = 5_000; // no hot loop
export const IDLE_WINDOW_MS_FLOOR = 60_000; // armed conductor can't near-instant reap
export const PINNED_MAX = 100;
export const CALLSIGN_MAX = 64;

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; error: string };

// Validate a PARTIAL config patch (only the provided fields). Returns the cleaned
// partial on success, or a 400-worthy error string. Unknown keys are ignored.
export function validateConductorConfig(input: unknown): ValidateResult<Partial<ConductorControl>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = input as Record<string, unknown>;
  const out: Partial<ConductorControl> = {};

  if ("armed" in b) {
    if (typeof b.armed !== "boolean") return { ok: false, error: "armed must be a boolean" };
    out.armed = b.armed;
  }
  if ("paused" in b) {
    if (typeof b.paused !== "boolean") return { ok: false, error: "paused must be a boolean" };
    out.paused = b.paused;
  }
  if ("idleWindowMs" in b) {
    if (b.idleWindowMs === null) {
      out.idleWindowMs = null;
    } else if (typeof b.idleWindowMs !== "number" || !Number.isFinite(b.idleWindowMs)) {
      return { ok: false, error: "idleWindowMs must be a number or null" };
    } else if (b.idleWindowMs < IDLE_WINDOW_MS_FLOOR) {
      return { ok: false, error: `idleWindowMs must be >= ${IDLE_WINDOW_MS_FLOOR}` };
    } else {
      out.idleWindowMs = Math.floor(b.idleWindowMs);
    }
  }
  if ("intervalMs" in b) {
    if (b.intervalMs === null) {
      out.intervalMs = null;
    } else if (typeof b.intervalMs !== "number" || !Number.isFinite(b.intervalMs)) {
      return { ok: false, error: "intervalMs must be a number or null" };
    } else if (b.intervalMs < INTERVAL_MS_FLOOR) {
      return { ok: false, error: `intervalMs must be >= ${INTERVAL_MS_FLOOR}` };
    } else {
      out.intervalMs = Math.floor(b.intervalMs);
    }
  }
  if ("pinned" in b) {
    if (!Array.isArray(b.pinned)) return { ok: false, error: "pinned must be an array of callsigns" };
    if (b.pinned.length > PINNED_MAX) return { ok: false, error: `pinned exceeds ${PINNED_MAX} entries` };
    const cleaned: string[] = [];
    for (const c of b.pinned) {
      if (typeof c !== "string") return { ok: false, error: "pinned entries must be strings" };
      const s = c.trim();
      if (!s) continue;
      if (s.length > CALLSIGN_MAX) return { ok: false, error: `pinned callsign too long (>${CALLSIGN_MAX})` };
      if (!cleaned.includes(s)) cleaned.push(s);
    }
    out.pinned = cleaned;
  }

  if (Object.keys(out).length === 0) {
    return { ok: false, error: "no recognized fields to update" };
  }
  return { ok: true, value: out };
}

// Read the stored control file (raw operator-set values), or defaults if absent.
export function readControlRaw(): ConductorControl {
  const stored = readJson<Partial<ConductorControl>>(controlFile());
  if (!stored) return { ...CONTROL_DEFAULT };
  return { ...CONTROL_DEFAULT, ...stored };
}

// Merge a VALIDATED partial over the current file and atomically persist it.
export function writeControlMerged(patch: Partial<ConductorControl>, nowIso: string): ConductorControl {
  const current = readControlRaw();
  const next: ConductorControl = {
    ...current,
    ...patch,
    version: 1,
    updatedAt: nowIso,
    updatedBy: "operator",
  };
  atomicWriteJson(controlFile(), next);
  return next;
}

// ── operator settings (e.g. fleetMax) ──

export interface OperatorSettings {
  fleetMax: number | null;
}
export const FLEET_MAX_MIN = 1;
export const FLEET_MAX_MAX = 20;

export function validateFleetMax(input: unknown): ValidateResult<number> {
  const b = input as Record<string, unknown> | null;
  const v = b && typeof b === "object" ? b.value : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: "value must be a number" };
  const n = Math.floor(v);
  if (n < FLEET_MAX_MIN || n > FLEET_MAX_MAX) {
    return { ok: false, error: `value must be ${FLEET_MAX_MIN}..${FLEET_MAX_MAX}` };
  }
  return { ok: true, value: n };
}

export function readSettings(): OperatorSettings {
  const stored = readJson<Partial<OperatorSettings>>(settingsFile());
  const fleetMax = stored && typeof stored.fleetMax === "number" ? stored.fleetMax : null;
  return { fleetMax };
}

export function writeFleetMax(value: number): OperatorSettings {
  const next: OperatorSettings = { ...readSettings(), fleetMax: value };
  atomicWriteJson(settingsFile(), next);
  return next;
}

// ── process deps (injectable for tests) ──

export interface ProcDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  isAlive: (pid: number) => boolean;
  signal: (pid: number, sig: NodeJS.Signals) => void;
  // F2: process.kill(pid,0) matches ANY process at that pid, so after a crash + OS pid-reuse it could
  // match an unrelated process. cmdlineMatches lets the lifecycle confirm the pid is really OUR
  // conductor before reading it as running or sending it a signal.
  cmdlineMatches: (pid: number, needle: string) => boolean;
}

const realProc: ProcDeps = {
  spawn: realSpawn,
  isAlive: (pid: number) => {
    try {
      process.kill(pid, 0); // signal 0 = liveness probe, no actual signal sent
      return true;
    } catch {
      return false;
    }
  },
  signal: (pid: number, sig: NodeJS.Signals) => process.kill(pid, sig),
  cmdlineMatches: (pid: number, needle: string) => {
    try {
      // /proc/<pid>/cmdline is NUL-separated argv (Linux; the hub host). Our own child → readable.
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle);
    } catch {
      return false; // unreadable/gone → don't trust it as our conductor
    }
  },
};

function readPidFile(): number | null {
  const raw = readJson<{ pid?: number }>(pidFile());
  if (raw && typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0) return raw.pid;
  return null;
}

// ── launch referee ──

export interface LaunchResult {
  ok: boolean;
  message: string;
}

// Spawn a single detached REFEREE via fleet.mjs. FIXED argv — no request input. The
// fleet.mjs process enforces the concurrency cap + writes the audit log itself; we just
// pass the operator's fleetMax (if set) through the env so the cap toggle takes effect.
export function launchReferee(proc: ProcDeps = realProc): LaunchResult {
  const settings = readSettings();
  const env = { ...process.env };
  if (settings.fleetMax != null) {
    env.AF_FLEET_MAX = String(settings.fleetMax);
    env.WT_FLEET_MAX = env.AF_FLEET_MAX; // back-compat: a conductor that still reads the legacy name this version
  }
  const args = [fleetScript(), "up", "--linux", "1", "--windows", "0", "--referee", "--yes", "--term", "tmux"];
  const child = proc.spawn(nodeBin(), args, { detached: true, stdio: "ignore", env });
  // F1(b) DE-SILENCE: a detached + stdio:"ignore" spawn swallows failures (bad node, missing tmux),
  // so a failed launch would be invisible (the operator clicks the button, nothing happens). Surface async
  // spawn errors to the hub log; the operator's confirmation channel is the roster (a referee that
  // never joins ~45s after "launching…" means it failed).
  child.on("error", (e) => console.error(`[operator-control] launch-referee spawn error: ${(e as Error).message}`));
  if (typeof child.pid !== "number") {
    return { ok: false, message: "launch-referee failed: spawn produced no pid" };
  }
  child.unref();
  return { ok: true, message: "Referee launching… (joins the hub in ~30–45s; watch the roster)" };
}

// ── conductor lifecycle (pidfile singleton, stale-safe) ──

export interface ConductorStatus {
  running: boolean;
  control: ConductorControl;
  fleetMax: number | null; // folded in so the cockpit prefills the cap from one poll
  lastTick: number | null;
  flagged: Array<{ callsign: string; reason: string }>;
}

// The pid of the live conductor (alive AND actually conductor-executor), or null. Cleans up a stale
// or pid-reused pidfile as a side effect.
function liveConductorPid(proc: ProcDeps): number | null {
  const pid = readPidFile();
  if (pid == null) return null;
  // F2: require BOTH liveness and a cmdline match — a bare kill(pid,0) would match an unrelated
  // process that inherited the pid after the conductor crashed.
  if (proc.isAlive(pid) && proc.cmdlineMatches(pid, "conductor-executor")) return pid;
  // dead, or the pid now belongs to something else — forget it so status reads not-running and we
  // never signal an unrelated process.
  try {
    rmSync(pidFile(), { force: true });
  } catch {
    /* best effort */
  }
  return null;
}

export function conductorStatus(proc: ProcDeps = realProc): ConductorStatus {
  const running = liveConductorPid(proc) != null;
  const control = readControlRaw();
  const state = readJson<{ lastEval?: { tickTs?: number; flagged?: Array<{ callsign: string; reason: string }> } }>(
    stateFile(),
  );
  const lastEval = state?.lastEval;
  const flagged = Array.isArray(lastEval?.flagged) ? lastEval!.flagged : [];
  const lastTick = typeof lastEval?.tickTs === "number" ? lastEval!.tickTs : null;
  return { running, control, fleetMax: readSettings().fleetMax, lastTick, flagged };
}

export interface StartResult {
  ok: boolean;
  running: boolean;
  started: boolean;
  message: string;
}

// Start the conductor loop if not already running (SINGLETON). Spawns the CANONICAL
// repo-path executor in observe mode (armed is driven by the control file, default off).
export function startConductor(proc: ProcDeps = realProc): StartResult {
  const existing = liveConductorPid(proc);
  if (existing != null) {
    return { ok: true, running: true, started: false, message: `conductor already running (pid ${existing})` };
  }
  const child = proc.spawn(nodeBin(), [conductorScript(), "--loop"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  // De-silence the detached spawn (same rationale as launch-referee).
  child.on("error", (e) => console.error(`[operator-control] conductor spawn error: ${(e as Error).message}`));
  const pid = child.pid;
  if (typeof pid !== "number") {
    return { ok: false, running: false, started: false, message: "spawn failed: no pid" };
  }
  child.unref();
  atomicWriteJson(pidFile(), { pid, startedAt: nowStamp() });
  return { ok: true, running: true, started: true, message: `conductor started (pid ${pid})` };
}

export interface StopResult {
  ok: boolean;
  running: boolean;
  stopped: boolean;
  message: string;
}

// Stop the conductor: SIGTERM then verify; tolerate already-dead. Uses the cmdline-guarded liveness
// (F2) so we never signal an unrelated process that reused the conductor's pid.
export function stopConductor(proc: ProcDeps = realProc): StopResult {
  const pid = liveConductorPid(proc); // null if absent/dead/pid-reused (and clears a stale pidfile)
  if (pid == null) {
    return { ok: true, running: false, stopped: false, message: "conductor not running" };
  }
  try {
    proc.signal(pid, "SIGTERM");
  } catch {
    /* raced to dead between the check and the signal — fine */
  }
  try {
    rmSync(pidFile(), { force: true });
  } catch {
    /* best effort */
  }
  return { ok: true, running: false, stopped: true, message: `conductor stopped (pid ${pid})` };
}

// Wall-clock stamp without Date.now() (unavailable in some sandboxes). Falls back to 0.
function nowStamp(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}
