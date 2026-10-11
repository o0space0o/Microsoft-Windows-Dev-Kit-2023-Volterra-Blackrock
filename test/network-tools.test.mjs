import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-network-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
const { networkQuery, collectNetworking, inspectNetworking, networkReport } = await import('../app/network-tools.mjs');
const { createApplication } = await import('../app/server.mjs');
const { describeProgress } = await import('../app/public/progress.js');
const ipv4 = { address: '192.0.2.10', family: 'IPv4', netmask: '255.255.255.0', internal: false, scopeId: null };
const ipv6 = { address: 'fe80::1', family: 'IPv6', netmask: 'ffff:ffff:ffff:ffff::', internal: false, scopeId: 7 };
const evidence = (patch = {}) => ({ version: 1, kind: 'networking', status: 'passed', error: null, observedAt: '2026-10-11T18:00:00.000Z',
  system: { platform: 'win32', release: 'fixture', runtimeArchitecture: 'arm64' }, interfaces: [
    { name: 'Fixture [wired]', addresses: [ipv6, ipv4] },
    { name: 'Loopback fixture', addresses: [{ address: '::1', family: 'IPv6', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', internal: true, scopeId: 0 }] }
  ], ...patch });

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

test('network chat queries are precise and keep path, command and regex text out of the collector', () => {
  assert.deepEqual(networkQuery('show networking'), { filter: '' });
  assert.deepEqual(networkQuery(' LIST NETWORK matching [wired] '), { filter: '[wired]' });
  assert.deepEqual(networkQuery('networking matching $(Example); *'), { filter: '$(Example); *' });
  for (const message of ['change networking', 'show networking and disable an adapter', 'networking\ncommands', null]) assert.equal(networkQuery(message), null);
  assert.throws(() => networkQuery('network matching ' + 'x'.repeat(257)), /256/);
  assert.throws(() => networkQuery('network matching bad\u0000filter'), /256/);
});

test('the local collector receives no filter and includes only address inventory fields', async () => {
  let calls = 0;
  const result = await collectNetworking({ readInterfaces: (...args) => {
    assert.deepEqual(args, []); calls++;
    return { Fixture: [{ ...ipv4, mac: 'Excluded fixture metadata', cidr: '192.0.2.10/24' }, { ...ipv6, scopeid: 7 }] };
  } });
  assert.equal(calls, 1); assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  assert.equal(result.status, 'passed'); assert.equal(result.error, null);
  assert.deepEqual(result.interfaces, [{ name: 'Fixture', addresses: [ipv4, ipv6] }]);
  await assert.rejects(collectNetworking({ readInterfaces: null }), /local network address API/);
  await assert.rejects(collectNetworking({ readInterfaces: () => [] }), /unsupported readings/);
});

test('network inventory preserves family, mask, internal flags and zero or unreported IPv6 scope', async () => {
  const result = await inspectNetworking('', async () => evidence());
  assert.equal(result.status, 'passed'); assert.equal(result.totalInterfaceCount, 2); assert.equal(result.totalAddressCount, 3);
  assert.equal(result.matchedInterfaceCount, 2); assert.equal(result.matchedAddressCount, 3);
  assert.deepEqual(result.interfaces[0].addresses, [ipv4, ipv6]);
  const report = networkReport(result);
  assert.match(report, /IPv6 scope ID: 7/); assert.match(report, /IPv6 scope ID: 0/);
  assert.match(report, /Internal flag: No/); assert.match(report, /Internal flag: Yes/);
  assert.match(report, /Link state, gateways, DNS configuration and connectivity remain unverified/);
  assert.match(report, /VM or physical identity unverified/);
  const unreported = await inspectNetworking('', async () => evidence({ interfaces: [{ name: 'Fixture', addresses: [{ ...ipv6, scopeId: null }] }] }));
  assert.match(networkReport(unreported), /IPv6 scope ID: Unreported/);
  for (const key of ['connectivityPassed', 'hardwareAccepted', 'runtimeAccepted']) assert.equal(result[key], undefined);
});

test('literal filtering matches an interface or specific address while preserving full totals', async () => {
  let calls = 0;
  const collect = async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); };
  const byName = await inspectNetworking('[wired]', collect);
  assert.equal(byName.matchedAddressCount, 2); assert.equal(byName.totalAddressCount, 3);
  const byAddress = await inspectNetworking('192.0.2.', collect);
  assert.equal(byAddress.matchedInterfaceCount, 1); assert.deepEqual(byAddress.interfaces[0].addresses, [ipv4]);
  assert.equal((await inspectNetworking('*', collect)).matchedAddressCount, 0);
  assert.equal((await inspectNetworking('$(Example); *', collect)).matchedAddressCount, 0);
  assert.equal(calls, 4);
  assert.match(networkReport(await inspectNetworking('*', collect)), /No assigned addresses matched this literal filter/);
  await assert.rejects(inspectNetworking(null, collect), /256/);
});

test('malformed, duplicate and excessive address evidence fails closed without partial success', async () => {
  for (const raw of [null, evidence({ observedAt: 'invalid' }), evidence({ interfaces: {} }), evidence({ kind: 'devices' }),
    evidence({ interfaces: [{ name: '', addresses: [ipv4] }] }), evidence({ interfaces: [{ name: 'Fixture', addresses: {} }] }),
    ...[{ ...ipv4, address: 'invalid' }, { ...ipv4, family: 'IPv6' }, { ...ipv4, netmask: 'ffff::' }, { ...ipv4, internal: 'false' },
      { ...ipv4, scopeId: 7 }, { ...ipv6, scopeId: -1 }, { ...ipv6, scopeId: 0x1_0000_0000 }, { ...ipv6, scopeId: undefined }]
      .map(reading => evidence({ interfaces: [{ name: 'Fixture', addresses: [ipv4, reading] }] })),
    evidence({ interfaces: [{ name: 'Fixture', addresses: [ipv4, ipv4] }] }),
    evidence({ interfaces: [{ name: 'Fixture', addresses: [ipv4] }, { name: 'fixture', addresses: [ipv6] }] }),
    evidence({ interfaces: Array.from({ length: 513 }, () => ({ name: 'Fixture', addresses: [ipv4] })) }),
    evidence({ interfaces: [{ name: 'Fixture', addresses: Array.from({ length: 129 }, () => ipv4) }] }),
    evidence({ interfaces: Array.from({ length: 65 }, (_, index) => ({ name: `Fixture-${index}`, addresses: Array.from({ length: 64 }, (_, suffix) => ({ ...ipv4, address: `192.0.2.${suffix + 1}` })) })) })]) {
    const result = await inspectNetworking('', async () => raw);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.interfaces, []); assert.match(networkReport(result), /blocked/);
  }
  const empty = await inspectNetworking('', async () => evidence({ interfaces: [{ name: 'No assigned addresses', addresses: [] }] }));
  assert.equal(empty.status, 'passed'); assert.equal(empty.totalInterfaceCount, 0); assert.equal(empty.totalAddressCount, 0);
  assert.match(networkReport(empty), /No assigned interface addresses were reported/);
  const failed = await inspectNetworking('', async () => { throw new Error('Address API unavailable. Bearer fixture-secret'); });
  assert.match(failed.error.message, /unavailable/); assert.doesNotMatch(networkReport(failed), /fixture-secret/);
});

test('conversation output stays bounded while matched addresses remain available in the authorized result', async () => {
  const result = await inspectNetworking('', async () => evidence({ interfaces: [{ name: 'n'.repeat(256), addresses: Array.from({ length: 42 }, (_, index) => ({ ...ipv4, address: `192.0.2.${index + 1}` })) }] }));
  assert.equal(result.status, 'passed'); assert.equal(result.matchedAddressCount, 42);
  const report = networkReport(result);
  assert.equal(report.match(/Internal flag:/g).length, 40); assert.match(report, /Showing 40 of 42/); assert.ok(report.length < 30_000);
  const sanitized = await inspectNetworking('', async () => evidence({ interfaces: [{ name: 'Fixture\nBearer fixture-secret', addresses: [ipv4] }] }));
  assert.doesNotMatch(networkReport(sanitized), /fixture-secret/); assert.doesNotMatch(sanitized.interfaces[0].name, /\n/);
});

test('the real local network inventory has typed address readings without testing connectivity', async () => {
  const result = await inspectNetworking();
  assert.equal(result.status, 'passed'); assert.ok(Number.isInteger(result.totalAddressCount));
  assert.equal(result.matchedAddressCount, result.totalAddressCount);
  assert.equal(result.interfaces.reduce((count, iface) => count + iface.addresses.length, 0), result.totalAddressCount);
  assert.equal(result.connectivityPassed, undefined);
});

test('network chat requires a local session and persists output without account sign-in', async () => {
  const fake = new FakeCodex(); let calls = 0;
  let app = await createApplication({ port: 0, codex: fake, autostart: false, networkCollector: async () => { calls++; return evidence(); } });
  try {
    const unauthorized = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'show networking' }) });
    assert.equal(unauthorized.status, 403); assert.equal(calls, 0);
    const entry = await fetch(app.origin), html = await entry.text();
    const cookie = entry.headers.get('set-cookie').split(';')[0], token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1];
    const headers = { cookie, 'Content-Type': 'application/json', 'X-Volterra-Client': token };
    const crossOrigin = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ text: 'show networking' }) });
    assert.equal(crossOrigin.status, 403); assert.equal(calls, 0);
    const response = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers, body: JSON.stringify({ text: 'show networking matching [wired]' }) });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.tool, 'networking'); assert.equal(result.status, 'passed'); assert.equal(result.matchedAddressCount, 2); assert.equal(calls, 1);
    assert.equal(fake.calls.length, 0); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Live network addresses'));
    assert.ok(output); await app.close();
    app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('network checking remains live without resuming a saved pause, steering a turn or overlapping other inventory tools', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, networkCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Continue the project work' });
    await app.automation.pause(); const before = fake.calls.length;
    const request = app.actions['agent/send']({ text: 'show networking' });
    const snapshot = app.snapshot();
    assert.equal(snapshot.systemTool.kind, 'networking'); assert.equal(snapshot.progress.since, snapshot.systemTool.since);
    assert.equal(describeProgress(snapshot).phase, 'checking'); assert.equal(describeProgress(snapshot).title, 'Reading network addresses');
    for (const text of ['show networking', 'show services', 'show devices', 'show storage']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('an unavailable network API leaves a saved blocked report and clears checking state', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false,
    networkCollector: async () => { throw new Error('Local network address API unavailable.'); } });
  try {
    const result = await app.actions['agent/send']({ text: 'show networking' });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.interfaces, []); assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'output' && entry.data.delta?.includes('Network address inventory is blocked.')));
  } finally { await app.close(); }
});

test('missing interface positions are blocked before totals or literal filtering can hide them', async () => {
  const sparse = new Array(2); sparse[0] = evidence().interfaces[0];
  for (const interfaces of [new Array(1), sparse, [undefined], [null]]) {
    for (const filter of ['', '[wired]', 'does not match']) {
      const result = await inspectNetworking(filter, async () => evidence({ interfaces }));
      assert.equal(result.status, 'blocked'); assert.deepEqual(result.interfaces, []);
      for (const key of ['totalInterfaceCount', 'totalAddressCount', 'matchedInterfaceCount', 'matchedAddressCount']) assert.equal(result[key], undefined);
      assert.match(networkReport(result), /incomplete interface readings/);
    }
  }
});

test('missing address positions cannot inflate matched counts, disappear behind filters or crash a report', async () => {
  const sparse = new Array(2); sparse[0] = ipv4;
  for (const addresses of [new Array(1), sparse, [undefined], [null]]) {
    for (const filter of ['', 'Fixture', '192.0.2.', 'does not match']) {
      const result = await inspectNetworking(filter, async () => evidence({ interfaces: [{ name: 'Fixture', addresses }] }));
      assert.equal(result.status, 'blocked'); assert.deepEqual(result.interfaces, []);
      for (const key of ['totalInterfaceCount', 'totalAddressCount', 'matchedInterfaceCount', 'matchedAddressCount']) assert.equal(result[key], undefined);
      assert.match(networkReport(result), /incomplete address readings/);
    }
  }
});

test('the native collector rejects missing address positions and unsupported arrays without returning partial success', async () => {
  const sparse = new Array(2); sparse[0] = ipv4;
  for (const addresses of [new Array(1), sparse, [undefined], [null], [[]], null, {}, new Array(129)]) {
    let calls = 0;
    const result = await inspectNetworking('', () => collectNetworking({ readInterfaces: (...args) => {
      calls++; assert.deepEqual(args, []); return { Fixture: addresses };
    } }));
    assert.equal(calls, 1); assert.equal(result.status, 'blocked'); assert.deepEqual(result.interfaces, []);
    assert.equal(result.totalAddressCount, undefined); assert.match(networkReport(result), /network address API returned/);
  }
  await assert.rejects(collectNetworking({ readInterfaces: () => Object.fromEntries(Array.from({ length: 513 }, (_, index) => ['Fixture-' + index, []])) }), /too many interface readings/);
});

test('network success and failure flags must agree before any address counts or provider diagnostics are accepted', async () => {
  const failed = { stage: 'Local address API', message: 'Provider failed. Bearer fixture-secret' };
  const invalid = [evidence({ status: 'unknown' }), evidence({ status: undefined }), evidence({ error: undefined }), evidence({ error: failed }),
    evidence({ status: 'blocked', error: failed }), evidence({ status: 'blocked', error: null, interfaces: [] }),
    evidence({ status: 'blocked', error: { ...failed, stage: ' ' }, interfaces: [] }),
    evidence({ status: 'blocked', error: { ...failed, message: '' }, interfaces: [] })];
  for (const raw of invalid) {
    const result = await inspectNetworking('does not match', async () => raw);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.interfaces, []);
    assert.equal(result.totalAddressCount, undefined); assert.doesNotMatch(networkReport(result), /fixture-secret|No assigned addresses matched/);
  }
  const result = await inspectNetworking('', async () => evidence({ status: 'blocked', error: failed, interfaces: [] }));
  assert.equal(result.status, 'blocked'); assert.equal(result.error.stage, failed.stage);
  assert.match(networkReport(result), /Provider failed/); assert.doesNotMatch(networkReport(result), /fixture-secret/);
  for (const failure of [null, undefined]) {
    const result = await inspectNetworking('', async () => { throw failure; });
    assert.equal(result.status, 'blocked'); assert.match(networkReport(result), /address query did not succeed/);
  }
});

test('actual empty inventories, false flags and zero or unreported scopes stay distinct from missing rows', async () => {
  for (const interfaces of [[], [{ name: 'Fixture', addresses: [] }]]) {
    const result = await inspectNetworking('', async () => evidence({ interfaces }));
    assert.equal(result.status, 'passed'); assert.equal(result.totalInterfaceCount, 0); assert.equal(result.totalAddressCount, 0);
    assert.match(networkReport(result), /No assigned interface addresses were reported/);
  }
  const result = await inspectNetworking('', () => collectNetworking({ readInterfaces: () => ({
    Fixture: [{ ...ipv6, scopeid: 0 }, { ...ipv6, address: 'fe80::2', scopeid: undefined }]
  }) }));
  assert.equal(result.status, 'passed'); assert.equal(result.matchedAddressCount, 2);
  assert.deepEqual(result.interfaces[0].addresses.map(address => [address.internal, address.scopeId]), [[false, 0], [false, null]]);
  assert.match(networkReport(result), /IPv6 scope ID: 0/); assert.match(networkReport(result), /IPv6 scope ID: Unreported/);
});

test('missing network readings save a blocked chat report across restart and permit a fresh read', async () => {
  const sparse = new Array(2); sparse[0] = ipv4;
  const fake = new FakeCodex();
  let app = await createApplication({ port: 0, codex: fake, autostart: false,
    networkCollector: async () => evidence({ interfaces: [{ name: 'Fixture', addresses: sparse }] }) });
  try {
    const before = fake.calls.length, result = await app.actions['agent/send']({ text: 'show networking matching does not match' });
    assert.equal(result.status, 'blocked'); assert.equal(app.snapshot().systemTool, null); assert.equal(fake.calls.length, before);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('incomplete address readings'));
    assert.ok(output); assert.doesNotMatch(output.data.delta, /assigned addresses read|No assigned addresses matched/);
    await app.close();
    const next = new FakeCodex();
    app = await createApplication({ port: 0, codex: next, autostart: false, networkCollector: async () => evidence() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const prior = next.calls.length, recovered = await app.actions['agent/send']({ text: 'show networking' });
    assert.equal(recovered.status, 'passed'); assert.equal(recovered.totalAddressCount, 3);
    assert.equal(next.calls.length, prior); assert.equal(app.snapshot().systemTool, null);
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-network-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
