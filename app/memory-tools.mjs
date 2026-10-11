import os from 'node:os';
import { redact } from './platform.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const maximumBytes = BigInt(Number.MAX_SAFE_INTEGER);
const nativeBytes = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('The system memory API returned unsupported byte counts.');
  return String(value);
};

export function memoryQuery(message) {
  return typeof message === 'string' && /^(?:show )?(?:system )?memory$/i.test(message.trim()) ? {} : null;
}

export async function collectMemory({ readTotal = () => os.totalmem(), readFree = () => os.freemem() } = {}) {
  if (typeof readTotal !== 'function' || typeof readFree !== 'function') throw new Error('The Node total and free system memory APIs are required.');
  // These two getter calls are sequential readings, not an atomic allocation snapshot.
  const totalBytes = nativeBytes(await readTotal());
  const freeBytes = nativeBytes(await readFree());
  return { version: 1, kind: 'memory', observedAt: new Date().toISOString(),
    system: { platform: process.platform, release: os.release(), runtimeArchitecture: process.arch }, totalBytes, freeBytes };
}

export async function inspectMemory(collect = collectMemory) {
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'memory'
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt))
      || !raw.system || ['platform', 'release', 'runtimeArchitecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || ['totalBytes', 'freeBytes'].some(key => typeof raw[key] !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(raw[key]))) {
      throw new Error('The memory collector returned unsupported evidence.');
    }
    const total = BigInt(raw.totalBytes), free = BigInt(raw.freeBytes);
    if (total === 0n || total > maximumBytes || free > total) throw new Error('The system memory API returned inconsistent byte counts.');
    return { status: 'passed', observedAt: raw.observedAt,
      system: Object.fromEntries(['platform', 'release', 'runtimeArchitecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)])),
      environment: 'Current OS session; VM or physical identity unverified', scope: 'System memory reported to this Node runtime',
      source: 'Node os.totalmem() and os.freemem()', totalBytes: total.toString(), freeBytes: free.toString(), nonFreeBytes: (total - free).toString() };
  } catch (error) {
    return { status: 'blocked', error: { stage: 'System memory readings', message: text(error?.message || 'The memory query did not succeed.') } };
  }
}

function capacityText(value) {
  const gibibyte = 1n << 30n;
  const hundredths = (BigInt(value) * 100n + gibibyte / 2n) / gibibyte;
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')} GiB (${value} bytes)`;
}

export function memoryReport(result) {
  if (result.status !== 'passed') return `System memory readings are blocked. ${result.error.stage}: ${result.error.message}`;
  return [`Live system memory readings · ${result.environment}\n${result.system.platform}, OS release ${result.system.release}, runtime architecture ${result.system.runtimeArchitecture}. Observed ${result.observedAt}.`,
    `Scope: ${result.scope}.\nTotal reported memory: ${capacityText(result.totalBytes)}.\nReported free memory: ${capacityText(result.freeBytes)}.\nTotal minus reported free: ${capacityText(result.nonFreeBytes)}.`,
    'The difference is not application working-set or committed memory. Cache, allocation limits, page files, memory pressure and installed memory modules are outside this query. Readings can change between the two getter calls; this is not an atomic snapshot, a memory test or system-health/Validation OS acceptance evidence.',
    'This read-only query changes no settings, frees no memory and stops no process.'].join('\n\n');
}
