import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-conversation-ui-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.VOLTERRA_AUTOSTART = '0';
delete process.env.VOLTERRA_OS_ROOT;
const { createApplication } = await import('../app/server.mjs');
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [process.env.VOLTERRA_TEST_MODULES] }));
class FixtureCodex extends EventEmitter {
  replies = [];
  async start() { this.child = {}; }
  async stop() { this.child = null; }
  reply(id, result) { this.replies.push({ id, result }); }
  async request(method) {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'fixture-thread' } };
    if (method === 'turn/start') return { turn: { id: 'fixture-turn' } };
    return {};
  }
}
const codex = new FixtureCodex();
const application = await createApplication({ port: 0, autostart: false, codex });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  await application.actions['codex/connect']();
  await application.actions['agent/send']({ text: 'Check the conversation fixture.' });
  const page = await browser.newPage({ viewport: { width: 703, height: 884 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(application.origin + '/?screen=connections');
  await page.getByRole('heading', { name: 'Codex is working', exact: true }).waitFor();
  assert.equal(await page.locator('#workspace button').count(), 1);
  assert.equal(await page.locator('#workspace').getAttribute('data-active'), 'true');
  const before = await page.locator('#activity-clock').textContent();
  await page.waitForFunction(before => document.querySelector('#activity-clock').textContent !== before, before);
  codex.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'fixture-thread', itemId: 'stream', delta: 'The live message reached the conversation.' } });
  await page.getByText('The live message reached the conversation.', { exact: true }).waitFor();
  codex.emit('approval', { id: 'question', method: 'item/tool/requestUserInput', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', questions: [{ id: 'artwork', question: 'Keep the approved images unchanged?' }] } });
  await page.getByRole('heading', { name: 'Codex needs your answer', exact: true }).waitFor();
  assert.equal(await page.locator('#workspace button').count(), 1);
  await page.getByRole('textbox', { name: 'Message to Codex', exact: true }).fill('Keep them unchanged.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('heading', { name: 'Codex is working', exact: true }).waitFor();
  assert.deepEqual(codex.replies, [{ id: 'question', result: { answers: { artwork: { answers: ['Keep them unchanged.'] } } } }]);
  const journal = await fs.readFile(path.join(directory, 'state/journal.jsonl'), 'utf8');
  assert.match(journal, /Keep the approved images unchanged/); assert.match(journal, /Keep them unchanged/);
  codex.emit('notification', { method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } });
  await page.getByRole('heading', { name: 'Ready for your message', exact: true }).waitFor();
  assert.equal(await page.locator('#workspace').getAttribute('data-active'), 'false');
  assert.deepEqual(errors, []);
  await fs.mkdir('build/verification', { recursive: true });
  await fs.writeFile('build/verification/conversation-ui.json', JSON.stringify({ passed: true, fixtureOnly: true, checks: ['Only chat send control', 'Actual streamed messages', 'Elapsed activity changes', 'Question answered through chat', 'Question and reply persisted', 'Completion removes running state', 'No browser errors'] }, null, 2));
  console.log('Conversation UI fixture passed: streaming, timer, chat replies, persistence and stopped state.');
} finally { await browser.close(); await application.close(); }
