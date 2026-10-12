import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { run, powershell, root } from './platform.mjs';
import { ensurePrivateState } from './private-state.mjs';

export const stateDirectory = process.env.VOLTERRA_STATE_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'VolterraWorkspace');
export async function assertStatePrivacy({ directory = stateDirectory, create = false, privacy = ensurePrivateState } = {}) {
  return privacy({ directory, volume: process.env.VOLTERRA_STATE_VOLUME || '', scope: 'state', create, root });
}
export async function atomic(file, content, mode = 0o600, { directory = stateDirectory, privacy = ensurePrivateState } = {}) {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('State writes must stay inside verified private storage.');
  await assertStatePrivacy({ directory, create: true, privacy });
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode, flag: 'wx' });
  try { await assertStatePrivacy({ directory, privacy }); await fs.rename(temporary, file); await assertStatePrivacy({ directory, privacy }); }
  catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}
export async function readState(options = {}) {
  await assertStatePrivacy({ ...options, create: true });
  try { return JSON.parse(await fs.readFile(path.join(options.directory || stateDirectory, 'state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { version: 1, hostId: `urn:uuid:${randomUUID()}`, projects: {}, selected: null, authMode: null }; }
}
export const saveState = (value, options = {}) => atomic(path.join(options.directory || stateDirectory, 'state.json'), JSON.stringify(value, null, 2), 0o600, options);
export async function saveCredential(value, options = {}) {
  await assertStatePrivacy(options);
  if (!powershell) throw new Error('Protected credential storage currently requires Windows DPAPI. Use Codex-managed sign-in on this platform.');
  const protectedValue = await run(powershell, ['-NoProfile', '-File', path.join(root, 'scripts', 'Protect-Credential.ps1'), '-Mode', 'Protect'], { input: JSON.stringify(value) });
  await atomic(path.join(options.directory || stateDirectory, 'chatgpt.dpapi'), protectedValue, 0o600, options);
}
export async function readCredential(options = {}) {
  await assertStatePrivacy(options);
  try {
    const encrypted = await fs.readFile(path.join(options.directory || stateDirectory, 'chatgpt.dpapi'), 'utf8');
    const value = await run(powershell, ['-NoProfile', '-File', path.join(root, 'scripts', 'Protect-Credential.ps1'), '-Mode', 'Unprotect'], { input: encrypted });
    return JSON.parse(value);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function projectPath(project, relative, forWrite = false) {
  if (!project || typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Choose a project and a relative file path.');
  const base = await fs.realpath(project);
  const target = path.resolve(base, relative);
  const within = value => { const rel = path.relative(base, value); return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };
  if (!within(target)) throw new Error('The file must stay inside the selected project.');
  let resolved;
  try { resolved = await fs.realpath(target); }
  catch (error) {
    if (!forWrite || error.code !== 'ENOENT') throw error;
    resolved = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
  }
  if (!within(resolved)) throw new Error('A linked path points outside the selected project.');
  return resolved;
}
