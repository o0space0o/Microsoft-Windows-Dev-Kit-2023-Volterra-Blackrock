import os from 'node:os';
import { redact } from './platform.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const secondsValid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

export function uptimeQuery(message) {
  return typeof message === 'string' && /^(?:show )?(?:system )?uptime$/i.test(message.trim()) ? {} : null;
}

export async function collectUptime({ readSystem = () => os.uptime(), readHelper = () => process.uptime() } = {}) {
  if (typeof readSystem !== 'function' || typeof readHelper !== 'function') throw new Error('The Node OS and helper process uptime APIs are required.');
  // Each counter has its own scope and precision; these are sequential readings.
  const systemSeconds = await readSystem();
  if (!secondsValid(systemSeconds)) throw new Error('The OS uptime API returned unsupported seconds.');
  const helperSeconds = await readHelper();
  if (!secondsValid(helperSeconds)) throw new Error('The helper process uptime API returned unsupported seconds.');
  return { version: 1, kind: 'uptime', status: 'passed', error: null, observedAt: new Date().toISOString(),
    system: { platform: process.platform, release: os.release(), runtimeArchitecture: process.arch }, systemSeconds, helperSeconds };
}

export async function inspectUptime(collect = collectUptime) {
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'uptime' || raw.status !== 'passed' || raw.error !== null
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt))
      || new Date(raw.observedAt).toISOString() !== raw.observedAt
      || !raw.system || ['platform', 'release', 'runtimeArchitecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !secondsValid(raw.systemSeconds) || !secondsValid(raw.helperSeconds)) {
      throw new Error('The uptime collector returned unsupported evidence.');
    }
    return { status: 'passed', observedAt: raw.observedAt,
      system: Object.fromEntries(['platform', 'release', 'runtimeArchitecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)])),
      environment: 'Current OS session; VM or physical identity unverified', scope: 'OS and current Node helper process uptime',
      source: 'Node os.uptime() and process.uptime()', systemSeconds: raw.systemSeconds, helperSeconds: raw.helperSeconds };
  } catch (error) {
    return { status: 'blocked', error: { stage: 'Uptime readings', message: text(error?.message || 'The uptime query did not succeed.') } };
  }
}

function durationText(value) {
  const whole = Math.floor(value);
  return `${Math.floor(whole / 86400)}d ${String(Math.floor(whole / 3600) % 24).padStart(2, '0')}h ${String(Math.floor(whole / 60) % 60).padStart(2, '0')}m ${String(whole % 60).padStart(2, '0')}s (${value} seconds reported)`;
}

export function uptimeReport(result) {
  if (result.status !== 'passed') return `Uptime readings are blocked. ${result.error.stage}: ${result.error.message}`;
  return [`Live uptime readings · ${result.environment}\n${result.system.platform}, OS release ${result.system.release}, runtime architecture ${result.system.runtimeArchitecture}. Observed ${result.observedAt}.`,
    `Scope: ${result.scope}.\nOS uptime: ${durationText(result.systemSeconds)}.\nCurrent helper process uptime: ${durationText(result.helperSeconds)}.`,
    'Duration labels use whole seconds; the original API seconds are retained, including any fractions. Each counter has its own scope, precision depends on the API and runtime, and the getters are read sequentially. These counters do not establish a boot timestamp, reboot history, saved-history persistence, system health or Validation OS/hardware acceptance.',
    'This read-only query changes no settings and restarts neither the OS nor the helper.'].join('\n\n');
}
