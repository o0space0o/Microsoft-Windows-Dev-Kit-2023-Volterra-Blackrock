import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-file-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
const { fileQuery, collectFiles, inspectFiles, fileReport } = await import('../app/file-tools.mjs');
const { createApplication } = await import('../app/server.mjs');
const { describeProgress } = await import('../app/public/progress.js');
const modifiedAt = '2026-10-11T18:00:00.000Z';
const entry = { name: 'Example [source].txt', kind: 'File', sizeBytes: '9007199254740993', modifiedAt };
const evidence = (workspace = directory, patch = {}) => ({ version: 1, kind: 'files', requestedWorkspace: workspace, workspace,
  observedAt: modifiedAt, system: { platform: 'win32', release: 'fixture', runtimeArchitecture: 'arm64' }, excludedCount: 2,
  entries: [entry, { name: 'Folder fixture', kind: 'Folder', sizeBytes: null, modifiedAt }, { name: 'Link fixture', kind: 'Link', sizeBytes: null, modifiedAt }], ...patch });
const stats = (kind = 'Folder', patch = {}) => ({ dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n, mtime: new Date(modifiedAt), size: 0n,
  isDirectory: () => kind === 'Folder', isFile: () => kind === 'File', isSymbolicLink: () => kind === 'Link', ...patch });
function fixtureFilesystem(names = ['Example.txt'], readings = {}) {
  const calls = []; let index = 0, closed = false;
  const handle = { read: async () => index < names.length ? { name: names[index++] } : null, close: async () => { closed = true; } };
  const filesystem = {
    realpath: async requested => { calls.push(['realpath', requested]); return requested; },
    opendir: async (requested, options) => { calls.push(['opendir', requested, options]); return handle; },
    lstat: async (requested, options) => { calls.push(['lstat', requested, options]); return requested === directory ? stats() : readings[path.basename(requested)] || stats('File', { size: 9007199254740993n }); }
  };
  return { calls, handle, filesystem, closed: () => closed };
}
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

test('file chat intent selects only workspace metadata and treats matching text literally', () => {
  for (const message of ['files', 'show files', ' LIST FILES ']) assert.deepEqual(fileQuery(message), { filter: '' });
  assert.deepEqual(fileQuery('show files matching [source]'), { filter: '[source]' });
  assert.deepEqual(fileQuery('files matching ../private; $(Example)'), { filter: '../private; $(Example)' });
  for (const message of ['delete files', 'show files in A:', 'files\ncommands', 'show files and open a document', null]) assert.equal(fileQuery(message), null);
  assert.throws(() => fileQuery('files matching ' + 'x'.repeat(257)), /256/);
  assert.throws(() => fileQuery('files matching bad\u0000filter'), /256/);
});

test('collection uses bounded nonrecursive enumeration and exact lstat sizes without any content or link-target reads', async () => {
  const fixture = fixtureFilesystem(['Example.txt', 'Folder fixture', 'Link fixture', 'Other fixture'], {
    'Folder fixture': stats(), 'Link fixture': stats('Link'), 'Other fixture': stats('Other')
  });
  const result = await collectFiles(directory, { filesystem: fixture.filesystem });
  assert.equal(result.entries[0].sizeBytes, '9007199254740993');
  assert.deepEqual(result.entries.map(value => value.kind), ['File', 'Folder', 'Link', 'Other']);
  assert.ok(result.entries.slice(1).every(value => value.sizeBytes === null));
  assert.equal(result.excludedCount, 0); assert.equal(fixture.closed(), true);
  assert.deepEqual(fixture.calls.find(call => call[0] === 'opendir'), ['opendir', directory, { bufferSize: 32, recursive: false }]);
  for (const call of fixture.calls.filter(call => call[0] === 'lstat')) assert.deepEqual(call[2], { bigint: true });
  assert.equal(fixture.calls.filter(call => call[0] === 'realpath' && call[1] === directory).length, 2);
  assert.equal(fixture.calls.filter(call => call[0] === 'realpath' && call[1] === process.env.VOLTERRA_STATE_DIR).length, 2);
  assert.ok(fixture.calls.every(call => !['readFile', 'stat', 'readlink'].includes(call[0])));
});

test('private build/runtime folders and credential/media entries are excluded before entry metadata is read', async () => {
  const excluded = ['build', 'PRIVATE', '.git', '.codex', '.agents', '.aws', '.ssh', '.gnupg', 'node_modules', '.env.production',
    'auth.json', 'credential.json', 'credentials.json', 'saved.dpapi', 'saved.credential', 'host.log', 'image.iso', 'boot.wim', 'disk.vhdx', 'disk.vhd', 'media.ffu', 'state'];
  const fixture = fixtureFilesystem([...excluded, 'Example.txt']);
  const result = await collectFiles(directory, { filesystem: fixture.filesystem });
  assert.equal(result.excludedCount, excluded.length); assert.deepEqual(result.entries.map(value => value.name), ['Example.txt']);
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'lstat' && call[1] !== directory).map(call => path.basename(call[1])), ['Example.txt']);
  for (const root of [path.join(directory, 'build', 'snapshot'), path.join(directory, '.codex', 'history'), path.join(directory, 'state'), path.join(directory, 'state', 'history')]) {
    await assert.rejects(collectFiles(root, { filesystem: fixture.filesystem }), /Private runtime and build/);
  }
});

test('workspace remapping, directory identity or timestamp changes and linked roots fail closed', async () => {
  for (const change of [{ ino: 99n }, { dev: 99n }, { mtimeNs: 99n }, { ctimeNs: 99n }, { isSymbolicLink: () => true }]) {
    const fixture = fixtureFilesystem(); let rootReads = 0;
    fixture.filesystem.lstat = async requested => requested === directory ? stats('Folder', ++rootReads === 1 ? {} : change) : stats('File');
    await assert.rejects(collectFiles(directory, { filesystem: fixture.filesystem }), /changed|stable/); assert.equal(fixture.closed(), true);
  }
  const fixture = fixtureFilesystem(); let realReads = 0;
  fixture.filesystem.realpath = async requested => requested !== directory ? requested : ++realReads === 1 ? directory : path.dirname(directory);
  await assert.rejects(collectFiles(directory, { filesystem: fixture.filesystem }), /changed/); assert.equal(fixture.closed(), true);
  fixture.filesystem.lstat = async () => stats('Link');
  await assert.rejects(collectFiles(directory, { filesystem: fixture.filesystem }), /stable/);
  await assert.rejects(collectFiles('relative'), /absolute/);
});

test('a configured state junction excludes its canonical target and descendants before directory or entry metadata reads', async () => {
  const canonical = path.join(directory, 'history-target'), configured = process.env.VOLTERRA_STATE_DIR;
  for (const workspace of [configured, canonical, path.join(canonical, 'nested')]) {
    const fixture = fixtureFilesystem(['journal.jsonl']);
    fixture.filesystem.realpath = async requested => { fixture.calls.push(['realpath', requested]); return requested === configured ? canonical : requested; };
    await assert.rejects(collectFiles(workspace, { filesystem: fixture.filesystem }), /Private runtime and build/);
    assert.ok(fixture.calls.some(call => call[0] === 'realpath' && call[1] === configured));
    assert.ok(fixture.calls.every(call => call[0] !== 'opendir' && call[0] !== 'lstat'));
  }
  const fixture = fixtureFilesystem(['state', 'history-target', 'Example.txt']);
  fixture.filesystem.realpath = async requested => { fixture.calls.push(['realpath', requested]); return requested === configured ? canonical : requested; };
  const result = await collectFiles(directory, { filesystem: fixture.filesystem });
  assert.equal(result.excludedCount, 2); assert.deepEqual(result.entries.map(value => value.name), ['Example.txt']);
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'lstat' && call[1] !== directory).map(call => path.basename(call[1])), ['Example.txt']);
});

test('unresolvable private state fails closed while absent state retains its configured exclusion', async () => {
  const configured = process.env.VOLTERRA_STATE_DIR;
  for (const code of ['EACCES', 'EPERM', 'ELOOP']) {
    const fixture = fixtureFilesystem();
    fixture.filesystem.realpath = async requested => { if (requested === configured) throw Object.assign(new Error('Private state resolution failed.'), { code }); return requested; };
    const result = await inspectFiles(directory, '', workspace => collectFiles(workspace, { filesystem: fixture.filesystem }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.entries, []);
    assert.ok(fixture.calls.every(call => call[0] !== 'opendir' && call[0] !== 'lstat'));
  }
  const fixture = fixtureFilesystem(['state', 'Example.txt']);
  fixture.filesystem.realpath = async requested => { if (requested === configured) throw Object.assign(new Error('State is absent.'), { code: 'ENOENT' }); return requested; };
  const result = await collectFiles(directory, { filesystem: fixture.filesystem });
  assert.equal(result.excludedCount, 1); assert.deepEqual(result.entries.map(value => value.name), ['Example.txt']);
  assert.equal(fixture.closed(), true);
});

test('a private state remapping or appearance during collection cannot publish earlier entries', async () => {
  const configured = process.env.VOLTERRA_STATE_DIR;
  for (const initiallyMissing of [false, true]) {
    const fixture = fixtureFilesystem(); let stateReads = 0;
    fixture.filesystem.realpath = async requested => {
      if (requested !== configured) return requested;
      if (++stateReads === 1) {
        if (initiallyMissing) throw Object.assign(new Error('State is absent.'), { code: 'ENOENT' });
        return path.join(directory, 'first-state');
      }
      return path.join(directory, 'second-state');
    };
    const result = await inspectFiles(directory, '', workspace => collectFiles(workspace, { filesystem: fixture.filesystem }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.entries, []);
    assert.match(result.error.message, /private state directory changed/); assert.equal(fixture.closed(), true);
  }
});

test('a real state junction protects its canonical root and hides both parent entries without reading private metadata', async t => {
  const configured = process.env.VOLTERRA_STATE_DIR, canonical = path.join(directory, 'history-target');
  await fs.mkdir(canonical); await fs.writeFile(path.join(canonical, 'journal.jsonl'), 'Private history fixture');
  await fs.symlink(canonical, configured, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(async () => { assert.equal((await fs.lstat(configured)).isSymbolicLink(), true); await fs.unlink(configured); });
  const calls = [];
  const filesystem = { ...fs,
    lstat: async (...args) => { calls.push(['lstat', args[0]]); return fs.lstat(...args); },
    opendir: async (...args) => { calls.push(['opendir', args[0]]); return fs.opendir(...args); }
  };
  for (const workspace of [configured, canonical]) {
    const result = await inspectFiles(workspace, '', requested => collectFiles(requested, { filesystem }));
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.entries, []);
  }
  assert.deepEqual(calls, []);
  const result = await inspectFiles(directory, '', requested => collectFiles(requested, { filesystem }));
  assert.equal(result.status, 'passed'); assert.equal(result.excludedCount, 2); assert.deepEqual(result.entries, []);
  assert.ok(calls.every(call => call[1] !== configured && call[1] !== canonical && call[1] !== path.join(canonical, 'journal.jsonl')));
  assert.equal(await fs.readFile(path.join(canonical, 'journal.jsonl'), 'utf8'), 'Private history fixture');
});

test('enumeration closes on malformed names, excessive entries, missing entry metadata and API errors', async () => {
  for (const names of [['../outside'], ['C:outside'], ['slash/name'], ['back\\name'], ['..'], ['bad\nname'], ['x'.repeat(256)], Array.from({ length: 4097 }, (_, index) => `Entry-${index}`)]) {
    const fixture = fixtureFilesystem(names);
    await assert.rejects(collectFiles(directory, { filesystem: fixture.filesystem }), /unsupported entry name|too many entries/);
    assert.equal(fixture.closed(), true);
  }
  for (const size of [-1n, 0x1_0000_0000_0000_0000n, 12]) {
    const fixture = fixtureFilesystem(['Example.txt'], { 'Example.txt': stats('File', { size }) });
    await assert.rejects(collectFiles(directory, { filesystem: fixture.filesystem }), /unsupported file sizes/); assert.equal(fixture.closed(), true);
  }
  const fixture = fixtureFilesystem(); fixture.handle.read = async () => { throw new Error('Directory access denied.'); };
  await assert.rejects(collectFiles(directory, { filesystem: fixture.filesystem }), /access denied/); assert.equal(fixture.closed(), true);
  const disappeared = fixtureFilesystem(); disappeared.filesystem.lstat = async requested => { if (requested === directory) return stats(); throw new Error('Entry disappeared.'); };
  await assert.rejects(collectFiles(directory, { filesystem: disappeared.filesystem }), /disappeared/); assert.equal(disappeared.closed(), true);
});

test('literal filtering preserves full totals and precise metadata without passing filter or path input to the collector', async () => {
  let calls = 0;
  const collect = async (...args) => { calls++; assert.deepEqual(args, [directory]); return evidence(); };
  const result = await inspectFiles(directory, '[source]', collect);
  assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 3); assert.equal(result.matchedCount, 1); assert.equal(result.excludedCount, 2);
  assert.deepEqual(result.entries, [entry]); assert.match(fileReport(result), /9007199254740993 bytes/);
  assert.equal((await inspectFiles(directory, '*', collect)).matchedCount, 0);
  assert.equal((await inspectFiles(directory, '../private; $(Example)', collect)).matchedCount, 0); assert.equal(calls, 3);
  assert.match(fileReport(await inspectFiles(directory, 'Link', collect)), /Link target unverified/);
  assert.match(fileReport(result), /VM or physical identity unverified/); assert.equal(result.runtimeAccepted, undefined);
  await assert.rejects(inspectFiles(directory, null, collect), /256/);
});

test('malformed or excluded collector evidence becomes blocked without partial entries', async () => {
  for (const raw of [null, evidence(directory, { kind: 'storage' }), evidence(directory, { requestedWorkspace: path.dirname(directory) }),
    evidence(directory, { workspace: 'relative' }), evidence(directory, { observedAt: 'invalid' }), evidence(directory, { excludedCount: -1 }),
    evidence(directory, { entries: {} }), evidence(directory, { entries: Array.from({ length: 4096 }, () => entry), excludedCount: 1 }),
    ...[{ ...entry, name: '../outside' }, { ...entry, name: 'auth.json' }, { ...entry, kind: 'Unknown' }, { ...entry, modifiedAt: 'invalid' },
      { ...entry, sizeBytes: '18446744073709551616' }, { ...entry, sizeBytes: '-1' }, { ...entry, sizeBytes: 12 }, { ...entry, kind: 'Folder' }]
      .map(value => evidence(directory, { entries: [value] })), evidence(directory, { entries: [entry, entry] })]) {
    const result = await inspectFiles(directory, '', async () => raw);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.entries, []); assert.match(fileReport(result), /blocked/);
  }
  assert.equal((await inspectFiles('relative')).status, 'blocked');
  const denied = await inspectFiles(directory, '', async () => { throw new Error('Entry query denied. Bearer fixture-secret'); });
  assert.doesNotMatch(fileReport(denied), /fixture-secret/); assert.match(denied.error.message, /denied/);
  const empty = await inspectFiles(directory, '', async () => evidence(directory, { entries: [] }));
  assert.equal(empty.status, 'passed'); assert.match(fileReport(empty), /No included root entries/);
});

test('report output is bounded and credential-like names are redacted', async () => {
  const result = await inspectFiles(directory, '', async () => evidence(directory, {
    entries: Array.from({ length: 42 }, (_, index) => ({ ...entry, name: 'n'.repeat(245) + index }))
  }));
  assert.equal(result.status, 'passed'); assert.equal(result.matchedCount, 42);
  const report = fileReport(result); assert.equal(report.match(/Type: File/g).length, 40); assert.match(report, /Showing 40 of 42/); assert.ok(report.length < 30_000);
  const redacted = await inspectFiles(directory, '', async () => evidence(directory, { entries: [{ ...entry, name: 'Bearer fixture-secret' }] }));
  assert.doesNotMatch(fileReport(redacted), /fixture-secret/);
});

test('real metadata reads preserve files and report a junction without entering its outside target', async () => {
  const root = path.join(directory, 'live'), outside = path.join(directory, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside); await fs.mkdir(path.join(root, 'build'));
  await fs.writeFile(path.join(root, 'Example.txt'), 'Original fixture');
  await fs.writeFile(path.join(root, 'auth.json'), 'Excluded credential fixture');
  await fs.writeFile(path.join(root, 'build', 'receipt.txt'), 'Private fixture');
  await fs.writeFile(path.join(outside, 'outside.txt'), 'Outside fixture');
  await fs.symlink(outside, path.join(root, 'Linked fixture'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await fs.readdir(root), result = await inspectFiles(root);
  assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 2); assert.equal(result.excludedCount, 2);
  assert.deepEqual(result.entries.find(value => value.name === 'Example.txt'), { name: 'Example.txt', kind: 'File', sizeBytes: '16', modifiedAt: (await fs.lstat(path.join(root, 'Example.txt'), { bigint: true })).mtime.toISOString() });
  assert.equal(result.entries.find(value => value.name === 'Linked fixture').kind, 'Link');
  assert.doesNotMatch(fileReport(result), /outside\.txt|receipt\.txt|auth\.json/);
  assert.deepEqual(await fs.readdir(root), before);
  for (const [file, expected] of [[path.join(root, 'Example.txt'), 'Original fixture'], [path.join(root, 'auth.json'), 'Excluded credential fixture'],
    [path.join(root, 'build', 'receipt.txt'), 'Private fixture'], [path.join(outside, 'outside.txt'), 'Outside fixture']]) assert.equal(await fs.readFile(file, 'utf8'), expected);
});

test('authorized file chat selects its workspace, rejects cross-origin access and saves output without account sign-in', async () => {
  const fake = new FakeCodex(); let collected;
  let app = await createApplication({ port: 0, codex: fake, autostart: false, fileCollector: async workspace => { collected = workspace; return evidence(workspace); } });
  try {
    const unauthorized = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'show files' }) });
    assert.equal(unauthorized.status, 403); assert.equal(collected, undefined);
    const response = await fetch(app.origin), html = await response.text();
    const cookie = response.headers.get('set-cookie').split(';')[0], token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1];
    const headers = { cookie, 'Content-Type': 'application/json', 'X-Volterra-Client': token };
    const foreign = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ text: 'show files' }) });
    assert.equal(foreign.status, 403); assert.equal(collected, undefined);
    const result = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers, body: JSON.stringify({ text: 'show files matching [source]', path: path.dirname(directory) }) });
    assert.equal(result.status, 200); const data = await result.json(); assert.equal(data.tool, 'files'); assert.equal(data.status, 'passed');
    assert.equal(data.matchedCount, 1); assert.equal(collected, app.snapshot().project.path); assert.equal(fake.calls.length, 0);
    const output = app.snapshot().journal.find(value => value.type === 'output' && value.data.delta?.includes('Live workspace files')); assert.ok(output);
    await app.close(); app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false });
    assert.ok(app.snapshot().journal.some(value => value.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('file checking does not resume a pause, steer a turn, hide approvals or overlap another inventory', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, fileCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Continue the project work' });
    await app.automation.pause(); const before = fake.calls.length;
    const request = app.actions['agent/send']({ text: 'show files' }), snapshot = app.snapshot();
    assert.equal(snapshot.systemTool.kind, 'files'); assert.equal(snapshot.progress.since, snapshot.systemTool.since);
    assert.equal(describeProgress(snapshot).title, 'Reading workspace files');
    assert.equal(describeProgress({ ...snapshot, approvals: [{}] }).phase, 'question');
    for (const text of ['show files', 'show services', 'show devices', 'show storage', 'show networking']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence(snapshot.project.path)); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn');
    assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('unavailable file metadata leaves a saved blocked report and clears checking', async () => {
  const app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false, fileCollector: async () => { throw new Error('Directory API unavailable.'); } });
  try {
    const result = await app.actions['agent/send']({ text: 'show files' });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.entries, []); assert.equal(app.snapshot().systemTool, null);
    assert.ok(app.snapshot().journal.some(value => value.type === 'output' && value.data.delta?.includes('File inventory is blocked.')));
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-file-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
