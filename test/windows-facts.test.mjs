import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWindowsFacts } from '../app/windows-facts.mjs';
import { allowedSource } from '../app/source-policy.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readWindowsFacts } from '../app/windows-facts.mjs';

const options = { pid: 100, chrome: 'X:\\Volterra\\private\\tools\\chrome\\chrome.exe', launchedAt: '2026-10-11T12:00:00.000Z', before: Date.parse('2026-10-11T12:00:10Z'), after: Date.parse('2026-10-11T12:00:12Z') };
const facts = () => ({ version: 1, kind: 'windowsFacts', status: 'passed', observedAt: '2026-10-11T12:00:11.0000000Z', boot: { observed: true, source: 'Win32_OperatingSystem.LastBootUpTime', utc: '2026-10-11T11:00:00.1234560Z', dmtf: '20261011130000.123456+120' }, browser: { requestedPid: 100, observed: true, imagePath: options.chrome, creationUtc: '2026-10-11T12:00:00.5000000Z' }, errors: [] });

test('native facts require exact staged browser, fresh PID lifetime and coherent actual boot timestamp', () => {
  const observed = inspectWindowsFacts(facts(), options);
  assert.equal(observed.browserImageObserved, true); assert.equal(observed.bootId, '2026-10-11T11:00:00.1234560Z');
  for (const mutate of [
    value => { value.browser.imagePath = 'C:\\Other\\chrome.exe'; },
    value => { value.browser.requestedPid++; },
    value => { value.browser.creationUtc = '2026-10-11T11:59:50.0000000Z'; },
    value => { value.boot.utc = '2026-10-11T11:00:01.1234560Z'; },
    value => { value.boot.dmtf = '20261311130000.123456+120'; },
    value => { value.observedAt = '2026-10-11T12:00:30.0000000Z'; },
    value => { value.accepted = true; }
  ]) { const value = facts(); mutate(value); assert.throws(() => inspectWindowsFacts(value, options)); }
});

test('a failed provider preserves exact process proof while missing browser preserves actual boot proof', () => {
  const providerFailure = facts(); providerFailure.status = 'blocked'; providerFailure.boot = { observed: false, source: 'Win32_OperatingSystem.LastBootUpTime', utc: null, dmtf: null };
  providerFailure.errors = [{ stage: 'Boot identity', code: '0x80041001', message: 'Provider unavailable' }];
  const processOnly = inspectWindowsFacts(providerFailure, options);
  assert.equal(processOnly.bootIdentityObserved, false); assert.equal(processOnly.browserImageObserved, true);
  const browserFailure = facts(); browserFailure.status = 'blocked'; browserFailure.browser = { requestedPid: 100, observed: false, imagePath: null, creationUtc: null };
  browserFailure.errors = [{ stage: 'Browser process', code: '0x80070005', message: 'Query denied' }];
  const bootOnly = inspectWindowsFacts(browserFailure, options);
  assert.equal(bootOnly.bootIdentityObserved, true); assert.equal(bootOnly.browserImageObserved, false);
  assert.equal(allowedSource('scripts/Probe-WindowsFacts.cs'), true);
  assert.equal(allowedSource('scripts/Unreviewed.cs'), false); assert.equal(allowedSource('private/tools/volterra-facts.exe'), false);
});

test('changed private binary or public facts source is rejected before native execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-facts-provenance-'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
  try {
    await fs.mkdir(path.join(root, 'private', 'tools'), { recursive: true }); await fs.mkdir(path.join(root, 'scripts'));
    const binary = Buffer.alloc(2048, 1), source = Buffer.from('original facts source'), build = Buffer.from('original compile script');
    const commit = 'a'.repeat(40), executable = path.join(root, 'private', 'tools', 'volterra-facts.exe'), sourceFile = path.join(root, 'scripts', 'Probe-WindowsFacts.cs');
    const manifest = { version: 1, kind: 'volterraWindowsFactsBuild', sourceCommit: commit, sourceFile: 'scripts/Probe-WindowsFacts.cs', sourceSHA256: hash(source), buildScript: 'scripts/Build-WindowsFacts.ps1', buildScriptSHA256: hash(build), executable: { file: 'private/tools/volterra-facts.exe', bytes: binary.length, SHA256: hash(binary) } };
    await Promise.all([
      fs.writeFile(executable, binary), fs.writeFile(sourceFile, source), fs.writeFile(path.join(root, 'scripts', 'Build-WindowsFacts.ps1'), build),
      fs.writeFile(path.join(root, 'private', 'tools', 'volterra-facts-build.json'), JSON.stringify(manifest)),
      fs.writeFile(path.join(root, 'private', 'source-version.json'), JSON.stringify({ repository: 'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock', commit }))
    ]);
    let calls = 0;
    const probe = { root, guard: async () => {}, execute: async () => { calls++; throw new Error('Native invocation unexpectedly reached.'); } };
    await fs.writeFile(executable, Buffer.alloc(2048, 2));
    await assert.rejects(readWindowsFacts(probe), /not bound/); assert.equal(calls, 0);
    await fs.writeFile(executable, binary); await fs.writeFile(sourceFile, 'changed facts source');
    await assert.rejects(readWindowsFacts(probe), /provenance changed/); assert.equal(calls, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
