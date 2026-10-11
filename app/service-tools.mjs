import path from 'node:path';
import { root, powershell, run, redact } from './platform.mjs';

const statuses = new Set(['Stopped', 'StartPending', 'StopPending', 'Running', 'ContinuePending', 'PausePending', 'Paused']);
const startupModes = new Set(['Boot', 'System', 'Automatic', 'Manual', 'Disabled']);
const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);

export function serviceQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^(?:(?:show|list) )?services(?: matching ([^\r\n]+))?$/i.exec(message.trim());
  if (!match) return null;
  const filter = (match[1] || '').trim();
  if (filter.length > 256 || /[\u0000-\u001f\u007f]/.test(filter)) throw new Error('Use a service filter of up to 256 characters.');
  return { filter };
}

export async function collectServices({ execute = run, shell = powershell } = {}) {
  if (!shell) throw new Error('Windows PowerShell and the local Service Control Manager are required.');
  const output = await execute(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'Get-ServiceInventory.ps1')], { timeout: 15_000 });
  return JSON.parse(output.replace(/^\uFEFF/, ''));
}

export async function inspectServices(filter = '', collect = collectServices) {
  if (typeof filter !== 'string' || filter.length > 256 || /[\u0000-\u001f\u007f]/.test(filter)) throw new Error('Use a service filter of up to 256 characters.');
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'services' || !['passed', 'blocked'].includes(raw.status)
      || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt)) || !raw.system
      || ['edition', 'build', 'architecture'].some(key => typeof raw.system[key] !== 'string')
      || !Array.isArray(raw.services) || raw.services.length > 4096) throw new Error('The service collector returned unsupported evidence.');
    const system = { edition: text(raw.system.edition || 'Unknown', 128), build: text(raw.system.build || 'Unknown', 64), architecture: text(raw.system.architecture || 'Unknown', 64) };
    const environment = system.edition === 'WinVOS' ? 'Validation OS session; VM or physical identity unverified'
      : system.edition === 'Unknown' ? 'Windows session; OS edition unverified' : 'Windows session; VM or physical identity unverified';
    if (raw.status === 'blocked') return { status: 'blocked', observedAt: raw.observedAt, system, environment, filter, services: [],
      error: { stage: text(raw.error?.stage || 'Service enumeration'), message: text(raw.error?.message || 'Service enumeration did not succeed.') } };
    const names = new Set();
    const all = raw.services.map(service => {
      if (typeof service?.name !== 'string' || !service.name || typeof service.displayName !== 'string' || !statuses.has(service.status) || !startupModes.has(service.startType)
        || names.has(service.name.toLowerCase())) throw new Error('The service collector returned incomplete or duplicate readings.');
      names.add(service.name.toLowerCase());
      return { name: text(service.name, 256), displayName: text(service.displayName, 256), status: service.status, startType: service.startType };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const needle = filter.toLowerCase();
    const services = all.filter(service => service.name.toLowerCase().includes(needle) || service.displayName.toLowerCase().includes(needle));
    const counts = Object.fromEntries([...statuses].map(status => [status, all.filter(service => service.status === status).length]));
    return { status: 'passed', observedAt: raw.observedAt, system, environment, filter: text(filter, 256), source: 'Local Windows Service Control Manager',
      totalCount: all.length, matchedCount: services.length, counts, services };
  } catch (error) {
    return { status: 'blocked', filter: text(filter, 256), services: [], error: { stage: 'Service inventory', message: text(error.message) } };
  }
}

export function serviceReport(result) {
  if (result.status !== 'passed') return `Service inventory is blocked. ${result.error.stage}: ${result.error.message}`;
  const displayed = result.services.slice(0, 40);
  const paragraphs = [`Live services · ${result.environment}\n${result.system.edition}, build ${result.system.build}, ${result.system.architecture}. Observed ${result.observedAt}.`,
    `${result.totalCount} services read; ${result.counts.Running} running, ${result.counts.Stopped} stopped.${result.filter ? ` Filter “${result.filter}” matched ${result.matchedCount}.` : ''}`];
  if (!displayed.length) paragraphs.push('No services matched this literal filter.');
  for (const service of displayed) paragraphs.push(`${service.displayName || service.name} (${service.name})\nState: ${service.status}. Startup mode: ${service.startType}.`);
  if (result.services.length > displayed.length) paragraphs.push(`Showing ${displayed.length} of ${result.matchedCount} matches. Say “show services matching <text>” to narrow the readings.`);
  return paragraphs.join('\n\n');
}
