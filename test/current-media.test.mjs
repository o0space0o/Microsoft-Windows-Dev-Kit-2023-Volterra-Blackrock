import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isoBootPaths } from '../app/iso-boot-plan.mjs';
import { readCurrentMedia, readRequestedIsoPlan } from '../scripts/Current-Media.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = '5ec92dd1c058a7e13836242ec8ba3b963b832636';
async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-current-media-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), workspace);
    assert.ok(relative.startsWith('volterra-current-media-') && !relative.includes(path.sep));
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const pointer = path.join(workspace, 'build', 'verification', 'single-current-media.json');
  await fs.mkdir(path.dirname(pointer), { recursive: true });
  async function build(name) {
    const p = isoBootPaths(workspace, name), bytes = Buffer.from('Source fixture only; no bootable media or disk.');
    await fs.mkdir(p.owned, { recursive: true }); await fs.writeFile(p.iso, bytes); await fs.writeFile(p.data, 'Not a VHD.');
    const receipt = { path: p.iso, sha256: digest(bytes), bytes: bytes.length, sourceCommit: commit, architecture: 'arm64', privateDevelopmentOnly: true };
    await fs.writeFile(p.receiptFile, JSON.stringify(receipt));
    await fs.writeFile(path.join(p.build, 'image-receipt.json'), JSON.stringify({ helperBuild: name, sourceCommit: commit }));
    await fs.writeFile(path.join(p.build, 'Finalize-result.json'), JSON.stringify({ status: 'passed', sourceCommit: commit }));
    await fs.writeFile(p.identityFile, JSON.stringify({ version: 2, buildName: name, id: '11111111-2222-3333-4444-555555555555', name: p.vmName, data: p.data, iso: p.iso, isoSHA256: receipt.sha256, physicalDiskAttached: false, network: false, sourceCommit: commit, isoReceipt: p.receiptFile, isoReceiptSHA256: digest(await fs.readFile(p.receiptFile)) }));
    return { p, receipt };
  }
  const current = await build('development-013');
  const value = { version: 1, kind: 'Observed single current custom ISO', customISOCount: 1, currentBuild: 'development-013', sourceCommit: commit, path: current.p.iso, sha256: current.receipt.sha256, bytes: current.receipt.bytes };
  const save = value => fs.writeFile(pointer, JSON.stringify(value));
  await save(value);
  return { workspace, pointer, current, value, save, build };
}
test('implicit read-only selection uses the observed013 pointer and independently sealed ISO receipts', async t => {
  const f = await fixture(t), before = await fs.readdir(f.current.p.owned);
  const selected = await readRequestedIsoPlan(f.workspace);
  assert.equal(selected.buildName, 'development-013'); assert.equal(selected.phase, 'Inspect');
  assert.equal(selected.isoSHA256, f.value.sha256); assert.equal(selected.sourceCommit, commit);
  assert.equal(selected.currentMediaPointerSHA256, digest(await fs.readFile(f.pointer)));
  assert.equal(selected.bootAccepted, false); assert.equal(selected.runtimeAccepted, false);
  assert.deepEqual(await fs.readdir(f.current.p.owned), before);
  for (const phase of ['Prepare', 'Stop']) await assert.rejects(readRequestedIsoPlan(f.workspace, undefined, phase), /explicit BuildName/);
});
test('an absent pointer never falls back to the retained006 foundation', async t => {
  const f = await fixture(t); await f.build('development-006'); await fs.unlink(f.pointer);
  await assert.rejects(readRequestedIsoPlan(f.workspace), /ENOENT/);
  assert.equal((await readRequestedIsoPlan(f.workspace, 'development-006', 'Inspect')).buildName, 'development-006');
  assert.equal((await readRequestedIsoPlan(f.workspace, 'development-006', 'Stop')).phase, 'Stop');
});
test('another current version, multiple media, foreign paths and missing source data refuse', async t => {
  const f = await fixture(t);
  for (const patch of [{ currentBuild: 'development-006' }, { currentBuild: 'development-014' }, { customISOCount: 2 },
    { path: path.join(f.workspace, 'elsewhere.iso') }, { sourceCommit: undefined }, { version: 2 }, { sha256: 'main' }, { bytes: 0 }]) {
    await f.save({ ...f.value, ...patch }); await assert.rejects(readCurrentMedia(f.workspace), /explicit observed current013/);
  }
});
test('current pointer cannot override actual ISO hash, size or source commit', async t => {
  const f = await fixture(t);
  for (const patch of [{ sha256: '0'.repeat(64) }, { bytes: f.value.bytes + 1 }, { sourceCommit: '1'.repeat(40) }]) {
    await f.save({ ...f.value, ...patch }); await assert.rejects(readRequestedIsoPlan(f.workspace), /independently verified/);
  }
});
test('linked or oversized current pointers are excluded before selection', async t => {
  const f = await fixture(t), copy = path.join(f.workspace, 'copy.json');
  await fs.rename(f.pointer, copy); await fs.link(copy, f.pointer);
  await assert.rejects(readCurrentMedia(f.workspace), /Linked|ordinary file/);
  await fs.unlink(f.pointer); await fs.unlink(copy);
  await fs.writeFile(f.pointer, ' '.repeat(65537)); await assert.rejects(readCurrentMedia(f.workspace), /bounded ordinary/);
});
