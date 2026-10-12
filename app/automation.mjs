import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, stateDirectory } from './storage.mjs';
import { Repository } from './repository.mjs';
import { root } from './platform.mjs';
import { ensurePrivateState } from './private-state.mjs';

export const outcomeSchema = {
  type: 'object', additionalProperties: false,
  properties: { status: { type: 'string', enum: ['progress', 'complete', 'blocked'] }, summary: { type: 'string' } },
  required: ['status', 'summary']
};

const inFlightPhases = ['starting', 'working', 'reviewing', 'reviewing-update', 'checking', 'publishing'];
const savedPhases = new Set([...inFlightPhases, 'idle', 'paused', 'blocked', 'restart-pending', 'waiting-for-sign-in', 'watching']);
const recoveryNotice = 'The saved automation queue was invalid. Its original bytes were preserved privately, and automatic work is disabled and paused. You can reply in this conversation.';
const initialState = enabled => ({ version: 1, enabled, paused: false, phase: 'idle', task: 0, failures: 0, pendingOutcome: null, reviewPassed: false, lastCommit: null, lastError: null });

function validSavedState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean'
    || !Number.isSafeInteger(value.task) || value.task < 0 || !savedPhases.has(value.phase)
    || (value.phase === 'paused' && !value.paused)) return false;
  if (value.failures !== undefined && (!Number.isSafeInteger(value.failures) || value.failures < 0)) return false;
  if (value.reviewPassed !== undefined && typeof value.reviewPassed !== 'boolean') return false;
  if (value.lastError !== undefined && value.lastError !== null && typeof value.lastError !== 'string') return false;
  if (value.pendingOutcome !== undefined && value.pendingOutcome !== null
    && (!value.pendingOutcome || typeof value.pendingOutcome !== 'object' || Array.isArray(value.pendingOutcome)
      || !['progress', 'complete', 'blocked'].includes(value.pendingOutcome.status) || typeof value.pendingOutcome.summary !== 'string')) return false;
  return true;
}

async function readSavedBytes(handle) {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 2n * 1024n * 1024n) throw new Error('The saved automation queue is not a bounded ordinary file.');
  const buffer = Buffer.alloc(Number(before.size) + 1); let count = 0;
  while (count < buffer.length) {
    const read = await handle.read(buffer, count, buffer.length - count, count);
    if (!read.bytesRead) break;
    count += read.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (BigInt(count) !== before.size || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new Error('The saved automation queue changed while being read.');
  return { bytes: buffer.subarray(0, count), info: before };
}

async function assertSavedIdentity(file, info) {
  await assertSavedPath(file);
  const current = await fs.lstat(file, { bigint: true });
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => info[key] !== current[key])) throw new Error('The saved automation queue changed before recovery.');
}

async function assertSavedPath(file, allowMissing = false) {
  let current = path.resolve(file);
  while (true) {
    let info;
    try { info = await fs.lstat(current, { bigint: true }); }
    catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error; }
    if (!info) { const parent = path.dirname(current); if (parent === current) throw new Error('The saved automation queue has no ordinary parent.'); current = parent; continue; }
    if (info.isSymbolicLink() || path.relative(current, await fs.realpath(current)) !== ''
      || (current === path.resolve(file) ? !info.isFile() || info.nlink !== 1n : !info.isDirectory())) throw new Error('The saved automation queue path is redirected or not ordinary.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}

async function preserveInvalidState(file, bytes, info) {
  // Preserve exact bytes before the normal atomic writer can replace the queue.
  await assertSavedIdentity(file, info);
  const quarantine = path.join(path.dirname(file), `automation-state-quarantine-${randomUUID()}.json`);
  const copy = await fs.open(quarantine, 'wx+', 0o600);
  try {
    await copy.writeFile(bytes); await copy.sync();
    const preserved = await readSavedBytes(copy);
    if (!preserved.bytes.equals(bytes)) throw new Error('Saved queue preservation differs.');
    await assertSavedIdentity(quarantine, preserved.info);
    await assertSavedIdentity(file, info);
  } finally { await copy.close(); }
}

// Persist a bounded queue, rather than asking the model to run forever without evidence.
export class Automation {
  constructor({ config, repository, hooks, directory = stateDirectory, enabled = false, privacy = ensurePrivateState }) {
    this.config = config; this.repository = repository || new Repository({ config, privacy }); this.hooks = hooks; this.directory = directory; this.privacy = privacy;
    this.file = path.join(directory, 'automation-state.json'); this.enabled = enabled;
    this.saved = initialState(enabled);
    this.persistence = Promise.resolve(); this.busy = false; this.loaded = false;
  }
  async load() {
    await this.privacy({ directory: this.directory, scope: 'state', create: true, root });
    let handle, recovered = false;
    try { await assertSavedPath(this.file, true); handle = await fs.open(this.file, 'r'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (handle) {
      try {
        const { bytes, info } = await readSavedBytes(handle);
        await assertSavedIdentity(this.file, info);
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
        catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error; }
        if (validSavedState(value)) this.saved = { ...this.saved, ...value };
        else {
          this.saved = { ...initialState(false), paused: true, phase: 'paused', lastError: recoveryNotice,
            recovery: { version: 1, reason: 'invalid-saved-state', originalBytesPreserved: false } };
          try { await this.privacy({ directory: this.directory, scope: 'state', root }); await preserveInvalidState(this.file, bytes, info); }
          catch { throw new Error('The saved automation queue could not be preserved. Automatic work remains stopped.'); }
          this.saved.recovery.originalBytesPreserved = true; recovered = true;
        }
      } finally { await handle.close(); }
    }
    // A turn interrupted by power loss is resumed from the saved thread and task.
    if (inFlightPhases.includes(this.saved.phase)) this.saved.phase = 'idle';
    if (this.saved.phase === 'restart-pending') {
      try { const update = JSON.parse(await fs.readFile(path.join(path.dirname(this.file), 'last-update.json'), 'utf8')); if (update.phase === 'confirmed' && update.commit === this.saved.comparison?.latest) this.saved.phase = 'idle'; } catch {}
      try { const update = JSON.parse(await fs.readFile(path.join(path.dirname(this.file), 'pending-update.json'), 'utf8')); if (update.phase === 'rolled-back') { this.saved.phase = 'blocked'; this.saved.lastError = 'The helper update failed its startup health check and was rolled back. Previous files are retained.'; } } catch {}
    }
    await this.persist();
    this.loaded = true;
    if (recovered) this.hooks.notice?.(recoveryNotice);
  }
  snapshot() { return { ...this.saved, repository: this.config.repository, branch: 'main', taskTitle: this.config.tasks[this.saved.task]?.title || 'Maintenance', tasksRemaining: Math.max(0, this.config.tasks.length - this.saved.task) }; }
  persist() {
    const content = JSON.stringify(this.saved, null, 2);
    this.persistence = this.persistence.catch(() => {}).then(() => atomic(this.file, content, 0o600, { directory: this.directory, privacy: this.privacy }));
    this.hooks.changed?.(); return this.persistence;
  }
  async pause() { this.saved.paused = true; this.saved.phase = 'paused'; await this.persist(); }
  async resume() { this.saved.enabled = true; this.saved.paused = false; this.saved.lastError = null; this.saved.phase = 'idle'; this.saved.failures = 0; await this.persist(); await this.tick(); }
  async start() {
    await this.load();
    this.timer = setInterval(() => this.tick().catch(e => this.fail(e)), this.config.pollIntervalMs); this.timer.unref();
    await this.tick();
  }
  close() { clearInterval(this.timer); clearTimeout(this.next); }
  async fail(error) {
    this.saved.lastError = error.message; this.saved.phase = this.saved.paused ? 'paused' : 'blocked';
    await this.persist(); this.hooks.notice?.(`Automation needs attention: ${error.message}`);
  }
  async tick() {
    if (!this.loaded || this.busy || !this.saved.enabled || this.saved.paused || this.hooks.active()
      || inFlightPhases.includes(this.saved.phase) || ['blocked', 'restart-pending'].includes(this.saved.phase)) return;
    if (!this.hooks.connected()) { this.saved.phase = 'waiting-for-sign-in'; await this.persist(); return; }
    this.busy = true;
    try {
      await this.repository.initialize();
      const comparison = await this.repository.compare();
      this.saved.comparison = comparison; await this.persist();
      if (comparison.diverged) throw new Error('Local and GitHub main both changed. Codex must reconcile them before publishing.');
      if (comparison.behind) {
        this.saved.phase = 'reviewing-update'; await this.persist();
        await this.hooks.reviewRemote(comparison); return;
      }
      if (this.saved.pendingOutcome && !this.saved.reviewPassed) {
        this.saved.phase = 'reviewing'; await this.persist(); await this.hooks.review(this.saved.pendingOutcome); return;
      }
      if (comparison.ahead || this.saved.pendingOutcome) {
        const checkpoint = await this.repository.checkpoint(this.saved.pendingOutcome?.summary || 'Validate saved Volterra source changes', () => !this.saved.paused);
        this.saved.lastCommit = checkpoint.commit; this.saved.phase = 'publishing'; await this.persist();
        const pushed = await this.repository.push(() => !this.saved.paused); this.saved.lastCommit = pushed.commit;
        await this.acceptOutcome();
      }
      const task = this.config.tasks[this.saved.task];
      if (!task) { this.saved.phase = this.saved.blockedTasks?.length ? 'blocked' : 'watching'; await this.persist(); return; }
      this.saved.phase = 'working'; await this.persist();
      this.hooks.notice?.(`Automatic task: ${task.title}`);
      await this.hooks.work(task, this.saved);
    } catch (error) { await this.fail(error); }
    finally { this.busy = false; }
  }
  async completed(status, result) {
    if (!this.saved.enabled || !['working', 'reviewing', 'reviewing-update'].includes(this.saved.phase)) return;
    if (this.saved.paused || status === 'interrupted') { await this.pause(); return; }
    if (status !== 'completed') { await this.fail(new Error(`Codex turn ${status}; saved work is retained.`)); return; }
    let outcome;
    try { outcome = typeof result === 'string' ? JSON.parse(result) : result; }
    catch { await this.fail(new Error('Codex did not return a verifiable task outcome.')); return; }
    if (!outcome || !['progress', 'complete', 'blocked'].includes(outcome.status) || typeof outcome.summary !== 'string') { await this.fail(new Error('The automatic task outcome is invalid.')); return; }
    if (this.saved.phase === 'reviewing-update') {
      if (outcome.status !== 'complete') { await this.fail(new Error(outcome.summary)); return; }
      try {
        const pending = await this.repository.stage(this.saved.comparison);
        this.saved.phase = pending ? 'restart-pending' : 'idle'; await this.persist();
        this.hooks.notice?.(pending ? 'Reviewed and tested helper update staged. Restart required to apply it.' : 'No source update is needed.');
      } catch (error) { await this.fail(error); }
      return;
    }
    if (this.saved.phase === 'working') {
      this.saved.pendingOutcome = outcome; this.saved.reviewPassed = false; this.saved.phase = 'reviewing'; await this.persist();
      await this.hooks.review(outcome); return;
    }
    if (outcome.status !== 'complete') {
      this.saved.failures++;
      this.saved.lastError = outcome.summary;
      this.saved.pendingOutcome = null; this.saved.reviewPassed = false;
      if (this.saved.failures >= this.config.retryLimit) { await this.fail(new Error(outcome.summary)); return; }
      this.saved.phase = 'idle'; await this.persist(); this.schedule(); return;
    }
    this.saved.reviewPassed = true; this.saved.phase = 'checking'; await this.persist();
    try {
      const checkpoint = await this.repository.checkpoint(this.saved.pendingOutcome.summary, () => !this.saved.paused);
      if (!checkpoint.changed && this.saved.pendingOutcome.status === 'progress') throw new Error('Codex reported progress without a source change. The queue is stopped until there is concrete work to continue.');
      this.saved.lastCommit = checkpoint.commit; this.saved.phase = 'publishing'; await this.persist();
      const pushed = await this.repository.push(() => !this.saved.paused); this.saved.lastCommit = pushed.commit;
      this.hooks.notice?.(`Verified source checkpoint published to main: ${pushed.commit}`);
      await this.acceptOutcome();
      if (this.saved.phase !== 'blocked') this.schedule();
    } catch (error) { await this.fail(error); }
  }
  async acceptOutcome() {
    const outcome = this.saved.pendingOutcome;
    if (outcome?.status === 'complete' || outcome?.status === 'blocked') this.saved.task++;
    if (outcome?.status === 'blocked') { this.saved.blockedTasks ||= []; this.saved.blockedTasks.push({ id: this.config.tasks[this.saved.task - 1]?.id, reason: outcome.summary }); }
    this.saved.phase = 'idle';
    this.saved.lastError = outcome?.status === 'blocked' ? outcome.summary : null;
    this.saved.pendingOutcome = null; this.saved.reviewPassed = false; this.saved.failures = 0; await this.persist();
  }
  schedule() { clearTimeout(this.next); this.next = setTimeout(() => this.tick().catch(e => this.fail(e)), 1500); this.next.unref(); }
}

export async function readAutomationConfig() { return JSON.parse(await fs.readFile(path.join(root, 'automation.json'), 'utf8')); }
