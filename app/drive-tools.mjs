import path from 'node:path';
import { root, powershell, run, redact } from './platform.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const driveTypes = ['Unknown', 'No root directory', 'Removable disk', 'Local disk', 'Network drive', 'Compact disc', 'RAM disk'];
const bytes = value => value === null || (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn);
const optionalText = (value, maximum) => value === null || (typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value));
const validateFilter = filter => {
  if (typeof filter !== 'string' || filter.length > 256 || /[\u0000-\u001f\u007f]/.test(filter)) throw new Error('Use a drive filter of up to 256 characters.');
};

export function driveQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^(?:(?:show|list) )?(?:logical )?drives(?: matching ([^\r\n]+))?$/i.exec(message.trim());
  if (!match) return null;
  const filter = (match[1] || '').trim(); validateFilter(filter);
  return { filter };
}

export async function collectDrives({ execute = run, shell = powershell } = {}) {
  if (!shell) throw new Error('Windows PowerShell and the local Win32_LogicalDisk CIM provider are required.');
  const output = await execute(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'Get-DriveInventory.ps1')], { timeout: 15_000 });
  return JSON.parse(output.replace(/^\uFEFF/, ''));
}

export async function inspectDrives(filter = '', collect = collectDrives) {
  validateFilter(filter);
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'drives' || !['passed', 'blocked'].includes(raw.status)
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt))
      || !raw.system || ['edition', 'build', 'architecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !Array.isArray(raw.drives) || raw.drives.length > 26) throw new Error('The drive collector returned unsupported evidence.');
    const system = Object.fromEntries(['edition', 'build', 'architecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)]));
    const environment = system.edition === 'WinVOS' ? 'Validation OS session; VM or physical identity unverified'
      : system.edition === 'Unknown' ? 'Windows session; OS edition unverified' : 'Windows session; VM or physical identity unverified';
    if (raw.status === 'blocked') {
      if (raw.drives.length || typeof raw.error?.stage !== 'string' || !raw.error.stage.trim()
        || typeof raw.error.message !== 'string' || !raw.error.message.trim()) throw new Error('The drive collector returned ambiguous failure evidence.');
      return { status: 'blocked', observedAt: raw.observedAt, system, environment, drives: [],
        error: { stage: text(raw.error.stage), message: text(raw.error.message) } };
    }
    if (raw.error !== null) throw new Error('The drive collector returned conflicting failure evidence.');
    const identities = new Set();
    // Validate all positions before literal filtering; absent rows cannot become empty inventory.
    const all = Array.from(raw.drives, reading => {
      if (typeof reading?.id !== 'string' || !/^[A-Z]:$/i.test(reading.id)
        || !Number.isInteger(reading.driveType) || reading.driveType < 0 || reading.driveType >= driveTypes.length
        || !optionalText(reading.label, 512) || !optionalText(reading.fileSystem, 128)
        || !bytes(reading.totalBytes) || !bytes(reading.freeBytes)) throw new Error('The drive collector returned incomplete drive readings.');
      const id = reading.id.toUpperCase();
      if (identities.has(id)) throw new Error('The drive collector returned duplicate drive letters.');
      identities.add(id);
      const total = reading.totalBytes, free = reading.freeBytes;
      if (total !== null && free !== null && BigInt(free) > BigInt(total)) throw new Error('The drive collector returned inconsistent capacity readings.');
      // Provider paths, serial numbers and caller health/installation claims never enter history.
      return { id, driveType: reading.driveType, type: driveTypes[reading.driveType],
        label: reading.label === null ? null : text(reading.label), fileSystem: reading.fileSystem === null ? null : text(reading.fileSystem, 128),
        totalBytes: total, freeBytes: free, usedBytes: total === null || free === null ? null : (BigInt(total) - BigInt(free)).toString() };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const needle = filter.toLowerCase();
    const drives = all.filter(reading => [reading.id, reading.label, reading.fileSystem, reading.type].some(value => value !== null && value.toLowerCase().includes(needle)));
    return { status: 'passed', observedAt: raw.observedAt, system, environment, source: 'Local Win32_LogicalDisk CIM provider',
      scope: 'Reported logical drive letters only', filter: text(filter, 256), totalCount: all.length, matchedCount: drives.length, drives };
  } catch (error) {
    return { status: 'blocked', drives: [], error: { stage: 'Logical drive inventory', message: text(error?.message || 'The drive query did not succeed.') } };
  }
}

export function driveReport(result) {
  if (result.status !== 'passed') return `Logical drive inventory is blocked. ${result.error.stage}: ${result.error.message}`;
  const paragraphs = [`Live logical drive inventory · ${result.environment}\n${result.system.edition}, build ${result.system.build}, ${result.system.architecture}. Observed ${result.observedAt}.`,
    'Scope: Reported drive letters only. Unlettered volumes, physical disk identity, partition layout, EFI/recovery status and Validation OS/hardware acceptance remain unverified.',
    `${result.totalCount} logical drive${result.totalCount === 1 ? '' : 's'} read.${result.filter ? ` Filter “${result.filter}” matched ${result.matchedCount}.` : ''}`];
  for (const reading of result.drives) paragraphs.push(`${reading.id}\nType: ${reading.type} (${reading.driveType}). Label: ${reading.label === null ? 'Unreported' : reading.label || 'No label reported'}. Filesystem: ${reading.fileSystem || 'Unreported'}.\nTotal: ${reading.totalBytes === null ? 'Unreported' : reading.totalBytes + ' bytes'}. Free: ${reading.freeBytes === null ? 'Unreported' : reading.freeBytes + ' bytes'}. Used: ${reading.usedBytes === null ? 'Unreported' : reading.usedBytes + ' bytes'}.`);
  if (!result.drives.length) paragraphs.push(result.filter ? 'No logical drives matched this literal filter.' : 'No logical drives were reported by the local provider.');
  paragraphs.push('Used space is total minus free when both are reported. Missing capacity properties remain unreported; free space is not a quota-aware available-space reading. Drives and capacity can change during collection. This query never formats, mounts, writes, changes partitions or assigns drive letters.');
  return paragraphs.join('\n\n');
}
