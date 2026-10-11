import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { redact } from './platform.mjs';
import { stateDirectory } from './storage.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const privateNames = new Set(['build', 'private', '.git', '.codex', '.agents', '.aws', '.ssh', '.gnupg', 'node_modules']);
const excluded = name => privateNames.has(name.toLowerCase()) || /^\.env/i.test(name)
  || /^(?:auth|credentials?)\.json$/i.test(name) || /\.(?:credential|dpapi|log|iso|wim|vhdx?|ffu)$/i.test(name);
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[/\\:\u0000-\u001f\u007f]/.test(name) && name !== '.' && name !== '..';
const validTime = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const within = (base, candidate) => { const relative = path.relative(base, candidate); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const validateFilter = filter => {
  if (typeof filter !== 'string' || filter.length > 256 || /[\u0000-\u001f\u007f]/.test(filter)) throw new Error('Use a file filter of up to 256 characters.');
};
const directoryIdentity = info => {
  if (!info.isDirectory() || info.isSymbolicLink() || ['dev', 'ino', 'mtimeNs', 'ctimeNs'].some(key => typeof info[key] !== 'bigint')) throw new Error('A stable workspace directory is required.');
  return ['dev', 'ino', 'mtimeNs', 'ctimeNs'].map(key => info[key]);
};
async function privateStatePaths(filesystem) {
  const configured = path.resolve(stateDirectory);
  try {
    const canonical = await filesystem.realpath(configured);
    if (typeof canonical !== 'string' || !path.isAbsolute(canonical)) throw new Error('The private state directory returned an unsupported path.');
    return [...new Set([configured, canonical])];
  } catch (error) {
    // A fresh helper may not have created state yet. Keep its configured path excluded.
    if (error.code === 'ENOENT') return [configured];
    throw error;
  }
}

export function fileQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^(?:(?:show|list) )?files(?: matching ([^\r\n]+))?$/i.exec(message.trim());
  if (!match) return null;
  const filter = (match[1] || '').trim(); validateFilter(filter);
  return { filter };
}

export async function collectFiles(directory, { filesystem = fs } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute workspace folder is required.');
  const workspace = await filesystem.realpath(directory);
  const protectedPaths = await privateStatePaths(filesystem);
  if (workspace.split(path.sep).some(part => privateNames.has(part.toLowerCase())) || protectedPaths.some(base => within(base, workspace))) throw new Error('Private runtime and build folders are excluded from file inventory.');
  const before = directoryIdentity(await filesystem.lstat(workspace, { bigint: true }));
  const entries = []; let excludedCount = 0, scanned = 0;
  const handle = await filesystem.opendir(workspace, { bufferSize: 32, recursive: false });
  try {
    let entry;
    while ((entry = await handle.read()) !== null) {
      if (++scanned > 4096) throw new Error('The workspace has too many entries for this inventory.');
      if (!validName(entry.name)) throw new Error('The directory API returned an unsupported entry name.');
      const target = path.join(workspace, entry.name);
      if (excluded(entry.name) || protectedPaths.some(base => within(base, target))) { excludedCount++; continue; }
      // Read entry metadata without resolving a link, inspecting its target or descending into a folder.
      const info = await filesystem.lstat(target, { bigint: true });
      const kind = info.isSymbolicLink() ? 'Link' : info.isFile() ? 'File' : info.isDirectory() ? 'Folder' : 'Other';
      if (kind === 'File' && (typeof info.size !== 'bigint' || info.size < 0n || info.size > 0xffff_ffff_ffff_ffffn)) throw new Error('The filesystem returned unsupported file sizes.');
      entries.push({ name: entry.name, kind, sizeBytes: kind === 'File' ? info.size.toString() : null, modifiedAt: info.mtime.toISOString() });
    }
  } finally { await handle.close(); }
  const after = directoryIdentity(await filesystem.lstat(workspace, { bigint: true }));
  if (before.some((value, index) => value !== after[index]) || await filesystem.realpath(directory) !== workspace) throw new Error('The workspace changed during file inventory. Refresh the reading.');
  const currentProtected = await privateStatePaths(filesystem);
  if (protectedPaths.length !== currentProtected.length || protectedPaths.some((value, index) => path.relative(value, currentProtected[index]) !== '')) throw new Error('The private state directory changed during file inventory. Refresh the reading.');
  return { version: 1, kind: 'files', requestedWorkspace: directory, workspace, observedAt: new Date().toISOString(),
    system: { platform: process.platform, release: os.release(), runtimeArchitecture: process.arch }, excludedCount, entries };
}

export async function inspectFiles(directory, filter = '', collect = collectFiles) {
  validateFilter(filter);
  try {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('An absolute workspace folder is required.');
    const raw = await collect(directory);
    if (raw?.version !== 1 || raw.kind !== 'files' || raw.requestedWorkspace !== directory
      || typeof raw.workspace !== 'string' || !path.isAbsolute(raw.workspace) || raw.workspace.length > 4096
      || !validTime(raw.observedAt) || !raw.system
      || ['platform', 'release', 'runtimeArchitecture'].some(key => typeof raw.system[key] !== 'string')
      || !Number.isInteger(raw.excludedCount) || raw.excludedCount < 0 || raw.excludedCount > 4096
      || !Array.isArray(raw.entries) || raw.entries.length + raw.excludedCount > 4096) throw new Error('The file collector returned unsupported evidence.');
    const names = new Set();
    const all = raw.entries.map(entry => {
      if (!validName(entry?.name) || excluded(entry.name) || !['File', 'Folder', 'Link', 'Other'].includes(entry.kind) || !validTime(entry.modifiedAt)
        || (entry.kind === 'File' ? typeof entry.sizeBytes !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(entry.sizeBytes) || BigInt(entry.sizeBytes) > 0xffff_ffff_ffff_ffffn : entry.sizeBytes !== null)) {
        throw new Error('The file collector returned incomplete entry readings.');
      }
      const name = text(entry.name, 255);
      if (names.has(name.toLowerCase())) throw new Error('The file collector returned duplicate entry names.');
      names.add(name.toLowerCase());
      return { name, kind: entry.kind, sizeBytes: entry.sizeBytes, modifiedAt: entry.modifiedAt };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const entries = all.filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase()));
    return { status: 'passed', observedAt: raw.observedAt, workspace: text(raw.workspace, 4096), filter: text(filter, 256),
      system: Object.fromEntries(['platform', 'release', 'runtimeArchitecture'].map(key => [key, text(raw.system[key] || 'Unknown', 64)])),
      environment: 'Current OS session; VM or physical identity unverified', source: 'Node directory and entry metadata APIs', scope: 'Workspace root only',
      totalCount: all.length, matchedCount: entries.length, excludedCount: raw.excludedCount, entries };
  } catch (error) {
    return { status: 'blocked', entries: [], error: { stage: 'Workspace file inventory', message: text(error?.message || 'The directory query did not succeed.') } };
  }
}

export function fileReport(result) {
  if (result.status !== 'passed') return `File inventory is blocked. ${result.error.stage}: ${result.error.message}`;
  const displayed = result.entries.slice(0, 40);
  const paragraphs = [`Live workspace files · ${result.environment}\n${result.system.platform}, OS release ${result.system.release}, runtime architecture ${result.system.runtimeArchitecture}. Observed ${result.observedAt}.`,
    `Workspace: ${result.workspace}\nRoot entries only. Private runtime/build entries and credential/media names are excluded. No file contents, nested folders or link targets are read.`,
    `${result.totalCount} entries read; ${result.excludedCount} excluded.${result.filter ? ` Filter "${result.filter}" matched ${result.matchedCount}.` : ''}`];
  if (!displayed.length) paragraphs.push(result.filter ? 'No entries matched this literal filter.' : 'No included root entries were reported.');
  for (const entry of displayed) paragraphs.push(`${entry.name}\nType: ${entry.kind}.${entry.kind === 'File' ? ` Size: ${entry.sizeBytes} bytes.` : ''}\nModified: ${entry.modifiedAt}.${entry.kind === 'Link' ? ' Link target unverified.' : ''}`);
  if (result.entries.length > displayed.length) paragraphs.push(`Showing ${displayed.length} of ${result.matchedCount} matches. Say "show files matching <text>" to narrow the readings.`);
  return paragraphs.join('\n\n');
}
