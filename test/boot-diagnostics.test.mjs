import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLauncherDiagnostics } from '../app/boot-diagnostics.mjs';
import { ownedPath } from '../scripts/Start-Volterra.mjs';
import { fixturePrivateState } from './fixture-private-state.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-diagnostics-'));
  const systemRoot = path.join(directory, 'ram'), storageRoot = path.join(directory, 'persistent');
  const stateDirectory = path.join(storageRoot, 'VolterraState'), root = path.join(storageRoot, 'Volterra');
  const source = path.join(systemRoot, 'Windows', 'Temp', 'VolterraLauncher');
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(stateDirectory, { recursive: true }); await fs.mkdir(root);
  const handles = [], timer = { callback: null, unrefCalls: 0, cancelled: 0 };
  const options = { boot: { systemRoot, storageRoot, stateDirectory, ramdisk: true, projectRootPersistent: true, volume: '\\\\?\\Volume{741d77ce-a5ee-4544-a158-b62783007d27}\\' }, root, guard: ownedPath,
    privacy: fixturePrivateState(directory), interval: (callback, duration) => { assert.equal(duration, 15000); timer.callback = callback; return { unref() { timer.unrefCalls++; } }; }, cancel: () => { timer.cancelled++; } };
  t.after(async () => {
    for (const handle of handles) await handle.stop();
    const real = await fs.realpath(directory), relative = path.relative(await fs.realpath(os.tmpdir()), real);
    assert.ok(relative.startsWith('volterra-diagnostics-') && !relative.includes(path.sep));
    await fs.rm(real, { recursive: true, force: true });
  });
  const start = (override = {}) => { const handle = startLauncherDiagnostics({ ...options, ...override }); handles.push(handle); return handle; };
  const read = async (name = 'native-launcher-logs.json') => JSON.parse(await fs.readFile(path.join(stateDirectory, name), 'utf8'));
  return { directory, source, stateDirectory, root, options, timer, start, read };
}

test('captures only bounded tails of the newest native launcher names in private state', async t => {
  const f = await fixture(t), privacyCalls = [];
  for (let index = 1; index <= 6; index++) {
    const name = `launcher-42-${index}${index % 2 ? '' : '-node'}.log`, file = path.join(f.source, name);
    await fs.writeFile(file, `${'a'.repeat(70000)}tail-${index}`);
    await fs.utimes(file, index, index);
  }
  await fs.writeFile(path.join(f.source, 'auth.json'), 'Unrelated content');
  await fs.writeFile(path.join(f.source, 'launcher-42-7.log.backup'), 'Unrelated content');
  const capture = f.start({ privacy: async options => { privacyCalls.push(options); return f.options.privacy(options); } });
  assert.equal((await capture.flush()).status, 'captured');
  const value = await f.read();
  assert.equal(value.systemRoot, f.options.boot.systemRoot); assert.equal(value.sourceDirectory, f.source);
  assert.equal(value.logs.length, 4);
  assert.deepEqual(value.logs.map(log => log.name), ['launcher-42-6-node.log', 'launcher-42-5.log', 'launcher-42-4-node.log', 'launcher-42-3.log']);
  for (const log of value.logs) { assert.equal(Buffer.byteLength(log.text), 65536); assert.equal(log.offset + 65536, log.sourceBytes); assert.match(log.text, /tail-[3-6]$/); }
  assert.equal(JSON.stringify(value).includes('Unrelated content'), false);
  assert.equal(privacyCalls[0].directory, f.stateDirectory); assert.equal(privacyCalls[0].root, f.root); assert.equal(privacyCalls[0].scope, 'state');
  assert.equal(f.timer.unrefCalls, 1);
});

test('periodic refresh and final failure capture keep one prior launch snapshot', async t => {
  const f = await fixture(t), log = path.join(f.source, 'launcher-42-10-node.log');
  await fs.writeFile(log, 'First startup');
  const first = f.start(); await first.flush(); await first.stop();
  const previous = await fs.readFile(path.join(f.stateDirectory, 'native-launcher-logs.json'));
  await fs.appendFile(log, '\nSecond startup');
  const second = f.start(); await second.flush();
  assert.deepEqual(await fs.readFile(path.join(f.stateDirectory, 'native-launcher-logs.previous.json')), previous);
  await fs.appendFile(log, '\nLater progress'); f.timer.callback(); await second.flush();
  assert.match((await f.read()).logs[0].text, /Later progress$/);
  await second.stop(new Error('x'.repeat(3000)));
  const final = await f.read();
  assert.equal(final.startupFailure.length, 2048);
  await second.stop(); assert.equal((await f.read()).startupFailure.length, 2048);
  assert.deepEqual(await fs.readFile(path.join(f.stateDirectory, 'native-launcher-logs.previous.json')), previous);
  assert.deepEqual((await fs.readdir(f.stateDirectory)).sort(), ['native-launcher-logs.json', 'native-launcher-logs.previous.json']);
});

test('privacy refusal is best effort and cannot write a snapshot', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'launcher-42-10.log'), 'Native output');
  const capture = f.start({ privacy: async () => { throw new Error('Privacy unavailable'); } });
  assert.equal((await capture.flush()).status, 'unavailable');
  assert.equal((await capture.stop(new Error('Setup failed'))).status, 'unavailable');
  assert.deepEqual(await fs.readdir(f.stateDirectory), []);
});

test('source and destination hardlinks fail closed without modifying their targets', async t => {
  const f = await fixture(t), outside = path.join(f.directory, 'retained.txt');
  await fs.writeFile(outside, 'Retained bytes');
  const source = path.join(f.source, 'launcher-42-10.log'); await fs.link(outside, source);
  const linkedSource = f.start(); assert.equal((await linkedSource.flush()).status, 'unavailable'); await linkedSource.stop();
  await fs.unlink(source); await fs.writeFile(source, 'Native output');
  await fs.link(outside, path.join(f.stateDirectory, 'native-launcher-logs.json'));
  const linkedDestination = f.start(); assert.equal((await linkedDestination.flush()).status, 'unavailable'); await linkedDestination.stop();
  assert.equal(await fs.readFile(outside, 'utf8'), 'Retained bytes');
  assert.equal((await fs.readdir(f.stateDirectory)).length, 1);
});

test('a redirected source directory and state inside RAM are refused', async t => {
  const f = await fixture(t), alternate = path.join(f.directory, 'other');
  await fs.mkdir(alternate); await fs.writeFile(path.join(alternate, 'launcher-42-10.log'), 'Other bytes');
  await fs.rmdir(f.source); await fs.symlink(alternate, f.source, 'junction');
  const redirected = f.start(); assert.equal((await redirected.flush()).status, 'unavailable'); await redirected.stop();
  await fs.unlink(f.source); await fs.mkdir(f.source); await fs.writeFile(path.join(f.source, 'launcher-42-10.log'), 'Native output');
  const invalid = f.start({ boot: { ...f.options.boot, storageRoot: f.options.boot.systemRoot, stateDirectory: path.join(f.options.boot.systemRoot, 'VolterraState') } });
  assert.equal((await invalid.flush()).status, 'unavailable');
  assert.deepEqual(await fs.readdir(f.stateDirectory), []);
});

test('excess directory entries cannot produce an unbounded snapshot', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'launcher-42-10.log'), 'Native output');
  await Promise.all(Array.from({ length: 256 }, (_, index) => fs.writeFile(path.join(f.source, `unrelated-${index}`), '')));
  const capture = f.start(); assert.equal((await capture.flush()).status, 'unavailable');
  assert.deepEqual(await fs.readdir(f.stateDirectory), []);
});
