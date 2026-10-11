import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProgress, noticeText, messageText, duration } from '../app/public/progress.js';

test('a running Codex process is not presented as an active job without an active turn', () => {
  assert.equal(describeProgress({ running: true }).active, false);
  assert.equal(describeProgress({ activeTurn: 'real-turn', automation: { phase: 'working', taskTitle: 'Runtime' } }).active, true);
  for (const phase of ['reviewing', 'checking', 'publishing']) assert.equal(describeProgress({ automation: { phase } }).active, true);
});

test('questions, saved pauses, prerequisites and disconnection have distinct waiting states', () => {
  assert.equal(describeProgress({ activeTurn: 'turn', approvals: [{}] }).phase, 'question');
  assert.equal(describeProgress({ automation: { phase: 'paused' } }).active, false);
  assert.equal(describeProgress({ automation: { phase: 'blocked' } }).active, false);
  assert.equal(describeProgress({ activeTurn: 'reply', automation: { phase: 'paused' } }).phase, 'replying');
  assert.equal(describeProgress({ activeTurn: 'turn' }, false).active, false);
  assert.equal(describeProgress({ automation: { phase: 'watching' } }).title, 'The saved work queue is finished');
});

test('the conversation summarizes patches and structured outcomes without exposing transport JSON', () => {
  assert.equal(noticeText({ files: [{ path: 'C:\\source\\app\\server.mjs', diff: 'large patch' }] }), 'Updated app/server.mjs');
  assert.equal(messageText('{"status":"progress","summary":"Verified the increment."}'), 'Verified the increment.');
  assert.equal(messageText('{"status"'), 'Preparing the work report…');
  assert.equal(duration(61000), '1m 1s');
  assert.equal(duration(-1000), '0s');
});
