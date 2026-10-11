import os from 'node:os';
import { redact } from './platform.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const modes = ['user', 'nice', 'sys', 'idle', 'irq'];
const counterValid = value => Number.isSafeInteger(value) && value >= 0;
const speedValid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const validateFilter = filter => {
  if (typeof filter !== 'string' || filter.length > 256 || /[\u0000-\u001f\u007f]/.test(filter)) throw new Error('Use a processor filter of up to 256 characters.');
};

export function processorQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^(?:(?:show|list) )?(?:processors|cpus)(?: matching ([^\r\n]+))?$/i.exec(message.trim());
  if (!match) return null;
  const filter = (match[1] || '').trim(); validateFilter(filter);
  return { filter };
}

export async function collectProcessors({ readProcessors = () => os.cpus() } = {}) {
  if (typeof readProcessors !== 'function') throw new Error('The Node logical processor API is required.');
  const processors = await readProcessors();
  return { version: 1, kind: 'processors', status: 'passed', error: null, observedAt: new Date().toISOString(),
    system: { platform: process.platform, release: os.release(), runtimeArchitecture: process.arch }, processors };
}

export async function inspectProcessors(filter = '', collect = collectProcessors) {
  validateFilter(filter);
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'processors' || !['passed', 'blocked'].includes(raw.status)
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt))
      || new Date(raw.observedAt).toISOString() !== raw.observedAt
      || !raw.system || ['platform', 'release', 'runtimeArchitecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !Array.isArray(raw.processors) || raw.processors.length > 4096) throw new Error('The processor collector returned unsupported evidence.');
    if (raw.status === 'blocked') {
      if (raw.processors.length || typeof raw.error?.stage !== 'string' || !raw.error.stage.trim()
        || typeof raw.error.message !== 'string' || !raw.error.message.trim()) throw new Error('The processor collector returned ambiguous failure evidence.');
      return { status: 'blocked', processors: [], observedAt: raw.observedAt,
        error: { stage: text(raw.error.stage), message: text(raw.error.message) } };
    }
    if (raw.error !== null) throw new Error('The processor collector returned conflicting failure evidence.');
    if (!raw.processors.length) throw new Error('The Node API returned no logical processor information.');
    // Check every position before filtering; missing rows cannot become missing processors.
    const all = Array.from(raw.processors, (reading, index) => {
      if (typeof reading?.model !== 'string' || reading.model.length > 512 || /[\u0000-\u001f\u007f]/.test(reading.model)
        || !speedValid(reading.speed) || !reading.times || modes.some(mode => !counterValid(reading.times[mode]))) {
        throw new Error('The processor collector returned incomplete or unsupported readings.');
      }
      return { index, model: text(reading.model), speedMHz: reading.speed,
        timesMilliseconds: Object.fromEntries(modes.map(mode => [mode, String(reading.times[mode])])) };
    });
    const needle = filter.toLowerCase();
    const processors = all.filter(reading => [String(reading.index), `logical processor ${reading.index}`, reading.model].some(value => value.toLowerCase().includes(needle)));
    return { status: 'passed', observedAt: raw.observedAt, processors, totalCount: all.length, matchedCount: processors.length,
      filter: text(filter, 256), source: 'Node os.cpus()', scope: 'Logical processor information reported to this Node runtime',
      environment: 'Current OS session; VM or physical identity unverified',
      system: Object.fromEntries(['platform', 'release', 'runtimeArchitecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)])) };
  } catch (error) {
    return { status: 'blocked', processors: [], error: { stage: 'Logical processor inventory', message: text(error?.message || 'The processor query did not succeed.') } };
  }
}

export function processorReport(result) {
  if (result.status !== 'passed') return `Logical processor inventory is blocked. ${result.error.stage}: ${result.error.message}`;
  const paragraphs = [`Live logical processor inventory · ${result.environment}\n${result.system.platform}, OS release ${result.system.release}, runtime architecture ${result.system.runtimeArchitecture}. Observed ${result.observedAt}.`,
    `${result.totalCount} logical processor${result.totalCount === 1 ? '' : 's'} reported to this Node runtime.${result.filter ? ` Filter "${result.filter}" matched ${result.matchedCount}.` : ''}`];
  for (const reading of result.processors) paragraphs.push(`Logical processor ${reading.index}\nModel: ${reading.model || 'No model reported'}. Reported speed: ${reading.speedMHz} MHz.\nTime counters: User ${reading.timesMilliseconds.user} ms; nice ${reading.timesMilliseconds.nice} ms; system ${reading.timesMilliseconds.sys} ms; idle ${reading.timesMilliseconds.idle} ms; IRQ ${reading.timesMilliseconds.irq} ms.`);
  if (!result.processors.length) paragraphs.push('No logical processors matched this literal filter.');
  paragraphs.push('Numbers identify positions in this API reading, not stable hardware IDs or physical core/socket counts. Reported speed is not a measured current frequency. Time counters are cumulative API readings, not a sampled utilization percentage; they are not added together. Windows nice counters are always zero. This inventory does not establish application parallelism limits, CPU/NPU tests, system health or Validation OS/hardware acceptance.');
  paragraphs.push('This read-only query changes no settings, scheduling priority or CPU affinity and runs no workload.');
  return paragraphs.join('\n\n');
}
