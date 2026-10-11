import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-maintenance-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
const { maintenanceQuery, collectMaintenance, inspectMaintenance, maintenanceReport } = await import('../app/maintenance-tools.mjs');
const { createApplication } = await import('../app/server.mjs');
const { describeProgress } = await import('../app/public/progress.js');
const check = (id, restartReported = false) => ({ id, status: 'passed', restartReported, error: null });
const denied = id => ({ id, status: 'blocked', restartReported: null, error: { stage: 'Fixture provider', message: 'Access denied. Bearer fixture-secret' } });
const evidence = (patch = {}) => ({ version: 1, kind: 'maintenance', status: 'passed', observedAt: '2026-10-11T18:00:00.000Z',
  system: { edition: 'Professional', build: '26200', architecture: 'ARM64' }, checks: [check('windows-update'), check('pending-file-operations')], ...patch });

class FakeCodex extends EventEmitter {
  calls = [];
  async start() { this.child = {}; }
  async stop() { this.child = null; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.invalid' } };
    if (method === 'thread/start') return { thread: { id: 'fixture-thread' } };
    if (method === 'turn/start') return { turn: { id: 'fixture-turn' } };
    return {};
  }
}

test('maintenance queries select only fixed read-only intent, never restart or configuration commands', () => {
  for (const message of ['maintenance', 'show maintenance', ' CHECK MAINTENANCE ', 'show restart requirements', 'check restart requirements']) assert.deepEqual(maintenanceQuery(message), {});
  for (const message of ['restart', 'restart now', 'show maintenance and reboot', 'clear maintenance', 'show maintenance matching Example',
    'show maintenance from another host', 'maintenance\ncommand', null]) assert.equal(maintenanceQuery(message), null);
});

test('the maintenance collector receives only its fixed script and respects policy failures', async () => {
  let calls = 0;
  const result = await collectMaintenance({ shell: 'fixture-powershell', execute: async (shell, args, options) => {
    calls++; assert.equal(shell, 'fixture-powershell');
    assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-File']);
    assert.equal(path.basename(args.at(-1)), 'Get-MaintenanceStatus.ps1'); assert.equal(options.timeout, 15_000);
    return '\uFEFF' + JSON.stringify(evidence());
  } });
  assert.deepEqual(result, evidence()); assert.equal(calls, 1);
  await assert.rejects(collectMaintenance({ shell: null }), /Windows PowerShell/);
  await assert.rejects(collectMaintenance({ shell: 'fixture', execute: async () => 'unsupported' }), SyntaxError);
  await assert.rejects(collectMaintenance({ shell: 'fixture', execute: async () => { throw new Error('Script execution is disabled by policy.'); } }), /policy/);
});

test('the native source uses a read-only update property and fixed registry read without exposing queued paths', async () => {
  const source = await fs.readFile(new URL('../scripts/Get-MaintenanceStatus.ps1', import.meta.url), 'utf8');
  assert.match(source, /New-Object -ComObject Microsoft\.Update\.SystemInfo/);
  assert.match(source, /\$required = \$information\.RebootRequired/);
  assert.match(source, /Get-Item -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -ErrorAction Stop/);
  assert.match(source, /GetValueNames\(\).*PendingFileRenameOperations/);
  assert.match(source, /RegistryValueKind\]::MultiString/);
  assert.match(source, /\$files\.restartReported = \$null/);
  assert.match(source, /FinalReleaseComObject/); assert.match(source, /\$key\.Close\(\)/);
  assert.doesNotMatch(source, /(?:Set|Remove|New)-ItemProperty|(?:Set|Remove)-Item|Restart-Computer|shutdown|MoveFileEx|Update\.Session|Download\(|Install\(|Uninstall\(|ExecutionPolicy|SilentlyContinue/i);
  assert.doesNotMatch(source, /(?:report|checks|files)\.[\w]+\s*=\s*\$pending\s*(?:\r?\n|;)/i);
});

test('both negative readings are scoped evidence, never proof that the OS is healthy or restart-free', async () => {
  let calls = 0;
  const result = await inspectMaintenance(async (...args) => { assert.deepEqual(args, []); calls++; return evidence(); });
  assert.equal(calls, 1); assert.equal(result.status, 'passed'); assert.equal(result.restartRequired, false); assert.deepEqual(result.reasons, []);
  assert.equal(result.checks.length, 2); assert.match(result.scope, /only/);
  const report = maintenanceReport(result);
  assert.match(report, /Neither queried provider reports/); assert.match(report, /other restart requirements remain unverified/);
  assert.match(report, /You control any restart/); assert.match(report, /VM or physical identity unverified/);
  for (const key of ['healthy', 'safeToRestart', 'hardwareAccepted', 'runtimeAccepted', 'bootAccepted', 'recoveryAccepted']) assert.equal(result[key], undefined);
  const validation = await inspectMaintenance(async () => evidence({ system: { edition: 'WinVOS', build: 'fixture', architecture: 'ARM64' } }));
  assert.match(validation.environment, /Validation OS session; VM or physical identity unverified/);
});

test('each positive provider contributes a concrete reason and reversing provider order preserves the report', async () => {
  for (const [id, reason] of [['windows-update', 'Windows Update'], ['pending-file-operations', 'Pending file operations']]) {
    const raw = evidence(); raw.checks.find(value => value.id === id).restartReported = true; raw.checks.reverse();
    const result = await inspectMaintenance(async () => raw);
    assert.equal(result.status, 'passed'); assert.equal(result.restartRequired, true); assert.deepEqual(result.reasons, [reason]);
    assert.deepEqual(result.checks.map(value => value.id), ['windows-update', 'pending-file-operations']);
    assert.match(maintenanceReport(result), new RegExp('Restart reported by: ' + reason));
  }
  const both = await inspectMaintenance(async () => evidence({ checks: [check('windows-update', true), check('pending-file-operations', true)] }));
  assert.deepEqual(both.reasons, ['Windows Update', 'Pending file operations']);
});

test('partial failures preserve a positive restart reason and never turn unknown negatives into false', async () => {
  for (const positive of [false, true]) {
    const result = await inspectMaintenance(async () => evidence({ status: 'blocked', checks: [check('windows-update', positive), denied('pending-file-operations')] }));
    assert.equal(result.status, 'blocked'); assert.equal(result.restartRequired, positive ? true : null);
    assert.equal(result.checks[1].restartReported, null); assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
    const report = maintenanceReport(result); assert.match(report, /Pending file operations is blocked/);
    assert.match(report, positive ? /Restart reported by: Windows Update/ : /Restart requirements remain unknown/);
  }
  const result = await inspectMaintenance(async () => evidence({ status: 'blocked', checks: [denied('windows-update'), denied('pending-file-operations')] }));
  assert.equal(result.status, 'blocked'); assert.equal(result.restartRequired, null); assert.deepEqual(result.reasons, []);
});

test('missing maintenance provider rows remain unknown instead of passing as negative restart evidence', async () => {
  const missingFirst = Array(2); missingFirst[1] = check('pending-file-operations');
  const missingSecond = Array(2); missingSecond[0] = check('windows-update', true);
  const blockedWithHole = Array(2); blockedWithHole[0] = denied('windows-update');
  for (const checks of [Array(2), missingFirst, missingSecond, blockedWithHole,
    [undefined, check('pending-file-operations')], [check('windows-update'), null]]) {
    for (const status of ['passed', 'blocked']) {
      const result = await inspectMaintenance(async () => evidence({ status, checks }));
      assert.equal(result.status, 'blocked'); assert.equal(result.restartRequired, null);
      assert.deepEqual(result.reasons, []); assert.deepEqual(result.checks, []);
      const report = maintenanceReport(result);
      assert.match(report, /blocked.*incomplete provider readings/);
      assert.doesNotMatch(report, /Neither queried provider reports|No restart reported/);
    }
  }
});

test('complete provider pairs retain true, false and unknown restart evidence in either order', async () => {
  const states = [false, true, null];
  const reading = (id, state) => state === null ? denied(id) : check(id, state);
  for (const update of states) for (const files of states) for (const reverse of [false, true]) {
    const checks = [reading('windows-update', update), reading('pending-file-operations', files)];
    if (reverse) checks.reverse();
    const status = update === null || files === null ? 'blocked' : 'passed';
    const result = await inspectMaintenance(async () => evidence({ status, checks }));
    const expected = update === true || files === true ? true : status === 'passed' ? false : null;
    assert.equal(result.status, status); assert.equal(result.restartRequired, expected);
    assert.deepEqual(result.checks.map(value => value.id), ['windows-update', 'pending-file-operations']);
    assert.deepEqual(result.reasons, [update === true && 'Windows Update', files === true && 'Pending file operations'].filter(Boolean));
    assert.match(maintenanceReport(result), expected === true ? /Restart reported by:/
      : expected === false ? /Neither queried provider reports/ : /Restart requirements remain unknown/);
  }
});

test('queued filenames, provider extras and caller-supplied aggregate flags are excluded from results', async () => {
  const raw = evidence({ restartRequired: true, reasons: ['Private fixture reason'], accepted: true });
  raw.checks[1].queuedPaths = ['Private fixture filename']; raw.checks[0].details = 'Private fixture details';
  const result = await inspectMaintenance(async () => raw);
  assert.equal(result.restartRequired, false); assert.deepEqual(result.reasons, []);
  assert.doesNotMatch(JSON.stringify(result) + maintenanceReport(result), /Private fixture/); assert.equal(result.accepted, undefined);
});

test('contradictory status, duplicate providers and unsupported readings fail closed without reasons', async () => {
  for (const raw of [null, evidence({ observedAt: 'invalid' }), evidence({ checks: [] }), evidence({ checks: {} }), evidence({ status: 'blocked' }),
    evidence({ checks: [check('windows-update'), check('windows-update')] }), evidence({ checks: [check('__proto__'), check('pending-file-operations')] }),
    evidence({ checks: [check('outside-provider'), check('pending-file-operations')] }), evidence({ checks: [check(['windows-update']), check(['windows-update'])] }),
    evidence({ checks: [check(['windows-update']), check('pending-file-operations')] }), evidence({ checks: [check('windows-update', 'true'), check('pending-file-operations')] }),
    evidence({ checks: [check('windows-update', 0), check('pending-file-operations')] }), evidence({ checks: [check('windows-update', null), check('pending-file-operations')] }),
    evidence({ checks: [denied('windows-update'), check('pending-file-operations')] }),
    evidence({ status: 'blocked', checks: [{ ...denied('windows-update'), restartReported: false }, check('pending-file-operations')] }),
    evidence({ status: 'blocked', checks: [{ ...denied('windows-update'), error: null }, check('pending-file-operations')] }),
    evidence({ checks: [{ ...check('windows-update'), error: { message: 'Conflicting error' } }, check('pending-file-operations')] })]) {
    const result = await inspectMaintenance(async () => raw);
    assert.equal(result.status, 'blocked'); assert.equal(result.restartRequired, null); assert.deepEqual(result.reasons, []); assert.deepEqual(result.checks, []);
  }
  const failed = await inspectMaintenance(async () => { throw new Error('Provider unavailable. Bearer fixture-secret'); });
  assert.equal(failed.restartRequired, null); assert.match(maintenanceReport(failed), /Provider unavailable/); assert.doesNotMatch(maintenanceReport(failed), /fixture-secret/);
});

test('chat requires session and origin checks, ignores scope fields, uses no account and saves the report across restart', async () => {
  let calls = 0; const fake = new FakeCodex();
  const options = { port: 0, codex: fake, autostart: false, maintenanceCollector: async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); } };
  let app = await createApplication(options);
  try {
    const send = headers => fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'show maintenance', path: 'outside-fixture', registryPath: 'other-fixture', restart: true, computerName: 'remote-fixture' }) });
    assert.equal((await send({})).status, 403); assert.equal(calls, 0);
    const page = await fetch(app.origin), html = await page.text(), cookie = page.headers.get('set-cookie').split(';')[0];
    const token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1], headers = { cookie, 'X-Volterra-Client': token };
    assert.equal((await send({ cookie })).status, 403);
    assert.equal((await send({ ...headers, Origin: 'https://untrusted.example' })).status, 403); assert.equal(calls, 0);
    const response = await send(headers), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.tool, 'maintenance'); assert.equal(result.status, 'passed'); assert.equal(result.restartRequired, false);
    assert.equal(calls, 1); assert.deepEqual(fake.calls, []); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Neither queried provider reports'));
    assert.ok(output); await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('maintenance checking preserves saved pauses, active turns and permission questions and excludes simultaneous inventories', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, maintenanceCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' }); await app.automation.pause();
    const before = fake.calls.length, request = app.actions['agent/send']({ text: 'show maintenance' });
    const snapshot = app.snapshot(); assert.equal(snapshot.activeTurn, 'fixture-turn'); assert.equal(snapshot.systemTool.kind, 'maintenance');
    assert.equal(describeProgress(snapshot).phase, 'checking'); assert.equal(describeProgress(snapshot).active, true);
    assert.equal(describeProgress({ ...snapshot, approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress({ ...snapshot, interruptRequested: true }).phase, 'stopping'); assert.equal(describeProgress(snapshot, false).phase, 'disconnected');
    for (const text of ['show services', 'show devices', 'show storage', 'show networking', 'show files', 'show logs', 'show maintenance']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn'); assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('a policy-blocked maintenance read remains saved as unknown and clears transient checking', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false,
    maintenanceCollector: async () => { throw new Error('Script execution is disabled by policy.'); } });
  try {
    const result = await app.actions['agent/send']({ text: 'show restart requirements' });
    assert.equal(result.status, 'blocked'); assert.equal(result.restartRequired, null); assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'output' && entry.data.delta?.includes('Maintenance restart requirements are blocked.')));
  } finally { await app.close(); }
});

test('missing maintenance readings save a blocked report and checking recovers for the next complete query', async () => {
  let calls = 0;
  const options = { port: 0, codex: new FakeCodex(), autostart: false, maintenanceCollector: async () => {
    calls++;
    return calls === 1 ? evidence({ checks: Array(2) }) : evidence();
  } };
  let app = await createApplication(options);
  try {
    const before = app.snapshot().journal.length;
    const missing = await app.actions['agent/send']({ text: 'show maintenance' });
    assert.equal(missing.status, 'blocked'); assert.equal(missing.restartRequired, null);
    assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.slice(before).find(entry => entry.type === 'output'
      && entry.data.delta?.includes('Maintenance restart requirements are blocked.'));
    assert.ok(output); assert.doesNotMatch(output.data.delta, /Neither queried provider reports/);
    await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const complete = await app.actions['agent/send']({ text: 'show maintenance' });
    assert.equal(complete.status, 'passed'); assert.equal(complete.restartRequired, false);
    assert.equal(calls, 2); assert.equal(app.snapshot().systemTool, null);
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-maintenance-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
