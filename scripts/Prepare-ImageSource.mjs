import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { prepareImageSource, verifyImageSource, copyImagePayload } from '../app/image-source.mjs';
import { applicationOverlayOptions } from '../app/image-mount.mjs';
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = process.env.VOLTERRA_GIT_PATH || (existsSync(path.join(workspace, 'private/tools/git/cmd/git.exe')) ? path.join(workspace, 'private/tools/git/cmd/git.exe') : 'git');
export function parseImageSourceArguments(args) {
  if (!args.length) return { mode: 'prepare' };
  if (args[0] === '--verify' && args.length === 2 && args[1]) return { mode: 'verify', receiptFile: args[1] };
  if (args[0] !== '--copy' || ![3, 5].includes(args.length) || !args[1] || !args[2]) throw new Error('Unsupported image source arguments.');
  return { mode: 'copy', receiptFile: args[1], mount: args[2], ...applicationOverlayOptions(args[3] ?? '', args[4] ?? '') };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = parseImageSourceArguments(process.argv.slice(2));
    const result = input.mode === 'copy'
      ? await copyImagePayload(input.receiptFile, workspace, input.mount, { git, applicationOverlayAuthority: input.applicationOverlayAuthority, expectedApplicationOverlayAuthoritySHA256: input.expectedApplicationOverlayAuthoritySHA256 })
      : input.mode === 'verify' ? await verifyImageSource(input.receiptFile, workspace, { git }) : await prepareImageSource({ directory: workspace, git });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
