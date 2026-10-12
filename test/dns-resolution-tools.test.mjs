import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-resolution-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { resolutionQuery, collectResolution, inspectResolution, resolutionReport } = await import('../app/dns-resolution-tools.mjs');
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });
const { describeProgress } = await import('../app/public/progress.js');
const answer = (type = 'A', records = [{ address: '192.0.2.8', ttl: 60 }]) => ({ type, status: 'passed', records, error: null });
const negative = (type = 'AAAA', code = 'ENODATA') => ({ type, status: 'negative', records: [], error: { code, stage: `${type} query`, message: 'No address answer.' } });
const failed = (type = 'AAAA', code = 'ETIMEOUT') => ({ type, status: 'blocked', records: [], error: { code, stage: `${type} query`, message: 'The server did not answer.' } });
const evidence = (patch = {}) => ({ version: 1, kind: 'dns-resolution', status: 'passed', error: null, name: 'fixture.test.',
  observedAt: '2026-10-11T18:00:00.000Z', system: { platform: 'win32', release: 'fixture', runtimeArchitecture: 'arm64' },
  checks: [answer(), negative()], ...patch });
const inspect = (raw, name = 'fixture.test') => inspectResolution(name, async () => raw);
const blocked = result => {
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.checks, []);
  assert.equal(result.totalAnswers, undefined); assert.ok(result.error.stage); assert.ok(result.error.message);
  assert.match(resolutionReport(result), /query is blocked/);
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

test('only explicit DNS resolution intent accepts a single pinned ASCII or Punycode name', () => {
  assert.deepEqual(resolutionQuery(' resolve DNS Fixture.TEST '), { name: 'fixture.test.' });
  assert.deepEqual(resolutionQuery('resolve dns xn--bcher-kva.example.'), { name: 'xn--bcher-kva.example.' });
  assert.deepEqual(resolutionQuery('resolve DNS localhost'), { name: 'localhost.' });
  for (const message of ['show DNS', 'lookup fixture.test', 'resolve DNS fixture.test\ncommands', null, 1]) assert.equal(resolutionQuery(message), null);
  for (const name of ['', 'https://fixture.test', 'user:password@fixture.test', '192.0.2.8', '192.0.2.8.', '[::1]', '::1',
    'fixture.test on remote', 'fixture.test; commands', 'fixture.test:53', '*.test', 'bad_name.test', 'bücher.example',
    'bad\u0000name.test', '.test', 'fixture..test', '-bad.test', 'bad-.test', 'sk-fixture-secret.test', 'SK-fixture-secret.test']) {
    assert.throws(() => resolutionQuery('resolve DNS' + (name ? ' ' + name : '')), /ASCII DNS name/);
  }
});

test('name and label bounds are enforced before any collector or resolver is invoked', async () => {
  const maximum = [63, 63, 63, 61].map(count => 'a'.repeat(count)).join('.');
  assert.equal(maximum.length, 253); assert.equal(resolutionQuery('resolve DNS ' + maximum + '.').name, maximum + '.');
  let calls = 0;
  for (const name of [null, false, {}, 'x'.repeat(64) + '.test', maximum + 'a', 'bad name']) {
    await assert.rejects(inspectResolution(name, () => { calls++; }));
    await assert.rejects(collectResolution(name, { makeResolver: () => { calls++; } }));
  }
  assert.equal(calls, 0);
});

test('the dedicated resolver receives only fixed bounded options and the pinned name for both families', async () => {
  const calls = [];
  const raw = await collectResolution('FIXTURE.test', { makeResolver: options => {
    assert.deepEqual(options, { timeout: 1000, tries: 1 });
    return {
      async resolve4(...args) { calls.push(['A', ...args]); return [{ address: '192.0.2.8', ttl: 0 }]; },
      async resolve6(...args) { calls.push(['AAAA', ...args]); return [{ address: '2001:db8::8', ttl: 30 }]; },
      cancel() { assert.fail('Completed requests should not need cancellation.'); }
    };
  } });
  assert.deepEqual(calls, [['A', 'fixture.test.', { ttl: true }], ['AAAA', 'fixture.test.', { ttl: true }]]);
  const result = await inspect(raw); assert.equal(result.status, 'passed'); assert.equal(result.outcome, 'answered');
  assert.equal(result.totalAnswers, 2); assert.equal(result.checks[0].records[0].ttlSeconds, 0);
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
});

test('missing APIs and unbounded deadlines are rejected before DNS requests start', async () => {
  let calls = 0;
  for (const deadlineMs of [0, -1, 5001, 0.5, null, Infinity]) {
    await assert.rejects(collectResolution('fixture.test', { deadlineMs, makeResolver: () => { calls++; } }), /bounded/);
  }
  for (const resolver of [null, {}, { resolve4() { calls++; }, resolve6() { calls++; } }]) {
    const result = await inspectResolution('fixture.test', () => collectResolution('fixture.test', { makeResolver: () => resolver }));
    blocked(result);
  }
  assert.equal(calls, 0);
});

test('negative DNS answers remain distinct from timeout, refusal and unknown failures', async () => {
  for (const code of ['ENODATA', 'ENOTFOUND', 'ETIMEOUT', 'EREFUSED', 'ESERVFAIL', 'UNKNOWN']) {
    const result = await inspectResolution('fixture.test', () => collectResolution('fixture.test', { makeResolver: () => ({
      async resolve4() { return answer().records; }, async resolve6() { throw Object.assign(new Error('Fixture failure.'), { code }); }, cancel() {}
    }) }));
    assert.equal(result.status, ['ENODATA', 'ENOTFOUND'].includes(code) ? 'passed' : 'blocked');
    assert.equal(result.checks[1].status, ['ENODATA', 'ENOTFOUND'].includes(code) ? 'negative' : 'blocked');
    assert.equal(result.checks[1].error.code, code); assert.equal(result.totalAnswers, 1);
  }
  const result = await inspect(evidence({ checks: [negative('A', 'ENOTFOUND'), negative()] }));
  assert.equal(result.status, 'passed'); assert.equal(result.outcome, 'no-addresses'); assert.equal(result.totalAnswers, 0);
  assert.match(resolutionReport(result), /Neither family returned an address answer/);
  assert.equal(result.connectivityPassed, undefined);
});

test('null query failures and unknown codes produce redacted family diagnostics', async () => {
  for (const error of [null, undefined, Object.assign(new Error('Denied. Bearer fixture-secret'), { code: 'private-code' })]) {
    const result = await inspectResolution('fixture.test', () => collectResolution('fixture.test', { makeResolver: () => ({
      async resolve4() { throw error; }, async resolve6() { throw error; }, cancel() {}
    }) }));
    assert.equal(result.status, 'blocked'); assert.equal(result.outcome, 'incomplete'); assert.equal(result.totalAnswers, 0);
    assert.ok(result.checks.every(check => check.error.code === 'UNKNOWN' && check.error.message));
    assert.doesNotMatch(resolutionReport(result), /fixture-secret|private-code/);
  }
});

test('the overall deadline cancels only its resolver and retains an already completed family', async () => {
  let cancellations = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const result = await inspectResolution('fixture.test', () => collectResolution('fixture.test', { deadlineMs: 10, makeResolver: () => ({
    async resolve4() { return answer().records; }, resolve6() { return pending; },
    cancel() { cancellations++; release([{ address: '2001:db8::99', ttl: 60 }]); }
  }) }));
  assert.equal(cancellations, 1); assert.equal(result.status, 'blocked'); assert.equal(result.totalAnswers, 1);
  assert.equal(result.checks[0].status, 'passed'); assert.equal(result.checks[1].error.code, 'ETIMEOUT');
  assert.doesNotMatch(JSON.stringify(result), /2001:db8::99/); assert.match(resolutionReport(result), /Resolution remains incomplete/);
});

test('failed cancellation is reported without inventing an address answer or hanging the chat', async () => {
  const pending = new Promise(() => {});
  const result = await inspectResolution('fixture.test', () => collectResolution('fixture.test', { deadlineMs: 10, makeResolver: () => ({
    resolve4() { return pending; }, resolve6() { return pending; }, cancel() { throw new Error('Cannot cancel.'); }
  }) }));
  assert.equal(result.status, 'blocked'); assert.equal(result.totalAnswers, 0);
  assert.match(resolutionReport(result), /Cancellation could not be confirmed/);
});

test('missing, duplicate and conflicting family evidence fails without partial counts', async () => {
  const sparse = Array(2); sparse[1] = negative();
  for (const checks of [[], Array(2), sparse, [answer(), null], [answer(), answer()], [answer(), negative('MX')],
    [answer('A', []), negative()], [{ ...answer(), error: { code: 'ETIMEOUT', stage: 'A', message: 'Failed' } }, negative()],
    [answer(), { ...failed(), records: [{ address: '2001:db8::8', ttl: 1 }] }],
    [answer(), { ...negative(), error: { code: 'ETIMEOUT', stage: 'AAAA', message: 'Failed' } }],
    [answer(), { ...failed(), error: { code: 'ENODATA', stage: 'AAAA', message: 'No data' } }]]) {
    blocked(await inspect(evidence({ checks })));
  }
  blocked(await inspect(evidence({ status: 'blocked' })));
  blocked(await inspect(evidence({ checks: [answer(), failed()] })));
  for (const error of [null, {}, { code: 'ETIMEOUT', stage: ' ', message: 'Failed' }, { code: 'ETIMEOUT', stage: 'AAAA', message: '\u0000' }]) {
    blocked(await inspect(evidence({ status: 'blocked', checks: [answer(), { ...failed(), error }] })));
  }
});

test('every answer requires the right IP family and an exact bounded TTL before any counts', async () => {
  const maximum = await inspect(evidence({ checks: [answer('A', [{ address: '192.0.2.8', ttl: 0xffff_ffff }]), negative()] }));
  assert.equal(maximum.checks[0].records[0].ttlSeconds, 0xffff_ffff);
  for (const record of [null, {}, { address: '2001:db8::8', ttl: 0 }, { address: 'host.test', ttl: 0 },
    { address: '192.0.2.8:53', ttl: 0 }, ...[undefined, null, '0', false, -1, 0.5, NaN, Infinity, 0x1_0000_0000, 1n].map(ttl => ({ address: '192.0.2.8', ttl }))]) {
    blocked(await inspect(evidence({ checks: [answer('A', [answer().records[0], record]), negative()] })));
  }
  blocked(await inspect(evidence({ checks: [answer('A', Array(1)), negative()] })));
  blocked(await inspect(evidence({ checks: [answer('A', Array(257).fill(answer().records[0])), negative()] })));
  blocked(await inspect(evidence({ checks: [answer(), answer('AAAA', [{ address: 'fe80::1%private', ttl: 0 }])] })));
});

test('the evidence must match the exact name, timestamp, kind and runtime metadata', async () => {
  for (const raw of [null, evidence({ name: 'other.test.' }), evidence({ name: 'fixture.test' }), evidence({ version: 2 }),
    evidence({ kind: 'dns' }), evidence({ error: {} }), evidence({ status: 'unknown' }), evidence({ observedAt: '2026-10-11' }),
    evidence({ system: {} }), evidence({ system: { ...evidence().system, release: 'x'.repeat(129) } })]) blocked(await inspect(raw));
  for (const collect of [async () => { throw null; }, async () => { throw undefined; }]) blocked(await inspectResolution('fixture.test', collect));
});

test('reports preserve returned order and duplicates while bounding displayed answers', async () => {
  const records = Array.from({ length: 41 }, (_, index) => ({ address: '192.0.2.8', ttl: index }));
  const result = await inspect(evidence({ checks: [negative('AAAA'), answer('A', records)] }));
  assert.equal(result.totalAnswers, 41); assert.equal(result.checks[0].type, 'A');
  assert.deepEqual(result.checks[0].records.map(record => record.ttlSeconds), Array.from({ length: 41 }, (_, index) => index));
  const report = resolutionReport(result); assert.match(report, /Showing 40 of 41 A answers/);
  assert.equal((report.match(/192\.0\.2\.8 · TTL/g) || []).length, 40); assert.doesNotMatch(report, /TTL 40 seconds/);
});

test('only whitelisted answer evidence enters history and no connectivity or acceptance claim is invented', async () => {
  const result = await inspect(evidence({ accepted: true, source: 'private-provider', secret: 'private-envelope',
    checks: [answer('A', [{ address: '192.0.2.8', ttl: 0, secret: 'private-record', healthy: true }]), negative()] }));
  const report = resolutionReport(result);
  assert.doesNotMatch(JSON.stringify(result), /private-provider|private-envelope|private-record|accepted|healthy/);
  for (const pattern of [/sends DNS queries/,/not an atomic snapshot/,/does not consult the hosts file/,/application connectivity/,/DNS authenticity/,/Validation OS\/hardware acceptance/,/no resolver or OS settings are changed/]) assert.match(report, pattern);
});

test('chat authorization protects resolution and supplied server or record options never reach the collector', async () => {
  let calls = 0; const fake = new FakeCodex();
  const options = { port: 0, autostart: false, resolutionCollector: async (...args) => { calls++; assert.deepEqual(args, ['fixture.test.']); return evidence(); } };
  let app = await createApplication({ ...options, codex: fake });
  try {
    const send = (headers, text = 'resolve DNS Fixture.test') => fetch(app.origin + '/api/agent/send', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ text, servers: ['203.0.113.53'], rrtype: 'TXT', hostname: 'other.test', timeout: -1 }) });
    assert.equal((await send({})).status, 403); assert.equal(calls, 0);
    const page = await fetch(app.origin), html = await page.text(), cookie = page.headers.get('set-cookie').split(';')[0];
    const token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1], headers = { cookie, 'X-Volterra-Client': token };
    assert.equal((await send({ cookie })).status, 403); assert.equal((await send({ ...headers, Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await send(headers, 'resolve DNS fixture.test:53')).status, 400); assert.equal(calls, 0);
    const before = [...fake.calls], response = await send(headers), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.tool, 'dns-resolution'); assert.equal(result.outcome, 'answered');
    assert.equal(calls, 1); assert.deepEqual(fake.calls, before); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('TTL 60 seconds'));
    assert.ok(output); await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('DNS query checking preserves jobs, pauses and permission questions and excludes concurrent tools', async () => {
  const fake = new FakeCodex(); let release, request;
  const pending = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, autostart: false, codex: fake, resolutionCollector: () => pending });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' }); await app.automation.pause();
    const before = [...fake.calls]; request = app.actions['agent/send']({ text: 'resolve DNS fixture.test' });
    const snapshot = app.snapshot(); assert.equal(snapshot.systemTool.kind, 'dns-resolution'); assert.equal(describeProgress(snapshot).phase, 'checking');
    assert.equal(snapshot.progress.since, snapshot.systemTool.since); assert.equal(describeProgress({ ...snapshot, approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress({ ...snapshot, interruptRequested: true }).phase, 'stopping'); assert.equal(describeProgress(snapshot, false).phase, 'disconnected');
    for (const text of ['resolve DNS fixture.test', 'show DNS', 'show processors', 'show files']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence()); await request; assert.deepEqual(fake.calls, before);
    assert.equal(app.snapshot().activeTurn, 'fixture-turn'); assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await request; await app.close(); }
});

test('failed query output survives restart and a later negative answer does not resume a saved pause', async () => {
  let app = await createApplication({ port: 0, autostart: false, codex: new FakeCodex(), resolutionCollector: async () => { throw null; } });
  try {
    await app.automation.pause(); blocked(await app.actions['agent/send']({ text: 'resolve DNS fixture.test' }));
    const output = app.snapshot().journal.findLast(entry => entry.type === 'output' && entry.data.delta?.includes('DNS address query is blocked'));
    assert.ok(output); assert.equal(app.snapshot().systemTool, null); await app.close();
    const fake = new FakeCodex(); app = await createApplication({ port: 0, autostart: false, codex: fake,
      resolutionCollector: async () => evidence({ checks: [negative('A'), negative()] }) });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const before = [...fake.calls], result = await app.actions['agent/send']({ text: 'resolve DNS fixture.test' });
    assert.equal(result.outcome, 'no-addresses'); assert.equal(result.totalAnswers, 0); assert.deepEqual(fake.calls, before);
    assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { await app.close(); }
});

async function dnsFixture(mode, work) {
  const socket = dgram.createSocket('udp4'), requests = [], faults = [];
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
  socket.on('message', (packet, remote) => {
    try {
      assert.equal(remote.address, '127.0.0.1'); assert.equal(packet.readUInt16BE(4), 1);
      let offset = 12; const labels = [];
      while (packet[offset]) { const length = packet[offset++]; assert.ok(length <= 63); labels.push(packet.subarray(offset, offset + length).toString('ascii')); offset += length; }
      const type = packet.readUInt16BE(++offset), end = offset + 4; assert.ok([1, 28].includes(type));
      requests.push({ name: labels.join('.') + '.', type });
      if (mode === 'silent') return;
      const header = Buffer.alloc(12); packet.copy(header, 0, 0, 2); header.writeUInt16BE(mode === 'negative' && type === 28 ? 0x8183 : 0x8180, 2); header.writeUInt16BE(1, 4);
      const parts = [header, packet.subarray(12, end)];
      if (mode === 'answers') {
        header.writeUInt16BE(1, 6);
        const bytes = type === 1 ? Buffer.from([192, 0, 2, 8]) : Buffer.from('20010db8000000000000000000000008', 'hex');
        const record = Buffer.alloc(12); record.writeUInt16BE(0xc00c, 0); record.writeUInt16BE(type, 2); record.writeUInt16BE(1, 4);
        record.writeUInt32BE(type === 1 ? 60 : 0, 6); record.writeUInt16BE(bytes.length, 10); parts.push(record, bytes);
      }
      socket.send(Buffer.concat(parts), remote.port, remote.address);
    } catch (error) { faults.push(error); }
  });
  try {
    await work({ requests, makeResolver: options => { const resolver = new Resolver(options); resolver.setServers([`127.0.0.1:${socket.address().port}`]); return resolver; } });
    assert.deepEqual(faults, []);
  } finally { await new Promise(resolve => socket.close(resolve)); }
}

test('the real Node resolver reads A and AAAA answers and TTLs from a fixture-owned loopback DNS server', async () => {
  const before = dns.getServers();
  await dnsFixture('answers', async ({ makeResolver, requests }) => {
    const result = await inspectResolution('fixture.test', name => collectResolution(name, { makeResolver }));
    assert.equal(result.status, 'passed'); assert.equal(result.outcome, 'answered'); assert.equal(result.totalAnswers, 2);
    assert.deepEqual(result.checks.map(check => check.records), [[{ address: '192.0.2.8', ttlSeconds: 60 }], [{ address: '2001:db8::8', ttlSeconds: 0 }]]);
    assert.deepEqual(requests.map(request => request.name), ['fixture.test.', 'fixture.test.']); assert.deepEqual(requests.map(request => request.type).sort((a, b) => a - b), [1, 28]);
  });
  assert.deepEqual(dns.getServers(), before);
});

test('real empty and NXDOMAIN fixture responses remain negative family evidence', async () => {
  await dnsFixture('negative', async ({ makeResolver }) => {
    const result = await inspectResolution('fixture.test', name => collectResolution(name, { makeResolver }));
    assert.equal(result.status, 'passed'); assert.equal(result.outcome, 'no-addresses'); assert.equal(result.totalAnswers, 0);
    assert.deepEqual(result.checks.map(check => check.error.code), ['ENODATA', 'ENOTFOUND']);
  });
});

test('real unanswered loopback DNS queries are cancelled by the overall deadline', async () => {
  await dnsFixture('silent', async ({ makeResolver, requests }) => {
    let cancellations = 0;
    const result = await inspectResolution('fixture.test', name => collectResolution(name, { deadlineMs: 250, makeResolver: options => {
      const resolver = makeResolver(options), cancel = resolver.cancel.bind(resolver);
      resolver.cancel = () => { cancellations++; cancel(); }; return resolver;
    } }));
    assert.equal(result.status, 'blocked'); assert.equal(result.outcome, 'incomplete'); assert.equal(result.totalAnswers, 0);
    assert.ok(result.checks.every(check => check.error.code === 'ETIMEOUT')); assert.equal(cancellations, 1);
    assert.equal(requests.length, 2);
  });
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(path.isAbsolute(directory) && relative.startsWith('volterra-resolution-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
