import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { executable, redact } from './platform.mjs';
import { ensurePrivateState, managedAccountDirectory } from './private-state.mjs';

export class CodexBridge extends EventEmitter {
  constructor() { super(); this.pending = new Map(); this.counter = 0; this.approvals = new Map(); }
  async start(token) {
    if (this.child) return;
    await ensurePrivateState({ directory: managedAccountDirectory('codex'), scope: 'codex', create: true });
    const args = ['app-server', '--listen', 'stdio://', '-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"'];
    if (token) args.push('-c', 'model_provider="openai_chatgpt_plan"', '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"', '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"', '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"', '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"', '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false', '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false');
    const env = { ...process.env };
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    if (token) env.ACCESS_TOKEN = token;
    const child = spawn(executable('codex'), args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.once('error', error => this.fail(error));
    child.once('exit', code => { if (this.child === child) { this.child = null; this.fail(new Error(`Codex stopped (${code}).`)); this.emit('stopped'); } });
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch { this.emit('diagnostic', 'An unreadable Codex transport message was ignored.'); }
    });
    this.child.stderr.on('data', chunk => this.emit('diagnostic', redact(chunk.toString())));
    try {
      await this.request('initialize', { clientInfo: { name: 'volterra_workspace', title: 'Microsoft Volterra', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
    } catch (error) { this.stop(); throw error; }
  }
  receive(message) {
    if (message.method && message.id !== undefined) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'].includes(message.method)) {
        this.approvals.set(String(message.id), message);
        this.emit('approval', { id: String(message.id), method: message.method, params: message.params });
      } else this.write({ id: message.id, error: { code: -32601, message: 'This client does not implement that request.' } });
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    } else if (message.method) this.emit('notification', message);
  }
  write(value) { if (!this.child?.stdin.writable) throw new Error('Codex is not running.'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error('Codex is not running.')); return; }
      const id = ++this.counter;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex did not acknowledge ${method}.`)); }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  reply(id, result) {
    const message = this.approvals.get(String(id));
    if (!message) throw new Error('This request is no longer pending.');
    this.write({ id: message.id, result }); this.approvals.delete(String(id));
  }
  fail(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); this.approvals.clear(); }
  async stop() {
    const child = this.child;
    if (!child) return;
    await new Promise(resolve => {
      child.once('exit', resolve);
      if (!child.kill()) resolve();
    });
    if (this.child === child) this.child = null;
    this.fail(new Error('Codex was stopped.'));
  }
}
