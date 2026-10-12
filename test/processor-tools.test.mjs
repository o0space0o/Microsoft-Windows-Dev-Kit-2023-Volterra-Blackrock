import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-processor-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { processorQuery, collectProcessors, inspectProcessors, processorReport } = await import('../app/processor-tools.mjs');
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });
const { describeProgress } = await import('../app/public/progress.js');
const reading = (patch = {}) => ({ model: 'Fixture processor', speed: 2400,
  times: { user: 100, nice: 0, sys: 50, idle: 900, irq: 5 }, ...patch });
const evidence = (patch = {}) => ({ version: 1, kind: 'processors', status: 'passed', error: null,
  observedAt: '2026-10-11T18:00:00.000Z', system: { platform: 'win32', release: 'fixture', runtimeArchitecture: 'arm64' },
  processors: [reading()], ...patch });
const blocked = result => {
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.processors, []);
  assert.equal(result.totalCount, undefined); assert.equal(result.matchedCount, undefined);
  assert.ok(result.error.stage); assert.ok(result.error.message); assert.match(processorReport(result), /inventory is blocked/);
};

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

test('processor intent accepts bounded literal filters and rejects operation or remote arguments', () => {
  for (const message of ['processors', 'show processors', ' SHOW CPUS ', 'list cpus']) assert.deepEqual(processorQuery(message), { filter: '' });
  assert.deepEqual(processorQuery('show processors matching .*; set priority'), { filter: '.*; set priority' });
  for (const message of ['show CPU usage', 'change processors', 'show processors on another host', 'show processors; commands', 'processors\ncommands', '', 1, null]) assert.equal(processorQuery(message), null);
  assert.throws(() => processorQuery('show processors matching ' + 'x'.repeat(257)), /up to 256/);
  assert.throws(() => processorQuery('show processors matching bad\u0000filter'), /up to 256/);
});

test('the collector calls its fixed getter once without arguments and retains the API readings', async () => {
  let calls = 0; const processors = [reading()];
  const raw = await collectProcessors({ readProcessors: (...args) => { calls++; assert.deepEqual(args, []); return processors; } });
  assert.equal(calls, 1); assert.equal(raw.status, 'passed'); assert.equal(raw.error, null); assert.equal(raw.kind, 'processors');
  assert.deepEqual(raw.processors, processors); assert.ok(Number.isFinite(Date.parse(raw.observedAt)));
  assert.equal(raw.system.platform, process.platform); assert.equal(raw.system.runtimeArchitecture, process.arch);
  await assert.rejects(collectProcessors({ readProcessors: null }), /API is required/);
});

test('getter failures, missing APIs and null failures produce redacted blocked diagnostics', async () => {
  for (const collect of [() => collectProcessors({ readProcessors: null }),
    () => collectProcessors({ readProcessors: () => { throw new Error('Processor API unavailable. Bearer fixture-secret'); } }),
    async () => { throw null; }, async () => { throw undefined; }, async () => null]) {
    const result = await inspectProcessors('', collect); blocked(result);
    assert.doesNotMatch(processorReport(result), /fixture-secret/);
  }
});

test('empty and missing rows are unavailable evidence before filtering or counting', async () => {
  for (const processors of [[], new Array(1), [undefined], [null], [reading(), , reading()]]) {
    blocked(await inspectProcessors('no-match', async () => evidence({ processors })));
  }
  blocked(await inspectProcessors('', async () => evidence({ processors: undefined })));
  blocked(await inspectProcessors('', async () => evidence({ processors: new Array(4097) })));
});

test('counter precision and zero readings survive without totals or utilization estimates', async () => {
  const times = { user: Number.MAX_SAFE_INTEGER, nice: 0, sys: 0, idle: 0, irq: 0 };
  const result = await inspectProcessors('', async () => evidence({ processors: [reading({ model: '', speed: 0, times })] }));
  assert.equal(result.status, 'passed'); assert.equal(result.processors[0].speedMHz, 0);
  assert.deepEqual(result.processors[0].timesMilliseconds, { user: '9007199254740991', nice: '0', sys: '0', idle: '0', irq: '0' });
  assert.equal(result.processors[0].utilization, undefined); assert.equal(result.processors[0].totalMilliseconds, undefined);
  const report = processorReport(result);
  assert.match(report, /No model reported/); assert.match(report, /0 MHz/); assert.match(report, /9007199254740991 ms/);
  assert.match(report, /not a sampled utilization percentage/); assert.match(report, /not added together/);
});

test('every counter must be complete and safe even in an unmatched row', async () => {
  const unsupported = [undefined, null, false, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0n];
  for (const mode of ['user', 'nice', 'sys', 'idle', 'irq']) for (const value of unsupported) {
    blocked(await inspectProcessors('matching model', async () => evidence({ processors: [reading({ model: 'Matching model' }),
      reading({ times: { ...reading().times, [mode]: value } })] })));
  }
  for (const times of [null, undefined, {}, []]) blocked(await inspectProcessors('', async () => evidence({ processors: [reading({ times })] })));
});

test('reported speeds preserve finite fractional MHz but unsupported numbers are blocked', async () => {
  const fraction = await inspectProcessors('', async () => evidence({ processors: [reading({ speed: 2400.5 })] }));
  assert.equal(fraction.status, 'passed'); assert.equal(fraction.processors[0].speedMHz, 2400.5);
  for (const speed of [undefined, null, '2400', false, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    blocked(await inspectProcessors('', async () => evidence({ processors: [reading({ speed })] })));
  }
});

test('literal model or reading-index filters retain the original API positions', async () => {
  const collect = async () => evidence({ processors: [reading({ model: 'Efficiency.*' }), reading({ model: 'Performance' })] });
  const result = await inspectProcessors('.*', collect);
  assert.equal(result.totalCount, 2); assert.equal(result.matchedCount, 1); assert.equal(result.processors[0].index, 0);
  const second = await inspectProcessors('logical processor 1', collect);
  assert.equal(second.processors[0].index, 1); assert.equal(second.matchedCount, 1);
  const unmatched = await inspectProcessors('[01]', collect);
  assert.equal(unmatched.status, 'passed'); assert.equal(unmatched.totalCount, 2); assert.deepEqual(unmatched.processors, []);
  assert.match(processorReport(unmatched), /No logical processors matched/);
});

test('models and envelope metadata must be complete, bounded and timestamped', async () => {
  for (const raw of [evidence({ version: 2 }), evidence({ kind: 'devices' }), evidence({ observedAt: 'invalid' }),
    evidence({ observedAt: '2026-10-11' }), evidence({ system: {} }),
    evidence({ system: { ...evidence().system, release: 'x'.repeat(129) } })]) blocked(await inspectProcessors('', async () => raw));
  for (const model of [undefined, null, 1, {}, 'x'.repeat(513), 'bad\nmodel']) {
    blocked(await inspectProcessors('no-match', async () => evidence({ processors: [reading({ model })] })));
  }
  for (const filter of [null, {}, 1, 'x'.repeat(257), 'bad\nfilter']) await assert.rejects(inspectProcessors(filter, async () => evidence()), /up to 256/);
});

test('conflicting success and failure evidence is rejected before reading processor rows', async () => {
  for (const patch of [{ status: undefined }, { status: 'unknown' }, { error: undefined }, { error: false },
    { error: { stage: 'Inventory', message: 'Failed' } }]) {
    const row = reading(); Object.defineProperty(row, 'model', { get() { throw new Error('Processor row was accessed'); } });
    const result = await inspectProcessors('', async () => evidence({ ...patch, processors: [row] }));
    blocked(result); assert.doesNotMatch(processorReport(result), /row was accessed/);
  }
});

test('provider failures require empty readings and a concrete redacted diagnostic', async () => {
  const failed = evidence({ status: 'blocked', processors: [], error: { stage: 'Processor provider', message: 'Access denied. Bearer fixture-secret' } });
  const result = await inspectProcessors('', async () => failed); blocked(result);
  assert.match(processorReport(result), /Processor provider: Access denied/); assert.doesNotMatch(processorReport(result), /fixture-secret/);
  for (const patch of [{ processors: [reading()] }, { processors: new Array(1) }, { error: null },
    { error: { stage: '', message: 'Failed' } }, { error: { stage: 'Inventory', message: ' ' } }]) {
    blocked(await inspectProcessors('', async () => ({ ...failed, ...patch })));
  }
});

test('reports retain only whitelisted readings and do not claim CPU or NPU acceptance', async () => {
  const raw = evidence({ hardwareAccepted: true, runtimeAccepted: true,
    processors: [reading({ index: 99, model: 'Bearer fixture-secret', serial: 'private-serial', path: 'private-path', health: 'Passed' })] });
  const result = await inspectProcessors('', async () => raw), report = processorReport(result);
  assert.equal(result.status, 'passed'); assert.equal(result.processors[0].index, 0);
  assert.equal(result.hardwareAccepted, undefined); assert.equal(result.runtimeAccepted, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|private-serial|private-path/);
  assert.match(report, /not stable hardware IDs/); assert.match(report, /not a measured current frequency/);
  assert.match(report, /does not establish application parallelism/); assert.match(report, /changes no settings/);
});

test('authorized chat ignores supplied host and operation fields, requires no account and saves output', async () => {
  let calls = 0; const fake = new FakeCodex();
  const options = { port: 0, autostart: false, processorCollector: async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); } };
  let app = await createApplication({ ...options, codex: fake });
  try {
    const send = headers => fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'show processors matching Fixture', hostname: 'remote.example.invalid', setPriority: true, cpuAffinity: 0 }) });
    assert.equal((await send({})).status, 403); assert.equal(calls, 0);
    const page = await fetch(app.origin), html = await page.text(), cookie = page.headers.get('set-cookie').split(';')[0];
    const token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1], headers = { cookie, 'X-Volterra-Client': token };
    assert.equal((await send({ cookie })).status, 403);
    assert.equal((await send({ ...headers, Origin: 'https://untrusted.example' })).status, 403); assert.equal(calls, 0);
    const response = await send(headers), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.tool, 'processors'); assert.equal(result.status, 'passed');
    assert.equal(result.matchedCount, 1); assert.equal(calls, 1); assert.deepEqual(fake.calls, []);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('2400 MHz'));
    assert.ok(output); assert.equal(app.snapshot().systemTool, null);
    await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('checking preserves active turns, pauses and approvals and excludes simultaneous inventories', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, processorCollector: () => collecting }); let request;
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' }); await app.automation.pause();
    const before = fake.calls.length; request = app.actions['agent/send']({ text: 'show processors' });
    const snapshot = app.snapshot(); assert.equal(snapshot.systemTool.kind, 'processors');
    assert.equal(describeProgress(snapshot).phase, 'checking'); assert.equal(snapshot.progress.since, snapshot.systemTool.since);
    assert.equal(describeProgress({ ...snapshot, approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress({ ...snapshot, interruptRequested: true }).phase, 'stopping');
    assert.equal(describeProgress(snapshot, false).phase, 'disconnected');
    for (const text of ['show processors', 'show drives', 'show memory', 'show services']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await request; await app.close(); }
});

test('blocked reports survive chat restart and a later zero reading recovers without resuming the queue', async () => {
  let app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false, processorCollector: async () => { throw null; } });
  try {
    await app.automation.pause(); const result = await app.actions['agent/send']({ text: 'show processors' }); blocked(result);
    const output = app.snapshot().journal.findLast(entry => entry.type === 'output' && entry.data.delta?.includes('processor query did not succeed'));
    assert.ok(output); assert.equal(app.snapshot().systemTool, null);
    await app.close(); const fake = new FakeCodex();
    app = await createApplication({ port: 0, codex: fake, autostart: false, processorCollector: async () => evidence({ processors: [reading({ speed: 0 })] }) });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const previousCalls = [...fake.calls];
    const recovered = await app.actions['agent/send']({ text: 'show CPUs' });
    assert.equal(recovered.status, 'passed'); assert.equal(recovered.processors[0].speedMHz, 0);
    assert.equal(app.automation.saved.paused, true); assert.deepEqual(fake.calls, previousCalls); assert.equal(app.snapshot().systemTool, null);
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(path.isAbsolute(directory) && relative.startsWith('volterra-processor-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
