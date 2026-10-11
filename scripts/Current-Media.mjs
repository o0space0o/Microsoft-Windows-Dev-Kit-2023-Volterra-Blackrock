import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkPath, isoBootPaths, readIsoBootPlan } from '../app/iso-boot-plan.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

// This private observed pointer selects media only; it grants no boot, runtime,
// installation, redistribution or recovery acceptance.
export async function readCurrentMedia(workspace) {
  const root = await fs.realpath(workspace), file = path.join(root, 'build', 'verification', 'single-current-media.json');
  await checkPath(root, file);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > 65536) throw new Error('Current media pointer must be one bounded ordinary file.');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    const after = await handle.stat(), current = await fs.lstat(file);
    if (offset !== before.size || current.isSymbolicLink() || current.nlink !== 1
      || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key] || after[key] !== current[key])) throw new Error('Current media pointer changed during its bounded read.');
    await checkPath(root, file);
    const raw = bytes.subarray(0, offset), value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/, ''));
    const expected = isoBootPaths(root, 'development-013');
    if (value.version !== 1 || value.kind !== 'Observed single current custom ISO' || value.customISOCount !== 1
      || value.currentBuild !== 'development-013' || !same(value.path, expected.iso)
      || !/^[a-f0-9]{40}$/.test(value.sourceCommit ?? '') || !/^[a-f0-9]{64}$/i.test(value.sha256 ?? '')
      || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) throw new Error('Only the explicit observed current013 media pointer is accepted.');
    return { buildName: value.currentBuild, path: expected.iso, sha256: value.sha256.toLowerCase(), bytes: value.bytes, sourceCommit: value.sourceCommit, pointer: file, pointerSHA256: sha(raw) };
  } finally { await handle.close(); }
}

export async function readRequestedIsoPlan(workspace, buildName, phase) {
  if (buildName !== undefined && buildName !== null && buildName !== '') return readIsoBootPlan(workspace, buildName, phase ?? 'Prepare');
  if (phase !== undefined && phase !== 'Inspect') throw new Error('Only read-only Inspect can select current media implicitly; other phases require explicit BuildName.');
  const current = await readCurrentMedia(workspace);
  const plan = await readIsoBootPlan(workspace, current.buildName, 'Inspect');
  if (!same(plan.iso, current.path) || plan.isoSHA256 !== current.sha256 || plan.isoBytes !== current.bytes || plan.sourceCommit !== current.sourceCommit) throw new Error('Current pointer differs from the independently verified ISO/source receipts.');
  const after = await readCurrentMedia(workspace);
  if (after.pointerSHA256 !== current.pointerSHA256) throw new Error('Current media pointer changed during selection.');
  return { ...plan, currentMediaPointerSHA256: current.pointerSHA256 };
}
