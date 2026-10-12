import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateOfflineImageMount } from '../app/image-mount.mjs';
import { hash } from '../app/source-policy.mjs';

const id = '11111111-2222-3333-4444-555555555555';
async function fixture(t) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-image-mount-')));
  t.after(async () => {
    const real = await fs.realpath(workspace), relative = path.relative(await fs.realpath(os.tmpdir()), real);
    assert.ok(relative.startsWith('volterra-image-mount-') && !relative.includes(path.sep));
    await fs.rm(real, { recursive: true, force: true });
  });
  const artifactRoot = path.join(workspace, `build/verification/media-candidate-development-013-${id}`);
  const mount = path.join(artifactRoot, 'final-boot');
  const receiptFile = path.join(workspace, 'build/source-snapshots/fixture/source-receipt.json');
  await fs.mkdir(mount, { recursive: true }); await fs.mkdir(path.dirname(receiptFile), { recursive: true });
  const source = { version: 1, commit: 'a'.repeat(40), checksPassed: true, files: { 'app/fixture.mjs': 'b'.repeat(64) } };
  const bytes = Buffer.from(JSON.stringify(source)); await fs.writeFile(receiptFile, bytes);
  const identityFile = path.join(artifactRoot, 'candidate-identity.json');
  const identity = { version: 1, kind: 'volterraImageCandidateV1', buildName: 'development-013', candidateId: id, artifactRoot,
    baseArtifactRoot: path.join(workspace, 'build/development-006'), sourceReceipt: receiptFile, sourceReceiptSHA256: hash(bytes).toUpperCase(), sourceCommit: source.commit,
    baseImageReceiptSHA256: '1'.repeat(64), baseBootSHA256: '2'.repeat(64), baseInstallSHA256: '3'.repeat(64), privateDevelopmentOnly: true,
    publicDistributionAllowed: false, bootAccepted: false, runtimeAccepted: false, recoveryAccepted: false, physicalHardwareAccepted: false };
  await fs.writeFile(identityFile, JSON.stringify(identity));
  return { workspace, mount, receiptFile, source, identity, identityFile, artifactRoot };
}

test('the actual shared boundary accepts both historical mounts and source-bound current013 candidate mounts', async t => {
  const f = await fixture(t);
  const candidate = await validateOfflineImageMount(f);
  assert.equal(candidate.candidate, true); assert.equal(candidate.candidateId, id);
  assert.equal(candidate.sourceReceiptSHA256, f.identity.sourceReceiptSHA256.toLowerCase());
  const install = path.join(f.artifactRoot, 'final-install'); await fs.mkdir(install);
  assert.equal((await validateOfflineImageMount({ ...f, mount: install })).candidate, true);
  for (const relative of ['build/development-006/final-boot', 'build/development-013/final-install', 'build/development-900/final-boot']) {
    const mount = path.join(f.workspace, relative); await fs.mkdir(mount, { recursive: true });
    assert.equal((await validateOfflineImageMount({ ...f, mount })).candidate, false);
  }
});

test('candidate admission requires exact existing identity, typed flags, source bytes and base scope', async t => {
  const f = await fixture(t);
  for (const [key, value] of [ ['version', '1'], ['kind', 'other'], ['candidateId', 'f'.repeat(36)], ['buildName', 'development-014'],
    ['artifactRoot', path.join(f.workspace, 'build/development-013')], ['baseArtifactRoot', f.workspace], ['baseInstallSHA256', 'a'.repeat(64)],
    ['sourceReceiptSHA256', '4'.repeat(64)], ['sourceCommit', 'c'.repeat(40)], ['sourceReceipt', path.join(f.workspace, 'other.json')],
    ['privateDevelopmentOnly', 'true'], ['publicDistributionAllowed', true], ['bootAccepted', true], ['runtimeAccepted', true], ['recoveryAccepted', true], ['physicalHardwareAccepted', true] ]) {
    await fs.writeFile(f.identityFile, JSON.stringify({ ...f.identity, [key]: value }));
    await assert.rejects(validateOfflineImageMount(f));
  }
  await fs.writeFile(f.identityFile, JSON.stringify(f.identity));
  await assert.rejects(validateOfflineImageMount({ ...f, source: { ...f.source, files: { 'app/fixture.mjs': 'c'.repeat(64) } } }), /source receipt bytes/);
  await fs.writeFile(f.receiptFile, JSON.stringify({ ...f.source, checksPassed: false }));
  await assert.rejects(validateOfflineImageMount(f), /source receipt bytes/);
  await fs.unlink(f.identityFile); await assert.rejects(validateOfflineImageMount(f));
});

test('candidate naming cannot admit another version, nested mount, malformed or zero identity', async t => {
  const f = await fixture(t);
  for (const relative of ['build/verification/media-candidate-development-014-' + id + '/final-boot',
    'build/verification/media-candidate-development-013-00000000-0000-0000-0000-000000000000/final-boot',
    'build/verification/media-candidate-development-013-' + id + '/nested/final-boot',
    'build/verification/media-candidate-development-013-ABCDEFAB-2222-3333-4444-555555555555/final-boot', 'outside/final-boot']) {
    const mount = path.join(f.workspace, relative); await fs.mkdir(mount, { recursive: true });
    await assert.rejects(validateOfflineImageMount({ ...f, mount }));
  }
});

test('redirected candidate ancestry and multiply linked identity or receipt files are refused before payload access', async t => {
  const f = await fixture(t), linked = path.join(f.workspace, 'identity-link');
  await fs.link(f.identityFile, linked); await assert.rejects(validateOfflineImageMount(f), /single-link/); await fs.unlink(linked);
  await fs.link(f.receiptFile, linked); await assert.rejects(validateOfflineImageMount(f), /single-link/); await fs.unlink(linked);
  const external = path.join(f.workspace, 'external'); await fs.mkdir(external);
  await fs.rmdir(f.mount); await fs.symlink(external, f.mount, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateOfflineImageMount(f), /redirected/);
  assert.deepEqual(await fs.readdir(external), []);
});

test('the identity reader rejects a same-name replacement during its bounded handle read', async t => {
  for (const extra of [{}, { changedDuringRead: true }]) {
    const f = await fixture(t), originalOpen = fs.open.bind(fs); let changed = false;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== f.identityFile) return handle;
      const read = handle.read.bind(handle);
      handle.read = async (...parameters) => {
        const result = await read(...parameters);
        if (!changed) { changed = true; await fs.writeFile(f.identityFile, JSON.stringify({ ...f.identity, sourceCommit: 'c'.repeat(40), ...extra })); }
        return result;
      };
      return handle;
    });
    await assert.rejects(validateOfflineImageMount(f), /changed during reading/);
    assert.equal(changed, true); t.mock.restoreAll();
  }
});
