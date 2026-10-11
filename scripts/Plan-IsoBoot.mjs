import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequestedIsoPlan } from './Current-Media.mjs';
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  console.log(JSON.stringify(await readRequestedIsoPlan(workspace, process.argv[2], process.argv[3])));
} catch (error) { console.error(error.message); process.exitCode = 1; }
