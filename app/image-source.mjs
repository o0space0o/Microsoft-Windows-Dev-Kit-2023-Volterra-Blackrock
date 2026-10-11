import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { allowedSource, validateSource, hash } from './source-policy.mjs';

const repository = 'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock';
const inside = (base, target) => { const relative = path.relative(base, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
function committedFiles(records) {
  return records.toString('utf8').split('\0').filter(Boolean).map(record => {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(record);
    if (!match || !allowedSource(match[2])) throw new Error('The source commit contains an excluded file or link.');
    return match[2];
  });
}
async function checkSnapshot(source, owned, git, execute) {
  await execute(process.execPath, [path.join(source, 'scripts', 'Check-Source.mjs'), source], {
    cwd: source, env: { ...process.env, VOLTERRA_GIT_PATH: git, VOLTERRA_AUTOSTART: '0', VOLTERRA_OS_ROOT: '', VOLTERRA_STATE_DIR: path.join(owned, 'check-state') }
  });
}
export function executeBytes(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    const chunks = []; let length = 0, error = '';
    child.stdout.on('data', bytes => { length += bytes.length; if (length > 8_000_000) child.kill(); else chunks.push(bytes); });
    child.stderr.on('data', bytes => { error = (error + bytes.toString()).slice(-2000); });
    child.once('error', reject);
    child.once('close', code => code === 0 && length <= 8_000_000 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Source preparation command failed (${code}): ${error}`)));
  });
}

// Read committed Git objects, never the folder the live agent is editing.
export async function prepareImageSource({ directory, git = process.env.VOLTERRA_GIT_PATH || 'git', execute = executeBytes, check } = {}) {
  const workspace = await fs.realpath(directory);
  const command = (...args) => execute(git, ['-C', workspace, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const text = async (...args) => (await command(...args)).toString('utf8').trim();
  if (await text('remote', 'get-url', 'origin') !== `https://github.com/${repository}.git` || await text('branch', '--show-current') !== 'main') throw new Error('Image source must belong to the configured repository on main.');
  if (await text('status', '--porcelain')) throw new Error('Checkpoint and publish source changes before preparing an image.');
  const commit = await text('rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(commit) || (await text('ls-remote', '--exit-code', 'origin', 'refs/heads/main')).split(/\s+/)[0] !== commit) throw new Error('The image source commit must be the currently published GitHub main.');
  const files = committedFiles(await command('ls-tree', '-r', '-z', commit));
  const build = path.join(workspace, 'build'); await fs.mkdir(build, { recursive: true });
  if (!inside(workspace, await fs.realpath(build))) throw new Error('The build directory escaped this workspace.');
  const snapshots = path.join(build, 'source-snapshots');
  await fs.mkdir(snapshots, { recursive: true });
  if (!inside(workspace, await fs.realpath(snapshots))) throw new Error('The source snapshot directory escaped this workspace.');
  const owned = path.join(snapshots, `${commit.slice(0, 12)}-${randomUUID()}`), source = path.join(owned, 'source');
  await fs.mkdir(source, { recursive: true });
  for (const file of files) {
    const bytes = await command('show', `${commit}:${file}`);
    if (bytes.length > 3_000_000) throw new Error('An image source file exceeds the public source limit.');
    const target = path.join(source, file); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
  }
  const hashes = await validateSource(source, files);
  if (Object.values(hashes).some(value => value === null)) throw new Error('A committed source file is missing.');
  if (check) await check(source);
  else await checkSnapshot(source, owned, git, execute);
  const after = await validateSource(source, files);
  if (JSON.stringify(after) !== JSON.stringify(hashes)) throw new Error('Source changed during the snapshot checks.');
  if (await text('rev-parse', 'HEAD') !== commit || await text('status', '--porcelain')) throw new Error('The working source changed during preparation. Keep this private snapshot and prepare again after publication.');
  const receipt = { version: 1, repository, commit, source, files: hashes, checksPassed: true, createdAt: new Date().toISOString() };
  const receiptFile = path.join(owned, 'source-receipt.json');
  await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return { receiptFile, ...receipt };
}

export async function verifyImageSource(receiptFile, workspace, { git = process.env.VOLTERRA_GIT_PATH || 'git', execute = executeBytes, check } = {}) {
  const root = await fs.realpath(workspace), snapshots = await fs.realpath(path.join(root, 'build', 'source-snapshots'));
  if (!inside(root, snapshots)) throw new Error('The source snapshot directory escaped this workspace.');
  const file = await fs.realpath(receiptFile);
  if (!inside(snapshots, file)) throw new Error('The source receipt is outside the owned snapshots.');
  const receipt = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  if (receipt.version !== 1 || receipt.repository !== repository || !/^[a-f0-9]{40}$/.test(receipt.commit) || receipt.checksPassed !== true || !receipt.files || !Object.keys(receipt.files).length) throw new Error('The checked source receipt is invalid.');
  const source = await fs.realpath(receipt.source);
  if (source !== path.join(path.dirname(file), 'source') || !inside(snapshots, source)) throw new Error('The source snapshot is outside its owned receipt directory.');
  const files = Object.keys(receipt.files);
  if (Object.values(receipt.files).some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('A source hash is missing or invalid.');
  const command = (...args) => execute(git, ['-C', root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if ((await command('remote', 'get-url', 'origin')).toString().trim() !== `https://github.com/${repository}.git`) throw new Error('The image source repository changed.');
  await command('cat-file', '-e', `${receipt.commit}^{commit}`);
  await command('merge-base', '--is-ancestor', receipt.commit, 'refs/remotes/origin/main');
  const committed = committedFiles(await command('ls-tree', '-r', '-z', receipt.commit));
  if (committed.length !== files.length || committed.some(name => !Object.hasOwn(receipt.files, name))) throw new Error('The source receipt file list differs from its Git commit.');
  for (const name of committed) if (hash(await command('show', `${receipt.commit}:${name}`)) !== receipt.files[name]) throw new Error('The source receipt hashes differ from its Git commit.');
  const hashes = await validateSource(source, files);
  if (files.some(name => hashes[name] !== receipt.files[name])) throw new Error('The checked image source was changed or a file is missing.');
  if (check) await check(source); else await checkSnapshot(source, path.dirname(file), git, execute);
  const after = await validateSource(source, files);
  if (files.some(name => after[name] !== receipt.files[name])) throw new Error('The source snapshot changed during verification.');
  return receipt;
}

// This only writes inside a caller-owned, per-build offline mount. It never
// applies an image, mounts a disk, touches host Windows or changes boot settings.
export async function copyImagePayload(receiptFile, workspace, mount, options = {}) {
  const source = await verifyImageSource(receiptFile, workspace, options);
  const root = await fs.realpath(workspace), mounted = await fs.realpath(mount);
  if (!/^build\/development-[0-9]{3}\/final-(boot|install)$/.test(path.relative(root, mounted).split(path.sep).join('/'))) throw new Error('Image payload target is not an owned offline build mount.');
  for (const name of ['scripts/Apply-SourceUpdate.mjs', 'image/Volterra-Startup.cmd', 'PROJECT_BRIEF.md']) if (!source.files[name]) throw new Error('Required boot source is missing from the checked commit.');
  async function directory(base, target) {
    if (target !== base && !inside(base, target)) throw new Error('An image directory escaped the offline mount.');
    const relative = path.relative(base, target);
    let current = base;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(base, await fs.realpath(current))) throw new Error('Linked image directories cannot receive source files.');
    }
  }
  const payload = path.join(mounted, 'Volterra'); await directory(mounted, payload);
  const existing = [];
  async function collect(folder, prefix) {
    const stat = await fs.lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(payload, await fs.realpath(folder))) throw new Error('Linked image source trees cannot be refreshed.');
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      const name = `${prefix}/${item.name}`, target = path.join(folder, item.name);
      if (item.isSymbolicLink()) throw new Error('Linked image source files cannot be refreshed.');
      if (item.isDirectory()) await collect(target, name);
      else { if (!item.isFile() || !allowedSource(name)) throw new Error('The old image source contains a protected or unsupported file.'); existing.push({ name, target }); }
    }
  }
  for (const name of ['app', 'scripts', 'test', 'image', 'design']) await collect(path.join(payload, name), name);
  for (const item of await fs.readdir(payload, { withFileTypes: true })) if (allowedSource(item.name)) {
    if (!item.isFile() || item.isSymbolicLink()) throw new Error('An original source root file is linked or is not a regular file.');
    existing.push({ name: item.name, target: path.join(payload, item.name) });
  }
  // Only individually enumerated original-source files can be removed. Private
  // runtime binaries and credentials are outside these source trees.
  for (const item of existing) if (!Object.hasOwn(source.files, item.name)) {
    if (!inside(payload, await fs.realpath(item.target))) throw new Error('An obsolete source path escaped the payload.');
    await fs.unlink(item.target);
  }
  async function write(base, target, bytes, expected) {
    if (!inside(base, target)) throw new Error('An image source destination escaped its boundary.');
    await directory(base, path.dirname(target));
    const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) throw new Error('An image source destination is linked or is not a regular file.');
    if (hash(bytes) !== expected) throw new Error('Source changed before copying into the image.');
    const temporary = path.join(path.dirname(target), `.volterra-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      await fs.rename(temporary, target);
    } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    if (hash(await fs.readFile(target)) !== expected) throw new Error('Copied image source hash changed.');
  }
  for (const [name, expected] of Object.entries(source.files)) await write(payload, path.join(payload, name), await fs.readFile(path.join(source.source, name)), expected);
  for (const [name, destination] of [
    ['scripts/Apply-SourceUpdate.mjs', 'Volterra/private/bootstrap/Apply-SourceUpdate.mjs'],
    ['image/Volterra-Startup.cmd', 'Windows/VolterraStartup.cmd'],
    ['PROJECT_BRIEF.md', 'PROJECT_BRIEF.md']
  ]) await write(mounted, path.join(mounted, destination), await fs.readFile(path.join(payload, name)), source.files[name]);
  const version = Buffer.from(JSON.stringify({ repository: source.repository, commit: source.commit }));
  await write(mounted, path.join(payload, 'private/source-version.json'), version, hash(version));
  const instructions = Buffer.from('This is the Microsoft Volterra development OS root. Read Volterra/AGENTS.md and Volterra/PROJECT_BRIEF.md before changing source. Application and approved design paths are relative to Volterra. Keep credentials and third-party OS binaries out of GitHub. Do not restart automatically.\r\n');
  await write(mounted, path.join(mounted, 'AGENTS.md'), instructions, hash(instructions));
  const copied = await validateSource(payload, Object.keys(source.files));
  if (Object.keys(source.files).some(name => copied[name] !== source.files[name])) throw new Error('The image payload does not match the checked Git commit.');
  return { commit: source.commit, files: source.files };
}
