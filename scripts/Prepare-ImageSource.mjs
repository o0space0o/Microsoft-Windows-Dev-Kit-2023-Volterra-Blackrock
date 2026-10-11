import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { prepareImageSource, verifyImageSource, copyImagePayload } from '../app/image-source.mjs';
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = process.env.VOLTERRA_GIT_PATH || (existsSync(path.join(workspace, 'private/tools/git/cmd/git.exe')) ? path.join(workspace, 'private/tools/git/cmd/git.exe') : 'git');
try {
  const result = process.argv[2] === '--copy'
    ? await copyImagePayload(process.argv[3], workspace, process.argv[4], { git })
    : process.argv[2] === '--verify'
      ? await verifyImageSource(process.argv[3], workspace, { git })
      : await prepareImageSource({ directory: workspace, git });
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
