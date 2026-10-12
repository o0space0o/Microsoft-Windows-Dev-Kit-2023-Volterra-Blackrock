import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-log-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { logQuery, collectLogs, inspectLogs, logReport } = await import('../app/log-tools.mjs');
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });
const { describeProgress } = await import('../app/public/progress.js');
const event = (patch = {}) => ({ channel: 'System', provider: 'Fixture [provider]', id: 42, recordId: '9007199254740993',
  level: 3, createdAt: '2026-10-11T16:00:00.000Z', ...patch });
const channel = (name, events = []) => ({ name, status: 'passed', events, error: null });
const evidence = (patch = {}) => ({ version: 1, kind: 'logs', status: 'passed', observedAt: '2026-10-11T18:00:00.000Z', maxEvents: 50,
  system: { edition: 'Professional', build: '26200', architecture: 'ARM64' }, channels: [channel('System', [event()]),
    channel('Application', [event({ channel: 'Application', provider: 'Example app', recordId: '1', id: 1000, level: 2, createdAt: '2026-10-11T17:00:00.000Z' })])], ...patch });
const denied = name => ({ name, status: 'blocked', events: [], error: { stage: `${name} event query`, message: 'Access denied. Bearer fixture-secret' } });

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

test('log chat intent accepts bounded literal filters and rejects commands or expanded scope', () => {
  assert.deepEqual(logQuery('show logs'), { filter: '' });
  assert.deepEqual(logQuery('  LIST LOGS matching [provider] '), { filter: '[provider]' });
  assert.deepEqual(logQuery('logs matching $(Example); *'), { filter: '$(Example); *' });
  for (const value of ['clear logs', 'show logs and clear System', 'show logs Security', 'show logs from another host', 'logs\ncommands', null]) assert.equal(logQuery(value), null);
  for (const value of ['x'.repeat(257), 'bad\u0000filter']) assert.throws(() => logQuery('show logs matching ' + value), /256/);
});

test('the collector uses only its fixed local script with no policy bypass or caller-supplied arguments', async () => {
  let calls = 0;
  const raw = await collectLogs({ shell: 'fixture-powershell', execute: async (shell, args, options) => {
    calls++; assert.equal(shell, 'fixture-powershell');
    assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-File']);
    assert.equal(path.basename(args.at(-1)), 'Get-LogInventory.ps1'); assert.equal(options.timeout, 15_000);
    return '\uFEFF' + JSON.stringify(evidence());
  } });
  assert.deepEqual(raw, evidence()); assert.equal(calls, 1);
  await assert.rejects(collectLogs({ shell: null }), /Windows PowerShell/);
  await assert.rejects(collectLogs({ shell: 'fixture', execute: async () => 'unsupported' }), SyntaxError);
  await assert.rejects(collectLogs({ shell: 'fixture', execute: async () => { throw new Error('Execution policy denied.'); } }), /policy denied/);
});

test('the PowerShell collector keeps channel and sample scope fixed and never evaluates event contents', async () => {
  const source = await fs.readFile(new URL('../scripts/Get-LogInventory.ps1', import.meta.url), 'utf8');
  assert.match(source, /foreach \(\$name in @\('System', 'Application'\)\)/);
  assert.match(source, /Get-WinEvent -LogName \$name -MaxEvents 50 -ErrorAction Stop/);
  assert.match(source, /NoMatchingEventsFound,Microsoft\.PowerShell\.Commands\.GetWinEventCommand/);
  assert.match(source, /RecordId\.ToString\(\[Globalization\.CultureInfo\]::InvariantCulture\)/);
  assert.match(source, /\$record\.Dispose\(\)/);
  assert.doesNotMatch(source, /\$_\.(?:Message|Properties|UserId|MachineName|ToXml)\b/);
  assert.doesNotMatch(source, /-(?:ComputerName|Credential|Path|FilterXPath|FilterXml|FilterHashtable|ExecutionPolicy)\b|Clear-EventLog|wevtutil|SaveChanges\(/i);
});

test('metadata retains exact large record IDs and newest-first times without accepting system health', async () => {
  const result = await inspectLogs('', async () => evidence());
  assert.equal(result.status, 'passed'); assert.equal(result.sampledCount, 2); assert.equal(result.maxEvents, 50);
  assert.equal(result.events[0].channel, 'Application'); assert.equal(result.events[1].recordId, '9007199254740993');
  assert.equal(result.events[1].levelName, 'Warning');
  const report = logReport(result);
  assert.match(report, /Record ID: 9007199254740993/); assert.match(report, /newest 50/);
  assert.match(report, /bounded sample does not establish system health/); assert.match(report, /VM or physical identity unverified/);
  const validation = await inspectLogs('', async () => evidence({ system: { edition: 'WinVOS', build: 'fixture', architecture: 'ARM64' } }));
  assert.match(validation.environment, /Validation OS session; VM or physical identity unverified/);
  for (const key of ['healthy', 'hardwareAccepted', 'bootAccepted', 'runtimeAccepted']) assert.equal(result[key], undefined);
});

test('filtering stays literal and local to the sample; unknown and missing metadata stay explicit', async () => {
  let calls = 0;
  const collect = async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); };
  const result = await inspectLogs('[provider]', collect);
  assert.equal(result.matchedCount, 1); assert.equal(result.sampledCount, 2);
  assert.equal((await inspectLogs('*', collect)).matchedCount, 0);
  assert.equal((await inspectLogs('1000', collect)).events[0].channel, 'Application');
  assert.equal((await inspectLogs('Warning', collect)).events[0].channel, 'System');
  assert.equal(calls, 4);
  const unknown = await inspectLogs('', async () => evidence({ channels: [channel('System', [event({ recordId: null, level: null, createdAt: null }),
    event({ level: 64 })]), channel('Application')] }));
  assert.equal(unknown.status, 'passed'); assert.equal(unknown.events[0].levelName, 'Level 64');
  const report = logReport(unknown);
  assert.match(report, /Record ID: Unreported/); assert.match(report, /Created: Unreported/); assert.match(report, /Level 64 \(64\)/);
});

test('messages, XML, identities and token-shaped provider values never enter the saved metadata contract', async () => {
  const result = await inspectLogs('', async () => evidence({ channels: [channel('System', [event({ provider: 'Bearer fixture-secret',
    message: 'Private fixture message', xml: 'Private fixture XML', userId: 'Private fixture identity', machineName: 'Private fixture machine' })]), channel('Application')] }));
  assert.equal(result.status, 'passed'); assert.equal(result.events.length, 1);
  const serialized = JSON.stringify(result) + logReport(result);
  assert.doesNotMatch(serialized, /fixture-secret|Private fixture/); assert.match(serialized, /redacted/);
  assert.equal(result.events[0].message, undefined);
});

test('one blocked channel retains useful metadata from the other while keeping the result blocked', async () => {
  const result = await inspectLogs('', async () => evidence({ status: 'blocked', channels: [denied('System'), evidence().channels[1]] }));
  assert.equal(result.status, 'blocked'); assert.equal(result.events.length, 1); assert.equal(result.events[0].channel, 'Application');
  assert.equal(result.channels[0].status, 'blocked'); assert.match(result.channels[0].error.message, /Access denied/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  const report = logReport(result);
  assert.match(report, /blocked; partial readings follow/); assert.match(report, /System is blocked/); assert.match(report, /Application: 1 events sampled/);
  const both = await inspectLogs('', async () => evidence({ status: 'blocked', channels: [denied('System'), denied('Application')] }));
  assert.equal(both.status, 'blocked'); assert.deepEqual(both.events, []);
  assert.match(logReport(both), /Neither channel returned a successful query/);
  assert.doesNotMatch(logReport(both), /partial readings follow|the successful channel queries/);
});

test('successful empty samples are distinct from blocked API or execution failures', async () => {
  const empty = await inspectLogs('', async () => evidence({ channels: [channel('System'), channel('Application')] }));
  assert.equal(empty.status, 'passed'); assert.equal(empty.sampledCount, 0);
  assert.match(logReport(empty), /No event metadata was returned by the successful channel queries/);
  const failed = await inspectLogs('', async () => { throw new Error('Get-WinEvent is unavailable.'); });
  assert.equal(failed.status, 'blocked'); assert.deepEqual(failed.events, []); assert.match(logReport(failed), /unavailable/);
  for (const filter of [null, 'x'.repeat(257), 'bad\u0000filter']) await assert.rejects(inspectLogs(filter), /256/);
});

test('missing, duplicate, mismatched, oversized or contradictory channel evidence fails closed', async () => {
  for (const raw of [null, evidence({ observedAt: 'invalid' }), evidence({ maxEvents: 500 }), evidence({ channels: [] }),
    evidence({ channels: [channel('Security'), channel('Application')] }), evidence({ channels: [channel('System'), channel('System')] }),
    evidence({ channels: [channel('System', Array.from({ length: 51 }, (_, index) => event({ recordId: String(index + 1) }))), channel('Application')] }),
    evidence({ channels: [denied('System'), channel('Application')] }), evidence({ status: 'blocked' }),
    evidence({ channels: [{ ...denied('System'), events: [event()] }, channel('Application')], status: 'blocked' }),
    evidence({ channels: [{ ...channel('System'), error: { message: 'Conflicting error' } }, channel('Application')] })]) {
    const result = await inspectLogs('', async () => raw);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.events, []); assert.deepEqual(result.channels, []);
  }
});

test('malformed event metadata cannot become a passing report; identities are channel-specific', async () => {
  const patches = [{ channel: 'Application' }, { id: -1 }, { id: 65536 }, { id: 1.5 }, { recordId: 9007199254740992 },
    { recordId: '0' }, { recordId: '01' }, { recordId: '9223372036854775808' }, { recordId: '1.2' }, { createdAt: 'invalid' },
    { level: -1 }, { level: 256 }, { level: '3' }, { provider: '' }, { provider: 'x'.repeat(513) }, { provider: 'bad\u0000provider' }];
  for (const patch of patches) {
    const result = await inspectLogs('', async () => evidence({ channels: [channel('System', [event(patch)]), channel('Application')] }));
    assert.equal(result.status, 'blocked', JSON.stringify(patch)); assert.deepEqual(result.events, []);
  }
  const duplicate = await inspectLogs('', async () => evidence({ channels: [channel('System', [event(), event()]), channel('Application')] }));
  assert.equal(duplicate.status, 'blocked'); assert.deepEqual(duplicate.events, []);
  const sharedRecord = await inspectLogs('', async () => evidence({ channels: [channel('System', [event({ recordId: '1' })]), evidence().channels[1]] }));
  assert.equal(sharedRecord.status, 'passed'); assert.equal(sharedRecord.events.length, 2);
  const largest = await inspectLogs('', async () => evidence({ channels: [channel('System', [event({ recordId: '9223372036854775807', id: 65535, level: 255 })]), channel('Application')] }));
  assert.equal(largest.status, 'passed'); assert.equal(largest.events[0].recordId, '9223372036854775807');
});

test('missing channel or event rows cannot become a successful empty sample or inflate sampled counts', async () => {
  const missingFirst = Array(2); missingFirst[1] = evidence().channels[1];
  const missingSecond = Array(2); missingSecond[0] = channel('System');
  const blockedWithHole = Array(2); blockedWithHole[0] = denied('System');
  for (const channels of [Array(2), missingFirst, missingSecond, blockedWithHole,
    [null, channel('Application')], [channel('System'), undefined]]) {
    for (const status of ['passed', 'blocked']) {
      const result = await inspectLogs('', async () => evidence({ status, channels }));
      assert.equal(result.status, 'blocked'); assert.deepEqual(result.channels, []); assert.deepEqual(result.events, []);
      assert.equal(result.sampledCount, undefined); assert.equal(result.matchedCount, undefined);
      assert.match(logReport(result), /blocked.*incomplete channel readings/);
      assert.doesNotMatch(logReport(result), /successful channel queries|Live event log metadata/);
    }
  }
  const partialEvents = Array(2); partialEvents[0] = event();
  for (const events of [Array(1), partialEvents, [event(), undefined], [null]]) {
    const result = await inspectLogs('', async () => evidence({ channels: [channel('System', events), channel('Application')] }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.events, []); assert.deepEqual(result.channels, []);
    assert.equal(result.sampledCount, undefined); assert.match(logReport(result), /incomplete or duplicate event metadata/);
  }
  const empty = await inspectLogs('', async () => evidence({ channels: [channel('System'), channel('Application')] }));
  assert.equal(empty.status, 'passed'); assert.equal(empty.sampledCount, 0);
  const zero = await inspectLogs('', async () => evidence({ channels: [channel('System', [event({ id: 0, level: 0, recordId: null, createdAt: null })]), channel('Application')] }));
  assert.equal(zero.status, 'passed'); assert.equal(zero.sampledCount, 1);
  assert.match(logReport(zero), /Event ID: 0\. Record ID: Unreported\. Level: Log always \(0\)/);
  assert.match(logReport(zero), /Created: Unreported/);
});

test('blocked channels require a named failure stage and preserve valid channel-specific diagnostics', async () => {
  for (const error of [null, {}, { stage: '', message: 'Denied' }, { stage: ' \t ', message: 'Denied' },
    { stage: null, message: 'Denied' }, { stage: 1, message: 'Denied' }, { stage: 'Read', message: ' ' }, { stage: 'Read', message: {} }]) {
    const result = await inspectLogs('', async () => evidence({ status: 'blocked',
      channels: [{ ...denied('System'), error }, evidence().channels[1]] }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.events, []); assert.deepEqual(result.channels, []);
    assert.match(logReport(result), /ambiguous channel failure evidence/);
  }
  const result = await inspectLogs('', async () => evidence({ status: 'blocked', channels: [denied('System'), evidence().channels[1]] }));
  assert.equal(result.channels[0].error.stage, 'System event query'); assert.equal(result.sampledCount, 1);
  assert.match(logReport(result), /Application: 1 events sampled/); assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});

test('null and non-Error collector failures remain blocked with renderable redacted diagnostics', async () => {
  for (const failure of [null, undefined, '', 'Access denied', 123, {}]) {
    const result = await inspectLogs('sk-fixture-filter', async () => { throw failure; });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.events, []); assert.deepEqual(result.channels, []);
    assert.equal(result.error.stage, 'Event log inventory'); assert.equal(result.sampledCount, undefined);
    assert.match(logReport(result), /event log query did not succeed/); assert.doesNotMatch(JSON.stringify(result), /fixture-filter/);
  }
  const result = await inspectLogs('', async () => { throw { message: 'Read denied. Bearer fixture-secret' }; });
  assert.match(logReport(result), /Read denied/); assert.doesNotMatch(logReport(result), /fixture-secret/);
});

test('chat rendering is bounded while the authenticated result retains the whole collected sample', async () => {
  const result = await inspectLogs('', async () => evidence({ channels: channelNamesForFixture().map(name => channel(name,
    Array.from({ length: 50 }, (_, index) => event({ channel: name, recordId: String(index + 1) })))) }));
  assert.equal(result.sampledCount, 100); assert.equal(result.events.length, 100);
  const report = logReport(result);
  assert.equal(report.match(/Event ID:/g).length, 40); assert.match(report, /Showing 40 of 100 sampled matches/); assert.ok(report.length < 30_000);
});
function channelNamesForFixture() { return ['System', 'Application']; }

test('log chat requires session and origin checks, accepts no scope overrides and persists metadata after restart', async () => {
  const fake = new FakeCodex(); let calls = 0;
  const options = { port: 0, codex: fake, autostart: false, logCollector: async (...args) => { assert.deepEqual(args, []); calls++; return evidence(); } };
  let app = await createApplication(options);
  try {
    const send = headers => fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'show logs matching [provider]', path: 'outside-fixture', channel: 'Security', computerName: 'remote-fixture' }) });
    assert.equal((await send({})).status, 403); assert.equal(calls, 0);
    const entry = await fetch(app.origin), html = await entry.text();
    const cookie = entry.headers.get('set-cookie').split(';')[0], token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1];
    assert.equal((await send({ cookie })).status, 403);
    const headers = { cookie, 'X-Volterra-Client': token };
    assert.equal((await send({ ...headers, Origin: 'https://untrusted.example' })).status, 403); assert.equal(calls, 0);
    const response = await send(headers); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.tool, 'logs'); assert.equal(result.status, 'passed'); assert.equal(result.matchedCount, 1);
    assert.equal(calls, 1); assert.equal(fake.calls.length, 0); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Record ID: 9007199254740993'));
    assert.ok(output); await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('a log read shows live checking, excludes simultaneous tools and preserves the active turn, saved pause and approvals', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, logCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' }); await app.automation.pause();
    const before = fake.calls.length, request = app.actions['agent/send']({ text: 'show logs' });
    const snapshot = app.snapshot();
    assert.equal(snapshot.activeTurn, 'fixture-turn'); assert.equal(snapshot.systemTool.kind, 'logs');
    assert.equal(describeProgress(snapshot).phase, 'checking'); assert.equal(describeProgress(snapshot).active, true);
    assert.equal(describeProgress({ ...snapshot, approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress({ ...snapshot, interruptRequested: true }).phase, 'stopping');
    assert.equal(describeProgress(snapshot, false).phase, 'disconnected');
    for (const text of ['show services', 'show devices', 'show storage', 'show networking', 'show files', 'show logs']) {
      await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    }
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('collector failures retain a redacted blocked chat report and clear the transient state', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false,
    logCollector: async () => { throw new Error('Script execution is disabled by policy. Bearer fixture-secret'); } });
  try {
    const result = await app.actions['agent/send']({ text: 'show logs' });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.events, []); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('Script execution is disabled by policy.'));
    assert.ok(output); assert.doesNotMatch(output.data.delta, /fixture-secret/);
  } finally { await app.close(); }
});

test('log collector anomalies save blocked output across restart and checking recovers for a complete query', async () => {
  let calls = 0;
  const options = { port: 0, codex: new FakeCodex(), autostart: false, logCollector: async () => {
    calls++;
    if (calls === 1) throw null;
    if (calls === 2) return evidence({ channels: Array(2) });
    if (calls === 3) return evidence({ status: 'blocked', channels: [{ ...denied('System'), error: { stage: ' ', message: 'Denied' } }, channel('Application')] });
    return evidence();
  } };
  let app = await createApplication(options);
  try {
    const blockedOutputs = () => app.snapshot().journal.filter(entry => entry.type === 'output'
      && entry.data.delta?.startsWith('Event log inventory is blocked.'));
    const before = blockedOutputs().length;
    const beforeCodexCalls = options.codex.calls.length;
    for (let index = 0; index < 3; index++) {
      const result = await app.actions['agent/send']({ text: 'show logs' });
      assert.equal(result.status, 'blocked'); assert.equal(result.sampledCount, undefined);
      assert.equal(app.snapshot().systemTool, null);
    }
    const saved = blockedOutputs().slice(before); assert.equal(saved.length, 3); assert.equal(options.codex.calls.length, beforeCodexCalls);
    await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    for (const output of saved) assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const result = await app.actions['agent/send']({ text: 'show logs' });
    assert.equal(result.status, 'passed'); assert.equal(result.sampledCount, 2); assert.equal(calls, 4);
    assert.equal(app.snapshot().systemTool, null);
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-log-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
