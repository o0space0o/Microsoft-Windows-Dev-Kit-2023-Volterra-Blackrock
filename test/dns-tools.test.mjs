import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Resolver } from 'node:dns';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-dns-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
const { dnsQuery, collectDns, inspectDns, dnsReport } = await import('../app/dns-tools.mjs');
const { createApplication } = await import('../app/server.mjs');
const { describeProgress } = await import('../app/public/progress.js');
const evidence = (patch = {}) => ({ version: 1, kind: 'dns', status: 'passed', error: null, observedAt: '2026-10-11T18:00:00.000Z',
  system: { platform: 'win32', release: 'fixture', runtimeArchitecture: 'arm64' },
  servers: ['192.0.2.53', '2001:db8::53', '192.0.2.54:1053', '[2001:db8::54]:1053'], ...patch });

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

test('DNS chat intent accepts only configuration readings with bounded literal filters', () => {
  for (const message of ['show DNS', 'DNS', 'list DNS servers']) assert.deepEqual(dnsQuery(message), { filter: '' });
  assert.deepEqual(dnsQuery(' SHOW DNS SERVERS matching [2001:db8::54] '), { filter: '[2001:db8::54]' });
  assert.deepEqual(dnsQuery('DNS matching $(Example); *'), { filter: '$(Example); *' });
  for (const message of ['set DNS', 'flush DNS', 'show DNS and resolve example.invalid', 'show DNS from another host', 'DNS\ncommands', null]) assert.equal(dnsQuery(message), null);
  for (const filter of ['x'.repeat(257), 'bad\u0000filter']) assert.throws(() => dnsQuery('show DNS matching ' + filter), /256/);
});

test('the collector reads configuration without arguments and copies the returned array', async () => {
  let calls = 0; const servers = ['192.0.2.53'];
  const result = await collectDns({ readServers: (...args) => { assert.deepEqual(args, []); calls++; return servers; } });
  assert.equal(calls, 1); assert.equal(result.version, 1); assert.equal(result.kind, 'dns');
  assert.equal(result.status, 'passed'); assert.equal(result.error, null);
  assert.ok(Number.isFinite(Date.parse(result.observedAt))); assert.deepEqual(result.servers, ['192.0.2.53']);
  servers[0] = '192.0.2.54'; assert.deepEqual(result.servers, ['192.0.2.53']);
  await assert.rejects(collectDns({ readServers: null }), /configuration API/);
  await assert.rejects(collectDns({ readServers: () => ({}) }), /unsupported readings/);
});

test('an isolated native Node resolver confirms IPv4 and IPv6 endpoint formats without any lookup', async () => {
  const resolver = new Resolver();
  // Fixture-owned resolver only; the global resolver and Windows settings are untouched.
  resolver.setServers(['192.0.2.53', '[2001:db8::53]', '192.0.2.54:1053', '[2001:db8::54]:1053']);
  const result = await inspectDns('', () => collectDns({ readServers: () => resolver.getServers() }));
  assert.equal(result.status, 'passed'); assert.deepEqual(result.servers.map(server => server.endpoint), evidence().servers);
  assert.deepEqual(result.servers.map(server => server.port), [53, 53, 1053, 1053]);
});

test('endpoint parsing preserves returned order, repeated entries and IPv6 ambiguity without health claims', async () => {
  const result = await inspectDns('', async () => evidence({ servers: ['192.0.2.53', '[2001:db8::53]:65535', '192.0.2.53', '2001:db8::53:1053'] }));
  assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 4);
  assert.deepEqual(result.servers, [
    { position: 1, endpoint: '192.0.2.53', address: '192.0.2.53', family: 'IPv4', port: 53 },
    { position: 2, endpoint: '[2001:db8::53]:65535', address: '2001:db8::53', family: 'IPv6', port: 65535 },
    { position: 3, endpoint: '192.0.2.53', address: '192.0.2.53', family: 'IPv4', port: 53 },
    { position: 4, endpoint: '2001:db8::53:1053', address: '2001:db8::53:1053', family: 'IPv6', port: 53 }
  ]);
  const report = dnsReport(result);
  assert.match(report, /Helper Node resolver only/); assert.match(report, /DNS port: 65535/);
  assert.match(report, /Windows DNS Client settings/); assert.match(report, /VM or physical identity unverified/);
  for (const key of ['connectivityPassed', 'resolutionPassed', 'hardwareAccepted', 'runtimeAccepted', 'healthy']) assert.equal(result[key], undefined);
});

test('filters apply literally to endpoints after collection and retain original positions and totals', async () => {
  let calls = 0; const collect = async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); };
  const bracket = await inspectDns('[2001:db8::54]', collect);
  assert.equal(bracket.totalCount, 4); assert.equal(bracket.matchedCount, 1); assert.equal(bracket.servers[0].position, 4);
  assert.equal((await inspectDns('1053', collect)).matchedCount, 2);
  assert.equal((await inspectDns('2001:DB8', collect)).matchedCount, 2);
  assert.equal((await inspectDns('$(Example); *', collect)).matchedCount, 0); assert.equal(calls, 4);
});

test('malformed evidence, hostnames and invalid endpoint ports fail closed without partial configuration', async () => {
  const invalid = [null, evidence({ version: 2 }), evidence({ kind: 'networking' }), evidence({ observedAt: 'invalid' }),
    evidence({ system: {} }), evidence({ system: { ...evidence().system, release: 'x'.repeat(129) } }),
    evidence({ servers: {} }), evidence({ servers: Array(257).fill('192.0.2.53') }), evidence({ servers: Array(2) })];
  for (const value of [null, 53, '', ' ', 'resolver.example.invalid', 'https://192.0.2.53', '192.0.2.53\u0000',
    '192.0.2.53:0', '192.0.2.53:01', '192.0.2.53:-1', '192.0.2.53:65536', '[2001:db8::53]:65536',
    '[192.0.2.53]:53', '[2001:db8::53]', '[2001:db8::53]:abc', '192.0.2.999', '1'.repeat(129)]) invalid.push(evidence({ servers: ['192.0.2.53', value] }));
  for (const raw of invalid) {
    const result = await inspectDns('', async () => raw);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.servers, []); assert.equal(result.totalCount, undefined);
  }
  const boundary = await inspectDns('', async () => evidence({ servers: ['192.0.2.53:1', '192.0.2.53:65535', '[::1]:53'] }));
  assert.equal(boundary.status, 'passed'); assert.deepEqual(boundary.servers.map(server => server.port), [1, 65535, 53]);
});

test('empty configuration remains a reading rather than proof that name resolution will fail', async () => {
  const result = await inspectDns('', async () => evidence({ servers: [] }));
  assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 0);
  assert.match(dnsReport(result), /no configured server entries; resolution behavior remains unverified/);
  const noMatch = await inspectDns('missing', async () => evidence());
  assert.match(dnsReport(noMatch), /No configured server entries matched this literal filter/);
});

test('conflicting DNS failure evidence is blocked before any endpoint is read or filtered', async () => {
  const servers = [];
  Object.defineProperty(servers, 0, { get() { throw new Error('Endpoint was accessed.'); } });
  const error = { stage: 'Resolver query', message: 'Configuration access denied.' };
  for (const patch of [{ status: undefined }, { status: 'unknown' }, { error: undefined }, { error: false }, { error },
    { status: 'blocked', error }, { status: 'blocked', error, servers: Array(1) }]) {
    const result = await inspectDns('no-match', async () => evidence({ servers, ...patch }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.servers, []);
    assert.equal(result.totalCount, undefined); assert.equal(result.matchedCount, undefined);
    assert.doesNotMatch(dnsReport(result), /Endpoint was accessed/);
  }
  const failedEmpty = await inspectDns('', async () => evidence({ servers: [], error }));
  assert.equal(failedEmpty.status, 'blocked'); assert.doesNotMatch(dnsReport(failedEmpty), /no configured server entries/);
});

test('complete DNS provider failures retain bounded redacted diagnostics and reject blank failure details', async () => {
  const failed = evidence({ status: 'blocked', servers: [], error: { stage: 'Resolver query', message: 'Configuration access denied. Bearer fixture-secret ' + 'x'.repeat(1024) } });
  const result = await inspectDns('no-match', async () => failed);
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.servers, []); assert.equal(result.observedAt, failed.observedAt);
  assert.equal(result.error.stage, 'Resolver query'); assert.match(dnsReport(result), /Configuration access denied/);
  assert.doesNotMatch(dnsReport(result), /fixture-secret/); assert.ok(result.error.message.length <= 512);
  assert.equal(result.totalCount, undefined);
  for (const error of [null, {}, { stage: '', message: 'Denied.' }, { stage: '   ', message: 'Denied.' },
    { stage: 'Resolver query', message: '' }, { stage: 'Resolver query', message: '   ' }]) {
    const rejected = await inspectDns('', async () => ({ ...failed, error }));
    assert.equal(rejected.status, 'blocked'); assert.deepEqual(rejected.servers, []);
    assert.match(rejected.error.message, /ambiguous failure evidence/);
  }
});

test('sparse or missing DNS endpoints cannot disappear behind a literal filter', async () => {
  const sparse = Array(2); sparse[1] = '192.0.2.53';
  for (const servers of [Array(1), sparse, ['192.0.2.53', undefined], [null, '192.0.2.53'], ['192.0.2.53', 'invalid.example.invalid']]) {
    const result = await inspectDns('no-match', async () => evidence({ servers }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.servers, []);
    assert.equal(result.totalCount, undefined); assert.equal(result.matchedCount, undefined);
    assert.match(dnsReport(result), /unsupported server endpoint/);
  }
});

test('null DNS collector failures preserve usable blocked diagnostics', async () => {
  for (const collect of [async () => null, async () => { throw null; }, async () => { throw undefined; }]) {
    const result = await inspectDns('no-match', collect);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.servers, []);
    assert.equal(result.error.stage, 'DNS resolver configuration'); assert.ok(result.error.message);
    assert.match(dnsReport(result), /DNS resolver configuration is blocked/);
  }
});

test('IPv6 zone text is rejected before arbitrary scope data can enter chat or history', async () => {
  for (const server of ['fe80::1%sk-fixture-secret', '[fe80::1%sk-fixture-secret]:53', 'fe80::1%7']) {
    const result = await inspectDns('', async () => evidence({ servers: ['192.0.2.53', server] }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.servers, []);
    assert.doesNotMatch(JSON.stringify(result) + dnsReport(result), /fixture-secret|fe80::1/);
  }
});

test('caller-supplied configuration claims are excluded and API diagnostics are redacted', async () => {
  const result = await inspectDns('', async () => evidence({ accepted: true, resolutionPassed: true, credentials: 'Private fixture metadata',
    interfaces: ['Private fixture metadata'], source: 'Private fixture metadata' }));
  assert.equal(result.accepted, undefined); assert.equal(result.resolutionPassed, undefined);
  assert.equal(result.source, 'Node dns.getServers()'); assert.doesNotMatch(JSON.stringify(result) + dnsReport(result), /Private fixture metadata/);
  const blocked = await inspectDns('', async () => { throw new Error('Resolver API unavailable. Bearer fixture-secret'); });
  assert.equal(blocked.status, 'blocked'); assert.match(dnsReport(blocked), /Resolver API unavailable/); assert.doesNotMatch(dnsReport(blocked), /fixture-secret/);
});

test('chat output is bounded while preserving configuration count and position', async () => {
  const result = await inspectDns('', async () => evidence({ servers: Array(41).fill('192.0.2.53') }));
  const report = dnsReport(result);
  assert.equal(result.totalCount, 41); assert.equal((report.match(/\nServer:/g) || []).length, 40);
  assert.match(report, /Showing 40 of 41/); assert.match(report, /Entry 40/); assert.doesNotMatch(report, /Entry 41/);
});

test('invalid filters are rejected before the configuration API runs', async () => {
  let calls = 0;
  for (const filter of [null, 'x'.repeat(257), 'bad\u0000filter']) await assert.rejects(inspectDns(filter, async () => { calls++; return evidence(); }), /256/);
  assert.equal(calls, 0);
});

test('chat authorization protects the query, ignores scope fields and saves readings without account sign-in', async () => {
  let calls = 0; const fake = new FakeCodex();
  const options = { port: 0, codex: fake, autostart: false, dnsCollector: async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); } };
  let app = await createApplication(options);
  try {
    const send = headers => fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'show DNS', hostname: 'remote.example.invalid', servers: ['203.0.113.53'], lookup: true, path: 'outside-fixture' }) });
    assert.equal((await send({})).status, 403); assert.equal(calls, 0);
    const page = await fetch(app.origin), html = await page.text(), cookie = page.headers.get('set-cookie').split(';')[0];
    const token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1], headers = { cookie, 'X-Volterra-Client': token };
    assert.equal((await send({ cookie })).status, 403);
    assert.equal((await send({ ...headers, Origin: 'https://untrusted.example' })).status, 403); assert.equal(calls, 0);
    const response = await send(headers), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.tool, 'dns'); assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 4);
    assert.equal(calls, 1); assert.deepEqual(fake.calls, []); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('DNS port: 1053'));
    assert.ok(output); await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('DNS checking preserves pauses, active turns and permission questions and excludes simultaneous tools', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, dnsCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' }); await app.automation.pause();
    const before = fake.calls.length, request = app.actions['agent/send']({ text: 'show DNS' }), snapshot = app.snapshot();
    assert.equal(snapshot.activeTurn, 'fixture-turn'); assert.equal(snapshot.systemTool.kind, 'dns'); assert.equal(describeProgress(snapshot).phase, 'checking');
    assert.equal(describeProgress({ ...snapshot, approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress({ ...snapshot, interruptRequested: true }).phase, 'stopping'); assert.equal(describeProgress(snapshot, false).phase, 'disconnected');
    for (const text of ['show services', 'show devices', 'show storage', 'show networking', 'show files', 'show logs', 'show maintenance', 'show processes', 'show DNS']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn'); assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('a blocked DNS API reading is saved and clears transient checking', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false,
    dnsCollector: async () => { throw new Error('Node DNS resolver configuration API unavailable.'); } });
  try {
    const result = await app.actions['agent/send']({ text: 'show DNS servers' });
    assert.equal(result.status, 'blocked'); assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'output' && entry.data.delta?.includes('DNS resolver configuration is blocked.')));
  } finally { await app.close(); }
});

test('DNS provider failures survive chat restart and a successful empty reading can recover', async () => {
  const fake = new FakeCodex();
  let app = await createApplication({ port: 0, codex: fake, autostart: false,
    dnsCollector: async () => evidence({ status: 'blocked', servers: [], error: { stage: 'Resolver query', message: 'Configuration access denied.' } }) });
  try {
    const before = fake.calls.length, wasPaused = app.automation.saved.paused;
    const result = await app.actions['agent/send']({ text: 'show DNS matching no-match' });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.servers, []); assert.equal(result.totalCount, undefined);
    assert.equal(app.snapshot().systemTool, null); assert.equal(fake.calls.length, before); assert.equal(app.automation.saved.paused, wasPaused);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Resolver query: Configuration access denied.'));
    assert.ok(output); assert.match(output.data.delta, /DNS resolver configuration is blocked/);
    await app.close();
    const restored = new FakeCodex();
    app = await createApplication({ port: 0, codex: restored, autostart: false, dnsCollector: async () => evidence({ servers: [] }) });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const resumedCalls = restored.calls.length, recovered = await app.actions['agent/send']({ text: 'show DNS' });
    assert.equal(recovered.status, 'passed'); assert.equal(recovered.totalCount, 0); assert.equal(recovered.matchedCount, 0);
    assert.match(dnsReport(recovered), /no configured server entries; resolution behavior remains unverified/);
    assert.equal(app.snapshot().systemTool, null); assert.equal(restored.calls.length, resumedCalls); assert.equal(app.automation.saved.paused, wasPaused);
  } finally { await app.close(); }
});

test('the production collector reads only the getter, never performs lookups or changes DNS settings', async () => {
  const source = await fs.readFile(new URL('../app/dns-tools.mjs', import.meta.url), 'utf8');
  assert.match(source, /readServers = \(\) => dns\.getServers\(\)/);
  assert.doesNotMatch(source, /dns\.(?:lookup|lookupService|resolve\w*|reverse|setServers|setLocalAddress|setDefaultResultOrder)\s*\(|node:child_process|node:fs|fetch\s*\(/);
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-dns-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
