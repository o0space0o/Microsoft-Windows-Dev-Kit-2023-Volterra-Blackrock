import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeInf, inspectDriverInf, checkImageDrivers, driverPolicyReasons } from '../scripts/Check-ImageDrivers.mjs';

const inf = className => `[Version]\r\nSignature="$Windows NT$"\r\nClass=${className}\r\n`;
const utf16 = (text, bigEndian = false, bom = true) => {
  const bytes = Buffer.from(text, 'utf16le');
  if (bigEndian) bytes.swap16();
  return bom ? Buffer.concat([Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]), bytes]) : bytes;
};

test('firmware setup class is rejected across INF encodings and syntax variations', () => {
  const text = '; Class=USB is a comment\r\n[vErSiOn]\r\nCLASS = \\\r\n "fIrMwArE" ; trailing comment\r\n';
  for (const bytes of [Buffer.from(text), Buffer.from('\uFEFF' + text), utf16(text), utf16(text, true), utf16(text, false, false), utf16(text, true, false)]) {
    assert.deepEqual(inspectDriverInf('oem1.inf', bytes).classes, ['firmware']);
    assert.equal(inspectDriverInf('oem1.inf', bytes).reasons.length, 1);
  }
  const ansi = Buffer.concat([Buffer.from('; caf'), Buffer.from([0xe9]), Buffer.from('\n' + inf('Firmware'))]);
  assert.equal(inspectDriverInf('oem1.inf', ansi).reasons.length, 1);
  assert.throws(() => decodeInf(Buffer.from([0xff, 0xfe, 0x41])), /encoded|encoding/i);
});

test('Class tokens and duplicate Version sections cannot conceal a firmware class', () => {
  const bytes = Buffer.from('[Version]\nClass=%Kind%\n[Strings]\nKind="USB"\nIgnored="a;b"\n[Strings.0409]\nKind="Firmware"\n');
  assert.equal(inspectDriverInf('token.inf', bytes).reasons.length, 1);
  assert.equal(inspectDriverInf('duplicate.inf', Buffer.from(inf('USB') + inf('Firmware'))).reasons.length, 1);
  assert.throws(() => inspectDriverInf('unknown.inf', Buffer.from(inf('%missing%'))), /Unresolved/);
  assert.throws(() => inspectDriverInf('cycle.inf', Buffer.from(inf('%one%') + '[Strings]\none=%one%\n')), /recursive/);
});

test('stock inbox framework exceptions require both the original name and exact reviewed bytes', () => {
  const stock = [
    ['c_firmware.inf', '0E4CD3A44033044FD29CE598603666D86BF85AFFD03872665C8EC4F510CA45AD'],
    ['hidcfu.inf', '00F54BD92E8BD948E4B5AD357C4362FEBCC2523014073B693ACDF40AF4E2CF23'],
    ['storfwupdate.inf', 'DAEE97F4A3A4563212FC09476C4D096CFCCE8A2C25C90803B39B4F0E6002065C'],
  ];
  for (const [name, hash] of stock) {
    assert.deepEqual(driverPolicyReasons('Windows/INF/' + name.toUpperCase(), ['firmware'], hash), []);
    assert.equal(driverPolicyReasons('Windows/INF/oem101.inf', ['firmware'], hash).length, 1);
    assert.equal(driverPolicyReasons(name, ['firmware'], '0'.repeat(64)).length, 1);
    assert.equal(inspectDriverInf(name, Buffer.from(inf('Firmware'))).reasons.length, 1, 'An allowed name cannot bypass hashing the actual INF bytes.');
  }
  assert.equal(driverPolicyReasons('surfaceusbhubfwupdatev2.inf', ['usb'], stock[0][1]).length, 1);
});

test('the USB-class updater is rejected by exact original name while ordinary hardware packages remain allowed', () => {
  assert.equal(inspectDriverInf('store/SuRfAcEuSbHuBfWuPdAtEv2.InF', Buffer.from(inf('USB'))).reasons.length, 1);
  for (const [name, className] of [['usbhub3.inf', 'USB'], ['qcxhcifilter8280.inf', 'USB'], ['hidusb.inf', 'HIDClass'], ['qcpil.inf', 'System'], ['surfacewatchdog.inf', 'System'], ['surfaceusbhubfwupdatev2-extra.inf', 'USB']]) {
    assert.deepEqual(inspectDriverInf(name, Buffer.from(inf(className) + '[Files]\nfirmware.bin=1\n')).reasons, [], name);
  }
  // Hardware IDs and other directives are lists, not Class/Strings metadata.
  const hardware = inf('System') + '[Models.NTarm64]\n%Device%="Install",ACPI\\QCOM1234\n[Strings]\nDevice="Qualcomm device"\nUnrelatedDisplay="OEM display string with missing closing quote\n';
  assert.deepEqual(inspectDriverInf('qci2c.inf', Buffer.from(hardware)).reasons, []);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-driver-policy-'));
  t.after(async () => {
    const relative = path.relative(await fs.realpath(os.tmpdir()), await fs.realpath(root));
    assert.ok(relative.startsWith('volterra-driver-policy-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const published = path.join(root, 'Windows', 'INF'), store = path.join(root, 'Windows', 'System32', 'DriverStore', 'FileRepository');
  await fs.mkdir(published, { recursive: true }); await fs.mkdir(store, { recursive: true });
  await fs.writeFile(path.join(published, 'oem1.inf'), utf16(inf('USB')));
  const packageRoot = path.join(store, 'usbhub3.inf_arm64_fixture'); await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'usbhub3.inf'), Buffer.from(inf('USB')));
  return { root, published, store, packageRoot };
}

test('final image inventory checks published firmware and renamed USB updater originals without changing files', async t => {
  const f = await fixture(t);
  const safe = await checkImageDrivers(f.root); assert.equal(safe.status, 'passed'); assert.equal(safe.checkedInfs, 2);
  const firmware = path.join(f.published, 'oem2.inf'), firmwareBytes = utf16(inf('Firmware'));
  const updater = path.join(f.packageRoot, 'SurfaceUsbHubFwUpdateV2.inf'), updaterBytes = Buffer.from(inf('USB'));
  await fs.writeFile(firmware, firmwareBytes); await fs.writeFile(updater, updaterBytes);
  const result = await checkImageDrivers(f.root);
  assert.equal(result.status, 'blocked'); assert.equal(result.checkedInfs, 4); assert.equal(result.blocked.length, 2); assert.equal(result.filesChanged, false);
  assert.deepEqual(await fs.readFile(firmware), firmwareBytes); assert.deepEqual(await fs.readFile(updater), updaterBytes);
  const command = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/Check-ImageDrivers.mjs', import.meta.url)), f.root], { encoding: 'utf8', windowsHide: true });
  assert.equal(command.status, 1); assert.equal(JSON.parse(command.stdout).status, 'blocked');
});

test('missing, empty and redirected inventories cannot report a policy pass', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.packageRoot, 'usbhub3.inf'));
  await assert.rejects(checkImageDrivers(f.root), /empty/);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'firmware.inf'), Buffer.from(inf('Firmware')));
  await fs.symlink(outside, path.join(f.store, 'redirected'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(checkImageDrivers(f.root), /link|redirected/);
});

test('the live image builder gates seed sealing and commit on the driver policy result', async () => {
  const script = await fs.readFile(new URL('../scripts/Build-LiveIso.ps1', import.meta.url), 'utf8');
  const guard = script.indexOf("'Check-ImageDrivers.mjs'");
  assert.ok(guard > 0 && guard < script.indexOf("'Seal-LiveSeed.mjs'"));
  assert.match(script.slice(guard, script.indexOf("'Seal-LiveSeed.mjs'")), /if\(\$LASTEXITCODE-ne0\)\{throw/);
  assert.ok(guard < script.indexOf('Dismount-WindowsImage -Path $mount -Save'));
});
