import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-uptime-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
const { uptimeQuery, collectUptime, inspectUptime, uptimeReport } = await import('../app/uptime-tools.mjs');
const { createApplication } = await import('../app/server.mjs');
const { describeProgress } = await import('../app/public/progress.js');
const evidence = (patch = {}) => ({ version: 1, kind: 'uptime', status: 'passed', error: null, observedAt: '2026-10-11T18:00:00.000Z',
  system: { platform: 'win32', release: 'fixture', runtimeArchitecture: 'arm64' }, systemSeconds: 183845, helperSeconds: 61.25, ...patch });

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

test('uptime intent accepts only fixed local readings without operation or scope arguments', () => {
  for (const message of ['uptime', 'show uptime', ' SHOW SYSTEM UPTIME ', 'system uptime']) assert.deepEqual(uptimeQuery(message), {});
  for (const message of ['restart uptime', 'show uptime from another host', 'show uptime matching x', 'show uptime; restart', 'uptime\ncommands', '', null, 1]) assert.equal(uptimeQuery(message), null);
});

test('the collector reads both counters once without arguments and preserves helper fractions', async () => {
  const calls = [];
  const result = await collectUptime({
    readSystem: (...args) => { calls.push('system'); assert.deepEqual(args, []); return 183845; },
    readHelper: (...args) => { calls.push('helper'); assert.deepEqual(args, []); return 61.25; }
  });
  assert.deepEqual(calls, ['system', 'helper']); assert.equal(result.version, 1); assert.equal(result.kind, 'uptime');
  assert.equal(result.status, 'passed'); assert.equal(result.error, null);
  assert.equal(result.systemSeconds, 183845); assert.equal(result.helperSeconds, 61.25);
  assert.ok(Number.isFinite(Date.parse(result.observedAt))); assert.equal(result.bootTimestamp, undefined);
});

test('missing getters and unsupported seconds are rejected before becoming readings', async () => {
  let reads = 0;
  await assert.rejects(collectUptime({ readSystem: () => { reads++; return 1; }, readHelper: null }), /APIs are required/);
  await assert.rejects(collectUptime({ readSystem: null, readHelper: () => { reads++; return 0; } }), /APIs are required/);
  assert.equal(reads, 0);
  const invalid = [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1, '1024', 1024n, null, undefined, true];
  for (const value of invalid) await assert.rejects(collectUptime({ readSystem: () => value, readHelper: () => 0 }), /OS uptime API returned unsupported seconds/);
  for (const value of invalid) await assert.rejects(collectUptime({ readSystem: () => 1, readHelper: () => value }), /helper process uptime API returned unsupported seconds/);
});

test('zero counters, fractional helper seconds and safe boundaries remain independent readings', async () => {
  for (const [systemSeconds, helperSeconds] of [[0, 0], [0, 0.25], [1, 2.5], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
    const result = await inspectUptime(async () => evidence({ systemSeconds, helperSeconds }));
    assert.equal(result.status, 'passed'); assert.equal(result.systemSeconds, systemSeconds); assert.equal(result.helperSeconds, helperSeconds);
    assert.match(uptimeReport(result), new RegExp(`\\(${String(systemSeconds).replace('.', '\\.')} seconds reported\\)`));
    assert.match(uptimeReport(result), new RegExp(`\\(${String(helperSeconds).replace('.', '\\.')} seconds reported\\)`));
  }
});

test('fractional OS seconds observed on the host runtime are retained without rounding the reading', async () => {
  const result = await inspectUptime(() => collectUptime({ readSystem: () => 30450.703, readHelper: () => 0.0963979 }));
  assert.equal(result.status, 'passed'); assert.equal(result.systemSeconds, 30450.703); assert.equal(result.helperSeconds, 0.0963979);
  assert.match(uptimeReport(result), /OS uptime: 0d 08h 27m 30s \(30450\.703 seconds reported\)/);
  assert.match(uptimeReport(result), /0d 00h 00m 00s \(0\.0963979 seconds reported\)/);
});

test('malformed or conflicting evidence fails closed without either partial counter', async () => {
  const invalid = [null, evidence({ version: 2 }), evidence({ kind: 'memory' }), evidence({ status: 'blocked' }), evidence({ status: undefined }),
    evidence({ error: { message: 'Failed provider' } }), evidence({ error: undefined }), evidence({ observedAt: 'invalid' }),
    evidence({ observedAt: '1' }), evidence({ observedAt: 'x'.repeat(41) }), evidence({ system: {} }),
    evidence({ system: { ...evidence().system, release: 'x'.repeat(129) } })];
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, '1', 1n, null, undefined]) invalid.push(evidence({ systemSeconds: value }), evidence({ helperSeconds: value }));
  for (const raw of invalid) {
    const result = await inspectUptime(async () => raw);
    assert.equal(result.status, 'blocked'); assert.equal(result.systemSeconds, undefined); assert.equal(result.helperSeconds, undefined);
    assert.match(uptimeReport(result), /Uptime readings are blocked/);
  }
});

test('reports show separate whole-second durations and original seconds without deriving boot dates', async () => {
  const result = await inspectUptime(async () => evidence()), report = uptimeReport(result);
  assert.match(report, /OS uptime: 2d 03h 04m 05s \(183845 seconds reported\)/);
  assert.match(report, /Current helper process uptime: 0d 00h 01m 01s \(61\.25 seconds reported\)/);
  const fractional = await inspectUptime(async () => evidence({ systemSeconds: 0, helperSeconds: 0.0001 }));
  assert.match(uptimeReport(fractional), /0d 00h 00m 00s \(0\.0001 seconds reported\)/);
  assert.match(report, /whole seconds/); assert.match(report, /read sequentially/); assert.match(report, /precision depends on the API and runtime/);
  assert.match(report, /VM or physical identity unverified/);
  assert.match(report, /do not establish a boot timestamp, reboot history, saved-history persistence, system health or Validation OS\/hardware acceptance/);
  assert.match(report, /restarts neither the OS nor the helper/);
});

test('private fields and caller health, boot or persistence claims cannot enter saved results', async () => {
  const result = await inspectUptime(async () => evidence({ credentials: 'Private fixture metadata', source: 'Private fixture metadata',
    bootTimestamp: 'Private fixture metadata', rebootHistory: ['Private fixture metadata'], historyPersisted: true,
    healthy: true, hardwareAccepted: true, runtimeAccepted: true, system: { ...evidence().system, serial: 'Private fixture metadata' } }));
  assert.equal(result.status, 'passed'); assert.equal(result.source, 'Node os.uptime() and process.uptime()');
  for (const key of ['credentials', 'bootTimestamp', 'rebootHistory', 'historyPersisted', 'healthy', 'hardwareAccepted', 'runtimeAccepted']) assert.equal(result[key], undefined);
  assert.doesNotMatch(JSON.stringify(result) + uptimeReport(result), /Private fixture metadata/);
});

test('missing APIs and null failures produce redacted blocked diagnostics without partial seconds', async () => {
  const result = await inspectUptime(() => collectUptime({ readSystem: () => 1024, readHelper: () => { throw new Error('Helper uptime API unavailable. Bearer fixture-secret'); } }));
  assert.equal(result.status, 'blocked'); assert.equal(result.systemSeconds, undefined); assert.equal(result.helperSeconds, undefined);
  assert.match(uptimeReport(result), /Helper uptime API unavailable/); assert.doesNotMatch(uptimeReport(result), /fixture-secret/);
  assert.equal((await inspectUptime(() => collectUptime({ readHelper: null }))).status, 'blocked');
  for (const failure of [null, undefined, 'Native API unavailable']) {
    const failed = await inspectUptime(async () => { throw failure; });
    assert.equal(failed.status, 'blocked'); assert.match(uptimeReport(failed), /query did not succeed/);
  }
});

test('native read-only collection supplies OS and helper counters without establishing target acceptance', async () => {
  const result = await inspectUptime();
  assert.equal(result.status, 'passed'); assert.equal(result.system.platform, process.platform); assert.equal(result.system.runtimeArchitecture, process.arch);
  assert.ok(Number.isFinite(result.systemSeconds) && result.systemSeconds >= 0 && result.systemSeconds <= Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isFinite(result.helperSeconds) && result.helperSeconds >= 0);
  assert.equal(result.hardwareAccepted, undefined); assert.equal(result.runtimeAccepted, undefined); assert.equal(result.historyPersisted, undefined);
});

test('authorized chat ignores supplied scopes, needs no account and saves output across restart', async () => {
  let calls = 0; const fake = new FakeCodex();
  const options = { port: 0, codex: fake, autostart: false, uptimeCollector: async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); } };
  let app = await createApplication(options);
  try {
    const send = headers => fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'show uptime', hostname: 'remote.example.invalid', pid: 1, bootTimestamp: 'outside-fixture', restart: true }) });
    assert.equal((await send({})).status, 403); assert.equal(calls, 0);
    const page = await fetch(app.origin), html = await page.text(), cookie = page.headers.get('set-cookie').split(';')[0];
    const token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1], headers = { cookie, 'X-Volterra-Client': token };
    assert.equal((await send({ cookie })).status, 403);
    assert.equal((await send({ ...headers, Origin: 'https://untrusted.example' })).status, 403); assert.equal(calls, 0);
    const response = await send(headers), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.tool, 'uptime'); assert.equal(result.status, 'passed');
    assert.equal(calls, 1); assert.deepEqual(fake.calls, []); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('61.25 seconds reported'));
    assert.ok(output); await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('live uptime checking preserves pauses, turns and approval priority and excludes simultaneous tools', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, uptimeCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' }); await app.automation.pause();
    const before = fake.calls.length, request = app.actions['agent/send']({ text: 'show uptime' }), snapshot = app.snapshot();
    assert.equal(snapshot.activeTurn, 'fixture-turn'); assert.equal(snapshot.systemTool.kind, 'uptime'); assert.equal(describeProgress(snapshot).phase, 'checking');
    assert.equal(snapshot.progress.since, snapshot.systemTool.since); assert.equal(describeProgress(snapshot).title, 'Reading OS and helper uptime');
    assert.equal(describeProgress({ ...snapshot, approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress({ ...snapshot, interruptRequested: true }).phase, 'stopping'); assert.equal(describeProgress(snapshot, false).phase, 'disconnected');
    for (const text of ['show services', 'show devices', 'show storage', 'show networking', 'show files', 'show logs', 'show maintenance', 'show processes', 'show DNS', 'show memory', 'show uptime']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn'); assert.equal(app.automation.saved.paused, true);
    assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('blocked uptime diagnostics survive restart and a fresh query can recover without agent work', async () => {
  const options = { port: 0, autostart: false, uptimeCollector: async () => { throw null; } };
  let app = await createApplication({ ...options, codex: new FakeCodex() });
  try {
    const result = await app.actions['agent/send']({ text: 'show system uptime' });
    assert.equal(result.status, 'blocked'); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Uptime readings are blocked.'));
    assert.ok(output); await app.close();
    const fake = new FakeCodex(); app = await createApplication({ ...options, codex: fake, uptimeCollector: async () => evidence() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const before = fake.calls.length, recovered = await app.actions['agent/send']({ text: 'show uptime' });
    assert.equal(recovered.status, 'passed'); assert.equal(fake.calls.length, before); assert.equal(app.snapshot().systemTool, null);
  } finally { await app.close(); }
});

test('production collection uses only local uptime getters without file, process or settings operations', async () => {
  const source = await fs.readFile(new URL('../app/uptime-tools.mjs', import.meta.url), 'utf8');
  assert.match(source, /readSystem = \(\) => os\.uptime\(\)/); assert.match(source, /readHelper = \(\) => process\.uptime\(\)/);
  assert.doesNotMatch(source, /node:child_process|node:fs|fetch\s*\(|process\.kill|os\.setPriority|exec\s*\(/);
  assert.doesNotMatch(source, /Date\.now\(\)\s*-|new Date\([^)]*Seconds/);
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-uptime-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
