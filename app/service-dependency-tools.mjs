import path from 'node:path';
import { root, powershell, run, redact } from './platform.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const validName = value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[/\\\u0000-\u001f\u007f]/.test(value);
const validFilter = value => typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

export function dependencyQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^(?:(?:show|list) )?service dependencies(?: matching ([^\r\n]+))?$/i.exec(message.trim());
  if (!match) return null;
  const filter = (match[1] || '').trim();
  if (!validFilter(filter)) throw new Error('Use a service dependency filter of up to 256 characters.');
  return { filter };
}

export async function collectDependencies({ execute = run, shell = powershell } = {}) {
  if (!shell) throw new Error('Windows PowerShell and the local Service Control Manager are required.');
  const output = await execute(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'Get-ServiceDependencies.ps1')], { timeout: 15_000 });
  return JSON.parse(output.replace(/^\uFEFF/, ''));
}

export async function inspectDependencies(filter = '', collect = collectDependencies) {
  if (!validFilter(filter)) throw new Error('Use a service dependency filter of up to 256 characters.');
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'service-dependencies' || !['passed', 'blocked'].includes(raw.status)
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt))
      || !raw.system || ['edition', 'build', 'architecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !Array.isArray(raw.services) || raw.services.length > 4096) throw new Error('The dependency collector returned unsupported evidence.');
    const system = Object.fromEntries(['edition', 'build', 'architecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)]));
    const environment = system.edition === 'WinVOS' ? 'Validation OS session; VM or physical identity unverified'
      : system.edition === 'Unknown' ? 'Windows session; OS edition unverified' : 'Windows session; VM or physical identity unverified';
    if (raw.status === 'blocked') {
      if (raw.services.length || typeof raw.error?.stage !== 'string' || !raw.error.stage.trim()
        || typeof raw.error.message !== 'string' || !raw.error.message.trim()) throw new Error('The dependency collector returned ambiguous failure evidence.');
      return { status: 'blocked', observedAt: raw.observedAt, system, environment, filter: text(filter, 256), services: [],
        error: { stage: text(raw.error.stage), message: text(raw.error.message) } };
    }
    if (raw.error !== null) throw new Error('The dependency collector returned conflicting failure evidence.');
    const identities = new Set();
    let relationshipReadings = 0;
    const names = values => {
      if (!Array.isArray(values) || values.length > 4096) throw new Error('The dependency collector returned incomplete relationships.');
      relationshipReadings += values.length;
      if (relationshipReadings > 16_384) throw new Error('The dependency collector exceeded the relationship limit.');
      const seen = new Set();
      return Array.from(values, value => {
        if (!validName(value)) throw new Error('The dependency collector returned incomplete relationship identities.');
        const name = text(value, 256), key = name.toLowerCase();
        if (seen.has(key)) throw new Error('The dependency collector returned duplicate relationship identities.');
        seen.add(key);
        return name;
      }).sort((a, b) => a.localeCompare(b));
    };
    // Validate every row and both provider lists before counting or filtering.
    const all = Array.from(raw.services, row => {
      if (!validName(row?.name) || typeof row.displayName !== 'string' || row.displayName.length > 256) throw new Error('The dependency collector returned incomplete service identities.');
      const name = text(row.name, 256), key = name.toLowerCase();
      if (identities.has(key)) throw new Error('The dependency collector returned duplicate service identities.');
      identities.add(key);
      return { name, displayName: text(row.displayName, 256), required: names(row.required), dependents: names(row.dependents) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const needle = filter.toLowerCase();
    const services = all.filter(row => row.name.toLowerCase().includes(needle) || row.displayName.toLowerCase().includes(needle));
    return { status: 'passed', observedAt: raw.observedAt, system, environment, filter: text(filter, 256),
      source: 'Local Windows ServiceController dependency properties', totalCount: all.length, matchedCount: services.length, services };
  } catch (error) {
    return { status: 'blocked', filter: text(filter, 256), services: [],
      error: { stage: 'Service dependencies', message: text(error?.message || 'The dependency query did not succeed.') } };
  }
}

export function dependencyReport(result) {
  if (result.status !== 'passed') return `Service dependencies are blocked. ${result.error.stage}: ${result.error.message}`;
  const displayed = result.services.slice(0, 20);
  const paragraphs = [`Live service dependencies · ${result.environment}\n${result.system.edition}, build ${result.system.build}, ${result.system.architecture}. Observed ${result.observedAt}.`,
    `${result.totalCount} services read.${result.filter ? ` Literal service-name/display-name filter “${result.filter}” matched ${result.matchedCount}.` : ''}`,
    'Reported ServicesDependedOn and DependentServices names for enumerated Windows services. Driver services are not separately enumerated; related names can fall outside this inventory. Lists are read sequentially, without recursive traversal or an atomic graph snapshot. Empty lists mean none reported by that property. These readings do not establish load-order groups, startup viability, service health or Validation OS acceptance. No service is started, stopped or reconfigured.'];
  if (!displayed.length) paragraphs.push(result.totalCount ? 'No services matched this literal filter.' : 'The provider returned no services.');
  const relationships = (label, values) => `${label}: ${values.length} reported.${values.length ? '\n' + values.slice(0, 10).map(name => `  ${name}`).join('\n') : ''}${values.length > 10 ? `\nShowing 10 of ${values.length} reported names.` : ''}`;
  for (const row of displayed) paragraphs.push(`${row.displayName || row.name} (${row.name})\n${relationships('Required services', row.required)}\n${relationships('Dependent services', row.dependents)}`);
  if (result.services.length > displayed.length) paragraphs.push(`Showing ${displayed.length} of ${result.matchedCount} services. Say “show service dependencies matching <text>” to narrow the service readings.`);
  return paragraphs.join('\n\n');
}
