// A sealed copy is kept in private/bootstrap. It survives a broken source update.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const top = new Set(['AGENTS.md', 'PROJECT_BRIEF.md', 'README.md', 'package.json', 'automation.json', '.gitignore']);
const allowed = file => typeof file === 'string' && !file.includes('\\') && !file.includes(':') && !file.startsWith('/') && !file.split('/').some(p => !p || p === '.' || p === '..') && (top.has(file) || /^(app|scripts|test|image|design)\/[\w./-]+\.(mjs|js|json|ps1|cmd|html|css|md|txt|png)$/.test(file)) && !/(^|\/)(private|build|node_modules|\.git)(\/|$)/.test(file);
async function atomic(file, value) { const temp = `${file}.${randomUUID()}.tmp`; await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' }); await fs.rename(temp, file); }
async function content(file) { try { return await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function checkedPath(base, file) {
  if (!allowed(file)) throw new Error(`Protected update path: ${file}`);
  const target = path.resolve(base, file);
  let current = target;
  while (true) {
    try {
      const real = await fs.realpath(current), relative = path.relative(base, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`An update path escaped through a link: ${file}`);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`An update path is linked: ${file}`);
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; current = path.dirname(current); }
  }
  return target;
}
export async function applySourceUpdate({ directory, target, mode = 'apply', git }) {
  directory = await fs.realpath(directory); target = await fs.realpath(target);
  const manifest = path.join(directory, 'pending-update.json');
  const raw = await content(manifest); if (!raw) return { status: 'none' };
  const pending = JSON.parse(raw.toString('utf8'));
  if (pending.target !== target || !/^[a-f0-9]{40}$/.test(pending.commit) || !/^[\w-]+$/.test(pending.id)) throw new Error('Update target identity is invalid.');
  const backup = path.join(directory, 'updates', pending.id, 'rollback');
  const source = await fs.realpath(pending.source);
  if (source !== await fs.realpath(path.join(directory, 'updates', pending.id, 'source'))) throw new Error('Update source identity is invalid.');
  const sourceRelative = path.relative(directory, source);
  if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)) throw new Error('The staged source is outside persistent storage.');
  if (!Array.isArray(pending.files) || !pending.files.length) throw new Error('Empty update manifest.');
  for (const item of pending.files) { await checkedPath(target, item.file); await checkedPath(source, item.file); }
  async function restore() {
    for (const item of pending.files) {
      const destination = await checkedPath(target, item.file);
      const previous = await content(path.join(backup, item.file));
      if (item.expected !== null && (!previous || digest(previous) !== item.expected)) throw new Error('Rollback data is incomplete; no unverified replacement will be made.');
    }
    for (const item of pending.files) {
      const destination = await checkedPath(target, item.file);
      if (item.expected === null) await fs.unlink(destination).catch(e => { if (e.code !== 'ENOENT') throw e; });
      else { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(path.join(backup, item.file), destination); }
    }
    pending.phase = 'rolled-back'; pending.rolledBackAt = new Date().toISOString(); await atomic(manifest, pending);
    return { status: 'rolled-back', commit: pending.commit };
  }
  if (mode === 'confirm') {
    if (pending.phase !== 'applied') return { status: pending.phase };
    for (const item of pending.files) {
      const bytes = await content(await checkedPath(target, item.file));
      if ((bytes === null ? null : digest(bytes)) !== item.desired) throw new Error('Updated source changed before health confirmation.');
    }
    if (git) {
      const execute = args => new Promise((resolve, reject) => { const child = spawn(git, ['-C', target, ...args], { windowsHide: true, stdio: 'ignore' }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Updated source Git history could not be confirmed.'))); });
      await execute(['update-ref', 'refs/heads/main', pending.commit, pending.base]);
      await execute(['read-tree', pending.commit]);
    }
    pending.phase = 'confirmed'; pending.confirmedAt = new Date().toISOString();
    await atomic(path.join(directory, 'last-update.json'), pending); await fs.unlink(manifest);
    return { status: 'confirmed', commit: pending.commit };
  }
  if (pending.phase === 'applied' || pending.phase === 'applying') return restore();
  if (pending.phase !== 'pending') return { status: pending.phase };
  for (const item of pending.files) {
    const original = await content(await checkedPath(target, item.file)), replacement = await content(await checkedPath(source, item.file));
    if ((original === null ? null : digest(original)) !== item.expected || (replacement === null ? null : digest(replacement)) !== item.desired) throw new Error('Source changed since staging; update deferred.');
  }
  await fs.mkdir(backup, { recursive: true });
  for (const item of pending.files) if (item.expected !== null) {
    const destination = path.join(backup, item.file); await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(target, item.file), destination, fs.constants.COPYFILE_EXCL);
  }
  pending.phase = 'applying'; await atomic(manifest, pending);
  try {
    for (const item of pending.files) {
      const destination = await checkedPath(target, item.file);
      if (item.desired === null) await fs.unlink(destination);
      else { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(path.join(source, item.file), destination); }
    }
    pending.phase = 'applied'; pending.appliedAt = new Date().toISOString(); await atomic(manifest, pending);
    return { status: 'applied', commit: pending.commit, healthConfirmationRequired: true };
  } catch (error) { await restore(); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, target, mode, git] = process.argv.slice(2);
  try { console.log(JSON.stringify(await applySourceUpdate({ directory, target, mode, git }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
