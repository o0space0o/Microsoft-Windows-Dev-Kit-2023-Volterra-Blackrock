import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-service-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
const { serviceQuery, collectServices, inspectServices, serviceReport } = await import('../app/service-tools.mjs');
const { createApplication } = await import('../app/server.mjs');
const { describeProgress } = await import('../app/public/progress.js');
const evidence = (patch = {}) => ({ version: 1, kind: 'services', status: 'passed', observedAt: '2026-10-11T12:00:00.000Z',
  system: { edition: 'Professional', build: '26200', architecture: 'ARM64' }, services: [
    { name: 'Zulu', displayName: 'Literal [match] fixture', status: 'Stopped', startType: 'Disabled' },
    { name: 'Alpha', displayName: 'Example service', status: 'Running', startType: 'Automatic' },
    { name: 'Beta', displayName: 'Pending service', status: 'StartPending', startType: 'Manual' }
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

test('service chat intent is precise and filter metacharacters remain literal data', () => {
  assert.deepEqual(serviceQuery('show services'), { filter: '' });
  assert.deepEqual(serviceQuery('  LIST services matching [match]  '), { filter: '[match]' });
  assert.deepEqual(serviceQuery('services matching $(Start-Service Example); *'), { filter: '$(Start-Service Example); *' });
  for (const message of ['start services', 'stop services', 'show services and stop Alpha', 'services\nstop Alpha', 'service', null]) assert.equal(serviceQuery(message), null);
  assert.throws(() => serviceQuery('show services matching ' + 'x'.repeat(257)), /256/);
});

test('the collector launches only its fixed read-only script with a bounded lifetime', async () => {
  let calls = 0;
  const value = await collectServices({ shell: 'fixture-powershell', execute: async (shell, args, options) => {
    calls++; assert.equal(shell, 'fixture-powershell');
    assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-File']);
    assert.equal(path.basename(args.at(-1)), 'Get-ServiceInventory.ps1'); assert.equal(options.timeout, 15_000);
    return '\uFEFF' + JSON.stringify(evidence());
  } });
  assert.equal(calls, 1); assert.deepEqual(value, evidence());
  await assert.rejects(collectServices({ shell: null }), /Windows PowerShell/);
});

test('live service readings preserve state and startup mode, with literal filtering and honest totals', async () => {
  const all = await inspectServices('', async () => evidence());
  assert.equal(all.status, 'passed'); assert.equal(all.totalCount, 3); assert.equal(all.matchedCount, 3);
  assert.deepEqual(all.services.map(service => service.name), ['Alpha', 'Beta', 'Zulu']);
  assert.equal(all.counts.Running, 1); assert.equal(all.counts.Stopped, 1); assert.equal(all.counts.StartPending, 1);
  const match = await inspectServices('[match]', async () => evidence());
  assert.equal(match.totalCount, 3); assert.equal(match.matchedCount, 1); assert.equal(match.services[0].startType, 'Disabled');
  assert.match(serviceReport(match), /Windows session; VM or physical identity unverified/); assert.match(serviceReport(match), /Stopped/);
  assert.equal((await inspectServices('*', async () => evidence())).matchedCount, 0);
  assert.match(serviceReport(await inspectServices('*', async () => evidence())), /No services matched/);
  const validation = await inspectServices('', async () => evidence({ system: { edition: 'WinVOS', build: 'fixture', architecture: 'ARM64' } }));
  assert.match(validation.environment, /Validation OS session; VM or physical identity unverified/);
  assert.equal(validation.bootAccepted, undefined); assert.equal(validation.runtimeAccepted, undefined);
});

test('missing APIs, partial or malformed readings produce blocked diagnostics instead of an empty success', async () => {
  for (const raw of [null, evidence({ observedAt: 'invalid' }), evidence({ services: {} }),
    evidence({ services: [{ name: 'Alpha', displayName: 'Alpha', status: 'invented', startType: 'Automatic' }] }),
    evidence({ services: [evidence().services[0], evidence().services[0]] })]) {
    const result = await inspectServices('', async () => raw);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.services, []); assert.match(serviceReport(result), /blocked/);
  }
  const unsupported = await inspectServices('', async () => { throw new Error('Get-Service is unavailable.'); });
  assert.match(unsupported.error.message, /unavailable/);
  const denied = await inspectServices('', async () => evidence({ status: 'blocked', services: [], error: { stage: 'Service enumeration', message: 'Access denied. Bearer fixture-secret' } }));
  assert.equal(denied.status, 'blocked'); assert.equal(denied.error.stage, 'Service enumeration');
  assert.match(denied.error.message, /Access denied/); assert.doesNotMatch(denied.error.message, /fixture-secret/);
});

test('conversation output is bounded while the authenticated result retains all matched readings', async () => {
  const result = await inspectServices('', async () => evidence({ services: Array.from({ length: 42 }, (_, index) => ({ name: `fixture-${index}`, displayName: 'Service', status: 'Stopped', startType: 'Manual' })) }));
  assert.equal(result.services.length, 42);
  const report = serviceReport(result);
  assert.equal(report.match(/State: Stopped/g).length, 40); assert.match(report, /Showing 40 of 42/);
  assert.ok(report.length < 30_000);
});

test('the chat endpoint requires session authorization, needs no sign-in for a local read and persists its output', async () => {
  const fake = new FakeCodex(); let calls = 0;
  let app = await createApplication({ port: 0, codex: fake, autostart: false, serviceCollector: async () => { calls++; return evidence(); } });
  try {
    const unauthorized = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'show services' }) });
    assert.equal(unauthorized.status, 403); assert.equal(calls, 0);
    const entry = await fetch(app.origin), html = await entry.text();
    const cookie = entry.headers.get('set-cookie').split(';')[0], token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1];
    const headers = { cookie, 'Content-Type': 'application/json', 'X-Volterra-Client': token };
    const crossOrigin = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ text: 'show services' }) });
    assert.equal(crossOrigin.status, 403); assert.equal(calls, 0);
    const response = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers, body: JSON.stringify({ text: 'show services matching [match]' }) });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.tool, 'services'); assert.equal(result.matchedCount, 1); assert.equal(calls, 1);
    assert.equal(fake.calls.length, 0); assert.equal(app.snapshot().activeTurn, null); assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'user' && entry.data === 'show services matching [match]'));
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Literal [match] fixture'));
    assert.ok(output); await app.close();
    app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false, serviceCollector: async () => evidence() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('a service read has real checking progress without steering an active Codex turn or resuming a saved pause', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, serviceCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' });
    await app.automation.pause();
    const before = fake.calls.length;
    const request = app.actions['agent/send']({ text: 'show services' });
    assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(describeProgress(app.snapshot()).phase, 'checking');
    assert.equal(describeProgress(app.snapshot()).active, true);
    await assert.rejects(app.actions['agent/send']({ text: 'show services' }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('a denied collector leaves a saved blocked report and clears transient checking state', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false,
    serviceCollector: async () => { throw new Error('Script execution is disabled by policy.'); } });
  try {
    const result = await app.actions['agent/send']({ text: 'show services' });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.services, []);
    assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'output' && entry.data.delta?.includes('blocked. Service inventory: Script execution is disabled by policy.')));
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-service-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
