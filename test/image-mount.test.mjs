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
  for (const relative of ['build/current/final-boot', 'build/development-006/final-boot', 'build/development-013/final-install', 'build/development-900/final-boot']) {
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

async function featureFixture(t) {
 const f=await fixture(t), sha='A'.repeat(64);
 f.identity={version:2,kind:'volterraFeatureImageCandidateV2',buildName:'development-013',candidateId:id,artifactRoot:f.artifactRoot,sourceReceipt:f.receiptFile,sourceReceiptSHA256:f.identity.sourceReceiptSHA256,sourceCommit:f.source.commit,inputKind:'officialPredefinedWpfComposition',compositionReceipt:'feature-composition.json',technicianStagingSHA256:sha,inputBindingSHA256:sha,initialImageReceiptSHA256:sha,initialBootSHA256:sha,initialInstallSHA256:sha,privateDevelopmentOnly:true,publicDistributionAllowed:false,bootAccepted:false,runtimeAccepted:false,recoveryAccepted:false,physicalHardwareAccepted:false,approvedVisualMatch:false,apiCompatibilityAccepted:false};
 f.composition={version:1,kind:'candidate013WpfCompositionCollected',status:'feature-composition-collected-awaiting-file-overlay',candidateId:id,artifactRoot:f.artifactRoot,sourceCommit:f.source.commit,sourceReceiptSHA256:f.identity.sourceReceiptSHA256,inputBindingSHA256:sha,stagingReceiptSHA256:sha,initialImageReceiptSHA256:sha,technicianState:'Off',technicianDisksDetached:true,sourceInputsUnchanged:true,completeGuestInputManifestMatched:true,packageInventoryBothExitZero:true,exactPackageAndVariantClosureVerified:true,driverFilesAndCatalogsVerified:true,runtime799FilesVerified:true,sourceApplicationOverlayPerformed:false,factsOverlayPerformed:false,existing006Written:false,canonical013Written:false,publicDistributionAllowed:false,bootAccepted:false,runtimeAccepted:false,recoveryAccepted:false,physicalHardwareAccepted:false,approvedVisualMatch:false,apiCompatibilityAccepted:false,images:[]};
 for(const [i,kind] of ['boot','install'].entries())f.composition.images.push({kind,path:path.join(f.artifactRoot,'output',kind+'.wim'),index:1,sourceIndex:i===0?2:1,bootIndex:1,architecture:'arm64',version:'10.0.26100.9549',SHA256:sha,bytes:1700000000,genImageExitCode:0,runtimeCopyExitCode:3,packageInventoryExitCode:0,driverInventoryExitCode:0,driverAddExitCode:0,driverForceUnsignedRequested:false,startupDriveCode:i===0?88:67,startupCurrentEqualsDefault:true,startupShellVerified:true,fontRegularAndVariableFilesVerified:true,verifiedFontFiles:['segoeui.ttf','segoeuib.ttf','seguisb.ttf','segoeuil.ttf','segoeuisl.ttf','seguivar.ttf'],packageInventorySHA256:sha,driverInventorySHA256:sha,fontMetadataSHA256:sha,payloadReadbackSHA256:sha,sourceInputsUnchanged:true,wholeWimUnchangedDuringReadonlyVerification:true,fontRegistrationAccepted:false,guestRenderAccepted:false});
 f.compositionFile=path.join(f.artifactRoot,'feature-composition.json');
 f.seal=async()=>{const bytes=Buffer.from(JSON.stringify(f.composition));await fs.writeFile(f.compositionFile,bytes);f.identity.compositionReceiptSHA256=hash(bytes).toUpperCase();await fs.writeFile(f.identityFile,JSON.stringify(f.identity));};
 await f.seal();return f;
}
test('the actual boundary admits measured v2 composition separately from legacy006 identity',async t=>{
 const f=await featureFixture(t);const b=await validateOfflineImageMount(f);assert.equal(b.featureCompositionSHA256,f.identity.compositionReceiptSHA256);assert.equal(b.candidateId,id);
 const install=path.join(f.artifactRoot,'final-install');await fs.mkdir(install);assert.equal((await validateOfflineImageMount({...f,mount:install})).featureCompositionSHA256,b.featureCompositionSHA256);
});
test('a correctly hashed composition must still satisfy every measured scope gate',async t=>{
 const f=await featureFixture(t), original=structuredClone(f.composition);
 const changes=[['status','draft'],['technicianState','Running'],['sourceCommit','b'.repeat(40)],['candidateId','bad'],['technicianDisksDetached',false],['sourceInputsUnchanged',false],['runtime799FilesVerified',false],['exactPackageAndVariantClosureVerified',false],['driverFilesAndCatalogsVerified',false],['packageInventoryBothExitZero',false],['sourceApplicationOverlayPerformed',true],['existing006Written',true],['canonical013Written',true],['runtimeAccepted',true],['apiCompatibilityAccepted','false'],['initialImageReceiptSHA256','B'.repeat(64)]];
 for(const [key,value] of changes){f.composition=structuredClone(original);f.composition[key]=value;await f.seal();await assert.rejects(validateOfflineImageMount(f));}
});
test('v2 image readback requires both proper source indices, font/style scope and payload seals',async t=>{
 const f=await featureFixture(t),original=structuredClone(f.composition);
 for(const [key,value] of [['sourceIndex',1],['index',2],['architecture','amd64'],['genImageExitCode',1],['runtimeCopyExitCode',8],['driverForceUnsignedRequested',true],['startupDriveCode',67],['bytes','1700000000'],['startupShellVerified',false],['fontRegularAndVariableFilesVerified',false],['payloadReadbackSHA256','bad'],['wholeWimUnchangedDuringReadonlyVerification',false],['fontRegistrationAccepted',true],['guestRenderAccepted',true],['verifiedFontFiles',['seguisbi.ttf']]]){f.composition=structuredClone(original);f.composition.images[0][key]=value;await f.seal();await assert.rejects(validateOfflineImageMount(f));}
});
test('v2 cannot broaden version, receipt leaf, acceptance flags or the exact composition seal',async t=>{
 const f=await featureFixture(t),original=structuredClone(f.identity);
 for(const [key,value] of [['version','2'],['inputKind','base006'],['compositionReceipt','other.json'],['compositionReceiptSHA256','B'.repeat(64)],['technicianStagingSHA256','bad'],['privateDevelopmentOnly','true'],['approvedVisualMatch',true],['apiCompatibilityAccepted',true]]){await fs.writeFile(f.identityFile,JSON.stringify({...original,[key]:value}));await assert.rejects(validateOfflineImageMount(f));}
 await fs.writeFile(f.identityFile,JSON.stringify(original));await fs.unlink(f.compositionFile);await assert.rejects(validateOfflineImageMount(f));
});
test('v2 composition redirect, hardlink, oversized and mid-read replacement refuse before any payload access',async t=>{
 const f=await featureFixture(t),peer=path.join(f.workspace,'composition-link');await fs.link(f.compositionFile,peer);await assert.rejects(validateOfflineImageMount(f),/single-link/);await fs.unlink(peer);
 await fs.writeFile(f.compositionFile,' '.repeat(131073));await assert.rejects(validateOfflineImageMount(f),/JSON bounds/);await f.seal();
 const open=fs.open.bind(fs);let changed=false;t.mock.method(fs,'open',async(...args)=>{const h=await open(...args);if(args[0]!==f.compositionFile)return h;const read=h.read.bind(h);h.read=async(...parameters)=>{const r=await read(...parameters);if(!changed){changed=true;await fs.writeFile(f.compositionFile,JSON.stringify({...f.composition,status:'draft'}));}return r;};return h;});await assert.rejects(validateOfflineImageMount(f),/changed during reading/);assert.equal(changed,true);t.mock.restoreAll();
});
