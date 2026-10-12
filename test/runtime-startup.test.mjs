import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { EventEmitter } from 'node:events';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-delayed-start-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });

test('HTTP readiness remains false until the actual Codex initialization finishes', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const startup = new Promise(resolve => { started = resolve; });
  class DelayedCodex extends EventEmitter {
    async start() { this.child = {}; started(); await gate; }
    async stop() { this.child = null; }
    async request(method) {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'startup-thread' } };
      if (method === 'turn/start') return { turn: { id: 'startup-turn' } };
      return {};
    }
  }
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const repository = { initialize: async () => {}, compare: async () => ({ current: 'same', latest: 'same', ahead: 0, behind: 0, diverged: false }) };
  let application;
  const creation = createApplication({ port, autostart: true, codex: new DelayedCodex(), repository });
  try {
    await startup;
    const page = await fetch('http://127.0.0.1:' + port + '/');
    const headers = { Cookie: page.headers.get('set-cookie').split(';')[0] };
    const initial = await (await fetch('http://127.0.0.1:' + port + '/api/state', { headers })).json();
    assert.equal(initial.running, true); assert.equal(initial.runtimeReady, false);
    release(); application = await creation; assert.equal(application.snapshot().runtimeReady, true);
  } finally { release(); application ||= await creation; await application.close(); }
});
