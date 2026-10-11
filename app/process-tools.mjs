import path from 'node:path';
import { root, powershell, run, redact } from './platform.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const integer = value => Number.isInteger(value) && value >= 0 && value <= 0x7fff_ffff;
const bytes = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 0x7fff_ffff_ffff_ffffn;
const validateFilter = filter => {
  if (typeof filter !== 'string' || filter.length > 256 || /[\u0000-\u001f\u007f]/.test(filter)) throw new Error('Use a process filter of up to 256 characters.');
};

export function processQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^(?:(?:show|list) )?processes(?: matching ([^\r\n]+))?$/i.exec(message.trim());
  if (!match) return null;
  const filter = (match[1] || '').trim(); validateFilter(filter);
  return { filter };
}

export async function collectProcesses({ execute = run, shell = powershell } = {}) {
  if (!shell) throw new Error('Windows PowerShell and the local process API are required.');
  const output = await execute(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'Get-ProcessInventory.ps1')], { timeout: 15_000 });
  return JSON.parse(output.replace(/^\uFEFF/, ''));
}

export async function inspectProcesses(filter = '', collect = collectProcesses) {
  validateFilter(filter);
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'processes' || !['passed', 'blocked'].includes(raw.status)
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt))
      || !raw.system || ['edition', 'build', 'architecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !Array.isArray(raw.processes) || raw.processes.length > 4096) throw new Error('The process collector returned unsupported evidence.');
    const system = Object.fromEntries(['edition', 'build', 'architecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)]));
    const environment = system.edition === 'WinVOS' ? 'Validation OS session; VM or physical identity unverified'
      : system.edition === 'Unknown' ? 'Windows session; OS edition unverified' : 'Windows session; VM or physical identity unverified';
    if (raw.status === 'blocked') {
      if (raw.processes.length || typeof raw.error?.stage !== 'string' || !raw.error.stage.trim()
        || typeof raw.error.message !== 'string' || !raw.error.message.trim()) throw new Error('The process collector returned ambiguous failure evidence.');
      return { status: 'blocked', observedAt: raw.observedAt, system, environment, processes: [],
        error: { stage: text(raw.error.stage), message: text(raw.error.message) } };
    }
    if (raw.error !== null) throw new Error('The process collector returned conflicting failure evidence.');
    const identities = new Set();
    const all = raw.processes.map(reading => {
      if (!integer(reading?.pid) || identities.has(reading.pid) || typeof reading.name !== 'string' || !reading.name.trim()
        || reading.name.length > 512 || /[\u0000-\u001f\u007f]/.test(reading.name)
        || !(reading.sessionId === null || integer(reading.sessionId))
        || !(reading.workingSetBytes === null || bytes(reading.workingSetBytes))) throw new Error('The process collector returned incomplete or duplicate readings.');
      identities.add(reading.pid);
      // Names and numeric readings only; paths, arguments, owners and process handles never enter history.
      return { pid: reading.pid, name: text(reading.name), sessionId: reading.sessionId, workingSetBytes: reading.workingSetBytes };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
    const needle = filter.toLowerCase();
    const processes = all.filter(reading => reading.name.toLowerCase().includes(needle) || String(reading.pid).includes(needle));
    return { status: 'passed', observedAt: raw.observedAt, system, environment, source: 'Local Windows Get-Process API', filter: text(filter, 256),
      totalCount: all.length, matchedCount: processes.length,
      unreportedSessionCount: all.filter(reading => reading.sessionId === null).length,
      unreportedWorkingSetCount: all.filter(reading => reading.workingSetBytes === null).length, processes };
  } catch (error) {
    return { status: 'blocked', processes: [], error: { stage: 'Process inventory', message: text(error?.message || 'The process query did not succeed.') } };
  }
}

export function processReport(result) {
  if (result.status !== 'passed') return `Process inventory is blocked. ${result.error.stage}: ${result.error.message}`;
  const displayed = result.processes.slice(0, 40);
  const paragraphs = [`Live process inventory · ${result.environment}\n${result.system.edition}, build ${result.system.build}, ${result.system.architecture}. Observed ${result.observedAt}.`,
    'Read-only collection, not an atomic snapshot. Processes can exit or change during collection; PID reuse is possible. These readings do not verify system health, performance or target OS acceptance.',
    `${result.totalCount} process${result.totalCount === 1 ? '' : 'es'} read; ${result.unreportedSessionCount} session IDs and ${result.unreportedWorkingSetCount} working sets unreported.${result.filter ? ` Filter “${result.filter}” matched ${result.matchedCount}.` : ''}`];
  for (const reading of displayed) paragraphs.push(`${reading.name}\nPID: ${reading.pid}. Session ID: ${reading.sessionId ?? 'Unreported'}.\nWorking set: ${reading.workingSetBytes === null ? 'Unreported; the property could not be read' : reading.workingSetBytes + ' bytes'}.`);
  if (!displayed.length) paragraphs.push(result.filter ? 'No processes matched this literal filter.' : 'No processes were reported by the local API.');
  if (result.matchedCount > displayed.length) paragraphs.push(`Showing ${displayed.length} of ${result.matchedCount} matches. Say “show processes matching <text>” to narrow the readings.`);
  paragraphs.push('This query never stops processes, changes their priority or reads command lines, executable paths or account names.');
  return paragraphs.join('\n\n');
}
