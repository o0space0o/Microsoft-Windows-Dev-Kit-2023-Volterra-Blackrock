import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function browserAddress(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Unsupported browser address.');
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('Unsupported browser address.');
  return url.href;
}

// GitHub's official browser launcher splits this string into argv, then invokes
// the executable directly. Quote each fixed path for its shlex parser; no shell
// command, authorization URL or credential is embedded in this setting.
export function githubBrowserCommand(node, script) {
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  return [node, script].map(quote).join(' ');
}

export async function openSystemBrowser(value, { root = sourceRoot, profile = process.env.VOLTERRA_BROWSER_PROFILE, spawnImpl = spawn, existsImpl = existsSync } = {}) {
  const address = browserAddress(value);
  const chrome = path.join(root, 'private', 'tools', 'chrome', 'chrome.exe');
  if (!existsImpl(chrome)) throw new Error('The staged system browser is unavailable. Official browser sign-in cannot start.');
  if (profile && (!path.isAbsolute(profile) || /[\u0000-\u001f\u007f]/.test(profile))) throw new Error('The browser profile must be an absolute local directory.');
  const args = ['--new-window', '--no-first-run'];
  if (profile) args.push(`--user-data-dir=${profile}`);
  args.push(address);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(chrome, args, { shell: false, detached: true, windowsHide: false, stdio: 'ignore' });
    child.once('error', () => reject(new Error('The staged system browser could not start.')));
    child.once('spawn', () => { child.unref(); resolve({ executable: chrome, pid: child.pid, started: true }); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Supply one browser address.');
    await openSystemBrowser(process.argv[2]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
