import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageWindowsFacts } from '../scripts/Stage-WindowsFacts.mjs';
import { hash } from '../app/source-policy.mjs';

const binaryFile = 'private/tools/volterra-facts.exe';
const manifestFile = 'private/tools/volterra-facts-build.json';
async function fixture(t) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-facts-')));
  t.after(async () => {
    const real = await fs.realpath(workspace), relative = path.relative(await fs.realpath(os.tmpdir()), real);
    assert.ok(relative.startsWith('volterra-facts-') && !relative.includes(path.sep));
    await fs.rm(real, { recursive: true, force: true });
  });
  const mount = path.join(workspace, 'build/development-012/final-boot');
  await fs.mkdir(path.join(workspace, 'private/tools'), { recursive: true });
  await fs.mkdir(path.join(mount, 'Volterra/private/tools'), { recursive: true });
  const source = { commit: 'a'.repeat(40), files: { 'scripts/Probe-WindowsFacts.cs': hash(Buffer.from('Owned C# source')), 'scripts/Build-WindowsFacts.ps1': hash(Buffer.from('Owned compiler script')) } };
  const binary = Buffer.from('Fixture binary, never executed');
  const manifest = { version: 1, kind: 'volterraWindowsFactsBuild', sourceCommit: source.commit, sourceFile: 'scripts/Probe-WindowsFacts.cs', sourceSHA256: source.files['scripts/Probe-WindowsFacts.cs'], buildScript: 'scripts/Build-WindowsFacts.ps1', buildScriptSHA256: source.files['scripts/Build-WindowsFacts.ps1'], executable: { file: binaryFile, SHA256: hash(binary), bytes: binary.length, target: 'AnyCPU; ARM64 Windows CLR required' }, compiler: { path: 'C:/Fixture/compiler.exe', SHA256: 'b'.repeat(64), fileVersion: 'Fixture' }, managementAssembly: { path: 'C:/Fixture/management.dll', SHA256: 'c'.repeat(64) }, guestCompatibilityVerified: false };
  await fs.writeFile(path.join(workspace, binaryFile), binary);
  await fs.writeFile(path.join(workspace, manifestFile), JSON.stringify(manifest));
  return { workspace, mount, source, binary, manifest, verify: async () => source };
}
const options = f => ({ receiptFile: 'Fixture already verified by injected source checker', workspace: f.workspace, mount: f.mount, verify: f.verify });

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

test('facts overlay refuses a different source commit, compiler script, executable or guest acceptance claim before writes', async t => {
  for (const change of [m => { m.sourceCommit = 'd'.repeat(40); }, m => { m.buildScriptSHA256 = 'd'.repeat(64); }, m => { m.executable.SHA256 = 'd'.repeat(64); }, m => { m.executable.file = 'private/auth.json'; }, m => { m.guestCompatibilityVerified = true; }]) {
    const f = await fixture(t); change(f.manifest);
    await fs.writeFile(path.join(f.workspace, manifestFile), JSON.stringify(f.manifest));
    await assert.rejects(stageWindowsFacts(options(f)));
    assert.deepEqual(await fs.readdir(path.join(f.mount, 'Volterra/private/tools')), []);
  }
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
