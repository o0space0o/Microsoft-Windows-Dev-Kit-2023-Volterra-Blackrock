import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isoBootPaths, readIsoBootPlan } from '../app/iso-boot-plan.mjs';

const commit = 'c776fbe8ca9a874a5d5b92254a5544e76bb828ef';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = '8548b37f-3ac3-41f4-a8ea-1fec05456e40';
const save = (file, value) => fs.writeFile(file, JSON.stringify(value));

async function fixture(t, buildName = 'development-007') {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-iso-plan-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), workspace);
    assert.ok(relative.startsWith('volterra-iso-plan-') && !relative.includes(path.sep));
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const paths = isoBootPaths(workspace, buildName), bytes = Buffer.from('Original tiny source-test fixture, not bootable media.');
  await fs.mkdir(paths.build, { recursive: true });
  await fs.writeFile(paths.iso, bytes);
  const receipt = { path: paths.iso, sha256: hash(bytes).toUpperCase(), bytes: bytes.length, architecture: 'arm64', privateDevelopmentOnly: true, sourceCommit: commit, bootTested: false };
  const imageFile = path.join(paths.build, 'image-receipt.json'), finalFile = path.join(paths.build, 'Finalize-result.json');
  await save(paths.receiptFile, receipt);
  await save(imageFile, { helperBuild: buildName, sourceCommit: commit });
  await save(finalFile, { status: 'passed', sourceCommit: commit });
  const read = phase => readIsoBootPlan(workspace, buildName, phase);
  async function installIdentity(legacy = false) {
    await fs.mkdir(paths.owned, { recursive: true });
    await fs.writeFile(paths.data, 'Virtual disk path fixture only.');
    const identity = { id, name: paths.vmName, data: paths.data, iso: paths.iso, isoSHA256: receipt.sha256, physicalDiskAttached: false, network: false };
    if (!legacy) Object.assign(identity, { version: 2, buildName, sourceCommit: commit, isoReceipt: paths.receiptFile, isoReceiptSHA256: hash(await fs.readFile(paths.receiptFile)) });
    await save(paths.identityFile, identity);
    return identity;
  }
  return { workspace, paths, receipt, read, installIdentity, imageFile, finalFile };
}

test('explicit 006 identities stay compatible while omitted build selection refuses', () => {
  const a = isoBootPaths(os.tmpdir(), 'development-006'), b = isoBootPaths(os.tmpdir(), 'development-007');
  assert.equal(a.buildName, 'development-006');
  assert.equal(a.vmName, 'Microsoft Volterra development ISO test 006');
  assert.equal(path.basename(a.iso), 'Microsoft-Volterra-development-arm64.iso');
  assert.equal(b.vmName, 'Microsoft Volterra development ISO test 007');
  assert.equal(path.basename(b.iso), 'Microsoft-Volterra-development-007-arm64.iso');
  for (const key of ['build', 'owned', 'iso', 'data', 'identityFile', 'receiptFile']) assert.notEqual(a[key], b[key]);
  for (const value of ['../development-007', 'development-007\n', 'development-007/elsewhere', 'development-7', 'development-007:stream', '', null, undefined]) assert.throws(() => isoBootPaths(os.tmpdir(), value), /BuildName/);
});

test('the exported reader refuses omitted build selection without changing fixture outputs', async t => {
  const f = await fixture(t), before = (await fs.readdir(f.paths.build)).sort();
  for (const phase of ['Prepare', 'Inspect', 'Stop']) await assert.rejects(readIsoBootPlan(f.workspace, undefined, phase), /BuildName/);
  assert.deepEqual((await fs.readdir(f.paths.build)).sort(), before);
  await assert.rejects(fs.access(f.paths.owned));
});

test('selection binds the exact ISO bytes and receipt to its image source commit without creating output', async t => {
  const f = await fixture(t), plan = await f.read('Prepare');
  assert.equal(plan.sourceCommit, commit);
  assert.equal(plan.isoReceiptSHA256, hash(await fs.readFile(f.paths.receiptFile)));
  assert.equal(plan.isoSHA256, f.receipt.sha256.toLowerCase());
  assert.equal(plan.sourceBinding, 'bound');
  assert.equal(plan.bootAccepted, false); assert.equal(plan.runtimeAccepted, false);
  await assert.rejects(fs.access(f.paths.owned));
  assert.deepEqual((await fs.readdir(f.paths.build)).sort(), ['Finalize-result.json', 'Microsoft-Volterra-development-007-arm64.iso', 'image-receipt.json', 'iso-receipt.json']);
});

test('wrong receipt paths, bytes, hashes, architectures and source bindings fail closed', async t => {
  const f = await fixture(t);
  for (const patch of [{ path: isoBootPaths(f.workspace, 'development-006').iso }, { bytes: f.receipt.bytes + 1 }, { sha256: '0'.repeat(64) },
    { architecture: 'x64' }, { privateDevelopmentOnly: false }, { sourceCommit: undefined }, { sourceCommit: 'main' }]) {
    await save(f.paths.receiptFile, { ...f.receipt, ...patch });
    await assert.rejects(f.read('Prepare'), /receipt|commit/);
  }
  await save(f.paths.receiptFile, f.receipt);
  await fs.appendFile(f.paths.iso, 'changed');
  await assert.rejects(f.read('Prepare'), /hash or size/);
});

test('ISO source binding must agree with successful finalization of this selected build', async t => {
  const f = await fixture(t);
  for (const patch of [{ helperBuild: 'development-006', sourceCommit: commit }, { helperBuild: 'development-007', sourceCommit: '1'.repeat(40) }]) {
    await save(f.imageFile, patch); await assert.rejects(f.read('Prepare'), /image\/finalization/);
  }
  await save(f.imageFile, { helperBuild: 'development-007', sourceCommit: commit });
  await save(f.finalFile, { status: 'failed', sourceCommit: commit });
  await assert.rejects(f.read('Prepare'), /image\/finalization/);
});

test('new identities reject cross-build disks and changed ISO receipt/source binding', async t => {
  const f = await fixture(t), identity = await f.installIdentity();
  assert.equal((await f.read('Inspect')).vmId, id);
  for (const patch of [{ data: isoBootPaths(f.workspace, 'development-006').data }, { buildName: 'development-006' }, { id: 'not-a-guid' },
    { isoReceiptSHA256: '0'.repeat(64) }, { sourceCommit: '1'.repeat(40) }, { physicalDiskAttached: true }, { network: true }]) {
    await save(f.paths.identityFile, { ...identity, ...patch });
    await assert.rejects(f.read('Inspect'), /identity/);
  }
  await save(f.paths.identityFile, identity);
  await fs.appendFile(f.paths.receiptFile, '\n');
  await assert.rejects(f.read('Stop'), /binding changed/);
});

test('an existing test disk or identity is never replaced by preparation', async t => {
  const f = await fixture(t);
  const identity = await f.installIdentity();
  await assert.rejects(f.read('Prepare'), /will not be replaced/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.identityFile)), identity);
  assert.equal(await fs.readFile(f.paths.data, 'utf8'), 'Virtual disk path fixture only.');
});

test('legacy unbound 006 can be inspected or stopped without inventing a source commit; new preparation cannot use it', async t => {
  const f = await fixture(t, 'development-006'); delete f.receipt.sourceCommit;
  await save(f.paths.receiptFile, f.receipt); await f.installIdentity(true);
  for (const phase of ['Inspect', 'Stop']) {
    const plan = await f.read(phase);
    assert.equal(plan.sourceCommit, null); assert.equal(plan.sourceBinding, 'legacy-unbound');
    assert.equal(plan.bootAccepted, false); assert.equal(plan.runtimeAccepted, false); assert.equal(plan.vmId, id);
  }
  await assert.rejects(f.read('Prepare'), /source commit/);
  const newer = await fixture(t); delete newer.receipt.sourceCommit;
  await save(newer.paths.receiptFile, newer.receipt); await newer.installIdentity(true);
  await assert.rejects(newer.read('Inspect'), /source commit/);
});

test('a linked owned directory or ISO receipt cannot redirect selection to another build', async t => {
  const f = await fixture(t), elsewhere = path.join(f.workspace, 'outside'); await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, f.paths.owned, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.read('Prepare'), /Linked/);
  await fs.unlink(f.paths.owned);
  const linked = path.join(elsewhere, 'receipt.json'); await fs.rename(f.paths.receiptFile, linked);
  await fs.link(linked, f.paths.receiptFile);
  await assert.rejects(f.read('Prepare'), /Linked/);
  assert.deepEqual(JSON.parse(await fs.readFile(linked)), f.receipt);
});

test('a hard-linked capture output is rejected without writing outside the selected test', async t => {
  const f = await fixture(t); await f.installIdentity();
  const outside = path.join(f.workspace, 'outside-fixture.txt'); await fs.writeFile(outside, 'Preserve this fixture.');
  await fs.link(outside, path.join(f.paths.owned, 'screen.png'));
  await assert.rejects(f.read('Inspect'), /Linked/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'Preserve this fixture.');
});
