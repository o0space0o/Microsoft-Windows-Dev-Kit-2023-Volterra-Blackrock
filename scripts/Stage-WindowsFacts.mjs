import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyImageSource } from '../app/image-source.mjs';
import { hash } from '../app/source-policy.mjs';
import { validateOfflineImageMount } from '../app/image-mount.mjs';

const sourceFile = 'scripts/Probe-WindowsFacts.cs';
const privateStateSourceFile = 'scripts/Private-WindowsState.cs';
const buildScript = 'scripts/Build-WindowsFacts.ps1';
const binaryFile = 'private/tools/volterra-facts.exe';
const manifestFile = 'private/tools/volterra-facts-build.json';
const samePath = (left, right) => path.relative(path.resolve(left), path.resolve(right)) === '';
const inside = (base, target) => { const relative = path.relative(base, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

async function checkedPath(base, target, { missing = false, writable = false, directory = false } = {}) {
  if (!inside(base, target)) throw new Error('A facts-tool path escaped its owned directory.');
  let current = base;
  for (const part of ['', ...path.relative(base, target).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (missing && error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !samePath(current, await fs.realpath(current))) throw new Error('A facts-tool path is redirected.');
    if (current !== target || directory) { if (!stat.isDirectory()) throw new Error('A facts-tool directory is not regular.'); }
    else if (!stat.isFile() || (writable && stat.nlink !== 1)) throw new Error('A facts-tool file is not regular or has multiple links.');
  }
  return target;
}

async function directory(base, target) {
  await checkedPath(base, target, { missing: true, directory: true });
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await checkedPath(base, current, { directory: true });
  }
}

async function readOwned(base, target, limit) {
  await checkedPath(base, target);
  const stat = await fs.lstat(target);
  if (stat.nlink !== 1 || stat.size > limit) throw new Error('A private facts input has multiple links or exceeds its size limit.');
  const bytes = await fs.readFile(target);
  if (bytes.length !== stat.size) throw new Error('A private facts input changed during reading.');
  return bytes;
}

export function validateFactsManifest(manifest, source, binary) {
  if (manifest?.version !== 1 || manifest.kind !== 'volterraWindowsFactsBuild' || !/^[a-f\d]{40}$/.test(manifest.sourceCommit || '') || manifest.sourceFile !== sourceFile || manifest.privateStateSourceFile !== privateStateSourceFile || manifest.buildScript !== buildScript || manifest.guestCompatibilityVerified !== false) throw new Error('The private facts provenance is not bound to this checked source.');
  // Retain the actual compiled commit. Reuse across source-only updates is
  // permitted solely when every original native/build input stays byte-identical.
  for (const [file, expected] of [[sourceFile, manifest.sourceSHA256], [privateStateSourceFile, manifest.privateStateSourceSHA256], [buildScript, manifest.buildScriptSHA256]]) {
    if (!/^[a-f\d]{64}$/i.test(expected || '') || source.files[file]?.toLowerCase() !== expected.toLowerCase()) throw new Error('Facts source or compiler-script hashes differ from the immutable source snapshot.');
  }
  if (manifest.executable?.file !== binaryFile || manifest.executable.SHA256?.toLowerCase() !== hash(binary) || manifest.executable.bytes !== binary.length || manifest.executable.target !== 'AnyCPU; ARM64 Windows CLR required') throw new Error('The facts executable differs from its source-bound provenance.');
  for (const input of [manifest.compiler, manifest.managementAssembly]) if (!input || typeof input.path !== 'string' || !/^[a-f\d]{64}$/i.test(input.SHA256 || '')) throw new Error('The facts compiler dependency provenance is incomplete.');
  if (typeof manifest.compiler.fileVersion !== 'string') throw new Error('The facts compiler version is missing.');
}

export async function stageWindowsFacts({ receiptFile, workspace, mount, mode = 'copy', verify = verifyImageSource }) {
  if (!['copy', 'verify'].includes(mode)) throw new Error('Choose copy or verify for the facts payload.');
  const source = await verify(receiptFile, workspace);
  const { root, mounted } = await validateOfflineImageMount({ workspace, mount, receiptFile, source });
  await checkedPath(root, mounted, { directory: true });
  const binaryPath = path.join(root, binaryFile), manifestPath = path.join(root, manifestFile);
  const binary = await readOwned(root, binaryPath, 4_000_000), manifestBytes = await readOwned(root, manifestPath, 64_000);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validateFactsManifest(manifest, source, binary);
  const files = { [binaryFile]: hash(binary), [manifestFile]: hash(manifestBytes) };
  const payload = path.join(mounted, 'Volterra');
  if (mode === 'copy') await directory(mounted, path.join(payload, 'private', 'tools'));
  for (const [file, bytes] of [[binaryFile, binary], [manifestFile, manifestBytes]]) {
    const destination = path.join(payload, file);
    if (mode === 'copy') {
      await checkedPath(mounted, destination, { missing: true, writable: true });
      const temporary = path.join(path.dirname(destination), `.volterra-facts-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await checkedPath(mounted, destination, { missing: true, writable: true });
        await fs.rename(temporary, destination);
      } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    }
    if (hash(await readOwned(mounted, destination, file === binaryFile ? 4_000_000 : 64_000)) !== files[file]) throw new Error('The persisted facts payload differs from its verified private input.');
  }
  if (hash(await readOwned(root, binaryPath, 4_000_000)) !== files[binaryFile] || hash(await readOwned(root, manifestPath, 64_000)) !== files[manifestFile]) throw new Error('The private facts inputs changed during offline image access.');
  return { version: 1, mode, sourceCommit: source.commit, compiledSourceCommit: manifest.sourceCommit, sourceFile, sourceSHA256: manifest.sourceSHA256, privateStateSourceFile, privateStateSourceSHA256: manifest.privateStateSourceSHA256, buildScript, buildScriptSHA256: manifest.buildScriptSHA256, executableSHA256: files[binaryFile], provenanceSHA256: files[manifestFile], bytes: binary.length, files, payloadBytesVerified: true, guestCompatibilityVerified: false, runtimeAccepted: false, physicalHardwareAccepted: false };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const [receiptFile, workspace, mount, mode, ...extra] = process.argv.slice(2);
  try { if (extra.length) throw new Error('Unsupported facts staging arguments.'); console.log(JSON.stringify(await stageWindowsFacts({ receiptFile, workspace, mount, mode }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
