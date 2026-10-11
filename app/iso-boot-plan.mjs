import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

export function isoBootPaths(workspace, buildName) {
  if (typeof buildName !== 'string' || !/^development-[0-9]{3}$/.test(buildName) || buildName.length !== 15) throw new Error('Invalid ISO test BuildName.');
  const build = path.resolve(workspace, 'build', buildName), owned = path.join(build, 'iso-test');
  const isoName = buildName === 'development-006' ? 'Microsoft-Volterra-development-arm64.iso' : `Microsoft-Volterra-${buildName}-arm64.iso`;
  return { buildName, build, owned, vmName: `Microsoft Volterra development ISO test ${buildName.slice(-3)}`,
    iso: path.join(build, isoName), receiptFile: path.join(build, 'iso-receipt.json'),
    identityFile: path.join(owned, 'identity.json'), data: path.join(owned, 'persistent.vhdx') };
}

// Refuse links in existing ancestors and leaves, including an output path that
// does not exist yet. Planning reads metadata; it never creates VM/image files.
export async function checkPath(base, target, directory = false) {
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ISO test path escaped the workspace.');
  let current = base;
  const parts = relative.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let info;
    try { info = await fs.lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const isDirectory = i < parts.length - 1 || directory;
    if (info.isSymbolicLink() || !samePath(await fs.realpath(current), current)
      || (isDirectory ? !info.isDirectory() : !info.isFile() || info.nlink > 1)) throw new Error(`Linked or unsupported ISO test path: ${current}`);
  }
}

async function readJson(base, file) {
  await checkPath(base, file);
  const bytes = await fs.readFile(file);
  return { value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), sha256: digest(bytes) };
}

async function hashIso(file) {
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat(), hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat(), current = await fs.stat(file);
    if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.ino !== after.ino || current.dev !== after.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw new Error('ISO changed while hashing.');
    return { sha256: hash.digest('hex'), bytes: after.size, metadata: after };
  } finally { await handle.close(); }
}

export function bindIsoReceipt(plan, receipt, actual, phase, identity, receiptSHA256) {
  if (!['Prepare', 'Inspect', 'Stop'].includes(phase)) throw new Error('Invalid ISO test phase.');
  if (!samePath(receipt.path, plan.iso) || receipt.architecture !== 'arm64' || receipt.privateDevelopmentOnly !== true
    || !/^[a-f0-9]{64}$/i.test(receipt.sha256 ?? '') || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0
    || receipt.sha256.toLowerCase() !== actual.sha256 || receipt.bytes !== actual.bytes) throw new Error('Selected ISO receipt, path, hash or size does not match.');
  const sourceCommit = receipt.sourceCommit ?? null;
  const legacy = plan.buildName === 'development-006' && phase !== 'Prepare' && sourceCommit === null
    && identity && identity.version === undefined && identity.sourceCommit === undefined;
  if (!legacy && (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(sourceCommit))) throw new Error('Selected ISO has no valid source commit binding.');
  if (phase !== 'Prepare') {
    if (!identity || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(identity.id ?? '') || identity.name !== plan.vmName
      || !samePath(identity.data, plan.data) || !samePath(identity.iso, plan.iso) || identity.isoSHA256?.toLowerCase() !== actual.sha256
      || identity.network !== false || identity.physicalDiskAttached !== false) throw new Error('Selected ISO test identity does not match its isolated paths.');
    if (!legacy && (identity.version !== 2 || identity.buildName !== plan.buildName || identity.sourceCommit !== sourceCommit
      || !samePath(identity.isoReceipt, plan.receiptFile) || identity.isoReceiptSHA256 !== receiptSHA256)) throw new Error('Selected ISO test identity source/receipt binding changed.');
  }
  return { ...plan, phase, isoSHA256: actual.sha256, isoBytes: actual.bytes, isoReceiptSHA256: receiptSHA256,
    sourceCommit, sourceBinding: legacy ? 'legacy-unbound' : 'bound', vmId: identity?.id ?? null,
    bootAccepted: false, runtimeAccepted: false };
}

export async function readIsoBootPlan(workspace, buildName, phase = 'Prepare') {
  if (!['Prepare', 'Inspect', 'Stop'].includes(phase)) throw new Error('Invalid ISO test phase.');
  const base = await fs.realpath(workspace), plan = isoBootPaths(base, buildName);
  for (const folder of [plan.build, plan.owned]) await checkPath(base, folder, true);
  const outputs = ['screen.png', 'screen.png.bmp', 'screen.png.error.txt', 'status.json', 'Prepare-result.json', 'Inspect-result.json', 'Stop-result.json'].map(file => path.join(plan.owned, file));
  for (const file of [plan.iso, plan.data, plan.identityFile, ...outputs]) await checkPath(base, file);
  const receipt = await readJson(base, plan.receiptFile);
  const identity = phase === 'Prepare' ? null : await readJson(base, plan.identityFile);
  const actual = await hashIso(plan.iso);
  const result = bindIsoReceipt(plan, receipt.value, actual, phase, identity?.value, receipt.sha256);
  if (phase === 'Prepare') {
    for (const file of [plan.data, plan.identityFile]) {
      try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('An existing ISO test disk or identity will not be replaced.');
    }
  }
  const checks = [[plan.receiptFile, receipt.sha256]];
  if (identity) checks.push([plan.identityFile, identity.sha256]);
  if (result.sourceBinding === 'bound') {
    const imageFile = path.join(plan.build, 'image-receipt.json'), finalFile = path.join(plan.build, 'Finalize-result.json');
    const image = await readJson(base, imageFile), final = await readJson(base, finalFile);
    if (image.value.helperBuild !== buildName || image.value.sourceCommit !== result.sourceCommit
      || final.value.status !== 'passed' || final.value.sourceCommit !== result.sourceCommit) throw new Error('ISO source commit differs from selected image/finalization receipts.');
    checks.push([imageFile, image.sha256], [finalFile, final.sha256]);
  }
  // A concurrent receipt edit must not produce a mixed selection.
  for (const [file, expected] of checks) if ((await readJson(base, file)).sha256 !== expected) throw new Error('ISO test receipt changed during selection.');
  for (const folder of [plan.build, plan.owned]) await checkPath(base, folder, true);
  for (const file of [plan.iso, plan.data, plan.identityFile, ...outputs]) await checkPath(base, file);
  const current = await fs.stat(plan.iso), hashed = actual.metadata;
  if (!current.isFile() || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => current[key] !== hashed[key])) throw new Error('ISO changed during receipt selection.');
  return result;
}
