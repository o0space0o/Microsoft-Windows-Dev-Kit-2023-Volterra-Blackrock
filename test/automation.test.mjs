import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-automation-'));
process.env.VOLTERRA_STATE_DIR = path.join(temporary, 'state');
const { Automation } = await import('../app/automation.mjs');
const { applySourceUpdate } = await import('../scripts/Apply-SourceUpdate.mjs');
const { allowedSource, validateSource } = await import('../app/source-policy.mjs');
const config = { repository: 'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock', branch: 'main', pollIntervalMs: 300_000, retryLimit: 3, tasks: [{ id: 'one', title: 'First task', instruction: 'Implement' }, { id: 'two', title: 'Second task', instruction: 'Verify' }] };
function controller(name, changes = {}) {
  const calls = [];
  const repository = {
    initialize: async () => {}, compare: async () => ({ current: 'a'.repeat(40), latest: 'a'.repeat(40), ahead: 0, behind: 0, diverged: false }),
    checkpoint: async () => { calls.push('checks'); return { changed: true, commit: 'b'.repeat(40) }; },
    push: async () => { calls.push('push'); return { commit: 'b'.repeat(40) }; }, ...changes
  };
  const runner = new Automation({ config, repository, directory: path.join(temporary, name), enabled: true, hooks: {
    connected: () => true, active: () => false, work: async task => calls.push(`work:${task.id}`), review: async () => calls.push('review'), reviewRemote: async () => calls.push('remote-review')
  } });
  return { runner, calls };
}
test('automatic work is reviewed, checked and published before advancing; saved pause survives restart', async () => {
  const { runner, calls } = controller('queue');
  await runner.start();
  assert.deepEqual(calls, ['work:one']);
  await runner.completed('completed', { status: 'complete', summary: 'Implemented and tested' });
  assert.deepEqual(calls, ['work:one', 'review']);
  assert.equal(runner.saved.task, 0);
  await runner.completed('completed', { status: 'complete', summary: 'Review passed' });
  assert.deepEqual(calls, ['work:one', 'review', 'checks', 'push']);
  assert.equal(runner.saved.task, 1);
  await runner.pause(); runner.close();
  const resumed = controller('queue'); await resumed.runner.start();
  assert.deepEqual(resumed.calls, []);
  await resumed.runner.resume();
  assert.deepEqual(resumed.calls, ['work:two']);
  resumed.runner.close();
});
test('an authorization wake before startup cannot run the default task before the saved queue is loaded', async () => {
  const saved = controller('before-load'); saved.runner.saved.task = 1; await saved.runner.persist();
  const next = controller('before-load');
  try {
    await next.runner.tick(); assert.deepEqual(next.calls, []);
    await next.runner.start(); assert.deepEqual(next.calls, ['work:two']);
    assert.equal(next.runner.saved.task, 1);
  } finally { next.runner.close(); }
});

test('invalid saved queue bytes are preserved exactly before a disabled paused queue replaces them', async () => {
  const { runner, calls } = controller('corrupt-queue'), notices = [];
  runner.hooks.notice = message => notices.push(message);
  await fs.mkdir(path.dirname(runner.file), { recursive: true });
  const original = Buffer.from(', {"private":"NEVER_DISPLAY_ORIGINAL"}');
  await fs.writeFile(runner.file, original);
  const neighbors = ['state.json', 'auth.json', 'history.jsonl'];
  for (const file of neighbors) await fs.writeFile(path.join(path.dirname(runner.file), file), 'Unchanged private fixture');
  try {
    await runner.start();
    assert.deepEqual(calls, []); assert.equal(runner.loaded, true);
    assert.equal(runner.saved.enabled, false); assert.equal(runner.saved.paused, true); assert.equal(runner.saved.phase, 'paused');
    assert.equal(runner.saved.pendingOutcome, null); assert.equal(runner.saved.reviewPassed, false);
    assert.deepEqual(runner.saved.recovery, { version: 1, reason: 'invalid-saved-state', originalBytesPreserved: true });
    const quarantines = (await fs.readdir(path.dirname(runner.file))).filter(name => name.startsWith('automation-state-quarantine-'));
    assert.equal(quarantines.length, 1); assert.match(quarantines[0], /^automation-state-quarantine-[a-f\d-]{36}\.json$/);
    assert.deepEqual(await fs.readFile(path.join(path.dirname(runner.file), quarantines[0])), original);
    assert.deepEqual(JSON.parse(await fs.readFile(runner.file, 'utf8')), runner.saved);
    assert.equal(notices.length, 1); assert.match(notices[0], /disabled and paused/);
    assert.doesNotMatch(JSON.stringify({ notices, saved: runner.saved }), /NEVER_DISPLAY_ORIGINAL|quarantine-|Unexpected token/);
    for (const file of neighbors) assert.equal(await fs.readFile(path.join(path.dirname(runner.file), file), 'utf8'), 'Unchanged private fixture');
    const restarted = controller('corrupt-queue');
    try {
      await restarted.runner.start(); assert.deepEqual(restarted.calls, []);
      assert.equal((await fs.readdir(path.dirname(runner.file))).filter(name => name.startsWith('automation-state-quarantine-')).length, 1);
    } finally { restarted.runner.close(); }
  } finally { runner.close(); }
});

test('parse-valid unsafe queue shapes and invalid UTF-8 cannot inherit enabled defaults', async () => {
  const valid = { version: 1, enabled: true, paused: false, phase: 'idle', task: 0 };
  const invalid = [null, [], true, {}, { ...valid, version: 2 }, { ...valid, enabled: 'true' }, { ...valid, paused: null },
    { ...valid, task: -1 }, { ...valid, phase: 'unknown' }, { ...valid, phase: 'paused' }, { ...valid, reviewPassed: 'true' },
    { ...valid, failures: -1 }, { ...valid, pendingOutcome: { status: 'complete' } }, { ...valid, lastError: {} }];
  const inputs = invalid.map(value => Buffer.from(JSON.stringify(value)));
  inputs.push(Buffer.from([0xc3, 0x28]));
  for (const [index, original] of inputs.entries()) {
    const { runner, calls } = controller(`corrupt-schema-${index}`); await fs.mkdir(path.dirname(runner.file), { recursive: true });
    await fs.writeFile(runner.file, original);
    try {
      await runner.start(); assert.deepEqual(calls, []); assert.equal(runner.saved.enabled, false); assert.equal(runner.saved.paused, true);
      const copy = (await fs.readdir(path.dirname(runner.file))).find(name => name.startsWith('automation-state-quarantine-'));
      assert.deepEqual(await fs.readFile(path.join(path.dirname(runner.file), copy)), original);
    } finally { runner.close(); }
  }
});

test('valid older queue records retain optional-field defaults and never create a quarantine', async () => {
  const { runner, calls } = controller('valid-minimal'); await fs.mkdir(path.dirname(runner.file), { recursive: true });
  await fs.writeFile(runner.file, JSON.stringify({ version: 1, enabled: false, paused: true, phase: 'paused', task: 1 }));
  try {
    await runner.start(); assert.deepEqual(calls, []); assert.equal(runner.saved.task, 1); assert.equal(runner.saved.failures, 0);
    assert.equal(runner.saved.pendingOutcome, null); assert.equal(runner.saved.recovery, undefined);
    assert.deepEqual(await fs.readdir(path.dirname(runner.file)), ['automation-state.json']);
  } finally { runner.close(); }
});

test('read I/O errors and preservation failures leave the original untouched and cannot start work', async t => {
  const { runner, calls } = controller('preservation-failure'); await fs.mkdir(path.dirname(runner.file), { recursive: true });
  const original = Buffer.from(', PRIVATE_PARSER_SENTINEL'); await fs.writeFile(runner.file, original);
  const open = fs.open.bind(fs);
  const deny = t.mock.method(fs, 'open', async (file, ...args) => {
    if (path.basename(file).startsWith('automation-state-quarantine-')) throw Object.assign(new Error('PRIVATE_PRESERVATION_SENTINEL'), { code: 'EACCES' });
    return open(file, ...args);
  });
  await assert.rejects(runner.start(), error => /could not be preserved/.test(error.message) && !error.message.includes('PRIVATE_'));
  assert.equal(runner.loaded, false); assert.deepEqual(calls, []); assert.deepEqual(await fs.readFile(runner.file), original);
  assert.deepEqual(await fs.readdir(path.dirname(runner.file)), ['automation-state.json']);
  deny.mock.restore();
  t.mock.method(fs, 'open', async file => { if (file === runner.file) throw Object.assign(new Error('Read access denied'), { code: 'EACCES' }); return open(file); });
  await assert.rejects(runner.start(), { code: 'EACCES' });
  assert.equal(runner.loaded, false); assert.deepEqual(calls, []); assert.deepEqual(await fs.readFile(runner.file), original);
});

test('changed originals and redirected queue files are refused without overwriting them', async t => {
  const { runner, calls } = controller('changed-corrupt'); await fs.mkdir(path.dirname(runner.file), { recursive: true });
  await fs.writeFile(runner.file, ', old invalid bytes');
  const replacement = 'A concurrent writer owns these newer bytes', open = fs.open.bind(fs);
  const intercept = t.mock.method(fs, 'open', async (file, ...args) => {
    if (path.basename(file).startsWith('automation-state-quarantine-')) await fs.writeFile(runner.file, replacement);
    return open(file, ...args);
  });
  await assert.rejects(runner.start(), /could not be preserved/);
  assert.equal(await fs.readFile(runner.file, 'utf8'), replacement); assert.equal(runner.loaded, false); assert.deepEqual(calls, []);
  intercept.mock.restore();
  const linked = controller('linked-corrupt'), outside = path.join(temporary, 'private-outside.json');
  await fs.mkdir(path.dirname(linked.runner.file), { recursive: true }); await fs.writeFile(outside, ', outside private bytes');
  await fs.link(outside, linked.runner.file);
  await assert.rejects(linked.runner.start(), /redirected or not ordinary/);
  assert.equal(await fs.readFile(outside, 'utf8'), ', outside private bytes'); assert.deepEqual(linked.calls, []);
});

for (const phase of ['publishing', 'reviewing-update']) {
  test(`restart during ${phase} reloads the saved outcome and repeats source checks before publication`, async () => {
    const saved = controller(`restart-${phase}`);
    saved.runner.saved = { ...saved.runner.saved, task: 1, phase, reviewPassed: false,
      pendingOutcome: { status: 'progress', summary: 'Retained source candidate' } };
    await saved.runner.persist();
    const next = controller(`restart-${phase}`);
    try {
      await next.runner.start();
      assert.deepEqual(next.calls, ['review']); assert.equal(next.runner.saved.phase, 'reviewing');
      assert.equal(next.runner.saved.pendingOutcome.summary, 'Retained source candidate');
      await next.runner.completed('completed', { status: 'complete', summary: 'Independent review passed after restart' });
      assert.deepEqual(next.calls, ['review', 'checks', 'push']);
      assert.equal(next.runner.saved.task, 1); assert.equal(next.runner.saved.phase, 'idle');
      assert.equal(next.runner.saved.pendingOutcome, null);
    } finally { next.runner.close(); }
  });
}

test('failed independent checks retain the task and prevent any main push', async () => {
  const { runner, calls } = controller('failed', { checkpoint: async () => { throw new Error('A required test failed'); } });
  await runner.start();
  await runner.completed('completed', { status: 'complete', summary: 'Candidate' });
  await runner.completed('completed', { status: 'complete', summary: 'Review passed' });
  assert.equal(runner.saved.phase, 'blocked'); assert.equal(runner.saved.task, 0);
  assert.equal(calls.includes('push'), false); runner.close();
});
test('pausing or restarting during review never bypasses review on resume', async () => {
  const first = controller('review-restart'); await first.runner.start();
  await first.runner.completed('completed', { status: 'complete', summary: 'Unreviewed candidate' });
  await first.runner.pause(); first.runner.close();
  const next = controller('review-restart'); await next.runner.start(); await next.runner.resume();
  assert.deepEqual(next.calls, ['review']); assert.equal(next.calls.includes('push'), false); next.runner.close();
});
test('diverged main is retained and remote updates require a review before staging', async () => {
  const diverged = controller('diverged', { compare: async () => ({ diverged: true, behind: 1, ahead: 1 }) });
  await diverged.runner.start(); assert.equal(diverged.runner.saved.phase, 'blocked'); assert.deepEqual(diverged.calls, []); diverged.runner.close();
  const update = controller('update', { compare: async () => ({ current: 'a'.repeat(40), latest: 'b'.repeat(40), behind: 1, ahead: 0 }), stage: async () => ({ id: 'staged' }) });
  await update.runner.start(); assert.deepEqual(update.calls, ['remote-review']);
  await update.runner.completed('completed', { status: 'complete', summary: 'Remote review passed' });
  assert.equal(update.runner.saved.phase, 'restart-pending'); assert.equal(update.calls.includes('push'), false); update.runner.close();
});
test('public source policy excludes OS files, runtimes, auth files and traversal', () => {
  for (const file of ['Windows/System32/kernel.dll', 'private/tools/node.exe', 'app/auth.json', '../README.md', 'app/../../Windows/x.ps1', 'scripts/drivers.cat']) assert.equal(allowedSource(file), false, file);
  assert.equal(allowedSource('app/auth.mjs'), true);
});
const digest = content => createHash('sha256').update(content).digest('hex');
async function updateFixture(name) {
  const directory = path.join(temporary, name), target = path.join(directory, 'installed'), source = path.join(directory, 'updates', 'candidate', 'source');
  await fs.mkdir(path.join(target, 'app'), { recursive: true }); await fs.mkdir(path.join(source, 'app'), { recursive: true });
  await fs.writeFile(path.join(target, 'app', 'sample.mjs'), 'previous'); await fs.writeFile(path.join(source, 'app', 'sample.mjs'), 'replacement');
  const pending = { version: 1, phase: 'pending', id: 'candidate', target: await fs.realpath(target), source: await fs.realpath(source), base: 'a'.repeat(40), commit: 'b'.repeat(40), files: [{ file: 'app/sample.mjs', expected: digest('previous'), desired: digest('replacement') }] };
  await fs.writeFile(path.join(directory, 'pending-update.json'), JSON.stringify(pending)); return { directory, target, source, pending };
}
test('an unconfirmed startup update rolls back; a healthy update is confirmed and retained', async () => {
  const broken = await updateFixture('rollback');
  assert.equal((await applySourceUpdate(broken)).status, 'applied');
  assert.equal(await fs.readFile(path.join(broken.target, 'app/sample.mjs'), 'utf8'), 'replacement');
  assert.equal((await applySourceUpdate(broken)).status, 'rolled-back');
  assert.equal(await fs.readFile(path.join(broken.target, 'app/sample.mjs'), 'utf8'), 'previous');
  const healthy = await updateFixture('healthy');
  await applySourceUpdate(healthy);
  assert.equal((await applySourceUpdate({ ...healthy, mode: 'confirm' })).status, 'confirmed');
  assert.equal((await applySourceUpdate(healthy)).status, 'none');
  assert.equal(await fs.readFile(path.join(healthy.target, 'app/sample.mjs'), 'utf8'), 'replacement');
});
test('a modified candidate or local file defers application without overwriting it', async () => {
  const fixture = await updateFixture('tamper');
  await fs.writeFile(path.join(fixture.source, 'app/sample.mjs'), 'tampered');
  await assert.rejects(applySourceUpdate(fixture), /changed since staging/);
  assert.equal(await fs.readFile(path.join(fixture.target, 'app/sample.mjs'), 'utf8'), 'previous');
  const local = await updateFixture('local-change');
  await fs.writeFile(path.join(local.target, 'app/sample.mjs'), 'local edits');
  await assert.rejects(applySourceUpdate(local), /changed since staging/);
  assert.equal(await fs.readFile(path.join(local.target, 'app/sample.mjs'), 'utf8'), 'local edits');
});
test('update traversal and external directory links cannot write outside the helper', async () => {
  const fixture = await updateFixture('escape');
  fixture.pending.files[0].file = '../outside.txt';
  await fs.writeFile(path.join(fixture.directory, 'pending-update.json'), JSON.stringify(fixture.pending));
  await assert.rejects(applySourceUpdate(fixture), /Protected update path/);
  const linked = await updateFixture('linked');
  const outside = path.join(temporary, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(linked.target, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  linked.pending.files[0].file = 'linked/file.mjs';
  await fs.writeFile(path.join(linked.directory, 'pending-update.json'), JSON.stringify(linked.pending));
  await assert.rejects(applySourceUpdate(linked), /Protected update path/);
});
test.after(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
