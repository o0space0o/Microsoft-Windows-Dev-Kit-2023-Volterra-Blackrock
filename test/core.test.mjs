import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
const { projectPath } = await import('../app/storage.mjs');
const { createApplication } = await import('../app/server.mjs');
const { redact } = await import('../app/platform.mjs');

test('project files cannot escape through traversal or an external directory junction', async () => {
  const project = path.join(directory, 'project'), outside = path.join(directory, 'outside');
  await fs.mkdir(project); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(projectPath(project, '../outside/secret.txt'), /inside/);
  await assert.rejects(projectPath(project, 'linked/secret.txt'), /outside/);
  await assert.rejects(projectPath(project, 'linked/new.txt', true), /outside/);
  assert.equal(await projectPath(project, 'new.txt', true), path.join(project, 'new.txt'));
});

class FakeCodex extends EventEmitter {
  calls = []; counter = 0;
  async start() { this.child = {}; }
  stop() { this.child = null; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'test@example.invalid' } };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || 'saved-thread' } };
    if (method === 'turn/start') return { turn: { id: `turn-${++this.counter}` } };
    return {};
  }
}

test('local endpoints require the launch cookie, exact origin and anti-CSRF header', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex() });
  try {
    assert.equal(app.snapshot().project.path, await fs.realpath(path.resolve('.')));
    assert.equal((await fetch(app.origin + '/api/state')).status, 403);
    const response = await fetch(app.origin); const source = await response.text();
    const token = source.match(/name="volterra-session" content="([a-f0-9]+)"/)[1];
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const headers = { cookie, 'Content-Type': 'application/json', 'X-Volterra-Client': token };
    assert.equal((await fetch(app.origin + '/api/project/open', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(app.origin + '/api/project/open', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(app.origin + '/api/state', { headers: { cookie } })).status, 200);
  } finally { await app.close(); }
});

test('messages steer an active turn, pause waits for interruption, and project history resumes after restart', async () => {
  const fake = new FakeCodex(); let app = await createApplication({ port: 0, codex: fake });
  const project = path.join(directory, 'resume-project'); await fs.mkdir(project);
  try {
    await app.actions['project/open']({ path: project }); await app.actions['codex/connect']();
    await app.actions['agent/send']({ text: 'First instruction' });
    await app.actions['agent/send']({ text: 'Follow-up instruction' });
    assert.equal(fake.calls.at(-1).method, 'turn/steer');
    await app.actions['agent/interrupt']({ pause: true });
    assert.equal(app.snapshot().paused, false);
    fake.emit('notification', { method: 'turn/completed', params: { threadId: 'saved-thread', turn: { id: 'turn-1', status: 'interrupted' } } });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(app.snapshot().paused, true);
    await app.actions['file/save']({ path: 'result.txt', content: 'Saved on disk' });
    assert.equal(await fs.readFile(path.join(project, 'result.txt'), 'utf8'), 'Saved on disk');
    await app.close();
    const restarted = new FakeCodex(); app = await createApplication({ port: 0, codex: restarted });
    await app.actions['project/resume']();
    assert.equal(restarted.calls.find(call => call.method === 'thread/resume').params.threadId, 'saved-thread');
    assert.equal(app.snapshot().project.path, project);
  } finally { await app.close(); }
});

test('common credential formats are removed from display output', () => {
  assert.equal(redact('Bearer abc-secret'), 'Bearer [redacted]');
  assert.equal(redact('ghp_abcdefghijklmnop'), '[redacted token]');
});

test('public ChatGPT sign-in endpoint uses native Codex browser authorization without an app credential', async () => {
  const opened = [];
  class NativeLoginCodex extends FakeCodex {
    async request(method, params) {
      if (method === 'account/login/start') { this.calls.push({ method, params }); return { loginId: 'native-login', authUrl: 'https://auth.openai.com/authorize?state=native-test' }; }
      return super.request(method, params);
    }
  }
  const fake = new NativeLoginCodex(), app = await createApplication({ port: 0, codex: fake, browserOpener: async url => opened.push(url) });
  try {
    const page = await fetch(app.origin), html = await page.text();
    const token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1];
    const headers = { Cookie: page.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-Volterra-Client': token };
    const response = await fetch(app.origin + '/api/chatgpt/sign-in', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'Waiting for browser sign-in');
    assert.deepEqual(fake.calls.find(call => call.method === 'account/login/start').params, { type: 'chatgpt' });
    assert.deepEqual(opened, ['https://auth.openai.com/authorize?state=native-test']);
    assert.equal(app.state.authMode, 'codex');
    await assert.rejects(fs.stat(path.join(process.env.VOLTERRA_STATE_DIR, 'chatgpt.dpapi')), { code: 'ENOENT' });
  } finally { await app.close(); }
});

test('OS root is selected without setup and first browser sign-in starts the project brief once', async () => {
  const system = path.join(directory, 'system'); await fs.mkdir(system);
  process.env.VOLTERRA_OS_ROOT = system;
  const fake = new FakeCodex(), app = await createApplication({ port: 0, codex: fake });
  try {
    assert.equal(app.snapshot().project.path, await fs.realpath(system));
    assert.equal(app.state.autoContinueVision, true);
    app.state.authMode = 'codex';
    fake.emit('notification', { method: 'account/login/completed', params: { success: true } });
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.match(fake.calls.find(call => call.method === 'turn/start').params.input[0].text, /system workspace is automatic/i);
    assert.equal(app.state.autoContinueVision, false);
    fake.emit('notification', { method: 'account/login/completed', params: { success: true } });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { delete process.env.VOLTERRA_OS_ROOT; await app.close(); }
});

test.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
