import dns from 'node:dns';
import os from 'node:os';
import { isIP } from 'node:net';
import { redact } from './platform.mjs';

const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const validateFilter = filter => {
  if (typeof filter !== 'string' || filter.length > 256 || /[\u0000-\u001f\u007f]/.test(filter)) throw new Error('Use a DNS filter of up to 256 characters.');
};

export function dnsQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^(?:(?:show|list) )?dns(?: servers)?(?: matching ([^\r\n]+))?$/i.exec(message.trim());
  if (!match) return null;
  const filter = (match[1] || '').trim(); validateFilter(filter);
  return { filter };
}

export async function collectDns({ readServers = () => dns.getServers() } = {}) {
  if (typeof readServers !== 'function') throw new Error('The Node DNS resolver configuration API is required.');
  const servers = await readServers();
  if (!Array.isArray(servers)) throw new Error('The DNS resolver API returned unsupported readings.');
  return { version: 1, kind: 'dns', status: 'passed', error: null, observedAt: new Date().toISOString(),
    system: { platform: process.platform, release: os.release(), runtimeArchitecture: process.arch }, servers: Array.from(servers) };
}

function endpoint(value, position) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('%') || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('The DNS collector returned an unsupported server endpoint.');
  let address = value, family = isIP(value), port = 53;
  if (!family) {
    const ipv4 = /^([^:]+):([1-9][0-9]{0,4})$/.exec(value);
    const ipv6 = /^\[([^\[\]]+)\]:([1-9][0-9]{0,4})$/.exec(value);
    const match = ipv4 || ipv6;
    if (!match || isIP(match[1]) !== (ipv4 ? 4 : 6)) throw new Error('The DNS collector returned an unsupported server endpoint.');
    address = match[1]; family = ipv4 ? 4 : 6; port = Number(match[2]);
    if (port > 65535) throw new Error('The DNS collector returned an unsupported server port.');
  }
  return { position, endpoint: value, address, family: family === 4 ? 'IPv4' : 'IPv6', port };
}

export async function inspectDns(filter = '', collect = collectDns) {
  validateFilter(filter);
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'dns' || !['passed', 'blocked'].includes(raw.status)
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt))
      || !raw.system || ['platform', 'release', 'runtimeArchitecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !Array.isArray(raw.servers) || raw.servers.length > 256) throw new Error('The DNS collector returned unsupported evidence.');
    if (raw.status === 'blocked') {
      if (raw.servers.length || typeof raw.error?.stage !== 'string' || !raw.error.stage.trim()
        || typeof raw.error.message !== 'string' || !raw.error.message.trim()) throw new Error('The DNS collector returned ambiguous failure evidence.');
      return { status: 'blocked', observedAt: raw.observedAt, servers: [],
        error: { stage: text(raw.error.stage), message: text(raw.error.message) } };
    }
    if (raw.error !== null) throw new Error('The DNS collector returned conflicting failure evidence.');
    // Preserve returned order and repeated entries. This is resolver configuration,
    // not a Windows adapter inventory or a measurement of DNS query outcomes.
    const all = Array.from(raw.servers, (value, index) => endpoint(value, index + 1));
    const needle = filter.toLowerCase();
    const servers = all.filter(server => server.endpoint.toLowerCase().includes(needle));
    return { status: 'passed', observedAt: raw.observedAt,
      system: Object.fromEntries(['platform', 'release', 'runtimeArchitecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)])),
      environment: 'Current OS session; VM or physical identity unverified', source: 'Node dns.getServers()', scope: 'Helper Node resolver only',
      filter: text(filter, 256), totalCount: all.length, matchedCount: servers.length, servers };
  } catch (error) {
    return { status: 'blocked', servers: [], error: { stage: 'DNS resolver configuration', message: text(error?.message || 'The DNS configuration query did not succeed.') } };
  }
}

export function dnsReport(result) {
  if (result.status !== 'passed') return `DNS resolver configuration is blocked. ${result.error.stage}: ${result.error.message}`;
  const displayed = result.servers.slice(0, 40);
  const paragraphs = [`Live DNS resolver configuration · ${result.environment}\n${result.system.platform}, OS release ${result.system.release}, runtime architecture ${result.system.runtimeArchitecture}. Observed ${result.observedAt}.`,
    `Scope: ${result.scope}. Windows DNS Client settings, per-interface policies, browser resolution and server reachability remain unverified. This is not connectivity or target OS acceptance evidence.`,
    `${result.totalCount} configured server entr${result.totalCount === 1 ? 'y' : 'ies'} read, in returned order.${result.filter ? ` Filter “${result.filter}” matched ${result.matchedCount}.` : ''}`];
  for (const server of displayed) paragraphs.push(`Entry ${server.position} · ${server.family}\nServer: ${server.endpoint}. DNS port: ${server.port}.`);
  if (!displayed.length) paragraphs.push(result.filter ? 'No configured server entries matched this literal filter.' : 'The Node resolver returned no configured server entries; resolution behavior remains unverified.');
  if (result.matchedCount > displayed.length) paragraphs.push(`Showing ${displayed.length} of ${result.matchedCount} matches. Say “show DNS matching <text>” to narrow the readings.`);
  paragraphs.push('This read-only query performs no DNS lookups and changes no resolver settings.');
  return paragraphs.join('\n\n');
}
