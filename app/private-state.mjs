import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const executeFile = promisify(execFile);
const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeFile = 'private/tools/volterra-facts.exe';
const manifestFile = 'private/tools/volterra-facts-build.json';
const privacySourceFile = 'scripts/Private-WindowsState.cs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
export const privateStateNotice = 'Private storage is not verified. Existing files are retained; sign-in and automatic work remain paused.';
const refused = () => new Error(privateStateNotice);
const sameWindowsPath = (left, right) => path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
const volumePattern = /^\\\\\?\\Volume\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}\\$/i;
const exactKeys = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function inspectWindowsPrivateState(value, { directory, scope, mode, volume, before, after }) {
  const keys = ['version', 'kind', 'status', 'observedAt', 'mode', 'scope', 'directory', 'volume', 'userSID', 'rootCreated', 'managedDirectoriesCreated', 'entriesChecked', 'allEntriesPrivate', 'rootDACLProtected', 'contentsRead', 'existingACLsChanged', 'privilegesChanged', 'errorClass', 'nativeCode'];
  if (!exactKeys(value, keys) || value.version !== 1 || value.kind !== 'windowsPrivateState' || value.status !== 'private' || value.mode !== mode || value.scope !== scope
    || typeof value.directory !== 'string' || !sameWindowsPath(value.directory, directory) || !volumePattern.test(value.volume) || (volume && value.volume.toLowerCase() !== volume.toLowerCase())
    || typeof value.userSID !== 'string' || !/^S-1-5-(?:\d+-){0,12}\d+$/.test(value.userSID) || value.userSID.length > 160
    || !Number.isFinite(before) || !Number.isFinite(after) || before > after || after - before > 30000
    || typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value.observedAt)
    || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) < before - 2000 || Date.parse(value.observedAt) > after + 2000
    || typeof value.rootCreated !== 'boolean' || (mode === 'verify' && value.rootCreated)
    || !Array.isArray(value.managedDirectoriesCreated) || value.managedDirectoriesCreated.length > 3 || new Set(value.managedDirectoriesCreated).size !== value.managedDirectoriesCreated.length
    || value.managedDirectoriesCreated.some(name => !['codex', 'github', 'browser'].includes(name)) || ((scope !== 'state' || mode === 'verify') && value.managedDirectoriesCreated.length)
    || !Number.isSafeInteger(value.entriesChecked) || value.entriesChecked < 1 || value.entriesChecked > 100000
    || value.allEntriesPrivate !== true || value.rootDACLProtected !== true || value.contentsRead !== false || value.existingACLsChanged !== false || value.privilegesChanged !== false
    || value.errorClass !== null || value.nativeCode !== 0) throw refused();
  return { status: 'private', windowsDACLVerified: true, sourceBoundNativeProof: true, currentTokenUserSID: value.userSID, entriesChecked: value.entriesChecked, directory, volume: value.volume, existingACLsChanged: false };
}

async function ordinary(file, { missing = false, directory = false } = {}) {
  const absolute = path.resolve(file);
  for (let cursor = absolute; ; cursor = path.dirname(cursor)) {
    let value;
    try { value = await fs.lstat(cursor); } catch (error) { if (missing && error.code === 'ENOENT') { if (cursor === path.dirname(cursor)) break; continue; } throw refused(); }
    if (value.isSymbolicLink() || path.relative(path.resolve(await fs.realpath(cursor)), cursor) !== '') throw refused();
    if (cursor === absolute && !directory) { if (!value.isFile() || value.nlink !== 1) throw refused(); }
    else if (!value.isDirectory()) throw refused();
    if (cursor === path.dirname(cursor)) break;
  }
  return absolute;
}
export async function readPrivateInput(file, maximum, { io = fs, guard = ordinary } = {}) {
  await guard(file);
  const handle = await io.open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!Number.isSafeInteger(maximum) || maximum < 1 || typeof before.size !== 'bigint' || !before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(maximum)) throw refused();
    const buffer = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < buffer.length) { const result = await handle.read(buffer, count, buffer.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
    const after = await handle.stat({ bigint: true }); const named = await io.lstat(file, { bigint: true });
    if (BigInt(count) !== before.size) throw refused();
    for (const key of ['dev', 'ino', 'size', 'nlink', 'birthtimeNs', 'ctimeNs', 'mtimeNs']) if (typeof before[key] !== 'bigint' || before[key] !== after[key] || after[key] !== named[key]) throw refused();
    await guard(file); return buffer.subarray(0, count);
  } finally { await handle.close(); }
}
async function nativeExecute(executable, args) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  try {
    const result = await executeFile(executable, args, { env, windowsHide: true, timeout: 20000, maxBuffer: 32768, encoding: 'utf8' });
    if (result.stderr.length || Buffer.byteLength(result.stdout, 'utf8') > 32768) throw refused();
    return result.stdout;
  } catch { throw refused(); }
}
export async function windowsPrivateState({ directory, volume = '', scope = 'state', create = false, root = applicationRoot, execute = nativeExecute, read = readPrivateInput, guard = ordinary, clock = Date.now }) {
  if (!['state', 'codex', 'github', 'browser'].includes(scope) || (volume && !volumePattern.test(volume)) || typeof directory !== 'string' || !path.win32.isAbsolute(directory)
    || /[\u0000-\u001f\u007f]/.test(directory) || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(directory) || /^[\\/]{2}(?!\?\\Volume\{)/.test(directory)) throw refused();
  const normalized = path.win32.normalize(directory);
  const sourceRelative = path.win32.relative(path.win32.resolve(root), normalized);
  if (!sourceRelative || (!sourceRelative.startsWith('..\\') && sourceRelative !== '..' && !path.win32.isAbsolute(sourceRelative))) throw refused();
  const files = [[nativeFile, 1048576], [manifestFile, 32768], ['private/source-version.json', 65536]];
  const inputs = [];
  for (const [relative, limit] of files) { const file = path.join(root, relative); await guard(file); inputs.push([file, await read(file, limit)]); }
  let manifest, version;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inputs[1][1]).replace(/^\uFEFF/, '')); version = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inputs[2][1]).replace(/^\uFEFF/, '')); } catch { throw refused(); }
  // A source update may reuse the recorded compiled commit only when all three
  // original native/build inputs still match their complete recorded hashes.
  // Changing a native input requires a separately built, source-bound helper.
  if (manifest.version !== 1 || manifest.kind !== 'volterraWindowsFactsBuild' || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || !/^[a-f0-9]{40}$/.test(version.commit || '')
    || version.repository !== 'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock' || manifest.sourceFile !== 'scripts/Probe-WindowsFacts.cs' || manifest.buildScript !== 'scripts/Build-WindowsFacts.ps1'
    || manifest.privateStateSourceFile !== privacySourceFile || !/^[A-F0-9]{64}$/.test(manifest.privateStateSourceSHA256 || '')
    || manifest.executable?.file !== nativeFile || manifest.executable.bytes !== inputs[0][1].length || manifest.executable.SHA256 !== digest(inputs[0][1])) throw refused();
  for (const [relative, expected] of [[manifest.sourceFile, manifest.sourceSHA256], [manifest.buildScript, manifest.buildScriptSHA256], [privacySourceFile, manifest.privateStateSourceSHA256]]) {
    if (!/^[A-F0-9]{64}$/.test(expected || '')) throw refused(); const file = path.join(root, relative); await guard(file); const bytes = await read(file, 1048576); if (digest(bytes) !== expected) throw refused(); inputs.push([file, bytes]);
  }
  await guard(normalized, { directory: true, missing: create });
  const mode = create ? 'create' : 'verify', before = clock();
  const output = await execute(inputs[0][0], ['--private-state', mode, scope, normalized, volume || '-']); const after = clock();
  await guard(normalized, { directory: true });
  for (const [file, bytes] of inputs) { await guard(file); if (digest(await read(file, 1048576)) !== digest(bytes)) throw refused(); }
  let value; try { value = JSON.parse(output); } catch { throw refused(); }
  return inspectWindowsPrivateState(value, { directory: normalized, scope, mode, volume, before, after });
}

export async function ensurePrivateState({ directory, volume = '', scope = 'state', create = false, root = applicationRoot, platform = process.platform, windows = windowsPrivateState } = {}) {
  if (!directory) throw refused();
  if (platform === 'win32') {
    // Browser/database startup and atomic state writes can replace a child
    // between metadata enumeration and inspection. Repeat the complete proof;
    // never treat a refused attempt as verified or change an existing ACL.
    for (let attempt = 0; ; attempt++) {
      try { return await windows({ directory, volume, scope, create, root }); }
      catch (error) { if (attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 150)); }
    }
  }
  // POSIX tests/hosts use filesystem mode protection; this is never a Windows
  // DACL claim. Existing objects are observed rather than permission-reset.
  if (create) { try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw refused(); } }
  await ordinary(directory, { directory: true }); const stat = await fs.lstat(directory);
  if ((stat.mode & 0o077) !== 0) throw refused();
  return { status: 'private', windowsDACLVerified: false, sourceBoundNativeProof: false, directory, existingACLsChanged: false };
}
export function managedAccountDirectory(kind, { env = process.env, home = os.homedir() } = {}) {
  if (kind === 'codex') return env.CODEX_HOME || path.join(home, '.codex');
  if (kind === 'github') return env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'gh') : env.APPDATA ? path.join(env.APPDATA, 'GitHubCLI') : path.join(home, '.config', 'gh'));
  throw refused();
}
