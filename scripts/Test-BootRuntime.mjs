import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CodexBridge } from '../app/codex.mjs';
import { redact } from '../app/platform.mjs';
import { atomic } from '../app/storage.mjs';
import { waitForHelperRuntime, probeCodexRuntime, probePersistentHistory, evaluateBootRuntime, inspectBrowserCapture } from '../app/runtime-verification.mjs';
import { readWindowsFacts } from '../app/windows-facts.mjs';
import { renderBrowser } from '../app/browser-probe.mjs';
import { ownedPath } from './Start-Volterra.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Invoke a fixed native executable directly. The exact child is the only
// process terminated on timeout; neither policy nor sandbox settings change.
export function runProbe(executable, args, { timeoutMs = 15000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure;
    const timer = setTimeout(() => { failure = 'The native runtime probe timed out.'; child.kill(); }, timeoutMs);
    const read = (name, chunk) => {
      if (name === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 5_000_000) { failure = 'The native runtime probe returned too much output.'; child.kill(); }
    };
    child.stdout.on('data', chunk => read('stdout', chunk)); child.stderr.on('data', chunk => read('stderr', chunk));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); failure ? reject(new Error(failure)) : resolve({ code, stdout, stderr: redact(stderr), pid: child.pid }); });
  });
}

async function regularPath(file, base, { directory = false } = {}) {
  let ancestor = base;
  while (true) {
    const info = await fs.lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(ancestor, await fs.realpath(ancestor)) !== '') throw new Error('A runtime evidence directory is redirected.');
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  const relative = path.relative(base, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Runtime evidence must stay on its persistent state volume.');
  let current = base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const info = await fs.lstat(current); if (info.isSymbolicLink() || path.relative(current, await fs.realpath(current)) !== '' || (!info.isDirectory() && info.nlink > 1)) throw new Error('A runtime evidence path is linked.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (directory) { const info = await fs.lstat(file); if (!info.isDirectory()) throw new Error('Runtime evidence needs a directory.'); }
}

export async function verifyBootRuntime({ port = 43123, execute = runProbe } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid local helper port.');
  const tools = path.join(sourceRoot, 'private', 'tools');
  const systemRoot = process.env.SystemRoot;
  const result = { version: 2, status: 'running', edition: 'Unknown', architecture: process.arch, systemRoot: `${process.env.SystemDrive || ''}\\`, workspaceRoot:process.env.VOLTERRA_OS_ROOT, versions: {}, utc: new Date().toISOString(), errors: [], environment: 'OS identity unverified', bootIdentityObserved: false, history: { storageConfigured: false, historyReadable: false, survivedBoot: false }, browser: { executableMatched: false, helperScriptExecuted: false, renderCaptured: false } };
  let stateRoot, output;
  const save = async () => { if (output) { await regularPath(output, stateRoot); result.utc = new Date().toISOString(); await atomic(output, JSON.stringify(result, null, 2)); } };
  const evaluate = async () => {
    if (result.historyContext) result.history = await probePersistentHistory(result.historyContext);
    Object.assign(result, evaluateBootRuntime(result)); await save();
  };
  const observe = async timeoutMs => {
    const observed = await waitForHelperRuntime(`http://127.0.0.1:${port}`, { timeoutMs });
    for (const key of ['automaticWorkspace', 'serverReady', 'helperRuntimeReady', 'helperRuntimeRunning', 'helperChatgptAccountObserved']) result[key] = observed[key];
    result.historyContext = { directory: stateRoot, codexHome: process.env.CODEX_HOME, sourceRoot, osRoot: result.systemRoot, bootId: result.bootId, project: observed.project };
    if (observed.error) result.errors.push(observed.error);
    return observed;
  };
  try {
    if (process.platform !== 'win32' || !systemRoot) throw new Error('This native verifier requires the actually booted Windows guest.');
    const identity = await execute(path.join(systemRoot, 'System32', 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'EditionID']);
    if (identity.code !== 0) throw new Error('Native Windows edition inspection failed.');
    result.edition = identity.stdout.match(/\bEditionID\s+REG_SZ\s+(\S+)\s*$/m)?.[1] || 'Unknown';
    if (result.edition !== 'WinVOS') throw new Error('Host inspection cannot run guest tools or source confirmation.');
    result.environment = 'Validation OS; VM or physical identity still needs separate evidence';
    if (!process.env.VOLTERRA_STATE_DIR || !process.env.CODEX_HOME || !process.env.VOLTERRA_OS_ROOT) throw new Error('The native boot launcher must configure OS root and persistent state first.');
    stateRoot = await fs.realpath(process.env.VOLTERRA_STATE_DIR);
    const source = await fs.realpath(sourceRoot), relative = path.relative(source, stateRoot);
    const systemVolume = path.win32.parse(result.systemRoot).root.toLowerCase(), stateVolume = path.win32.parse(stateRoot).root.toLowerCase();
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) || (systemVolume === 'x:\\' ? stateVolume === systemVolume : stateVolume !== systemVolume)) throw new Error('Persistent runtime state must stay outside source and on the configured data volume.');
    output = path.join(stateRoot, 'boot-runtime.json'); await save();
    for (const name of ['node', 'codex', 'gh', 'git']) {
      try {
        const file = name === 'git' ? path.join(tools, 'git', 'cmd', 'git.exe') : path.join(tools, `${name}.exe`);
        const version = await execute(file, ['--version']);
        if (version.code !== 0 || !version.stdout.trim()) throw new Error(`${name} could not report its version in this OS (${version.code}).`);
        result.versions[name] = redact(version.stdout.trim()).slice(0, 512);
      } catch (error) { result.errors.push(redact(error.message)); }
      await save();
    }
    result.versionsVerified = Object.keys(result.versions).length === 4;
    let observed = await observe(120000); await save();
    result.codexProtocol = await probeCodexRuntime(new CodexBridge(), { cwd: process.env.VOLTERRA_OS_ROOT, threadId: observed.project?.threadId, versionCommand: [path.join(tools, 'node.exe'), '-p', 'require("node:os").release()'] });
    await save();
    try {
      const profile = path.join(stateRoot, `runtime-browser-probe-${randomUUID()}`);
      await regularPath(profile, stateRoot); await fs.mkdir(profile); await regularPath(profile, stateRoot, { directory: true });
      const capture = path.join(profile, 'render.png');
      const executable = await ownedPath(path.join(tools, 'chrome', 'chrome.exe'));
      const rendered = await renderBrowser({ executable, profile, capture, url: `http://127.0.0.1:${port}/?runtimeProbe=1`, guard: file => regularPath(file, stateRoot) });
      await regularPath(capture, stateRoot);
      Object.assign(result.browser, inspectBrowserCapture(rendered.stdout, await fs.readFile(capture)));
      result.browser.headlessExecutableRan = true;
      result.browser.capture = capture;
      // This separate, credential-free process proves engine execution and
      // rendering. It does not prove the visible sign-in browser's image path.
      result.browser.imagePathObserved = false;
    } catch (error) { result.errors.push(redact(error.message)); }
    try {
      result.windowsFacts = await readWindowsFacts({ root: sourceRoot, execute, guard: regularPath, browserPid: process.env.VOLTERRA_BROWSER_PID, browserStartedUtc: process.env.VOLTERRA_BROWSER_STARTED_UTC });
      result.bootIdentityObserved = result.windowsFacts.bootIdentityObserved;
      if (result.bootIdentityObserved) result.bootId = result.windowsFacts.bootId;
      result.browser.executableMatched = result.windowsFacts.browserImageObserved;
      result.browser.imagePathObserved = result.windowsFacts.browserImageObserved;
      for (const error of result.windowsFacts.errors) result.errors.push(redact(`${error.stage}: ${error.message}`));
    } catch (error) { result.errors.push(redact(error.message)); }
    if (!result.browser.executableMatched) result.errors.push('The visible browser image path has not been observed through a native process query.');
    observed = await observe(5000); await evaluate();
    result.sourceUpdate = { status: 'unconfirmed', reason: 'Startup health has not passed.' };
    if (result.startupHealthy) {
      const confirmation = await execute(path.join(tools, 'node.exe'), [path.join(tools, '..', 'bootstrap', 'Apply-SourceUpdate.mjs'), stateRoot, sourceRoot, 'confirm', path.join(tools, 'git', 'cmd', 'git.exe')]);
      if (confirmation.code !== 0) throw new Error('Source update health confirmation failed.');
      result.sourceUpdate = JSON.parse(confirmation.stdout);
    }
    if (!result.bootIdentityObserved) result.errors.push('A native boot identity has not been observed; reboot persistence is unproven.');
  } catch (error) { result.errors.push(redact(error.message)); await evaluate().catch(() => { result.status = 'blocked'; }); }
  finally { await save(); }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--port') throw new Error('Use --port followed by a local helper port.');
    const result = await verifyBootRuntime({ port: Number(process.argv[3]) });
    console.log(JSON.stringify({ status: result.status, startupHealthy: result.startupHealthy === true, missingEvidence: result.missingEvidence, errors: result.errors }));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
