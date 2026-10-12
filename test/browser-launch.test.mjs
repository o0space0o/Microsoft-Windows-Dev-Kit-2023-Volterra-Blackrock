import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { browserAddress, githubBrowserCommand, openSystemBrowser } from '../scripts/Open-Browser.mjs';
import { fixturePrivateState } from './fixture-private-state.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-browser-'));
const privacy = fixturePrivateState(directory);
const profile = path.join(directory, 'VolterraState', 'browser');
test.after(async () => {
  const root = path.resolve(directory);
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('volterra-browser-'));
  const entry = await fs.lstat(root);
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
  assert.equal(path.resolve(await fs.realpath(root)), root);
  await fs.rm(root, { recursive: true });
});

test('official authorization URLs remain one literal browser argument without shell execution', async () => {
  const calls = [];
  const url = 'https://auth.openai.com/authorize?state=a%26b&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback';
  const browser = await openSystemBrowser(url, {
    root: path.resolve('fixture root'), profile, privacy, existsImpl: () => true,
    spawnImpl(executable, args, options) {
      calls.push({ executable, args, options });
      const child = new EventEmitter(); child.pid = 123; child.unref = () => {};
      queueMicrotask(() => child.emit('spawn')); return child;
    }
  });
  assert.equal(browser.started, true);
  assert.equal(calls[0].args.at(-1), url);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, false);
  assert.equal(calls[0].args.filter(arg => arg.startsWith('--user-data-dir=')).length, 1);
  assert.equal(calls[0].args.some(arg => /sandbox|ExecutionPolicy|IEX/i.test(arg)), false);
});

test('missing or rejected browser launch does not claim sign-in or expose authorization state', async () => {
  await assert.rejects(openSystemBrowser('https://github.com/login/device', { existsImpl: () => false }), /unavailable/);
  await assert.rejects(openSystemBrowser('https://auth.openai.com/authorize?state=secret', {
    root: path.resolve('.'), profile, privacy, existsImpl: () => true,
    spawnImpl() { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('secret URL'))); return child; }
  }), error => error.message === 'The staged system browser could not start.');
  for (const value of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'http://example.com', 'https://user:password@github.com', 'https://github.com/\nlogin']) assert.throws(() => browserAddress(value));
});

test('GitHub browser command quotes paths for its direct argv launcher', () => {
  const command = githubBrowserCommand('C:/Program files/node.exe', "C:/Kevin's project/Open-Browser.mjs");
  assert.equal(command, "'C:/Program files/node.exe' 'C:/Kevin'\\''s project/Open-Browser.mjs'");
  assert.doesNotMatch(command, /powershell|cmd\.exe|ExecutionPolicy|IEX/i);
});

test('browser privacy refusal prevents process creation without exposing authorization state', async () => {
  let launched = false;
  await assert.rejects(openSystemBrowser('https://auth.openai.com/authorize?state=PRIVATE_FIXTURE', {
    profile, existsImpl: () => true, privacy: async () => { throw new Error('Private fixture refused.'); },
    spawnImpl() { launched = true; throw new Error('Unexpected process creation'); }
  }), error => error.message === 'Private fixture refused.');
  assert.equal(launched, false);
});
