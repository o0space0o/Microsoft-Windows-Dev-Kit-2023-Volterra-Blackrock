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

async function boundedJson(root, file) {
  await checkedPath(root, file, false);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 2n || before.size > 131072n) throw new Error('An offline image identity input exceeds its JSON bounds.');
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
    return { value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), SHA256: hash(bytes) };
  } finally { await handle.close(); }
}

// Both source and facts overlays use this boundary. A candidate is admitted by
// its existing creation identity and exact verified source receipt, never by a
// broader path regex alone. This function performs no mount or image operation.
export async function validateOfflineImageMount({ workspace, mount, receiptFile, source }) {
  const root = await fs.realpath(workspace), mounted = await fs.realpath(mount);
  if (!samePath(workspace, root) || !samePath(mount, mounted)) throw new Error('An offline image workspace or mount is redirected.');
  const relative = path.relative(root, mounted).split(path.sep).join('/');
  const ordinary = /^build\/development-[0-9]{3}\/final-(boot|install)$/.test(relative);
  const candidate = /^build\/verification\/media-candidate-development-013-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/final-(boot|install)$/.exec(relative);
  if (!ordinary && !candidate) throw new Error('Image payload target is not an exact owned offline build mount.');
  await checkedPath(root, mounted, true);
  if (ordinary) return { root, mounted, candidate: false };
  const candidateId = candidate[1], artifactRoot = path.dirname(mounted);
  if (candidateId === '00000000-0000-0000-0000-000000000000') throw new Error('A candidate mount requires a nonzero creation identity.');
  const identity = await boundedJson(root, path.join(artifactRoot, 'candidate-identity.json'));
  const value = identity.value;
  if (value?.version !== 1 || value.kind !== 'volterraImageCandidateV1' || value.buildName !== 'development-013' || value.candidateId !== candidateId
    || !exactPath(value.artifactRoot, artifactRoot) || !exactPath(value.baseArtifactRoot, path.join(root, 'build/development-006'))
    || !sha256(value.baseImageReceiptSHA256) || !sha256(value.baseBootSHA256) || !sha256(value.baseInstallSHA256)
    || value.privateDevelopmentOnly !== true || value.publicDistributionAllowed !== false || value.bootAccepted !== false || value.runtimeAccepted !== false || value.recoveryAccepted !== false || value.physicalHardwareAccepted !== false) throw new Error('The candidate mount creation identity differs.');
  if (typeof receiptFile !== 'string' || !exactPath(value.sourceReceipt, path.resolve(receiptFile))
    || !sha256(value.sourceReceiptSHA256) || value.sourceCommit !== source?.commit || source?.checksPassed !== true) throw new Error('The candidate mount is not bound to its verified source receipt.');
  const receiptRelative = path.relative(path.join(root, 'build/source-snapshots'), path.resolve(receiptFile));
  if (!receiptRelative || receiptRelative === '..' || receiptRelative.startsWith(`..${path.sep}`) || path.isAbsolute(receiptRelative)) throw new Error('The candidate source receipt is outside the owned snapshots.');
  const receipt = await boundedJson(root, path.resolve(receiptFile));
  if (receipt.SHA256 !== value.sourceReceiptSHA256.toLowerCase() || JSON.stringify(canonical(receipt.value)) !== JSON.stringify(canonical(source))) throw new Error('The candidate source receipt bytes differ from its creation identity.');
  return { root, mounted, candidate: true, candidateId, artifactRoot, candidateIdentitySHA256: identity.SHA256, sourceReceiptSHA256: receipt.SHA256 };
}
