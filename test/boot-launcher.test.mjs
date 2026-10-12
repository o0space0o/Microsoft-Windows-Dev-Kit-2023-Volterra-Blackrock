import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, volumeIdentity, ownedPath, selectPersistentStorage, prepareBootPaths, writeLaunchEvidence } from '../scripts/Start-Volterra.mjs';
import { fixturePrivateState } from './fixture-private-state.mjs';

const volume = '\\\\?\\Volume{741d77ce-a5ee-4544-a158-b62783007d27}\\';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-boot-'));
  t.after(async () => {
    const real = await fs.realpath(directory), relative = path.relative(await fs.realpath(os.tmpdir()), real);
    assert.ok(relative.startsWith('volterra-boot-') && !relative.includes(path.sep));
    await fs.rm(real, { recursive: true, force: true });
  });
  const systemRoot = path.join(directory, 'ramdisk');
  const persistent = path.join(directory, 'persistent');
  const root = path.join(systemRoot, 'Volterra');
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(persistent);
  await fs.writeFile(path.join(persistent, 'Volterra-persistent.tag'), 'Development test');
  return { directory, systemRoot, persistent, root, privacy: fixturePrivateState(directory) };
}

test('startup invokes staged Node directly without changing script policy', async () => {
  const source = await fs.readFile(fileURLToPath(new URL('../image/Volterra-Startup.cmd', import.meta.url)), 'utf8');
  assert.match(source, /"%VOLTERRA_ROOT%\\private\\tools\\node\.exe" "%VOLTERRA_ROOT%\\scripts\\Start-Volterra\.mjs" --boot/);
  assert.doesNotMatch(source, /powershell|executionpolicy|encodedcommand|\bIEX\b/i);
  assert.deepEqual(parseArguments(['--boot', '--port', '43123']), { boot: true, noBrowser: false, port: 43123 });
  for (const arguments_ of [['--port', '0'], ['--port', '65536'], ['--port', '43123;cmd'], ['--boot', '--boot'], ['--policy', 'bypass']]) assert.throws(() => parseArguments(arguments_));
});

test('persistent volume identity requires one exact local volume GUID', () => {
  assert.equal(volumeIdentity(`    ${volume}\r\n`), volume);
  for (const value of ['C:\\', '\\\\server\\share', `${volume}\n${volume}`, 'The system cannot find the path specified.', '\\\\?\\Volume{invalid}\\']) assert.throws(() => volumeIdentity(value));
});

test('RAM boot chooses one marked writable volume and isolates state from OS source', async t => {
  const f = await fixture(t); const calls = [];
  const result = await prepareBootPaths({ ...f, ramdisk: true, edition: 'WinVOS', roots: [f.systemRoot, f.persistent, path.join(f.directory, 'missing')], readVolume: async root => { calls.push(root); return volume; } });
  assert.equal(result.systemRoot, f.systemRoot); assert.equal(result.storageRoot, f.persistent);
  assert.equal(result.stateDirectory, path.join(f.persistent, 'VolterraState'));
  assert.equal(result.projectRootPersistent, false); assert.equal(result.volume, volume);
  assert.deepEqual(calls, [f.persistent]);
  assert.deepEqual((await fs.readdir(result.stateDirectory)).sort(), ['browser', 'codex', 'github']);
});

test('OS root mode refuses another edition and an unrelated payload before creating state', async t => {
  const f = await fixture(t); const options = { ...f, ramdisk: true, roots: [f.persistent], readVolume: async () => volume };
  await assert.rejects(prepareBootPaths({ ...options, edition: 'Professional' }), /Validation OS/);
  await assert.rejects(prepareBootPaths({ ...options, edition: 'WinVOS', root: f.persistent }), /this OS root/);
  await assert.rejects(fs.access(path.join(f.persistent, 'VolterraState')), { code: 'ENOENT' });
});

test('RAM boot refuses absent or ambiguous markers and network storage identity', async t => {
  const f = await fixture(t);
  await assert.rejects(selectPersistentStorage({ systemRoot: f.systemRoot, roots: [f.systemRoot], readVolume: async () => volume }), /No marked/);
  const second = path.join(f.directory, 'second'); await fs.mkdir(second); await fs.writeFile(path.join(second, 'Volterra-persistent.tag'), 'Second');
  await assert.rejects(selectPersistentStorage({ systemRoot: f.systemRoot, roots: [f.persistent, second], readVolume: async () => volume }), /Multiple marked/);
  await assert.rejects(selectPersistentStorage({ systemRoot: f.systemRoot, roots: [f.persistent], readVolume: async () => '\\\\server\\share' }), /local Windows volume/);
});

test('redirected state directories and linked markers cannot receive writes', async t => {
  const f = await fixture(t); const external = path.join(f.directory, 'external'); await fs.mkdir(external);
  await fs.symlink(external, path.join(f.persistent, 'VolterraState'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareBootPaths({ ...f, ramdisk: true, edition: 'WinVOS', roots: [f.persistent], readVolume: async () => volume }), /redirected/);
  assert.deepEqual(await fs.readdir(external), []);
  const marker = path.join(f.persistent, 'Volterra-persistent.tag');
  await fs.link(marker, path.join(f.directory, 'external-marker'));
  await assert.rejects(selectPersistentStorage({ systemRoot: f.systemRoot, roots: [f.persistent], readVolume: async () => volume }), /multiple links/);
});

test('launcher evidence cannot declare runtime acceptance and refuses hardlinked destination', async t => {
  const f = await fixture(t); const state = path.join(f.persistent, 'VolterraState'); await fs.mkdir(state);
  await writeLaunchEvidence(state, { stage: 'Listening', helperListening: true, bootAccepted: true, runtimeAccepted: true, physicalHardwareAccepted: true }, { privacy: f.privacy });
  const evidence = JSON.parse(await fs.readFile(path.join(state, 'boot-launch.json'), 'utf8'));
  assert.equal(evidence.helperListening, true);
  assert.equal(evidence.bootAccepted, false); assert.equal(evidence.runtimeAccepted, false); assert.equal(evidence.physicalHardwareAccepted, false);
  const external = path.join(f.directory, 'external-evidence'); await fs.link(path.join(state, 'boot-launch.json'), external);
  const original = await fs.readFile(external);
  await assert.rejects(writeLaunchEvidence(state, { stage: 'Stopped' }, { privacy: f.privacy }), /multiple links/);
  assert.deepEqual(await fs.readFile(external), original);
  await assert.rejects(ownedPath(external), /multiple links/);
});

test('boot privacy refusal occurs before creating state or a write witness', async t => {
  const f = await fixture(t); let checked = 0;
  await assert.rejects(prepareBootPaths({ ...f, ramdisk: true, edition: 'WinVOS', roots: [f.persistent], readVolume: async () => volume,
    privacy: async options => { checked++; assert.equal(options.directory, path.join(f.persistent, 'VolterraState')); assert.equal(options.volume, volume); assert.equal(options.create, true); throw new Error('Fixture privacy refused.'); } }), /privacy refused/);
  assert.equal(checked, 1);
  await assert.rejects(fs.access(path.join(f.persistent, 'VolterraState')), { code: 'ENOENT' });
});

test('evidence privacy refusal preserves existing bytes and creates no temporary file', async t => {
  const f = await fixture(t); const state = path.join(f.persistent, 'VolterraState'); await fs.mkdir(state);
  const file = path.join(state, 'boot-launch.json'); const original = Buffer.from('{"private":"fixture"}'); await fs.writeFile(file, original);
  await assert.rejects(writeLaunchEvidence(state, { stage: 'Listening' }, { privacy: async () => { throw new Error('Fixture privacy refused.'); } }), /privacy refused/);
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual(await fs.readdir(state), ['boot-launch.json']);
});
