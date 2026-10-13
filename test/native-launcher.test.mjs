import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hash } from '../app/source-policy.mjs';
import { inspectBaseHandoff, stageVolterraLauncher, validateBaseHandoff, validateLauncherBuild } from '../scripts/Stage-VolterraLauncher.mjs';

const commit = '1'.repeat(40);
const admitted = { mode: 'originalNativeSupervisor', softwareSHA256: '182a8b1454b07dc0fd9b0a0e63b5ae8100670e6b8cb32e8e251297eed685d994',
  supervisorSHA256: '488b67f8368d206dabcf36ea4d6bfe23fe13bbd887cea275840b2d577a1953d7' };
function build() {
  const binary = Buffer.alloc(4096);
  binary.writeUInt16LE(0x5a4d, 0); binary.writeUInt32LE(128, 0x3c); binary.writeUInt32LE(0x4550, 128);
  binary.writeUInt16LE(0xaa64, 132); binary.writeUInt16LE(0x20b, 152); binary.writeUInt16LE(3, 220);
  const strings = ['X:\\Windows', 'WinVOS', 'X:\\Volterra\\private\\tools\\node.exe', 'X:\\Volterra\\scripts\\Start-Volterra.mjs',
    '"X:\\Volterra\\private\\tools\\node.exe" "X:\\Volterra\\scripts\\Start-Volterra.mjs" --boot'];
  Buffer.from(strings.join('\0') + '\0', 'utf16le').copy(binary, 512);
  const source = { commit, files: { 'scripts/Launch-Volterra.cpp': hash('launcher source'), 'scripts/Build-VolterraLauncher.ps1': hash('build source') } };
  const manifest = { version: 1, kind: 'volterraNativeLauncherBuild', source: 'scripts/Launch-Volterra.cpp', sourceSHA256: source.files['scripts/Launch-Volterra.cpp'],
    buildScriptSHA256: source.files['scripts/Build-VolterraLauncher.ps1'], executable: 'private/rebase-tools/DesktopShell.exe',
    executableSHA256: hash(binary), executableBytes: binary.length, architecture: 'arm64', subsystem: 'console', guestCompatibilityVerified: false, hostBootChanged: false,
    toolchainArchiveSHA256: 'A317514A7A63BADD692032C0C2B8E165F630BBAEBBE7A3254348051F43A64949', toolchainVerifiedFiles: 9052,
    compilerSHA256: '7B8F98D3990ACAE9F0132FBC74937D7597529F5E9D9F28CE1E0B0BE70F717F78' };
  return { binary, source, manifest };
}

test('only the inspected SOFTWARE and supervisor identities admit each startup handoff', () => {
  assert.equal(validateBaseHandoff(admitted.softwareSHA256, admitted.supervisorSHA256), 'originalNativeSupervisor');
  assert.equal(validateBaseHandoff('8d8589c2bb2aa62aa498e0736fa9232121f100c94c2a2d255ca9bc58c5b6a956', null), 'commandShell');
  for (const pair of [[admitted.softwareSHA256, null], [admitted.softwareSHA256, '0'.repeat(64)], ['0'.repeat(64), admitted.supervisorSHA256],
    ['8d8589c2bb2aa62aa498e0736fa9232121f100c94c2a2d255ca9bc58c5b6a956', admitted.supervisorSHA256]]) {
    assert.throws(() => validateBaseHandoff(...pair), /unsupported/);
  }
});

test('the verified Hyper-V guest base still requires the preserved native supervisor', () => {
  const serviced = '8018fdfee5171f1269d1fdc59ef646b8273fa85ecc2e41044609c009c97c4c90';
  assert.equal(validateBaseHandoff(serviced, admitted.supervisorSHA256), 'originalNativeSupervisor');
  for (const supervisor of [null, '0'.repeat(64), admitted.softwareSHA256]) {
    assert.throws(() => validateBaseHandoff(serviced, supervisor), /unsupported/);
  }
  assert.throws(() => validateBaseHandoff('0' + serviced.slice(1), admitted.supervisorSHA256), /unsupported/);
  // A post-query registry view is evidence, not the pristine image identity.
  assert.throws(() => validateBaseHandoff('fea1dee14992bdc1a1ac3d24505ef39385f348afc950be155b2f7aff95a139bf', admitted.supervisorSHA256), /unsupported/);
});

test('the verified WPF base admits only its pristine SOFTWARE with the preserved supervisor', () => {
  const serviced = 'cc6c6ee49702405dc2f8d8b1e12642692831bdfad873f34e783d9a0e5c6f999c';
  assert.equal(validateBaseHandoff(serviced, admitted.supervisorSHA256), 'originalNativeSupervisor');
  for (const supervisor of [null, '0'.repeat(64), admitted.softwareSHA256]) {
    assert.throws(() => validateBaseHandoff(serviced, supervisor), /unsupported/);
  }
  assert.throws(() => validateBaseHandoff('0' + serviced.slice(1), admitted.supervisorSHA256), /unsupported/);
});

test('launcher provenance binds both source files, the checked compiler and exact executable bytes', () => {
  const f = build();
  validateLauncherBuild(f.manifest, f.source, f.binary);
  for (const patch of [{ version: 2 }, { source: 'another.cpp' }, { executable: '../DesktopShell.exe' }, { architecture: 'x64' },
    { guestCompatibilityVerified: true }, { hostBootChanged: true }, { sourceSHA256: '0'.repeat(64) }, { buildScriptSHA256: '0'.repeat(64) },
    { compilerSHA256: '0'.repeat(64) }, { toolchainArchiveSHA256: '0'.repeat(64) }, { toolchainVerifiedFiles: 0 },
    { executableSHA256: '0'.repeat(64) }, { executableBytes: f.binary.length + 1 }]) {
    assert.throws(() => validateLauncherBuild({ ...f.manifest, ...patch }, f.source, f.binary));
  }
  assert.throws(() => validateLauncherBuild(f.manifest, { files: {} }, f.binary), /checked source/);
});

test('receipt claims cannot substitute for ARM64 PE and fixed live startup paths', () => {
  const f = build();
  for (const change of [b => b.writeUInt16LE(0x8664, 132), b => b.writeUInt32LE(0xffffffff, 0x3c),
    b => b.writeUInt16LE(2, 220), b => b.fill(0, 512)]) {
    const changed = Buffer.from(f.binary); change(changed);
    assert.throws(() => validateLauncherBuild({ ...f.manifest, executableSHA256: hash(changed) }, f.source, changed), /ARM64|fixed live/);
  }
});

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-launcher-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), workspace);
    assert.ok(relative.startsWith('volterra-launcher-') && !relative.includes(path.sep));
    assert.equal(await fs.realpath(workspace), path.resolve(workspace));
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const mount = path.join(workspace, 'build/current/final-boot'), tools = path.join(workspace, 'private/rebase-tools');
  const target = path.join(mount, 'Programs/Volterra/DesktopShell.exe'), supervisor = path.join(mount, 'Programs/Volterra/StartupSupervisor.exe');
  const launcherReceipt = path.join(tools, 'launcher-build.json'), f = build();
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.mkdir(tools, { recursive: true });
  await fs.writeFile(target, 'Original desktop fixture'); await fs.writeFile(supervisor, 'Preserved supervisor fixture');
  await fs.writeFile(path.join(tools, 'DesktopShell.exe'), f.binary); await fs.writeFile(launcherReceipt, JSON.stringify(f.manifest));
  return { ...f, workspace, mount, target, supervisor, launcherReceipt, inspect: async () => ({ ...admitted }) };
}

test('native staging replaces only DesktopShell and returns source-bound provenance separately from the application seed', async t => {
  const f = await fixture(t), before = await fs.readFile(f.supervisor);
  const result = await stageVolterraLauncher(f);
  assert.deepEqual(await fs.readFile(f.target), f.binary);
  assert.deepEqual(await fs.readFile(f.supervisor), before);
  assert.equal(result.previousLauncherSHA256, hash('Original desktop fixture'));
  assert.equal(result.launcherSHA256, hash(f.binary)); assert.equal(result.sourceCommit, commit);
  assert.equal(result.launcherBuildReceiptSHA256, hash(await fs.readFile(f.launcherReceipt)));
  assert.equal(result.guestCompatibilityVerified, false); assert.equal(result.physicalHardwareAccepted, false);
  assert.deepEqual((await fs.readdir(path.dirname(f.target))).sort(), ['DesktopShell.exe', 'StartupSupervisor.exe']);
  await assert.rejects(fs.stat(path.join(f.mount, 'Volterra')), /ENOENT/);
});

test('missing receipt, mismatched source, redirected inputs and unsupported base refuse before replacement', async t => {
  const f = await fixture(t), original = await fs.readFile(f.target);
  await assert.rejects(stageVolterraLauncher({ ...f, launcherReceipt: '' }), /explicit staged/);
  await assert.rejects(stageVolterraLauncher({ ...f, source: { ...f.source, files: {} } }), /checked source/);
  await assert.rejects(stageVolterraLauncher({ ...f, mount: path.join(f.workspace, 'other') }), /current offline/);
  await assert.rejects(stageVolterraLauncher({ ...f, inspect: async () => ({ mode: 'unknown' }) }), /Unsupported/);
  const copy = f.launcherReceipt + '.copy'; await fs.rename(f.launcherReceipt, copy); await fs.link(copy, f.launcherReceipt);
  await assert.rejects(stageVolterraLauncher(f), /multiple links/);
  await fs.unlink(f.launcherReceipt); await fs.rename(copy, f.launcherReceipt);
  assert.deepEqual(await fs.readFile(f.target), original);
});

test('the real base inspector refuses an unreviewed SOFTWARE hive', async t => {
  const f = await fixture(t), config = path.join(f.mount, 'Windows/System32/config');
  await fs.mkdir(config, { recursive: true }); await fs.writeFile(path.join(config, 'SOFTWARE'), 'Unreviewed SOFTWARE fixture');
  await assert.rejects(inspectBaseHandoff(f.mount), /unsupported/);
});

test('a changed supervisor during staging cannot yield a passing provenance result', async t => {
  const f = await fixture(t); let count = 0;
  await assert.rejects(stageVolterraLauncher({ ...f, inspect: async () => ++count === 1 ? { ...admitted } : { ...admitted, supervisorSHA256: '0'.repeat(64) } }), /preserved base handoff changed/);
});

test('command-shell admission checks its startup source and refuses native staging', async t => {
  const f = await fixture(t), file = path.join(f.mount, 'Windows/Volterra-Startup.cmd');
  await fs.mkdir(path.dirname(file)); await fs.writeFile(file, 'Checked command fixture');
  const options = { ...f, launcherReceipt: '', source: { ...f.source, files: { ...f.source.files, 'image/Volterra-Startup.cmd': hash('Checked command fixture') } },
    inspect: async () => ({ mode: 'commandShell', softwareSHA256: 'fixture', supervisorSHA256: null }) };
  assert.equal((await stageVolterraLauncher(options)).launcherStaged, false);
  await assert.rejects(stageVolterraLauncher({ ...options, launcherReceipt: f.launcherReceipt }), /command-shell base/);
  await fs.appendFile(file, 'changed');
  await assert.rejects(stageVolterraLauncher(options), /checked source/);
  assert.equal((await fs.readFile(f.target)).toString(), 'Original desktop fixture');
});
