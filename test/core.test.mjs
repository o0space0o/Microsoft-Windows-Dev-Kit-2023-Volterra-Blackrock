import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { projectPath } = await import('../app/storage.mjs');
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });
const { redact } = await import('../app/platform.mjs');

// These interactive fixtures must not inherit the launcher's automatic queue or use live Git.
const unexpectedRepositoryCalls = [];
const unusedRepository = Object.fromEntries(['initialize', 'compare', 'checkpoint', 'push', 'stage'].map(method => [method, async () => {
  unexpectedRepositoryCalls.push(method); assert.fail(`Interactive fixture unexpectedly called repository.${method}`);
}]));
const createInteractiveFixture = options => createApplication({ ...options, autostart: false, repository: unusedRepository });
async function waitFor(condition, message) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

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
  async notify(notification) {
    const listeners = this.listeners('notification');
    assert.equal(listeners.length, 1);
    await listeners[0](notification);
  }
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
  const app = await createInteractiveFixture({ port: 0, codex: new FakeCodex() });
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
  const fake = new FakeCodex(); let app = await createInteractiveFixture({ port: 0, codex: fake });
  const project = path.join(directory, 'resume-project'); await fs.mkdir(project);
  try {
    await app.actions['project/open']({ path: project }); await app.actions['codex/connect']();
    await app.actions['agent/send']({ text: 'First instruction' });
    await app.actions['agent/send']({ text: 'Follow-up instruction' });
    assert.equal(fake.calls.at(-1).method, 'turn/steer');
    await app.actions['agent/interrupt']({ pause: true });
    assert.equal(app.snapshot().paused, false);
    await fake.notify({ method: 'turn/completed', params: { threadId: 'saved-thread', turn: { id: 'turn-1', status: 'interrupted' } } });
    assert.equal(app.snapshot().paused, true);
    await app.actions['file/save']({ path: 'result.txt', content: 'Saved on disk' });
    assert.equal(await fs.readFile(path.join(project, 'result.txt'), 'utf8'), 'Saved on disk');
    await app.close();
    const restarted = new FakeCodex(); app = await createInteractiveFixture({ port: 0, codex: restarted });
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
  const fake = new NativeLoginCodex(), app = await createInteractiveFixture({ port: 0, codex: fake, browserOpener: async url => opened.push(url) });
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

test('unverified browser privacy blocks ChatGPT login before an authorization flow starts', async () => {
  const fake = new FakeCodex(); let opened = false;
  const app = await createInteractiveFixture({ port: 0, codex: fake, browserOpener: async () => { opened = true; },
    statePrivacy: options => options.scope === 'browser' ? Promise.reject(new Error('Fixture browser privacy refused.')) : statePrivacy(options) });
  try {
    await assert.rejects(app.actions['chatgpt/sign-in']({}), /browser privacy refused/);
    assert.equal(fake.calls.some(call => call.method === 'account/login/start'), false);
    assert.equal(opened, false);
  } finally { await app.close(); }
});

test('GitHub authorization launches with the verified configured browser namespace', async () => {
  const previous = process.env.VOLTERRA_BROWSER_PROFILE, profile = path.join(directory, 'configured-browser');
  await fs.mkdir(profile); await fs.writeFile(path.join(profile, 'existing-profile.fixture'), 'Existing browser fixture');
  process.env.VOLTERRA_BROWSER_PROFILE = profile;
  const checked = [], launches = [];
  const app = await createInteractiveFixture({ port: 0, codex: new FakeCodex(), statePrivacy: async options => {
    checked.push({ directory: options.directory, scope: options.scope }); return statePrivacy(options);
  }, githubSpawner(executable, args, options) {
    launches.push({ executable, args, options });
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child;
  } });
  try {
    await app.actions['github/sign-in']();
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0].args, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web']);
    assert.equal(launches[0].options.env.VOLTERRA_BROWSER_PROFILE, profile);
    assert.ok(checked.some(value => value.scope === 'browser' && value.directory === profile));
    assert.equal(await fs.readFile(path.join(profile, 'existing-profile.fixture'), 'utf8'), 'Existing browser fixture');
  } finally { await app.close(); if (previous === undefined) delete process.env.VOLTERRA_BROWSER_PROFILE; else process.env.VOLTERRA_BROWSER_PROFILE = previous; }
});

test('without the automatic queue, OS root is selected and completed sign-in starts the project brief once', async () => {
  const system = path.join(directory, 'system'); await fs.mkdir(system);
  process.env.VOLTERRA_OS_ROOT = system;
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'automation-state.json'), JSON.stringify({ version: 1, enabled: false,
    paused: false, phase: 'idle', task: 0 }));
  const fake = new FakeCodex(), app = await createInteractiveFixture({ port: 0, codex: fake });
  try {
    assert.equal(app.automation.saved.enabled, false);
    assert.equal(app.snapshot().project.path, await fs.realpath(system));
    assert.equal(app.state.autoContinueVision, true);
    app.state.authMode = 'codex';
    await fake.notify({ method: 'account/login/completed', params: { success: true } });
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.match(fake.calls.find(call => call.method === 'turn/start').params.input[0].text, /system workspace is automatic/i);
    assert.equal(app.state.autoContinueVision, false);
    await fake.notify({ method: 'account/login/completed', params: { success: true } });
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally { delete process.env.VOLTERRA_OS_ROOT; await app.close(); }
});

test('concurrent and repeated sign-in notifications retain one saved queue startup and its running phase', async () => {
  const system = path.join(directory, 'queue-system'); await fs.mkdir(system);
  const canonical = await fs.realpath(system), previousRoot = process.env.VOLTERRA_OS_ROOT;
  process.env.VOLTERRA_OS_ROOT = canonical;
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'state.json'), JSON.stringify({ version: 1, authMode: null,
    projects: { [canonical]: { path: canonical, name: 'System workspace', threadId: 'queue-thread' } }, selected: canonical, autoContinueVision: true }));
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'automation-state.json'), JSON.stringify({ version: 1, enabled: true,
    paused: false, phase: 'working', task: 1, failures: 0, pendingOutcome: null, reviewPassed: false }));
  let signedIn = false;
  let releaseThread;
  const threadGate = new Promise(resolve => { releaseThread = resolve; });
  class QueueCodex extends FakeCodex {
    async request(method, params) {
      if (method === 'account/read' && !signedIn) { this.calls.push({ method, params }); return { account: null }; }
      if (method === 'thread/resume') { this.calls.push({ method, params }); await threadGate; return { thread: { id: params.threadId } }; }
      return super.request(method, params);
    }
  }
  const repositoryCalls = [], repository = {
    initialize: async () => { repositoryCalls.push('initialize'); },
    compare: async () => { repositoryCalls.push('compare'); return { current: 'a'.repeat(40), latest: 'a'.repeat(40), ahead: 0, behind: 0, diverged: false }; },
    checkpoint: async () => assert.fail('Startup must not checkpoint source'), push: async () => assert.fail('Startup must not publish source')
  };
  const fake = new QueueCodex(); let app, firstLogin, overlappingLogin;
  try {
    app = await createApplication({ port: 0, codex: fake, autostart: true, repository });
    assert.equal(app.snapshot().automation.phase, 'waiting-for-sign-in'); assert.deepEqual(repositoryCalls, []);
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 0);
    const signInNotices = () => app.snapshot().journal.filter(entry => entry.type === 'notice' && entry.data === 'Codex browser sign-in completed.').length;
    const previousNotices = signInNotices();
    signedIn = true;
    firstLogin = fake.notify({ method: 'account/login/completed', params: { success: true } });
    await waitFor(() => fake.calls.some(call => call.method === 'thread/resume'), 'The first login did not resume the saved queue thread.');
    assert.equal(app.snapshot().activeTurn, null); assert.equal(app.snapshot().automation.phase, 'working');
    overlappingLogin = fake.notify({ method: 'account/login/completed', params: { success: true } });
    await waitFor(() => signInNotices() === previousNotices + 2, 'The overlapping login notification was not handled.');
    assert.equal(app.snapshot().automation.phase, 'working');
    releaseThread(); await Promise.all([firstLogin, overlappingLogin]);
    assert.deepEqual(repositoryCalls, ['initialize', 'compare']);
    assert.equal(fake.calls.find(call => call.method === 'thread/resume').params.threadId, 'queue-thread');
    assert.equal(fake.calls.find(call => call.method === 'thread/resume').params.cwd, canonical);
    const starts = fake.calls.filter(call => call.method === 'turn/start');
    assert.equal(starts.length, 1); assert.match(starts[0].params.input[0].text, /Task: Build the organized system tools/);
    assert.equal(starts[0].params.threadId, 'queue-thread'); assert.equal(app.snapshot().automation.task, 1);
    assert.equal(app.snapshot().automation.phase, 'working'); assert.equal(app.state.autoContinueVision, true);
    const activeTurn = app.snapshot().activeTurn;
    await fake.notify({ method: 'account/login/completed', params: { success: true } });
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(app.snapshot().activeTurn, activeTurn); assert.equal(app.snapshot().automation.phase, 'working');
    assert.deepEqual(repositoryCalls, ['initialize', 'compare']);
    await fake.notify({ method: 'turn/completed', params: { threadId: 'queue-thread', turn: { id: activeTurn, status: 'completed',
      items: [{ type: 'agentMessage', text: JSON.stringify({ status: 'progress', summary: 'Original source fixture increment' }) }] } } });
    assert.equal(app.snapshot().automation.phase, 'reviewing'); assert.equal(app.snapshot().automation.pendingOutcome.status, 'progress');
    assert.equal(app.snapshot().automation.task, 1);
    const review = fake.calls.filter(call => call.method === 'turn/start');
    assert.equal(review.length, 2); assert.match(review[1].params.input[0].text, /Review the current source changes independently/);
    assert.deepEqual(review[1].params.sandboxPolicy, { type: 'readOnly' }); assert.deepEqual(repositoryCalls, ['initialize', 'compare']);
  } finally {
    releaseThread(); await Promise.allSettled([firstLogin, overlappingLogin].filter(Boolean));
    await app?.close();
    if (previousRoot === undefined) delete process.env.VOLTERRA_OS_ROOT; else process.env.VOLTERRA_OS_ROOT = previousRoot;
  }
});

test('completed browser sign-in preserves a saved queue pause and never initializes the repository', async () => {
  const system = path.join(directory, 'paused-queue-system'); await fs.mkdir(system);
  const canonical = await fs.realpath(system), previousRoot = process.env.VOLTERRA_OS_ROOT;
  process.env.VOLTERRA_OS_ROOT = canonical;
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'state.json'), JSON.stringify({ version: 1, authMode: null,
    projects: { [canonical]: { path: canonical, name: 'System workspace', threadId: 'paused-thread' } }, selected: canonical, autoContinueVision: true }));
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'automation-state.json'), JSON.stringify({ version: 1, enabled: true,
    paused: true, phase: 'paused', task: 1, failures: 2, pendingOutcome: null, reviewPassed: false }));
  let signedIn = false;
  class PausedCodex extends FakeCodex {
    async request(method, params) {
      if (method === 'account/read' && !signedIn) { this.calls.push({ method, params }); return { account: null }; }
      return super.request(method, params);
    }
  }
  const repositoryCalls = [], repository = Object.fromEntries(['initialize', 'compare', 'checkpoint', 'push'].map(method => [method, async () => {
    repositoryCalls.push(method); assert.fail(`Paused startup called repository.${method}`);
  }]));
  const fake = new PausedCodex(); let app;
  try {
    app = await createApplication({ port: 0, codex: fake, autostart: true, repository });
    assert.equal(app.snapshot().automation.phase, 'paused'); signedIn = true;
    await fake.notify({ method: 'account/login/completed', params: { success: true } });
    assert.equal(app.snapshot().automation.phase, 'paused'); assert.equal(app.snapshot().automation.paused, true);
    assert.equal(app.snapshot().automation.task, 1); assert.equal(app.snapshot().automation.failures, 2);
    assert.equal(app.snapshot().project.threadId, 'paused-thread'); assert.equal(app.snapshot().activeTurn, null);
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 0); assert.deepEqual(repositoryCalls, []);
  } finally {
    await app?.close();
    if (previousRoot === undefined) delete process.env.VOLTERRA_OS_ROOT; else process.env.VOLTERRA_OS_ROOT = previousRoot;
  }
});

test('corrupt queue recovery stays paused through early and completed sign-in and preserves the project thread', async () => {
  const system = path.join(directory, 'corrupt-queue-system'); await fs.mkdir(system);
  const canonical = await fs.realpath(system), previousRoot = process.env.VOLTERRA_OS_ROOT;
  process.env.VOLTERRA_OS_ROOT = canonical;
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'state.json'), JSON.stringify({ version: 1, authMode: 'codex',
    projects: { [canonical]: { path: canonical, name: 'System workspace', threadId: 'retained-corrupt-thread' } }, selected: canonical, autoContinueVision: true }));
  const invalid = Buffer.from(', PRIVATE_QUEUE_CONTENTS');
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'automation-state.json'), invalid);
  class EarlySignInCodex extends FakeCodex {
    async start() { this.child = {}; await this.notify({ method: 'account/login/completed', params: { success: true } }); }
  }
  const fake = new EarlySignInCodex(); let app;
  try {
    app = await createInteractiveFixture({ port: 0, codex: fake });
    assert.equal(app.snapshot().automation.enabled, false); assert.equal(app.snapshot().automation.paused, true);
    assert.equal(app.snapshot().automation.phase, 'paused'); assert.equal(app.snapshot().project.threadId, 'retained-corrupt-thread');
    assert.equal(app.state.authMode, 'codex'); assert.equal(app.state.autoContinueVision, true);
    assert.equal(fake.calls.filter(call => call.method === 'turn/start' || call.method === 'thread/resume').length, 0);
    await fake.notify({ method: 'account/login/completed', params: { success: true } });
    assert.equal(fake.calls.filter(call => call.method === 'turn/start' || call.method === 'thread/resume').length, 0);
    const notices = app.snapshot().journal.filter(entry => entry.type === 'notice' && typeof entry.data === 'string' && entry.data.includes('saved automation queue'));
    assert.equal(notices.length, 1); assert.match(notices[0].data, /disabled and paused/);
    assert.doesNotMatch(JSON.stringify(app.snapshot().journal), /PRIVATE_QUEUE_CONTENTS|quarantine-|Unexpected token/);
    const names = (await fs.readdir(process.env.VOLTERRA_STATE_DIR)).filter(name => name.startsWith('automation-state-quarantine-'));
    assert.equal(names.length, 1); assert.deepEqual(await fs.readFile(path.join(process.env.VOLTERRA_STATE_DIR, names[0])), invalid);
    const page = await fetch(app.origin), cookie = page.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(app.origin + '/api/state', { headers: { Cookie: cookie } })).status, 200);
  } finally {
    await app?.close();
    if (previousRoot === undefined) delete process.env.VOLTERRA_OS_ROOT; else process.env.VOLTERRA_OS_ROOT = previousRoot;
  }
});

test('an authorized early sign-in waits for queue loading and continues once when the valid queue is unpaused', async () => {
  const system = path.join(directory, 'early-valid-queue-system'); await fs.mkdir(system);
  const canonical = await fs.realpath(system), previousRoot = process.env.VOLTERRA_OS_ROOT;
  process.env.VOLTERRA_OS_ROOT = canonical;
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'state.json'), JSON.stringify({ version: 1, authMode: 'codex',
    projects: { [canonical]: { path: canonical, name: 'System workspace', threadId: 'retained-early-thread' } }, selected: canonical, autoContinueVision: true }));
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'automation-state.json'), JSON.stringify({ version: 1, enabled: false, paused: false, phase: 'idle', task: 0 }));
  class EarlySignInCodex extends FakeCodex {
    async start() { this.child = {}; await this.notify({ method: 'account/login/completed', params: { success: true } }); }
  }
  const fake = new EarlySignInCodex(); let app;
  try {
    app = await createInteractiveFixture({ port: 0, codex: fake });
    assert.equal(app.automation.loaded, true); assert.equal(app.state.autoContinueVision, false);
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(fake.calls.find(call => call.method === 'thread/resume').params.threadId, 'retained-early-thread');
    await fake.notify({ method: 'account/login/completed', params: { success: true } });
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 1);
  } finally {
    await app?.close();
    if (previousRoot === undefined) delete process.env.VOLTERRA_OS_ROOT; else process.env.VOLTERRA_OS_ROOT = previousRoot;
  }
});

async function lifecycleFixture(name, heldOperation) {
  const system = path.join(directory, name); await fs.mkdir(system);
  const canonical = await fs.realpath(system), previousRoot = process.env.VOLTERRA_OS_ROOT;
  process.env.VOLTERRA_OS_ROOT = canonical;
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'state.json'), JSON.stringify({ version: 1, authMode: 'codex',
    projects: { [canonical]: { path: canonical, name: 'System workspace', threadId: 'lifecycle-thread' } }, selected: canonical, autoContinueVision: true }));
  await fs.writeFile(path.join(process.env.VOLTERRA_STATE_DIR, 'automation-state.json'), JSON.stringify({ version: 1, enabled: true,
    paused: false, phase: 'idle', task: 1, failures: 2, pendingOutcome: null, reviewPassed: false }));
  let signedIn = false, release;
  const gate = new Promise(resolve => { release = resolve; }), calls = [];
  async function operation(name) {
    calls.push(name);
    if (name === heldOperation && calls.filter(call => call === name).length === 1) await gate;
  }
  class LifecycleCodex extends FakeCodex {
    async request(method, params) {
      if (method === 'account/read' && !signedIn) { this.calls.push({ method, params }); return { account: null }; }
      if (method === 'thread/resume') { await operation(method); }
      return super.request(method, params);
    }
  }
  const commit = 'b'.repeat(40), repository = {
    initialize: async () => operation('initialize'),
    compare: async () => { await operation('compare'); return { current: 'a'.repeat(40), latest: 'a'.repeat(40), ahead: 0, behind: 0, diverged: false }; },
    checkpoint: async () => { await operation('checkpoint'); return { changed: true, commit }; },
    push: async () => { await operation('push'); return { commit }; }
  };
  const fake = new LifecycleCodex(); let app;
  const restoreRoot = () => { if (previousRoot === undefined) delete process.env.VOLTERRA_OS_ROOT; else process.env.VOLTERRA_OS_ROOT = previousRoot; };
  try { app = await createApplication({ port: 0, codex: fake, autostart: true, repository }); }
  catch (error) { release(); restoreRoot(); throw error; }
  return { app, fake, calls, commit, release,
    connect: async () => { signedIn = true; await app.actions['codex/connect'](); },
    login: async () => { signedIn = true; await fake.notify({ method: 'account/login/completed', params: { success: true } }); },
    complete: async outcome => fake.notify({ method: 'turn/completed', params: { threadId: 'lifecycle-thread', turn: {
      id: app.snapshot().activeTurn, status: 'completed', items: [{ type: 'agentMessage', text: JSON.stringify(outcome) }] } } }),
    close: async () => { release(); await app.close(); restoreRoot(); }
  };
}

test('login during an independent busy tick retains the working phase and sends its outcome to review', async () => {
  const fixture = await lifecycleFixture('busy-tick', 'thread/resume'); let tick;
  const { app, fake, calls } = fixture;
  try {
    await fixture.connect(); tick = app.automation.tick();
    await waitFor(() => calls.includes('thread/resume'), 'The independent tick did not reach its thread resume.');
    assert.equal(app.automation.busy, true); assert.equal(app.snapshot().activeTurn, null);
    assert.equal(app.snapshot().automation.phase, 'working');
    const before = structuredClone(app.automation.saved);
    await fixture.login(); await fixture.login();
    assert.deepEqual(app.automation.saved, before);
    assert.deepEqual(calls, ['initialize', 'compare', 'thread/resume']);
    fixture.release(); await tick;
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 1);
    await fixture.complete({ status: 'progress', summary: 'Deferred tick increment' });
    assert.equal(app.snapshot().automation.phase, 'reviewing');
    assert.equal(app.snapshot().automation.pendingOutcome.summary, 'Deferred tick increment');
    assert.equal(app.snapshot().automation.failures, 2);
    const turns = fake.calls.filter(call => call.method === 'turn/start');
    assert.equal(turns.length, 2); assert.deepEqual(turns[1].params.sandboxPolicy, { type: 'readOnly' });
  } finally { fixture.release(); await tick; await fixture.close(); }
});

for (const [operation, phase] of [['checkpoint', 'checking'], ['push', 'publishing']]) {
  test(`login and scheduler ticks preserve a deferred ${phase} operation without duplicate publication or early work`, async () => {
    const fixture = await lifecycleFixture(`deferred-${operation}`, operation); let completion;
    const { app, fake, calls, commit } = fixture;
    try {
      await fixture.login();
      await fixture.complete({ status: 'progress', summary: `Deferred ${operation} increment` });
      completion = fixture.complete({ status: 'complete', summary: 'Independent review passed' });
      await waitFor(() => calls.includes(operation), `The review did not reach ${operation}.`);
      assert.equal(app.snapshot().activeTurn, null); assert.equal(app.snapshot().automation.phase, phase);
      const before = structuredClone(app.automation.saved), previousCalls = [...calls];
      await fixture.login(); await fixture.login(); await app.automation.tick();
      assert.deepEqual(app.automation.saved, before); assert.deepEqual(calls, previousCalls);
      assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 2);
      fixture.release(); await completion;
      assert.equal(app.snapshot().automation.phase, 'idle'); assert.equal(app.snapshot().automation.task, 1);
      assert.equal(app.snapshot().automation.pendingOutcome, null); assert.equal(app.snapshot().automation.lastCommit, commit);
      assert.equal(calls.filter(call => call === 'checkpoint').length, 1); assert.equal(calls.filter(call => call === 'push').length, 1);
      await app.automation.tick();
      assert.equal(app.snapshot().automation.phase, 'working');
      assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 3);
      assert.equal(calls.filter(call => call === 'checkpoint').length, 1); assert.equal(calls.filter(call => call === 'push').length, 1);
    } finally { fixture.release(); await completion; await fixture.close(); }
  });
}

test('completed login retains a failed source gate without retrying it or clearing its diagnostic', async () => {
  const fixture = await lifecycleFixture('failed-source-gate');
  const { app, fake, calls } = fixture;
  app.automation.repository.checkpoint = async () => { calls.push('checkpoint'); throw new Error('Fixture source gate failed'); };
  try {
    await fixture.login();
    await fixture.complete({ status: 'progress', summary: 'Candidate requiring source checks' });
    await fixture.complete({ status: 'complete', summary: 'Independent review passed' });
    assert.equal(app.snapshot().automation.phase, 'blocked');
    assert.equal(app.snapshot().automation.lastError, 'Fixture source gate failed');
    const before = structuredClone(app.automation.saved), previousCalls = [...calls];
    await fixture.login();
    assert.deepEqual(app.automation.saved, before); assert.deepEqual(calls, previousCalls);
    assert.equal(calls.filter(call => call === 'checkpoint').length, 1); assert.equal(calls.includes('push'), false);
    assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 2);
  } finally { await fixture.close(); }
});

test.after(async () => {
  assert.deepEqual(unexpectedRepositoryCalls, []);
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(path.isAbsolute(directory) && relative.startsWith('volterra-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
