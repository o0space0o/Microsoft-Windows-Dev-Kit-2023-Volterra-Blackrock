import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// A public source checkpoint never includes the Windows tree, vendor binaries or credentials.
const roots = new Set(['AGENTS.md', 'PROJECT_BRIEF.md', 'README.md', 'package.json', 'automation.json', '.gitignore']);
// These optional delivery inputs are public, but are not OS application payload.
const buildAutomation = new Set(['.github/workflows/build-validation-node.yml', 'patches/node-v26.10.0-validationos.patch', 'patches/node-v26.10.0-validationos.json', 'patches/README.md']);
export const isBuildAutomationSource = file => buildAutomation.has(file);
export const approved = Object.freeze({
  'desktop.png': '6db4c93d32c30b60965af271617a2587f432d607792e75c6d4f4604a19582b96',
  'system.png': 'c9fb03b6af4c4ebfa34b341dc61b14d65c99042f2f82d4eaa693fa383f962a85',
  'maintenance.png': '062f42d998e89969d781c1b91a64fa2893c98dbfbdc8f8b4b36c40cac41f7264',
  'connections.png': '658a9ebddbaae7c9efbafa73a6c3efbc389532e001ea07193ae869125c34d687'
});
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function allowedSource(file) {
  if (typeof file !== 'string' || file.includes('\\') || file.includes(':') || file.startsWith('/') || file.split('/').some(p => !p || p === '.' || p === '..')) return false;
  if (roots.has(file)) return true;
  if (isBuildAutomationSource(file)) return true;
  if (file === 'scripts/Probe-WindowsFacts.cs' || file === 'scripts/Private-WindowsState.cs' || file === 'scripts/Launch-Volterra.cpp') return true;
  if (/^design\/[\w/-]+\.png$/.test(file)) return true;
  return /^(app|scripts|test|image|design)\/[\w./-]+\.(mjs|js|json|ps1|cmd|html|css|md|txt)$/.test(file)
    && !/(^|\/)(?:node_modules|private|build|\.git|\.env[^/]*|auth\.json|credentials?(?:\.json)?)(\/|$)/i.test(file);
}
export async function validateSource(directory, files) {
  const base = await fs.realpath(directory);
  const receipt = {};
  for (const file of files) {
    if (!allowedSource(file)) throw new Error(`Excluded from public source: ${file}`);
    const target = path.resolve(base, file);
    let bytes;
    try {
      const info = await fs.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 3_000_000) throw new Error(`Unsupported source file: ${file}`);
      const real = await fs.realpath(target);
      const relative = path.relative(base, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Linked source escaped the workspace: ${file}`);
      bytes = await fs.readFile(real);
    } catch (error) { if (error.code === 'ENOENT') { receipt[file] = null; continue; } throw error; }
    if (!file.endsWith('.png') && /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/.test(bytes.toString('utf8'))) throw new Error(`Credential-like content in ${file}`);
    receipt[file] = hash(bytes);
  }
  for (const [file, expected] of Object.entries(approved)) {
    const target = `design/approved-v1/${file}`;
    if (hash(await fs.readFile(path.join(base, target))) !== expected) throw new Error(`Approved artwork changed: ${file}`);
  }
  return receipt;
}
