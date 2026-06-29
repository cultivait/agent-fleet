// node --test windows.test.mjs  (Node v22 built-in runner; no deps)
// D5-W (task_8b3d40af3d) — pure-helper + dry-run coverage for the Windows lane.
// Does NOT touch fleet.test.mjs (Lane A's, frozen). No live spawns: only --dry-run + pure fns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIN_SSH_ALIAS,
  winWorkDir,
  windowsPsScript,
  encodePsCommand,
  windowsSpawnCmd,
  spawnWindows,
} from './windows.mjs';

test('WIN_SSH_ALIAS: defaults to user', () => {
  assert.equal(WIN_SSH_ALIAS, 'user');
});

test('winWorkDir: Linux ctx.workDir falls through to the Windows default', () => {
  // fleet.mjs cmdUp defaults ctx.workDir to the Linux homedir — must NOT be used on Windows.
  assert.equal(winWorkDir({ workDir: '/home/user' }), 'C:\\Users\\winuser');
  assert.equal(winWorkDir({}), 'C:\\Users\\winuser');
});

test('winWorkDir: honors an explicit Windows-style ctx.workDir', () => {
  assert.equal(winWorkDir({ workDir: 'D:\\work\\fleet' }), 'D:\\work\\fleet');
  assert.equal(winWorkDir({ workDir: 'C:/Users/winuser/proj' }), 'C:/Users/winuser/proj');
});

test('winWorkDir: WT_WIN_WORK_DIR overrides (Windows path), ignored when Linux-shaped', () => {
  const prev = process.env.WT_WIN_WORK_DIR;
  try {
    process.env.WT_WIN_WORK_DIR = 'E:\\fleet';
    assert.equal(winWorkDir({ workDir: '/home/user' }), 'E:\\fleet');
    process.env.WT_WIN_WORK_DIR = '/not/windows';
    assert.equal(winWorkDir({ workDir: 'C:\\real' }), 'C:\\real'); // env ignored, ctx honored
  } finally {
    if (prev === undefined) delete process.env.WT_WIN_WORK_DIR;
    else process.env.WT_WIN_WORK_DIR = prev;
  }
});

test('windowsPsScript: hidden detached Start-Process with PassThru + PID echo', () => {
  const s = windowsPsScript('C:\\Users\\winuser');
  assert.match(s, /\$ErrorActionPreference='Stop'/);
  assert.match(s, /\$ProgressPreference='SilentlyContinue'/); // keeps the PID the only stdout line
  assert.match(s, /Start-Process -FilePath '[^']*claude\.exe'/);
  assert.match(s, /-ArgumentList '"[^']*fleet_join[^']*"'/); // initial prompt → first turn → join (RC#1 fix)
  assert.match(s, /-WindowStyle Hidden/);
  assert.match(s, /-WorkingDirectory 'C:\\Users\\winuser'/);
  assert.match(s, /-PassThru/);
  assert.match(s, /Write-Output \$p\.Id$/);
  assert.equal(s.includes('TOKEN'), false); // Approach C — token never inlined
});

test('windowsPsScript: prompt becomes ONE double-quoted claude arg; bin override + PS quote-escape', () => {
  const s = windowsPsScript("C:\\dir\\o'brien", 'join now and stand by', "C:\\bin\\claude.exe");
  assert.match(s, /-FilePath 'C:\\bin\\claude\.exe'/);
  assert.match(s, /-ArgumentList '"join now and stand by"'/); // spaces stay one arg via the double quotes
  assert.match(s, /-WorkingDirectory 'C:\\dir\\o''brien'/); // ' doubled for PS literal
});

test('encodePsCommand: round-trips as UTF-16LE base64 (what -EncodedCommand expects)', () => {
  const script = windowsPsScript('C:\\Users\\winuser');
  const b64 = encodePsCommand(script);
  assert.match(b64, /^[A-Za-z0-9+/]+=*$/); // pure base64, safe through cmd.exe unquoted
  const decoded = Buffer.from(b64, 'base64').toString('utf16le');
  assert.equal(decoded, script);
});

test('windowsSpawnCmd: guarded ssh argv carrying only an EncodedCommand (no quotes to mangle)', () => {
  const { sshArgs, b64, script } = windowsSpawnCmd({ workDir: '/home/user' });
  assert.deepEqual(sshArgs.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'user']);
  const remote = sshArgs[sshArgs.length - 1];
  assert.equal(remote, `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`);
  assert.equal(remote.includes('"'), false); // the whole point: nothing for ssh→cmd to escape
  assert.equal(remote.includes("'"), false);
  // the transported payload decodes back to the Windows-default-dir script
  assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), script);
  assert.match(script, /-WorkingDirectory 'C:\\Users\\winuser'/);
});

test('windowsSpawnCmd: ctx.prompt overrides the default initial prompt', () => {
  const { script } = windowsSpawnCmd({ prompt: 'CUSTOM JOIN NUDGE' });
  assert.match(script, /-ArgumentList '"CUSTOM JOIN NUDGE"'/);
});

test('windowsSpawnCmd: falls back to a join+standby prompt when ctx.prompt is absent', () => {
  const { script } = windowsSpawnCmd({});
  assert.match(script, /-ArgumentList '"[^']*fleet_join[^']*"'/); // never spawns prompt-less (would never join)
});

test('spawnWindows: dry-run returns contract shape and spawns nothing', async () => {
  const r = await spawnWindows(2, { dryRun: true });
  assert.equal(r.node, 'windows');
  assert.equal(r.requested, 2);
  assert.equal(r.spawned.length, 2);
  for (const s of r.spawned) {
    assert.equal(s.ok, true);
    assert.equal(s.dryRun, true);
    assert.match(s.cmd, /ssh user powershell -NoProfile -NonInteractive -EncodedCommand <base64>/);
    assert.match(s.cmd, /decoded: .*Start-Process .*-WindowStyle Hidden/);
  }
});

test('spawnWindows: dry-run with count 0 yields an empty fleet, no error', async () => {
  const r = await spawnWindows(0, { dryRun: true });
  assert.equal(r.requested, 0);
  assert.deepEqual(r.spawned, []);
});
