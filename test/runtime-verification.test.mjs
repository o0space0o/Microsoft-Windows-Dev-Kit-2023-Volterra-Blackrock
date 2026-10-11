import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { probeCodexRuntime, probePersistentHistory, evaluateBootRuntime, inspectBrowserCapture, waitForHelperRuntime } from '../app/runtime-verification.mjs';

const ready = () => ({
  edition: 'WinVOS', versionsVerified: true, systemRoot: 'A:\\', automaticWorkspace: 'a:\\', serverReady: true, helperRuntimeReady: true, helperRuntimeRunning: true,
  helperChatgptAccountObserved: true,
  history: { storageConfigured: true, historyReadable: true, survivedBoot: true },
  historyContext: { project: { path: 'A:\\', threadId: 'saved-thread' } },
  codexProtocol: { appServerInitialized: true, chatgptAccountObserved: true, nativeSandboxReady: true, sandboxCommandCompleted: true, savedThreadReadable: true, savedThreadId: 'saved-thread' },
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
  for (const key of ['helperRuntimeReady', 'helperRuntimeRunning', 'serverReady', 'versionsVerified', 'helperChatgptAccountObserved']) {
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
  const changed = ready(); changed.historyContext.project.threadId = 'new-thread';
  assert.equal(evaluateBootRuntime(changed).checks.persistentHistory, false);
  delete changed.codexProtocol.savedThreadId;
  assert.equal(evaluateBootRuntime(changed).checks.persistentHistory, false);
});

test('helper polling waits through delayed initialization and uses a fresh authenticated snapshot after a stop', async () => {
  let generation = 0, stateReads = 0, stopped = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/') {
      generation++;
      response.writeHead(200, { 'Set-Cookie': `launch-${generation}=test; HttpOnly; SameSite=Strict` }).end('helper');
    } else if (request.url === '/api/state') {
      if (request.headers.cookie !== `launch-${generation}=test`) { response.writeHead(403).end(); return; }
      stateReads++;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        running: !stopped, runtimeReady: !stopped && stateReads >= 2,
        project: { path: 'A:\\', threadId: 'saved-thread' }, authMode: 'codex',
        account: stateReads >= 2 ? { type: 'chatgpt', email: 'private@example.invalid' } : null,
        journal: [{ type: 'message', data: 'private conversation' }]
      }));
    } else response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const initialized = await waitForHelperRuntime(origin, { intervalMs: 5, timeoutMs: 2000 });
    assert.equal(stateReads, 2);
    assert.equal(initialized.helperRuntimeReady, true); assert.equal(initialized.helperChatgptAccountObserved, true);
    assert.equal(initialized.project.threadId, 'saved-thread');
    assert.equal(JSON.stringify(initialized).includes('private@'), false);
    assert.equal(JSON.stringify(initialized).includes('private conversation'), false);
    stopped = true;
    const refreshed = await waitForHelperRuntime(origin, { intervalMs: 5, timeoutMs: 50 });
    assert.equal(refreshed.helperRuntimeReady, false); assert.equal(refreshed.helperRuntimeRunning, false);
    const runtime = ready(); Object.assign(runtime, initialized);
    assert.equal(evaluateBootRuntime(runtime).startupHealthy, true);
    Object.assign(runtime, refreshed);
    assert.equal(evaluateBootRuntime(runtime).startupHealthy, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('polling does not wait for first sign-in and cannot reuse a snapshot after a failed state request', async () => {
  let time = 0, reads = 0;
  const options = {
    timeoutMs: 20, intervalMs: 10, now: () => time, delay: async ms => { time += ms; },
    fetchImpl: async url => url.endsWith('/api/state')
      ? new Response(JSON.stringify({ running: true, runtimeReady: true, project: { path: 'A:\\', threadId: null }, account: null }), { status: 200 })
      : new Response('helper', { headers: { 'Set-Cookie': 'launch=test; HttpOnly' } })
  };
  const signedOut = await waitForHelperRuntime('http://127.0.0.1:43123', options);
  assert.equal(signedOut.helperRuntimeReady, true); assert.equal(signedOut.helperChatgptAccountObserved, false);
  options.fetchImpl = async url => {
    if (!url.endsWith('/api/state')) return new Response('helper', { headers: { 'Set-Cookie': 'launch=test' } });
    reads++;
    if (reads > 1) return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify({ running: true, runtimeReady: false, project: { path: 'A:\\', threadId: 'old-thread' } }));
  };
  const failed = await waitForHelperRuntime('http://127.0.0.1:43123', options);
  assert.equal(failed.serverReady, false); assert.equal(failed.helperRuntimeReady, false);
  assert.equal(failed.project, null); assert.match(failed.error, /503/);
  await assert.rejects(waitForHelperRuntime('https://untrusted.example', options), /local helper/);
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
  assert.equal(result.savedThreadId, 'saved-thread');
  assert.equal(result.chatgptAccountObserved, true);
  assert.deepEqual(bridge.calls.find(call => call.method === 'command/exec').params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.deepEqual(bridge.calls.find(call => call.method === 'thread/read').params, { threadId: 'saved-thread', includeTurns: false });
  assert.equal(bridge.calls.some(call => /setup|login|turn\//.test(call.method)), false);
  assert.equal(JSON.stringify(result).includes('never-export@example.invalid'), false);
  assert.equal(bridge.stopped, true);
});

test('Codex directory junctions cannot escape persistent storage or point into public source', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-history-junction-'));
  const sourceRoot = path.join(directory, 'source'), state = path.join(directory, 'state'), outside = path.join(directory, 'outside');
  const codexHome = path.join(state, 'codex');
  try {
    await Promise.all([fs.mkdir(sourceRoot), fs.mkdir(state), fs.mkdir(outside)]);
    const options = { directory: state, codexHome, sourceRoot, osRoot: path.parse(directory).root, bootId: 'boot-one', project: { path: path.parse(directory).root, threadId: 'saved-thread' } };
    for (const target of [outside, sourceRoot]) {
      await fs.symlink(target, codexHome, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await probePersistentHistory(options);
      assert.equal(result.storageConfigured, false); assert.equal(result.survivedBoot, false);
      await assert.rejects(fs.stat(path.join(state, 'runtime-history-witness.json')), { code: 'ENOENT' });
      await fs.unlink(codexHome);
    }
    // Even a source tree below the persistent state folder is public source.
    const nestedSource = path.join(state, 'Volterra'); await fs.mkdir(nestedSource);
    await fs.symlink(nestedSource, codexHome, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await probePersistentHistory({ ...options, sourceRoot: nestedSource })).storageConfigured, false);
    await fs.unlink(codexHome);
    const privateHistory = path.join(state, 'history'); await fs.mkdir(privateHistory);
    await fs.symlink(privateHistory, codexHome, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await probePersistentHistory({ ...options, project: { path: options.project.path, threadId: null } })).storageConfigured, true);
    await fs.unlink(codexHome);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('canonical Codex home on a RAM volume is rejected before reading history', async t => {
  const filesystem = await import('node:fs/promises');
  const state = 'A:\\VolterraState', sourceRoot = 'A:\\Volterra', home = 'X:\\codex';
  t.mock.method(filesystem.default, 'realpath', async value => value === path.join(state, 'codex') ? home : value);
  t.mock.method(filesystem.default, 'readFile', async () => { assert.fail('Rejected storage must not read history'); });
  const result = await probePersistentHistory({ directory: state, codexHome: path.join(state, 'codex'), sourceRoot, osRoot: 'A:\\', bootId: 'boot-one', project: { path: 'A:\\', threadId: 'saved-thread' } });
  assert.equal(result.storageConfigured, false); assert.equal(result.historyReadable, false); assert.equal(result.survivedBoot, false);
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
