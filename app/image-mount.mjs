import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from './source-policy.mjs';

const samePath = (left, right) => path.relative(path.resolve(left), path.resolve(right)) === '';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha256 = value => typeof value === 'string' && /^[A-F0-9]{64}$/.test(value);
const exactPath = (value, expected) => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && samePath(value, expected);

async function checkedPath(root, target, directory) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('An offline image path escaped its workspace.');
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !samePath(current, await fs.realpath(current))) throw new Error('An offline image path is redirected.');
    if (current !== target || directory) {
      if (!info.isDirectory()) throw new Error('An offline image directory is not regular.');
    } else if (!info.isFile() || info.nlink !== 1) throw new Error('An offline image identity input is not an ordinary single-link file.');
  }
}

async function boundedBytes(root, file, limit = 131072) {
  await checkedPath(root, file, false);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 2n || before.size > BigInt(limit)) throw new Error('An offline image identity input exceeds its JSON bounds.');
    async function readBytes() {
      const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (BigInt(length) !== before.size) throw new Error('An offline image identity input changed during reading.');
      return buffer.subarray(0, length);
    }
    const bytes = await readBytes(), repeated = await readBytes();
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true });
    if (!bytes.equals(repeated) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some(key => before[key] !== after[key] || after[key] !== current[key])) throw new Error('An offline image identity input changed during reading.');
    await checkedPath(root, file, false);
    return { bytes, SHA256: hash(bytes) };
  } finally { await handle.close(); }
}
async function boundedJson(root, file, limit = 131072, strict = false) {
  const record = await boundedBytes(root, file, limit);
  const text = strict ? new TextDecoder('utf-8', { fatal: true }).decode(record.bytes) : record.bytes.toString('utf8');
  return { ...record, value: JSON.parse(text.replace(/^\uFEFF/, '')) };
}

const nativeInputs = ['scripts/Probe-WindowsFacts.cs', 'scripts/Private-WindowsState.cs', 'scripts/Build-WindowsFacts.ps1'];
const overlayNoClaims = ['sourceApplicationOverlayPerformed', 'factsOverlayPerformed', 'originalCandidateIdentityWritten', 'compositionReceiptWritten', 'originalInputPlanWritten', 'existing006Written', 'canonical013Written', 'currentPointerWritten', 'bootAccepted', 'runtimeAccepted', 'apiCompatibilityAccepted', 'recoveryAccepted', 'physicalHardwareAccepted', 'approvedVisualMatch', 'publicDistributionAllowed'];
export function applicationOverlayOptions(authority = '', SHA256 = '') {
  if (authority === '' && SHA256 === '') return {};
  if (typeof authority !== 'string' || !authority || !path.isAbsolute(authority) || path.normalize(authority) !== authority || !sha256(SHA256)) throw new Error('An application overlay requires an exact authority path and its explicit uppercase SHA256.');
  return { applicationOverlayAuthority: authority, expectedApplicationOverlayAuthoritySHA256: SHA256 };
}
async function checkedReceipt(root, receiptFile, expectedSHA256, source, strict = false) {
  const relative = path.relative(path.join(root, 'build/source-snapshots'), receiptFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('The candidate source receipt is outside the owned snapshots.');
  const record = await boundedJson(root, receiptFile, 131072, strict);
  if ((expectedSHA256 && record.SHA256 !== expectedSHA256.toLowerCase()) || (source && JSON.stringify(canonical(record.value)) !== JSON.stringify(canonical(source)))) throw new Error('The candidate source receipt bytes differ from its creation identity.');
  return record;
}
async function assertApplicationOverlay(root, artifactRoot, candidateId, identity, composition, original, receipt, source, options) {
  if (!exactPath(options.applicationOverlayAuthority, path.join(artifactRoot, 'application-overlay-source.json'))) throw new Error('Only the exact application overlay authority leaf is permitted.');
  const authority = await boundedJson(root, options.applicationOverlayAuthority, 131072, true);
  if (authority.SHA256.toUpperCase() !== options.expectedApplicationOverlayAuthoritySHA256) throw new Error('The application overlay authority bytes differ from their external seal.');
  const facts = await boundedJson(root, path.join(root, 'private/tools/volterra-facts-build.json'), 64000, true);
  const binary = await boundedBytes(root, path.join(root, 'private/tools/volterra-facts.exe'), 4000000), manifest = facts.value;
  if (manifest?.version !== 1 || manifest.kind !== 'volterraWindowsFactsBuild' || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '') || manifest.sourceFile !== nativeInputs[0] || manifest.privateStateSourceFile !== nativeInputs[1] || manifest.buildScript !== nativeInputs[2] || manifest.guestCompatibilityVerified !== false) throw new Error('An overlay requires the preserved actual facts build provenance.');
  for (const [file, key] of [[nativeInputs[0], 'sourceSHA256'], [nativeInputs[1], 'privateStateSourceSHA256'], [nativeInputs[2], 'buildScriptSHA256']]) {
    if (!/^[a-f0-9]{64}$/i.test(manifest[key] || '') || source.files?.[file]?.toUpperCase() !== manifest[key].toUpperCase()) throw new Error('Application overlay cannot reuse facts built from different native inputs.');
  }
  if (manifest.executable?.file !== 'private/tools/volterra-facts.exe' || manifest.executable.SHA256?.toLowerCase() !== binary.SHA256 || manifest.executable.bytes !== binary.bytes.length || manifest.executable.target !== 'AnyCPU; ARM64 Windows CLR required') throw new Error('The application overlay facts executable differs from its preserved manifest.');
  for (const item of [manifest.compiler, manifest.managementAssembly]) if (typeof item?.path !== 'string' || !/^[a-f0-9]{64}$/i.test(item.SHA256 || '')) throw new Error('Facts dependency provenance is incomplete.');
  if (typeof manifest.compiler.fileVersion !== 'string' || source.commit === original.value.commit || receipt.SHA256 === original.SHA256) throw new Error('An application transition requires a distinct checked source and complete facts provenance.');
  const wanted = { version: 1, kind: 'candidate013CheckedApplicationOverlayAuthority', status: 'reviewed-checked-source-transition', candidateId, buildName: 'development-013', artifactRoot,
    originalCandidateIdentitySHA256: identity.SHA256.toUpperCase(), compositionReceiptSHA256: composition.SHA256.toUpperCase(), originalInputBindingSHA256: identity.value.inputBindingSHA256,
    compositionSourceCommit: original.value.commit, compositionSourceReceipt: identity.value.sourceReceipt, compositionSourceReceiptSHA256: original.SHA256.toUpperCase(),
    applicationSourceCommit: source.commit, applicationSourceReceipt: receipt.path, applicationSourceReceiptSHA256: receipt.SHA256.toUpperCase(),
    factsCompiledSourceCommit: manifest.sourceCommit, factsExecutableSHA256: binary.SHA256.toUpperCase(), factsProvenanceSHA256: facts.SHA256.toUpperCase(),
    factsNativeInputSHA256: Object.fromEntries(nativeInputs.map(file => [file, source.files[file].toUpperCase()])), privateDevelopmentOnly: true, operationalAuthorityGranted: true,
    ...Object.fromEntries(overlayNoClaims.map(key => [key, false])) };
  for (const [key, expected] of Object.entries(wanted)) if (key === 'factsNativeInputSHA256' ? JSON.stringify(canonical(authority.value[key])) !== JSON.stringify(canonical(expected)) : authority.value[key] !== expected) throw new Error('The checked application transition differs: ' + key);
  return { applicationSourceAuthoritySHA256: authority.SHA256.toUpperCase(), compositionSourceCommit: original.value.commit, applicationSourceCommit: source.commit, factsCompiledSourceCommit: manifest.sourceCommit, factsExecutableSHA256: binary.SHA256.toUpperCase(), factsProvenanceSHA256: facts.SHA256.toUpperCase() };
}

// Pure admission declarations for the proposed public boundary; no entrypoint.
const fonts = ['segoeui.ttf','segoeuib.ttf','seguisb.ttf','segoeuil.ttf','segoeuisl.ttf','seguivar.ttf'];
const seal = value => typeof value === 'string' && /^[A-F0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value);
function assertFeatureCandidate(value, proof, context) {
  const { candidateId, artifactRoot, source, exactPath, imagePath, compositionSHA256 } = context;
  if (value?.version !== 2 || value.kind !== 'volterraFeatureImageCandidateV2' || value.inputKind !== 'officialPredefinedWpfComposition'
    || value.buildName !== 'development-013' || value.candidateId !== candidateId || !exactPath(value.artifactRoot, artifactRoot)
    || value.sourceCommit !== source?.commit || value.compositionReceipt !== 'feature-composition.json'
    || value.compositionReceiptSHA256 !== compositionSHA256) throw new Error('The exact v2 composition identity differs.');
  for (const key of ['privateDevelopmentOnly','publicDistributionAllowed','bootAccepted','runtimeAccepted','recoveryAccepted','physicalHardwareAccepted','approvedVisualMatch','apiCompatibilityAccepted']) {
    if (value[key] !== (key === 'privateDevelopmentOnly')) throw new Error('The v2 candidate cannot imply acceptance.');
  }
  for (const key of ['compositionReceiptSHA256','technicianStagingSHA256','inputBindingSHA256','initialImageReceiptSHA256','initialBootSHA256','initialInstallSHA256']) {
    if (!seal(value[key])) throw new Error('A v2 identity input seal differs.');
  }
  if (proof?.version !== 1 || proof.kind !== 'candidate013WpfCompositionCollected' || proof.status !== 'feature-composition-collected-awaiting-file-overlay'
    || proof.candidateId !== candidateId || !exactPath(proof.artifactRoot, artifactRoot) || proof.sourceCommit !== source.commit
    || proof.sourceReceiptSHA256 !== value.sourceReceiptSHA256 || proof.inputBindingSHA256 !== value.inputBindingSHA256
    || proof.stagingReceiptSHA256 !== value.technicianStagingSHA256 || proof.initialImageReceiptSHA256 !== value.initialImageReceiptSHA256
    || proof.technicianState !== 'Off') throw new Error('The exact v2 measured composition authority differs.');
  for (const key of ['technicianDisksDetached','sourceInputsUnchanged','completeGuestInputManifestMatched','packageInventoryBothExitZero','exactPackageAndVariantClosureVerified','driverFilesAndCatalogsVerified','runtime799FilesVerified']) {
    if (proof[key] !== true) throw new Error('Actual v2 composition readback is required.');
  }
  for (const key of ['sourceApplicationOverlayPerformed','factsOverlayPerformed','existing006Written','canonical013Written','publicDistributionAllowed','bootAccepted','runtimeAccepted','recoveryAccepted','physicalHardwareAccepted','approvedVisualMatch','apiCompatibilityAccepted']) {
    if (proof[key] !== false) throw new Error('Composition cannot imply an overlay or acceptance.');
  }
  if (!Array.isArray(proof.images) || proof.images.length !== 2) throw new Error('Only exact boot/install composition images are permitted.');
  for (let i=0;i<2;i++) {
    const kind=i===0?'boot':'install', image=proof.images[i];
    const expectedSHA=i===0?value.initialBootSHA256:value.initialInstallSHA256;
    for (const key of ['index','sourceIndex','bootIndex','genImageExitCode','runtimeCopyExitCode','packageInventoryExitCode','driverInventoryExitCode','driverAddExitCode','startupDriveCode','bytes']) {
      if (!integer(image?.[key])) throw new Error('Measured v2 image numeric facts must be integers.');
    }
    if (image.kind !== kind || !exactPath(image.path, imagePath(kind)) || image.index !== 1 || image.sourceIndex !== (i===0?2:1)
      || (i===0?image.bootIndex!==1:![0,1].includes(image.bootIndex)) || image.architecture !== 'arm64' || image.version !== '10.0.26100.9549'
      || image.SHA256 !== expectedSHA || image.bytes <= 281080081 || image.genImageExitCode !== 0 || image.runtimeCopyExitCode < 0 || image.runtimeCopyExitCode > 7
      || image.packageInventoryExitCode !== 0 || image.driverInventoryExitCode !== 0 || image.driverAddExitCode !== 0 || image.driverForceUnsignedRequested !== false
      || image.startupDriveCode !== (i===0?88:67)) throw new Error('Measured v2 image source, output or startup differs.');
    for (const key of ['startupCurrentEqualsDefault','startupShellVerified','fontRegularAndVariableFilesVerified','sourceInputsUnchanged','wholeWimUnchangedDuringReadonlyVerification']) {
      if (image[key] !== true) throw new Error('Actual composed startup, font and readonly preservation proof is required.');
    }
    if (image.fontRegistrationAccepted !== false || image.guestRenderAccepted !== false || JSON.stringify(image.verifiedFontFiles) !== JSON.stringify(fonts)) throw new Error('Font readback cannot grant guest rendering or registration.');
    for (const key of ['packageInventorySHA256','driverInventorySHA256','fontMetadataSHA256','payloadReadbackSHA256']) {
      if (!seal(image[key])) throw new Error('Collected v2 image readback seals differ.');
    }
  }
}

// Both source and facts overlays use this boundary. A candidate is admitted by
// its existing creation identity and exact verified source receipt, never by a
// broader path regex alone. This function performs no mount or image operation.
export async function validateOfflineImageMount({ workspace, mount, receiptFile, source, applicationOverlayAuthority = '', expectedApplicationOverlayAuthoritySHA256 = '' }) {
  const overlay = applicationOverlayOptions(applicationOverlayAuthority, expectedApplicationOverlayAuthoritySHA256);
  const root = await fs.realpath(workspace), mounted = await fs.realpath(mount);
  if (!samePath(workspace, root) || !samePath(mount, mounted)) throw new Error('An offline image workspace or mount is redirected.');
  const relative = path.relative(root, mounted).split(path.sep).join('/');
  const ordinary = /^build\/(?:current|development-[0-9]{3})\/final-(boot|install)$/.test(relative);
  const candidate = /^build\/verification\/media-candidate-development-013-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/final-(boot|install)$/.exec(relative);
  if (!ordinary && !candidate) throw new Error('Image payload target is not an exact owned offline build mount.');
  await checkedPath(root, mounted, true);
  if (ordinary) { if (overlay.applicationOverlayAuthority) throw new Error('Application transition authority is only permitted for a v2 candidate.'); return { root, mounted, candidate: false }; }
  const candidateId = candidate[1], artifactRoot = path.dirname(mounted);
  if (candidateId === '00000000-0000-0000-0000-000000000000') throw new Error('A candidate mount requires a nonzero creation identity.');
  const identity = await boundedJson(root, path.join(artifactRoot, 'candidate-identity.json'));
  const value = identity.value;
  let featureCompositionSHA256, compositionRecord, original, applicationBinding;
  if (value?.version === 2) {
    const composition = await boundedJson(root, path.join(artifactRoot, 'feature-composition.json'));
    compositionRecord = composition;
    featureCompositionSHA256 = composition.SHA256.toUpperCase();
    let compositionSource = source;
    if (overlay.applicationOverlayAuthority) {
      if (typeof value.sourceReceipt !== 'string' || !exactPath(value.sourceReceipt, path.resolve(value.sourceReceipt)) || !sha256(value.sourceReceiptSHA256)) throw new Error('Original v2 source receipt identity differs.');
      original = await checkedReceipt(root, value.sourceReceipt, value.sourceReceiptSHA256, undefined, true);
      if (original.value?.version !== 1 || original.value.checksPassed !== true || original.value.commit !== value.sourceCommit || !original.value.files || typeof original.value.files !== 'object' || Array.isArray(original.value.files)) throw new Error('Original checked composition source receipt is invalid.');
      compositionSource = original.value;
    }
    assertFeatureCandidate(value, composition.value, { candidateId, artifactRoot, source: compositionSource, exactPath,
      imagePath: kind => path.join(artifactRoot, 'output', kind+'.wim'), compositionSHA256: featureCompositionSHA256 });
  } else {
  if (overlay.applicationOverlayAuthority) throw new Error('Application transition authority is only permitted for a v2 candidate.');
  if (value?.version !== 1 || value.kind !== 'volterraImageCandidateV1' || value.buildName !== 'development-013' || value.candidateId !== candidateId
    || !exactPath(value.artifactRoot, artifactRoot) || !exactPath(value.baseArtifactRoot, path.join(root, 'build/development-006'))
    || !sha256(value.baseImageReceiptSHA256) || !sha256(value.baseBootSHA256) || !sha256(value.baseInstallSHA256)
    || value.privateDevelopmentOnly !== true || value.publicDistributionAllowed !== false || value.bootAccepted !== false || value.runtimeAccepted !== false || value.recoveryAccepted !== false || value.physicalHardwareAccepted !== false) throw new Error('The candidate mount creation identity differs.');
  }
  if (typeof receiptFile !== 'string' || !exactPath(receiptFile, path.resolve(receiptFile)) || source?.checksPassed !== true) throw new Error('The overlay source must be a separately verified exact source receipt.');
  if (overlay.applicationOverlayAuthority) {
    if (source.version !== 1 || !/^[a-f0-9]{40}$/.test(source.commit || '') || !source.files || typeof source.files !== 'object' || Array.isArray(source.files)) throw new Error('The application source receipt is invalid.');
    // Its original serialization is sealed by the external sidecar below.
    const receipt = await checkedReceipt(root, receiptFile, undefined, source, true);
    receipt.path = receiptFile;
    applicationBinding = await assertApplicationOverlay(root, artifactRoot, candidateId, identity, compositionRecord, original, receipt, source, overlay);
    return { root, mounted, candidate: true, candidateId, artifactRoot, candidateIdentitySHA256: identity.SHA256, sourceReceiptSHA256: receipt.SHA256, featureCompositionSHA256, ...applicationBinding };
  }
  if (!exactPath(value.sourceReceipt, path.resolve(receiptFile))
    || !sha256(value.sourceReceiptSHA256) || value.sourceCommit !== source?.commit || source?.checksPassed !== true) throw new Error('The candidate mount is not bound to its verified source receipt.');
  const receipt = await checkedReceipt(root, path.resolve(receiptFile), value.sourceReceiptSHA256, source);
  return { root, mounted, candidate: true, candidateId, artifactRoot, candidateIdentitySHA256: identity.SHA256, sourceReceiptSHA256: receipt.SHA256, ...(featureCompositionSHA256 ? { featureCompositionSHA256 } : {}) };
}
