import test from 'node:test';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-drive-test-'));
process.env.VOLTERRA_STATE_DIR = path.join(directory, 'state');
process.env.CODEX_HOME = path.join(directory, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(directory, 'state', 'github');
const statePrivacy = fixturePrivateState(directory);
const { driveQuery, collectDrives, inspectDrives, driveReport } = await import('../app/drive-tools.mjs');
const { createApplication: createApplicationChecked } = await import('../app/server.mjs');
const createApplication = options => createApplicationChecked({ statePrivacy, githubAccountReader: async () => { throw new Error('Fixture has no GitHub account.'); }, ...options });
const { describeProgress } = await import('../app/public/progress.js');
const reading = (patch = {}) => ({ id: 'C:', driveType: 3, label: 'Workspace', fileSystem: 'NTFS', totalBytes: '9007199254740993', freeBytes: '30', ...patch });
const evidence = (patch = {}) => ({ version: 1, kind: 'drives', status: 'passed', error: null, observedAt: '2026-10-11T18:00:00.0000000Z',
  system: { edition: 'Professional', build: 'fixture', architecture: 'ARM64' }, drives: [reading()], ...patch });
const blocked = result => {
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.drives, []);
  assert.equal(result.totalCount, undefined); assert.equal(result.matchedCount, undefined);
  assert.match(driveReport(result), /Logical drive inventory is blocked/);
};

class FakeCodex extends EventEmitter {
  calls = [];
  async start() { this.child = {}; }
  async stop() { this.child = null; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.invalid' } };
    if (method === 'thread/start') return { thread: { id: 'fixture-thread' } };
    if (method === 'turn/start') return { turn: { id: 'fixture-turn' } };
    return {};
  }
}

test('drive intent accepts fixed local inventory with bounded literal filters', () => {
  for (const message of ['drives', 'show drives', 'list logical drives', ' SHOW LOGICAL DRIVES ']) assert.deepEqual(driveQuery(message), { filter: '' });
  assert.deepEqual(driveQuery('show drives matching C:'), { filter: 'C:' });
  assert.deepEqual(driveQuery('show drives matching .*; format A:'), { filter: '.*; format A:' });
  for (const message of ['format drives', 'show drives on another host', 'show drives; format', 'drives\ncommands', '', null, 1]) assert.equal(driveQuery(message), null);
  assert.throws(() => driveQuery('show drives matching ' + 'x'.repeat(257)), /up to 256/);
  assert.throws(() => driveQuery('show drives matching bad\u0000filter'), /up to 256/);
});

test('the collector invokes only the fixed original script without supplied filters or hosts', async () => {
  let calls = 0;
  const result = await collectDrives({ shell: 'fixture-powershell', execute: async (shell, args, options) => {
    calls++; assert.equal(shell, 'fixture-powershell');
    assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/Get-DriveInventory.ps1')]);
    assert.equal(args.length, 4); assert.deepEqual(options, { timeout: 15_000 });
    return '\uFEFF' + JSON.stringify(evidence());
  } });
  assert.equal(calls, 1); assert.deepEqual(result, evidence());
});

test('missing APIs, denied transport, malformed JSON and null failures are blocked', async () => {
  let calls = 0;
  await assert.rejects(collectDrives({ shell: null, execute: async () => { calls++; } }), /PowerShell.*CIM provider/);
  assert.equal(calls, 0);
  for (const collect of [async () => null, async () => { throw null; }, async () => { throw undefined; },
    () => collectDrives({ shell: 'fixture', execute: async () => '{invalid' }),
    () => collectDrives({ shell: 'fixture', execute: async () => { throw new Error('Script execution denied. Bearer fixture-secret'); } })]) {
    const result = await inspectDrives('', collect); blocked(result); assert.ok(result.error.stage); assert.ok(result.error.message);
    assert.doesNotMatch(driveReport(result), /fixture-secret/);
  }
});

test('logical drives sort by letter and filter names, filesystems and types literally', async () => {
  const collect = async () => evidence({ drives: [reading({ id: 'z:', driveType: 4, label: 'Shared.*', fileSystem: null }), reading(),
    reading({ id: 'D:', driveType: 5, label: null, fileSystem: null, totalBytes: null, freeBytes: null })] });
  const result = await inspectDrives('', collect);
  assert.equal(result.status, 'passed'); assert.deepEqual(result.drives.map(item => item.id), ['C:', 'D:', 'Z:']);
  assert.equal(result.totalCount, 3); assert.equal(result.matchedCount, 3);
  for (const [filter, expected] of [['c:', ['C:']], ['NTFS', ['C:']], ['network', ['Z:']], ['.*', ['Z:']], ['[CZ]', []]]) {
    const filtered = await inspectDrives(filter, collect);
    assert.equal(filtered.totalCount, 3); assert.deepEqual(filtered.drives.map(item => item.id), expected); assert.equal(filtered.matchedCount, expected.length);
  }
});

test('capacity bytes retain uint64 precision, real zero and independently unreported properties', async () => {
  const maximum = '18446744073709551615';
  for (const [totalBytes, freeBytes, usedBytes] of [[maximum, '1', '18446744073709551614'], ['0', '0', '0'], ['1', '0', '1'],
    [null, null, null], [null, '0', null], ['1', null, null]]) {
    const result = await inspectDrives('', async () => evidence({ drives: [reading({ totalBytes, freeBytes })] }));
    assert.equal(result.status, 'passed'); assert.equal(result.drives[0].totalBytes, totalBytes);
    assert.equal(result.drives[0].freeBytes, freeBytes); assert.equal(result.drives[0].usedBytes, usedBytes);
  }
  const precise = await inspectDrives('', async () => evidence());
  assert.equal(precise.drives[0].usedBytes, '9007199254740963');
});

test('unknown drive types, blank labels and absent filesystems remain separate readings', async () => {
  for (let driveType = 0; driveType <= 6; driveType++) {
    const result = await inspectDrives('', async () => evidence({ drives: [reading({ driveType, label: '', fileSystem: null })] }));
    assert.equal(result.status, 'passed'); assert.equal(result.drives[0].driveType, driveType); assert.equal(result.drives[0].label, '');
    assert.equal(result.drives[0].fileSystem, null); assert.match(driveReport(result), /No label reported.*Filesystem: Unreported/);
  }
});

test('missing rows cannot inflate counts or hide behind literal filters', async () => {
  for (const drives of [new Array(1), [null], [undefined], [reading(), , reading({ id: 'D:' })]]) {
    for (const filter of ['', 'no matching drive']) blocked(await inspectDrives(filter, async () => evidence({ drives })));
  }
  for (const field of ['id', 'driveType', 'label', 'fileSystem', 'totalBytes', 'freeBytes']) {
    const item = reading(); delete item[field]; blocked(await inspectDrives('', async () => evidence({ drives: [item] })));
  }
});

test('duplicate identities, invalid byte counts and inconsistent capacities are rejected', async () => {
  blocked(await inspectDrives('', async () => evidence({ drives: [reading(), reading({ id: 'c:' })] })));
  for (const patch of [{ id: 'C:\\' }, { id: '\\\\server\\share' }, { id: 'AA:' }, { driveType: -1 }, { driveType: 7 }, { driveType: null },
    { driveType: '3' }, { label: 'x'.repeat(513) }, { label: 'bad\nlabel' }, { fileSystem: 'x'.repeat(129) },
    { totalBytes: '18446744073709551616' }, { totalBytes: '01' }, { totalBytes: 1024 }, { freeBytes: '-1' }, { freeBytes: '1.5' },
    { totalBytes: '1', freeBytes: '2' }]) blocked(await inspectDrives('', async () => evidence({ drives: [reading(patch)] })));
});

test('success needs complete consistent evidence while genuine empty inventory remains valid', async () => {
  for (const patch of [{ version: 2 }, { kind: 'storage' }, { status: undefined }, { status: 'unknown' }, { error: undefined }, { error: false },
    { error: { stage: 'Query', message: 'Denied' } }, { observedAt: 'invalid' }, { observedAt: 'x'.repeat(41) }, { system: null },
    { system: { ...evidence().system, build: 'x'.repeat(129) } }, { drives: {} }, { drives: new Array(27) }]) blocked(await inspectDrives('', async () => evidence(patch)));
  const result = await inspectDrives('', async () => evidence({ drives: [] }));
  assert.equal(result.status, 'passed'); assert.equal(result.totalCount, 0); assert.match(driveReport(result), /No logical drives were reported/);
});

test('explicit provider failures keep redacted bounded diagnostics and forbid partial drives', async () => {
  const failed = evidence({ status: 'blocked', drives: [], error: { stage: 'Local drive query', message: 'Denied. Bearer fixture-secret ' + 'x'.repeat(900) } });
  const result = await inspectDrives('', async () => failed); blocked(result);
  assert.equal(result.observedAt, failed.observedAt); assert.equal(result.error.stage, 'Local drive query');
  assert.ok(result.error.message.length <= 512); assert.doesNotMatch(driveReport(result), /fixture-secret/);
  for (const patch of [{ drives: [reading({ freeBytes: '0' })] }, { error: null }, { error: {} },
    { error: { stage: ' ', message: 'Denied' } }, { error: { stage: 'Query', message: ' ' } }]) {
    const invalid = await inspectDrives('', async () => ({ ...failed, ...patch })); blocked(invalid); assert.match(invalid.error.message, /ambiguous failure evidence/);
  }
});

test('saved reports exclude serials, share paths, credentials and caller installation claims', async () => {
  const secret = 'Private fixture metadata';
  const result = await inspectDrives('', async () => evidence({ providerName: secret, credentials: secret, installedOnA: true, recoveryPassed: true,
    drives: [reading({ serialNumber: secret, providerName: secret, path: secret, label: 'Bearer fixture-secret' })],
    system: { ...evidence().system, serial: secret } }));
  assert.equal(result.status, 'passed'); assert.doesNotMatch(JSON.stringify(result) + driveReport(result), /Private fixture metadata|fixture-secret/);
  assert.equal(result.scope, 'Reported logical drive letters only'); assert.match(driveReport(result), /partition layout, EFI\/recovery status/);
  assert.match(driveReport(result), /remain unverified/); assert.match(driveReport(result), /never formats, mounts, writes/);
});

test('authorized local chat ignores operation overrides and saves drive output across restart', async () => {
  const fake = new FakeCodex(); let collections = 0;
  const options = { port: 0, autostart: false, driveCollector: async (...args) => { assert.deepEqual(args, []); collections++; return evidence(); } };
  let app = await createApplication({ ...options, codex: fake });
  try {
    const send = headers => fetch(app.origin + '/api/agent/send', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'show drives matching NTFS', hostname: 'remote.invalid', path: 'A:', format: true, script: 'outside-fixture.ps1' }) });
    assert.equal((await send({})).status, 403); assert.equal(collections, 0);
    const page = await fetch(app.origin), html = await page.text(), cookie = page.headers.get('set-cookie').split(';')[0];
    const token = html.match(/name="volterra-session" content="([a-f0-9]+)"/)[1], headers = { cookie, 'X-Volterra-Client': token };
    assert.equal((await send({ cookie })).status, 403); assert.equal((await send({ ...headers, Origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal(collections, 0);
    const response = await send(headers), result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.tool, 'drives'); assert.equal(result.status, 'passed'); assert.equal(collections, 1);
    assert.deepEqual(fake.calls, []); assert.equal(app.snapshot().systemTool, null);
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('9007199254740993 bytes'));
    assert.ok(output); await app.close(); app = await createApplication({ ...options, codex: new FakeCodex() });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
  } finally { await app.close(); }
});

test('drive checking preserves paused turns and approval priority and excludes simultaneous tools', async () => {
  const fake = new FakeCodex(); let release;
  const collecting = new Promise(resolve => { release = resolve; });
  const app = await createApplication({ port: 0, codex: fake, autostart: false, driveCollector: () => collecting });
  try {
    await app.actions['codex/connect'](); await app.actions['agent/send']({ text: 'Work on the project' }); await app.automation.pause();
    const before = fake.calls.length, request = app.actions['agent/send']({ text: 'show drives' }), snapshot = app.snapshot();
    assert.equal(snapshot.activeTurn, 'fixture-turn'); assert.equal(snapshot.systemTool.kind, 'drives');
    assert.equal(describeProgress(snapshot).phase, 'checking'); assert.equal(describeProgress(snapshot).title, 'Reading Windows logical drives');
    assert.equal(snapshot.progress.since, snapshot.systemTool.since);
    assert.equal(describeProgress({ ...snapshot, approvals: [{}] }).phase, 'question');
    assert.equal(describeProgress({ ...snapshot, interruptRequested: true }).phase, 'stopping');
    for (const text of ['show drives', 'show services', 'show devices', 'show storage', 'show networking', 'show files', 'show logs', 'show maintenance', 'show processes', 'show DNS', 'show memory', 'show uptime']) await assert.rejects(app.actions['agent/send']({ text }), /already running/);
    release(evidence()); await request;
    assert.equal(fake.calls.length, before); assert.equal(app.snapshot().activeTurn, 'fixture-turn'); assert.equal(app.automation.saved.paused, true);
    assert.equal(app.snapshot().systemTool, null);
  } finally { release(evidence()); await app.close(); }
});

test('blocked provider diagnostics persist and fresh successful readings recover without agent work', async () => {
  const options = { port: 0, autostart: false, driveCollector: async () => evidence({ status: 'blocked', drives: [],
    error: { stage: 'Local logical drive enumeration', message: 'CIM provider unavailable.' } }) };
  let app = await createApplication({ ...options, codex: new FakeCodex() });
  try {
    const result = await app.actions['agent/send']({ text: 'show drives' }); blocked(result); assert.equal(app.snapshot().systemTool, null);
    const wasPaused = app.automation.saved.paused;
    const output = app.snapshot().journal.find(entry => entry.type === 'output' && entry.data.delta?.includes('CIM provider unavailable.'));
    assert.ok(output); await app.close();
    const fake = new FakeCodex(); app = await createApplication({ ...options, codex: fake, driveCollector: async () => evidence({ drives: [reading({ freeBytes: '0' })] }) });
    assert.ok(app.snapshot().journal.some(entry => entry.data?.itemId === output.data.itemId));
    const before = fake.calls.length, recovered = await app.actions['agent/send']({ text: 'show drives' });
    assert.equal(recovered.status, 'passed'); assert.equal(recovered.drives[0].freeBytes, '0'); assert.equal(app.snapshot().systemTool, null);
    assert.equal(fake.calls.length, before); assert.equal(app.automation.saved.paused, wasPaused);
  } finally { await app.close(); }
});

test('production collector uses a bounded fixed local property query without storage mutations', async () => {
  const source = await fs.readFile(new URL('../scripts/Get-DriveInventory.ps1', import.meta.url), 'utf8');
  assert.match(source, /Get-CimInstance -Namespace 'root\/cimv2' -ClassName Win32_LogicalDisk -Property DeviceID,DriveType,VolumeName,FileSystem,Size,FreeSpace -OperationTimeoutSec 10 -ErrorAction Stop/);
  assert.match(source, /\$records\.Count -gt 26/); assert.match(source, /\$value -isnot \[uint64\]/); assert.match(source, /InvariantCulture/);
  assert.doesNotMatch(source, /Format-Volume|Clear-Disk|Set-Partition|Initialize-Disk|Mount-|Dism|bcdedit|Restart-|Invoke-CimMethod|-ComputerName|-CimSession|ExecutionPolicy|ProviderName|VolumeSerialNumber/i);
});

test.after(async () => {
  const relative = path.relative(os.tmpdir(), directory);
  assert.ok(relative.startsWith('volterra-drive-test-') && !relative.includes(path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});
