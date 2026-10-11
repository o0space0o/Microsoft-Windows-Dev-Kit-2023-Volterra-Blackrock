import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexBridge } from '../app/codex.mjs';
import { outcomeSchema } from '../app/automation.mjs';

const bridge = new CodexBridge();
const project = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-codex-probe-'));
const report = { timestamp: new Date().toISOString(), tests: [], output: '' };
let finished;
const completion = new Promise(resolve => { finished = resolve; });
bridge.on('notification', ({ method, params }) => {
  if (method === 'item/agentMessage/delta') report.output += params.delta;
  if (method === 'turn/completed') finished(params.turn);
});
bridge.on('approval', request => bridge.reply(request.id, { decision: 'decline' }));
try {
  await bridge.start(); report.tests.push('Initialized real Codex app-server');
  const account = await bridge.request('account/read', { refreshToken: false });
  if (account.account?.type !== 'chatgpt') throw new Error('This computer has no Codex-managed ChatGPT sign-in.');
  report.tests.push('Codex reports ChatGPT authentication; no API key used');
  const thread = await bridge.request('thread/start', { cwd: project, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true });
  await bridge.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Return status complete and summary exactly Volterra connection verified. Do not use tools or change any files.', text_elements: [] }], outputSchema: outcomeSchema });
  const timer = setTimeout(() => finished({ status: 'timeout' }), 90_000);
  const turn = await completion; clearTimeout(timer);
  report.status = turn.status; report.error = turn.error?.message || null;
  if (turn.status !== 'completed') throw new Error(`Live inference did not complete (${turn.status}): ${report.error || ''}`);
  report.tests.push('Received real streamed agent text and a completed turn');
  const outcome = JSON.parse(report.output);
  if (outcome.status !== 'complete' || outcome.summary !== 'Volterra connection verified.') throw new Error('Structured automation outcome did not match.');
  report.tests.push('Validated the structured outcome used by the automatic queue');
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
finally {
  await bridge.stop(); await fs.mkdir('build/verification', { recursive: true });
  await fs.writeFile('build/verification/live-codex.json', JSON.stringify(report, null, 2));
  await fs.rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log(JSON.stringify(report, null, 2));
}
