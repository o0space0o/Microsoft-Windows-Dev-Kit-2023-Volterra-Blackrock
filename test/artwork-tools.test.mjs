import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-artwork-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { artworkQuery, collectArtwork, inspectArtwork, artworkReport } = await import('../app/artwork-tools.mjs');
const { root } = await import('../app/platform.mjs');
const { approved } = await import('../app/source-policy.mjs');
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });
const { describeProgress } = await import('../app/public/progress.js');
const names = Object.keys(approved);
const observedAt = '2026-10-11T18:00:00.000Z';
const evidence = (patch = {}) => ({ version: 1, kind: 'artwork', status: 'passed', error: null, observedAt,
  system: { platform: 'win32', release: 'fixture', runtimeArchitecture: 'arm64' },
  checks: names.map(file => ({ file, expectedSha256: approved[file], status: 'passed', actualSha256: approved[file], sizeBytes: '2000000', error: null })), ...patch });
const info = (folder = false, size = 0, patch = {}) => ({ dev: 1n, ino: 2n, size: BigInt(size), mtimeNs: 3n, ctimeNs: 4n,
  isDirectory: () => folder, isFile: () => !folder, isSymbolicLink: () => false, ...patch });
function fixtureFilesystem(bytes = Buffer.from('fixture artwork content'), base = root) {
  const calls = [], handles = [], targets = names.map(file => path.join(base, 'design', 'approved-v1', file));
  const filesystem = {
    realpath: async target => { calls.push(['realpath', target]); return target; },
    lstat: async (target, options) => { calls.push(['lstat', target, options]); return info(!targets.includes(target), bytes.length); },
    open: async (target, mode) => {
      calls.push(['open', target, mode]); assert.ok(targets.includes(target)); assert.equal(mode, 'r');
      const handle = {
        stat: async options => { calls.push(['handle.stat', target, options]); return info(false, bytes.length); },
        read: async (buffer, offset, length, position) => {
          calls.push(['read', target, offset, length, position]);
          return { bytesRead: bytes.copy(buffer, offset, position, position + length), buffer };
        },
        close: async () => { handle.closed = true; calls.push(['close', target]); }, closed: false
      };
      handles.push(handle); return handle;
    }
  };
  return { filesystem, calls, handles, targets };
}
function assertFixedArtworkScope(fixture, base = root) {
  const allowed = new Set([root, base, path.join(base, 'design'), path.join(base, 'design', 'approved-v1'), ...fixture.targets]);
  assert.ok(fixture.calls.every(call => allowed.has(call[1])), 'Only the installed source directories and four fixed reference leaves may be read.');
  assert.deepEqual(fixture.calls.filter(call => call[0] === 'open').map(call => call[1]), fixture.targets);
}
const checkBlocked = result => { assert.equal(result.status, 'blocked'); assert.deepEqual(result.checks, []); assert.equal(result.matchedCount, undefined); assert.match(artworkReport(result), /checks are blocked/); };
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

test('artwork intent accepts only fixed reference checks without paths, hashes or repair operations', () => {
  for (const message of ['check artwork', 'verify artwork', ' VERIFY APPROVED ARTWORK ', 'check approved artwork']) assert.deepEqual(artworkQuery(message), {});
  for (const message of ['show artwork', 'repair artwork', 'check artwork in A:', 'check artwork matching desktop', 'check artwork; repair', 'check artwork\ncommands', null]) assert.equal(artworkQuery(message), null);
});

test('native collection reads the four real approved images without changing their bytes or claiming runtime acceptance', async () => {
  const before = await Promise.all(names.map(file => fs.readFile(path.join(root, 'design', 'approved-v1', file))));
  const result = await inspectArtwork();
  assert.equal(result.status, 'passed'); assert.equal(result.matchedCount, 4); assert.equal(result.changedCount, 0); assert.equal(result.blockedCount, 0);
  for (let index = 0; index < names.length; index++) {
    const bytes = await fs.readFile(path.join(root, 'design', 'approved-v1', names[index]));
    assert.deepEqual(bytes, before[index]); assert.equal(result.checks[index].actualSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.checks[index].sizeBytes, String(bytes.length));
  }
  assert.equal(result.runtimeAccepted, undefined); assert.equal(result.bootAccepted, undefined);
  assert.match(artworkReport(result), /do not compare rendered pixels/);
});

test('collection reads only the fixed files in bounded chunks through read-only handles and never reads the manifest', async () => {
  const bytes = Buffer.alloc(140_000, 7), fixture = fixtureFilesystem(bytes);
  const result = await collectArtwork({ filesystem: fixture.filesystem });
  assert.equal(result.status, 'blocked'); assert.ok(result.checks.every(check => check.status === 'changed' && check.error === null));
  for (const check of result.checks) { assert.equal(check.actualSha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(check.sizeBytes, String(bytes.length)); }
  assertFixedArtworkScope(fixture);
  assert.ok(fixture.calls.filter(call => call[0] === 'read').every(call => call[3] <= 65_536));
  assert.ok(fixture.handles.every(handle => handle.closed));
  assert.ok(fixture.calls.filter(call => call[0] === 'lstat' || call[0] === 'handle.stat').every(call => call[2].bigint));
});

test('fixed artwork reads remain scoped when the source is relocated beneath build or credential-like parent names', async () => {
  const base = path.join(directory, 'build', 'source-snapshots', 'private', 'auth.json', 'source');
  const bytes = Buffer.from('relocated artwork fixture'), fixture = fixtureFilesystem(bytes, base);
  fixture.filesystem.realpath = async target => { fixture.calls.push(['realpath', target]); return target === root ? base : target; };
  const result = await collectArtwork({ filesystem: fixture.filesystem });
  assertFixedArtworkScope(fixture, base);
  assert.equal(result.checks.length, 4);
  assert.ok(result.checks.every(check => check.status === 'changed' && check.actualSha256 === createHash('sha256').update(bytes).digest('hex')));
  assert.ok(fixture.handles.every(handle => handle.closed));
  assert.ok(!fixture.calls.some(call => path.basename(call[1]) === 'visual-lock.json'));
});

test('short reads are accumulated exactly while premature EOF and unsupported read counts are blocked and closed', async () => {
  const bytes = Buffer.from('short read fixture'), fixture = fixtureFilesystem(bytes), open = fixture.filesystem.open;
  fixture.filesystem.open = async (...args) => {
    const handle = await open(...args);
    handle.read = async (buffer, offset, length, position) => ({ bytesRead: bytes.copy(buffer, offset, position, position + Math.min(3, length)), buffer });
    return handle;
  };
  const result = await collectArtwork({ filesystem: fixture.filesystem });
  assert.ok(result.checks.every(check => check.actualSha256 === createHash('sha256').update(bytes).digest('hex')));
  for (const bytesRead of [0, -1, 100_000, 1.5, null, undefined]) {
    const failed = fixtureFilesystem(), original = failed.filesystem.open;
    failed.filesystem.open = async (...args) => { const handle = await original(...args); handle.read = async () => ({ bytesRead }); return handle; };
    const reading = await collectArtwork({ filesystem: failed.filesystem });
    assert.ok(reading.checks.every(check => check.status === 'blocked' && check.actualSha256 === null));
    assert.ok(failed.handles.every(handle => handle.closed));
  }
});

test('linked files or directories and oversized or non-file entries are excluded before any content read', async () => {
  for (const target of [root, path.join(root, 'design'), path.join(root, 'design', 'approved-v1'), ...fixtureFilesystem().targets]) {
    const fixture = fixtureFilesystem(), original = fixture.filesystem.lstat;
    fixture.filesystem.lstat = async (value, options) => value === target ? info(!fixture.targets.includes(value), 1, { isSymbolicLink: () => true }) : original(value, options);
    const result = await collectArtwork({ filesystem: fixture.filesystem });
    if (fixture.targets.includes(target)) assert.equal(result.checks.find(check => path.basename(target) === check.file).status, 'blocked');
    else assert.ok(result.checks.every(check => check.status === 'blocked'));
    assert.ok(!fixture.calls.some(call => call[0] === 'open' && call[1] === target));
  }
  for (const patch of [{ size: 3_000_001n }, { size: -1n }, { size: 1 }, { isFile: () => false }]) {
    const fixture = fixtureFilesystem(), original = fixture.filesystem.lstat;
    fixture.filesystem.lstat = async (value, options) => fixture.targets.includes(value) ? info(false, 1, patch) : original(value, options);
    const result = await collectArtwork({ filesystem: fixture.filesystem });
    assert.ok(result.checks.every(check => check.status === 'blocked')); assert.equal(fixture.handles.length, 0);
  }
});

test('an opened file identity change blocks before content is read and still closes the handle', async () => {
  const fixture = fixtureFilesystem(), original = fixture.filesystem.open;
  fixture.filesystem.open = async (...args) => { const handle = await original(...args); handle.stat = async () => info(false, 23, { ino: 99n }); return handle; };
  const result = await collectArtwork({ filesystem: fixture.filesystem });
  assert.ok(result.checks.every(check => check.status === 'blocked' && /before its content read/.test(check.error.message)));
  assert.ok(!fixture.calls.some(call => call[0] === 'read')); assert.ok(fixture.handles.every(handle => handle.closed));
});

test('file metadata changes during reading and path replacement after close discard the digest', async () => {
  for (const patch of [{ ino: 99n }, { size: 0n }, { mtimeNs: 99n }, { ctimeNs: 99n }]) {
    const fixture = fixtureFilesystem(), original = fixture.filesystem.open;
    fixture.filesystem.open = async (...args) => {
      const handle = await original(...args); let stats = 0;
      handle.stat = async () => info(false, 23, ++stats === 1 ? {} : patch); return handle;
    };
    const result = await collectArtwork({ filesystem: fixture.filesystem });
    assert.ok(result.checks.every(check => check.status === 'blocked' && check.actualSha256 === null));
    assert.ok(fixture.handles.every(handle => handle.closed));
  }
  const fixture = fixtureFilesystem(), original = fixture.filesystem.lstat, reads = new Map();
  fixture.filesystem.lstat = async (value, options) => {
    if (!fixture.targets.includes(value)) return original(value, options);
    reads.set(value, (reads.get(value) || 0) + 1);
    return info(false, 23, reads.get(value) > 1 ? { ino: 99n } : {});
  };
  const result = await collectArtwork({ filesystem: fixture.filesystem });
  assert.ok(result.checks.every(check => check.status === 'blocked' && /path changed/.test(check.error.message)));
});

test('canonical remaps and parent directory replacement are blocked rather than checking redirected artwork', async () => {
  const fixture = fixtureFilesystem();
  fixture.filesystem.realpath = async value => value.endsWith('.png') ? path.join(directory, path.basename(value)) : value;
  const remapped = await collectArtwork({ filesystem: fixture.filesystem });
  assert.ok(remapped.checks.every(check => check.status === 'blocked')); assert.equal(fixture.handles.length, 0);
  const parent = fixtureFilesystem(), original = parent.filesystem.lstat; let reads = 0;
  parent.filesystem.lstat = async (value, options) => value === path.join(root, 'design') ? info(true, 0, { ino: BigInt(++reads) }) : original(value, options);
  const replaced = await collectArtwork({ filesystem: parent.filesystem });
  assert.ok(replaced.checks.every(check => check.status === 'blocked' && check.actualSha256 === null));
  const source = fixtureFilesystem(); let sourceReads = 0;
  source.filesystem.realpath = async value => value === root && ++sourceReads > 1 ? directory : value;
  const moved = await collectArtwork({ filesystem: source.filesystem });
  assert.ok(moved.checks.every(check => check.status === 'blocked')); assert.equal(source.handles.length, 0);
});

test('individual denied reads and close failures preserve other completed checks; null failures have diagnostics', async () => {
  const fixture = fixtureFilesystem(), original = fixture.filesystem.open;
  fixture.filesystem.open = async (...args) => {
    if (args[0] === fixture.targets[0]) throw new Error('Access denied. Bearer fixture-secret');
    const handle = await original(...args);
    if (args[0] === fixture.targets[1]) handle.close = async () => { throw null; };
    return handle;
  };
  const result = await inspectArtwork(() => collectArtwork({ filesystem: fixture.filesystem }));
  assert.equal(result.status, 'blocked'); assert.equal(result.blockedCount, 2); assert.equal(result.changedCount, 2);
  assert.match(result.checks[0].error.message, /Access denied/); assert.match(result.checks[1].error.message, /read did not succeed/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  const unavailable = await collectArtwork({ filesystem: {} });
  assert.equal(unavailable.checks.length, 4); assert.ok(unavailable.checks.every(check => check.status === 'blocked'));
});

test('missing, sparse, duplicate or unknown reference rows and untrusted expected hashes fail closed', async () => {
  const raw = evidence();
  for (const checks of [[], Array(4), raw.checks.slice(0, 3), [...raw.checks, raw.checks[0]],
    [raw.checks[0], raw.checks[0], ...raw.checks.slice(2)], [null, ...raw.checks.slice(1)],
    [{ ...raw.checks[0], file: '../private/secret.png' }, ...raw.checks.slice(1)],
    [{ ...raw.checks[0], expectedSha256: '0'.repeat(64) }, ...raw.checks.slice(1)]]) checkBlocked(await inspectArtwork(async () => evidence({ checks })));
});

test('matched, changed and blocked counts are derived only from complete consistent checks', async () => {
  const raw = evidence(); raw.status = 'blocked';
  raw.checks[1] = { ...raw.checks[1], status: 'changed', actualSha256: '0'.repeat(64) };
  raw.checks[2] = { ...raw.checks[2], status: 'blocked', actualSha256: null, sizeBytes: null, error: { stage: 'Read', message: 'Denied' } };
  const result = await inspectArtwork(async () => raw);
  assert.equal(result.status, 'blocked'); assert.equal(result.matchedCount, 2); assert.equal(result.changedCount, 1); assert.equal(result.blockedCount, 1);
  const report = artworkReport(result); assert.match(report, /2 of 4 reference files matched; 1 changed; 1 reads blocked/);
  assert.match(report, /system.png: differs/); assert.match(report, /maintenance.png: read blocked/);
  checkBlocked(await inspectArtwork(async () => ({ ...raw, status: 'passed' })));
  checkBlocked(await inspectArtwork(async () => evidence({ status: 'blocked' })));
});

test('failure evidence cannot conceal partial digests or masquerade as a completed check', async () => {
  const raw = evidence(), first = raw.checks[0];
  for (const patch of [{ error: undefined }, { error: false }, { error: { stage: 'Read', message: 'Denied' } },
    { status: 'changed' }, { actualSha256: '0'.repeat(64) }, { status: 'blocked', error: { stage: 'Read', message: 'Denied' } },
    { status: 'blocked', actualSha256: null, sizeBytes: null, error: null },
    { status: 'blocked', actualSha256: null, sizeBytes: null, error: { stage: '', message: 'Denied' } },
    { status: 'blocked', actualSha256: null, sizeBytes: null, error: { stage: 'Read', message: '\u0000\n' } }]) {
    checkBlocked(await inspectArtwork(async () => evidence({ checks: [{ ...first, ...patch }, ...raw.checks.slice(1)] })));
  }
  for (const error of [undefined, false, {}, { stage: 'Read', message: 'Denied' }]) checkBlocked(await inspectArtwork(async () => evidence({ error })));
});

test('unsupported sizes, digests, timestamps and envelopes are blocked while valid zero-byte mismatches remain distinct', async () => {
  const raw = evidence();
  for (const patch of [{ version: 2 }, { kind: 'files' }, { status: 'unknown' }, { observedAt: 'invalid' }, { observedAt: '2026-10-11' },
    { system: null }, { system: { ...raw.system, release: 'x'.repeat(129) } }]) checkBlocked(await inspectArtwork(async () => evidence(patch)));
  for (const sizeBytes of [null, undefined, 1, '01', '-1', '3e6', '3000001', '1\n']) checkBlocked(await inspectArtwork(async () => evidence({ checks: [{ ...raw.checks[0], sizeBytes }, ...raw.checks.slice(1)] })));
  for (const actualSha256 of [null, 'a'.repeat(63), 'G'.repeat(64), raw.checks[0].actualSha256.toUpperCase()]) checkBlocked(await inspectArtwork(async () => evidence({ checks: [{ ...raw.checks[0], actualSha256 }, ...raw.checks.slice(1)] })));
  const result = await inspectArtwork(async () => evidence({ status: 'blocked', checks: [{ ...raw.checks[0], status: 'changed', actualSha256: createHash('sha256').digest('hex'), sizeBytes: '0' }, ...raw.checks.slice(1)] }));
  assert.equal(result.changedCount, 1); assert.equal(result.checks[0].sizeBytes, '0');
});

test('private fields and caller acceptance claims are excluded and failures are safely redacted', async () => {
  const raw = evidence(); raw.secret = 'private-field'; raw.bootAccepted = true; raw.checks[0].path = 'private-field';
  const result = await inspectArtwork(async (...args) => { assert.deepEqual(args, []); return raw; });
  assert.equal(result.status, 'passed'); assert.doesNotMatch(JSON.stringify(result), /private-field|bootAccepted/);
  for (const error of [null, undefined, '', {}, 123]) {
    const failed = await inspectArtwork(async () => { throw error; }); checkBlocked(failed); assert.match(failed.error.message, /read did not succeed/);
  }
  const denied = await inspectArtwork(async () => { throw new Error('Denied. Bearer fixture-secret ' + 'x'.repeat(1000)); });
  checkBlocked(denied); assert.doesNotMatch(JSON.stringify(denied), /fixture-secret/); assert.ok(denied.error.message.length <= 512);
});

test('authorized chat ignores supplied projects and hashes, needs no account and saves output across restart', async () => {
  const fake = new FakeCodex(); let calls = 0;
  let app = await createApplication({ port: 0, codex: fake, autostart: false, artworkCollector: async (...args) => { calls++; assert.deepEqual(args, []); return evidence(); } });
  try {
    app.state.projects[directory] = { path: directory }; app.state.selected = directory;
    const unauthorized = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'check artwork' }) });
    assert.equal(unauthorized.status, 403); assert.equal(calls, 0);
    const entry = await fetch(app.origin), html = await entry.text();
    const headers = { cookie: entry.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-Volterra-Client': html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1] };
    const crossOrigin = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ text: 'check artwork' }) });
    assert.equal(crossOrigin.status, 403); assert.equal(calls, 0);
    const response = await fetch(app.origin + '/api/agent/send', { method: 'POST', headers, body: JSON.stringify({ text: 'check artwork', directory: 'A:/private', files: ['secret'], expectedSha256: '0'.repeat(64), repair: true }) });
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.tool, 'artwork'); assert.equal(result.matchedCount, 4);
    assert.equal(calls, 1); assert.equal(fake.calls.length, 0); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(item => item.type === 'output' && item.data.delta?.startsWith('Approved artwork checks passed'));
    assert.ok(output); await app.close();
    app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false });
    assert.ok(app.snapshot().journal.some(item => item.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('live artwork checking preserves turns and saved pauses, honors permission priority and excludes other inventories', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, artworkCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' });
    await app.automation.pause(); const before = fake.calls.length;
    const request = app.actions['agent/send']({ text: 'check artwork' });
    assert.equal(app.snapshot().activeTurn, 'fixture-turn'); assert.equal(describeProgress(app.snapshot()).title, 'Checking approved artwork');
    assert.equal(describeProgress({ ...app.snapshot(), approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress(app.snapshot(), false).phase, 'disconnected');
    await assert.rejects(app.actions['agent/send']({ text: 'show services' }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.automation.saved.paused, true); assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('blocked and changed chat readings recover after restart without replacing references or starting agent work', async () => {
  let reads = 0, app = await createApplication({ port: 0, codex: new FakeCodex(), autostart: false, artworkCollector: async () => {
    if (++reads === 1) throw null;
    const raw = evidence(); raw.status = 'blocked'; raw.checks[0] = { ...raw.checks[0], status: 'changed', actualSha256: '0'.repeat(64) }; return raw;
  } });
  try {
    const failed = await app.actions['agent/send']({ text: 'check artwork' }); assert.equal(failed.status, 'blocked'); assert.equal(app.snapshot().systemTool, null);
    const changed = await app.actions['agent/send']({ text: 'check artwork' }); assert.equal(changed.changedCount, 1); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(item => item.type === 'output' && item.data.delta?.includes('desktop.png: differs'));
    assert.ok(output); await app.close();
    const fake = new FakeCodex(); app = await createApplication({ port: 0, codex: fake, autostart: false, artworkCollector: async () => evidence() });
    const before = fake.calls.length;
    assert.ok(app.snapshot().journal.some(item => item.data?.itemId === output.data.itemId));
    const result = await app.actions['agent/send']({ text: 'check artwork' }); assert.equal(result.status, 'passed'); assert.equal(fake.calls.length, before);
  } finally { await app.close(); }
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-artwork-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
