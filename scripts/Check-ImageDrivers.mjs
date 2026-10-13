import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const blockedNames = new Set(['surfaceusbhubfwupdatev2.inf']);
const maximumInfBytes = 4 * 1024 * 1024;
// These three stock inbox framework INFs are Class Firmware but are not OEM
// firmware payload packages. Their original names and bytes are unchanged
// between the original Validation OS 10.0.26100.9549 driver inventory and the
// inspected driver-isolation candidate (367 and 391 entries respectively).
// Preserve this exact baseline; an updated inbox package needs a new review.
// Local evidence: private/diagnostics/physical-boot/original/drivers.json and
// private/diagnostics/driver-isolation/drivers.json. No driver bytes are embedded.
const inboxFrameworkHashes = new Map([
  ['c_firmware.inf', '0E4CD3A44033044FD29CE598603666D86BF85AFFD03872665C8EC4F510CA45AD'],
  ['hidcfu.inf', '00F54BD92E8BD948E4B5AD357C4362FEBCC2523014073B693ACDF40AF4E2CF23'],
  ['storfwupdate.inf', 'DAEE97F4A3A4563212FC09476C4D096CFCCE8A2C25C90803B39B4F0E6002065C'],
]);

export function driverPolicyReasons(file, classes, sha256) {
  const name = path.win32.basename(file).toLowerCase(), reasons = [];
  const expected = inboxFrameworkHashes.get(name);
  if (classes.includes('firmware') && (!expected || expected !== sha256)) reasons.push('Firmware setup class is excluded unless the original name and bytes match a verified stock inbox framework.');
  if (blockedNames.has(name)) reasons.push('The Surface USB hub firmware updater is excluded even though its setup class is USB.');
  return reasons;
}

// INF syntax is case-insensitive and permits comments, continuations and
// Strings tokens. Unicode INFs normally use UTF-16LE; OEM exports also contain
// ANSI files. This policy reads metadata only; it is not an INF installer.
// https://learn.microsoft.com/windows-hardware/drivers/install/general-syntax-rules-for-inf-files
export function decodeInf(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maximumInfBytes) throw new Error('Invalid INF size.');
  let encoding;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes.includes(0)) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
    let even = 0, odd = 0;
    for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) odd++; else even++; }
    if (odd > sample.length / 4 && even === 0) encoding = 'utf-16le';
    else if (even > sample.length / 4 && odd === 0) encoding = 'utf-16be';
    else throw new Error('Unrecognized INF text encoding.');
  }
  let text;
  if (encoding) text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('windows-1252').decode(bytes); }
  }
  if (text.includes('\0')) throw new Error('INF text contains a null character.');
  return text.replace(/^\uFEFF/, '');
}

function lines(text) {
  const result = []; let continued = '';
  for (const physical of text.split(/\r\n|\r|\n/)) {
    let quoted = false, end = physical.length;
    for (let i = 0; i < physical.length; i++) {
      if (physical[i] === '"') quoted = !quoted;
      else if (physical[i] === ';' && !quoted) { end = i; break; }
    }
    const line = physical.slice(0, end).trim();
    if (!quoted && line.endsWith('\\')) { continued += line.slice(0, -1); continue; }
    result.push(continued + line); continued = '';
  }
  if (continued) throw new Error('Unfinished INF continuation.');
  return result;
}

const unquote = value => {
  value = value.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new Error('Unfinished INF metadata string.');
    return value.slice(1, -1).replaceAll('""', '"');
  }
  return value;
};

export function inspectDriverInf(file, bytes) {
  const classes = [], strings = new Map(); let section = '';
  for (const line of lines(decodeInf(bytes))) {
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) { section = unquote(heading[1]).toLowerCase(); continue; }
    const stringSection = /^strings(?:\.[a-f\d]{4})?$/.test(section);
    if (section !== 'version' && !stringSection) continue;
    const entry = /^([^=]+)=(.*)$/.exec(line);
    if (!entry) continue;
    const key = unquote(entry[1]).toLowerCase();
    if (section === 'version' && key === 'class') classes.push(unquote(entry[2]));
    if (stringSection) {
      if (!strings.has(key)) strings.set(key, new Set());
      // Only decode strings referenced by Class; unrelated OEM display strings
      // and install directives are outside this metadata policy.
      strings.get(key).add(entry[2]);
    }
  }
  function expand(value, seen = new Set()) {
    const token = /%([^%]+)%/.exec(value);
    if (!token) return [value.trim()];
    const key = token[1].toLowerCase(), values = strings.get(key);
    if (!values || seen.has(key) || seen.size >= 8) throw new Error('Unresolved or recursive INF Class token.');
    return [...values].flatMap(replacement => expand(value.replace(token[0], () => unquote(replacement)), new Set([...seen, key])));
  }
  const resolvedClasses = [...new Set(classes.flatMap(value => expand(value)).map(value => value.toLowerCase()))];
  const sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  return { file, classes: resolvedClasses, sha256, reasons: driverPolicyReasons(file, resolvedClasses, sha256) };
}

export async function checkImageDrivers(imageRoot) {
  const root = path.resolve(imageRoot);
  async function ordinary(target, directory = false) {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || path.relative(target, await fs.realpath(target)) !== '') throw new Error('The driver inventory contains a redirected or unsupported path.');
    return info;
  }
  await ordinary(root, true);
  const report = { version: 1, kind: 'volterraImageDriverPolicy', status: 'passed', checkedInfs: 0, blocked: [], inboxFirmwareFrameworks: [], filesChanged: false };
  const digest = createHash('sha256'); let visited = 0;
  async function visit(directory, recursive) {
    await ordinary(directory, true);
    if (++visited > 20_000) throw new Error('Driver inventory exceeds the directory limit.');
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name), info = await fs.lstat(file);
      if (info.isDirectory()) { if (recursive) await visit(file, true); }
      else if (/\.inf$/i.test(name)) {
        await ordinary(file);
        if (++report.checkedInfs > 4096 || info.size < 1 || info.size > maximumInfBytes) throw new Error('Driver inventory exceeds the INF limits.');
        const bytes = await fs.readFile(file), relative = path.relative(root, file).split(path.sep).join('/');
        const entry = inspectDriverInf(relative, bytes);
        digest.update(relative + '\0').update(createHash('sha256').update(bytes).digest());
        if (entry.reasons.length) report.blocked.push(entry);
        else if (entry.classes.includes('firmware')) report.inboxFirmwareFrameworks.push(entry);
      } else if (info.isSymbolicLink()) throw new Error('The driver inventory contains a link.');
    }
  }
  for (const components of [['Windows', 'INF'], ['Windows', 'System32', 'DriverStore', 'FileRepository']]) {
    let directory = root;
    for (const component of components) { directory = path.join(directory, component); await ordinary(directory, true); }
    const before = report.checkedInfs;
    await visit(directory, components.at(-1) === 'FileRepository');
    if (report.checkedInfs === before) throw new Error('A required image driver inventory is empty.');
  }
  report.inventorySHA256 = digest.digest('hex').toUpperCase();
  if (report.blocked.length) report.status = 'blocked';
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Provide one offline image directory.');
    const report = await checkImageDrivers(process.argv[2]);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) { console.error(`Image driver policy check failed: ${error.message}`); process.exitCode = 1; }
}
