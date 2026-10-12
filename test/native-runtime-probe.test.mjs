import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fixturePrivateState } from './fixture-private-state.mjs';
import { probePersistentHistory, probeCodexRuntime, evaluateBootRuntime } from '../app/runtime-verification.mjs';

test('readable persistent state without a boot identity never creates or accepts a reboot witness', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-unknown-boot-'));
  try {
    const sourceRoot = path.join(directory, 'source'), state = path.join(directory, 'state'), codexHome = path.join(state, 'codex');
    await fs.mkdir(sourceRoot); await fs.mkdir(codexHome, { recursive: true });
    const project = { path: path.parse(directory).root, threadId: 'saved-thread' };
    await fs.writeFile(path.join(state, 'state.json'), JSON.stringify({ selected: project.path, projects: { [project.path]: project } }));
    await fs.writeFile(path.join(state, 'journal.jsonl'), JSON.stringify({ type: 'notice', time: new Date().toISOString() }) + '\n');
    const history = await probePersistentHistory({ directory: state, codexHome, sourceRoot, osRoot: project.path, project, privacy: fixturePrivateState(directory) });
    assert.equal(history.storageConfigured, true); assert.equal(history.historyReadable, true); assert.equal(history.survivedBoot, false);
    await assert.rejects(fs.stat(path.join(state, 'runtime-history-witness.json')), { code: 'ENOENT' });
    assert.equal(evaluateBootRuntime({ edition: 'WinVOS', history }).checks.persistentHistory, false);
  } finally {
    const resolved = await fs.realpath(directory), relative = path.relative(await fs.realpath(os.tmpdir()), resolved);
    assert.ok(relative.startsWith('volterra-unknown-boot-') && !relative.includes(path.sep));
    await fs.rm(resolved, { recursive: true });
  }
});

test('native Node command stays read-only and cannot run until Codex sandbox readiness succeeds', async () => {
  class Bridge extends EventEmitter {
    calls = []; ready = false;
    async start() {}
    async stop() {}
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'account/read') return { account: null };
      if (method === 'windowsSandbox/readiness') return { status: this.ready ? 'ready' : 'notConfigured' };
      if (method === 'command/exec') return { exitCode: 0, stdout: '10.0.26100\n', stderr: '' };
      throw new Error('Unexpected protocol request.');
    }
  }
  const bridge = new Bridge(), versionCommand = ['X:\\Volterra\\private\\tools\\node.exe', '-p', 'require("node:os").release()'];
  const blocked = await probeCodexRuntime(bridge, { versionCommand, cwd: 'X:\\' });
  assert.equal(blocked.sandboxCommandCompleted, false);
  assert.equal(bridge.calls.some(call => call.method === 'command/exec'), false);
  bridge.ready = true;
  const observed = await probeCodexRuntime(bridge, { versionCommand, cwd: 'X:\\' });
  const command = bridge.calls.find(call => call.method === 'command/exec');
  assert.deepEqual(command.params.command, versionCommand);
  assert.deepEqual(command.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(observed.sandboxCommandCompleted, true); assert.equal(observed.chatgptAccountObserved, false);
  assert.equal(bridge.calls.some(call => /setup|login|turn\//.test(call.method)), false);
});
