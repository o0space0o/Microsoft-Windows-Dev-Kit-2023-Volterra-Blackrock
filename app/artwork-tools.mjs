import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { root, redact } from './platform.mjs';
import { approved } from './source-policy.mjs';

const files = Object.keys(approved);
const maximumBytes = 3_000_000n;
const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const failure = error => text(typeof error?.message === 'string' && error.message.trim() ? error.message : 'The artwork read did not succeed.');
const blocked = (file, message) => ({ file, expectedSha256: approved[file], status: 'blocked', actualSha256: null, sizeBytes: null,
  error: { stage: `${file} checksum`, message } });
const identity = (info, folder = false) => {
  if (info.isSymbolicLink() || !(folder ? info.isDirectory() : info.isFile())
    || ['dev', 'ino', ...(folder ? [] : ['size', 'mtimeNs', 'ctimeNs'])].some(key => typeof info[key] !== 'bigint')) throw new Error('A stable original artwork path is required; links and other file types are excluded.');
  if (!folder && (info.size < 0n || info.size > maximumBytes)) throw new Error('The artwork file exceeds the supported size limit.');
  return (folder ? ['dev', 'ino'] : ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']).map(key => info[key]);
};
const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

export function artworkQuery(message) {
  if (typeof message !== 'string') return null;
  return /^(?:check|verify) (?:approved )?artwork$/i.test(message.trim()) ? {} : null;
}

async function directories(base, filesystem) {
  const targets = [base, path.join(base, 'design'), path.join(base, 'design', 'approved-v1')];
  const identities = [];
  for (const target of targets) {
    identities.push(identity(await filesystem.lstat(target, { bigint: true }), true));
    if (path.relative(target, await filesystem.realpath(target)) !== '') throw new Error('The artwork directory is linked or remapped.');
  }
  return identities;
}

async function checksum(base, file, filesystem) {
  const beforeDirectories = await directories(base, filesystem);
  const target = path.join(base, 'design', 'approved-v1', file);
  const before = identity(await filesystem.lstat(target, { bigint: true }));
  if (path.relative(target, await filesystem.realpath(target)) !== '') throw new Error('The artwork file is linked or remapped.');
  const handle = await filesystem.open(target, 'r');
  let actualSha256;
  try {
    if (!same(before, identity(await handle.stat({ bigint: true })))) throw new Error('The artwork file changed before its content read.');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65_536);
    const expectedBytes = Number(before[2]); let position = 0;
    while (position < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - position);
      const reading = await handle.read(buffer, 0, length, position);
      if (!Number.isInteger(reading?.bytesRead) || reading.bytesRead < 1 || reading.bytesRead > length) throw new Error('The artwork content read was incomplete.');
      digest.update(buffer.subarray(0, reading.bytesRead)); position += reading.bytesRead;
    }
    if (!same(before, identity(await handle.stat({ bigint: true })))) throw new Error('The artwork file changed during its content read.');
    actualSha256 = digest.digest('hex');
  } finally { await handle.close(); }
  const after = identity(await filesystem.lstat(target, { bigint: true }));
  const afterDirectories = await directories(base, filesystem);
  if (!same(before, after) || beforeDirectories.some((value, index) => !same(value, afterDirectories[index]))
    || path.relative(target, await filesystem.realpath(target)) !== '') throw new Error('The artwork path changed during checksum collection.');
  return { file, expectedSha256: approved[file], status: actualSha256 === approved[file] ? 'passed' : 'changed', actualSha256, sizeBytes: before[2].toString(), error: null };
}

export async function collectArtwork({ filesystem = fs } = {}) {
  let checks;
  try {
    const base = await filesystem.realpath(root);
    if (typeof base !== 'string' || !path.isAbsolute(base)) throw new Error('The installed helper source returned an unsupported path.');
    checks = [];
    for (const file of files) {
      try { checks.push(await checksum(base, file, filesystem)); }
      catch (error) { checks.push(blocked(file, failure(error))); }
    }
    if (path.relative(base, await filesystem.realpath(root)) !== '') throw new Error('The installed helper source changed during artwork checks.');
  } catch (error) { checks = files.map(file => blocked(file, failure(error))); }
  return { version: 1, kind: 'artwork', status: checks.every(check => check.status === 'passed') ? 'passed' : 'blocked', error: null,
    observedAt: new Date().toISOString(), system: { platform: process.platform, release: os.release(), runtimeArchitecture: process.arch }, checks };
}

export async function inspectArtwork(collect = collectArtwork) {
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'artwork' || !['passed', 'blocked'].includes(raw.status) || raw.error !== null
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt)) || new Date(raw.observedAt).toISOString() !== raw.observedAt
      || !raw.system || ['platform', 'release', 'runtimeArchitecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !Array.isArray(raw.checks) || raw.checks.length !== files.length) throw new Error('The artwork collector returned unsupported evidence.');
    const seen = new Set();
    const checks = Array.from(raw.checks, check => {
      if (!check || typeof check.file !== 'string' || !Object.hasOwn(approved, check.file) || seen.has(check.file) || check.expectedSha256 !== approved[check.file]
        || !['passed', 'changed', 'blocked'].includes(check.status)) throw new Error('The artwork collector returned incomplete or conflicting reference identities.');
      seen.add(check.file);
      if (check.status === 'blocked') {
        if (check.actualSha256 !== null || check.sizeBytes !== null || typeof check.error?.stage !== 'string' || !text(check.error.stage).trim()
          || typeof check.error.message !== 'string' || !text(check.error.message).trim()) throw new Error('The artwork collector returned ambiguous failure evidence.');
        return blocked(check.file, text(check.error.message));
      }
      if (check.error !== null || typeof check.actualSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(check.actualSha256)
        || typeof check.sizeBytes !== 'string' || !/^(?:0|[1-9][0-9]{0,6})$/.test(check.sizeBytes) || BigInt(check.sizeBytes) > maximumBytes
        || (check.actualSha256 === approved[check.file]) !== (check.status === 'passed')) throw new Error('The artwork collector returned conflicting checksum readings.');
      return { file: check.file, expectedSha256: approved[check.file], status: check.status, actualSha256: check.actualSha256, sizeBytes: check.sizeBytes, error: null };
    }).sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file));
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'blocked';
    if (raw.status !== status) throw new Error('The artwork status does not match its checksum evidence.');
    return { status, observedAt: raw.observedAt, checks, matchedCount: checks.filter(check => check.status === 'passed').length,
      changedCount: checks.filter(check => check.status === 'changed').length, blockedCount: checks.filter(check => check.status === 'blocked').length,
      source: 'Node SHA-256 and bounded file reads', scope: 'Four pinned approved reference files in the installed helper source',
      environment: 'Current OS session; VM or physical identity unverified',
      system: Object.fromEntries(['platform', 'release', 'runtimeArchitecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)])) };
  } catch (error) {
    return { status: 'blocked', checks: [], error: { stage: 'Artwork checks', message: failure(error) } };
  }
}

export function artworkReport(result) {
  if (!result.checks.length) return `Artwork checks are blocked. ${result.error.stage}: ${result.error.message}`;
  const paragraphs = [`${result.status === 'passed' ? 'Approved artwork checks passed' : 'Approved artwork checks are incomplete or changed'} · ${result.environment}\n${result.system.platform}, OS release ${result.system.release}, runtime architecture ${result.system.runtimeArchitecture}. Observed ${result.observedAt}.`,
    `${result.matchedCount} of 4 reference files matched; ${result.changedCount} changed; ${result.blockedCount} reads blocked.\nScope: ${result.scope}.`];
  for (const check of result.checks) {
    paragraphs.push(check.status === 'blocked' ? `${check.file}: read blocked. ${check.error.message}`
      : `${check.file}: ${check.status === 'passed' ? 'matches the approved SHA-256' : 'differs from the approved SHA-256'}. ${check.sizeBytes} bytes.\nExpected: ${check.expectedSha256}\nObserved: ${check.actualSha256}`);
  }
  paragraphs.push('These are sequential file-content checks against the approved hashes pinned in this helper source. They do not compare rendered pixels or verify the rest of the source, an OS image, recovery, runtime or hardware. No reference is replaced and no settings are changed. A changed reference requires controller investigation; this command performs no repair.');
  return paragraphs.join('\n\n');
}
