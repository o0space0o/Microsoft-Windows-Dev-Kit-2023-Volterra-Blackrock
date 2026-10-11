import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { atomic } from './storage.mjs';
import { redact } from './platform.mjs';

// Keep completed observations when a later stage fails. Initialization is not
// authentication, sandbox execution, model access or Validation OS acceptance.
export async function probeCodexRuntime(bridge, { powershell, cwd, threadId } = {}) {
  const report = { appServerInitialized: false, chatgptAccountObserved: false, nativeSandboxReady: false, sandboxCommandCompleted: false, savedThreadReadable: false, errors: [] };
  const diagnostics = [];
  const diagnostic = text => { diagnostics.push(redact(text)); if (diagnostics.length > 10) diagnostics.shift(); };
  bridge.on('diagnostic', diagnostic);
  try {
    await bridge.start(); report.appServerInitialized = true;
    try {
      const account = await bridge.request('account/read', { refreshToken: false });
      report.chatgptAccountObserved = account.account?.type === 'chatgpt';
      if (!report.chatgptAccountObserved) report.errors.push('This OS needs its own official ChatGPT browser sign-in.');
    } catch (error) { report.errors.push(redact(error.message)); }
    try {
      const readiness = await bridge.request('windowsSandbox/readiness', null);
      report.nativeSandboxStatus = readiness.status;
      report.nativeSandboxReady = readiness.status === 'ready';
      if (!report.nativeSandboxReady) report.errors.push(`Native Codex sandbox is ${readiness.status || 'unverified'}. No setup or elevation was attempted.`);
      // Do not fall back to an unsandboxed command when readiness is missing.
      if (report.nativeSandboxReady) {
        const execution = await bridge.request('command/exec', { command: [powershell, '-NoProfile', '-Command', '[Environment]::OSVersion.Version.ToString()'], cwd, sandboxPolicy: { type: 'readOnly', networkAccess: false }, timeoutMs: 10000 });
        report.sandboxCommandCompleted = execution.exitCode === 0 && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(execution.stdout.trim());
        if (report.sandboxCommandCompleted) report.osVersion = execution.stdout.trim();
        else report.errors.push(`Native sandbox command failed (${execution.exitCode}): ${redact(execution.stderr || 'No OS version returned.')}`);
      }
    } catch (error) { report.errors.push(redact(error.message)); }
    if (threadId) {
      try {
        const result = await bridge.request('thread/read', { threadId, includeTurns: false });
        report.savedThreadReadable = result.thread?.id === threadId;
      } catch (error) { report.errors.push(redact(error.message)); }
    }
  } catch (error) { report.errors.push(redact(error.message)); }
  finally { await bridge.stop(); bridge.off('diagnostic', diagnostic); }
  report.diagnostics = diagnostics;
  return report;
}

function inside(base, value) {
  const relative = path.relative(base, value);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function probePersistentHistory({ directory, codexHome, sourceRoot, osRoot, bootId, project }) {
  const report = { storageConfigured: false, historyReadable: false, survivedBoot: false };
  if (!directory || !codexHome || !sourceRoot || !osRoot || !bootId) return report;
  try {
    const [stateRoot, home, source] = await Promise.all([fs.realpath(directory), fs.realpath(codexHome), fs.realpath(sourceRoot)]);
    const systemVolume = path.parse(osRoot).root.toLowerCase(), stateVolume = path.parse(stateRoot).root.toLowerCase();
    if (inside(source, stateRoot) || !inside(stateRoot, home) || home === stateRoot || path.parse(home).root.toLowerCase() !== stateVolume || home !== await fs.realpath(path.join(stateRoot, 'codex')) || (systemVolume === 'x:\\' ? stateVolume === systemVolume : stateVolume !== systemVolume)) return report;
    report.storageConfigured = true;
    if (!project?.threadId) return report;
    const saved = JSON.parse(await fs.readFile(path.join(stateRoot, 'state.json'), 'utf8'));
    const journal = await fs.readFile(path.join(stateRoot, 'journal.jsonl'), 'utf8');
    const entries = journal.split('\n').filter(line => {
      try { const entry = JSON.parse(line); return typeof entry.type === 'string' && typeof entry.time === 'string'; } catch { return false; }
    });
    report.historyReadable = saved.selected === project.path && saved.projects?.[project.path]?.threadId === project.threadId && entries.length > 0;
    if (!report.historyReadable) return report;
    const file = path.join(stateRoot, 'runtime-history-witness.json');
    let previous;
    try { previous = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entryHash = line => createHash('sha256').update(line).digest('hex');
    const matchingWitness = previous?.version === 1 && /^[a-f0-9-]{36}$/.test(previous.id) && typeof previous.bootId === 'string' && previous.bootId && /^[a-f0-9]{64}$/.test(previous.journalEntryHash) && previous.sourceRoot === source && previous.codexHome === home && previous.project === project.path && previous.threadId === project.threadId;
    if (matchingWitness && previous.bootId !== bootId && entries.some(line => entryHash(line) === previous.journalEntryHash)) {
      report.survivedBoot = true; report.witnessId = previous.id;
    }
    if (matchingWitness && !entries.some(line => entryHash(line) === previous.journalEntryHash)) report.error = 'The journal entry recorded before reboot was not retained.';
    // Repeated probes in one boot never count as reboot persistence. Retain a
    // matching witness so that a later user-controlled boot can establish it.
    if (!previous || previous.sourceRoot !== source || previous.codexHome !== home || previous.project !== project.path || previous.threadId !== project.threadId) {
      await atomic(file, JSON.stringify({ version: 1, id: randomUUID(), bootId, sourceRoot: source, codexHome: home, project: project.path, threadId: project.threadId, journalEntryHash: entryHash(entries[0]) }));
    }
    else if (!matchingWitness) report.error = 'The stored history witness is invalid; it cannot prove reboot persistence.';
  } catch (error) { report.error = redact(error.message); }
  return report;
}

export function evaluateBootRuntime(report) {
  const checks = {
    validationOS: report.edition === 'WinVOS',
    runtimeExecutables: report.versionsVerified === true,
    automaticWorkspace: report.serverReady === true && typeof report.systemRoot === 'string' && typeof report.automaticWorkspace === 'string' && path.win32.normalize(report.automaticWorkspace).toLowerCase() === path.win32.normalize(report.systemRoot).toLowerCase(),
    persistentHistory: report.history?.storageConfigured === true && report.history.historyReadable === true && report.history.survivedBoot === true && report.codexProtocol?.savedThreadReadable === true,
    browser: report.browser?.executableMatched === true && report.browser.helperScriptExecuted === true && report.browser.renderCaptured === true,
    nativeCodexSandbox: report.helperRuntimeRunning === true && report.codexProtocol?.appServerInitialized === true && report.codexProtocol.nativeSandboxReady === true && report.codexProtocol.sandboxCommandCompleted === true,
    signIn: report.helperChatgptAccountObserved === true && report.codexProtocol?.chatgptAccountObserved === true
  };
  const prerequisites = {
    validationOS: 'Run this verifier in the actually booted composed Validation OS; host preview and image receipts are insufficient.',
    runtimeExecutables: 'Successfully run the staged Node, Codex, GitHub CLI and Git executables on this OS.',
    automaticWorkspace: 'Observe the live helper automatically selecting this OS root.',
    persistentHistory: 'Retain and read the same saved Codex thread and journal on persistent storage across a user-controlled reboot.',
    browser: 'Run the staged system browser against the helper and capture successful script execution and rendering.',
    nativeCodexSandbox: 'Observe native Codex sandbox readiness and successful read-only command execution on this OS.',
    signIn: 'Verify this OS’s own Codex-managed ChatGPT account in both the helper and app-server; never copy host credentials.'
  };
  const missingEvidence = Object.entries(checks).filter(([, passed]) => !passed).map(([check]) => ({ check, prerequisite: prerequisites[check] }));
  // Source startup health and full runtime acceptance are separate. Missing
  // first sign-in or a reboot witness must not roll back healthy helper code.
  const startupHealthy = checks.validationOS && checks.automaticWorkspace && checks.browser && checks.nativeCodexSandbox && checks.runtimeExecutables && report.history?.storageConfigured === true;
  return { checks, startupHealthy, missingEvidence, status: missingEvidence.length ? 'blocked' : 'passed' };
}

export function inspectBrowserCapture(dom, png) {
  const helperScriptExecuted = /<div id="status" role="status">Codex (ready|not started)/.test(dom) && /<button class="portal"/.test(dom);
  const renderCaptured = Buffer.isBuffer(png) && png.length > 1000 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.subarray(12, 16).toString() === 'IHDR' && png.readUInt32BE(16) === 1672 && png.readUInt32BE(20) === 941;
  return { helperScriptExecuted, renderCaptured };
}
