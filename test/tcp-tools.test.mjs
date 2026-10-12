import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-tcp-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { tcpQuery, collectTcp, inspectTcp, tcpReport } = await import('../app/tcp-tools.mjs');
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });
const { describeProgress } = await import('../app/public/progress.js');
const connection = (patch = {}) => ({ remoteAddress: '192.0.2.8', remotePort: 443, remoteFamily: 'IPv4',
  localAddress: '192.0.2.9', localPort: 50000, localFamily: 'IPv4', ...patch });
const evidence = (patch = {}) => ({ version: 1, kind: 'tcp', endpoint: '192.0.2.8:443', status: 'passed', error: null,
  observedAt: '2026-10-12T00:00:00.000Z', system: { platform: 'win32', release: 'fixture', runtimeArchitecture: 'arm64' },
  elapsedMs: 1.25, deadlineMs: 5000, cleanup: 'destroyed', connection: connection(), ...patch });
const failed = (patch = {}) => evidence({ status: 'blocked', connection: null, error: { stage: 'TCP connection', code: 'ECONNREFUSED', message: 'The connection was refused.' }, ...patch });
const inspect = raw => inspectTcp('192.0.2.8:443', async () => raw);
const verifyInvalid = result => {
  assert.equal(result.status, 'blocked'); assert.equal(result.connection, null); assert.equal(result.elapsedMs, undefined);
  assert.equal(result.cleanup, undefined); assert.match(tcpReport(result), /check is blocked/);
};
class FakeSocket extends EventEmitter {
  destroyed = false; calls = []; destroys = 0;
  constructor(connect = socket => queueMicrotask(() => socket.emit('connect')), peer = connection()) { super(); Object.assign(this, peer); this.attempt = connect; }
  connect(options) { this.calls.push(options); this.attempt(this); return this; }
  destroy() { this.destroys++; this.destroyed = true; this.emit('close'); return this; }
}
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
async function loopbackServer(host) {
  let attempts = 0, receivedBytes = 0, resolveClosed;
  const sockets = new Set(), closedConnection = new Promise(resolve => { resolveClosed = resolve; });
  const server = net.createServer(socket => {
    attempts++; sockets.add(socket);
    socket.on('data', bytes => { receivedBytes += bytes.length; });
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); resolveClosed(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host, port: 0 }, resolve); });
  const port = server.address().port;
  return { endpoint: `${host.includes(':') ? `[${host}]` : host}:${port}`, port,
    get attempts() { return attempts; }, get receivedBytes() { return receivedBytes; },
    async waitForClose() {
      let timer;
      try { await Promise.race([closedConnection, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The fixture connection did not close.')), 2000); })]); }
      finally { clearTimeout(timer); }
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  };
}

test('TCP intent accepts one explicit IPv4 or bracketed IPv6 endpoint and rejects operation options', () => {
  assert.deepEqual(tcpQuery(' check TCP 192.0.2.8:443 '), { endpoint: '192.0.2.8:443' });
  assert.deepEqual(tcpQuery('CHECK TCP [2001:0DB8:0:0:0:0:0:8]:65535'), { endpoint: '[2001:db8::8]:65535' });
  for (const message of ['show networking', 'connect to 192.0.2.8', 'check TCP 192.0.2.8:443\ncommands', null, 1]) assert.equal(tcpQuery(message), null);
  for (const value of ['', 'fixture.test:443', 'https://192.0.2.8:443', 'user:secret@192.0.2.8:443', '192.0.2.8:0', '192.0.2.8:65536',
    '192.0.2.8:0443', '192.0.2.8:1-80', '192.0.2.8:443; commands', '192.0.2.8:443 send data', '192.0.2.8', '192.0.002.8:443',
    '[fe80::1%2]:443', '2001:db8::8:443', '[192.0.2.8]:443', '[bad]:443', 'pipe:443', 'bad\u0000address:443']) assert.throws(() => tcpQuery('check TCP' + (value ? ' ' + value : '')));
});

test('invalid targets, socket factories and deadlines are rejected before socket creation or collection', async () => {
  let calls = 0;
  for (const value of [null, {}, 'fixture.test:443', 'bad', '192.0.2.8:65536']) {
    await assert.rejects(collectTcp(value, { makeSocket: () => { calls++; } }));
    await assert.rejects(inspectTcp(value, () => { calls++; }));
  }
  for (const deadlineMs of [0, -1, 5001, 0.5, Infinity, null]) await assert.rejects(collectTcp('192.0.2.8:443', { deadlineMs, makeSocket: () => { calls++; } }), /deadline/);
  await assert.rejects(collectTcp('192.0.2.8:443', { makeSocket: null }), /dedicated/); assert.equal(calls, 0);
});

test('one dedicated socket receives only fixed connection options and is destroyed after peer metadata is captured', async () => {
  const socket = new FakeSocket(); let factories = 0;
  const raw = await collectTcp('192.0.2.8:443', { makeSocket: (...args) => { factories++; assert.deepEqual(args, []); return socket; } });
  assert.equal(factories, 1); assert.deepEqual(socket.calls, [{ host: '192.0.2.8', port: 443, family: 4, autoSelectFamily: false }]);
  assert.equal(socket.destroys, 1); assert.equal(raw.cleanup, 'destroyed'); assert.equal(raw.status, 'passed'); assert.equal(raw.error, null);
  assert.deepEqual(raw.connection, connection()); assert.ok(raw.elapsedMs >= 0); assert.equal(raw.deadlineMs, 5000);
  assert.equal((await inspect(raw)).status, 'passed');
});

test('IPv6 and IPv4-mapped IPv6 peer spellings are compared as canonical literal addresses without family fallback', async () => {
  const socket = new FakeSocket(undefined, connection({ remoteAddress: '::ffff:192.0.2.8', remoteFamily: 'IPv6', localAddress: '::1', localFamily: 'IPv6' }));
  const raw = await collectTcp('[::ffff:192.0.2.8]:443', { makeSocket: () => socket });
  assert.equal(raw.endpoint, '[::ffff:c000:208]:443'); assert.equal(raw.connection.remoteAddress, '::ffff:c000:208');
  assert.deepEqual(socket.calls, [{ host: '::ffff:c000:208', port: 443, family: 6, autoSelectFamily: false }]);
  const result = await inspectTcp('[0:0:0:0:0:ffff:c000:208]:443', async () => raw); assert.equal(result.status, 'passed');
});

test('refused, denied, unknown and null socket errors become blocked observations and always destroy the socket', async () => {
  for (const error of [{ code: 'ECONNREFUSED', message: 'Refused' }, { code: 'EPERM', message: 'Policy denied. Bearer fixture-secret' },
    { code: 'INVENTED', message: 'Unknown error' }, null, undefined, 'Denied', {}]) {
    const socket = new FakeSocket(value => value.emit('error', error));
    const result = await inspectTcp('192.0.2.8:443', target => collectTcp(target, { makeSocket: () => socket }));
    assert.equal(result.status, 'blocked'); assert.equal(result.connection, null); assert.equal(result.cleanup, 'destroyed'); assert.equal(socket.destroys, 1);
    assert.doesNotMatch(tcpReport(result), /fixture-secret/); assert.ok(result.error.code); assert.ok(result.error.message);
  }
  const socket = new FakeSocket(() => { throw new Error('Connection initialization failed.'); });
  const raw = await collectTcp('192.0.2.8:443', { makeSocket: () => socket }); assert.equal(raw.error.stage, 'TCP initialization'); assert.equal(socket.destroys, 1);
});

test('early close before a confirmed connection cannot become success', async () => {
  const socket = new FakeSocket(value => value.emit('close'));
  const result = await inspectTcp('192.0.2.8:443', target => collectTcp(target, { makeSocket: () => socket }));
  assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'ECONNRESET'); assert.equal(result.connection, null); assert.equal(socket.destroys, 1);
});

test('the monotonic deadline destroys a silent socket and ignores late success, error and close events', async () => {
  const socket = new FakeSocket(() => {}), started = performance.now();
  const raw = await collectTcp('192.0.2.8:443', { makeSocket: () => socket, deadlineMs: 25 });
  assert.equal(raw.status, 'blocked'); assert.equal(raw.error.code, 'ETIMEDOUT'); assert.equal(raw.error.stage, 'TCP timeout');
  assert.ok(raw.elapsedMs >= 25); assert.ok(performance.now() - started >= 25); assert.equal(socket.destroys, 1); assert.equal(socket.calls.length, 1);
  const receipt = JSON.stringify(raw); socket.emit('connect'); socket.emit('error', new Error('Late error')); socket.emit('close');
  assert.equal(JSON.stringify(raw), receipt); assert.equal(socket.destroys, 1); assert.equal((await inspect(raw)).status, 'blocked');
});

test('socket setup that already consumed its deadline never starts a late network attempt', async () => {
  const socket = new FakeSocket();
  const raw = await collectTcp('192.0.2.8:443', { deadlineMs: 1, makeSocket: () => {
    const stop = performance.now() + 10; while (performance.now() < stop) { /* Simulated synchronous setup delay. */ } return socket;
  } });
  assert.equal(raw.status, 'blocked'); assert.equal(raw.error.code, 'ETIMEDOUT'); assert.equal(socket.calls.length, 0); assert.equal(socket.destroys, 1);
});

test('missing socket APIs, factory failures and unconfirmed destruction cannot yield confirmed connections', async () => {
  const absent = await collectTcp('192.0.2.8:443', { makeSocket: () => null }); assert.equal(absent.cleanup, 'not-created'); assert.equal(absent.error.stage, 'TCP initialization');
  assert.equal((await inspect(absent)).status, 'blocked');
  const factory = await collectTcp('192.0.2.8:443', { makeSocket: () => { throw null; } }); assert.equal(factory.cleanup, 'not-created'); assert.match(factory.error.message, /did not complete/);
  const incomplete = await collectTcp('192.0.2.8:443', { makeSocket: () => ({}) }); assert.equal(incomplete.cleanup, 'unconfirmed'); assert.equal(incomplete.error.stage, 'TCP cleanup');
  for (const release of [() => { throw new Error('Cannot destroy socket'); }, () => {}]) {
    const socket = new FakeSocket(); socket.destroy = release;
    const result = await inspectTcp('192.0.2.8:443', target => collectTcp(target, { makeSocket: () => socket }));
    assert.equal(result.status, 'blocked'); assert.equal(result.cleanup, 'unconfirmed'); assert.equal(result.connection, null); assert.equal(result.error.stage, 'TCP cleanup');
  }
});

test('unsupported envelopes, redirected targets and invalid clocks or deadlines fail closed without partial endpoint readings', async () => {
  for (const raw of [null, evidence({ version: 2 }), evidence({ kind: 'networking' }), evidence({ endpoint: '192.0.2.9:443' }), evidence({ status: 'unknown' }),
    evidence({ observedAt: 'invalid' }), evidence({ observedAt: '2026-10-12' }), evidence({ system: null }), evidence({ system: { ...evidence().system, release: 'x'.repeat(129) } }),
    ...[null, undefined, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(elapsedMs => evidence({ elapsedMs })),
    ...[undefined, 0, 5001, 0.5].map(deadlineMs => evidence({ deadlineMs })), evidence({ cleanup: 'unknown' })]) verifyInvalid(await inspect(raw));
});

test('successful evidence requires a matching peer, complete local endpoints, no error and confirmed cleanup before its deadline', async () => {
  for (const patch of [{ remoteAddress: '192.0.2.9' }, { remotePort: 444 }, { remoteFamily: 'IPv6' }, { localAddress: undefined }, { localFamily: 'IPv6' },
    { localPort: 0 }, { localPort: 65536 }, { localPort: '50000' }, { localAddress: 'bad' }]) verifyInvalid(await inspect(evidence({ connection: connection(patch) })));
  for (const patch of [{ error: undefined }, { error: false }, { error: {} }, { cleanup: 'not-created' }, { cleanup: 'unconfirmed' },
    { elapsedMs: 5000 }, { elapsedMs: 5001 }, { connection: null }]) verifyInvalid(await inspect(evidence(patch)));
  const socket = new FakeSocket(undefined, connection({ remotePort: 444 }));
  const raw = await collectTcp('192.0.2.8:443', { makeSocket: () => socket }); assert.equal(raw.status, 'blocked'); assert.equal(raw.error.stage, 'TCP evidence'); assert.equal(socket.destroys, 1);
});

test('blocked evidence requires consistent diagnostics without a concealed connection or contradictory cleanup state', async () => {
  for (const patch of [{ error: null }, { error: {} }, { error: { code: 'INVENTED', stage: 'TCP connection', message: 'Denied' } },
    { error: { code: 'EPERM', stage: '', message: 'Denied' } }, { error: { code: 'EPERM', stage: 'TCP connection', message: ' ' } },
    { connection: connection() }, { connection: undefined }, { cleanup: 'not-created' }, { cleanup: 'unconfirmed' },
    { error: { code: 'UNKNOWN', stage: 'TCP cleanup', message: 'Failed' } },
    { error: { code: 'ETIMEDOUT', stage: 'TCP timeout', message: 'Timed out' } }]) verifyInvalid(await inspect(failed(patch)));
  const valid = await inspect(failed({ error: { code: 'ETIMEDOUT', stage: 'TCP timeout', message: 'Timed out' }, elapsedMs: 6000 }));
  assert.equal(valid.status, 'blocked'); assert.equal(valid.elapsedMs, 6000); assert.equal(valid.error.code, 'ETIMEDOUT');
});

test('literal endpoint and whitelisted observations exclude credentials and caller hardware or service-health claims', async () => {
  const raw = evidence({ credentials: 'private-field', hardwareAccepted: true }); raw.connection.owner = 'private-field';
  const result = await inspectTcp('192.0.2.8:443', async (...args) => { assert.deepEqual(args, ['192.0.2.8:443']); return raw; });
  assert.equal(result.status, 'passed'); assert.doesNotMatch(JSON.stringify(result), /private-field|hardwareAccepted/);
  const denied = await inspect(failed({ error: { code: 'EPERM', stage: 'TCP connection', message: 'Denied. Bearer fixture-secret ' + 'x'.repeat(1024) } }));
  assert.doesNotMatch(JSON.stringify(denied), /fixture-secret/); assert.ok(denied.error.message.length <= 512);
  for (const failure of [null, undefined, '', {}, 123]) { const value = await inspectTcp('192.0.2.8:443', async () => { throw failure; }); verifyInvalid(value); assert.match(value.error.message, /did not complete/); }
});

test('elapsed zero and fractional milliseconds are retained without becoming ping latency or application health', async () => {
  for (const elapsedMs of [0, 0.125, 4999.75]) {
    const result = await inspect(evidence({ elapsedMs })); assert.equal(result.status, 'passed'); assert.equal(result.elapsedMs, elapsedMs);
    assert.match(tcpReport(result), /not a ping latency/); assert.match(tcpReport(result), /TLS, HTTP, authentication, application health/);
  }
});

test('real IPv4 loopback confirms one transport connection, sends no application bytes and releases its socket', async () => {
  const fixture = await loopbackServer('127.0.0.1'), familyDefault = net.getDefaultAutoSelectFamily();
  try {
    const result = await inspectTcp(fixture.endpoint); assert.equal(result.status, 'passed'); assert.equal(result.connection.remotePort, fixture.port);
    assert.equal(result.connection.remoteAddress, '127.0.0.1'); assert.equal(result.connection.localAddress, '127.0.0.1'); assert.equal(result.cleanup, 'destroyed');
    await fixture.waitForClose(); assert.equal(fixture.attempts, 1); assert.equal(fixture.receivedBytes, 0); assert.equal(net.getDefaultAutoSelectFamily(), familyDefault);
  } finally { await fixture.close(); }
});

test('real IPv6 loopback uses the literal IPv6 endpoint without hostname resolution or fallback', async context => {
  let fixture;
  try { fixture = await loopbackServer('::1'); }
  catch (error) { if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { context.skip('The host has no IPv6 loopback fixture support.'); return; } throw error; }
  try {
    const result = await inspectTcp(fixture.endpoint); assert.equal(result.status, 'passed'); assert.equal(result.connection.remoteFamily, 'IPv6');
    assert.equal(result.connection.localFamily, 'IPv6'); assert.equal(result.connection.remoteAddress, '::1');
    await fixture.waitForClose(); assert.equal(fixture.attempts, 1); assert.equal(fixture.receivedBytes, 0);
  } finally { await fixture.close(); }
});

test('a real closed fixture listener yields a blocked refusal instead of fabricated connection endpoints', async () => {
  const fixture = await loopbackServer('127.0.0.1'), target = fixture.endpoint; await fixture.close();
  const result = await inspectTcp(target); assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'ECONNREFUSED');
  assert.equal(result.connection, null); assert.equal(result.cleanup, 'destroyed'); assert.ok(result.elapsedMs >= 0);
});

test('session authorization gates TCP checks, ignores supplied socket options and persists the result without account sign-in', async () => {
  const fake = new FakeCodex(); let calls = 0;
  let app = await createApplication({ port: 0, codex: fake, autostart: false, tcpCollector: async (...args) => { calls++; assert.deepEqual(args, ['192.0.2.8:443']); return evidence(); } });
  try {
    const unauthorized = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'check TCP 192.0.2.8:443' }) });
    assert.equal(unauthorized.status, 403); assert.equal(calls, 0);
    const entry = await fetch(app.origin), html = await entry.text();
    const headers = { cookie: entry.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-Volterra-Client': html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1] };
    const crossOrigin = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ text: 'check TCP 192.0.2.8:443' }) });
    assert.equal(crossOrigin.status, 403); assert.equal(calls, 0);
    const response = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers, body: JSON.stringify({ text: 'check TCP 192.0.2.8:443', host: 'other.test', port: 80, timeout: 0, payload: 'private-field', retries: 10 }) });
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.tool, 'tcp'); assert.equal(result.status, 'passed'); assert.equal(calls, 1);
    assert.equal(fake.calls.length, 0); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(item => item.type === 'output' && item.data.delta?.startsWith('TCP connection confirmed')); assert.ok(output);
    await app.close(); app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false });
    assert.ok(app.snapshot().journal.some(item => item.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('checking retains active turns and pauses, respects permission priority and prevents overlapping system tools', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, tcpCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' }); await app.automation.pause();
    const before = fake.calls.length, request = app.actions['agent/send']({ text: 'check TCP 192.0.2.8:443' });
    assert.equal(describeProgress(app.snapshot()).title, 'Checking a TCP connection'); assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(describeProgress({ ...app.snapshot(), approvals: [{}] }).phase, 'question'); assert.equal(describeProgress(app.snapshot(), false).phase, 'disconnected');
    await assert.rejects(app.actions['agent/send']({ text: 'show networking' }), /already running/); await assert.rejects(app.actions['agent/send']({ text: 'check TCP 192.0.2.8:443' }), /already running/);
    release(evidence()); await request; assert.equal(fake.calls.length, before); assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('blocked TCP diagnostics survive restart and a new check recovers without starting additional agent work', async () => {
  let reads = 0, app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false, tcpCollector: async () => {
    if (++reads === 1) throw null; return failed({ error: { code: 'EPERM', stage: 'TCP connection', message: 'Network permission denied.' } });
  } });
  try {
    assert.equal((await app.actions['agent/send']({ text: 'check TCP 192.0.2.8:443' })).status, 'blocked'); assert.equal(app.snapshot().systemTool, null);
    const denied = await app.actions['agent/send']({ text: 'check TCP 192.0.2.8:443' }); assert.equal(denied.error.code, 'EPERM'); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(item => item.type === 'output' && item.data.delta?.includes('Network permission denied.')); assert.ok(output);
    await app.close(); const fake = new FakeCodex(); app = await createApplication({ port: 0, codex: fake, autostart: false, tcpCollector: async () => evidence() });
    const before = fake.calls.length; assert.ok(app.snapshot().journal.some(item => item.data?.itemId === output.data.itemId));
    assert.equal((await app.actions['agent/send']({ text: 'check TCP 192.0.2.8:443' })).status, 'passed'); assert.equal(fake.calls.length, before);
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-tcp-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
