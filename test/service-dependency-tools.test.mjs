import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-dependency-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { dependencyQuery, collectDependencies, inspectDependencies, dependencyReport } = await import('../app/service-dependency-tools.mjs');
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });
const { describeProgress } = await import('../app/public/progress.js');
const evidence = (patch = {}) => ({ version: 1, kind: 'service-dependencies', status: 'passed', observedAt: '2026-10-11T12:00:00.000Z',
  system: { edition: 'Professional', build: '26200', architecture: 'ARM64' }, services: [
    { name: 'Zulu', displayName: 'Literal [match] service', required: ['DriverOutsideInventory', 'Alpha'], dependents: [] },
    { name: 'Alpha', displayName: 'Example service', required: [], dependents: ['Zulu'] },
    { name: 'Beta', displayName: 'Another service', required: [], dependents: [] }
  ], error: null, ...patch });
const row = () => evidence().services[0];
const blocked = error => evidence({ status: 'blocked', services: [], error });
const verifyBlocked = result => {
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.services, []);
  assert.equal(result.totalCount, undefined); assert.equal(result.matchedCount, undefined);
  assert.match(dependencyReport(result), /dependencies are blocked/);
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

test('dependency intent is precise and metacharacters are literal filter data', () => {
  assert.deepEqual(dependencyQuery('show service dependencies'), { filter: '' });
  assert.deepEqual(dependencyQuery(' LIST service dependencies matching [match] '), { filter: '[match]' });
  assert.deepEqual(dependencyQuery('service dependencies matching $(Stop-Service X); *'), { filter: '$(Stop-Service X); *' });
  for (const message of [null, 'show services', 'show service dependencies and stop Alpha', 'stop service dependencies', 'show service dependencies\nstop Alpha']) assert.equal(dependencyQuery(message), null);
  assert.throws(() => dependencyQuery('show service dependencies matching ' + 'x'.repeat(257)), /256/);
  assert.throws(() => dependencyQuery('show service dependencies matching a\u0000b'), /256/);
});

test('the collector uses one fixed local script and timeout without caller arguments or policy changes', async () => {
  let calls = 0;
  const result = await collectDependencies({ shell: 'fixture-powershell', execute: async (shell, args, options) => {
    calls++; assert.equal(shell, 'fixture-powershell');
    assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-File']);
    assert.equal(path.basename(args.at(-1)), 'Get-ServiceDependencies.ps1'); assert.equal(options.timeout, 15_000);
    return '\uFEFF' + JSON.stringify(evidence());
  } });
  assert.equal(calls, 1); assert.deepEqual(result, evidence());
  await assert.rejects(collectDependencies({ shell: null }), /Windows PowerShell/);
  await assert.rejects(collectDependencies({ shell: 'fixture', execute: async () => 'not JSON' }), SyntaxError);
});

test('required and dependent directions remain distinct without inventing state or rejecting external endpoints', async () => {
  const result = await inspectDependencies('', async (...args) => { assert.deepEqual(args, []); return evidence(); });
  assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 3); assert.equal(result.matchedCount, 3);
  assert.deepEqual(result.services.map(item => item.name), ['Alpha', 'Beta', 'Zulu']);
  assert.deepEqual(result.services[0].dependents, ['Zulu']);
  assert.deepEqual(result.services[2].required, ['Alpha', 'DriverOutsideInventory']);
  assert.deepEqual(result.services[2].dependents, []); assert.equal(result.services[2].status, undefined);
  assert.equal(result.bootAccepted, undefined); assert.equal(result.runtimeAccepted, undefined);
  const report = dependencyReport(result);
  assert.match(report, /Required services: 2 reported/); assert.match(report, /Dependent services: 1 reported/);
  assert.match(report, /not separately enumerated/); assert.match(report, /without recursive traversal/);
  assert.match(report, /do not establish load-order groups, startup viability, service health or Validation OS acceptance/);
});

test('filtering selects service identities literally after complete validation, not related endpoints', async () => {
  const match = await inspectDependencies('[match]', async () => evidence());
  assert.equal(match.totalCount, 3); assert.equal(match.matchedCount, 1); assert.equal(match.services[0].name, 'Zulu');
  for (const filter of ['*', 'DriverOutsideInventory']) {
    const result = await inspectDependencies(filter, async () => evidence());
    assert.equal(result.status, 'passed'); assert.equal(result.matchedCount, 0); assert.match(dependencyReport(result), /No services matched/);
  }
  const invalid = evidence(); invalid.services[1].required = null;
  verifyBlocked(await inspectDependencies('[match]', async () => invalid));
  let called = false;
  await assert.rejects(inspectDependencies('x'.repeat(257), async () => { called = true; }), /256/);
  assert.equal(called, false);
});

test('successful empty inventories and empty dependency lists remain real empty readings', async () => {
  const empty = await inspectDependencies('', async () => evidence({ services: [] }));
  assert.equal(empty.status, 'passed'); assert.equal(empty.totalCount, 0); assert.match(dependencyReport(empty), /provider returned no services/);
  const result = await inspectDependencies('Beta', async () => evidence());
  assert.deepEqual(result.services[0].required, []); assert.deepEqual(result.services[0].dependents, []);
  assert.match(dependencyReport(result), /Empty lists mean none reported by that property/);
});

test('missing and sparse service or relationship positions fail closed before counting', async () => {
  const sparse = Array(2); sparse[1] = 'Alpha';
  for (const services of [Array(2), [row(), undefined], [null], [{ ...row(), required: sparse }],
    ...[undefined, null, {}, [undefined], [null]].flatMap(values => [{ ...row(), required: values }, { ...row(), dependents: values }])]) {
    verifyBlocked(await inspectDependencies('no-match', async () => evidence({ services })));
  }
});

test('duplicate, invalid and redacted-colliding identities are blocked', async () => {
  for (const name of ['', ' ', 'bad/name', 'bad\\name', 'bad\nname', 'x'.repeat(257)]) {
    verifyBlocked(await inspectDependencies('', async () => evidence({ services: [{ ...row(), name }] })));
    verifyBlocked(await inspectDependencies('', async () => evidence({ services: [{ ...row(), required: [name] }] })));
  }
  for (const services of [[row(), { ...row(), name: 'zulu' }], [{ ...row(), required: ['Alpha', 'ALPHA'] }],
    [{ ...row(), required: ['sk-fixture-one', 'sk-fixture-two'] }]]) {
    verifyBlocked(await inspectDependencies('', async () => evidence({ services })));
  }
  const valid = await inspectDependencies('', async () => evidence({ services: [{ ...row(), name: 'x'.repeat(256), displayName: 'y'.repeat(256), required: ['z'.repeat(256)] }] }));
  assert.equal(valid.status, 'passed'); assert.equal(valid.services[0].name.length, 256);
});

test('sequential lists need not form a reciprocal or complete graph and reported cycles are retained without traversal', async () => {
  const result = await inspectDependencies('', async () => evidence({ services: [
    { name: 'One', displayName: 'One', required: ['Two'], dependents: [] },
    { name: 'Two', displayName: 'Two', required: ['One'], dependents: ['External', 'Two'] }
  ] }));
  assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 2);
  assert.deepEqual(result.services[0].dependents, []); assert.deepEqual(result.services[1].required, ['One']);
  assert.deepEqual(result.services[1].dependents, ['External', 'Two']);
  assert.match(dependencyReport(result), /sequentially/);
});

test('inventory, per-list and aggregate relationship bounds reject excessive evidence', async () => {
  verifyBlocked(await inspectDependencies('', async () => evidence({ services: Array(4097) })));
  verifyBlocked(await inspectDependencies('', async () => evidence({ services: [{ ...row(), required: Array(4097) }] })));
  const names = Array.from({ length: 4096 }, (_, index) => `Related${index}`);
  const services = Array.from({ length: 3 }, (_, index) => ({ name: `Owner${index}`, displayName: '', required: names, dependents: names }));
  const result = await inspectDependencies('', async () => evidence({ services }));
  verifyBlocked(result); assert.match(result.error.message, /relationship limit/);
});

test('success/error conflicts and malformed blocked evidence cannot become valid empty readings', async () => {
  for (const error of [undefined, false, {}, { stage: 'Read', message: 'Denied' }]) {
    const result = await inspectDependencies('', async () => evidence({ error }));
    verifyBlocked(result); assert.match(result.error.message, /conflicting/);
  }
  for (const raw of [blocked(null), blocked({ stage: '', message: 'Denied' }), blocked({ stage: 'Read', message: ' ' }),
    blocked({ stage: 'Read', message: {} }), blocked({ stage: 1, message: 'Denied' }),
    { ...blocked({ stage: 'Read', message: 'Denied' }), services: [row()] }]) {
    const result = await inspectDependencies('', async () => raw); verifyBlocked(result); assert.match(result.error.message, /ambiguous/);
  }
  const result = await inspectDependencies('', async () => blocked({ stage: 'SCM dependencies', message: 'Access denied' }));
  assert.equal(result.error.stage, 'SCM dependencies'); assert.equal(result.error.message, 'Access denied');
});

test('unsupported envelopes, metadata and collector failures yield bounded safe blocked diagnostics', async () => {
  for (const raw of [null, evidence({ version: 2 }), evidence({ kind: 'services' }), evidence({ status: 'unknown' }),
    evidence({ observedAt: 'invalid' }), evidence({ system: null }), evidence({ system: { ...evidence().system, build: 'x'.repeat(129) } }),
    evidence({ services: [{ ...row(), displayName: 'x'.repeat(257) }] })]) verifyBlocked(await inspectDependencies('', async () => raw));
  for (const failure of [null, undefined, 'Denied', {}, 123]) {
    const result = await inspectDependencies('', async () => { throw failure; });
    verifyBlocked(result); assert.match(result.error.message, /query did not succeed/);
  }
  const result = await inspectDependencies('', async () => { throw new Error('Read denied. Bearer fixture-secret ' + 'x'.repeat(1000)); });
  verifyBlocked(result); assert.ok(result.error.message.length <= 512); assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});

test('only whitelisted metadata is retained and credential-like text is redacted in results', async () => {
  const result = await inspectDependencies('sk-fixture-filter', async () => evidence({ secret: 'private-field', services: [
    { ...row(), displayName: 'Bearer fixture-secret', executablePath: 'private-field', credentials: 'private-field', required: ['sk-fixture-required'] }
  ] }));
  assert.equal(result.status, 'passed'); assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture-filter|private-field/);
  const all = await inspectDependencies('', async () => evidence({ services: [{ ...row(), required: ['sk-fixture-required'] }] }));
  assert.doesNotMatch(JSON.stringify(all), /fixture-required/);
  assert.deepEqual(Object.keys(all.services[0]).sort(), ['dependents', 'displayName', 'name', 'required']);
  const target = await inspectDependencies('', async () => evidence({ system: { edition: 'WinVOS', build: 'fixture', architecture: 'ARM64' } }));
  assert.match(target.environment, /Validation OS session; VM or physical identity unverified/);
});

test('chat output bounds services and names while the authorized result retains all validated readings', async () => {
  const names = Array.from({ length: 12 }, (_, index) => `Related${index}`);
  const result = await inspectDependencies('', async () => evidence({ services: Array.from({ length: 22 }, (_, index) => ({ name: `Owner${index}`, displayName: 'Service', required: names, dependents: names })) }));
  assert.equal(result.services.length, 22); assert.equal(result.services[0].required.length, 12);
  const report = dependencyReport(result);
  assert.equal(report.match(/Required services: 12 reported/g).length, 20); assert.equal(report.match(/Showing 10 of 12/g).length, 40);
  assert.match(report, /Showing 20 of 22/); assert.ok(report.length < 150_000);
});

test('session authorization gates the chat query, supplied scope fields are ignored, and output survives restart', async () => {
  const fake = new FakeCodex(); let calls = 0;
  let app = await createApplication({ port: 0, codex: fake, autostart: false, dependencyCollector: async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); } });
  try {
    const unauthorized = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'show service dependencies' }) });
    assert.equal(unauthorized.status, 403); assert.equal(calls, 0);
    const entry = await fetch(app.origin), html = await entry.text();
    const cookie = entry.headers.get('set-cookie').split(';')[0], token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1];
    const headers = { cookie, 'Content-Type': 'application/json', 'X-Volterra-Client': token };
    const crossOrigin = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ text: 'show service dependencies' }) });
    assert.equal(crossOrigin.status, 403); assert.equal(calls, 0);
    const response = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers, body: JSON.stringify({ text: 'show service dependencies matching [match]', computer: 'remote', script: 'Stop-Service Alpha' }) });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.tool, 'service-dependencies'); assert.equal(result.matchedCount, 1); assert.equal(calls, 1);
    assert.equal(fake.calls.length, 0); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(item => item.type === 'output' && item.data.delta?.includes('DriverOutsideInventory'));
    assert.ok(output); await app.close();
    app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false });
    assert.ok(app.snapshot().journal.some(item => item.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('deferred checking preserves active jobs, pauses and permission precedence, and excludes overlapping tools', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, dependencyCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' });
    await app.automation.pause(); const before = fake.calls.length;
    const request = app.actions['agent/send']({ text: 'show service dependencies' });
    assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(describeProgress(app.snapshot()).title, 'Reading service dependencies');
    assert.equal(describeProgress({ ...app.snapshot(), approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress(app.snapshot(), false).phase, 'disconnected');
    await assert.rejects(app.actions['agent/send']({ text: 'show services' }), /already running/);
    await assert.rejects(app.actions['agent/send']({ text: 'show service dependencies' }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('policy denial and anomalous evidence leave saved blocked diagnostics and allow a subsequent valid read', async () => {
  let read = 0;
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false, dependencyCollector: async () => {
    if (++read === 1) throw new Error('Script execution is disabled by policy.');
    if (read === 2) throw null;
    if (read === 3) return evidence({ services: [{ ...row(), required: null }] });
    return evidence();
  } });
  try {
    const outputCount = () => app.snapshot().journal.filter(item => item.type === 'output' && item.data.delta?.startsWith('Service dependencies are blocked.')).length;
    const before = outputCount();
    for (let index = 0; index < 3; index++) {
      verifyBlocked(await app.actions['agent/send']({ text: 'show service dependencies' }));
      assert.equal(app.snapshot().systemTool, null);
    }
    assert.equal(outputCount() - before, 3);
    assert.ok(app.snapshot().journal.some(item => item.data.delta?.includes('Script execution is disabled by policy.')));
    const result = await app.actions['agent/send']({ text: 'show service dependencies' });
    assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 3); assert.equal(app.snapshot().systemTool, null);
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-dependency-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
