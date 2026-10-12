import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-memory-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { memoryQuery, collectMemory, inspectMemory, memoryReport } = await import('../app/memory-tools.mjs');
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });
const { describeProgress } = await import('../app/public/progress.js');
const evidence = (patch = {}) => ({ version: 1, kind: 'memory', status: 'passed', error: null, observedAt: '2026-10-11T18:00:00.000Z',
  system: { platform: 'win32', release: 'fixture', runtimeArchitecture: 'arm64' }, totalBytes: '17179869184', freeBytes: '4294967296', ...patch });

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

test('memory chat intent accepts only fixed local readings without paths or operation arguments', () => {
  for (const message of ['memory', 'show memory', ' SHOW SYSTEM MEMORY ', 'system memory']) assert.deepEqual(memoryQuery(message), {});
  for (const message of ['free memory', 'clear memory', 'show memory from another host', 'show memory matching x', 'show memory; change settings', 'memory\ncommands', null]) assert.equal(memoryQuery(message), null);
});

test('the collector invokes both getters once without arguments and preserves byte counts', async () => {
  const calls = [];
  const result = await collectMemory({
    readTotal: (...args) => { calls.push('total'); assert.deepEqual(args, []); return 17179869184; },
    readFree: (...args) => { calls.push('free'); assert.deepEqual(args, []); return 4294967296; }
  });
  assert.deepEqual(calls, ['total', 'free']); assert.equal(result.version, 1); assert.equal(result.kind, 'memory');
  assert.equal(result.status, 'passed'); assert.equal(result.error, null);
  assert.equal(result.totalBytes, '17179869184'); assert.equal(result.freeBytes, '4294967296');
  assert.ok(Number.isFinite(Date.parse(result.observedAt))); assert.equal(result.nonFreeBytes, undefined);
});

test('missing getters and unsafe native numbers are rejected rather than rounded into readings', async () => {
  let reads = 0;
  await assert.rejects(collectMemory({ readTotal: () => { reads++; return 1; }, readFree: null }), /APIs are required/);
  await assert.rejects(collectMemory({ readTotal: null, readFree: () => { reads++; return 0; } }), /APIs are required/);
  assert.equal(reads, 0);
  for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1024', 1024n, null, undefined]) {
    await assert.rejects(collectMemory({ readTotal: () => value, readFree: () => 0 }), /unsupported byte counts/);
    await assert.rejects(collectMemory({ readTotal: () => 1024, readFree: () => value }), /unsupported byte counts/);
  }
});

test('arithmetic remains exact at the native safe-integer boundary and zero free memory is a reading', async () => {
  const result = await inspectMemory(async () => evidence({ totalBytes: String(Number.MAX_SAFE_INTEGER), freeBytes: '1' }));
  assert.equal(result.status, 'passed'); assert.equal(result.nonFreeBytes, '9007199254740990');
  assert.match(memoryReport(result), /9007199254740991 bytes/); assert.match(memoryReport(result), /9007199254740990 bytes/);
  for (const freeBytes of ['0', evidence().totalBytes]) {
    const reading = await inspectMemory(async () => evidence({ freeBytes }));
    assert.equal(reading.status, 'passed'); assert.equal(reading.freeBytes, freeBytes);
    assert.equal(BigInt(reading.nonFreeBytes) + BigInt(reading.freeBytes), BigInt(reading.totalBytes));
  }
});

test('malformed and inconsistent evidence fails closed with no partial capacity', async () => {
  const invalid = [null, evidence({ version: 2 }), evidence({ kind: 'storage' }), evidence({ observedAt: 'invalid' }),
    evidence({ observedAt: 'x'.repeat(41) }), evidence({ system: {} }), evidence({ system: { ...evidence().system, release: 'x'.repeat(129) } }),
    evidence({ totalBytes: '0' }), evidence({ totalBytes: '9007199254740992' }), evidence({ freeBytes: '17179869185' })];
  for (const value of [0, -1, '', '01', '-1', '1.0', '1e3', '0x10', ' 1', '1\n', '1'.repeat(17), null, undefined]) {
    invalid.push(evidence({ totalBytes: value }), evidence({ freeBytes: value }));
  }
  for (const raw of invalid) {
    const result = await inspectMemory(async () => raw);
    assert.equal(result.status, 'blocked'); assert.equal(result.totalBytes, undefined); assert.equal(result.freeBytes, undefined);
    assert.equal(result.nonFreeBytes, undefined); assert.match(memoryReport(result), /blocked/);
  }
});

test('memory success requires consistent failure metadata before byte readings are examined', async () => {
  const error = { stage: 'Free memory query', message: 'API access denied.' };
  for (const patch of [{ status: undefined }, { status: 'unknown' }, { error: undefined }, { error: false }, { error }]) {
    const raw = evidence(patch);
    Object.defineProperty(raw, 'totalBytes', { get() { throw new Error('Byte reading was accessed.'); } });
    const result = await inspectMemory(async () => raw);
    assert.equal(result.status, 'blocked'); assert.equal(result.totalBytes, undefined); assert.equal(result.freeBytes, undefined);
    assert.equal(result.nonFreeBytes, undefined); assert.doesNotMatch(memoryReport(result), /Byte reading was accessed/);
  }
  const failedZero = await inspectMemory(async () => evidence({ status: 'blocked', error, freeBytes: '0' }));
  assert.equal(failedZero.status, 'blocked'); assert.equal(failedZero.freeBytes, undefined); assert.equal(failedZero.nonFreeBytes, undefined);
  assert.doesNotMatch(memoryReport(failedZero), /Reported free memory/);
});

test('memory provider failures retain redacted diagnostics and reject placeholders or partial byte counts', async () => {
  const failed = evidence({ status: 'blocked', totalBytes: null, freeBytes: null,
    error: { stage: 'Free memory query', message: 'API access denied. Bearer fixture-secret ' + 'x'.repeat(1024) } });
  const result = await inspectMemory(async () => failed);
  assert.equal(result.status, 'blocked'); assert.equal(result.observedAt, failed.observedAt); assert.equal(result.error.stage, 'Free memory query');
  assert.equal(result.totalBytes, undefined); assert.equal(result.freeBytes, undefined); assert.equal(result.nonFreeBytes, undefined);
  assert.match(memoryReport(result), /API access denied/); assert.doesNotMatch(memoryReport(result), /fixture-secret/);
  assert.ok(result.error.message.length <= 512);
  for (const patch of [{ totalBytes: '1024' }, { freeBytes: '0' }, { totalBytes: 0 }, { totalBytes: undefined }, { freeBytes: undefined },
    { error: null }, { error: {} }, { error: { stage: '', message: 'Denied.' } }, { error: { stage: '   ', message: 'Denied.' } },
    { error: { stage: 'Memory query', message: '' } }, { error: { stage: 'Memory query', message: '   ' } }]) {
    const ambiguous = await inspectMemory(async () => ({ ...failed, ...patch }));
    assert.equal(ambiguous.status, 'blocked'); assert.equal(ambiguous.totalBytes, undefined); assert.equal(ambiguous.freeBytes, undefined);
    assert.equal(ambiguous.nonFreeBytes, undefined); assert.match(ambiguous.error.message, /ambiguous failure evidence/);
  }
});

test('null memory collector failures retain usable diagnostics without invented capacity', async () => {
  for (const collect of [async () => null, async () => { throw null; }, async () => { throw undefined; }]) {
    const result = await inspectMemory(collect);
    assert.equal(result.status, 'blocked'); assert.equal(result.totalBytes, undefined); assert.equal(result.freeBytes, undefined);
    assert.equal(result.nonFreeBytes, undefined); assert.equal(result.error.stage, 'System memory readings'); assert.ok(result.error.message);
    assert.match(memoryReport(result), /System memory readings are blocked/);
  }
});

test('reports keep rounded labels alongside exact bytes and distinguish memory scope from health', async () => {
  const result = await inspectMemory(async () => evidence());
  const report = memoryReport(result);
  assert.match(report, /16\.00 GiB \(17179869184 bytes\)/); assert.match(report, /4\.00 GiB \(4294967296 bytes\)/);
  assert.match(report, /12\.00 GiB \(12884901888 bytes\)/); assert.match(report, /not application working-set or committed memory/);
  assert.match(report, /VM or physical identity unverified/); assert.match(report, /not an atomic snapshot/);
  assert.match(report, /system-health\/Validation OS acceptance/); assert.match(report, /stops no process/);
  for (const key of ['healthy', 'pressure', 'hardwareAccepted', 'runtimeAccepted', 'recoveryAccepted']) assert.equal(result[key], undefined);
});

test('extra private fields and caller acceptance claims do not enter results or saved reports', async () => {
  const result = await inspectMemory(async () => evidence({ credentials: 'Private fixture metadata', source: 'Private fixture metadata',
    healthy: true, runtimeAccepted: true, nonFreeBytes: '0', processes: ['Private fixture metadata'],
    system: { ...evidence().system, serial: 'Private fixture metadata' } }));
  assert.equal(result.status, 'passed'); assert.equal(result.nonFreeBytes, '12884901888');
  assert.equal(result.source, 'Node os.totalmem() and os.freemem()'); assert.equal(result.healthy, undefined); assert.equal(result.runtimeAccepted, undefined);
  assert.doesNotMatch(JSON.stringify(result) + memoryReport(result), /Private fixture metadata/);
});

test('failed and missing APIs preserve redacted blocked diagnostics without invented counts', async () => {
  const result = await inspectMemory(() => collectMemory({ readTotal: () => 1024, readFree: () => { throw new Error('Memory API unavailable. Bearer fixture-secret'); } }));
  assert.equal(result.status, 'blocked'); assert.equal(result.totalBytes, undefined);
  assert.match(memoryReport(result), /Memory API unavailable/); assert.doesNotMatch(memoryReport(result), /fixture-secret/);
  const absent = await inspectMemory(() => collectMemory({ readFree: null })); assert.equal(absent.status, 'blocked');
  assert.equal((await inspectMemory(async () => { throw null; })).status, 'blocked');
});

test('native read-only collection returns system counts without establishing target acceptance', async () => {
  const result = await inspectMemory();
  assert.equal(result.status, 'passed'); assert.equal(result.system.platform, process.platform);
  assert.equal(result.system.runtimeArchitecture, process.arch); assert.ok(BigInt(result.totalBytes) > 0n);
  assert.equal(BigInt(result.nonFreeBytes) + BigInt(result.freeBytes), BigInt(result.totalBytes));
  assert.equal(result.hardwareAccepted, undefined); assert.equal(result.runtimeAccepted, undefined);
});

test('authorized chat ignores supplied scope fields, needs no account and saves output across restart', async () => {
  let calls = 0; const fake = new FakeCodex();
  const options = { port: 0, codex: fake, autostart: false, memoryCollector: async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); } };
  let app = await createApplication(options);
  try {
    const send = headers => fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'show memory', hostname: 'remote.example.invalid', pid: 1, path: 'outside-fixture', free: true }) });
    assert.equal((await send({})).status, 403); assert.equal(calls, 0);
    const page = await fetch(app.origin), html = await page.text(), cookie = page.headers.get('set-cookie').split(';')[0];
    const token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1], headers = { cookie, 'X-Volterra-Client': token };
    assert.equal((await send({ cookie })).status, 403);
    assert.equal((await send({ ...headers, Origin: 'https://untrusted.example' })).status, 403); assert.equal(calls, 0);
    const response = await send(headers), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.tool, 'memory'); assert.equal(result.status, 'passed');
    assert.equal(calls, 1); assert.deepEqual(fake.calls, []); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('17179869184 bytes'));
    assert.ok(output); await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('live memory checking preserves pauses, turns and approval precedence and excludes simultaneous tools', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, memoryCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' }); await app.automation.pause();
    const before = fake.calls.length, request = app.actions['agent/send']({ text: 'show memory' }), snapshot = app.snapshot();
    assert.equal(snapshot.activeTurn, 'fixture-turn'); assert.equal(snapshot.systemTool.kind, 'memory'); assert.equal(describeProgress(snapshot).phase, 'checking');
    assert.equal(snapshot.progress.since, snapshot.systemTool.since); assert.equal(describeProgress(snapshot).title, 'Reading system memory');
    assert.equal(describeProgress({ ...snapshot, approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress({ ...snapshot, interruptRequested: true }).phase, 'stopping'); assert.equal(describeProgress(snapshot, false).phase, 'disconnected');
    for (const text of ['show services', 'show devices', 'show storage', 'show networking', 'show files', 'show logs', 'show maintenance', 'show processes', 'show DNS', 'show memory']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn'); assert.equal(app.automation.saved.paused, true);
    assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('a blocked memory reading is saved and clears transient checking', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false,
    memoryCollector: async () => { throw new Error('Node system memory APIs unavailable.'); } });
  try {
    const result = await app.actions['agent/send']({ text: 'show system memory' });
    assert.equal(result.status, 'blocked'); assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'output' && entry.data.delta?.includes('System memory readings are blocked.')));
  } finally { await app.close(); }
});

test('memory provider diagnostics survive chat restart and a successful zero-free reading can recover', async () => {
  const fake = new FakeCodex();
  let app = await createApplication({ port: 0, codex: fake, autostart: false,
    memoryCollector: async () => evidence({ status: 'blocked', totalBytes: null, freeBytes: null,
      error: { stage: 'Free memory query', message: 'API access denied.' } }) });
  try {
    const before = fake.calls.length, wasPaused = app.automation.saved.paused;
    const result = await app.actions['agent/send']({ text: 'show memory' });
    assert.equal(result.status, 'blocked'); assert.equal(result.totalBytes, undefined); assert.equal(result.freeBytes, undefined);
    assert.equal(app.snapshot().systemTool, null); assert.equal(fake.calls.length, before); assert.equal(app.automation.saved.paused, wasPaused);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Free memory query: API access denied.'));
    assert.ok(output); assert.match(output.data.delta, /System memory readings are blocked/);
    await app.close();
    const restored = new FakeCodex();
    app = await createApplication({ port: 0, codex: restored, autostart: false, memoryCollector: async () => evidence({ freeBytes: '0' }) });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const resumedCalls = restored.calls.length, recovered = await app.actions['agent/send']({ text: 'show system memory' });
    assert.equal(recovered.status, 'passed'); assert.equal(recovered.freeBytes, '0'); assert.equal(recovered.nonFreeBytes, recovered.totalBytes);
    assert.match(memoryReport(recovered), /Reported free memory: 0\.00 GiB \(0 bytes\)/);
    assert.equal(app.snapshot().systemTool, null); assert.equal(restored.calls.length, resumedCalls); assert.equal(app.automation.saved.paused, wasPaused);
  } finally { await app.close(); }
});

test('production collection uses only OS memory getters without process, file or settings operations', async () => {
  const source = await fs.readFile(new URL('../app/memory-tools.mjs', import.meta.url), 'utf8');
  assert.match(source, /readTotal = \(\) => os\.totalmem\(\)/); assert.match(source, /readFree = \(\) => os\.freemem\(\)/);
  assert.doesNotMatch(source, /node:child_process|node:fs|fetch\s*\(|process\.(?:kill|memoryUsage)|os\.setPriority|exec\s*\(/);
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-memory-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
