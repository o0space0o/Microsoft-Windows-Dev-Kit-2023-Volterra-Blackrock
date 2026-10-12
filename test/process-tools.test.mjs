import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-process-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { processQuery, collectProcesses, inspectProcesses, processReport } = await import('../app/process-tools.mjs');
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });
const { describeProgress } = await import('../app/public/progress.js');
const reading = (patch = {}) => ({ pid: 123, name: 'Fixture [app]', sessionId: 1, workingSetBytes: '9007199254740993', ...patch });
const evidence = (patch = {}) => ({ version: 1, kind: 'processes', status: 'passed', observedAt: '2026-10-11T18:00:00.000Z',
  system: { edition: 'Professional', build: '26200', architecture: 'ARM64' }, processes: [reading()], error: null, ...patch });

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

test('process chat intent uses bounded literal filters and rejects mutation or expanded scope', () => {
  assert.deepEqual(processQuery('show processes'), { filter: '' });
  assert.deepEqual(processQuery(' LIST PROCESSES matching [app] '), { filter: '[app]' });
  assert.deepEqual(processQuery('processes matching $(Example); *'), { filter: '$(Example); *' });
  for (const value of ['stop processes', 'show processes and kill 123', 'show processes from another host', 'show process 123', 'processes\ncommands', null]) assert.equal(processQuery(value), null);
  for (const value of ['x'.repeat(257), 'bad\u0000filter']) assert.throws(() => processQuery('show processes matching ' + value), /256/);
});

test('the collector invokes only the fixed local script without evaluating filters or bypassing policy', async () => {
  let calls = 0;
  const result = await collectProcesses({ shell: 'fixture-powershell', execute: async (shell, args, options) => {
    calls++; assert.equal(shell, 'fixture-powershell');
    assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-File']);
    assert.equal(path.basename(args.at(-1)), 'Get-ProcessInventory.ps1'); assert.equal(options.timeout, 15_000);
    return '\uFEFF' + JSON.stringify(evidence());
  } });
  assert.equal(calls, 1); assert.deepEqual(result, evidence());
  await assert.rejects(collectProcesses({ shell: null }), /Windows PowerShell/);
  await assert.rejects(collectProcesses({ shell: 'fixture', execute: async () => 'unsupported' }), SyntaxError);
  await assert.rejects(collectProcesses({ shell: 'fixture', execute: async () => { throw new Error('Execution policy denied.'); } }), /policy denied/);
});

test('native collection has fixed local scope, exact bytes, resource disposal and no process controls or private properties', async () => {
  const source = await fs.readFile(new URL('../scripts/Get-ProcessInventory.ps1', import.meta.url), 'utf8');
  assert.match(source, /Get-Process -ErrorAction Stop/); assert.match(source, /\$records\.Count -gt 4096/);
  assert.match(source, /\$processRecord = \$_/); assert.match(source, /\$processRecord\.SessionId/); assert.match(source, /\$processRecord\.WorkingSet64/);
  assert.match(source, /workingSetBytes=\$null/); assert.match(source, /sessionId=\$null/);
  assert.match(source, /ToString\(\[Globalization\.CultureInfo\]::InvariantCulture\)/); assert.match(source, /\$record\.Dispose\(\)/);
  assert.doesNotMatch(source, /-(?:ComputerName|IncludeUserName|Module|FileVersionInfo|Name|Id|ExecutionPolicy)\b|Stop-Process|Start-Process|Debug-Process|Invoke-Command|Invoke-Expression|\.Kill\(|\.CloseMainWindow\(|\.PriorityClass\b/i);
  assert.doesNotMatch(source, /\$processRecord\.(?:MainModule|Modules|Path|CommandLine|UserName|StartInfo|Environment|MainWindowTitle)\b/);
});

test('process IDs, zero readings and large working-set byte values retain precision without health claims', async () => {
  const result = await inspectProcesses('', async (...args) => { assert.deepEqual(args, []); return evidence({ processes: [
    reading(), reading({ pid: 0, name: 'Idle fixture', sessionId: 0, workingSetBytes: '0' }),
    reading({ pid: 4, name: 'Protected fixture', sessionId: null, workingSetBytes: null })] }); });
  assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 3);
  assert.equal(result.unreportedSessionCount, 1); assert.equal(result.unreportedWorkingSetCount, 1);
  assert.equal(result.processes.find(value => value.pid === 123).workingSetBytes, '9007199254740993');
  const report = processReport(result);
  assert.match(report, /9007199254740993 bytes/); assert.match(report, /Working set: 0 bytes/);
  assert.match(report, /Session ID: 0/); assert.match(report, /property could not be read/);
  assert.match(report, /not an atomic snapshot/); assert.match(report, /PID reuse/); assert.match(report, /VM or physical identity unverified/);
  for (const key of ['healthy', 'performanceAccepted', 'hardwareAccepted', 'runtimeAccepted', 'bootAccepted']) assert.equal(result[key], undefined);
});

test('literal filters match only names or PID text and preserve full collection counts', async () => {
  const raw = evidence({ processes: [reading(), reading({ pid: 12, name: 'Z fixture app' }), reading({ pid: 7, name: 'A $(Example); *' })] });
  const bracket = await inspectProcesses('[app]', async () => raw);
  assert.equal(bracket.totalCount, 3); assert.equal(bracket.matchedCount, 1); assert.equal(bracket.processes[0].pid, 123);
  assert.equal((await inspectProcesses('23', async () => raw)).processes[0].pid, 123);
  assert.equal((await inspectProcesses('$(Example); *', async () => raw)).processes[0].pid, 7);
  assert.equal((await inspectProcesses('no matches', async () => raw)).matchedCount, 0);
  assert.deepEqual((await inspectProcesses('', async () => raw)).processes.map(value => value.pid), [7, 123, 12]);
  const tied = await inspectProcesses('', async () => evidence({ processes: [reading({ pid: 20 }), reading({ pid: 4 })] }));
  assert.deepEqual(tied.processes.map(value => value.pid), [4, 20]);
});

test('optional properties are independently unreported and Validation OS identity remains unverified', async () => {
  const result = await inspectProcesses('', async () => evidence({ system: { edition: 'WinVOS', build: 'fixture', architecture: 'ARM64' },
    processes: [reading({ sessionId: null }), reading({ pid: 124, workingSetBytes: null })] }));
  assert.equal(result.status, 'passed'); assert.equal(result.processes[0].workingSetBytes, '9007199254740993');
  assert.equal(result.processes[1].sessionId, 1); assert.equal(result.unreportedSessionCount, 1); assert.equal(result.unreportedWorkingSetCount, 1);
  assert.match(result.environment, /Validation OS session; VM or physical identity unverified/);
});

test('missing, contradictory, duplicate and unsupported process readings fail closed', async () => {
  const invalid = [null, evidence({ version: 2 }), evidence({ kind: 'outside-scope' }), evidence({ observedAt: 'invalid' }),
    evidence({ system: {} }), evidence({ processes: {} }), evidence({ processes: Array(4097).fill(reading()) }),
    evidence({ error: { stage: 'Conflicting', message: 'failure' } }), evidence({ status: 'blocked' }),
    evidence({ status: 'blocked', processes: [], error: null }), evidence({ processes: [reading(), reading()] })];
  for (const pid of [-1, 0x8000_0000, 1.5, '123', null]) invalid.push(evidence({ processes: [reading({ pid })] }));
  for (const sessionId of [-1, 0x8000_0000, '1', undefined]) invalid.push(evidence({ processes: [reading({ sessionId })] }));
  for (const workingSetBytes of [0, 9007199254740992, '01', '-1', '1.0', '1e3', '9223372036854775808', '', undefined]) invalid.push(evidence({ processes: [reading({ workingSetBytes })] }));
  for (const name of [null, '', ' ', 'bad\u0000name', 'x'.repeat(513)]) invalid.push(evidence({ processes: [reading({ name })] }));
  for (const raw of invalid) {
    const result = await inspectProcesses('', async () => raw);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.processes, []); assert.equal(result.totalCount, undefined);
  }
  const maximum = await inspectProcesses('', async () => evidence({ processes: [reading({ pid: 0x7fff_ffff, sessionId: 0x7fff_ffff, workingSetBytes: '9223372036854775807' })] }));
  assert.equal(maximum.status, 'passed'); assert.equal(maximum.processes[0].workingSetBytes, '9223372036854775807');
});

test('missing process rows cannot inflate totals or be hidden by a literal filter', async () => {
  const missingFirst = Array(2); missingFirst[1] = reading();
  const missingSecond = Array(2); missingSecond[0] = reading({ sessionId: null, workingSetBytes: null });
  for (const processes of [Array(2), missingFirst, missingSecond, [reading(), undefined], [null]]) {
    for (const filter of ['', '[app]', 'no matches']) {
      const result = await inspectProcesses(filter, async (...args) => { assert.deepEqual(args, []); return evidence({ processes }); });
      assert.equal(result.status, 'blocked'); assert.deepEqual(result.processes, []);
      for (const key of ['totalCount', 'matchedCount', 'unreportedSessionCount', 'unreportedWorkingSetCount']) assert.equal(result[key], undefined);
      const report = processReport(result);
      assert.match(report, /blocked.*incomplete or duplicate readings/);
      assert.doesNotMatch(report, /Live process inventory|processes read|No processes were reported/);
    }
  }
});

test('complete inventories count actual rows and independently unreported fields even when no rows match', async () => {
  const raw = evidence({ processes: [reading({ pid: 0, name: 'Idle fixture', sessionId: 0, workingSetBytes: '0' }),
    reading({ sessionId: null }), reading({ pid: 124, name: 'Unknown working set', workingSetBytes: null })] });
  for (const filter of ['', 'no matches']) {
    const result = await inspectProcesses(filter, async () => raw);
    assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 3);
    assert.equal(result.matchedCount, filter ? 0 : 3);
    assert.equal(result.unreportedSessionCount, 1); assert.equal(result.unreportedWorkingSetCount, 1);
    if (!filter) {
      const idle = result.processes.find(value => value.pid === 0);
      assert.equal(idle.sessionId, 0); assert.equal(idle.workingSetBytes, '0');
      assert.equal(result.processes.find(value => value.pid === 123).workingSetBytes, '9007199254740993');
      assert.equal(result.processes.find(value => value.pid === 124).workingSetBytes, null);
    }
  }
  const empty = await inspectProcesses('', async () => evidence({ processes: [] }));
  assert.equal(empty.status, 'passed'); assert.equal(empty.totalCount, 0); assert.equal(empty.matchedCount, 0);
  assert.equal(empty.unreportedSessionCount, 0); assert.equal(empty.unreportedWorkingSetCount, 0);
  const largest = Array.from({ length: 4096 }, (_, pid) => reading({ pid, sessionId: null, workingSetBytes: null }));
  const result = await inspectProcesses('no matches', async () => evidence({ processes: largest }));
  assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 4096); assert.equal(result.matchedCount, 0);
  assert.equal(result.unreportedSessionCount, 4096); assert.equal(result.unreportedWorkingSetCount, 4096);
  assert.deepEqual(result.processes, []);
});

test('private extras are discarded and collection errors or sensitive names are redacted before saving', async () => {
  const result = await inspectProcesses('', async () => evidence({ accepted: true, processes: [reading({ commandLine: 'Private fixture arguments',
    executablePath: 'Private fixture path', owner: 'Private fixture account', environment: 'Private fixture token' })] }));
  assert.deepEqual(Object.keys(result.processes[0]).sort(), ['name', 'pid', 'sessionId', 'workingSetBytes']);
  assert.equal(result.accepted, undefined); assert.doesNotMatch(JSON.stringify(result) + processReport(result), /Private fixture/);
  const blocked = await inspectProcesses('', async () => evidence({ status: 'blocked', processes: [],
    error: { stage: 'Local process enumeration', message: 'Access denied. Bearer fixture-secret' } }));
  assert.equal(blocked.status, 'blocked'); assert.match(processReport(blocked), /Local process enumeration/); assert.doesNotMatch(processReport(blocked), /fixture-secret/);
  const failed = await inspectProcesses('', async () => { throw new Error('Policy denied. Bearer fixture-secret'); });
  assert.match(processReport(failed), /Policy denied/); assert.doesNotMatch(processReport(failed), /fixture-secret/);
  const named = await inspectProcesses('', async () => evidence({ processes: [reading({ name: 'Bearer fixture-secret' })] }));
  assert.doesNotMatch(processReport(named), /fixture-secret/);
});

test('empty results and bounded chat output preserve scope without implying processes are still running', async () => {
  const empty = await inspectProcesses('', async () => evidence({ processes: [] }));
  assert.equal(empty.status, 'passed'); assert.match(processReport(empty), /No processes were reported/);
  const noMatch = await inspectProcesses('missing', async () => evidence());
  assert.match(processReport(noMatch), /No processes matched this literal filter/);
  const many = await inspectProcesses('', async () => evidence({ processes: Array.from({ length: 41 }, (_, pid) => reading({ pid })) }));
  const report = processReport(many);
  assert.equal(many.matchedCount, 41); assert.equal((report.match(/\nPID:/g) || []).length, 40); assert.match(report, /Showing 40 of 41/);
});

test('invalid filters fail before collection can execute', async () => {
  let calls = 0;
  for (const filter of [null, 'x'.repeat(257), 'bad\u0000filter']) await assert.rejects(inspectProcesses(filter, async () => { calls++; return evidence(); }), /256/);
  assert.equal(calls, 0);
});

test('chat requires session and origin authorization, ignores scope fields, needs no account and saves output across restart', async () => {
  let calls = 0; const fake = new FakeCodex();
  const options = { port: 0, codex: fake, autostart: false, processCollector: async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); } };
  let app = await createApplication(options);
  try {
    const send = headers => fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'show processes matching [app]', computerName: 'remote-fixture', pid: 7, path: 'outside-fixture', stop: true }) });
    assert.equal((await send({})).status, 403); assert.equal(calls, 0);
    const page = await fetch(app.origin), html = await page.text(), cookie = page.headers.get('set-cookie').split(';')[0];
    const token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1], headers = { cookie, 'X-Volterra-Client': token };
    assert.equal((await send({ cookie })).status, 403);
    assert.equal((await send({ ...headers, Origin: 'https://untrusted.example' })).status, 403); assert.equal(calls, 0);
    const response = await send(headers), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.tool, 'processes'); assert.equal(result.status, 'passed'); assert.equal(result.matchedCount, 1);
    assert.equal(result.processes[0].workingSetBytes, '9007199254740993'); assert.equal(calls, 1); assert.deepEqual(fake.calls, []);
    assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('9007199254740993 bytes'));
    assert.ok(output); await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('process collection shows checking while preserving pauses, active turns, questions and mutual exclusion', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, processCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' }); await app.automation.pause();
    const before = fake.calls.length, request = app.actions['agent/send']({ text: 'show processes' }), snapshot = app.snapshot();
    assert.equal(snapshot.activeTurn, 'fixture-turn'); assert.equal(snapshot.systemTool.kind, 'processes');
    assert.equal(describeProgress(snapshot).phase, 'checking'); assert.equal(describeProgress(snapshot).active, true);
    assert.equal(describeProgress({ ...snapshot, approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress({ ...snapshot, interruptRequested: true }).phase, 'stopping'); assert.equal(describeProgress(snapshot, false).phase, 'disconnected');
    for (const text of ['show services', 'show devices', 'show storage', 'show networking', 'show files', 'show logs', 'show maintenance', 'show processes']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn'); assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('a policy-blocked process query is saved with its prerequisite and clears transient checking', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false,
    processCollector: async () => { throw new Error('Script execution is disabled by policy.'); } });
  try {
    const result = await app.actions['agent/send']({ text: 'show processes' });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.processes, []); assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(entry => entry.type === 'output' && entry.data.delta?.includes('Script execution is disabled by policy.')));
  } finally { await app.close(); }
});

test('incomplete process queries save blocked diagnostics across restart and recover without phantom counts', async () => {
  let calls = 0;
  const partial = Array(2); partial[0] = reading();
  const options = { port: 0, codex: new FakeCodex(), autostart: false, processCollector: async () => {
    calls++;
    return evidence({ processes: calls === 1 ? Array(2) : calls === 2 ? partial : [reading()] });
  } };
  let app = await createApplication(options);
  try {
    const blockedOutputs = () => app.snapshot().journal.filter(entry => entry.type === 'output'
      && entry.data.delta?.startsWith('Process inventory is blocked.'));
    const before = blockedOutputs().length, beforeCodexCalls = options.codex.calls.length;
    for (const text of ['show processes', 'show processes matching [app]']) {
      const result = await app.actions['agent/send']({ text });
      assert.equal(result.status, 'blocked'); assert.equal(result.totalCount, undefined);
      assert.deepEqual(result.processes, []); assert.equal(app.snapshot().systemTool, null);
    }
    const saved = blockedOutputs().slice(before); assert.equal(saved.length, 2);
    assert.equal(options.codex.calls.length, beforeCodexCalls);
    await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    for (const output of saved) assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const result = await app.actions['agent/send']({ text: 'show processes matching [app]' });
    assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 1); assert.equal(result.matchedCount, 1);
    assert.equal(result.processes[0].workingSetBytes, '9007199254740993'); assert.equal(calls, 3);
    assert.equal(app.snapshot().systemTool, null);
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-process-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
