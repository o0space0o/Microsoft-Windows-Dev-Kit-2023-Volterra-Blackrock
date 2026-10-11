import path from 'node:path';
import { root, powershell, run, redact } from './platform.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const validateFilter = filter => {
  if (typeof filter !== 'string' || filter.length > 256 || /[\u0000-\u001f\u007f]/.test(filter)) throw new Error('Use a device filter of up to 256 characters.');
};

export function deviceQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^(?:(?:show|list) )?devices(?: matching ([^\r\n]+))?$/i.exec(message.trim());
  if (!match) return null;
  const filter = (match[1] || '').trim();
  validateFilter(filter);
  return { filter };
}

export async function collectDevices({ execute = run, shell = powershell } = {}) {
  if (!shell) throw new Error('Windows PowerShell and the local Win32_PnPEntity provider are required.');
  const output = await execute(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'Get-DeviceInventory.ps1')], { timeout: 15_000 });
  return JSON.parse(output.replace(/^\uFEFF/, ''));
}

export async function inspectDevices(filter = '', collect = collectDevices) {
  validateFilter(filter);
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'devices' || !['passed', 'blocked'].includes(raw.status)
      || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt)) || !raw.system
      || ['edition', 'build', 'architecture'].some(key => typeof raw.system[key] !== 'string')
      || !Array.isArray(raw.devices) || raw.devices.length > 4096) throw new Error('The device collector returned unsupported evidence.');
    const system = { edition: text(raw.system.edition || 'Unknown', 128), build: text(raw.system.build || 'Unknown', 64), architecture: text(raw.system.architecture || 'Unknown', 64) };
    const environment = system.edition === 'WinVOS' ? 'Validation OS session; VM or physical identity unverified'
      : system.edition === 'Unknown' ? 'Windows session; OS edition unverified' : 'Windows session; VM or physical identity unverified';
    if (raw.status === 'blocked') return { status: 'blocked', observedAt: raw.observedAt, system, environment, filter: text(filter, 256), devices: [],
      error: { stage: text(raw.error?.stage || 'Device enumeration'), message: text(raw.error?.message || 'Device enumeration did not succeed.') } };
    const identities = new Set();
    const all = raw.devices.map(device => {
      if (typeof device?.instanceId !== 'string' || !device.instanceId.trim() || device.instanceId.length > 512
        || /[\u0000-\u001f\u007f]/.test(device.instanceId)
        || ['name', 'deviceClass', 'status'].some(key => device[key] !== null && typeof device[key] !== 'string')
        || !(device.present === null || typeof device.present === 'boolean')
        || !(device.problemCode === null || (Number.isInteger(device.problemCode) && device.problemCode >= 0 && device.problemCode <= 0xffff_ffff))) {
        throw new Error('The device collector returned incomplete readings.');
      }
      const instanceId = text(device.instanceId, 512);
      if (identities.has(instanceId.toLowerCase())) throw new Error('The device collector returned duplicate identities.');
      identities.add(instanceId.toLowerCase());
      return { instanceId, name: device.name === null ? null : text(device.name), deviceClass: device.deviceClass === null ? null : text(device.deviceClass, 128),
        status: device.status === null ? null : text(device.status, 64), present: device.present, problemCode: device.problemCode };
    }).sort((a, b) => (a.name || a.instanceId).localeCompare(b.name || b.instanceId) || a.instanceId.localeCompare(b.instanceId));
    const needle = filter.toLowerCase();
    const devices = all.filter(device => [device.name, device.deviceClass, device.instanceId].some(value => value?.toLowerCase().includes(needle)));
    const counts = { codeZero: all.filter(device => device.problemCode === 0).length,
      codeNonzero: all.filter(device => device.problemCode !== null && device.problemCode !== 0).length,
      codeUnreported: all.filter(device => device.problemCode === null).length };
    return { status: 'passed', observedAt: raw.observedAt, system, environment, filter: text(filter, 256), source: 'Local Windows Win32_PnPEntity provider',
      totalCount: all.length, matchedCount: devices.length, counts, devices };
  } catch (error) {
    return { status: 'blocked', filter: text(filter, 256), devices: [], error: { stage: 'Device inventory', message: text(error.message) } };
  }
}

export function deviceReport(result) {
  if (result.status !== 'passed') return `Device inventory is blocked. ${result.error.stage}: ${result.error.message}`;
  const displayed = result.devices.slice(0, 40);
  const paragraphs = [`Live devices · ${result.environment}\n${result.system.edition}, build ${result.system.build}, ${result.system.architecture}. Observed ${result.observedAt}.`,
    'Inventory only. These readings do not verify driver functionality, the NPU or other hardware tests.',
    `${result.totalCount} devices read; ${result.counts.codeZero} report problem code 0, ${result.counts.codeNonzero} report a nonzero code, ${result.counts.codeUnreported} have no reported code.${result.filter ? ` Filter “${result.filter}” matched ${result.matchedCount}.` : ''}`];
  if (!displayed.length) paragraphs.push('No devices matched this literal filter.');
  for (const device of displayed) paragraphs.push(`${text(device.name || device.instanceId, 192)}\nInstance: ${text(device.instanceId, 192)}. Class: ${text(device.deviceClass || 'Unreported', 64)}.\nReported status: ${device.status || 'Unreported'}. Present: ${device.present === null ? 'Unreported' : device.present ? 'Yes' : 'No'}. Problem code: ${device.problemCode ?? 'Unreported'}.`);
  if (result.devices.length > displayed.length) paragraphs.push(`Showing ${displayed.length} of ${result.matchedCount} matches. Say “show devices matching <text>” to narrow the readings.`);
  return paragraphs.join('\n\n');
}
