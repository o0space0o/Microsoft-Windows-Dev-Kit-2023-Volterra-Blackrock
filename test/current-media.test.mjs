import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isoBootPaths } from '../app/iso-boot-plan.mjs';
import { readCurrentMedia, readRequestedIsoPlan } from '../scripts/Current-Media.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = '5ec92dd1c058a7e13836242ec8ba3b963b832636';
const save = (file, value) => fs.writeFile(file, JSON.stringify(value));
async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-current-media-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), workspace);
    assert.ok(relative.startsWith('volterra-current-media-') && !relative.includes(path.sep));
    assert.equal(await fs.realpath(workspace), path.resolve(workspace));
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const build = path.join(workspace, 'build', 'current'), iso = path.join(build, 'Microsoft Volterra.iso');
  const wim = path.join(build, 'Media', 'Sources', 'boot.wim'), receiptFile = path.join(build, 'image-receipt.json');
  const sourceReceiptFile = path.join(build, 'source-receipt.json');
  const isoBytes = Buffer.from('ISO fixture only; not bootable media.'), wimBytes = Buffer.from('WIM fixture only; not an OS image.');
  await fs.mkdir(path.dirname(wim), { recursive: true });
  await fs.writeFile(iso, isoBytes); await fs.writeFile(wim, wimBytes);
  const receipt = { version: 1, kind: 'volterraCurrentLiveImage', iso, wim, isoSHA256: digest(isoBytes).toUpperCase(),
    isoBytes: isoBytes.length, wimSHA256: digest(wimBytes).toUpperCase(), sourceCommit: commit, credentialsIncluded: false,
    bootAccepted: true, runtimeAccepted: true, physicalHardwareAccepted: true };
  const source = { version: 1, repository: 'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock',
    commit, source: path.join(workspace, 'build', 'source-snapshots', 'fixture', 'source'),
    files: { 'README.md': digest('Source inventory fixture.') }, checksPassed: true };
  await save(receiptFile, receipt); await save(sourceReceiptFile, source);
  return { workspace, build, iso, wim, receiptFile, sourceReceiptFile, receipt, source };
}

async function historical(workspace, name) {
  const p = isoBootPaths(workspace, name), bytes = Buffer.from('Historical source fixture; not bootable media.');
  await fs.mkdir(p.owned, { recursive: true }); await fs.writeFile(p.iso, bytes); await fs.writeFile(p.data, 'Not a VHD.');
  const receipt = { path: p.iso, sha256: digest(bytes), bytes: bytes.length, sourceCommit: commit, architecture: 'arm64', privateDevelopmentOnly: true };
  await save(p.receiptFile, receipt);
  await save(path.join(p.build, 'image-receipt.json'), { helperBuild: name, sourceCommit: commit });
  await save(path.join(p.build, 'Finalize-result.json'), { status: 'passed', sourceCommit: commit });
  await save(p.identityFile, { version: 2, buildName: name, id: '11111111-2222-3333-4444-555555555555', name: p.vmName,
    data: p.data, iso: p.iso, isoSHA256: receipt.sha256, physicalDiskAttached: false, network: false,
    sourceCommit: commit, isoReceipt: p.receiptFile, isoReceiptSHA256: digest(await fs.readFile(p.receiptFile)) });
  return p;
}

test('current inspection binds ISO and WIM bytes to the current image and source receipts without writing or granting acceptance', async t => {
  const f = await fixture(t), before = await fs.readdir(f.build);
  const selected = await readRequestedIsoPlan(f.workspace);
  assert.equal(selected.buildName, 'current'); assert.equal(selected.phase, 'Inspect'); assert.equal(selected.readOnly, true);
  assert.equal(selected.iso, f.iso); assert.equal(selected.wim, f.wim);
  assert.equal(selected.isoSHA256, f.receipt.isoSHA256.toLowerCase()); assert.equal(selected.wimSHA256, f.receipt.wimSHA256.toLowerCase());
  assert.equal(selected.sourceCommit, commit); assert.equal(selected.sourceBinding, 'receipt-consistent');
  assert.equal(selected.imageReceiptSHA256, digest(await fs.readFile(f.receiptFile)));
  assert.equal(selected.sourceReceiptSHA256, digest(await fs.readFile(f.sourceReceiptFile)));
  for (const key of ['bootAccepted', 'runtimeAccepted', 'physicalHardwareAccepted']) assert.equal(selected[key], false);
  for (const key of ['vmId', 'vmName', 'owned', 'data', 'identityFile']) assert.equal(Object.hasOwn(selected, key), false);
  assert.deepEqual(await fs.readdir(f.build), before);
  assert.deepEqual(JSON.parse(await fs.readFile(f.receiptFile)), f.receipt);
  for (const phase of ['Prepare', 'Stop', 'Start']) await assert.rejects(readRequestedIsoPlan(f.workspace, undefined, phase), /explicit BuildName/);
});

test('absent current media never falls back to historical media or an old current pointer', async t => {
  const f = await fixture(t), old = await historical(f.workspace, 'development-013');
  const pointer = path.join(f.workspace, 'build', 'verification', 'single-current-media.json');
  await fs.mkdir(path.dirname(pointer)); await save(pointer, { currentBuild: 'development-013', path: old.iso });
  await fs.unlink(f.receiptFile);
  await assert.rejects(readRequestedIsoPlan(f.workspace), /ENOENT/);
  assert.equal((await readRequestedIsoPlan(f.workspace, 'development-013', 'Inspect')).buildName, 'development-013');
  assert.equal((await readRequestedIsoPlan(f.workspace, 'development-013', 'Stop')).phase, 'Stop');
  await assert.rejects(readRequestedIsoPlan(f.workspace, 'current', 'Prepare'), /BuildName/);
});

test('foreign paths, old filenames and malformed current receipts refuse', async t => {
  const f = await fixture(t);
  for (const patch of [{ iso: path.join(f.workspace, 'elsewhere.iso') },
    { iso: path.join(f.build, 'Microsoft Windows Dev Kit 2023 Volterra Blackrock.iso') },
    { wim: path.join(f.build, 'boot.wim') }, { sourceCommit: undefined }, { version: 2 }, { kind: 'Observed single current custom ISO' },
    { isoSHA256: 'main' }, { wimSHA256: 'main' }, { isoBytes: 0 }, { credentialsIncluded: true }]) {
    await save(f.receiptFile, { ...f.receipt, ...patch });
    await assert.rejects(readCurrentMedia(f.workspace), /current image receipt/);
  }
});

test('actual media corruption or receipt hash/size changes refuse', async t => {
  const f = await fixture(t);
  for (const patch of [{ isoSHA256: '0'.repeat(64) }, { wimSHA256: '0'.repeat(64) }, { isoBytes: f.receipt.isoBytes + 1 }]) {
    await save(f.receiptFile, { ...f.receipt, ...patch });
    await assert.rejects(readCurrentMedia(f.workspace), /hash\/size differs/);
  }
  await save(f.receiptFile, f.receipt);
  const original = await fs.readFile(f.iso); await fs.appendFile(f.iso, 'changed');
  await assert.rejects(readCurrentMedia(f.workspace), /hash\/size differs/);
  await fs.writeFile(f.iso, original); await fs.appendFile(f.wim, 'changed');
  await assert.rejects(readCurrentMedia(f.workspace), /hash\/size differs/);
});

test('source receipt must agree with the image commit and contain a valid checked public inventory', async t => {
  const f = await fixture(t);
  for (const patch of [{ commit: '1'.repeat(40) }, { repository: 'another/repository' }, { checksPassed: false },
    { version: 2 }, { source: 'relative/path' }, { files: {} }, { files: [] },
    { files: { 'README.md': 'main' } }, { files: { 'private/auth.json': 'a'.repeat(64) } }]) {
    await save(f.sourceReceiptFile, { ...f.source, ...patch });
    await assert.rejects(readCurrentMedia(f.workspace), /source receipt are inconsistent/);
  }
  await fs.unlink(f.sourceReceiptFile);
  await assert.rejects(readCurrentMedia(f.workspace), /ENOENT/);
});

test('linked receipts, linked media and oversized receipts are excluded', async t => {
  const f = await fixture(t);
  for (const file of [f.receiptFile, f.sourceReceiptFile, f.iso, f.wim]) {
    const copy = file + '.copy'; await fs.rename(file, copy); await fs.link(copy, file);
    await assert.rejects(readCurrentMedia(f.workspace), /Linked|ordinary file/);
    await fs.unlink(file); await fs.rename(copy, file);
  }
  await fs.writeFile(f.receiptFile, ' '.repeat(1_000_001));
  await assert.rejects(readCurrentMedia(f.workspace), /bounded ordinary/);
});

test('a linked current directory cannot redirect inspection', async t => {
  const f = await fixture(t), elsewhere = path.join(f.workspace, 'elsewhere');
  await fs.rename(f.build, elsewhere);
  await fs.symlink(elsewhere, f.build, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readCurrentMedia(f.workspace), /Linked/);
  await fs.unlink(f.build); await fs.rename(elsewhere, f.build);
});

test('the actual legacy VM selection guards refuse omitted builds and injected current plans before VM operations', { skip: process.platform !== 'win32' }, () => {
  const file = fileURLToPath(new URL('../scripts/Test-IsoBoot.ps1', import.meta.url));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = [
    "$ErrorActionPreference='Stop'",
    "$tokens=$null;$errors=$null",
    "$ast=[Management.Automation.Language.Parser]::ParseFile(" + quote(file) + ",[ref]$tokens,[ref]$errors)",
    "if($errors.Count){throw 'Parse failed'}",
    "$guard=@($ast.EndBlock.Statements|Where-Object {$_.Extent.Text.StartsWith('if(-not$BuildName)')})",
    "if($guard.Count-ne1){throw 'Missing explicit build guard'}",
    "$BuildName=$null;$blocked=$false;try{&([scriptblock]::Create($guard[0].Extent.Text))}catch{$blocked=$true};if(-not$blocked){throw 'Omitted build accepted'}",
    "$definition=@($ast.FindAll({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-ceq'Read-Plan'},$true))",
    ".([scriptblock]::Create($definition[0].Extent.Text))",
    "function Join-Path { param($Path,$ChildPath) 'fixture-helper' }",
    "$PSScriptRoot='C:\\fixture';$node={param($script,$build,$phase)$global:LASTEXITCODE=0;$global:fixturePlan|ConvertTo-Json -Compress}",
    "$BuildName='development-013'",
    "foreach($scenario in @('current','wrong','readonly','historical')){",
    "$global:fixturePlan=@{buildName='development-013';readOnly=$false}",
    "switch($scenario){'current'{$global:fixturePlan.buildName='current'}'wrong'{$global:fixturePlan.buildName='development-012'}'readonly'{$global:fixturePlan.readOnly=$true}}",
    "$accepted=$false;$failure='';try{$null=Read-Plan 'Inspect';$accepted=$true}catch{$failure=$_.Exception.Message}",
    "if($accepted-ne($scenario-eq'historical')){throw ('Unexpected selection '+$scenario+': '+$failure)}}",
    "'Legacy selection fixtures passed'"
  ].join('\n');
  const env = { ...process.env }; delete env.PSModulePath;
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, env });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stdout, /Legacy selection fixtures passed/);
});
