import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkPath, readIsoBootPlan } from '../app/iso-boot-plan.mjs';
import { allowedSource } from '../app/source-policy.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const repository = 'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock';

async function inspectFile(root, file, json = false) {
  await checkPath(root, file);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < (json ? 2 : 1)
      || (json && before.size > 1_000_000)) throw new Error('Current media inputs must be bounded ordinary files.');
    const hash = createHash('sha256'), chunks = [];
    let length = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      length += chunk.length;
      if (length > before.size) throw new Error('Current media input changed during its read.');
      hash.update(chunk);
      if (json) chunks.push(chunk);
    }
    const after = await handle.stat(), current = await fs.lstat(file);
    if (length !== before.size || current.isSymbolicLink() || current.nlink !== 1
      || !unchanged(before, after) || !unchanged(after, current)) throw new Error('Current media input changed during its read.');
    await checkPath(root, file);
    return { file, sha256: hash.digest('hex'), bytes: length, metadata: after,
      ...(json ? { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, '')) } : {}) };
  } finally { await handle.close(); }
}

// This inspection validates the current files and source-receipt consistency.
// It does not start a VM or grant boot, runtime, hardware or recovery acceptance.
export async function readCurrentMedia(workspace) {
  const root = await fs.realpath(workspace), build = path.join(root, 'build', 'current');
  const iso = path.join(build, 'Microsoft Volterra.iso'), wim = path.join(build, 'Media', 'Sources', 'boot.wim');
  const receiptFile = path.join(build, 'image-receipt.json'), sourceReceiptFile = path.join(build, 'source-receipt.json');
  const receipt = await inspectFile(root, receiptFile, true), image = receipt.value;
  if (!image || image.version !== 1 || image.kind !== 'volterraCurrentLiveImage' || !same(image.iso, iso) || !same(image.wim, wim)
    || !validHash(image.isoSHA256) || !validHash(image.wimSHA256) || !Number.isSafeInteger(image.isoBytes) || image.isoBytes <= 0
    || !/^[a-f0-9]{40}$/.test(image.sourceCommit ?? '') || image.credentialsIncluded !== false) throw new Error('The current image receipt is invalid or does not select canonical current media.');
  const source = await inspectFile(root, sourceReceiptFile, true), value = source.value;
  if (!value || value.version !== 1 || value.repository !== repository || value.commit !== image.sourceCommit || value.checksPassed !== true
    || typeof value.source !== 'string' || !path.isAbsolute(value.source) || !value.files || typeof value.files !== 'object'
    || Array.isArray(value.files) || !Object.keys(value.files).length
    || Object.entries(value.files).some(([name, hash]) => !allowedSource(name) || !validHash(hash))) throw new Error('The current image and checked source receipt are inconsistent.');
  const actualIso = await inspectFile(root, iso), actualWim = await inspectFile(root, wim);
  if (actualIso.sha256 !== image.isoSHA256.toLowerCase() || actualIso.bytes !== image.isoBytes
    || actualWim.sha256 !== image.wimSHA256.toLowerCase()) throw new Error('The current ISO or WIM hash/size differs from its receipt.');
  // Re-read small receipts and recheck file identities after hashing both media
  // files, so an update cannot leave this inspection with a mixed selection.
  for (const previous of [receipt, source]) {
    if ((await inspectFile(root, previous.file, true)).sha256 !== previous.sha256) throw new Error('A current receipt changed during selection.');
  }
  for (const previous of [actualIso, actualWim]) {
    await checkPath(root, previous.file);
    if (!unchanged(previous.metadata, await fs.lstat(previous.file))) throw new Error('Current media changed during selection.');
  }
  return { kind: 'volterraCurrentMediaInspection', readOnly: true, buildName: 'current', build, phase: 'Inspect',
    iso, wim, isoSHA256: actualIso.sha256, isoBytes: actualIso.bytes, wimSHA256: actualWim.sha256, wimBytes: actualWim.bytes,
    receiptFile, imageReceiptSHA256: receipt.sha256, sourceReceiptFile, sourceReceiptSHA256: source.sha256,
    sourceCommit: image.sourceCommit, sourceBinding: 'receipt-consistent', bootAccepted: false, runtimeAccepted: false, physicalHardwareAccepted: false };
}

export async function readRequestedIsoPlan(workspace, buildName, phase) {
  if (buildName !== undefined && buildName !== null && buildName !== '') return readIsoBootPlan(workspace, buildName, phase ?? 'Prepare');
  if (phase !== undefined && phase !== 'Inspect') throw new Error('Only read-only Inspect can select current media implicitly; legacy VM phases require explicit BuildName.');
  return readCurrentMedia(workspace);
}
