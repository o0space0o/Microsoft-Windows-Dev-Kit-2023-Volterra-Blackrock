import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { run, powershell, root } from './platform.mjs';

export const stateDirectory = process.env.VOLTERRA_STATE_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'VolterraWorkspace');
export async function atomic(file, content, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode, flag: 'wx' });
  await fs.rename(temporary, file);
}
export async function readState() {
  try { return JSON.parse(await fs.readFile(path.join(stateDirectory, 'state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { version: 1, hostId: `urn:uuid:${randomUUID()}`, projects: {}, selected: null, authMode: null }; }
}
export const saveState = value => atomic(path.join(stateDirectory, 'state.json'), JSON.stringify(value, null, 2));
export async function saveCredential(value) {
  if (!powershell) throw new Error('Protected credential storage currently requires Windows DPAPI. Use Codex-managed sign-in on this platform.');
  const protectedValue = await run(powershell, ['-NoProfile', '-File', path.join(root, 'scripts', 'Protect-Credential.ps1'), '-Mode', 'Protect'], { input: JSON.stringify(value) });
  await atomic(path.join(stateDirectory, 'chatgpt.dpapi'), protectedValue);
}
export async function readCredential() {
  try {
    const encrypted = await fs.readFile(path.join(stateDirectory, 'chatgpt.dpapi'), 'utf8');
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
