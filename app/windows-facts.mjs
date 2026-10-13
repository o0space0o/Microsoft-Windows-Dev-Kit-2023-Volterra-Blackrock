import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPrivateInput } from './private-state.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const invocationTimeoutMs = 120000;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value) && Number.isFinite(Date.parse(value));
const exactKeys = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function bootTimestamp(dmtf) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(dmtf);
  if (!match) throw new Error('The native boot datetime is unsupported.');
  const local = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7].slice(0, 3)));
  const represented = new Date(local).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  if (represented !== dmtf.slice(0, 14)) throw new Error('The native boot datetime is invalid.');
  const offset = Number(match[9]) * 60000 * (match[8] === '+' ? 1 : -1);
  return new Date(local - offset).toISOString().slice(0, -1) + match[7].slice(3) + '0Z';
}

export function inspectWindowsFacts(value, { pid = 0, chrome, launchedAt, before, after } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 0 || pid > 2147483647 || !Number.isFinite(before) || !Number.isFinite(after) || before > after || after - before > invocationTimeoutMs) throw new Error('Native Windows facts need a bounded invocation and process ID.');
  if (!exactKeys(value, ['version', 'kind', 'status', 'observedAt', 'boot', 'browser', 'errors']) || value.version !== 1 || value.kind !== 'windowsFacts' || !['passed', 'blocked'].includes(value.status)
    || !timestamp(value.observedAt) || Date.parse(value.observedAt) < before - 2000 || Date.parse(value.observedAt) > after + 2000
    || !exactKeys(value.boot, ['observed', 'source', 'utc', 'dmtf']) || value.boot.source !== 'Win32_OperatingSystem.LastBootUpTime' || typeof value.boot.observed !== 'boolean'
    || !exactKeys(value.browser, ['requestedPid', 'observed', 'imagePath', 'creationUtc']) || value.browser.requestedPid !== pid || typeof value.browser.observed !== 'boolean'
    || !Array.isArray(value.errors) || value.errors.length > 2 || value.errors.some(error => !exactKeys(error, ['stage', 'code', 'message']) || !['Boot identity', 'Browser process'].includes(error.stage) || !/^0x[0-9A-F]{8}$/.test(error.code) || typeof error.message !== 'string' || error.message.length > 512)) throw new Error('The native Windows facts schema or observation binding is invalid.');
  const report = { bootIdentityObserved: false, browserImageObserved: false, errors: value.errors };
  if (value.boot.observed) {
    if (!timestamp(value.boot.utc) || Date.parse(value.boot.utc) < Date.UTC(2000, 0, 1) || Date.parse(value.boot.utc) > after + 60000 || typeof value.boot.dmtf !== 'string' || bootTimestamp(value.boot.dmtf) !== value.boot.utc) throw new Error('The native boot identity is invalid.');
    report.bootIdentityObserved = true; report.bootId = value.boot.utc;
  } else if (value.boot.utc !== null || value.boot.dmtf !== null) throw new Error('Unobserved boot identity contains unsupported evidence.');
  if (value.browser.observed) {
    if (!pid || typeof value.browser.imagePath !== 'string' || !path.win32.isAbsolute(value.browser.imagePath) || /[\u0000-\u001f\u007f]/.test(value.browser.imagePath) || !timestamp(value.browser.creationUtc)) throw new Error('The native browser process evidence is invalid.');
    const started = Date.parse(launchedAt), created = Date.parse(value.browser.creationUtc);
    if (!Number.isFinite(started) || created < started - 2000 || created > started + 15000 || created > after + 2000) throw new Error('The browser process does not match the recorded launch interval.');
    if (path.win32.normalize(value.browser.imagePath).toLowerCase() !== path.win32.normalize(chrome).toLowerCase()) throw new Error('The observed browser process does not use the staged executable.');
    report.browserImageObserved = true; report.browserPid = pid; report.browserCreationUtc = value.browser.creationUtc;
  } else if (value.browser.imagePath !== null || value.browser.creationUtc !== null) throw new Error('Unobserved browser process contains unsupported evidence.');
  if (value.status === 'passed' && (!report.bootIdentityObserved || (pid && !report.browserImageObserved) || value.errors.length)) throw new Error('Native Windows facts reported unsupported success.');
  if (value.status === 'blocked' && !value.errors.length) throw new Error('Blocked native Windows facts did not report a failure.');
  return report;
}

export async function readWindowsFacts({ root, execute, guard, browserPid, browserStartedUtc }) {
  let pid = 0;
  if (browserPid !== undefined) {
    if (!/^[1-9]\d{0,9}$/.test(browserPid) || Number(browserPid) > 2147483647) throw new Error('The visible browser process ID is invalid.');
    pid = Number(browserPid);
  }
  const executable = path.join(root, 'private', 'tools', 'volterra-facts.exe');
  const manifestFile = path.join(root, 'private', 'tools', 'volterra-facts-build.json');
  const versionFile = path.join(root, 'private', 'source-version.json');
  for (const file of [executable, manifestFile, versionFile]) await guard(file, root);
  const read = (file, maximum) => readPrivateInput(file, maximum, { guard: value => guard(value, root) });
  const [manifestBytes, versionBytes, executableBytes] = await Promise.all([read(manifestFile, 32768), read(versionFile, 65536), read(executable, 1048576)]);
  if (manifestBytes.length > 32768 || versionBytes.length > 65536 || executableBytes.length > 1048576) throw new Error('Native Windows facts provenance exceeds the supported size.');
  const manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')), version = JSON.parse(versionBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const inputs = [[executable, executableBytes], [manifestFile, manifestBytes], [versionFile, versionBytes]];
  if (manifest.version !== 1 || manifest.kind !== 'volterraWindowsFactsBuild' || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || !/^[a-f0-9]{40}$/.test(version.commit || '')
    || version.repository !== 'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock' || manifest.sourceFile !== 'scripts/Probe-WindowsFacts.cs' || manifest.buildScript !== 'scripts/Build-WindowsFacts.ps1'
    || manifest.executable?.file !== 'private/tools/volterra-facts.exe' || manifest.executable.bytes !== executableBytes.length || !/^[A-F0-9]{64}$/.test(manifest.executable.SHA256) || manifest.executable.SHA256 !== digest(executableBytes)
    || !/^[A-F0-9]{64}$/.test(manifest.sourceSHA256) || !/^[A-F0-9]{64}$/.test(manifest.buildScriptSHA256)) throw new Error('The native Windows facts tool is not bound to this sealed source.');
  const sourceInputs = [[manifest.sourceFile, manifest.sourceSHA256], [manifest.buildScript, manifest.buildScriptSHA256]];
  if (manifest.privateStateSourceFile !== undefined || manifest.privateStateSourceSHA256 !== undefined) {
    if (manifest.privateStateSourceFile !== 'scripts/Private-WindowsState.cs' || !/^[A-F0-9]{64}$/.test(manifest.privateStateSourceSHA256 || '')) throw new Error('The native privacy source provenance is invalid.');
    sourceInputs.push([manifest.privateStateSourceFile, manifest.privateStateSourceSHA256]);
  }
  for (const [file, expected] of sourceInputs) {
    const full = path.join(root, file); await guard(full, root);
    const bytes = await read(full, 1048576);
    if (digest(bytes) !== expected) throw new Error('The native Windows facts source provenance changed.');
    inputs.push([full, bytes]);
  }
  const before = Date.now();
  const observation = await execute(executable, pid ? ['--browser-pid', String(pid)] : [], { timeoutMs: invocationTimeoutMs });
  const after = Date.now();
  if (![0, 1].includes(observation.code) || Buffer.byteLength(observation.stdout) > 32768) throw new Error('Native Windows facts could not return supported evidence.');
  for (const [file, original] of inputs) {
    await guard(file, root); if (digest(await read(file, 1048576)) !== digest(original)) throw new Error('Native Windows facts inputs changed during inspection.');
  }
  const value = JSON.parse(observation.stdout);
  if ((observation.code === 0) !== (value.status === 'passed')) throw new Error('Native Windows facts exit status disagrees with its report.');
  return { ...inspectWindowsFacts(value, { pid, chrome: path.join(root, 'private', 'tools', 'chrome', 'chrome.exe'), launchedAt: browserStartedUtc, before, after }), sourceCommit: manifest.sourceCommit, executableSHA256: manifest.executable.SHA256 };
}
