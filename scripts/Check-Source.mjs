import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateSource } from '../app/source-policy.mjs';
const directory = process.argv[2] || process.cwd();
async function collect(folder, prefix = '') {
  const files = [];
  for (const item of await fs.readdir(folder, { withFileTypes: true })) {
    if (['.git', 'private', 'build', 'node_modules'].includes(item.name)) continue;
    const file = prefix + item.name;
    if (item.isDirectory()) files.push(...await collect(path.join(folder, item.name), file + '/'));
    else files.push(file);
  }
  return files;
}
// Check only publishable project files. Unlicensed media at the build root is intentionally excluded.
const files = (await collect(directory)).filter(f => !/\.(iso|wim|vhdx)$/.test(f));
await validateSource(directory, files);
function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: directory, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Check failed (${code})`)));
  });
}
for (const file of files.filter(f => /\.(mjs|js)$/.test(f))) await execute(['--check', file]);
const tests = (await fs.readdir(path.join(directory, 'test'))).filter(f => f.endsWith('.test.mjs')).map(f => `test/${f}`);
if (!tests.length) throw new Error('The source test suite is missing.');
await execute(['--test', ...tests]);
console.log('Source, credential exclusions, approved artwork and tests passed.');
