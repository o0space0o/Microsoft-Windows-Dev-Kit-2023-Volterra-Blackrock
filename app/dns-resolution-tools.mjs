import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import { redact } from './platform.mjs';

const types = ['A', 'AAAA'];
const negativeCodes = new Set(['ENODATA', 'ENOTFOUND']);
const errorCodes = new Set(['ENODATA', 'ENOTFOUND', 'EFORMERR', 'ESERVFAIL', 'ENOTIMP', 'EREFUSED', 'EBADQUERY', 'EBADNAME', 'EBADFAMILY', 'EBADRESP', 'ECONNREFUSED', 'ETIMEOUT', 'EOF', 'EFILE', 'ENOMEM', 'EDESTRUCTION', 'EBADSTR', 'EBADFLAGS', 'ENONAME', 'EBADHINTS', 'ENOTINITIALIZED', 'ELOADIPHLPAPI', 'EADDRGETNETWORKPARAMS', 'ECANCELLED', 'UNKNOWN']);
const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const diagnostic = value => typeof value === 'string' && value.length <= 512 && !!text(value).trim();

function dnsName(value) {
  if (typeof value !== 'string') throw new Error('Use one ASCII DNS name, without a URL, address, server option or credentials.');
  const base = value.endsWith('.') ? value.slice(0, -1) : value;
  if (!base || base.length > 253 || isIP(base) || redact(base) !== base || redact(base.toLowerCase()) !== base.toLowerCase()
    || !base.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    throw new Error('Use one ASCII DNS name of up to 253 characters, with labels of up to 63 characters. Punycode is supported; URLs, addresses, options and credential-like labels are excluded.');
  }
  // Pin the requested name, without applying a local DNS search suffix.
  return base.toLowerCase() + '.';
}

export function resolutionQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^resolve dns(?: ([^\r\n]+))?$/i.exec(message.trim());
  return match ? { name: dnsName(match[1]) } : null;
}

const failure = (type, code, message) => ({ type, status: negativeCodes.has(code) ? 'negative' : 'blocked', records: [],
  error: { code, stage: `${type} query`, message: text(message) } });

export async function collectResolution(requestedName, { makeResolver = options => new Resolver(options), deadlineMs = 5000 } = {}) {
  const name = dnsName(requestedName);
  if (typeof makeResolver !== 'function' || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5000) throw new Error('A bounded, dedicated Node DNS resolver is required.');
  const resolver = makeResolver({ timeout: 1000, tries: 1 });
  if (!resolver || ['resolve4', 'resolve6', 'cancel'].some(method => typeof resolver[method] !== 'function')) throw new Error('The Node DNS query and cancellation APIs are required.');
  const completed = new Map(); let timer, expired = false;
  const timeout = type => failure(type, 'ETIMEOUT', `The DNS query exceeded its ${deadlineMs} ms deadline.`);
  const jobs = types.map(async (type, index) => {
    let check;
    try {
      const records = await resolver[index === 0 ? 'resolve4' : 'resolve6'](name, { ttl: true });
      check = expired ? timeout(type) : { type, status: 'passed', records, error: null };
    } catch (error) {
      const code = errorCodes.has(error?.code) ? error.code : 'UNKNOWN';
      check = expired ? timeout(type) : failure(type, code, typeof error?.message === 'string' && error.message.trim() ? error.message : 'The DNS query did not succeed.');
    }
    completed.set(type, check); return check;
  });
  let checks;
  try {
    checks = await Promise.race([Promise.all(jobs), new Promise(resolve => {
      timer = setTimeout(() => {
        expired = true;
        // Only this query's resolver is cancelled; no global or OS settings change.
        let cancelled = true;
        try { resolver.cancel(); } catch { cancelled = false; }
        resolve(types.map(type => completed.get(type) || failure(type, 'ETIMEOUT', `The DNS query exceeded its ${deadlineMs} ms deadline.${cancelled ? '' : ' Cancellation could not be confirmed.'}`)));
      }, deadlineMs);
    })]);
  } finally { clearTimeout(timer); }
  return { version: 1, kind: 'dns-resolution', name, status: checks.some(check => check.status === 'blocked') ? 'blocked' : 'passed', error: null,
    observedAt: new Date().toISOString(), system: { platform: process.platform, release: os.release(), runtimeArchitecture: process.arch }, checks };
}

export async function inspectResolution(requestedName, collect = collectResolution) {
  const name = dnsName(requestedName);
  try {
    const raw = await collect(name);
    if (raw?.version !== 1 || raw.kind !== 'dns-resolution' || raw.name !== name || !['passed', 'blocked'].includes(raw.status) || raw.error !== null
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt)) || new Date(raw.observedAt).toISOString() !== raw.observedAt
      || !raw.system || ['platform', 'release', 'runtimeArchitecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !Array.isArray(raw.checks) || raw.checks.length !== 2) throw new Error('The DNS query collector returned unsupported evidence.');
    const identities = new Set();
    const checks = Array.from(raw.checks, check => {
      if (!types.includes(check?.type) || identities.has(check.type) || !['passed', 'negative', 'blocked'].includes(check.status)
        || !Array.isArray(check.records) || check.records.length > 256) throw new Error('The DNS query collector returned incomplete family readings.');
      identities.add(check.type);
      if (check.status !== 'passed') {
        if (check.records.length || !errorCodes.has(check.error?.code) || !diagnostic(check.error.stage) || !diagnostic(check.error.message)
          || negativeCodes.has(check.error.code) !== (check.status === 'negative')) throw new Error('The DNS query collector returned ambiguous failure evidence.');
        return { type: check.type, status: check.status, records: [], error: { code: check.error.code, stage: text(check.error.stage), message: text(check.error.message) } };
      }
      if (check.error !== null || !check.records.length) throw new Error('The DNS query collector returned conflicting or empty answer evidence.');
      const records = Array.from(check.records, record => {
        if (typeof record?.address !== 'string' || record.address.length > 128 || record.address.includes('%') || isIP(record.address) !== (check.type === 'A' ? 4 : 6)
          || !Number.isInteger(record.ttl) || record.ttl < 0 || record.ttl > 0xffff_ffff) throw new Error('The DNS query collector returned unsupported address or TTL readings.');
        return { address: record.address, ttlSeconds: record.ttl };
      });
      return { type: check.type, status: 'passed', records, error: null };
    }).sort((a, b) => types.indexOf(a.type) - types.indexOf(b.type));
    const status = checks.some(check => check.status === 'blocked') ? 'blocked' : 'passed';
    if (raw.status !== status) throw new Error('The DNS query status does not match its family evidence.');
    const totalAnswers = checks.reduce((count, check) => count + check.records.length, 0);
    return { status, name, observedAt: raw.observedAt, checks, totalAnswers,
      outcome: status === 'blocked' ? 'incomplete' : totalAnswers ? 'answered' : 'no-addresses',
      source: 'Node Resolver.resolve4() and resolve6()', scope: 'Dedicated Node DNS resolver; default server settings',
      environment: 'Current OS session; VM or physical identity unverified',
      system: Object.fromEntries(['platform', 'release', 'runtimeArchitecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)])) };
  } catch (error) {
    return { status: 'blocked', name, checks: [], error: { stage: 'DNS address query', message: text(error?.message || 'The DNS query did not succeed.') } };
  }
}

export function resolutionReport(result) {
  if (!result.checks.length) return `DNS address query is blocked. ${result.error.stage}: ${result.error.message}`;
  const paragraphs = [`${result.status === 'blocked' ? 'DNS address query is incomplete; available readings follow.' : 'Live DNS address query'} · ${result.environment}\n${result.system.platform}, OS release ${result.system.release}, runtime architecture ${result.system.runtimeArchitecture}. Observed ${result.observedAt}.`,
    `Name: ${result.name}\nScope: ${result.scope}. A and AAAA requests are separate queries, not an atomic snapshot.`];
  for (const check of result.checks) {
    if (check.status !== 'passed') paragraphs.push(check.status === 'negative'
      ? `${check.type}: no address answer returned (${check.error.code}). ${check.error.message}`
      : `${check.type} query is blocked. ${check.error.code} · ${check.error.stage}: ${check.error.message}`);
    else {
      const displayed = check.records.slice(0, 40);
      paragraphs.push(`${check.type}: ${check.records.length} address answer${check.records.length === 1 ? '' : 's'} returned.\n` + displayed.map(record => `${record.address} · TTL ${record.ttlSeconds} seconds`).join('\n'));
      if (displayed.length < check.records.length) paragraphs.push(`Showing ${displayed.length} of ${check.records.length} ${check.type} answers.`);
    }
  }
  paragraphs.push(`${result.totalAnswers} address answer${result.totalAnswers === 1 ? '' : 's'} obtained.${result.outcome === 'incomplete' ? ' Resolution remains incomplete because a family query was blocked.' : result.outcome === 'no-addresses' ? ' Neither family returned an address answer for this query.' : ''}`);
  paragraphs.push('This command sends DNS queries for the requested name, with a five-second overall deadline while the event loop can run. Returned order, duplicates and TTL seconds are retained. It does not consult the hosts file or establish Windows DNS Client policies, browser resolution, application connectivity, DNS authenticity or Validation OS/hardware acceptance. No application connection is made and no resolver or OS settings are changed.');
  return paragraphs.join('\n\n');
}
