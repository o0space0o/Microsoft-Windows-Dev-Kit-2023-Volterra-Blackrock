import fs from 'node:fs/promises';
import path from 'node:path';
import { run, executable, root } from './platform.mjs';
import { allowedSource, validateSource } from './source-policy.mjs';
import { atomic, stateDirectory } from './storage.mjs';
import { randomUUID } from 'node:crypto';

export class Repository {
  constructor({ directory = root, config, execute = run } = {}) { this.directory = directory; this.config = config; this.execute = execute; }
  git(...args) { return this.execute(executable('git'), ['-C', this.directory, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }
  async initialize() {
    const url = `https://github.com/${this.config.repository}.git`;
    if (!/^[\w.-]+\/[\w.-]+$/.test(this.config.repository) || this.config.branch !== 'main') throw new Error('Invalid automation repository configuration.');
    try { await fs.access(path.join(this.directory, '.git')); }
    catch {
      await this.git('init', '--initial-branch=main');
      await this.git('remote', 'add', 'origin', url);
      await this.fetch();
      // The image records the commit it contains. Attach that history without overwriting files.
      const receipt = JSON.parse((await fs.readFile(path.join(this.directory, 'private', 'source-version.json'), 'utf8')).replace(/^\uFEFF/, ''));
      if (!/^[a-f0-9]{40}$/.test(receipt.commit)) throw new Error('The image source commit receipt is missing.');
      await this.git('cat-file', '-e', `${receipt.commit}^{commit}`);
      await this.git('update-ref', 'refs/heads/main', receipt.commit);
      await this.git('read-tree', receipt.commit);
    }
    let origin;
    try { origin = await this.git('remote', 'get-url', 'origin'); } catch { await this.git('remote', 'add', 'origin', url); origin = url; }
    if (origin !== url) throw new Error('The existing origin belongs to another repository.');
    if ((await this.git('branch', '--show-current')) !== 'main') throw new Error('Automation requires the main branch.');
    await this.git('config', 'user.name', 'Microsoft Volterra build');
    await this.git('config', 'user.email', 'volterra-build@localhost');
  }
  async fetch() { await this.git('fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'); }
  async compare() {
    await this.fetch();
    const current = await this.git('rev-parse', 'HEAD'), latest = await this.git('rev-parse', 'origin/main');
    const counts = (await this.git('rev-list', '--left-right', '--count', 'HEAD...origin/main')).split(/\s+/).map(Number);
    return { current, latest, ahead: counts[0], behind: counts[1], diverged: counts[0] > 0 && counts[1] > 0 };
  }
  async check(directory = this.directory) {
    const output = await this.execute(process.execPath, [path.join(directory, 'scripts/Check-Source.mjs'), directory], { cwd: directory, env: { ...process.env, VOLTERRA_GIT_PATH: executable('git'), VOLTERRA_GH_PATH: executable('gh'), VOLTERRA_AUTOSTART: '0', VOLTERRA_OS_ROOT: '', VOLTERRA_STATE_DIR: path.join(stateDirectory, 'checks') } });
    return output;
  }
  async checkpoint(summary, allow = () => true) {
    const files = (await this.git('ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean);
    if (files.some(f => !allowedSource(f))) throw new Error('The Git index contains files outside the public source policy.');
    await validateSource(this.directory, files);
    await this.git('add', '--all', '--', ...files);
    const tree = await this.git('write-tree');
    const parent = await this.git('rev-parse', 'HEAD');
    const staged = (await this.git('ls-tree', '-r', '--name-only', '-z', tree)).split('\0').filter(Boolean);
    if (staged.some(f => !allowedSource(f))) throw new Error('Staged source contains a protected file.');
    const commit = await this.git('commit-tree', tree, '-p', parent, '-m', summary.slice(0, 200));
    const snapshot = path.join(stateDirectory, 'checkpoints', randomUUID());
    await fs.mkdir(path.dirname(snapshot), { recursive: true });
    await this.git('worktree', 'add', '--detach', snapshot, commit);
    await validateSource(snapshot, staged);
    await this.check(snapshot);
    if (!allow()) throw new Error('Automation paused before committing the checked snapshot.');
    if ((await this.git('rev-parse', 'HEAD^{tree}')) === tree) return { changed: false, commit: parent };
    await this.git('update-ref', 'refs/heads/main', commit, parent);
    return { changed: true, commit };
  }
  async push(allow = () => true) {
    // Git rejects a non-fast-forward push; conflicting main commits are never overwritten.
    await this.execute(executable('gh'), ['auth', 'setup-git', '--hostname', 'github.com']);
    if (!allow()) throw new Error('Automation paused before publication.');
    await this.git('push', 'origin', 'HEAD:refs/heads/main');
    return { commit: await this.git('rev-parse', 'HEAD'), branch: 'main' };
  }
  async stage({ current, latest }) {
    if (await this.git('status', '--porcelain')) throw new Error('Local source changes must be checkpointed before staging an update.');
    if (await fs.stat(path.join(stateDirectory, 'pending-update.json')).then(() => true, () => false)) throw new Error('An update is already waiting for restart.');
    const files = (await this.git('diff', '--name-only', '-z', current, latest)).split('\0').filter(Boolean);
    if (!files.length) return null;
    if (files.some(f => !allowedSource(f))) throw new Error('Remote changes include protected files.');
    const id = `${Date.now()}-${latest.slice(0, 12)}`, worktree = path.join(stateDirectory, 'updates', id, 'source');
    await fs.mkdir(path.dirname(worktree), { recursive: true });
    await this.git('worktree', 'add', '--detach', worktree, latest);
    const desired = await validateSource(worktree, files), expected = await validateSource(this.directory, files);
    await this.check(worktree);
    const pending = { version: 1, phase: 'pending', id, source: worktree, target: await fs.realpath(this.directory), base: current, commit: latest, files: files.map(file => ({ file, expected: expected[file], desired: desired[file] })), stagedAt: new Date().toISOString() };
    await atomic(path.join(stateDirectory, 'pending-update.json'), JSON.stringify(pending, null, 2));
    return pending;
  }
}
