import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { probeCodexRuntime, probePersistentHistory, evaluateBootRuntime, inspectBrowserCapture } from '../app/runtime-verification.mjs';

const ready = () => ({
  edition: 'WinVOS', versionsVerified: true, systemRoot: 'A:\\', automaticWorkspace: 'a:\\', serverReady: true, helperRuntimeRunning: true,
  helperChatgptAccountObserved: true,
  history: { storageConfigured: true, historyReadable: true, survivedBoot: true },
  codexProtocol: { appServerInitialized: true, chatgptAccountObserved: true, nativeSandboxReady: true, sandboxCommandCompleted: true, savedThreadReadable: true },
  browser: { executableMatched: true, helperScriptExecuted: true, renderCaptured: true }
});

test('host and legacy success reports cannot establish Validation OS acceptance', () => {
  const legacy = { edition: 'WinVOS', status: 'passed', systemRoot: 'A:\\', automaticWorkspace: 'A:\\', serverReady: true, browserRunning: true, codexProtocol: { appServerInitialized: true } };
  const result = evaluateBootRuntime(legacy);
  assert.equal(result.status, 'blocked');
  assert.equal(result.checks.nativeCodexSandbox, false);
  assert.equal(result.checks.browser, false);
  assert.equal(result.checks.signIn, false);
  const host = evaluateBootRuntime({ ...ready(), edition: 'Professional' });
  assert.equal(host.checks.validationOS, false);
  assert.equal(host.startupHealthy, false);
  assert.equal(host.status, 'blocked');
  assert.equal(evaluateBootRuntime({}).checks.automaticWorkspace, false);
});

test('every required runtime observation is mandatory and source health is separate from acceptance', () => {
  assert.equal(evaluateBootRuntime(ready()).status, 'passed');
  for (const [field, key] of [['history', 'survivedBoot'], ['codexProtocol', 'savedThreadReadable'], ['codexProtocol', 'nativeSandboxReady'], ['codexProtocol', 'sandboxCommandCompleted'], ['codexProtocol', 'chatgptAccountObserved'], ['browser', 'helperScriptExecuted'], ['browser', 'renderCaptured'], ['browser', 'executableMatched']]) {
    const record = ready(); delete record[field][key];
    assert.equal(evaluateBootRuntime(record).status, 'blocked', `${field}.${key}`);
  }
  for (const key of ['helperRuntimeRunning', 'serverReady', 'versionsVerified', 'helperChatgptAccountObserved']) {
    const record = ready(); delete record[key]; assert.equal(evaluateBootRuntime(record).status, 'blocked', key);
  }
  const record = ready(); record.automaticWorkspace = 'A:\\Volterra';
  assert.equal(evaluateBootRuntime(record).checks.automaticWorkspace, false);
  record.automaticWorkspace = 'A:\\'; record.history.survivedBoot = false; record.helperChatgptAccountObserved = false;
  const result = evaluateBootRuntime(record);
  assert.equal(result.status, 'blocked'); assert.equal(result.startupHealthy, true);
  assert.deepEqual(result.missingEvidence.map(item => item.check), ['persistentHistory', 'signIn']);
  record.history.storageConfigured = false;
  assert.equal(evaluateBootRuntime(record).startupHealthy, false);
});

class ProbeBridge extends EventEmitter {
  calls = []; stopped = false; accountType = 'chatgpt'; readiness = 'ready'; commandExit = 0;
  async start() { if (this.startError) { this.emit('diagnostic', 'Bearer probe-secret'); throw new Error(this.startError); } }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: this.accountType, email: 'never-export@example.invalid' } };
    if (method === 'windowsSandbox/readiness') return { status: this.readiness };
    if (method === 'command/exec') return { exitCode: this.commandExit, stdout: '10.0.26200.0\n', stderr: this.commandExit ? 'probe failed' : '' };
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    throw new Error('Unexpected request');
  }
  async stop() { this.stopped = true; }
}

test('Codex probe verifies native readiness, explicit read-only execution and existing thread without starting a turn', async () => {
  const bridge = new ProbeBridge();
  const result = await probeCodexRuntime(bridge, { powershell: 'powershell.exe', cwd: 'A:\\', threadId: 'saved-thread' });
  assert.equal(result.sandboxCommandCompleted, true); assert.equal(result.savedThreadReadable, true);
  assert.equal(result.chatgptAccountObserved, true);
  assert.deepEqual(bridge.calls.find(call => call.method === 'command/exec').params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.deepEqual(bridge.calls.find(call => call.method === 'thread/read').params, { threadId: 'saved-thread', includeTurns: false });
  assert.equal(bridge.calls.some(call => /setup|login|turn\//.test(call.method)), false);
  assert.equal(JSON.stringify(result).includes('never-export@example.invalid'), false);
  assert.equal(bridge.stopped, true);
});

test('missing authentication or sandbox readiness cannot be hidden by protocol initialization', async () => {
  const bridge = new ProbeBridge(); bridge.readiness = 'notConfigured'; bridge.accountType = 'apiKey';
  const result = await probeCodexRuntime(bridge, { powershell: 'powershell.exe', cwd: 'A:\\' });
  assert.equal(result.appServerInitialized, true); assert.equal(result.chatgptAccountObserved, false);
  assert.equal(result.nativeSandboxReady, false); assert.equal(result.sandboxCommandCompleted, false);
  assert.equal(bridge.calls.some(call => call.method === 'command/exec'), false);
  bridge.readiness = 'ready'; bridge.commandExit = 1;
  const failed = await probeCodexRuntime(bridge, { powershell: 'powershell.exe', cwd: 'A:\\' });
  assert.equal(failed.appServerInitialized, true); assert.equal(failed.sandboxCommandCompleted, false);
  bridge.startError = 'Could not find home directory';
  const startup = await probeCodexRuntime(bridge, {});
  assert.equal(startup.appServerInitialized, false);
  assert.deepEqual(startup.errors, ['Could not find home directory']);
  assert.deepEqual(startup.diagnostics, ['Bearer [redacted]']);
  assert.equal(bridge.listenerCount('diagnostic'), 0);
});

test('history requires a readable saved thread on external persistent storage and a distinct boot witness', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-history-proof-'));
  try {
    const sourceRoot = path.join(directory, 'source'), state = path.join(directory, 'state'), codexHome = path.join(state, 'codex');
    await fs.mkdir(sourceRoot); await fs.mkdir(codexHome, { recursive: true });
    const project = { path: path.parse(directory).root, threadId: 'saved-thread' };
    await fs.writeFile(path.join(state, 'state.json'), JSON.stringify({ selected: project.path, projects: { [project.path]: project } }));
    await fs.writeFile(path.join(state, 'journal.jsonl'), JSON.stringify({ type: 'message', time: '2026-10-11T00:00:00Z', data: 'saved' }) + '\npartial last line');
    const options = { directory: state, codexHome, sourceRoot, osRoot: project.path, bootId: 'boot-one', project };
    const empty = await probePersistentHistory({ ...options, project: { path: project.path, threadId: null } });
    assert.equal(empty.storageConfigured, true); assert.equal(empty.historyReadable, false);
    const first = await probePersistentHistory(options);
    assert.equal(first.historyReadable, true); assert.equal(first.survivedBoot, false);
    assert.equal((await probePersistentHistory(options)).survivedBoot, false);
    assert.equal((await probePersistentHistory({ ...options, bootId: 'boot-two' })).survivedBoot, true);
    const originalJournal = await fs.readFile(path.join(state, 'journal.jsonl'), 'utf8');
    await fs.writeFile(path.join(state, 'journal.jsonl'), JSON.stringify({ type: 'notice', time: '2026-10-12T00:00:00Z', data: 'new boot only' }));
    const lost = await probePersistentHistory({ ...options, bootId: 'boot-two' });
    assert.equal(lost.survivedBoot, false); assert.match(lost.error, /not retained/);
    await fs.writeFile(path.join(state, 'journal.jsonl'), originalJournal);
    assert.equal((await probePersistentHistory({ ...options, directory: sourceRoot })).storageConfigured, false);
    const witnessFile = path.join(state, 'runtime-history-witness.json');
    const witness = JSON.parse(await fs.readFile(witnessFile, 'utf8')); delete witness.bootId;
    await fs.writeFile(witnessFile, JSON.stringify(witness));
    assert.equal((await probePersistentHistory({ ...options, bootId: 'boot-three' })).survivedBoot, false);
    await fs.writeFile(path.join(state, 'state.json'), JSON.stringify({ selected: project.path, projects: { [project.path]: { ...project, threadId: 'another-thread' } } }));
    assert.equal((await probePersistentHistory({ ...options, bootId: 'boot-three' })).historyReadable, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('browser evidence requires helper script output and a captured PNG at the approved viewport', async () => {
  const source = await fs.readFile(new URL('../app/public/index.html', import.meta.url), 'utf8');
  const png = Buffer.alloc(1100); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.write('IHDR', 12); png.writeUInt32BE(1672, 16); png.writeUInt32BE(941, 20);
  const dom = '<div id="status" role="status">Codex ready</div><button class="portal" title="Home"></button>';
  assert.deepEqual(inspectBrowserCapture(dom, png), { helperScriptExecuted: true, renderCaptured: true });
  assert.equal(inspectBrowserCapture(source, png).helperScriptExecuted, false);
  assert.equal(inspectBrowserCapture(dom, Buffer.alloc(0)).renderCaptured, false);
  png.writeUInt32BE(800, 16);
  assert.equal(inspectBrowserCapture(dom, png).renderCaptured, false);
});

test('a Codex home junction outside persistent state cannot establish storage readiness', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-history-junction-'));
  try {
    const state = path.join(directory, 'state'), sourceRoot = path.join(directory, 'source'), outside = path.join(directory, 'outside');
    await fs.mkdir(state); await fs.mkdir(sourceRoot); await fs.mkdir(outside);
    const codexHome = path.join(state, 'codex');
    await fs.symlink(outside, codexHome, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await probePersistentHistory({ directory: state, codexHome, sourceRoot, osRoot: path.parse(directory).root, bootId: 'one', project: { path: path.parse(directory).root, threadId: 'saved' } });
    assert.equal(result.storageConfigured, false); assert.equal(result.survivedBoot, false);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('boot evidence CLI handles PowerShell UTF-8 BOM and rejects host evidence without a guest probe', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-boot-evidence-'));
  try {
    const file = path.join(directory, 'host.json');
    await fs.writeFile(file, '\uFEFF' + JSON.stringify({ ...ready(), edition: 'Professional', historyContext: { directory: 'do-not-write' } }));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/Check-BootEvidence.mjs', file], { windowsHide: true });
      let output = '', error = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
    });
    assert.equal(result.status, 'blocked'); assert.equal(result.startupHealthy, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
