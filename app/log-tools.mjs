import path from 'node:path';
import { root, powershell, run, redact } from './platform.mjs';

const channelNames = ['System', 'Application'];
const sampleLimit = 50;
const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const validTime = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const validRecord = value => value === null || (typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 0x7fff_ffff_ffff_ffffn);
const levelText = level => level === null ? 'Unreported' : ['Log always', 'Critical', 'Error', 'Warning', 'Information', 'Verbose'][level] || `Level ${level}`;
function validateFilter(filter) {
  if (typeof filter !== 'string' || filter.length > 256 || /[\u0000-\u001f\u007f]/.test(filter)) throw new Error('Use an event log filter of up to 256 characters.');
}

export function logQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^(?:(?:show|list) )?logs(?: matching ([^\r\n]+))?$/i.exec(message.trim());
  if (!match) return null;
  const filter = (match[1] || '').trim();
  validateFilter(filter);
  return { filter };
}

export async function collectLogs({ execute = run, shell = powershell } = {}) {
  if (!shell) throw new Error('Windows PowerShell and the local Windows Event Log API are required.');
  const output = await execute(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts', 'Get-LogInventory.ps1')], { timeout: 15_000 });
  return JSON.parse(output.replace(/^\uFEFF/, ''));
}

export async function inspectLogs(filter = '', collect = collectLogs) {
  validateFilter(filter);
  try {
    const raw = await collect();
    if (raw?.version !== 1 || raw.kind !== 'logs' || !['passed', 'blocked'].includes(raw.status) || !validTime(raw.observedAt)
      || !raw.system || ['edition', 'build', 'architecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || raw.maxEvents !== sampleLimit || !Array.isArray(raw.channels) || raw.channels.length !== channelNames.length) {
      throw new Error('The event log collector returned unsupported evidence.');
    }
    const system = Object.fromEntries(['edition', 'build', 'architecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)]));
    const environment = system.edition === 'WinVOS' ? 'Validation OS session; VM or physical identity unverified'
      : system.edition === 'Unknown' ? 'Windows session; OS edition unverified' : 'Windows session; VM or physical identity unverified';
    const names = new Set(), all = [];
    const channels = raw.channels.map(channel => {
      if (!channelNames.includes(channel?.name) || names.has(channel.name) || !['passed', 'blocked'].includes(channel.status)
        || !Array.isArray(channel.events) || channel.events.length > sampleLimit) throw new Error('The event log collector returned incomplete channel readings.');
      names.add(channel.name);
      if (channel.status === 'blocked') {
        if (channel.events.length || typeof channel.error?.stage !== 'string' || typeof channel.error.message !== 'string' || !channel.error.message.trim()) {
          throw new Error('The event log collector returned ambiguous channel failure evidence.');
        }
        return { name: channel.name, status: 'blocked', sampledCount: 0,
          error: { stage: text(channel.error.stage), message: text(channel.error.message) } };
      }
      if (channel.error !== null) throw new Error('The event log collector reported both success and a channel error.');
      const identities = new Set();
      for (const event of channel.events) {
        if (event?.channel !== channel.name || !Number.isInteger(event.id) || event.id < 0 || event.id > 0xffff
          || !validRecord(event.recordId) || !(event.createdAt === null || validTime(event.createdAt))
          || !(event.level === null || (Number.isInteger(event.level) && event.level >= 0 && event.level <= 255))
          || typeof event.provider !== 'string' || !event.provider.trim() || event.provider.length > 512 || /[\u0000-\u001f\u007f]/.test(event.provider)
          || (event.recordId !== null && identities.has(event.recordId))) throw new Error('The event log collector returned incomplete or duplicate event metadata.');
        if (event.recordId !== null) identities.add(event.recordId);
        // Copy only the metadata contract. Never persist message text, XML, user or computer fields.
        all.push({ channel: channel.name, id: event.id, recordId: event.recordId, createdAt: event.createdAt,
          level: event.level, provider: text(event.provider), levelName: levelText(event.level) });
      }
      return { name: channel.name, status: 'passed', sampledCount: channel.events.length, error: null };
    }).sort((a, b) => channelNames.indexOf(a.name) - channelNames.indexOf(b.name));
    const status = channels.every(channel => channel.status === 'passed') ? 'passed' : 'blocked';
    if (raw.status !== status) throw new Error('The event log collector status does not match its channel evidence.');
    all.sort((a, b) => (b.createdAt === null ? -Infinity : Date.parse(b.createdAt)) - (a.createdAt === null ? -Infinity : Date.parse(a.createdAt)) || a.channel.localeCompare(b.channel));
    const needle = filter.toLowerCase();
    const events = all.filter(event => [event.channel, event.provider, String(event.id), event.recordId || '', event.levelName].some(value => value.toLowerCase().includes(needle)));
    return { status, observedAt: raw.observedAt, system, environment, filter: text(filter, 256), source: 'Local Windows Event Log API (Get-WinEvent)',
      maxEvents: sampleLimit, channels, sampledCount: all.length, matchedCount: events.length, events };
  } catch (error) {
    return { status: 'blocked', filter: text(filter, 256), channels: [], events: [], error: { stage: 'Event log inventory', message: text(error.message) } };
  }
}

export function logReport(result) {
  if (!result.channels.length) return `Event log inventory is blocked. ${result.error.stage}: ${result.error.message}`;
  const heading = result.status === 'blocked' ? `Event log inventory is blocked${result.sampledCount ? '; partial readings follow.' : '.'}` : 'Live event log metadata';
  const paragraphs = [`${heading} · ${result.environment}\n${result.system.edition}, build ${result.system.build}, ${result.system.architecture}. Observed ${result.observedAt}.`,
    `Requested the newest ${result.maxEvents} events per local System and Application channel. This bounded sample does not establish system health, a complete log history or target OS acceptance. Message text, XML and identity fields are excluded.`];
  for (const channel of result.channels) paragraphs.push(channel.status === 'passed' ? `${channel.name}: ${channel.sampledCount} events sampled.`
    : `${channel.name} is blocked. ${channel.error.stage}: ${channel.error.message}`);
  paragraphs.push(`${result.sampledCount} event metadata records read.${result.filter ? ` Literal filter “${result.filter}” matched ${result.matchedCount} in this sample.` : ''}`);
  const displayed = result.events.slice(0, 40);
  if (!displayed.length) paragraphs.push(result.sampledCount ? 'No events matched this literal filter in the collected sample.'
    : result.channels.some(channel => channel.status === 'passed') ? 'No event metadata was returned by the successful channel queries.'
      : 'Neither channel returned a successful query; no event metadata is available.');
  for (const event of displayed) paragraphs.push(`${event.channel} · ${event.provider}\nEvent ID: ${event.id}. Record ID: ${event.recordId ?? 'Unreported'}. Level: ${event.levelName} (${event.level ?? 'Unreported'}).\nCreated: ${event.createdAt ?? 'Unreported'}.`);
  if (result.events.length > displayed.length) paragraphs.push(`Showing ${displayed.length} of ${result.matchedCount} sampled matches. Say “show logs matching <text>” to narrow these readings.`);
  return paragraphs.join('\n\n');
}
