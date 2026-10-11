import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { checkPath } from './iso-boot-plan.mjs';

const guid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validateCapturePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > 5_000_000 || !bytes.subarray(0, 8).equals(signature)) throw new Error('Capture is not a bounded PNG.');
  let offset = 8, header = false, data = false, end = false, channels = 0, dataEnded = false;
  const chunks = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('Truncated capture PNG.');
    const length = bytes.readUInt32BE(offset), next = offset + length + 12, type = bytes.toString('ascii', offset + 4, offset + 8);
    if (next > bytes.length || crc32(bytes.subarray(offset + 4, next - 4)) !== bytes.readUInt32BE(next - 4)) throw new Error('Invalid capture PNG chunk.');
    if (!header) {
      if (type !== 'IHDR' || length !== 13 || bytes.readUInt32BE(offset + 8) !== 1024 || bytes.readUInt32BE(offset + 12) !== 768) throw new Error('Capture PNG dimensions differ from the requested thumbnail.');
      const colour = bytes[offset + 17];
      if (bytes[offset + 16] !== 8 || ![2, 6].includes(colour) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) throw new Error('Capture PNG encoding is unsupported.');
      channels = colour === 2 ? 3 : 4;
      header = true;
    } else if (type === 'IHDR') throw new Error('Duplicate capture PNG header.');
    if (type === 'IDAT') {
      if (dataEnded) throw new Error('Capture PNG image chunks are not contiguous.');
      data = true; chunks.push(bytes.subarray(offset + 8, next - 4));
    } else if (data) dataEnded = true;
    if (type === 'IEND') {
      if (length !== 0 || next !== bytes.length || !data) throw new Error('Incomplete capture PNG.');
      end = true;
    }
    offset = next;
  }
  if (!end) throw new Error('Capture PNG has no end marker.');
  const rowBytes = 1024 * channels + 1, expectedBytes = rowBytes * 768;
  const compressed = Buffer.concat(chunks);
  let decoded;
  try { decoded = inflateSync(compressed, { maxOutputLength: expectedBytes, info: true }); }
  catch { throw new Error('Capture PNG image data cannot be decoded.'); }
  if (decoded.buffer.length !== expectedBytes || decoded.engine.bytesWritten !== compressed.length) throw new Error('Capture PNG image data length is invalid.');
  for (let row = 0; row < 768; row++) if (decoded.buffer[row * rowBytes] > 4) throw new Error('Capture PNG scanline filter is invalid.');
}

export async function saveVmCapture({ workspace, outputFile, captureId, vmId, pngBase64 }) {
  if (!guid(captureId) || !guid(vmId)) throw new Error('Capture requires this invocation and VM identifiers.');
  const base = await fs.realpath(workspace);
  if (typeof outputFile !== 'string' || !path.isAbsolute(outputFile)) throw new Error('Capture output must be an absolute owned path.');
  const target = path.resolve(outputFile), relative = path.relative(base, target).split(path.sep).join('/');
  if (!/^build\/development-[0-9]{3}\/(?:iso-test\/screen|technician)\.png$/.test(relative)) throw new Error('Capture output is outside the owned build paths.');
  const parent = path.dirname(target), legacy = [target + '.bmp', target + '.error.txt'];
  await checkPath(base, parent, true);
  for (const file of [target, ...legacy]) await checkPath(base, file);
  if (typeof pngBase64 !== 'string' || pngBase64.length > 7_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(pngBase64)) throw new Error('Invalid capture payload.');
  const bytes = Buffer.from(pngBase64, 'base64'); validateCapturePng(bytes);
  const temporary = path.join(parent, `.capture-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx'); created = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await checkPath(base, parent, true);
    for (const file of [target, ...legacy]) await checkPath(base, file);
    // Rename replaces the directory entry, without writing through a hard link.
    await fs.rename(temporary, target); created = false;
    await checkPath(base, target);
    const saved = await fs.readFile(target);
    if (saved.length !== bytes.length || hash(saved) !== hash(bytes)) throw new Error('Capture changed while publishing.');
    return { version: 1, status: 'passed', captureId, vmId, path: target, sha256: hash(saved), bytes: saved.length,
      capturedAt: new Date().toISOString(), bootAccepted: false, runtimeAccepted: false };
  } finally { if (created) await fs.unlink(temporary); }
}
