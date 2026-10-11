import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-storage-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
const { storageQuery, collectStorage, inspectStorage, storageReport } = await import('../app/storage-tools.mjs');
const { createApplication } = await import('../app/server.mjs');
const { describeProgress } = await import('../app/public/progress.js');
const evidence = (workspace = directory, patch = {}) => ({ version: 1, kind: 'storage', status: 'passed', error: null, requestedWorkspace: workspace, workspace,
  observedAt: '2026-10-11T17:33:00.000Z', system: { platform: 'win32', release: 'fixture', runtimeArchitecture: 'arm64' },
  blocks: { size: '4096', total: '100', free: '30', available: '20' }, ...patch });

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

test('storage chat intent accepts only a fixed read without paths or operation arguments', () => {
  for (const message of ['storage', 'show storage', ' LIST STORAGE ']) assert.deepEqual(storageQuery(message), {});
  for (const message of ['format storage', 'show storage in A:', 'show storage; change settings', 'storage\ncommands', null]) assert.equal(storageQuery(message), null);
});

test('the collector reads a canonical directory using BigInt statistics and rejects an identity change', async () => {
  const canonical = path.join(directory, 'canonical'); const calls = [];
  const filesystem = {
    realpath: async requested => { calls.push(['realpath', requested]); return canonical; },
    stat: async (requested, options) => { calls.push(['stat', requested, options]); return { isDirectory: () => true, dev: 1n, ino: 2n }; },
    statfs: async (requested, options) => { calls.push(['statfs', requested, options]); return { bsize: 4096n, blocks: 100n, bfree: 30n, bavail: 20n }; }
  };
  const result = await collectStorage(directory, { filesystem });
  assert.equal(result.status, 'passed'); assert.equal(result.error, null);
  assert.equal(result.requestedWorkspace, directory); assert.equal(result.workspace, canonical);
  assert.deepEqual(result.blocks, evidence().blocks); assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  assert.deepEqual(calls.map(call => call[0]), ['realpath', 'stat', 'statfs', 'stat', 'realpath']);
  for (const call of calls.filter(call => call[0] !== 'realpath')) { assert.equal(call[1], canonical); assert.deepEqual(call[2], { bigint: true }); }
  let reads = 0;
  await assert.rejects(collectStorage(directory, { filesystem: { ...filesystem, realpath: async () => ++reads === 1 ? canonical : directory } }), /workspace changed/);
  let stats = 0;
  await assert.rejects(collectStorage(directory, { filesystem: { ...filesystem, stat: async () => ({ isDirectory: () => true, dev: 1n, ino: BigInt(++stats) }) } }), /workspace changed/);
  await assert.rejects(collectStorage(directory, { filesystem: { ...filesystem, stat: async () => ({ isDirectory: () => false }) } }), /not a directory/);
  await assert.rejects(collectStorage(directory, { filesystem: { ...filesystem, statfs: async () => ({ bsize: 4096, blocks: 100n, bfree: 30n, bavail: 20n }) } }), /unsupported capacity/);
});

test('capacity arithmetic is exact beyond Number precision and keeps available, free and used capacity distinct', async () => {
  const totalBlocks = 9007199254740993n;
  const result = await inspectStorage(directory, async workspace => evidence(workspace, { blocks: { size: '4096', total: String(totalBlocks), free: '30', available: '20' } }));
  assert.equal(result.status, 'passed'); assert.equal(result.totalBytes, String(totalBlocks * 4096n));
  assert.equal(result.usedBytes, String((totalBlocks - 30n) * 4096n));
  assert.equal(result.freeBytes, '122880'); assert.equal(result.availableBytes, '81920');
  const report = storageReport(result);
  assert.match(report, new RegExp(result.totalBytes + ' bytes')); assert.match(report, /VM or physical identity unverified/);
  assert.match(report, /Physical disk, partition and recovery verification remain pending/);
  assert.equal(result.hardwareAccepted, undefined); assert.equal(result.recoveryAccepted, undefined);
  const full = await inspectStorage(directory, async workspace => evidence(workspace, { blocks: { size: '4096', total: '100', free: '0', available: '0' } }));
  assert.equal(full.status, 'passed'); assert.equal(full.freeBytes, '0'); assert.equal(full.availableBytes, '0');
  assert.match(storageReport(full), /Available capacity: 0\.00 GiB \(0 bytes\)/);
});

test('missing, malformed, inconsistent and mismatched workspace evidence becomes blocked without invented capacity', async () => {
  for (const raw of [null, evidence(directory, { version: 2 }), evidence(directory, { kind: 'devices' }), evidence(directory, { requestedWorkspace: path.dirname(directory) }),
    evidence(directory, { workspace: 'relative' }), evidence(directory, { observedAt: 'invalid' }), evidence(directory, { observedAt: 'x'.repeat(41) }),
    evidence(directory, { system: { ...evidence().system, release: 'x'.repeat(129) } }),
    ...[{ size: '0', total: '100', free: '30', available: '20' }, { size: '4096', total: '0', free: '0', available: '0' },
      { size: '4096', total: '100', free: '101', available: '20' }, { size: '4096', total: '100', free: '30', available: '31' },
      { size: '4096', total: '100', free: '-1', available: '0' }, { size: '4096', total: '100', free: 30, available: '20' },
      { size: '4096', total: '18446744073709551616', free: '30', available: '20' }, { size: '4096', total: '100', free: '30' }].map(blocks => evidence(directory, { blocks }))]) {
    const result = await inspectStorage(directory, async () => raw);
    assert.equal(result.status, 'blocked'); assert.equal(result.totalBytes, undefined); assert.match(storageReport(result), /blocked/);
  }
  assert.equal((await inspectStorage('relative')).status, 'blocked');
  const denied = await inspectStorage(directory, async () => { throw new Error('Filesystem API unavailable. Bearer fixture-secret'); });
  assert.match(denied.error.message, /unavailable/); assert.doesNotMatch(denied.error.message, /fixture-secret/);
  assert.equal((await inspectStorage(directory, async () => { throw null; })).status, 'blocked');
});

test('storage success requires consistent failure metadata before block readings are examined', async () => {
  const error = { stage: 'Filesystem capacity query', message: 'API access denied.' };
  for (const patch of [{ status: undefined }, { status: 'unknown' }, { error: undefined }, { error: false }, { error }]) {
    const raw = evidence(directory, patch);
    Object.defineProperty(raw, 'blocks', { get() { throw new Error('Block readings were accessed.'); } });
    const result = await inspectStorage(directory, async () => raw);
    assert.equal(result.status, 'blocked');
    for (const key of ['totalBytes', 'usedBytes', 'freeBytes', 'availableBytes']) assert.equal(result[key], undefined);
    assert.doesNotMatch(storageReport(result), /Block readings were accessed/);
  }
  const failedFull = await inspectStorage(directory, async () => evidence(directory, { status: 'blocked', error,
    blocks: { size: '4096', total: '100', free: '0', available: '0' } }));
  assert.equal(failedFull.status, 'blocked'); assert.equal(failedFull.freeBytes, undefined); assert.equal(failedFull.availableBytes, undefined);
  assert.doesNotMatch(storageReport(failedFull), /Free capacity|Available capacity/);
});

test('storage provider failures retain redacted diagnostics and reject placeholders or partial block counts', async () => {
  const failed = evidence(directory, { status: 'blocked', blocks: null,
    error: { stage: 'Filesystem capacity query', message: 'API access denied. Bearer fixture-secret ' + 'x'.repeat(1024) } });
  const result = await inspectStorage(directory, async () => failed);
  assert.equal(result.status, 'blocked'); assert.equal(result.observedAt, failed.observedAt); assert.equal(result.error.stage, 'Filesystem capacity query');
  for (const key of ['totalBytes', 'usedBytes', 'freeBytes', 'availableBytes']) assert.equal(result[key], undefined);
  assert.match(storageReport(result), /API access denied/); assert.doesNotMatch(storageReport(result), /fixture-secret/);
  assert.ok(result.error.message.length <= 512);
  for (const patch of [{ blocks: undefined }, { blocks: {} }, { blocks: { free: '0' } }, { blocks: evidence().blocks },
    { error: null }, { error: {} }, { error: { stage: '', message: 'Denied.' } }, { error: { stage: '   ', message: 'Denied.' } },
    { error: { stage: 'Capacity query', message: '' } }, { error: { stage: 'Capacity query', message: '   ' } }]) {
    const ambiguous = await inspectStorage(directory, async () => ({ ...failed, ...patch }));
    assert.equal(ambiguous.status, 'blocked');
    for (const key of ['totalBytes', 'usedBytes', 'freeBytes', 'availableBytes']) assert.equal(ambiguous[key], undefined);
    assert.match(ambiguous.error.message, /ambiguous failure evidence/);
  }
});

test('null storage collector failures retain usable diagnostics without invented capacity', async () => {
  for (const collect of [async () => null, async () => { throw null; }, async () => { throw undefined; }]) {
    const result = await inspectStorage(directory, collect);
    assert.equal(result.status, 'blocked');
    for (const key of ['totalBytes', 'usedBytes', 'freeBytes', 'availableBytes']) assert.equal(result[key], undefined);
    assert.equal(result.error.stage, 'Workspace storage capacity'); assert.ok(result.error.message);
    assert.match(storageReport(result), /Storage capacity is blocked/);
  }
});

test('a real read-only collection reports this test directory filesystem without changing its files', async () => {
  const marker = path.join(directory, 'capacity-marker.txt'); await fs.writeFile(marker, 'Original test fixture');
  const before = await fs.readdir(directory);
  const result = await inspectStorage(directory);
  assert.equal(result.status, 'passed'); assert.equal(result.workspace, await fs.realpath(directory));
  assert.ok(BigInt(result.totalBytes) > 0n); assert.ok(BigInt(result.availableBytes) <= BigInt(result.freeBytes));
  assert.equal(BigInt(result.usedBytes) + BigInt(result.freeBytes), BigInt(result.totalBytes));
  assert.deepEqual(await fs.readdir(directory), before); assert.equal(await fs.readFile(marker, 'utf8'), 'Original test fixture');
});

test('authorized chat uses its automatic workspace, ignores supplied path fields and retains output across restart', async () => {
  const fake = new FakeCodex(); let collected;
  let app = await createApplication({ port: 0, codex: fake, autostart: false, storageCollector: async workspace => { collected = workspace; return evidence(workspace); } });
  try {
    const unauthorized = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'show storage' }) });
    assert.equal(unauthorized.status, 403); assert.equal(collected, undefined);
    const entry = await fetch(app.origin), html = await entry.text();
    const cookie = entry.headers.get('set-cookie').split(';')[0], token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1];
    const headers = { cookie, 'Content-Type': 'application/json', 'X-Volterra-Client': token };
    const crossOrigin = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ text: 'show storage' }) });
    assert.equal(crossOrigin.status, 403); assert.equal(collected, undefined);
    const response = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers, body: JSON.stringify({ text: 'show storage', path: path.dirname(directory) }) });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.tool, 'storage'); assert.equal(result.status, 'passed'); assert.equal(collected, app.snapshot().project.path);
    assert.equal(result.workspace, collected); assert.equal(fake.calls.length, 0); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Live storage capacity'));
    assert.ok(output); await app.close();
    app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('storage checking is live and mutually exclusive without steering an active turn or resuming a saved pause', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, storageCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Continue the project work' });
    await app.automation.pause(); const before = fake.calls.length;
    const request = app.actions['agent/send']({ text: 'show storage' });
    const snapshot = app.snapshot();
    assert.equal(snapshot.systemTool.kind, 'storage'); assert.equal(snapshot.progress.since, snapshot.systemTool.since);
    assert.equal(describeProgress(snapshot).phase, 'checking'); assert.equal(describeProgress(snapshot).title, 'Reading workspace storage');
    for (const text of ['show storage', 'show services', 'show devices']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence(snapshot.project.path)); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('unavailable filesystem capacity is saved as blocked and clears transient checking', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false,
    storageCollector: async () => { throw new Error('Filesystem capacity API unavailable.'); } });
  try {
    const result = await app.actions['agent/send']({ text: 'show storage' });
    assert.equal(result.status, 'blocked'); assert.equal(result.totalBytes, undefined); assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'output' && entry.data.delta?.includes('Storage capacity is blocked.')));
  } finally { await app.close(); }
});

test('storage provider diagnostics survive chat restart and a successful full filesystem reading can recover', async () => {
  const fake = new FakeCodex();
  let app = await createApplication({ port: 0, codex: fake, autostart: false,
    storageCollector: async workspace => evidence(workspace, { status: 'blocked', blocks: null,
      error: { stage: 'Filesystem capacity query', message: 'API access denied.' } }) });
  try {
    const before = fake.calls.length, wasPaused = app.automation.saved.paused;
    const result = await app.actions['agent/send']({ text: 'show storage' });
    assert.equal(result.status, 'blocked'); assert.equal(result.totalBytes, undefined); assert.equal(result.availableBytes, undefined);
    assert.equal(app.snapshot().systemTool, null); assert.equal(fake.calls.length, before); assert.equal(app.automation.saved.paused, wasPaused);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Filesystem capacity query: API access denied.'));
    assert.ok(output); assert.match(output.data.delta, /Storage capacity is blocked/);
    await app.close();
    const restored = new FakeCodex();
    app = await createApplication({ port: 0, codex: restored, autostart: false,
      storageCollector: async workspace => evidence(workspace, { blocks: { size: '4096', total: '100', free: '0', available: '0' } }) });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const resumedCalls = restored.calls.length, recovered = await app.actions['agent/send']({ text: 'show storage' });
    assert.equal(recovered.status, 'passed'); assert.equal(recovered.freeBytes, '0'); assert.equal(recovered.availableBytes, '0');
    assert.equal(recovered.usedBytes, recovered.totalBytes); assert.match(storageReport(recovered), /Available capacity: 0\.00 GiB \(0 bytes\)/);
    assert.equal(app.snapshot().systemTool, null); assert.equal(restored.calls.length, resumedCalls); assert.equal(app.automation.saved.paused, wasPaused);
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-storage-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
