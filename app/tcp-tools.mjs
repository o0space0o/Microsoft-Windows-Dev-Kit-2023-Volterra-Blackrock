import { Socket, isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { redact } from './platform.mjs';

const codes = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EACCES', 'EPERM', 'EINVAL', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'UNKNOWN']);
const stages = new Set(['TCP initialization', 'TCP connection', 'TCP timeout', 'TCP cleanup', 'TCP evidence']);
const text = (value, maximum = 512) => redact(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, maximum);
const portNumber = value => Number.isInteger(value) && value >= 1 && value <= 65535;
function address(value, family) {
  if (typeof value !== 'string' || value.length > 64 || value.includes('%') || isIP(value) !== family) throw new Error('A literal IPv4 or unscoped IPv6 address is required.');
  return family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('Use check TCP <IPv4>:<port> or check TCP [<IPv6>]:<port>.');
  const ipv4 = /^([0-9.]+):([1-9][0-9]{0,4})$/.exec(value);
  const ipv6 = /^\[([a-f0-9:.]+)\]:([1-9][0-9]{0,4})$/i.exec(value);
  const match = ipv4 || ipv6;
  if (!match || !portNumber(Number(match[2]))) throw new Error('Use one literal IP address and TCP port from 1 to 65535; hostnames, URLs, credentials and scoped IPv6 addresses are excluded.');
  const family = ipv4 ? 4 : 6, host = address(match[1], family), port = Number(match[2]);
  return { address: host, family, port, endpoint: `${family === 6 ? `[${host}]` : host}:${port}` };
}

export function tcpQuery(message) {
  if (typeof message !== 'string') return null;
  const match = /^check tcp(?: ([^\r\n]+))?$/i.exec(message.trim());
  return match ? { endpoint: endpoint(match[1]).endpoint } : null;
}

function connectionReading(value, target) {
  const family = target.family === 4 ? 'IPv4' : 'IPv6';
  if (!value || value.remoteFamily !== family || value.localFamily !== family || value.remotePort !== target.port || !portNumber(value.localPort)
    || address(value.remoteAddress, target.family) !== target.address) throw new Error('The socket did not report complete endpoints for the requested TCP connection.');
  return { remoteAddress: address(value.remoteAddress, target.family), remotePort: value.remotePort, remoteFamily: family,
    localAddress: address(value.localAddress, target.family), localPort: value.localPort, localFamily: family };
}
const diagnostic = (error, stage = 'TCP connection') => ({ stage, code: codes.has(error?.code) ? error.code : 'UNKNOWN',
  message: text(typeof error?.message === 'string' && error.message.trim() ? error.message : 'The TCP attempt did not complete.') });
function destroy(socket) {
  if (!socket) return 'not-created';
  try { socket.destroy(); return socket.destroyed === true ? 'destroyed' : 'unconfirmed'; }
  catch { return 'unconfirmed'; }
}

export async function collectTcp(requested, { makeSocket = () => new Socket(), deadlineMs = 5000 } = {}) {
  const target = endpoint(requested);
  if (typeof makeSocket !== 'function' || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5000) throw new Error('A dedicated TCP socket and deadline of up to 5000 ms are required.');
  const started = performance.now(); let socket;
  const evidence = (status, error, connection, cleanup, elapsedMs) => ({ version: 1, kind: 'tcp', endpoint: target.endpoint,
    status, error, connection, cleanup, deadlineMs, elapsedMs, observedAt: new Date().toISOString(),
    system: { platform: process.platform, release: os.release(), runtimeArchitecture: process.arch } });
  try {
    socket = makeSocket();
    if (!socket || ['connect', 'destroy', 'on', 'once', 'removeListener'].some(method => typeof socket[method] !== 'function')) throw new Error('The Node TCP connection and socket destruction APIs are required.');
  } catch (error) {
    // An initialization failure must release any socket the factory already returned.
    try { socket?.on?.('error', () => {}); } catch { /* Cleanup still follows. */ }
    const cleanup = destroy(socket);
    return evidence('blocked', cleanup === 'unconfirmed' ? { stage: 'TCP cleanup', code: 'UNKNOWN', message: 'Socket destruction could not be confirmed after initialization failed.' }
      : diagnostic(error, 'TCP initialization'), null, cleanup, performance.now() - started);
  }
  return new Promise(resolve => {
    let finished = false, timer;
    const timeout = () => ({ stage: 'TCP timeout', code: 'ETIMEDOUT', message: `The TCP attempt exceeded its ${deadlineMs} ms deadline.` });
    const finish = (status, error, connection = null) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      const elapsedMs = performance.now() - started;
      if (status === 'passed' && elapsedMs >= deadlineMs) { status = 'blocked'; error = timeout(); connection = null; }
      // Retain an error handler for late socket events; no further I/O is initiated.
      const cleanup = destroy(socket);
      if (cleanup !== 'destroyed') { status = 'blocked'; error = { stage: 'TCP cleanup', code: 'UNKNOWN', message: 'Socket destruction could not be confirmed.' }; connection = null; }
      try { socket.removeListener('connect', connected); socket.removeListener('close', closed); } catch { /* The destroyed socket can be collected. */ }
      resolve(evidence(status, error, connection, cleanup, elapsedMs));
    };
    const connected = () => {
      if (finished) return;
      if (performance.now() - started >= deadlineMs) { finish('blocked', timeout()); return; }
      try { finish('passed', null, connectionReading(socket, target)); }
      catch (error) { finish('blocked', diagnostic(error, 'TCP evidence')); }
    };
    const closed = () => finish('blocked', { stage: 'TCP connection', code: 'ECONNRESET', message: 'The socket closed before a TCP connection was confirmed.' });
    const expire = () => {
      if (finished) return;
      const remaining = deadlineMs - (performance.now() - started);
      if (remaining > 0) timer = setTimeout(expire, Math.ceil(remaining));
      else finish('blocked', timeout());
    };
    try {
      socket.on('error', error => finish('blocked', diagnostic(error)));
      socket.once('close', closed); socket.once('connect', connected);
      if (performance.now() - started >= deadlineMs) { finish('blocked', timeout()); return; }
      timer = setTimeout(expire, Math.max(1, Math.ceil(deadlineMs - (performance.now() - started))));
      // One literal endpoint, no DNS lookup, family fallback, retries or supplied socket options.
      socket.connect({ host: target.address, port: target.port, family: target.family, autoSelectFamily: false });
    } catch (error) { finish('blocked', diagnostic(error, 'TCP initialization')); }
  });
}

export async function inspectTcp(requested, collect = collectTcp) {
  const target = endpoint(requested);
  try {
    const raw = await collect(target.endpoint);
    if (raw?.version !== 1 || raw.kind !== 'tcp' || raw.endpoint !== target.endpoint || !['passed', 'blocked'].includes(raw.status)
      || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt)) || new Date(raw.observedAt).toISOString() !== raw.observedAt
      || !raw.system || ['platform', 'release', 'runtimeArchitecture'].some(key => typeof raw.system[key] !== 'string' || raw.system[key].length > 128)
      || !Number.isInteger(raw.deadlineMs) || raw.deadlineMs < 1 || raw.deadlineMs > 5000
      || typeof raw.elapsedMs !== 'number' || !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0 || raw.elapsedMs > Number.MAX_SAFE_INTEGER
      || !['destroyed', 'not-created', 'unconfirmed'].includes(raw.cleanup)) throw new Error('The TCP collector returned unsupported evidence.');
    let error = null, connection = null;
    if (raw.status === 'passed') {
      if (raw.error !== null || raw.cleanup !== 'destroyed' || raw.elapsedMs >= raw.deadlineMs) throw new Error('The TCP collector returned conflicting connection evidence.');
      connection = connectionReading(raw.connection, target);
    } else {
      if (raw.connection !== null || !codes.has(raw.error?.code) || !stages.has(raw.error.stage) || typeof raw.error.message !== 'string' || !text(raw.error.message).trim()
        || (raw.cleanup === 'unconfirmed' && (raw.error.stage !== 'TCP cleanup' || raw.error.code !== 'UNKNOWN'))
        || (raw.cleanup === 'not-created' && raw.error.stage !== 'TCP initialization')
        || (raw.error.stage === 'TCP cleanup' && raw.cleanup !== 'unconfirmed')
        || (raw.error.stage === 'TCP timeout' && (raw.error.code !== 'ETIMEDOUT' || raw.elapsedMs < raw.deadlineMs))) throw new Error('The TCP collector returned ambiguous failure evidence.');
      error = { stage: raw.error.stage, code: raw.error.code, message: text(raw.error.message) };
    }
    return { status: raw.status, endpoint: target.endpoint, observedAt: raw.observedAt, deadlineMs: raw.deadlineMs, elapsedMs: raw.elapsedMs, cleanup: raw.cleanup,
      connection, error, source: 'Node net.Socket.connect()', scope: 'One TCP attempt to one literal IP endpoint',
      environment: 'Current OS session; VM or physical identity unverified',
      system: Object.fromEntries(['platform', 'release', 'runtimeArchitecture'].map(key => [key, text(raw.system[key] || 'Unknown', 128)])) };
  } catch (error) {
    return { status: 'blocked', endpoint: target.endpoint, connection: null, error: diagnostic(error, 'TCP evidence') };
  }
}

export function tcpReport(result) {
  const paragraphs = [`${result.status === 'passed' ? 'TCP connection confirmed' : 'TCP check is blocked'} · ${result.endpoint}`];
  if (result.observedAt) paragraphs.push(`${result.environment}\n${result.system.platform}, OS release ${result.system.release}, runtime architecture ${result.system.runtimeArchitecture}. Observed ${result.observedAt}.\nAttempt elapsed time: ${result.elapsedMs} ms. Deadline: ${result.deadlineMs} ms. Socket cleanup: ${result.cleanup}.`);
  if (result.connection) {
    const value = result.connection;
    paragraphs.push(`Remote: ${value.remoteAddress}, port ${value.remotePort}, ${value.remoteFamily}.\nLocal: ${value.localAddress}, port ${value.localPort}, ${value.localFamily}.`);
  } else paragraphs.push(`${result.error.stage}: ${result.error.code}. ${result.error.message}`);
  paragraphs.push('At most one TCP connection is attempted to the requested literal IP address and port, with a deadline of up to five seconds while the event loop can run. No application data is sent, no DNS lookup is performed and no network settings change. A confirmed connection is only a TCP transport observation; TLS, HTTP, authentication, application health, other destinations and Validation OS/hardware acceptance remain unverified. Elapsed time includes local setup and scheduling and is not a ping latency measurement.');
  return paragraphs.join('\n\n');
}
