// windows.mjs — fleet launcher, Windows lane.
// fleet.mjs imports { WIN_SSH_ALIAS, preflightWindows, spawnWindows }.
//
// Grounded Windows facts:
//   - ssh to the Windows node lands in cmd.exe; claude = C:\Users\<username>\.local\bin\claude.exe
//   - NO tmux / NO WSL distro → detach via PowerShell Start-Process, NOT tmux
//   - join token already in settings.json (Approach C) → do NOT inject it over ssh
//   - SessionStart hook sets the sid-derived callsign `windows-<sid[0:4]>` + INJECTS a
//     "call fleet_join" instruction — but it does NOT itself join. The AGENT must take a turn to act
//     on it, so a bare `claude.exe` with no prompt boots, sets its title, then idles at the prompt and
//     never joins. FIX:
//     launch with an initial prompt (ctx.prompt) so the session takes a first turn → runs fleet_join →
//     persists as a teammate. `claude "<prompt>"` stays interactive (only -p/--print is headless).
//     fleet.mjs reconciles joins by roster delta + platform prefix; the callsign is not predictable.
//
// spawnWindows MUST return the spawn-contract shape (same as spawnLinux):
//   { node:'windows', requested:N, spawned:[{ handle, ok, err?, dryRun?, cmd? }] }
// `ok` = the SPAWN started; hub-join is verified separately by fleet.mjs's roster reconcile.
//
// Quoting: rather than escape literal quotes through ssh → cmd.exe → PowerShell → Start-Process
// (the §4 "sharp edge" — a triple quoting layer), the PowerShell script is sent via
// `-EncodedCommand` (base64 of UTF-16LE). cmd.exe then only ever sees
// `powershell -NoProfile -EncodedCommand <base64>` — no quotes to mangle, and the payload is
// byte-identical no matter how many shells it transits.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const WIN_SSH_ALIAS = process.env.WT_WIN_SSH_ALIAS || 'windows-node';

// claude.exe location on the Windows box; overridable for testing/other hosts.
const WIN_CLAUDE_BIN = process.env.WT_WIN_CLAUDE_BIN || 'C:\\Users\\<username>\\.local\\bin\\claude.exe';

// Initial prompt fallback. fleet.mjs threads the canonical prompt via ctx.prompt (its own --prompt
// default), so both lanes use the SAME string; this local default only prevents a prompt-less spawn
// (which would never take a turn → never join) if ctx.prompt is somehow unset.
const DEFAULT_PROMPT = process.env.WT_FLEET_PROMPT ||
  'You are a fleet member — follow your SessionStart instructions: fleet_join, set fleet_mission, then stand by for board work.';

// Detached window style. Hidden (v1 default) = no visible window. If a hidden console starves the
// interactive claude.exe TUI so it never inits/joins (the open Q3), flip to Minimized/Normal via
// WT_WIN_WINDOW_STYLE — no code change. Allow-listed so the env can't inject into the PS script.
const WIN_WINDOW_STYLE = ['Hidden', 'Minimized', 'Normal', 'Maximized']
  .includes(process.env.WT_WIN_WINDOW_STYLE) ? process.env.WT_WIN_WINDOW_STYLE : 'Hidden';

// ssh guards so a hung mesh/tunnel can never block the launcher (build-plan §3 Lane B).
const SSH_GUARD = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
const SSH_TIMEOUT_MS = Number(process.env.WT_WIN_SSH_TIMEOUT_MS || 20000);

// powershell invocation: -NoProfile + -NonInteractive (and $ProgressPreference in the script)
// suppress the "Preparing modules for first use" progress record that PS otherwise serializes as
// `#< CLIXML …>` on STDERR over a pipe (confirmed on the live box by windows-callsign-fix) — so
// STDOUT is the PID line alone and the parse is bulletproof.
const PS_FLAGS = '-NoProfile -NonInteractive -EncodedCommand';

/**
 * Preflight the Windows node: ssh reachable + reverse tunnel (walkie-tunnel-win) up.
 * Returns {ok:true} or {ok:false, err}. Never hangs (BatchMode + ConnectTimeout).
 * (Seeded by linux-1d49 and verified live; b37c may refine.)
 */
export async function preflightWindows() {
  try {
    await execFileP('ssh', [...SSH_GUARD, WIN_SSH_ALIAS, 'echo ok'], { timeout: 12000 });
  } catch (e) {
    return { ok: false, err: `ssh ${WIN_SSH_ALIAS} failed (mesh/key/tunnel?): ${e.message.split('\n')[0]}` };
  }
  try {
    const { stdout } = await execFileP(
      'ssh', [...SSH_GUARD, WIN_SSH_ALIAS,
        'curl -s -o NUL -w %{http_code} http://localhost:9559/users'],
      { timeout: 12000 },
    );
    if (!stdout.includes('200')) return { ok: false, err: `Windows reverse tunnel down (curl→${stdout.trim()}); check pm2 walkie-tunnel-win` };
  } catch (e) {
    return { ok: false, err: `Windows tunnel probe failed: ${e.message.split('\n')[0]}` };
  }
  return { ok: true };
}

// ───────────────────────────── pure helpers (unit-tested) ─────────────────────────────

/** Quote a string as a PowerShell single-quoted literal (doubling any embedded single quote). */
function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * The -ArgumentList value passing the initial prompt as ONE argument to claude.exe: wrap it in
 * double-quotes (so claude's CRT arg-parser keeps spaces as a single arg), backslash-escape any
 * embedded double-quote, then PS-single-quote the whole token.
 */
function winArgLiteral(prompt) {
  return psSingleQuote(`"${String(prompt).replace(/"/g, '\\"')}"`);
}

/**
 * Resolve the Windows working directory. ctx.workDir defaults to the orchestrator's *Linux*
 * homedir (see fleet.mjs cmdUp), which is meaningless on Windows — so only honor an explicit
 * Windows-style path (drive letter). Otherwise fall back to the user profile.
 * Override with WT_WIN_WORK_DIR. (Per-node work dirs are a clean v2; this guard is right for v1.)
 */
export function winWorkDir(ctx = {}) {
  // First valid Windows-style path wins (env override, then ctx); else the user profile.
  // A set-but-non-Windows value (e.g. the Linux ctx default) is skipped, not propagated.
  for (const w of [process.env.WT_WIN_WORK_DIR, ctx.workDir]) {
    if (w && /^[A-Za-z]:[\\/]/.test(w)) return w;
  }
  return 'C:\\Users\\<username>';
}

/**
 * The PowerShell script that launches ONE detached, hidden claude.exe and prints its PID.
 * -PassThru yields the started process so we can return a reap handle; $ErrorActionPreference
 * = Stop makes a failed Start-Process exit non-zero (ssh/execFile rejects → we surface the err).
 */
export function windowsPsScript(workDir, prompt = DEFAULT_PROMPT, bin = WIN_CLAUDE_BIN) {
  // -ArgumentList carries the initial prompt → claude takes a first turn → self-joins (RC#1 fix).
  return [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'", // no "Preparing modules" progress record on stderr
    `$p = Start-Process -FilePath ${psSingleQuote(bin)} -ArgumentList ${winArgLiteral(prompt)} -WindowStyle ${WIN_WINDOW_STYLE} -WorkingDirectory ${psSingleQuote(workDir)} -PassThru`,
    'Write-Output $p.Id',
  ].join('; ');
}

/** Encode a PowerShell script for `-EncodedCommand` (base64 of UTF-16LE). */
export function encodePsCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Pure: the exact ssh argv + readable form to spawn ONE detached claude on Windows.
 * No execution. `sshArgs` is fed straight to execFile('ssh', …); `readable` is for --dry-run.
 */
export function windowsSpawnCmd(ctx = {}) {
  const workDir = winWorkDir(ctx);
  const prompt = ctx.prompt || DEFAULT_PROMPT; // fleet.mjs threads the canonical prompt via ctx.prompt
  const script = windowsPsScript(workDir, prompt);
  const b64 = encodePsCommand(script);
  const remote = `powershell ${PS_FLAGS} ${b64}`;
  const sshArgs = [...SSH_GUARD, WIN_SSH_ALIAS, remote];
  const readable = [
    `ssh ${WIN_SSH_ALIAS} powershell ${PS_FLAGS} <base64>`,
    `└ decoded: ${script}`,
  ].join('\n              ');
  return { workDir, script, b64, remote, sshArgs, readable };
}

// ───────────────────────────── spawn ─────────────────────────────

/**
 * Spawn `count` detached Claude Code sessions on Windows.
 * Each is launched hidden+detached via `ssh <windows-node> → powershell Start-Process`; the token comes
 * from settings.json (Approach C — never injected here), and each instance self-joins the hub via
 * its SessionStart hook. `handle` is the claude.exe PID (`pid:<n>`) for the future reap lane.
 * `ok` means the spawn started + returned a PID; hub membership is confirmed by fleet.mjs's
 * roster reconcile, NOT claimed here.
 */
export async function spawnWindows(count, ctx = {}) {
  const spawned = [];
  for (let i = 0; i < count; i++) {
    const plan = windowsSpawnCmd(ctx);
    if (ctx.dryRun) {
      spawned.push({ handle: '(dry-run)', ok: true, dryRun: true, cmd: plan.readable });
      continue;
    }
    try {
      const { stdout } = await execFileP('ssh', plan.sshArgs, { timeout: SSH_TIMEOUT_MS });
      const pid = (stdout.match(/\d+/) || [])[0];
      if (!pid) {
        spawned.push({ handle: null, ok: false, err: `spawn returned no PID (stdout: ${stdout.trim().slice(0, 80) || 'empty'})` });
      } else {
        spawned.push({ handle: `pid:${pid}`, ok: true });
      }
    } catch (e) {
      spawned.push({ handle: null, ok: false, err: e.message.split('\n')[0] });
    }
  }
  return { node: 'windows', requested: count, spawned };
}
