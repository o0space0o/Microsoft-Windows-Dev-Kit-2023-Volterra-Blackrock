import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fixturePrivateState } from './fixture-private-state.mjs';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-git-check-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const privacy = fixturePrivateState(directory);
const { Repository } = await import('../app/repository.mjs');
const { executable, run, root } = await import('../app/platform.mjs');
const git = (...args) => run(executable('git'), args);
const local = path.join(directory, 'local'), remote = path.join(directory, 'remote.git'), other = path.join(directory, 'other');
const report = { tests: [], status: 'running' };
try {
  await fs.mkdir(path.join(local, 'design/approved-v1'), { recursive: true }); await fs.mkdir(path.join(local, 'scripts')); await fs.mkdir(path.join(local, 'app'));
  for (const name of ['desktop', 'system', 'maintenance', 'connections']) await fs.copyFile(path.join(root, `design/approved-v1/${name}.png`), path.join(local, `design/approved-v1/${name}.png`));
  await fs.writeFile(path.join(local, 'README.md'), 'Baseline source'); await fs.writeFile(path.join(local, '.gitignore'), '/private/\n');
  await fs.writeFile(path.join(local, 'scripts/Check-Source.mjs'), "import fs from 'node:fs/promises'; import assert from 'node:assert/strict'; assert.equal(await fs.readFile('README.md','utf8'), 'Candidate source'); console.log('Snapshot check passed');\n");
  await git('init', '--bare', '--initial-branch=main', remote); await git('-C', local, 'init', '--initial-branch=main');
  await git('-C', local, 'config', 'user.name', 'Volterra test'); await git('-C', local, 'config', 'user.email', 'test@localhost');
  await git('-C', local, 'add', '.'); await git('-C', local, 'commit', '-m', 'Test baseline'); await git('-C', local, 'remote', 'add', 'origin', remote); await git('-C', local, 'push', 'origin', 'main');
  const repository = new Repository({ directory: local, config: { repository: 'test/test', branch: 'main' }, privacy, execute: (exe, args, options) => exe === executable('gh') ? Promise.resolve('Local test remote needs no account') : run(exe, args, options) });
  const original = await repository.git('rev-parse', 'HEAD'); await fs.writeFile(path.join(local, 'README.md'), 'Invalid candidate');
  await assert.rejects(repository.checkpoint('Invalid update'));
  assert.equal(await repository.git('rev-parse', 'HEAD'), original);
  assert.equal(await fs.readFile(path.join(local, 'README.md'), 'utf8'), 'Invalid candidate');
  report.tests.push('A failing real child check retains source edits and leaves main unchanged');
  await fs.writeFile(path.join(local, 'README.md'), 'Candidate source');
  const checkpoint = await repository.checkpoint('Verified candidate'); assert.equal(checkpoint.changed, true);
  await repository.push(); assert.equal(await git('--git-dir', remote, 'rev-parse', 'main'), checkpoint.commit);
  report.tests.push('A checked immutable snapshot advances and pushes main successfully');
  await git('clone', remote, other); await git('-C', other, 'config', 'user.name', 'Other developer'); await git('-C', other, 'config', 'user.email', 'other@localhost');
  await fs.writeFile(path.join(other, 'README.md'), 'Concurrent remote source'); await git('-C', other, 'commit', '-am', 'Concurrent remote update'); await git('-C', other, 'push', 'origin', 'main');
  const concurrent = await git('--git-dir', remote, 'rev-parse', 'main');
  await fs.writeFile(path.join(local, 'app/sample.mjs'), 'export const verified = true;\n');
  const candidate = await repository.checkpoint('Local verified work'); await assert.rejects(repository.push());
  assert.equal(await git('--git-dir', remote, 'rev-parse', 'main'), concurrent); assert.equal(await repository.git('rev-parse', 'HEAD'), candidate.commit);
  assert.equal((await repository.compare()).diverged, true);
  report.tests.push('A non-fast-forward push preserves both developers’ commits'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
finally {
  await fs.mkdir(path.join(root, 'build/verification'), { recursive: true }); await fs.writeFile(path.join(root, 'build/verification/repository.json'), JSON.stringify(report, null, 2));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); console.log(JSON.stringify(report, null, 2));
}
