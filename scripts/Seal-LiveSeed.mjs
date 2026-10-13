import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { liveSeedPath } from '../app/live-workspace.mjs';
import { ownedPath } from './Start-Volterra.mjs';

const workspace = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const mount = path.resolve(process.argv[2] || '');
if (mount !== path.join(workspace, 'build', 'current', 'final-boot')) throw new Error('Only the current offline live image can be sealed.');
await ownedPath(mount, 'directory');
const root = path.join(mount, 'Volterra');
const version = JSON.parse(await fs.readFile(await ownedPath(path.join(root, 'private/source-version.json'))));
if (!/^[a-f0-9]{40}$/.test(process.argv[3] || '') || version.commit !== process.argv[3]) throw new Error('Checked source commit differs.');
const files = {};
const digest = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
async function collect(directory, prefix = '') {
  await ownedPath(directory, 'directory');
  for (const name of await fs.readdir(directory)) {
    const target = path.join(directory, name), relative = prefix + name, info = await fs.lstat(target);
    if (info.isDirectory()) await collect(target, relative + '/');
    else {
      if (!liveSeedPath(relative) || Object.keys(files).length >= 5000) throw new Error('Protected or excessive live seed: ' + relative);
      await ownedPath(target); files[relative] = digest(await fs.readFile(target));
    }
  }
}
await collect(root);
const bytes = Buffer.from(JSON.stringify({ version: 1, kind: 'volterraLiveSeed', ...version, files }));
if (bytes.length > 512000) throw new Error('Live seed exceeds the manifest limit.');
await fs.writeFile(path.join(root, 'private/live-seed.json'), bytes, { flag: 'wx', flush: true });
console.log(JSON.stringify({ commit: version.commit, files: Object.keys(files).length, bytes: bytes.length, SHA256: digest(bytes), credentialsIncluded: false }));
