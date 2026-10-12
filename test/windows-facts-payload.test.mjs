import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageWindowsFacts } from '../scripts/Stage-WindowsFacts.mjs';
import { hash } from '../app/source-policy.mjs';

const binaryFile = 'private/tools/volterra-facts.exe';
const manifestFile = 'private/tools/volterra-facts-build.json';
async function fixture(t, candidate = false) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-facts-')));
  t.after(async () => {
    const real = await fs.realpath(workspace), relative = path.relative(await fs.realpath(os.tmpdir()), real);
    assert.ok(relative.startsWith('volterra-facts-') && !relative.includes(path.sep));
    await fs.rm(real, { recursive: true, force: true });
  });
  const candidateId = '11111111-2222-3333-4444-555555555555';
  const mount = path.join(workspace, candidate ? `build/verification/media-candidate-development-013-${candidateId}/final-boot` : 'build/development-012/final-boot');
  await fs.mkdir(path.join(workspace, 'private/tools'), { recursive: true });
  await fs.mkdir(path.join(mount, 'Volterra/private/tools'), { recursive: true });
  const source = { version: 1, checksPassed: true, commit: 'a'.repeat(40), files: { 'scripts/Probe-WindowsFacts.cs': hash(Buffer.from('Owned C# source')), 'scripts/Private-WindowsState.cs': hash(Buffer.from('Owned privacy source')), 'scripts/Build-WindowsFacts.ps1': hash(Buffer.from('Owned compiler script')) } };
  const binary = Buffer.from('Fixture binary, never executed');
  const manifest = { version: 1, kind: 'volterraWindowsFactsBuild', sourceCommit: source.commit, sourceFile: 'scripts/Probe-WindowsFacts.cs', sourceSHA256: source.files['scripts/Probe-WindowsFacts.cs'], privateStateSourceFile: 'scripts/Private-WindowsState.cs', privateStateSourceSHA256: source.files['scripts/Private-WindowsState.cs'], buildScript: 'scripts/Build-WindowsFacts.ps1', buildScriptSHA256: source.files['scripts/Build-WindowsFacts.ps1'], executable: { file: binaryFile, SHA256: hash(binary), bytes: binary.length, target: 'AnyCPU; ARM64 Windows CLR required' }, compiler: { path: 'C:/Fixture/compiler.exe', SHA256: 'b'.repeat(64), fileVersion: 'Fixture' }, managementAssembly: { path: 'C:/Fixture/management.dll', SHA256: 'c'.repeat(64) }, guestCompatibilityVerified: false };
  await fs.writeFile(path.join(workspace, binaryFile), binary);
  await fs.writeFile(path.join(workspace, manifestFile), JSON.stringify(manifest));
  let receiptFile = 'Fixture already verified by injected source checker';
  if (candidate) {
    receiptFile = path.join(workspace, 'build/source-snapshots/fixture/source-receipt.json');
    await fs.mkdir(path.dirname(receiptFile), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(source)); await fs.writeFile(receiptFile, bytes);
    const identity = { version: 1, kind: 'volterraImageCandidateV1', buildName: 'development-013', candidateId, artifactRoot: path.dirname(mount),
      baseArtifactRoot: path.join(workspace, 'build/development-006'), sourceReceipt: receiptFile, sourceReceiptSHA256: hash(bytes).toUpperCase(), sourceCommit: source.commit,
      baseImageReceiptSHA256: '1'.repeat(64), baseBootSHA256: '2'.repeat(64), baseInstallSHA256: '3'.repeat(64), privateDevelopmentOnly: true,
      publicDistributionAllowed: false, bootAccepted: false, runtimeAccepted: false, recoveryAccepted: false, physicalHardwareAccepted: false };
    await fs.writeFile(path.join(path.dirname(mount), 'candidate-identity.json'), JSON.stringify(identity));
  }
  return { workspace, mount, source, binary, manifest, receiptFile, verify: async () => source };
}
const options = f => ({ receiptFile: f.receiptFile, workspace: f.workspace, mount: f.mount, verify: f.verify });

test('facts copy and committed-byte verification admit the same source-bound current013 candidate boundary', async t => {
  const f = await fixture(t, true), identityFile = path.join(path.dirname(f.mount), 'candidate-identity.json');
  const identityBefore = await fs.readFile(identityFile), sourceBefore = await fs.readFile(f.receiptFile);
  const copied = await stageWindowsFacts(options(f)), verified = await stageWindowsFacts({ ...options(f), mode: 'verify' });
  assert.equal(copied.sourceCommit, f.source.commit); assert.equal(verified.executableSHA256, copied.executableSHA256);
  assert.equal(verified.guestCompatibilityVerified, false);
  assert.deepEqual(await fs.readFile(identityFile), identityBefore); assert.deepEqual(await fs.readFile(f.receiptFile), sourceBefore);
  const identity = JSON.parse(identityBefore); identity.sourceReceiptSHA256 = 'A'.repeat(64);
  await fs.writeFile(identityFile, JSON.stringify(identity));
  await assert.rejects(stageWindowsFacts({ ...options(f), mode: 'verify' }), /source receipt bytes/);
});

test('facts overlay copies exactly the two source-bound files, preserving vendor and account bytes', async t => {
  const f = await fixture(t), payload = path.join(f.mount, 'Volterra');
  const vendor = path.join(payload, 'private/tools/vendor.exe'), account = path.join(payload, 'private/auth.json');
  await fs.writeFile(vendor, 'Vendor bytes'); await fs.writeFile(account, 'Fixture account state, never transferred');
  const receipt = await stageWindowsFacts(options(f));
  assert.equal(receipt.sourceCommit, f.source.commit); assert.equal(receipt.guestCompatibilityVerified, false); assert.equal(receipt.runtimeAccepted, false);
  assert.deepEqual(await fs.readFile(path.join(payload, binaryFile)), f.binary);
  assert.equal(await fs.readFile(vendor, 'utf8'), 'Vendor bytes'); assert.equal(await fs.readFile(account, 'utf8'), 'Fixture account state, never transferred');
  assert.deepEqual((await fs.readdir(path.join(payload, 'private/tools'))).sort(), ['vendor.exe', 'volterra-facts-build.json', 'volterra-facts.exe']);
  assert.deepEqual(Object.keys(receipt.files).sort(), [manifestFile, binaryFile].sort());
  const verified = await stageWindowsFacts({ ...options(f), mode: 'verify' });
  assert.equal(verified.executableSHA256, receipt.executableSHA256); assert.equal(verified.provenanceSHA256, receipt.provenanceSHA256);
});

test('read-back verification rejects changed persisted bytes without rewriting them', async t => {
  const f = await fixture(t); await stageWindowsFacts(options(f));
  const destination = path.join(f.mount, 'Volterra', binaryFile);
  await fs.writeFile(destination, 'Changed committed fixture');
  await assert.rejects(stageWindowsFacts({ ...options(f), mode: 'verify' }), /persisted facts payload/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'Changed committed fixture');
});

test('facts overlay refuses invalid provenance, changed native inputs or guest acceptance before writes', async t => {
  for (const change of [m => { m.sourceCommit = 'invalid'; }, m => { delete m.privateStateSourceSHA256; }, m => { m.privateStateSourceSHA256 = 'd'.repeat(64); }, m => { m.buildScriptSHA256 = 'd'.repeat(64); }, m => { m.executable.SHA256 = 'd'.repeat(64); }, m => { m.executable.file = 'private/auth.json'; }, m => { m.guestCompatibilityVerified = true; }]) {
    const f = await fixture(t); change(f.manifest);
    await fs.writeFile(path.join(f.workspace, manifestFile), JSON.stringify(f.manifest));
    await assert.rejects(stageWindowsFacts(options(f)));
    assert.deepEqual(await fs.readdir(path.join(f.mount, 'Volterra/private/tools')), []);
  }
});

test('source-only updates reuse unchanged native inputs while retaining their compiled commit', async t => {
  const f = await fixture(t); f.manifest.sourceCommit = 'd'.repeat(40);
  await fs.writeFile(path.join(f.workspace, manifestFile), JSON.stringify(f.manifest));
  const result = await stageWindowsFacts(options(f));
  assert.equal(result.sourceCommit, f.source.commit); assert.equal(result.compiledSourceCommit, 'd'.repeat(40));
  assert.equal(result.privateStateSourceSHA256, f.source.files['scripts/Private-WindowsState.cs']);
});

test('facts overlay refuses redirected private destination and hardlink writes', async t => {
  const f = await fixture(t), tools = path.join(f.mount, 'Volterra/private/tools');
  const external = path.join(f.workspace, 'external'); await fs.mkdir(external);
  await fs.rmdir(tools);
  await fs.symlink(external, tools, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageWindowsFacts(options(f)), /redirected/);
  assert.deepEqual(await fs.readdir(external), []);
  const g = await fixture(t), destination = path.join(g.mount, 'Volterra', binaryFile);
  await fs.writeFile(destination, 'Existing tool'); await fs.link(destination, path.join(g.workspace, 'external-tool'));
  await assert.rejects(stageWindowsFacts(options(g)), /multiple links/);
  assert.equal(await fs.readFile(path.join(g.workspace, 'external-tool'), 'utf8'), 'Existing tool');
});

test('facts payload rejects an unowned mount before touching private inputs', async t => {
  const f = await fixture(t), unowned = path.join(f.workspace, 'external-mount'); await fs.mkdir(unowned);
  await assert.rejects(stageWindowsFacts({ ...options(f), mount: unowned }), /exact owned offline/);
  assert.deepEqual(await fs.readdir(unowned), []);
});
