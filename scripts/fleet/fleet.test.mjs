// node --test fleet.test.mjs  (Node v22 built-in runner; no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, parseEnvFile, classifyName, reconcile, linuxSpawnCmd, buildSpawnInner, sanitizeCallsign, ghosttyAttachCmd, resolveTermMode, resolveDisplay, reapPlan, parseTmuxSessions, panePidCmd, parsePanePid, enforceCap, auditRecord, launcherRegisterPayload, reapRegisterPayload, pickPluginInstallPath, buildFleetMcpConfig, buildBuilderSettings } from './fleet.mjs';

// A generic working directory for spawn-command tests (no hardcoded user/path).
const WORK_DIR = tmpdir();

test('parseArgs: up with counts', () => {
  const o = parseArgs(['up', '--linux', '3', '--windows', '1', '--yes']);
  assert.equal(o.cmd, 'up');
  assert.equal(o.linux, 3);
  assert.equal(o.windows, 1);
  assert.equal(o.yes, true);
});

test('parseArgs: rejects negative / non-integer', () => {
  assert.throws(() => parseArgs(['up', '--linux', '-1']));
  assert.throws(() => parseArgs(['up', '--linux', 'abc']));
  assert.throws(() => parseArgs(['up', '--bogus']));
});

test('parseArgs: bare command defaults', () => {
  const o = parseArgs(['status']);
  assert.equal(o.cmd, 'status');
  assert.equal(o.linux, 0);
  assert.equal(o.windows, 0);
  assert.equal(o.yes, false);
  assert.equal(o.term, 'auto');
});

test('parseArgs: --term accepts ghostty|tmux|auto, rejects others', () => {
  assert.equal(parseArgs(['up', '--linux', '1', '--term', 'ghostty']).term, 'ghostty');
  assert.equal(parseArgs(['up', '--linux', '1', '--term', 'tmux']).term, 'tmux');
  assert.throws(() => parseArgs(['up', '--linux', '1', '--term', 'screen']));
});

test('parseArgs: --prompt overrides, defaults to a non-empty join prompt, rejects empty', () => {
  assert.equal(parseArgs(['up', '--linux', '1', '--prompt', 'do the thing']).prompt, 'do the thing');
  const def = parseArgs(['up', '--linux', '1']).prompt;
  assert.equal(typeof def === 'string' && def.trim().length > 0, true); // a teammate always launches with a prompt
  assert.throws(() => parseArgs(['up', '--linux', '1', '--prompt', '   '])); // empty → no first turn → never joins
});

test('ghosttyAttachCmd: attaches a window to the tmux session, env carries DISPLAY/XAUTHORITY', () => {
  const c = ghosttyAttachCmd('wt-abc123', ':1', '/run/user/1000/gdm/Xauthority', '/snap/bin/ghostty');
  assert.equal(c.bin, '/snap/bin/ghostty');
  assert.deepEqual(c.args, ['--title=wt-abc123', '-e', 'tmux', 'attach', '-t', 'wt-abc123']);
  assert.equal(c.env.DISPLAY, ':1');
  assert.equal(c.env.XAUTHORITY, '/run/user/1000/gdm/Xauthority');
});

test('resolveTermMode: matrix', () => {
  const disp = { display: ':1', xauthority: '/x' };
  assert.equal(resolveTermMode('tmux', disp, '/snap/bin/ghostty'), 'tmux');     // explicit headless
  assert.equal(resolveTermMode('ghostty', disp, '/snap/bin/ghostty'), 'ghostty');
  assert.equal(resolveTermMode('ghostty', null, '/snap/bin/ghostty'), 'tmux-fallback'); // no display
  assert.equal(resolveTermMode('ghostty', disp, null), 'tmux-fallback');        // no ghostty binary
  assert.equal(resolveTermMode('auto', disp, '/snap/bin/ghostty'), 'ghostty');  // auto + gui → ghostty
  assert.equal(resolveTermMode('auto', null, null), 'tmux');                    // auto headless → tmux
});

test('resolveDisplay: AF_FLEET_NO_GUI forces null; explicit overrides resolve', () => {
  assert.equal(resolveDisplay({ AF_FLEET_NO_GUI: '1', DISPLAY: ':1' }), null);
  // /etc/hostname exists on Linux → use it as a stand-in xauthority for the override path
  const r = resolveDisplay({ AF_FLEET_DISPLAY: ':7', AF_FLEET_XAUTHORITY: '/etc/hostname' });
  assert.deepEqual(r, { display: ':7', xauthority: '/etc/hostname' });
});

test('parseEnvFile: KEY=VALUE, export, quotes, comments', () => {
  const env = parseEnvFile([
    '# comment',
    'AGENT_FLEET_JOIN_TOKEN=abc123',
    'export AGENT_FLEET_ADMIN_TOKEN="def 456"',
    "QUOTED='ghi'",
    '',
    'NOEQ',
  ].join('\n'));
  assert.equal(env.AGENT_FLEET_JOIN_TOKEN, 'abc123');
  assert.equal(env.AGENT_FLEET_ADMIN_TOKEN, 'def 456');
  assert.equal(env.QUOTED, 'ghi');
  assert.equal('NOEQ' in env, false);
});

test('classifyName: node from callsign prefix', () => {
  assert.equal(classifyName('linux-1d49'), 'linux');
  assert.equal(classifyName('windows-referee'), 'windows');
  assert.equal(classifyName('mac-3b92'), 'mac');
  assert.equal(classifyName('operator'), 'other');
});

test('reconcile: full success', () => {
  const before = ['linux-aaa', 'windows-x'];
  const after = ['linux-aaa', 'windows-x', 'linux-bbb', 'linux-ccc', 'windows-y'];
  const r = reconcile(before, after, { linux: 2, windows: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.joinedByNode, { linux: 2, windows: 1 });
  assert.deepEqual(r.newNames.sort(), ['linux-bbb', 'linux-ccc', 'windows-y']);
  assert.deepEqual(r.shortfall, { linux: 0, windows: 0 });
});

test('reconcile: silent-failure detector — shortfall when an instance never joins', () => {
  const before = ['linux-aaa'];
  const after = ['linux-aaa', 'linux-bbb']; // requested 2 linux, only 1 appeared
  const r = reconcile(before, after, { linux: 2, windows: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.shortfall.linux, 1);
});

test('reconcile: ignores pre-existing names and unrelated nodes', () => {
  const before = ['linux-aaa', 'windows-old'];
  const after = ['linux-aaa', 'windows-old', 'mac-z', 'linux-new'];
  const r = reconcile(before, after, { linux: 1, windows: 0 });
  assert.equal(r.ok, true);
  // mac-z is new but not counted toward linux/windows expectations
  assert.equal(r.joinedByNode.linux, 1);
  assert.equal(r.joinedByNode.windows, 0);
});

test('linuxSpawnCmd: detached tmux, Approach B env source, no token on command line', () => {
  const { session, bin, args } = linuxSpawnCmd(WORK_DIR, 'join the radio and stand by');
  assert.match(session, /^wt-[0-9a-f]{6}$/);
  assert.equal(bin, 'tmux');
  assert.deepEqual(args.slice(0, 6), ['new-session', '-d', '-s', session, '-c', WORK_DIR]);
  const inner = args[args.length - 1];
  assert.match(inner, /\. ".*agent-fleet\/env"/); // sources the canonical env file
  assert.match(inner, /exec claude --no-chrome --settings '[^']*fleet-builder-settings\.json' --strict-mcp-config --mcp-config '[^']*fleet-mcp\.json' --remote-control linux-[0-9a-f]{6} 'join the radio and stand by'$/); // builder --settings allowlist + strict-mcp Variant B + remote-control callsign + positional prompt → first turn → join
  assert.match(inner, /v22\.\*\/bin/); // pins node>=20 for hooks
  assert.match(inner, /export AF_SPAWN_ID=[0-9a-f]{6};/); // spawn id exported into the env for the hook
  // No token VALUE is ever inlined (values come from the sourced file at runtime). The default lane
  // legitimately names AGENT_FLEET_ADMIN_TOKEN in an `unset` (the NAME is not a secret), so assert
  // on a value-assignment `TOKEN=…` rather than the bare substring 'TOKEN'.
  assert.doesNotMatch(inner, /TOKEN=/);
  assert.match(inner, /unset AGENT_FLEET_ADMIN_TOKEN;/); // and the default lane sheds the admin token (least-privilege)
});

test('linuxSpawnCmd: AF_SPAWN_ID equals the session rid and is exported before exec claude', () => {
  const r = linuxSpawnCmd(WORK_DIR, 'go');
  const inner = r.args[r.args.length - 1];
  const id = r.session.slice(3); // strip the 'wt-' prefix
  assert.match(r.session, /^wt-[0-9a-f]{6}$/);
  assert.equal(r.rid, id); // returned rid is the session's rid
  assert.ok(inner.includes(`export AF_SPAWN_ID=${id};`)); // same rid that names the session
  // the export must precede `exec claude` so the SessionStart hook (a child process) inherits it
  assert.ok(inner.indexOf(`AF_SPAWN_ID=${id}`) < inner.indexOf('exec claude'));
});

test('parseArgs: reap command, with and without --yes', () => {
  assert.equal(parseArgs(['reap']).cmd, 'reap');
  assert.equal(parseArgs(['reap']).yes, false);
  assert.equal(parseArgs(['reap', '--yes']).cmd, 'reap');
  assert.equal(parseArgs(['reap', '--yes']).yes, true);
});

test('parseTmuxSessions: extracts wt-* session names from tmux ls output', () => {
  const out = 'wt-aaa111: 1 windows (created Tue)\nwt-bbb222: 1 windows (created Tue)\n';
  assert.deepEqual(parseTmuxSessions(out), ['wt-aaa111', 'wt-bbb222']);
  assert.deepEqual(parseTmuxSessions(''), []);
  assert.deepEqual(parseTmuxSessions('other: 1 windows'), []); // non-fleet sessions ignored
});

test('panePidCmd: builds the tmux pane_pid query for a session (no execution)', () => {
  assert.deepEqual(panePidCmd('wt-abc123'), { bin: 'tmux', args: ['display-message', '-p', '-t', 'wt-abc123', '#{pane_pid}'] });
});

test('parsePanePid: numeric pid → int; junk/empty → null', () => {
  assert.equal(parsePanePid('4242\n'), 4242);
  assert.equal(parsePanePid('  171717  '), 171717); // trims whitespace
  assert.equal(parsePanePid('4242\n9999'), 4242);   // first line only (one pane)
  assert.equal(parsePanePid(''), null);
  assert.equal(parsePanePid('\n'), null);
  assert.equal(parsePanePid('no server running on /tmp/tmux-1000/default'), null); // tmux error text
  assert.equal(parsePanePid('0'), null);            // pid 0 is not a real process
  assert.equal(parsePanePid('-5'), null);
  assert.equal(parsePanePid(undefined), null);
});

test('reapPlan: one tmux kill-session command per fleet session', () => {
  const plan = reapPlan(['wt-aaa111', 'wt-bbb222']);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { session: 'wt-aaa111', bin: 'tmux', args: ['kill-session', '-t', 'wt-aaa111'] });
  assert.deepEqual(plan[1], { session: 'wt-bbb222', bin: 'tmux', args: ['kill-session', '-t', 'wt-bbb222'] });
  assert.deepEqual(reapPlan([]), []);
});

test('enforceCap: under, at, and over the ceiling', () => {
  assert.equal(enforceCap(2, 2, 5).allowed, true);  // 4 <= 5  (under)
  assert.equal(enforceCap(3, 2, 5).allowed, true);  // 5 <= 5  (exactly at cap)
  const over = enforceCap(3, 3, 5);                 // 6 > 5   (over)
  assert.equal(over.allowed, false);
  assert.match(over.reason, /cap/i);
  assert.equal(enforceCap(0, 5, 5).allowed, true);  // fresh fleet, request fills the cap
  assert.equal(enforceCap(0, 6, 5).allowed, false); // single request over cap is refused
});

test('auditRecord: stable shape, injectable ts, workdir defaults to null', () => {
  const rec = auditRecord({ action: 'spawn', spawnId: 'abc123', session: 'wt-abc123', workdir: WORK_DIR, ts: '2026-06-17T00:00:00.000Z' });
  assert.deepEqual(rec, { ts: '2026-06-17T00:00:00.000Z', action: 'spawn', spawn_id: 'abc123', session: 'wt-abc123', node: 'linux', workdir: WORK_DIR });
  const r2 = auditRecord({ action: 'reap', spawnId: 'def456', session: 'wt-def456' });
  assert.match(r2.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/); // default ts is a real ISO timestamp
  assert.equal(r2.workdir, null);
  assert.equal(r2.node, 'linux');
});

test('launcherRegisterPayload: launcher subset; omits pid/owned_branch when unknown', () => {
  const minimal = launcherRegisterPayload({ spawnId: 'abc123', workDir: '/w/fleet' });
  assert.deepEqual(minimal, { spawn_id: 'abc123', node: 'linux', control_handle: 'tmux:wt-abc123', worktree_path: '/w/fleet' });
  assert.equal('pid' in minimal, false);
  assert.equal('owned_branch' in minimal, false);
  const full = launcherRegisterPayload({ spawnId: 'abc123', workDir: '/w', pid: 4242, ownedBranch: 'wip/x' });
  assert.equal(full.pid, 4242);
  assert.equal(full.owned_branch, 'wip/x');
  assert.equal(full.control_handle, 'tmux:wt-abc123');
});

test('reapRegisterPayload: signed_off retire body keyed on spawn_id, node-tagged, no other fields', () => {
  const p = reapRegisterPayload({ spawnId: 'abc123' });
  assert.deepEqual(p, { spawn_id: 'abc123', node: 'linux', status: 'signed_off' });
  // partial body: carries ONLY the merge key + the status transition (hub merges on spawn_id)
  assert.deepEqual(Object.keys(p).sort(), ['node', 'spawn_id', 'status']);
});

test('linuxSpawnCmd: defaults to a non-empty join prompt and shell-escapes single quotes', () => {
  const def = linuxSpawnCmd(WORK_DIR); // no prompt arg → DEFAULT_PROMPT
  assert.match(def.args[def.args.length - 1], /exec claude --no-chrome --settings '[^']*fleet-builder-settings\.json' --strict-mcp-config --mcp-config '[^']*fleet-mcp\.json' --remote-control linux-[0-9a-f]{6} '[^']+/); // settings allowlist + strict-mcp + callsign + a prompt is present, not bare `exec claude`
  const tricky = linuxSpawnCmd(WORK_DIR, "don't idle");
  // single quote doubled via the '\'' POSIX idiom so the payload stays one safe arg
  assert.match(tricky.args[tricky.args.length - 1], /exec claude --no-chrome --settings '[^']*fleet-builder-settings\.json' --strict-mcp-config --mcp-config '[^']*fleet-mcp\.json' --remote-control linux-[0-9a-f]{6} 'don'\\''t idle'$/);
});

// ── --referee lane (least-privilege admin-token carve-out) ──

test('parseArgs: --referee sets the flag (default false) and requires exactly --linux 1', () => {
  assert.equal(parseArgs(['up', '--linux', '1']).referee, false);            // default off
  assert.equal(parseArgs(['up', '--linux', '1', '--referee']).referee, true);
  assert.throws(() => parseArgs(['up', '--linux', '2', '--referee']), /single REFEREE/); // multi → collision
  assert.throws(() => parseArgs(['up', '--referee']), /single REFEREE/);      // --linux defaults to 0
});

test('buildSpawnInner: DEFAULT lane unsets the admin token (after the source) and sets no role; keeps join', () => {
  const inner = buildSpawnInner({ envFile: '/tmp/fake/env', id: 'abc123', prompt: 'go' });
  assert.match(inner, /set -a; \. "\/tmp\/fake\/env"; set \+a;/);   // sources the canonical file (no token on a cmd line)
  assert.match(inner, /unset AGENT_FLEET_ADMIN_TOKEN;/);            // least-privilege: admin shed by default
  assert.match(inner, /unset AF_ROLE;/);                           // plain builder SHEDS any leaked referee role
  assert.doesNotMatch(inner, /export AF_ROLE/);                    // ...and never exports one
  assert.match(inner, /export AF_SPAWN_ID=abc123;/);
  // non-referee callsign = linux-<rid>; exported as AF_CALLSIGN (before exec, for the hook)
  // and passed to --remote-control so tmux id = radio callsign = remote-control name.
  assert.match(inner, /export AF_CALLSIGN=linux-abc123;/);
  assert.ok(inner.indexOf('AF_CALLSIGN=linux-abc123') < inner.indexOf('exec claude'));
  assert.match(inner, /exec claude --no-chrome --settings '[^']*fleet-builder-settings\.json' --strict-mcp-config --mcp-config '[^']*fleet-mcp\.json' --remote-control linux-abc123 'go'$/);
  // the unset MUST come after the source so it clears file-sourced AND inherited admin
  assert.ok(inner.indexOf('unset AGENT_FLEET_ADMIN_TOKEN') > inner.indexOf('. "/tmp/fake/env"'));
});

test('buildSpawnInner: --referee lane exports AF_ROLE=referee and does NOT unset admin (the one spawn that needs it)', () => {
  const inner = buildSpawnInner({ envFile: '/tmp/fake/env', id: 'abc123', prompt: 'go', referee: true });
  assert.match(inner, /export AF_ROLE=referee;/);
  assert.doesNotMatch(inner, /unset AGENT_FLEET_ADMIN_TOKEN/);   // admin kept for fleet_become_referee
  assert.match(inner, /set -a; \. "\/tmp\/fake\/env"; set \+a;/);   // still sources the file
  // the REFEREE lane labels --remote-control REFEREE but must NOT set AF_CALLSIGN —
  // AF_ROLE=referee is the identity driver (radio promotes it to the reserved REFEREE callsign);
  // an AF_CALLSIGN would wrongly try to override that reserved identity.
  assert.match(inner, /exec claude --no-chrome --remote-control REFEREE 'go'$/);
  assert.doesNotMatch(inner, /AF_CALLSIGN/);
});

test('buildSpawnInner: the DEFAULT referee lane wires the become-referee prompt, NOT the join prompt', () => {
  // The real launcher path: prompt is the module DEFAULT_PROMPT. linuxSpawnCmd defaults to it,
  // so a 2-arg referee call exercises exactly what `fleet up --referee` produces.
  const ref = linuxSpawnCmd(WORK_DIR, undefined, { referee: true }).args.at(-1);
  assert.match(ref, /fleet_become_referee/);                 // startup action is the admin promote
  assert.match(ref, /do NOT call fleet_join/);               // explicitly steers off the member path
  assert.doesNotMatch(ref, /call fleet_join to join/);       // the DEFAULT_PROMPT join directive is gone
  // The plain default lane still carries the join directive (no regression).
  const plain = linuxSpawnCmd(WORK_DIR, undefined, {}).args.at(-1);
  assert.match(plain, /call fleet_join to join/);
  assert.doesNotMatch(plain, /fleet_become_referee/);
});

test('buildSpawnInner: an EXPLICIT --prompt overrides the referee default (custom prompt is honored verbatim)', () => {
  const inner = buildSpawnInner({ envFile: '/tmp/fake/env', id: 'abc123', prompt: 'custom-referee-go', referee: true });
  assert.match(inner, /exec claude --no-chrome --remote-control REFEREE 'custom-referee-go'$/);
  assert.doesNotMatch(inner, /fleet_become_referee/);
});

test('linuxSpawnCmd: opts.referee threads AF_ROLE into the payload; default unsets admin (no signature break)', () => {
  const ref = linuxSpawnCmd(WORK_DIR, 'go', { referee: true }).args.at(-1);
  assert.match(ref, /export AF_ROLE=referee;/);
  const plain = linuxSpawnCmd(WORK_DIR, 'go').args.at(-1);    // 2-arg call still works (backward-compat)
  assert.match(plain, /unset AGENT_FLEET_ADMIN_TOKEN;/);
  assert.match(plain, /unset AF_ROLE;/);              // sheds leaked referee role
  assert.doesNotMatch(plain, /export AF_ROLE/);
});

// BEHAVIORAL (the load-bearing one): a CLEAN-parent test would prove nothing about least-privilege.
// Run the real env-construction under `bash -lc` with the admin token PRESENT in the simulated operator
// parent env + an env file that ALSO carries it, swap exec→`env`, and confirm the child env per lane.
test('buildSpawnInner BEHAVIORAL: admin absent from a plain builder even when the operator shell has it; present ONLY under --referee', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-referee-'));
  const envFile = join(dir, 'env');
  writeFileSync(envFile, 'AGENT_FLEET_JOIN_TOKEN=file-join\nAGENT_FLEET_ADMIN_TOKEN=file-admin\n');
  // Simulate the leaky operator shell: BOTH tokens AND a referee role already exported into the
  // launcher's own env (AF_ROLE=referee is a real leak — the launcher session can carry it).
  const parentEnv = { ...process.env, AGENT_FLEET_ADMIN_TOKEN: 'parent-admin', AGENT_FLEET_JOIN_TOKEN: 'parent-join', AF_ROLE: 'parent-referee' };
  const probe = (referee) => {
    const inner = buildSpawnInner({ envFile, id: 'probe', prompt: 'go', referee }).replace(/exec claude .*/, 'exec env');
    const out = execFileSync('bash', ['-lc', inner], { env: parentEnv, encoding: 'utf8' });
    const get = (k) => (out.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
    return { join: get('AGENT_FLEET_JOIN_TOKEN'), admin: get('AGENT_FLEET_ADMIN_TOKEN'), role: get('AF_ROLE') };
  };
  const plain = probe(false);
  assert.equal(plain.admin, undefined, 'plain builder must NOT carry the admin token (unset wins over file + parent)');
  assert.equal(plain.join, 'file-join', 'plain builder still self-joins with the join token');
  assert.equal(plain.role, undefined, 'plain builder SHEDS the leaked parent AF_ROLE (unset wins over parent)');
  const ref = probe(true);
  assert.equal(ref.admin, 'file-admin', 'referee spawn carries the admin token for fleet_become_referee');
  assert.equal(ref.join, 'file-join');
  assert.equal(ref.role, 'referee', 'referee spawn sets AF_ROLE=referee');
});

// ── remote-control identity (tmux id = radio callsign = remote-control name) ──

test('sanitizeCallsign: keeps only [A-Za-z0-9-]', () => {
  assert.equal(sanitizeCallsign('linux-62930f'), 'linux-62930f');
  assert.equal(sanitizeCallsign('linux_/ab c.;'), 'linuxabc'); // strips _ / space . ; keeps letters
  assert.equal(sanitizeCallsign('REFEREE'), 'REFEREE');
});

test('linuxSpawnCmd: non-referee callsign linux-<rid> matches the session rid, exported + passed to --remote-control', () => {
  const r = linuxSpawnCmd(WORK_DIR, 'go');
  const inner = r.args.at(-1);
  const callsign = `linux-${r.rid}`;
  assert.ok(inner.includes(`export AF_CALLSIGN=${callsign};`));            // SessionStart hook adopts it
  assert.match(inner, new RegExp(`exec claude --no-chrome --settings '[^']*fleet-builder-settings\\.json' --strict-mcp-config --mcp-config '[^']*fleet-mcp\\.json' --remote-control ${callsign} `));  // settings allowlist + strict-mcp + remote-control name == tmux wt-<rid>
  assert.ok(inner.indexOf('AF_CALLSIGN=') < inner.indexOf('exec claude')); // exported before exec for the child hook
});

test('linuxSpawnCmd: REFEREE lane labels remote-control REFEREE and sets no AF_CALLSIGN', () => {
  const inner = linuxSpawnCmd(WORK_DIR, 'go', { referee: true }).args.at(-1);
  assert.match(inner, /exec claude --no-chrome --remote-control REFEREE /);
  assert.doesNotMatch(inner, /AF_CALLSIGN/);
});

// ── T3 strict-mcp-config (Variant B): builders load ONLY agent-fleet MCP ──

test('buildSpawnInner: REFEREE lane is EXEMPT from strict-mcp-config (keeps full tools to coordinate)', () => {
  const ref = buildSpawnInner({ envFile: '/tmp/fake/env', id: 'abc123', prompt: 'go', referee: true });
  assert.doesNotMatch(ref, /--strict-mcp-config/);
  assert.doesNotMatch(ref, /--mcp-config/);
  const plain = buildSpawnInner({ envFile: '/tmp/fake/env', id: 'abc123', prompt: 'go' });
  assert.match(plain, /--strict-mcp-config --mcp-config '[^']*fleet-mcp\.json'/); // builders restricted to agent-fleet only
});

test('pickPluginInstallPath: pulls agent-fleet installPath from installed_plugins.json, version-agnostic', () => {
  const json = { version: 2, plugins: {
    'other@x': [{ installPath: '/x', version: '1' }],
    'agent-fleet@suruseas': [{ installPath: '/plugins/cache/suruseas/agent-fleet/9.9.9', version: '9.9.9' }],
  } };
  assert.equal(pickPluginInstallPath(json), '/plugins/cache/suruseas/agent-fleet/9.9.9'); // no hardcoded version
  assert.equal(pickPluginInstallPath({ plugins: {} }), null);   // absent → null
  assert.equal(pickPluginInstallPath(null), null);              // malformed → null, no throw
  assert.equal(pickPluginInstallPath({ plugins: { 'agent-fleet': { installPath: '/bare' } } }), '/bare'); // non-array entry tolerated
});

test('buildFleetMcpConfig: Variant B — re-declares ONLY agent-fleet via node <pluginDir>/dist/mcp-server.mjs, no env block', () => {
  const cfg = buildFleetMcpConfig('/plug/dir');
  assert.deepEqual(Object.keys(cfg.mcpServers), ['agent-fleet']);   // ONLY agent-fleet
  assert.equal(cfg.mcpServers['agent-fleet'].command, 'node');
  assert.deepEqual(cfg.mcpServers['agent-fleet'].args, ['/plug/dir/dist/mcp-server.mjs']);
  assert.equal(cfg.mcpServers['agent-fleet'].env, undefined);       // token+hub come from the sourced env
});

test('buildBuilderSettings: templates the allowlist from dynamic repo-root + ~/.claude (no hardcoded user/path)', () => {
  const cfg = buildBuilderSettings('/repo/root', '/home/user/.claude');
  assert.deepEqual(cfg.permissions.allow, [
    'mcp__agent-fleet',
    'mcp__plugin_agent-fleet_agent-fleet',
    'Edit(/home/user/.claude/hooks/**)',
    'Write(/home/user/.claude/hooks/**)',
    'Edit(/repo/root/**)',
    'Write(/repo/root/**)',
  ]);
});
