import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { inspectWindowsPrivateState, windowsPrivateState, readPrivateInput, managedAccountDirectory, privateStateNotice } from '../app/private-state.mjs';

const directory = 'C:\\VolterraState', volume = '\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\';
const now = Date.parse('2026-10-12T08:00:00Z');
const expected = { directory, volume, scope: 'state', mode: 'create', before: now, after: now + 10 };
const proof = () => ({ version: 1, kind: 'windowsPrivateState', status: 'private', observedAt: '2026-10-12T08:00:00.0000000Z', mode: 'create', scope: 'state', directory, volume, userSID: 'S-1-5-21-1-2-3-1000', rootCreated: true, managedDirectoriesCreated: ['codex', 'github', 'browser'], entriesChecked: 4, allEntriesPrivate: true, rootDACLProtected: true, contentsRead: false, existingACLsChanged: false, privilegesChanged: false, errorClass: null, nativeCode: 0 });

test('Windows private proof requires fresh complete DACL evidence and truthful no-mutation fields', () => {
  assert.equal(inspectWindowsPrivateState(proof(), expected).windowsDACLVerified, true);
  const cases = [p => { p.directory = 'C:\\OtherState'; }, p => { p.volume = '\\\\?\\Volume{99999999-2222-3333-4444-555555555555}\\'; }, p => { p.observedAt = '2026-10-12T07:00:00.0000000Z'; }, p => { p.entriesChecked = 100001; }, p => { p.entriesChecked = '4'; }, p => { p.rootDACLProtected = false; }, p => { p.existingACLsChanged = true; }, p => { p.privilegesChanged = true; }, p => { p.contentsRead = true; }, p => { p.allEntriesPrivate = false; }, p => { p.nativeCode = 5; }, p => { p.extra = true; }, p => { p.managedDirectoriesCreated = ['codex', 'codex']; }];
  for (const change of cases) { const value = proof(); change(value); assert.throws(() => inspectWindowsPrivateState(value, expected), { message: privateStateNotice }); }
  const verify = proof(); Object.assign(verify, { mode: 'verify', rootCreated: false, managedDirectoriesCreated: [] });
  assert.equal(inspectWindowsPrivateState(verify, { ...expected, mode: 'verify' }).status, 'private');
  verify.managedDirectoriesCreated = ['codex']; assert.throws(() => inspectWindowsPrivateState(verify, { ...expected, mode: 'verify' }));
});

const info = size => ({ isFile: () => true, size: BigInt(size), nlink: 1n, dev: 2n, ino: 3n, birthtimeNs: 4n, ctimeNs: 5n, mtimeNs: 6n });
function readFixture(bytes, { before = info(bytes.length), after = before, named = after } = {}) {
  let closed = 0, reads = 0, largest = 0;
  return { io: { open: async () => ({ stat: async () => reads ? after : before, read: async (buffer, offset, length, position) => { reads++; largest = Math.max(largest, buffer.length); const count = Math.min(length, Math.max(0, bytes.length - position)); bytes.copy(buffer, offset, position, position + count); return { bytesRead: count }; }, close: async () => { closed++; }, readFile: () => assert.fail('Unbounded readFile must not run') }), lstat: async () => named }, guard: async () => {}, facts: () => ({ closed, reads, largest }) };
}
test('provenance reading allocates at most declared size plus one and refuses growing or replaced inputs', async () => {
  const good = readFixture(Buffer.from('abc')); assert.equal((await readPrivateInput('fixture', 3, good)).toString(), 'abc'); assert.deepEqual(good.facts(), { closed: 1, reads: 2, largest: 4 });
  const growing = readFixture(Buffer.from('abcd'), { before: info(3), after: info(4) }); await assert.rejects(readPrivateInput('fixture', 3, growing)); assert.equal(growing.facts().largest, 4);
  const oversized = readFixture(Buffer.from('abcd')); await assert.rejects(readPrivateInput('fixture', 3, oversized)); assert.equal(oversized.facts().reads, 0);
  for (const key of ['dev', 'ino', 'nlink', 'birthtimeNs', 'ctimeNs', 'mtimeNs']) { const changed = { ...info(3), [key]: 77n }; await assert.rejects(readPrivateInput('fixture', 3, readFixture(Buffer.from('abc'), { named: changed }))); }
  await assert.rejects(readPrivateInput('fixture', 3, readFixture(Buffer.from('ab'), { before: info(3) })));
  await assert.rejects(readPrivateInput('fixture', 3, readFixture(Buffer.from('abc'), { before: { ...info(3), ctimeNs: 5 } })));
});

const digest = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
function nativeFixture({ currentCommit = 'a'.repeat(40), compiledCommit = currentCommit } = {}) {
  const root = 'C:\\CheckedSource', files = new Map();
  for (const [file, bytes] of [['private/tools/volterra-facts.exe', 'Fixture binary, never executed'], ['scripts/Probe-WindowsFacts.cs', 'Original facts source'], ['scripts/Private-WindowsState.cs', 'Original privacy source'], ['scripts/Build-WindowsFacts.ps1', 'Original build script']]) files.set(path.join(root, file), Buffer.from(bytes));
  const manifest = { version: 1, kind: 'volterraWindowsFactsBuild', sourceCommit: compiledCommit, sourceFile: 'scripts/Probe-WindowsFacts.cs', sourceSHA256: digest(files.get(path.join(root, 'scripts/Probe-WindowsFacts.cs'))), privateStateSourceFile: 'scripts/Private-WindowsState.cs', privateStateSourceSHA256: digest(files.get(path.join(root, 'scripts/Private-WindowsState.cs'))), buildScript: 'scripts/Build-WindowsFacts.ps1', buildScriptSHA256: digest(files.get(path.join(root, 'scripts/Build-WindowsFacts.ps1'))), executable: { file: 'private/tools/volterra-facts.exe', bytes: files.get(path.join(root, 'private/tools/volterra-facts.exe')).length, SHA256: digest(files.get(path.join(root, 'private/tools/volterra-facts.exe'))) } };
  files.set(path.join(root, 'private/tools/volterra-facts-build.json'), Buffer.from(JSON.stringify(manifest)));
  files.set(path.join(root, 'private/source-version.json'), Buffer.from(JSON.stringify({ commit: currentCommit, repository: 'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock' })));
  let calls = 0; const guards = [];
  return { root, files, manifest, calls: () => calls, guards, options: { root, directory, volume, create: true, scope: 'state', read: async (file, max) => { const bytes = files.get(file); assert.ok(bytes && bytes.length <= max); return Buffer.from(bytes); }, guard: async (file, options) => { guards.push([file, options]); }, clock: () => now, execute: async (file, args) => { calls++; assert.equal(file, path.join(root, 'private/tools/volterra-facts.exe')); assert.deepEqual(args, ['--private-state', 'create', 'state', directory, volume]); return JSON.stringify(proof()); } } };
}
test('source updates reuse only unchanged native inputs and keep the actual compiled commit', async () => {
  const f = nativeFixture({ currentCommit: 'b'.repeat(40), compiledCommit: 'a'.repeat(40) }); assert.equal((await windowsPrivateState(f.options)).status, 'private'); assert.equal(f.calls(), 1);
  assert.ok(f.guards.some(([file, opts]) => file === directory && opts.directory && !opts.missing), 'Post-invocation directory guard is required');
  for (const relative of ['scripts/Probe-WindowsFacts.cs', 'scripts/Private-WindowsState.cs', 'scripts/Build-WindowsFacts.ps1', 'private/tools/volterra-facts.exe']) { const changed = nativeFixture(); changed.files.set(path.join(changed.root, relative), Buffer.from('Changed input')); await assert.rejects(windowsPrivateState(changed.options)); assert.equal(changed.calls(), 0); }
  const old = nativeFixture(); delete old.manifest.privateStateSourceSHA256; old.files.set(path.join(old.root, 'private/tools/volterra-facts-build.json'), Buffer.from(JSON.stringify(old.manifest))); await assert.rejects(windowsPrivateState(old.options)); assert.equal(old.calls(), 0);
});
test('redirected post-execution storage or changed native inputs refuse privacy success', async () => {
  const f = nativeFixture(); f.options.guard = async (file, options) => { if (file === directory && !options.missing) throw new Error('Synthetic redirect'); }; await assert.rejects(windowsPrivateState(f.options));
  const g = nativeFixture(), execute = g.options.execute; g.options.execute = async (...args) => { const result = await execute(...args); g.files.set(path.join(g.root, 'scripts/Private-WindowsState.cs'), Buffer.from('Replacement')); return result; }; await assert.rejects(windowsPrivateState(g.options));
});
test('invalid account roots refuse before native invocation and selected external homes stay selected', async () => {
  for (const value of ['\\\\server\\state', 'C:\\VolterraState\\..\\Other', 'C:\\VolterraState\u0000']) { const f = nativeFixture(); await assert.rejects(windowsPrivateState({ ...f.options, directory: value })); assert.equal(f.calls(), 0); }
  assert.equal(managedAccountDirectory('codex', { env: { CODEX_HOME: 'C:\\ExistingPrivateHome' }, home: 'C:\\User' }), 'C:\\ExistingPrivateHome');
  assert.equal(managedAccountDirectory('codex', { env: {}, home: 'C:\\User' }), path.join('C:\\User', '.codex'));
  assert.equal(managedAccountDirectory('github', { env: { GH_CONFIG_DIR: 'C:\\ExistingGH' } }), 'C:\\ExistingGH');
});

test('privacy refusal stops application before state reads, writes or native account startup', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-privacy-')); const state = path.join(temporary, 'VolterraState');
  t.after(async () => { const resolved = await fs.realpath(temporary); assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('volterra-privacy-')); await fs.rm(resolved, { recursive: true }); });
  process.env.VOLTERRA_STATE_DIR = state;
  const { createApplication } = await import('../app/server.mjs');
  let nativeStarted = 0;
  await assert.rejects(createApplication({ port: 0, autostart: true, codex: { start: () => { nativeStarted++; } }, statePrivacy: async () => { throw new Error(privateStateNotice); } }), { message: privateStateNotice });
  assert.equal(nativeStarted, 0); await assert.rejects(fs.lstat(state), { code: 'ENOENT' });
});
