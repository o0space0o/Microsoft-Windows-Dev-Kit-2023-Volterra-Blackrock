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
