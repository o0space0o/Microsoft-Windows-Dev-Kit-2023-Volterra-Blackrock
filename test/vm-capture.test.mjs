import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { saveVmCapture, validateCapturePng } from '../app/vm-capture.mjs';

const vmId = '8548b37f-3ac3-41f4-a8ea-1fec05456e40';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Construct a real RGB PNG with compressed scanlines, using a table-based CRC
// fixture independent of the capture validator's bit-at-a-time checksum.
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4, 'ascii'); data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, bytes.length - 4);
  return bytes;
}
function png({ width = 1024, height = 768, pixel = 0 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height); rows[1] = pixel;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const image = png();

async function fixture(t) {
  const scope = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-capture-test-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(scope));
    assert.ok(relative.startsWith('volterra-capture-test-') && !relative.includes(path.sep));
    assert.equal(await fs.realpath(scope), path.resolve(scope));
    await fs.rm(scope, { recursive: true, force: true });
  });
  const workspace = path.join(scope, 'workspace'), owned = path.join(workspace, 'build', 'development-007', 'iso-test');
  const outside = path.join(scope, 'outside'), outputFile = path.join(owned, 'screen.png');
  await fs.mkdir(owned, { recursive: true }); await fs.mkdir(outside);
  const marker = path.join(outside, 'preserve.txt'); await fs.writeFile(marker, 'Preserve outside the workspace.');
  const captureId = randomUUID();
  const capture = (patch = {}) => saveVmCapture({ workspace, outputFile, captureId, vmId, pngBase64: image.toString('base64'), ...patch });
  return { scope, workspace, owned, outside, marker, outputFile, captureId, capture };
}

test('a valid captured PNG is published with its exact hash and invocation, without claiming boot acceptance', async t => {
  const f = await fixture(t), receipt = await f.capture();
  assert.deepEqual(await fs.readFile(f.outputFile), image);
  assert.equal(receipt.version, 1); assert.equal(receipt.status, 'passed');
  assert.equal(receipt.captureId, f.captureId); assert.equal(receipt.vmId, vmId);
  assert.equal(receipt.path, f.outputFile); assert.equal(receipt.sha256, digest(image)); assert.equal(receipt.bytes, image.length);
  assert.ok(Number.isFinite(Date.parse(receipt.capturedAt)));
  assert.equal(receipt.bootAccepted, false); assert.equal(receipt.runtimeAccepted, false);
  assert.deepEqual(await fs.readdir(f.owned), ['screen.png']);
  const technician = path.join(f.workspace, 'build', 'development-007', 'technician.png');
  assert.equal((await f.capture({ outputFile: technician })).path, technician);
});

test('a new invocation atomically replaces an older regular capture and preserves harmless legacy diagnostics', async t => {
  const f = await fixture(t), first = await f.capture();
  await fs.writeFile(f.outputFile + '.bmp', 'An old diagnostic BMP.');
  await fs.writeFile(f.outputFile + '.error.txt', 'An old error report.');
  const nextImage = png({ pixel: 200 }), nextId = randomUUID();
  const next = await f.capture({ captureId: nextId, pngBase64: nextImage.toString('base64') });
  assert.notEqual(next.captureId, first.captureId); assert.notEqual(next.sha256, first.sha256);
  assert.deepEqual(await fs.readFile(f.outputFile), nextImage);
  assert.equal(next.sha256, digest(nextImage)); assert.equal((await fs.stat(f.outputFile)).nlink, 1);
  assert.equal(await fs.readFile(f.outputFile + '.bmp', 'utf8'), 'An old diagnostic BMP.');
  assert.equal(await fs.readFile(f.outputFile + '.error.txt', 'utf8'), 'An old error report.');
  assert.ok((await fs.readdir(f.owned)).every(name => !name.startsWith('.capture-')));
});

test('malformed, truncated, CRC-corrupt, oversized and wrong-dimension PNG payloads leave the last good capture intact', async t => {
  const f = await fixture(t); await f.capture();
  const corrupt = Buffer.from(image); corrupt[corrupt.length - 1] ^= 1;
  const malformed = [Buffer.from('Not a PNG.'), image.subarray(0, 30), image.subarray(0, image.length - 1), corrupt,
    png({ width: 1023 }), png({ height: 767 }), Buffer.concat([image, Buffer.from('trailing bytes')]), Buffer.alloc(5_000_001)];
  for (const bytes of malformed) {
    assert.throws(() => validateCapturePng(bytes), /PNG|thumbnail/);
    await assert.rejects(f.capture({ pngBase64: bytes.toString('base64') }), /PNG|thumbnail|payload/);
    assert.deepEqual(await fs.readFile(f.outputFile), image);
  }
  for (const pngBase64 of [null, '%%%%', 'data:image/png;base64,' + image.toString('base64'), 'A'.repeat(7_000_001)]) {
    await assert.rejects(f.capture({ pngBase64 }), /payload/);
    assert.deepEqual(await fs.readFile(f.outputFile), image);
  }
  assert.deepEqual(await fs.readdir(f.owned), ['screen.png']);
});

test('CRC-valid but unrenderable image encodings cannot be published as successful captures', async t => {
  const f = await fixture(t); await f.capture();
  const signature = image.subarray(0, 8), header = image.subarray(16, 29), ending = image.subarray(-12);
  const encoded = (ihdr, compressed) => Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', compressed), ending]);
  const malformed = [encoded(header, Buffer.from('This is not a zlib stream.')),
    encoded(header, deflateSync(Buffer.from([0, 0, 0, 0]))),
    encoded(header, deflateSync(Buffer.alloc((1024 * 3 + 1) * 768, 5)))];
  // These malformed header fields have recomputed CRCs, so checksum checking
  // alone cannot establish a renderable capture.
  for (const [offset, value] of [[8, 0], [9, 7], [10, 1], [11, 2], [12, 2]]) {
    const ihdr = Buffer.from(header); ihdr[offset] = value;
    malformed.push(encoded(ihdr, deflateSync(Buffer.alloc((1024 * 3 + 1) * 768))));
  }
  for (const bytes of malformed) {
    await assert.rejects(f.capture({ pngBase64: bytes.toString('base64') }), /PNG|capture|image|encoding|scanline|filter|compressed/i);
    assert.deepEqual(await fs.readFile(f.outputFile), image);
  }
});

test('invalid identities and unowned output paths cannot create or replace capture files', async t => {
  const f = await fixture(t);
  for (const patch of [{ captureId: 'old' }, { vmId: 'not-a-vm' }, { captureId: null }, { vmId: '' }]) {
    await assert.rejects(f.capture(patch), /identifiers/);
  }
  const paths = [null, 'screen.png', f.marker, path.join(f.owned, 'different.png'),
    path.join(f.workspace, 'build', 'development-007', 'screen.png'),
    path.join(f.workspace, 'build', 'development-7', 'iso-test', 'screen.png')];
  for (const outputFile of paths) await assert.rejects(f.capture({ outputFile }), /absolute owned|owned build/);
  assert.deepEqual(await fs.readdir(f.owned), []);
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'Preserve outside the workspace.');
});

async function linkDestination(f, target) {
  // Junctions exercise reparse-point protection on Windows without requiring
  // file-symlink privileges. Unix uses a normal file symlink.
  await fs.symlink(process.platform === 'win32' ? f.outside : f.marker, target, process.platform === 'win32' ? 'junction' : 'file');
}

test('a destination or legacy diagnostic link cannot redirect publication outside the workspace', async t => {
  const f = await fixture(t);
  for (const target of [f.outputFile, f.outputFile + '.bmp', f.outputFile + '.error.txt']) {
    await linkDestination(f, target);
    await assert.rejects(f.capture(), /Linked|unsupported/);
    assert.equal(await fs.readFile(f.marker, 'utf8'), 'Preserve outside the workspace.');
    assert.deepEqual(await fs.readdir(f.outside), ['preserve.txt']);
    await fs.unlink(target);
  }
  await fs.rmdir(f.owned);
  await fs.symlink(f.outside, f.owned, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.capture(), /Linked|unsupported/);
  assert.deepEqual(await fs.readdir(f.outside), ['preserve.txt']);
  await fs.unlink(f.owned);
});

test('hard-linked destination and sidefiles are rejected without writing through the outside file', async t => {
  const f = await fixture(t);
  for (const target of [f.outputFile, f.outputFile + '.bmp', f.outputFile + '.error.txt']) {
    await fs.link(f.marker, target);
    await assert.rejects(f.capture(), /Linked|unsupported/);
    assert.equal(await fs.readFile(f.marker, 'utf8'), 'Preserve outside the workspace.');
    assert.equal((await fs.stat(f.marker)).nlink, 2);
    await fs.unlink(target);
  }
  await f.capture();
  assert.equal((await fs.stat(f.outputFile)).nlink, 1);
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'Preserve outside the workspace.');
});

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(stdout) : reject(new Error(`Capture validation harness failed (${code}): ${stderr}`)); });
  });
}

test('the real Inspect receipt validator rejects stale invocation, wrong VM/path and changed bytes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await f.capture();
  const source = await fs.readFile(path.join(project, 'scripts', 'Test-IsoBoot.ps1'), 'utf8');
  const begin = source.indexOf('function Invoke-InspectionCapture('), end = source.indexOf('\ntry {', begin);
  assert.ok(begin >= 0 && end > begin);
  // Extract only the receipt-verification function. No Hyper-V command,
  // administrator requirement or image operation enters this fixture harness.
  const validator = source.slice(begin, end);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference='Stop'\nImport-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')\n${validator}\n`
    + `$vm=@{Id=${quote(vmId)}}; $selection=@{owned=${quote(f.owned)}}; $outcomes=@()\n`
    + `foreach ($scenario in @('fresh','fresh-again','stale','vm','path','hash','bytes','status','version')) {\n`
    + `$collect={ param($CaptureId,$OutputFile,$VMId)\n`
    + `$receipt=@{version=1;status='passed';captureId=$CaptureId;vmId=$VMId;path=$OutputFile;bytes=${image.length};sha256=${quote(digest(image))}}\n`
    + `switch ($scenario) {\n`
    + `'stale' {$receipt.captureId=${quote(f.captureId)}}\n`
    + `'vm' {$receipt.vmId='00000000-0000-0000-0000-000000000000'}\n`
    + `'path' {$receipt.path=Join-Path $selection.owned 'older.png'}\n`
    + `'hash' {$receipt.sha256='${'0'.repeat(64)}'}\n`
    + `'bytes' {$receipt.bytes=${image.length + 1}}\n`
    + `'status' {$receipt.status='failed'}\n`
    + `'version' {$receipt.version=0}\n}\n$receipt|ConvertTo-Json -Compress\n}\n`
    + `try {$receipt=Invoke-InspectionCapture $vm $selection $collect; $outcomes+=@{scenario=$scenario;accepted=$true;captureId=$receipt.captureId}}\n`
    + `catch {$outcomes+=@{scenario=$scenario;accepted=$false;error=$_.Exception.Message}}\n}\n`
    + `$outcomes|ConvertTo-Json -Compress\n`;
  const outcomes = JSON.parse((await runPowerShell(script)).trim());
  assert.equal(outcomes.length, 9);
  for (const item of outcomes) assert.equal(item.accepted, item.scenario.startsWith('fresh'), JSON.stringify(item));
  assert.notEqual(outcomes[0].captureId, outcomes[1].captureId);
  assert.notEqual(outcomes[0].captureId, f.captureId);
  for (const item of outcomes.slice(2)) assert.match(item.error, /Inspect invocation|hash\/size/);
  assert.deepEqual(await fs.readFile(f.outputFile), image);
});
