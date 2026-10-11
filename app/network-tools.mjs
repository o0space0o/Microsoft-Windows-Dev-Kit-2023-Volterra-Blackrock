import os from 'node:os';
import { isIP } from 'node:net';
import { redact } from './platform.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const validateFilter = filter => {
  if (typeof filter !== 'string' || filter.length > 256 || /[\u0000-\u001f\u007f]/.test(filter)) throw new Error('Use a network filter of up to 256 characters.');
};

export function networkQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^(?:(?:show|list) )?network(?:ing)?(?: matching ([^\r\n]+))?$/i.exec(message.trim());
  if (!match) return null;
  const filter = (match[1] || '').trim(); validateFilter(filter);
  return { filter };
}

export async function collectNetworking({ readInterfaces = os.networkInterfaces } = {}) {
  if (typeof readInterfaces !== 'function') throw new Error('The local network address API is required.');
  const readings = await readInterfaces();
  if (!readings || typeof readings !== 'object' || Array.isArray(readings)) throw new Error('The network address API returned unsupported readings.');
  const entries = Object.entries(readings);
  if (entries.length > 512) throw new Error('The network address API returned too many interface readings.');
  return { version: 1, kind: 'networking', status: 'passed', error: null, observedAt: new Date().toISOString(),
    system: { platform: process.platform, release: os.release(), runtimeArchitecture: process.arch },
    interfaces: entries.map(([name, addresses]) => {
      if (!Array.isArray(addresses) || addresses.length > 128) throw new Error('The network address API returned unsupported address readings.');
      return { name, addresses: Array.from(addresses, address => {
        if (!address || typeof address !== 'object' || Array.isArray(address)) throw new Error('The network address API returned incomplete address readings.');
        return { address: address.address, family: address.family, netmask: address.netmask, internal: address.internal,
          scopeId: address.family === 'IPv6' ? address.scopeid ?? null : null };
      }) };
    }) };
}

export async function inspectNetworking(filter = '', collect = collectNetworking) {
  validateFilter(filter);
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'networking' || !['passed', 'blocked'].includes(raw.status)
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt)) || !raw.system
      || ['platform', 'release', 'runtimeArchitecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !Array.isArray(raw.interfaces) || raw.interfaces.length > 512) throw new Error('The network collector returned unsupported evidence.');
    if (raw.status === 'blocked') {
      if (raw.interfaces.length || typeof raw.error?.stage !== 'string' || !raw.error.stage.trim()
        || typeof raw.error.message !== 'string' || !raw.error.message.trim()) throw new Error('The network collector returned ambiguous failure evidence.');
      return { status: 'blocked', observedAt: raw.observedAt, interfaces: [],
        error: { stage: text(raw.error.stage), message: text(raw.error.message) } };
    }
    if (raw.error !== null) throw new Error('The network collector returned conflicting failure evidence.');
    const names = new Set(); let totalAddressCount = 0;
    // Validate every interface and address before filtering; array holes are missing readings.
    const all = Array.from(raw.interfaces, iface => {
      if (typeof iface?.name !== 'string' || !iface.name.trim() || iface.name.length > 256 || !Array.isArray(iface.addresses) || iface.addresses.length > 128) {
        throw new Error('The network collector returned incomplete interface readings.');
      }
      const name = text(iface.name, 256);
      if (names.has(name.toLowerCase())) throw new Error('The network collector returned duplicate interface names.');
      names.add(name.toLowerCase());
      const identities = new Set();
      const addresses = Array.from(iface.addresses, reading => {
        const familyNumber = reading?.family === 'IPv4' ? 4 : reading?.family === 'IPv6' ? 6 : 0;
        if (!familyNumber || typeof reading.address !== 'string' || isIP(reading.address) !== familyNumber
          || typeof reading.netmask !== 'string' || isIP(reading.netmask) !== familyNumber || typeof reading.internal !== 'boolean'
          || !(reading.scopeId === null || (familyNumber === 6 && Number.isInteger(reading.scopeId) && reading.scopeId >= 0 && reading.scopeId <= 0xffff_ffff))) {
          throw new Error('The network collector returned incomplete address readings.');
        }
        const identity = `${reading.family}/${reading.address.toLowerCase()}/${reading.scopeId}`;
        if (identities.has(identity)) throw new Error('The network collector returned duplicate address readings.');
        identities.add(identity); totalAddressCount++;
        return { address: reading.address, family: reading.family, netmask: reading.netmask, internal: reading.internal, scopeId: reading.scopeId };
      }).sort((a, b) => a.family.localeCompare(b.family) || a.address.localeCompare(b.address) || (a.scopeId ?? 0) - (b.scopeId ?? 0));
      return { name, addresses };
    }).filter(iface => iface.addresses.length).sort((a, b) => a.name.localeCompare(b.name));
    if (totalAddressCount > 4096) throw new Error('The network collector returned too many address readings.');
    const needle = filter.toLowerCase();
    const interfaces = all.map(iface => ({ name: iface.name, addresses: iface.name.toLowerCase().includes(needle) ? iface.addresses
      : iface.addresses.filter(address => address.address.toLowerCase().includes(needle)) })).filter(iface => iface.addresses.length);
    return { status: 'passed', observedAt: raw.observedAt,
      system: Object.fromEntries(['platform', 'release', 'runtimeArchitecture'].map(key => [key, text(raw.system[key] || 'Unknown', 64)])),
      environment: 'Current OS session; VM or physical identity unverified', source: 'Node local network interface address API', filter: text(filter, 256),
      totalInterfaceCount: all.length, totalAddressCount, matchedInterfaceCount: interfaces.length,
      matchedAddressCount: interfaces.reduce((count, iface) => count + iface.addresses.length, 0), interfaces };
  } catch (error) {
    return { status: 'blocked', interfaces: [], error: { stage: 'Network address inventory', message: text(error?.message || 'The address query did not succeed.') } };
  }
}

export function networkReport(result) {
  if (result.status !== 'passed') return `Network address inventory is blocked. ${result.error.stage}: ${result.error.message}`;
  const paragraphs = [`Live network addresses · ${result.environment}\n${result.system.platform}, OS release ${result.system.release}, runtime architecture ${result.system.runtimeArchitecture}. Observed ${result.observedAt}.`,
    'Assigned addresses only. Link state, gateways, DNS configuration and connectivity remain unverified.',
    `${result.totalAddressCount} assigned address${result.totalAddressCount === 1 ? '' : 'es'} read across ${result.totalInterfaceCount} interface${result.totalInterfaceCount === 1 ? '' : 's'}.${result.filter ? ` Filter “${result.filter}” matched ${result.matchedAddressCount} address${result.matchedAddressCount === 1 ? '' : 'es'} across ${result.matchedInterfaceCount} interface${result.matchedInterfaceCount === 1 ? '' : 's'}.` : ''}`];
  let displayed = 0;
  for (const iface of result.interfaces) for (const reading of iface.addresses) {
    if (displayed >= 40) break;
    paragraphs.push(`${iface.name} · ${reading.family}\nAddress: ${reading.address}. Netmask: ${reading.netmask}.\nInternal flag: ${reading.internal ? 'Yes' : 'No'}.${reading.family === 'IPv6' ? ` IPv6 scope ID: ${reading.scopeId ?? 'Unreported'}.` : ''}`);
    displayed++;
  }
  if (!displayed) paragraphs.push(result.filter ? 'No assigned addresses matched this literal filter.' : 'No assigned interface addresses were reported.');
  if (result.matchedAddressCount > displayed) paragraphs.push(`Showing ${displayed} of ${result.matchedAddressCount} matches. Say “show networking matching <text>” to narrow the readings.`);
  return paragraphs.join('\n\n');
}
