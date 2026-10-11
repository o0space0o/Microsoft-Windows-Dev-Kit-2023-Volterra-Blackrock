import path from 'node:path';
import { root, powershell, run, redact } from './platform.mjs';

const providers = {
  'windows-update': { name: 'Windows Update', source: 'ISystemInformation.RebootRequired' },
  'pending-file-operations': { name: 'Pending file operations', source: 'Session Manager PendingFileRenameOperations' }
};
const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);

export function maintenanceQuery(message) {
  return typeof message === 'string' && /^(?:(?:show|check) )?maintenance$|^(?:show|check) restart requirements$/i.test(message.trim()) ? {} : null;
}

export async function collectMaintenance({ execute = run, shell = powershell } = {}) {
  if (!shell) throw new Error('Windows PowerShell and the local Windows maintenance providers are required.');
  const output = await execute(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'Get-MaintenanceStatus.ps1')], { timeout: 15_000 });
  return JSON.parse(output.replace(/^\uFEFF/, ''));
}

export async function inspectMaintenance(collect = collectMaintenance) {
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'maintenance' || !['passed', 'blocked'].includes(raw.status)
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt))
      || !raw.system || ['edition', 'build', 'architecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !Array.isArray(raw.checks) || raw.checks.length !== Object.keys(providers).length) throw new Error('The maintenance collector returned unsupported evidence.');
    const system = Object.fromEntries(['edition', 'build', 'architecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)]));
    const environment = system.edition === 'WinVOS' ? 'Validation OS session; VM or physical identity unverified'
      : system.edition === 'Unknown' ? 'Windows session; OS edition unverified' : 'Windows session; VM or physical identity unverified';
    const identities = new Set();
    const checks = raw.checks.map(check => {
      if (typeof check?.id !== 'string' || !Object.hasOwn(providers, check.id) || identities.has(check.id) || !['passed', 'blocked'].includes(check.status)) throw new Error('The maintenance collector returned incomplete provider readings.');
      identities.add(check.id);
      if (check.status === 'blocked') {
        if (check.restartReported !== null || typeof check.error?.stage !== 'string' || !check.error.stage.trim()
          || typeof check.error.message !== 'string' || !check.error.message.trim()) throw new Error('The maintenance collector returned ambiguous provider failure evidence.');
        return { id: check.id, ...providers[check.id], status: 'blocked', restartReported: null,
          error: { stage: text(check.error.stage), message: text(check.error.message) } };
      }
      if (typeof check.restartReported !== 'boolean' || check.error !== null) throw new Error('The maintenance collector returned incomplete restart readings.');
      // Retain only the two fixed boolean readings. Queued paths and COM details stay out of chat/history.
      return { id: check.id, ...providers[check.id], status: 'passed', restartReported: check.restartReported, error: null };
    }).sort((a, b) => Object.keys(providers).indexOf(a.id) - Object.keys(providers).indexOf(b.id));
    const status = checks.every(check => check.status === 'passed') ? 'passed' : 'blocked';
    if (raw.status !== status) throw new Error('The maintenance status does not match its provider evidence.');
    const reasons = checks.filter(check => check.restartReported === true).map(check => check.name);
    return { status, observedAt: raw.observedAt, system, environment, scope: 'Windows Update and pending file operations only', checks, reasons,
      restartRequired: reasons.length ? true : status === 'passed' ? false : null };
  } catch (error) {
    return { status: 'blocked', restartRequired: null, reasons: [], checks: [], error: { stage: 'Maintenance restart requirements', message: text(error?.message || 'The maintenance query did not succeed.') } };
  }
}

export function maintenanceReport(result) {
  if (!result.checks.length) return `Maintenance restart requirements are blocked. ${result.error.stage}: ${result.error.message}`;
  const paragraphs = [`${result.status === 'blocked' ? 'Maintenance restart requirements are blocked; available readings follow.' : 'Live maintenance restart requirements'} · ${result.environment}\n${result.system.edition}, build ${result.system.build}, ${result.system.architecture}. Observed ${result.observedAt}.`,
    `Scope: ${result.scope}. Other installers, component servicing, firmware and staged helper updates are outside this query. This is not system health, recovery or target OS acceptance evidence.`];
  for (const check of result.checks) paragraphs.push(check.status === 'passed'
    ? `${check.name}: ${check.restartReported ? 'Restart reported' : 'No restart reported'} by ${check.source}.`
    : `${check.name} is blocked. ${check.error.stage}: ${check.error.message}`);
  paragraphs.push(result.restartRequired === true ? `Restart reported by: ${result.reasons.join(', ')}.`
    : result.restartRequired === false ? 'Neither queried provider reports a restart requirement; other restart requirements remain unverified.'
      : 'Restart requirements remain unknown because a provider could not be read.');
  paragraphs.push('You control any restart. This read-only query never changes settings, schedules file operations or restarts the system.');
  return paragraphs.join('\n\n');
}
