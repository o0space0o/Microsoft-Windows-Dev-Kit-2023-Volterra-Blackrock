import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, approved } from '../app/source-policy.mjs';
import { validateOfflineImageMount, applicationOverlayOptions } from '../app/image-mount.mjs';
import { copyImagePayload } from '../app/image-source.mjs';
import { stageWindowsFacts, parseFactsArguments } from '../scripts/Stage-WindowsFacts.mjs';
import { parseImageSourceArguments } from '../scripts/Prepare-ImageSource.mjs';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function removeFixture(root, prefix) {
  const real = await fs.realpath(root), temp = await fs.realpath(os.tmpdir()), relative = path.relative(temp, real);
  assert.ok(relative.startsWith(prefix) && !relative.includes(path.sep) && relative !== '..');
  await fs.rm(real, { recursive: true, force: true });
}

const cid = '11111111-2222-4333-8444-555555555555', sha = 'A'.repeat(64);
const native = ['scripts/Probe-WindowsFacts.cs', 'scripts/Private-WindowsState.cs', 'scripts/Build-WindowsFacts.ps1'];
const fonts = ['segoeui.ttf', 'segoeuib.ttf', 'seguisb.ttf', 'segoeuil.ttf', 'segoeuisl.ttf', 'seguivar.ttf'];
const noClaims = ['sourceApplicationOverlayPerformed', 'factsOverlayPerformed', 'originalCandidateIdentityWritten', 'compositionReceiptWritten', 'originalInputPlanWritten', 'existing006Written', 'canonical013Written', 'currentPointerWritten', 'bootAccepted', 'runtimeAccepted', 'apiCompatibilityAccepted', 'recoveryAccepted', 'physicalHardwareAccepted', 'approvedVisualMatch', 'publicDistributionAllowed'];
async function fixture(t) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-overlay-fixture-')));
  t.after(() => removeFixture(workspace, 'volterra-overlay-fixture-'));
  const artifactRoot = path.join(workspace, 'build/verification/media-candidate-development-013-' + cid), mount = path.join(artifactRoot, 'final-boot');
  const originalReceipt = path.join(workspace, 'build/source-snapshots/original/source-receipt.json');
  const receiptFile = path.join(workspace, 'build/source-snapshots/current/source-receipt.json');
  const sourceRoot = path.join(path.dirname(receiptFile), 'source');
  await fs.mkdir(mount, { recursive: true }); await fs.mkdir(sourceRoot, { recursive: true }); await fs.mkdir(path.dirname(originalReceipt), { recursive: true });
  const inputs = {
    'app/fixture.mjs': Buffer.from('export const source = "current";\n'),
    'scripts/Apply-SourceUpdate.mjs': Buffer.from('export const update = true;\n'),
    'app/private-state.mjs': Buffer.from('export const privacy = true;\n'),
    'image/Volterra-Startup.cmd': Buffer.from('@echo off\r\necho Fixture only\r\n'),
    'PROJECT_BRIEF.md': Buffer.from('Nonsensitive fixture.\n'),
    [native[0]]: Buffer.from('Fixture facts native source'), [native[1]]: Buffer.from('Fixture private native source'), [native[2]]: Buffer.from('Fixture compiler source')
  };
  for (const name of Object.keys(approved)) inputs['design/approved-v1/' + name] = await fs.readFile(path.join(project, 'design/approved-v1', name));
  for (const [name, bytes] of Object.entries(inputs)) { const file = path.join(sourceRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx' }); }
  const repository = 'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock';
  const source = { version: 1, repository, commit: 'b'.repeat(40), source: sourceRoot, files: Object.fromEntries(Object.entries(inputs).map(([name, bytes]) => [name, hash(bytes)])), checksPassed: true };
  const original = { ...source, commit: 'a'.repeat(40), source: path.join(path.dirname(originalReceipt), 'source') };
  const originalBytes = Buffer.from(JSON.stringify(original, null, 2)), sourceBytes = Buffer.from(JSON.stringify(source, null, 2));
  await fs.writeFile(originalReceipt, originalBytes); await fs.writeFile(receiptFile, sourceBytes);
  const identity = { version: 2, kind: 'volterraFeatureImageCandidateV2', buildName: 'development-013', candidateId: cid, artifactRoot,
    sourceReceipt: originalReceipt, sourceReceiptSHA256: hash(originalBytes).toUpperCase(), sourceCommit: original.commit,
    inputKind: 'officialPredefinedWpfComposition', compositionReceipt: 'feature-composition.json', technicianStagingSHA256: sha,
    inputBindingSHA256: sha, initialImageReceiptSHA256: sha, initialBootSHA256: sha, initialInstallSHA256: sha, privateDevelopmentOnly: true,
    publicDistributionAllowed: false, bootAccepted: false, runtimeAccepted: false, recoveryAccepted: false, physicalHardwareAccepted: false, approvedVisualMatch: false, apiCompatibilityAccepted: false };
  const composition = { version: 1, kind: 'candidate013WpfCompositionCollected', status: 'feature-composition-collected-awaiting-file-overlay', candidateId: cid, artifactRoot,
    sourceCommit: original.commit, sourceReceiptSHA256: identity.sourceReceiptSHA256, inputBindingSHA256: sha, stagingReceiptSHA256: sha, initialImageReceiptSHA256: sha,
    technicianState: 'Off', technicianDisksDetached: true, sourceInputsUnchanged: true, completeGuestInputManifestMatched: true,
    packageInventoryBothExitZero: true, exactPackageAndVariantClosureVerified: true, driverFilesAndCatalogsVerified: true, runtime799FilesVerified: true,
    sourceApplicationOverlayPerformed: false, factsOverlayPerformed: false, existing006Written: false, canonical013Written: false, publicDistributionAllowed: false,
    bootAccepted: false, runtimeAccepted: false, recoveryAccepted: false, physicalHardwareAccepted: false, approvedVisualMatch: false, apiCompatibilityAccepted: false,
    images: ['boot', 'install'].map((kind, i) => ({ kind, path: path.join(artifactRoot, 'output', kind + '.wim'), index: 1, sourceIndex: i ? 1 : 2, bootIndex: 1,
      architecture: 'arm64', version: '10.0.26100.9549', SHA256: sha, bytes: 1700000000, genImageExitCode: 0, runtimeCopyExitCode: 3,
      packageInventoryExitCode: 0, driverInventoryExitCode: 0, driverAddExitCode: 0, driverForceUnsignedRequested: false, startupDriveCode: i ? 67 : 88,
      startupCurrentEqualsDefault: true, startupShellVerified: true, fontRegularAndVariableFilesVerified: true, verifiedFontFiles: fonts,
      packageInventorySHA256: sha, driverInventorySHA256: sha, fontMetadataSHA256: sha, payloadReadbackSHA256: sha,
      sourceInputsUnchanged: true, wholeWimUnchangedDuringReadonlyVerification: true, fontRegistrationAccepted: false, guestRenderAccepted: false })) };
  const compositionBytes = Buffer.from(JSON.stringify(composition)), compositionFile = path.join(artifactRoot, 'feature-composition.json');
  identity.compositionReceiptSHA256 = hash(compositionBytes).toUpperCase();
  const identityBytes = Buffer.from(JSON.stringify(identity)), identityFile = path.join(artifactRoot, 'candidate-identity.json');
  await fs.writeFile(identityFile, identityBytes); await fs.writeFile(compositionFile, compositionBytes);
  await fs.mkdir(path.join(workspace, 'private/tools'), { recursive: true });
  const binary = Buffer.from('Facts fixture bytes; never executed'), binaryPath = path.join(workspace, 'private/tools/volterra-facts.exe');
  const manifest = { version: 1, kind: 'volterraWindowsFactsBuild', sourceCommit: original.commit, sourceFile: native[0], sourceSHA256: source.files[native[0]],
    privateStateSourceFile: native[1], privateStateSourceSHA256: source.files[native[1]], buildScript: native[2], buildScriptSHA256: source.files[native[2]],
    executable: { file: 'private/tools/volterra-facts.exe', SHA256: hash(binary), bytes: binary.length, target: 'AnyCPU; ARM64 Windows CLR required' },
    compiler: { path: 'C:/Fixture/compiler.exe', SHA256: sha, fileVersion: 'Fixture' }, managementAssembly: { path: 'C:/Fixture/management.dll', SHA256: sha }, guestCompatibilityVerified: false };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)), manifestPath = path.join(workspace, 'private/tools/volterra-facts-build.json');
  await fs.writeFile(binaryPath, binary); await fs.writeFile(manifestPath, manifestBytes);
  const authorityFile = path.join(artifactRoot, 'application-overlay-source.json');
  const authority = { version: 1, kind: 'candidate013CheckedApplicationOverlayAuthority', status: 'reviewed-checked-source-transition', candidateId: cid, buildName: 'development-013', artifactRoot,
    originalCandidateIdentitySHA256: hash(identityBytes).toUpperCase(), compositionReceiptSHA256: hash(compositionBytes).toUpperCase(), originalInputBindingSHA256: sha,
    compositionSourceCommit: original.commit, compositionSourceReceipt: originalReceipt, compositionSourceReceiptSHA256: hash(originalBytes).toUpperCase(),
    applicationSourceCommit: source.commit, applicationSourceReceipt: receiptFile, applicationSourceReceiptSHA256: hash(sourceBytes).toUpperCase(),
    factsCompiledSourceCommit: manifest.sourceCommit, factsExecutableSHA256: hash(binary).toUpperCase(), factsProvenanceSHA256: hash(manifestBytes).toUpperCase(),
    factsNativeInputSHA256: Object.fromEntries(native.map(name => [name, source.files[name].toUpperCase()])), privateDevelopmentOnly: true, operationalAuthorityGranted: true,
    ...Object.fromEntries(noClaims.map(key => [key, false])) };
  const options = { workspace, mount, receiptFile, source, applicationOverlayAuthority: authorityFile, expectedApplicationOverlayAuthoritySHA256: '' };
  async function seal() { const bytes = Buffer.from(JSON.stringify(authority)); await fs.writeFile(authorityFile, bytes); options.expectedApplicationOverlayAuthoritySHA256 = hash(bytes).toUpperCase(); }
  await seal();
  const commands = [];
  const execute = async (command, args) => {
    commands.push(args); assert.equal(command, 'FixtureGitOnly'); assert.equal(args[0], '-C'); assert.equal(args[1], workspace);
    const vector = args.slice(2);
    if (JSON.stringify(vector) === JSON.stringify(['remote', 'get-url', 'origin'])) return Buffer.from('https://github.com/' + repository + '.git\n');
    if (vector[0] === 'cat-file' && vector[1] === '-e') return Buffer.alloc(0);
    if (vector[0] === 'merge-base' && vector[1] === '--is-ancestor') return Buffer.alloc(0);
    if (JSON.stringify(vector) === JSON.stringify(['ls-tree', '-r', '-z', source.commit])) return Buffer.from(Object.keys(inputs).map(name => '100644 blob ' + 'c'.repeat(40) + '\t' + name + '\0').join(''));
    if (vector[0] === 'show' && vector[1].startsWith(source.commit + ':')) { const name = vector[1].slice(41); assert.ok(Object.hasOwn(inputs, name)); return inputs[name]; }
    throw new Error('Unexpected process or Git command in an inert fixture.');
  };
  return { ...options, options, workspace, mount, receiptFile, source, original, originalReceipt, sourceBytes, originalBytes, identity, identityFile, identityBytes,
    composition, compositionFile, compositionBytes, authority, authorityFile, manifest, manifestPath, binary, binaryPath, seal, commands,
    copyOptions: { git: 'FixtureGitOnly', execute, check: async () => {} } };
}

test('one explicit sealed source layer admits new application source and preserves original composition and compiled facts identities', async t => {
  const f = await fixture(t), bound = await validateOfflineImageMount(f.options);
  assert.equal(bound.compositionSourceCommit, f.original.commit); assert.equal(bound.applicationSourceCommit, f.source.commit); assert.equal(bound.factsCompiledSourceCommit, f.original.commit);
  assert.equal(bound.applicationSourceAuthoritySHA256, f.options.expectedApplicationOverlayAuthoritySHA256);
  await assert.rejects(validateOfflineImageMount({ ...f.options, applicationOverlayAuthority: '', expectedApplicationOverlayAuthoritySHA256: '' }), /composition identity|source receipt/);
  assert.deepEqual(await fs.readFile(f.identityFile), f.identityBytes); assert.deepEqual(await fs.readFile(f.compositionFile), f.compositionBytes); assert.deepEqual(await fs.readFile(f.originalReceipt), f.originalBytes);
});
test('source copy and facts copy/verify use the layered boundary without vendor, private state or old-record writes', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.mount, 'Volterra/private/tools'), { recursive: true });
  const vendor = path.join(f.mount, 'Volterra/private/tools/vendor.exe'), account = path.join(f.mount, 'Volterra/private/auth.json');
  await fs.writeFile(vendor, 'Nonsensitive vendor fixture'); await fs.writeFile(account, 'Nonsensitive account fixture');
  const copied = await copyImagePayload(f.receiptFile, f.workspace, f.mount, { ...f.copyOptions, ...applicationOverlayOptions(f.authorityFile, f.options.expectedApplicationOverlayAuthoritySHA256) });
  assert.equal(copied.commit, f.source.commit); assert.equal(copied.compositionSourceCommit, f.original.commit); assert.equal(copied.compiledSourceCommit, f.original.commit);
  assert.ok(f.commands.length > 4); assert.equal(await fs.readFile(vendor, 'utf8'), 'Nonsensitive vendor fixture'); assert.equal(await fs.readFile(account, 'utf8'), 'Nonsensitive account fixture');
  const facts = await stageWindowsFacts({ ...f.options, verify: async () => f.source });
  const verified = await stageWindowsFacts({ ...f.options, verify: async () => f.source, mode: 'verify' });
  assert.equal(facts.sourceCommit, f.source.commit); assert.equal(facts.compiledSourceCommit, f.original.commit); assert.equal(facts.applicationSourceAuthoritySHA256, copied.applicationSourceAuthoritySHA256);
  assert.equal(verified.executableSHA256, facts.executableSHA256); assert.equal(facts.guestCompatibilityVerified, false);
  assert.deepEqual(await fs.readFile(path.join(f.mount, 'Volterra/private/tools/volterra-facts.exe')), f.binary);
  assert.deepEqual(await fs.readFile(f.identityFile), f.identityBytes); assert.deepEqual(await fs.readFile(f.compositionFile), f.compositionBytes); assert.deepEqual(await fs.readFile(f.originalReceipt), f.originalBytes);
});
test('sidecar field mutations refuse even when its new bytes have a matching explicit external seal', async t => {
  const f = await fixture(t), original = structuredClone(f.authority);
  for (const [key, value] of [['status', 'inert-proposal-requires-root-authority-construction'], ['operationalAuthorityGranted', false], ['candidateId', 'bad'],
    ['originalCandidateIdentitySHA256', 'B'.repeat(64)], ['compositionReceiptSHA256', 'B'.repeat(64)], ['originalInputBindingSHA256', 'B'.repeat(64)],
    ['applicationSourceReceiptSHA256', 'B'.repeat(64)], ['compositionSourceCommit', f.source.commit], ['applicationSourceCommit', f.original.commit],
    ['factsCompiledSourceCommit', f.source.commit], ['factsExecutableSHA256', 'B'.repeat(64)], ['factsProvenanceSHA256', 'B'.repeat(64)], ['privateDevelopmentOnly', 'true'],
    ...noClaims.map(key => [key, true])]) {
    Object.assign(f.authority, original, { [key]: value }); await f.seal(); await assert.rejects(validateOfflineImageMount(f.options));
  }
});
test('an overlay never bypasses the original v2 source, composition, package, driver or font admission gates', async t => {
  const f = await fixture(t);
  for (const [key, value] of [['technicianState', 'Running'], ['runtime799FilesVerified', false], ['exactPackageAndVariantClosureVerified', false], ['sourceApplicationOverlayPerformed', true]]) {
    await fs.writeFile(f.compositionFile, JSON.stringify({ ...f.composition, [key]: value })); await assert.rejects(validateOfflineImageMount(f.options));
  }
  await fs.writeFile(f.compositionFile, f.compositionBytes);
  await fs.writeFile(f.originalReceipt, JSON.stringify({ ...f.original, checksPassed: false })); await assert.rejects(validateOfflineImageMount(f.options));
  await fs.writeFile(f.originalReceipt, f.originalBytes);
  await fs.writeFile(f.identityFile, JSON.stringify({ ...f.identity, version: 1 })); await assert.rejects(validateOfflineImageMount(f.options), /only permitted for a v2/);
});
test('all three exact native build inputs and both actual facts byte seals must agree before source or facts writes', async t => {
  for (const file of native) {
    const f = await fixture(t); f.source.files[file] = 'd'.repeat(64); await fs.writeFile(f.receiptFile, JSON.stringify(f.source));
    await assert.rejects(stageWindowsFacts({ ...f.options, verify: async () => f.source }), /different native inputs/);
    assert.deepEqual(await fs.readdir(f.mount), []);
  }
  for (const target of ['binaryPath', 'manifestPath']) {
    const f = await fixture(t); await fs.writeFile(f[target], target === 'binaryPath' ? 'Changed fixture binary' : JSON.stringify({ ...f.manifest, guestCompatibilityVerified: true }));
    await assert.rejects(validateOfflineImageMount(f.options)); assert.deepEqual(await fs.readdir(f.mount), []);
  }
});
test('sidecar and facts inputs reject links, oversized files, wrong leaves and changes during a held bounded read', async t => {
  const f = await fixture(t), link = path.join(f.workspace, 'fixture-link');
  for (const file of [f.authorityFile, f.binaryPath, f.manifestPath]) {
    await fs.link(file, link); await assert.rejects(validateOfflineImageMount(f.options), /single-link/); await fs.unlink(link);
  }
  await assert.rejects(validateOfflineImageMount({ ...f.options, applicationOverlayAuthority: path.join(f.workspace, 'authority.json') }), /exact application overlay/);
  await fs.writeFile(f.authorityFile, ' '.repeat(131073)); await assert.rejects(validateOfflineImageMount(f.options), /JSON bounds/); await f.seal();
  const open = fs.open.bind(fs); let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const h = await open(...args); if (args[0] !== f.authorityFile) return h; const read = h.read.bind(h);
    h.read = async (...params) => { const result = await read(...params); if (!changed) { changed = true; await fs.writeFile(f.authorityFile, JSON.stringify({ ...f.authority, runtimeAccepted: true })); } return result; }; return h;
  });
  await assert.rejects(validateOfflineImageMount(f.options), /changed during reading/); assert.equal(changed, true); t.mock.restoreAll();
});
test('a current-source receipt outside snapshots or different from the independently verified value refuses', async t => {
  const f = await fixture(t), outside = path.join(f.workspace, 'source-receipt.json'); await fs.writeFile(outside, f.sourceBytes);
  await assert.rejects(validateOfflineImageMount({ ...f.options, receiptFile: outside }), /outside the owned snapshots/);
  await assert.rejects(validateOfflineImageMount({ ...f.options, source: { ...f.source, commit: 'c'.repeat(40) } }), /source receipt bytes/);
});
test('an original-source path outside snapshots is refused before that path is opened', async t => {
  const f = await fixture(t), forbidden = path.join(f.workspace, 'private/fixture-do-not-read.json');
  await fs.writeFile(f.identityFile, JSON.stringify({ ...f.identity, sourceReceipt: forbidden }));
  const open = fs.open.bind(fs); let opened = false;
  t.mock.method(fs, 'open', async (...args) => { if (args[0] === forbidden) opened = true; return open(...args); });
  await assert.rejects(validateOfflineImageMount(f.options), /outside the owned snapshots/); assert.equal(opened, false); t.mock.restoreAll();
});
test('strict overlay JSON cannot accept invalid UTF-8 even when an external hash seals those exact bytes', async t => {
  const f = await fixture(t), encoded = Buffer.from(JSON.stringify({ ...f.authority, fixtureExtra: 'VALUE' }));
  const index = encoded.indexOf(Buffer.from('VALUE')); assert.ok(index >= 0); encoded[index] = 0xff;
  await fs.writeFile(f.authorityFile, encoded); f.options.expectedApplicationOverlayAuthoritySHA256 = hash(encoded).toUpperCase();
  await assert.rejects(validateOfflineImageMount(f.options), /encoded data|encoding|UTF/i);
});
test('old CLI forms remain valid and the new pair is exact, complete, v2-only and cannot leak into prepare or verify', async t => {
  const f = await fixture(t), pair = [f.authorityFile, f.options.expectedApplicationOverlayAuthoritySHA256];
  assert.deepEqual(parseImageSourceArguments([]), { mode: 'prepare' });
  assert.equal(parseImageSourceArguments(['--verify', f.receiptFile]).mode, 'verify');
  assert.equal(parseImageSourceArguments(['--copy', f.receiptFile, f.mount]).mode, 'copy');
  assert.equal(parseImageSourceArguments(['--copy', f.receiptFile, f.mount, ...pair]).applicationOverlayAuthority, f.authorityFile);
  assert.equal(parseFactsArguments([f.receiptFile, f.workspace, f.mount]).mode, 'copy');
  assert.equal(parseFactsArguments([f.receiptFile, f.workspace, f.mount, 'verify', ...pair]).expectedApplicationOverlayAuthoritySHA256, pair[1]);
  for (const args of [['--copy', f.receiptFile, f.mount, pair[0]], ['--copy', f.receiptFile, f.mount, '', pair[1]], ['--copy', f.receiptFile, f.mount, ...pair, 'extra'], ['--verify', f.receiptFile, ...pair], ['unknown']]) assert.throws(() => parseImageSourceArguments(args));
  for (const args of [[f.receiptFile, f.workspace, f.mount, 'verify', pair[0]], [f.receiptFile, f.workspace, f.mount, 'bad', ...pair], [f.receiptFile, f.workspace, f.mount, 'copy', ...pair, 'extra']]) assert.throws(() => parseFactsArguments(args));
  for (const pair of [[null, null], ['relative.json', sha], [f.authorityFile, 'a'.repeat(64)], [f.authorityFile, ''], ['', sha]]) assert.throws(() => applicationOverlayOptions(...pair));
  const ordinary = path.join(f.workspace, 'build/development-013/final-boot'); await fs.mkdir(ordinary, { recursive: true });
  await assert.rejects(validateOfflineImageMount({ ...f.options, mount: ordinary }), /only permitted for a v2/);
});
