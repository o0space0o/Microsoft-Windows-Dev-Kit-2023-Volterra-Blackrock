import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveVmCapture } from '../app/vm-capture.mjs';
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 7_100_000) throw new Error('Capture payload is too large.');
  }
  const payload = JSON.parse(input.replace(/^\uFEFF/, ''));
  console.log(JSON.stringify(await saveVmCapture({ ...payload, workspace, outputFile: process.argv[2], captureId: process.argv[3], vmId: process.argv[4] })));
} catch (error) { console.error(error.message); process.exitCode = 1; }
