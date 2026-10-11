import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stateDirectory } from './storage.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const powershell = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
export function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; if (stdout.length > 5_000_000) child.kill(); });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `Process exited with ${code}`)));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}
export function executable(name) {
  const configured = process.env[`VOLTERRA_${name.toUpperCase()}_PATH`];
  if (configured && existsSync(configured)) return configured;
  const portable = path.join(root, 'private', 'tools', name === 'git' ? 'git/cmd/git.exe' : name === 'node' ? 'node.exe' : `${name}.exe`);
  return existsSync(portable) ? portable : name;
}
export async function openBrowser(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('Unsupported browser address');
  if (powershell) await run(powershell, ['-NoProfile', '-File', path.join(root, 'scripts', 'Open-Browser.ps1'), '-Url', url.href], { env: { ...process.env, VOLTERRA_BROWSER_PROFILE: path.join(stateDirectory, 'browser') } });
  else await run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url.href]);
}
export async function chooseFolder() {
  if (!powershell) throw new Error('Enter the absolute project folder path on this system.');
  return run(powershell, ['-NoProfile', '-STA', '-File', path.join(root, 'scripts', 'Choose-Folder.ps1')]);
}
export function redact(value) {
  return String(value).replace(/\bsk-[\w-]+/g, '[redacted key]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted token]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[\w]+/g, '[redacted token]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
}
