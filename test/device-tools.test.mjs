import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-device-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
const { deviceQuery, collectDevices, inspectDevices, deviceReport } = await import('../app/device-tools.mjs');
const { createApplication } = await import('../app/server.mjs');
const { describeProgress } = await import('../app/public/progress.js');
const evidence = (patch = {}) => ({ version: 1, kind: 'devices', status: 'passed', observedAt: '2026-10-11T12:00:00.000Z',
  system: { edition: 'Professional', build: '26200', architecture: 'ARM64' }, devices: [
    { instanceId: 'ROOT\\FIXTURE_ZULU', name: 'Literal [match] fixture', deviceClass: 'Example', status: 'Error', present: false, problemCode: 22 },
    { instanceId: 'ROOT\\FIXTURE_ALPHA', name: 'Example device', deviceClass: 'System', status: 'OK', present: true, problemCode: 0 },
    { instanceId: 'ROOT\\FIXTURE_BETA', name: null, deviceClass: null, status: null, present: null, problemCode: null }
  ], error: null, ...patch });

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

test('device chat intent is precise and treats filter command syntax as literal data', () => {
  assert.deepEqual(deviceQuery('show devices'), { filter: '' });
  assert.deepEqual(deviceQuery('  LIST devices matching [match]  '), { filter: '[match]' });
  assert.deepEqual(deviceQuery('devices matching $(Disable-PnpDevice Example); *'), { filter: '$(Disable-PnpDevice Example); *' });
  for (const message of ['disable devices', 'show devices and enable Example', 'devices\nstop', 'device', null]) assert.equal(deviceQuery(message), null);
  assert.throws(() => deviceQuery('show devices matching ' + 'x'.repeat(257)), /256/);
  assert.throws(() => deviceQuery('devices matching bad\u0000filter'), /256/);
});

test('device collection launches a fixed original script without an execution policy override or filter argument', async () => {
  let calls = 0;
  const value = await collectDevices({ shell: 'fixture-powershell', execute: async (shell, args, options) => {
    calls++; assert.equal(shell, 'fixture-powershell');
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/Get-DeviceInventory.ps1')]);
    assert.equal(options.timeout, 15_000);
    return '\uFEFF' + JSON.stringify(evidence());
  } });
  assert.equal(calls, 1); assert.deepEqual(value, evidence());
  await assert.rejects(collectDevices({ shell: null }), /Windows PowerShell/);
});

test('device status, presence and problem codes retain zero, false and unreported distinctions', async () => {
  const result = await inspectDevices('', async () => evidence());
  assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 3); assert.equal(result.matchedCount, 3);
  assert.deepEqual(result.counts, { codeZero: 1, codeNonzero: 1, codeUnreported: 1 });
  assert.deepEqual(result.devices.map(device => device.instanceId), ['ROOT\\FIXTURE_ALPHA', 'ROOT\\FIXTURE_ZULU', 'ROOT\\FIXTURE_BETA']);
  assert.equal(result.devices[0].problemCode, 0); assert.equal(result.devices[1].present, false);
  assert.equal(result.devices[2].present, null); assert.equal(result.devices[2].problemCode, null);
  const report = deviceReport(result);
  assert.match(report, /Present: Yes\. Problem code: 0/);
  assert.match(report, /Present: No\. Problem code: 22/);
  assert.match(report, /Reported status: Unreported\. Present: Unreported\. Problem code: Unreported/);
  assert.match(report, /Inventory only/); assert.match(report, /do not verify driver functionality, the NPU/);
  assert.match(report, /Windows session; VM or physical identity unverified/);
  const validation = await inspectDevices('', async () => evidence({ system: { edition: 'WinVOS', build: 'fixture', architecture: 'ARM64' } }));
  assert.match(validation.environment, /Validation OS session; VM or physical identity unverified/);
  for (const key of ['bootAccepted', 'runtimeAccepted', 'hardwareAccepted']) assert.equal(validation[key], undefined);
});

test('literal filtering matches names, classes and identities without regex, commands or provider input', async () => {
  let calls = 0;
  const collect = async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); };
  assert.equal((await inspectDevices('[match]', collect)).matchedCount, 1);
  assert.equal((await inspectDevices('system', collect)).devices[0].instanceId, 'ROOT\\FIXTURE_ALPHA');
  assert.equal((await inspectDevices('fixture_beta', collect)).matchedCount, 1);
  assert.equal((await inspectDevices('*', collect)).matchedCount, 0);
  assert.equal((await inspectDevices('$(Disable-PnpDevice Example); *', collect)).matchedCount, 0);
  assert.equal(calls, 5);
  assert.match(deviceReport(await inspectDevices('*', collect)), /No devices matched this literal filter/);
  await assert.rejects(inspectDevices('\u0000', collect), /256/);
  await assert.rejects(inspectDevices(null, collect), /256/);
});

test('malformed and duplicate device readings fail closed instead of becoming healthy readings', async () => {
  const row = evidence().devices[0];
  for (const raw of [null, evidence({ observedAt: 'invalid' }), evidence({ kind: 'services' }), evidence({ devices: {} }),
    evidence({ devices: [{ ...row, instanceId: '' }] }), evidence({ devices: [{ ...row, instanceId: 'x'.repeat(513) }] }),
    evidence({ devices: [{ ...row, name: 123 }] }), evidence({ devices: [{ ...row, present: 'false' }] }),
    evidence({ devices: [{ ...row, problemCode: undefined }] }), evidence({ devices: [{ ...row, problemCode: -1 }] }),
    evidence({ devices: [{ ...row, problemCode: 1.5 }] }), evidence({ devices: [{ ...row, problemCode: 0x1_0000_0000 }] }),
    evidence({ devices: [row, { ...row, instanceId: row.instanceId.toLowerCase() }] }),
    evidence({ devices: Array.from({ length: 4097 }, () => row) })]) {
    const result = await inspectDevices('', async () => raw);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.devices, []); assert.match(deviceReport(result), /blocked/);
  }
  assert.equal((await inspectDevices('', async () => evidence({ devices: [{ ...row, problemCode: 0xffff_ffff }] }))).status, 'passed');
  const empty = await inspectDevices('', async () => evidence({ devices: [] }));
  assert.equal(empty.totalCount, 0); assert.deepEqual(empty.counts, { codeZero: 0, codeNonzero: 0, codeUnreported: 0 });
});

test('provider failure and missing APIs produce sanitized blocked diagnostics', async () => {
  const denied = await inspectDevices('', async () => evidence({ status: 'blocked', devices: [], error: { stage: 'Device enumeration', message: 'Provider failed. Bearer fixture-secret' } }));
  assert.equal(denied.status, 'blocked'); assert.deepEqual(denied.devices, []);
  assert.equal(denied.error.stage, 'Device enumeration'); assert.match(denied.error.message, /Provider failed/);
  assert.doesNotMatch(denied.error.message, /fixture-secret/);
  const unavailable = await inspectDevices('', async () => { throw new Error('Win32_PnPEntity is unavailable.'); });
  assert.equal(unavailable.status, 'blocked'); assert.match(unavailable.error.message, /unavailable/);
  const sanitized = await inspectDevices('', async () => evidence({ devices: [{ ...evidence().devices[0], name: 'Label\nBearer fixture-secret' }] }));
  assert.doesNotMatch(deviceReport(sanitized), /fixture-secret/); assert.doesNotMatch(sanitized.devices[0].name, /\n/);
});

test('sparse device rows fail closed without inventing counts or omitting unknown readings', async () => {
  const partial = Array(3); partial[1] = evidence().devices[0];
  for (const devices of [Array(2), partial, [evidence().devices[0], undefined], [null]]) {
    const result = await inspectDevices('', async () => evidence({ devices }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.devices, []);
    assert.equal(result.totalCount, undefined); assert.equal(result.counts, undefined); assert.match(deviceReport(result), /blocked/);
  }
  for (const devices of [[], evidence().devices]) {
    const result = await inspectDevices('', async () => evidence({ devices }));
    assert.equal(result.status, 'passed'); assert.equal(result.totalCount, devices.length);
    assert.equal(Object.values(result.counts).reduce((total, value) => total + value, 0), result.totalCount);
  }
});

test('device success and blocked status require consistent explicit provider evidence', async () => {
  for (const error of [undefined, false, {}, { stage: 'Device enumeration', message: 'Provider failed' }]) {
    const result = await inspectDevices('', async () => evidence({ error }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.devices, []);
    assert.match(result.error.message, /conflicting failure evidence/);
  }
  const blocked = { status: 'blocked', devices: [], error: { stage: 'Device enumeration', message: 'Access denied' } };
  const malformed = [evidence({ ...blocked, devices: evidence().devices }),
    ...[null, {}, { stage: '', message: 'Denied' }, { stage: 'Read', message: ' ' }, { stage: 1, message: 'Denied' }, { stage: 'Read', message: {} }]
      .map(error => evidence({ ...blocked, error }))];
  for (const raw of malformed) {
    const result = await inspectDevices('', async () => raw);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.devices, []); assert.equal(result.totalCount, undefined);
    assert.match(result.error.message, /ambiguous failure evidence/);
  }
  const result = await inspectDevices('sk-fixture-filter', async () => evidence(blocked));
  assert.equal(result.error.stage, 'Device enumeration'); assert.equal(result.error.message, 'Access denied');
  assert.doesNotMatch(JSON.stringify(result), /fixture-filter/);
});

test('null and non-Error device collector exceptions remain blocked and retain safe diagnostics', async () => {
  for (const failure of [null, undefined, '', 'Access denied', 123, {}]) {
    const result = await inspectDevices('', async () => { throw failure; });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.devices, []);
    assert.equal(result.error.stage, 'Device inventory'); assert.match(deviceReport(result), /device query did not succeed/);
  }
  const denied = await inspectDevices('', async () => { throw { message: 'Read denied. Bearer fixture-secret' }; });
  assert.match(denied.error.message, /Read denied/); assert.doesNotMatch(denied.error.message, /fixture-secret/);
});

test('oversized device session metadata is blocked while optional readings keep their zero and null values', async () => {
  for (const key of ['edition', 'build', 'architecture']) {
    const result = await inspectDevices('', async () => evidence({ system: { ...evidence().system, [key]: 'x'.repeat(129) } }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.devices, []);
  }
  assert.equal((await inspectDevices('', async () => evidence({ observedAt: 'x'.repeat(41) }))).status, 'blocked');
  const result = await inspectDevices('', async () => evidence({ system: { edition: 'x'.repeat(128), build: 'x'.repeat(128), architecture: 'x'.repeat(128) } }));
  assert.equal(result.status, 'passed'); assert.deepEqual(result.counts, { codeZero: 1, codeNonzero: 1, codeUnreported: 1 });
  assert.equal(result.devices.find(row => row.instanceId.endsWith('ALPHA')).problemCode, 0);
  assert.equal(result.devices.find(row => row.instanceId.endsWith('ZULU')).present, false);
  assert.equal(result.devices.find(row => row.instanceId.endsWith('BETA')).problemCode, null);
});

test('the conversation bounds long inventory output while the authenticated result retains matches', async () => {
  const result = await inspectDevices('', async () => evidence({ devices: Array.from({ length: 42 }, (_, index) => ({
    instanceId: `${index}-` + 'x'.repeat(500), name: 'n'.repeat(512), deviceClass: 'c'.repeat(128), status: 's'.repeat(64), present: true, problemCode: 0
  })) }));
  assert.equal(result.status, 'passed'); assert.equal(result.devices.length, 42);
  const report = deviceReport(result);
  assert.equal(report.match(/Reported status:/g).length, 40); assert.match(report, /Showing 40 of 42/);
  assert.ok(report.length < 30_000);
});

test('the device chat endpoint requires local session authorization and persists readings without account sign-in', async () => {
  const fake = new FakeCodex(); let calls = 0;
  let app = await createApplication({ port: 0, codex: fake, autostart: false, deviceCollector: async () => { calls++; return evidence(); } });
  try {
    const unauthorized = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'show devices' }) });
    assert.equal(unauthorized.status, 403); assert.equal(calls, 0);
    const entry = await fetch(app.origin), html = await entry.text();
    const cookie = entry.headers.get('set-cookie').split(';')[0], token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1];
    const headers = { cookie, 'Content-Type': 'application/json', 'X-Volterra-Client': token };
    const crossOrigin = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ text: 'show devices' }) });
    assert.equal(crossOrigin.status, 403); assert.equal(calls, 0);
    const response = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers, body: JSON.stringify({ text: 'show devices matching [match]' }) });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.tool, 'devices'); assert.equal(result.status, 'passed'); assert.equal(result.matchedCount, 1); assert.equal(calls, 1);
    assert.equal(fake.calls.length, 0); assert.equal(app.snapshot().activeTurn, null); assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'user' && entry.data === 'show devices matching [match]'));
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Literal [match] fixture'));
    assert.ok(output);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'command' && entry.data.command.includes('Get-DeviceInventory.ps1')));
    await app.close();
    app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false, deviceCollector: async () => evidence() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('a device read shows live checking without steering an active turn, changing a saved pause or overlapping services', async () => {
  const fake = new FakeCodex(); let release; let serviceCalls = 0;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, deviceCollector: () => collecting,
    serviceCollector: async () => { serviceCalls++; throw new Error('Unexpected service read'); } });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' });
    await app.automation.pause();
    const before = fake.calls.length;
    const request = app.actions['agent/send']({ text: 'show devices' });
    const snapshot = app.snapshot();
    assert.equal(snapshot.activeTurn, 'fixture-turn'); assert.equal(snapshot.systemTool.kind, 'devices');
    assert.equal(snapshot.progress.since, snapshot.systemTool.since);
    assert.equal(describeProgress(snapshot).phase, 'checking'); assert.equal(describeProgress(snapshot).title, 'Reading Windows devices');
    assert.equal(describeProgress(snapshot).active, true);
    await assert.rejects(app.actions['agent/send']({ text: 'show devices' }), /already running/);
    await assert.rejects(app.actions['agent/send']({ text: 'show services' }), /already running/);
    assert.equal(serviceCalls, 0);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('a denied device collector saves a blocked diagnostic and clears transient checking state', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false,
    deviceCollector: async () => { throw new Error('Script execution is disabled by policy.'); } });
  try {
    const result = await app.actions['agent/send']({ text: 'show devices' });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.devices, []);
    assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'output' && entry.data.delta?.includes('blocked. Device inventory: Script execution is disabled by policy.')));
  } finally { await app.close(); }
});

test('device collector anomalies save blocked output, clear checking and recover for a valid subsequent read', async () => {
  let read = 0;
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false, deviceCollector: async () => {
    if (++read === 1) throw null;
    if (read === 2) return evidence({ devices: Array(2) });
    if (read === 3) return evidence({ error: { stage: 'Device enumeration', message: 'Provider failed' } });
    return evidence();
  } });
  try {
    const blockedOutputs = () => app.snapshot().journal.filter(entry => entry.type === 'output' && entry.data.delta?.startsWith('Device inventory is blocked.')).length;
    const before = blockedOutputs();
    for (let index = 0; index < 3; index++) {
      const result = await app.actions['agent/send']({ text: 'show devices' });
      assert.equal(result.status, 'blocked'); assert.equal(app.snapshot().systemTool, null);
    }
    assert.equal(blockedOutputs() - before, 3);
    const result = await app.actions['agent/send']({ text: 'show devices' });
    assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 3); assert.equal(app.snapshot().systemTool, null);
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-device-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
