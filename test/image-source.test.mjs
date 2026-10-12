import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareImageSource, verifyImageSource, copyImagePayload, executeBytes } from '../app/image-source.mjs';
import { approved, hash } from '../app/source-policy.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portable = path.join(root, 'private/tools/git/cmd/git.exe');
const gitPath = process.env.VOLTERRA_GIT_PATH || (existsSync(portable) ? portable : 'git');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-image-source-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative.startsWith('volterra-image-source-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => executeBytes(gitPath, ['-C', directory, ...args]);
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Source fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await git('remote', 'add', 'origin', 'https://github.com/o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock.git');
  await fs.mkdir(path.join(directory, 'design/approved-v1'), { recursive: true });
  for (const file of Object.keys(approved)) await fs.copyFile(path.join(root, 'design/approved-v1', file), path.join(directory, 'design/approved-v1', file));
  await fs.mkdir(path.join(directory, 'app')); await fs.mkdir(path.join(directory, 'test'));
  await fs.writeFile(path.join(directory, 'app/fixture.mjs'), "export const value = 'committed';\n");
  await fs.writeFile(path.join(directory, 'test/fixture.test.mjs'), "import assert from 'node:assert/strict'; import {value} from '../app/fixture.mjs'; assert.equal(value, 'committed');\n");
  await fs.mkdir(path.join(directory, 'scripts')); await fs.mkdir(path.join(directory, 'image'));
  await fs.writeFile(path.join(directory, 'scripts/Apply-SourceUpdate.mjs'), "export const fixture = true;\n");
  await fs.writeFile(path.join(directory, 'image/Volterra-Startup.cmd'), '@echo off\r\necho Fixture\r\n');
  await fs.writeFile(path.join(directory, 'PROJECT_BRIEF.md'), 'Private fixture boot source.\n');
  await fs.writeFile(path.join(directory, '.gitignore'), '/build/\n/private/\n');
  await fs.mkdir(path.join(directory, 'private')); await fs.writeFile(path.join(directory, 'private/auth.json'), 'Private fixture, never exported');
  await git('add', '.'); await git('commit', '-m', 'Fixture source');
  let published = (await git('rev-parse', 'HEAD')).toString().trim();
  await git('update-ref', 'refs/remotes/origin/main', published);
  // The local repository and all object reads are real. Only remote main lookup
  // is substituted, so this test never contacts or publishes to GitHub.
  const execute = (command, args, options) => args.includes('ls-remote') ? Promise.resolve(Buffer.from(published+'\trefs/heads/main\n')) : executeBytes(command, args, options);
  const check = source => executeBytes(process.execPath, ['--test', path.join(source, 'test/fixture.test.mjs')], { cwd: source });
  const options = { git: gitPath, execute, check };
  return { directory, git, prepare: extra => prepareImageSource({ directory, ...options, ...extra }), verify: file => verifyImageSource(file, directory, options), copy: (file, mount) => copyImagePayload(file, directory, mount, options), setPublished: value => { published = value; } };
}

test('image preparation exports a checked commit and excludes private files while later live edits leave it intact', async t => {
  const f = await fixture(t), receipt = await f.prepare();
  assert.equal(receipt.commit, (await f.git('rev-parse', 'HEAD')).toString().trim());
  await assert.rejects(fs.access(path.join(receipt.source, 'private/auth.json')));
  await fs.writeFile(path.join(f.directory, 'app/fixture.mjs'), "export const value = 'later live edit';\n");
  assert.equal((await f.verify(receipt.receiptFile)).commit, receipt.commit);
  assert.equal(await fs.readFile(path.join(receipt.source, 'app/fixture.mjs'), 'utf8'), "export const value = 'committed';\n");
  for (const file of Object.keys(approved)) assert.deepEqual(await fs.readFile(path.join(receipt.source, 'design/approved-v1', file)), await fs.readFile(path.join(root, 'design/approved-v1', file)));
});

test('dirty, unpublished and excluded committed source cannot become an image snapshot', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'app/fixture.mjs'), 'changed');
  await assert.rejects(f.prepare(), /Checkpoint/);
  await f.git('restore', 'app/fixture.mjs'); f.setPublished('0'.repeat(40));
  await assert.rejects(f.prepare(), /published GitHub main/);
  f.setPublished((await f.git('rev-parse', 'HEAD')).toString().trim());
  await f.git('add', '-f', 'private/auth.json'); await f.git('commit', '-m', 'Excluded fixture');
  f.setPublished((await f.git('rev-parse', 'HEAD')).toString().trim());
  await assert.rejects(f.prepare(), /excluded file or link/);
});

test('failed checks and a source mutation during checks do not seal a receipt', async t => {
  const f = await fixture(t);
  await assert.rejects(f.prepare({ check: async () => { throw new Error('Fixture check failed'); } }), /Fixture check failed/);
  await assert.rejects(f.prepare({ check: source => fs.writeFile(path.join(source, 'app/fixture.mjs'), 'tampered') }), /changed during/);
  await assert.rejects(f.prepare({ check: () => fs.writeFile(path.join(f.directory, 'app/fixture.mjs'), 'concurrent live edit') }), /working source changed/);
  const snapshots = path.join(f.directory, 'build/source-snapshots');
  for (const folder of await fs.readdir(snapshots)) await assert.rejects(fs.access(path.join(snapshots, folder, 'source-receipt.json')));
});

test('tampered source and a receipt outside the owned snapshot are rejected before image servicing', async t => {
  const f = await fixture(t), receipt = await f.prepare();
  const outside = path.join(f.directory, 'build/copied-receipt.json'); await fs.copyFile(receipt.receiptFile, outside);
  await assert.rejects(f.verify(outside), /outside the owned/);
  await fs.writeFile(path.join(receipt.source, 'app/fixture.mjs'), 'tampered');
  await assert.rejects(f.verify(receipt.receiptFile), /changed or a file is missing/);
});

test('forged commits, incomplete file lists and matching forged hashes cannot establish checked source', async t => {
  const f = await fixture(t), receipt = await f.prepare();
  const save = value => fs.writeFile(receipt.receiptFile, JSON.stringify(value));
  const original = JSON.parse(await fs.readFile(receipt.receiptFile, 'utf8'));
  await save({ ...original, commit: '0'.repeat(40) });
  await assert.rejects(f.verify(receipt.receiptFile), /command failed/);
  const incomplete = { ...original, files: { ...original.files } }; delete incomplete.files['app/fixture.mjs'];
  await save(incomplete); await assert.rejects(f.verify(receipt.receiptFile), /file list differs/);
  const forged = { ...original, files: { ...original.files, 'app/fixture.mjs': '0'.repeat(64) } };
  await save(forged); await assert.rejects(f.verify(receipt.receiptFile), /hashes differ/);
});

test('offline source copying removes obsolete source, preserves private/vendor files and hashes bootstrap and startup', async t => {
  const f = await fixture(t), receipt = await f.prepare(), mount = path.join(f.directory, 'build/development-900/final-install');
  await fs.mkdir(path.join(mount, 'Volterra/app'), { recursive: true });
  await fs.mkdir(path.join(mount, 'Volterra/private'), { recursive: true });
  await fs.mkdir(path.join(mount, 'Windows'), { recursive: true });
  await fs.writeFile(path.join(mount, 'Volterra/app/obsolete.mjs'), 'obsolete');
  await fs.writeFile(path.join(mount, 'Volterra/README.md'), 'Obsolete root source');
  await fs.writeFile(path.join(mount, 'Volterra/private/vendor.exe'), 'Private runtime fixture');
  await fs.writeFile(path.join(mount, 'Windows/vendor.dll'), 'Vendor fixture');
  await fs.writeFile(path.join(mount, 'Windows/Volterra-Startup.cmd'), 'Stale shell startup command');
  assert.equal((await f.copy(receipt.receiptFile, mount)).commit, receipt.commit);
  await assert.rejects(fs.access(path.join(mount, 'Volterra/app/obsolete.mjs')));
  await assert.rejects(fs.access(path.join(mount, 'Volterra/README.md')));
  assert.equal(await fs.readFile(path.join(mount, 'Volterra/private/vendor.exe'), 'utf8'), 'Private runtime fixture');
  assert.equal(await fs.readFile(path.join(mount, 'Windows/vendor.dll'), 'utf8'), 'Vendor fixture');
  assert.deepEqual(await fs.readFile(path.join(mount, 'Volterra/private/bootstrap/Apply-SourceUpdate.mjs')), await fs.readFile(path.join(receipt.source, 'scripts/Apply-SourceUpdate.mjs')));
  assert.deepEqual(await fs.readFile(path.join(mount, 'Windows/Volterra-Startup.cmd')), await fs.readFile(path.join(receipt.source, 'image/Volterra-Startup.cmd')));
  await assert.rejects(fs.access(path.join(mount, 'Windows/VolterraStartup.cmd')));
  assert.equal(JSON.parse(await fs.readFile(path.join(mount, 'Volterra/private/source-version.json'), 'utf8')).commit, receipt.commit);
});

test('source copying admits the exact source-bound current013 candidate and refuses an identity change before any writes', async t => {
  const f = await fixture(t), receipt = await f.prepare(), candidateId = '11111111-2222-3333-4444-555555555555';
  const artifactRoot = path.join(f.directory, `build/verification/media-candidate-development-013-${candidateId}`), mount = path.join(artifactRoot, 'final-install');
  await fs.mkdir(mount, { recursive: true });
  const identityFile = path.join(artifactRoot, 'candidate-identity.json');
  const identity = { version: 1, kind: 'volterraImageCandidateV1', buildName: 'development-013', candidateId, artifactRoot,
    baseArtifactRoot: path.join(f.directory, 'build/development-006'), sourceReceipt: receipt.receiptFile,
    sourceReceiptSHA256: hash(await fs.readFile(receipt.receiptFile)).toUpperCase(), sourceCommit: receipt.commit,
    baseImageReceiptSHA256: '1'.repeat(64), baseBootSHA256: '2'.repeat(64), baseInstallSHA256: '3'.repeat(64), privateDevelopmentOnly: true,
    publicDistributionAllowed: false, bootAccepted: false, runtimeAccepted: false, recoveryAccepted: false, physicalHardwareAccepted: false };
  await fs.writeFile(identityFile, JSON.stringify({ ...identity, sourceCommit: '0'.repeat(40) }));
  await assert.rejects(f.copy(receipt.receiptFile, mount), /verified source receipt/);
  assert.deepEqual(await fs.readdir(mount), []);
  await fs.writeFile(identityFile, JSON.stringify(identity));
  assert.equal((await f.copy(receipt.receiptFile, mount)).commit, receipt.commit);
  assert.deepEqual(await fs.readFile(path.join(mount, 'Windows/Volterra-Startup.cmd')), await fs.readFile(path.join(receipt.source, 'image/Volterra-Startup.cmd')));
  assert.deepEqual(await fs.readFile(identityFile), Buffer.from(JSON.stringify(identity)));
});

test('offline copying uses lstat when mounted provider Dirents misidentify regular files and directories as links', async t => {
  const f = await fixture(t), receipt = await f.prepare(), mount = path.join(f.directory, 'build/development-900/final-install');
  const payload = path.join(mount, 'Volterra');
  await fs.mkdir(path.join(payload, 'app/nested'), { recursive: true });
  await fs.mkdir(path.join(mount, 'Windows'), { recursive: true });
  await fs.writeFile(path.join(payload, 'app/nested/obsolete.mjs'), 'Obsolete nested source');
  await fs.writeFile(path.join(payload, 'app/fixture.mjs'), 'Stale source');
  await fs.writeFile(path.join(payload, 'README.md'), 'Obsolete root source');
  await fs.writeFile(path.join(payload, 'PROJECT_BRIEF.md'), 'Stale root source');
  await fs.writeFile(path.join(mount, 'Windows/Volterra-Startup.cmd'), 'Stale shell startup command');
  const readDirectory = fs.readdir.bind(fs);
  let misleadingFiles = 0, misleadingDirectories = 0;
  t.mock.method(fs, 'readdir', async (folder, options) => {
    const entries = await readDirectory(folder, options);
    const relative = path.relative(payload, folder);
    if (!options?.withFileTypes || relative.startsWith('..') || path.isAbsolute(relative)) return entries;
    return entries.map(item => {
      if (item.isFile()) misleadingFiles++;
      if (item.isDirectory()) misleadingDirectories++;
      return { name: item.name, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
    });
  });
  assert.equal((await f.copy(receipt.receiptFile, mount)).commit, receipt.commit);
  assert.ok(misleadingFiles >= 4 && misleadingDirectories >= 2, 'The fixture must exercise both source file levels and directory traversal.');
  await assert.rejects(fs.access(path.join(payload, 'app/nested/obsolete.mjs')));
  await assert.rejects(fs.access(path.join(payload, 'README.md')));
  for (const file of ['app/fixture.mjs', 'PROJECT_BRIEF.md']) assert.deepEqual(await fs.readFile(path.join(payload, file)), await fs.readFile(path.join(receipt.source, file)));
  assert.deepEqual(await fs.readFile(path.join(mount, 'Windows/Volterra-Startup.cmd')), await fs.readFile(path.join(receipt.source, 'image/Volterra-Startup.cmd')));
});

test('copying rejects redirected realpaths within the mount and hardlinks introduced before atomic replacement', async t => {
  const f = await fixture(t), receipt = await f.prepare(), mount = path.join(f.directory, 'build/development-900/final-install');
  const target = path.join(mount, 'Volterra/app/fixture.mjs'), redirected = path.join(mount, 'Volterra/private/redirected.mjs');
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.mkdir(path.dirname(redirected), { recursive: true });
  await fs.writeFile(target, 'Original destination'); await fs.writeFile(redirected, 'Other owned private file');
  const realpath = fs.realpath.bind(fs);
  t.mock.method(fs, 'realpath', file => path.resolve(file) === target ? Promise.resolve(redirected) : realpath(file));
  await assert.rejects(f.copy(receipt.receiptFile, mount), /Linked image source files/);
  assert.equal(await fs.readFile(target, 'utf8'), 'Original destination');
  assert.equal(await fs.readFile(redirected, 'utf8'), 'Other owned private file');
  t.mock.restoreAll();
  const outside = path.join(f.directory, 'outside.mjs'); await fs.writeFile(outside, 'Protected external content');
  const writeFile = fs.writeFile.bind(fs);
  let introduced = false;
  t.mock.method(fs, 'writeFile', async (file, bytes, options) => {
    const result = await writeFile(file, bytes, options);
    if (!introduced && path.dirname(file) === path.dirname(target) && path.basename(file).startsWith('.volterra-')) {
      introduced = true;
      await fs.unlink(target); await fs.link(outside, target);
    }
    return result;
  });
  await assert.rejects(f.copy(receipt.receiptFile, mount), /destination is linked/);
  assert.equal(introduced, true);
  assert.equal(await fs.readFile(outside, 'utf8'), 'Protected external content');
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['fixture.mjs']);
});

test('payload copying rejects host destinations and junctions before writing outside the offline mount', async t => {
  const f = await fixture(t), receipt = await f.prepare();
  const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside);
  await assert.rejects(f.copy(receipt.receiptFile, outside), /owned offline build mount/);
  const mount = path.join(f.directory, 'build/development-900/final-boot'); await fs.mkdir(mount, { recursive: true });
  await fs.symlink(outside, path.join(mount, 'Volterra'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.copy(receipt.receiptFile, mount), /Linked image directories/);
  assert.deepEqual(await fs.readdir(outside), []);
  const windowsMount = path.join(f.directory, 'build/development-901/final-boot'); await fs.mkdir(windowsMount, { recursive: true });
  await fs.symlink(outside, path.join(windowsMount, 'Windows'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.copy(receipt.receiptFile, windowsMount), /Linked image directories/);
  const privateMount = path.join(f.directory, 'build/development-902/final-install'); await fs.mkdir(path.join(privateMount, 'Volterra'), { recursive: true });
  await fs.symlink(outside, path.join(privateMount, 'Volterra/private'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.copy(receipt.receiptFile, privateMount), /Linked image directories/);
  assert.deepEqual(await fs.readdir(outside), []);
  const linkedMount = path.join(f.directory, 'build/development-903/final-install'); await fs.mkdir(path.join(linkedMount, 'Volterra/app'), { recursive: true });
  const linkedFile = path.join(outside, 'original.mjs'); await fs.writeFile(linkedFile, 'Outside hard link fixture');
  await fs.link(linkedFile, path.join(linkedMount, 'Volterra/app/fixture.mjs'));
  await assert.rejects(f.copy(receipt.receiptFile, linkedMount), /destination is linked/);
  assert.equal(await fs.readFile(linkedFile, 'utf8'), 'Outside hard link fixture');
  const nestedMount = path.join(f.directory, 'build/development-904/final-install'); await fs.mkdir(path.join(nestedMount, 'Volterra/app'), { recursive: true });
  await fs.symlink(outside, path.join(nestedMount, 'Volterra/app/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const readDirectory = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', async (folder, options) => {
    const entries = await readDirectory(folder, options);
    return options?.withFileTypes ? entries.map(item => ({ name: item.name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false })) : entries;
  });
  await assert.rejects(f.copy(receipt.receiptFile, nestedMount), /Linked image source files/);
  assert.equal(await fs.readFile(linkedFile, 'utf8'), 'Outside hard link fixture');
  assert.deepEqual(await fs.readdir(outside), ['original.mjs']);
});
