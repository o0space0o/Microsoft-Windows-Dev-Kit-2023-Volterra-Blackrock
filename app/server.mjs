import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CodexBridge } from './codex.mjs';
import { ChatGPTSignIn } from './auth.mjs';
import { root, executable, run, powershell, openBrowser, chooseFolder, redact } from './platform.mjs';
import { readState, saveState, projectPath, readCredential, stateDirectory } from './storage.mjs';
import { Automation, outcomeSchema, readAutomationConfig } from './automation.mjs';
import { serviceQuery, collectServices, inspectServices, serviceReport } from './service-tools.mjs';
import { deviceQuery, collectDevices, inspectDevices, deviceReport } from './device-tools.mjs';
import { storageQuery, collectStorage, inspectStorage, storageReport } from './storage-tools.mjs';
import { networkQuery, collectNetworking, inspectNetworking, networkReport } from './network-tools.mjs';
import { fileQuery, collectFiles, inspectFiles, fileReport } from './file-tools.mjs';
import { logQuery, collectLogs, inspectLogs, logReport } from './log-tools.mjs';
import { maintenanceQuery, collectMaintenance, inspectMaintenance, maintenanceReport } from './maintenance-tools.mjs';
import { processQuery, collectProcesses, inspectProcesses, processReport } from './process-tools.mjs';
import { dnsQuery, collectDns, inspectDns, dnsReport } from './dns-tools.mjs';
import { memoryQuery, collectMemory, inspectMemory, memoryReport } from './memory-tools.mjs';
import { uptimeQuery, collectUptime, inspectUptime, uptimeReport } from './uptime-tools.mjs';
import { driveQuery, collectDrives, inspectDrives, driveReport } from './drive-tools.mjs';
import { processorQuery, collectProcessors, inspectProcessors, processorReport } from './processor-tools.mjs';
import { resolutionQuery, collectResolution, inspectResolution, resolutionReport } from './dns-resolution-tools.mjs';
import { dependencyQuery, collectDependencies, inspectDependencies, dependencyReport } from './service-dependency-tools.mjs';
import { artworkQuery, collectArtwork, inspectArtwork, artworkReport } from './artwork-tools.mjs';
import { tcpQuery, collectTcp, inspectTcp, tcpReport } from './tcp-tools.mjs';
import { githubBrowserCommand } from '../scripts/Open-Browser.mjs';

export async function createApplication({ port = Number(process.env.VOLTERRA_PORT || 43123), codex = new CodexBridge(), autostart = process.env.VOLTERRA_AUTOSTART === '1', repository, serviceCollector = collectServices, deviceCollector = collectDevices, storageCollector = collectStorage, networkCollector = collectNetworking, browserOpener = openBrowser, fileCollector = collectFiles, logCollector = collectLogs, maintenanceCollector = collectMaintenance, processCollector = collectProcesses, dnsCollector = collectDns, memoryCollector = collectMemory, uptimeCollector = collectUptime, driveCollector = collectDrives, processorCollector = collectProcessors, resolutionCollector = collectResolution, dependencyCollector = collectDependencies, artworkCollector = collectArtwork, tcpCollector = collectTcp } = {}) {
  const state = await readState();
  const defaultFolder = await fs.realpath(process.env.VOLTERRA_OS_ROOT || root);
  if (!state.selected || (process.env.VOLTERRA_OS_ROOT && state.selected !== defaultFolder)) {
    state.projects[defaultFolder] ||= { path: defaultFolder, name: process.env.VOLTERRA_OS_ROOT ? 'System workspace' : 'OS build workspace', threadId: null };
    state.selected = defaultFolder;
  }
  if (process.env.VOLTERRA_OS_ROOT && state.autoContinueVision === undefined) state.autoContinueVision = true;
  await saveState(state);
  const clients = new Set(), journal = [], approvals = new Map();
  await fs.mkdir(stateDirectory, { recursive: true });
  const journalFile = path.join(stateDirectory, 'journal.jsonl');
  try { journal.push(...(await fs.readFile(journalFile, 'utf8')).trim().split('\n').slice(-500).filter(Boolean).map(line => JSON.parse(line))); } catch { /* A partial last line must not prevent recovery. */ }
  let journalWrites = Promise.resolve();
  const session = randomBytes(32).toString('hex');
  let origin, sessionCookieName, account = null, activeTurn = null, loadedThread = null, paused = false, pauseRequested = false, restartRequired = false, github = null, runtimeToken = null, runtimeStart, automation, runtimeReady = false;
  let progressPhase = null, progressSince = new Date().toISOString(), lastActivityAt = journal.at(-1)?.time || null, connectionsChecked = false;
  let initialContinuation = null;
  const finalMessages = new Map();
  let systemTool = null;
  const selected = () => state.selected && state.projects[state.selected];
  const inventoryTools = [
    { kind: 'services', query: serviceQuery, inspect: query => inspectServices(query.filter, serviceCollector), report: serviceReport, script: 'Get-ServiceInventory.ps1' },
    { kind: 'service-dependencies', query: dependencyQuery, inspect: query => inspectDependencies(query.filter, dependencyCollector), report: dependencyReport, script: 'Get-ServiceDependencies.ps1' },
    { kind: 'devices', query: deviceQuery, inspect: query => inspectDevices(query.filter, deviceCollector), report: deviceReport, script: 'Get-DeviceInventory.ps1' },
    { kind: 'storage', query: storageQuery, inspect: () => inspectStorage(selected()?.path || defaultFolder, storageCollector), report: storageReport, notice: 'Reading filesystem capacity for the selected workspace.' },
    { kind: 'drives', query: driveQuery, inspect: query => inspectDrives(query.filter, driveCollector), report: driveReport, script: 'Get-DriveInventory.ps1' },
    { kind: 'networking', query: networkQuery, inspect: query => inspectNetworking(query.filter, networkCollector), report: networkReport, notice: 'Reading assigned interface addresses for this OS session.' },
    { kind: 'tcp', query: tcpQuery, inspect: query => inspectTcp(query.endpoint, tcpCollector), report: tcpReport, notice: 'Initiating one TCP connection to the requested literal IP address and port, without application data.' },
    { kind: 'files', query: fileQuery, inspect: query => inspectFiles(selected()?.path || defaultFolder, query.filter, fileCollector), report: fileReport, notice: 'Reading metadata for the selected workspace root.' },
    { kind: 'logs', query: logQuery, inspect: query => inspectLogs(query.filter, logCollector), report: logReport, script: 'Get-LogInventory.ps1' },
    { kind: 'maintenance', query: maintenanceQuery, inspect: () => inspectMaintenance(maintenanceCollector), report: maintenanceReport, script: 'Get-MaintenanceStatus.ps1' },
    { kind: 'artwork', query: artworkQuery, inspect: () => inspectArtwork(artworkCollector), report: artworkReport, notice: 'Reading the four installed approved reference files and comparing their SHA-256 hashes.' },
    { kind: 'processes', query: processQuery, inspect: query => inspectProcesses(query.filter, processCollector), report: processReport, script: 'Get-ProcessInventory.ps1' },
    { kind: 'dns', query: dnsQuery, inspect: query => inspectDns(query.filter, dnsCollector), report: dnsReport, notice: 'Reading DNS server configuration for the helper’s Node resolver.' },
    { kind: 'dns-resolution', query: resolutionQuery, inspect: query => inspectResolution(query.name, resolutionCollector), report: resolutionReport, notice: 'Sending bounded A and AAAA queries for the requested DNS name through a dedicated Node resolver.' },
    { kind: 'memory', query: memoryQuery, inspect: () => inspectMemory(memoryCollector), report: memoryReport, notice: 'Reading total and free system memory for this OS session.' },
    { kind: 'uptime', query: uptimeQuery, inspect: () => inspectUptime(uptimeCollector), report: uptimeReport, notice: 'Reading OS and helper process uptime.' },
    { kind: 'processors', query: processorQuery, inspect: query => inspectProcessors(query.filter, processorCollector), report: processorReport, notice: 'Reading logical processor models and cumulative CPU time counters.' }
  ];
  function event(type, data) {
    const entry = JSON.parse(redact(JSON.stringify({ type, data, time: new Date().toISOString() })));
    if (type !== 'state') {
      lastActivityAt = entry.time;
      journal.push(entry); if (journal.length > 1000) journal.shift();
      journalWrites = journalWrites.catch(() => {}).then(() => fs.appendFile(journalFile, JSON.stringify(entry) + '\n'));
    }
    const serialized = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of clients) client.write(serialized);
    if (['message', 'command', 'output', 'error', 'notice'].includes(type)) process.stdout.write(`[${type}] ${typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)}\n`);
  }
  const snapshot = () => {
    const savedPhase = automation?.saved.phase;
    const phase = approvals.size ? 'question' : systemTool ? 'checking' : activeTurn && !['working', 'reviewing', 'reviewing-update'].includes(savedPhase) ? 'replying' : paused ? 'paused' : savedPhase || (activeTurn ? 'working' : 'idle');
    if (phase !== progressPhase || (phase === 'checking' && systemTool && progressSince !== systemTool.since)) { progressPhase = phase; progressSince = phase === 'checking' && systemTool ? systemTool.since : new Date().toISOString(); }
    return { project: selected() || null, projects: Object.values(state.projects), authMode: state.authMode, account, github, connectionsChecked, automation: automation?.snapshot() || null, running: !!codex.child, runtimeReady: runtimeReady && !!codex.child, activeTurn, paused, systemTool, interruptRequested: pauseRequested, progress: { phase, since: progressSince, lastActivityAt }, restartRequired: restartRequired || automation?.saved.phase === 'restart-pending', approvals: [...approvals.values()], journal: journal.slice(-300), sourceArtwork: 'Approved reference artwork; sample labels are part of the reference', implementation: 'Development prototype' };
  };
  const publish = () => event('state', snapshot());
  const auth = new ChatGPTSignIn(state, async () => {
    state.authMode = 'siwc'; await saveState(state);
    const credential = await readCredential(); account = { type: 'chatgpt', email: credential.email, source: 'This app’s ChatGPT plan authorization' };
    event('notice', 'ChatGPT plan connected. Project history stays on this device.'); publish();
    await continueInitialVision();
  }, error => event('error', error));
  codex.on('diagnostic', message => event('notice', message));
  codex.on('stopped', () => { runtimeReady = false; loadedThread = null; activeTurn = null; approvals.clear(); event('notice', 'Codex stopped. Saved project history is retained.'); publish(); });
  codex.on('approval', request => {
    approvals.set(request.id, request); event('approval', request);
    event('question', request.method === 'item/tool/requestUserInput' ? request.params.questions.map(question => question.question).join('\n') : request.params.reason || 'Codex needs permission for the pending action.'); publish();
  });
  codex.on('notification', async ({ method, params }) => {
    try {
      const project = selected();
      if (params?.threadId && project?.threadId && params.threadId !== project.threadId) return;
      if (method === 'item/agentMessage/delta') event('message', { itemId: params.itemId, delta: params.delta });
      else if (method === 'item/completed' && params.item?.type === 'agentMessage') finalMessages.set(params.turnId, params.item.text);
      else if (method === 'item/commandExecution/outputDelta') event('output', { itemId: params.itemId, delta: params.delta });
      else if (method === 'item/started') {
        if (params.item?.type === 'commandExecution') event('command', { command: params.item.command, cwd: params.item.cwd });
        else if (params.item?.type === 'fileChange') event('notice', { files: params.item.changes });
      } else if (method === 'turn/started') { activeTurn = params.turn.id; paused = false; publish(); }
      else if (method === 'turn/completed') {
        for (const [id, request] of approvals) if (request.params.turnId === params.turn.id) { approvals.delete(id); codex.approvals?.delete(id); }
        activeTurn = null; paused = pauseRequested && params.turn.status === 'interrupted'; pauseRequested = false;
        event(params.turn.status === 'failed' ? 'error' : 'notice', { status: params.turn.status, error: params.turn.error?.message || null });
        if (project) { project.lastStatus = params.turn.status; project.updatedAt = new Date().toISOString(); await saveState(state); }
        publish();
        const result = finalMessages.get(params.turn.id) || params.turn.items?.filter(item => item.type === 'agentMessage').at(-1)?.text;
        finalMessages.delete(params.turn.id);
        await automation?.completed(params.turn.status, result);
      } else if (method === 'account/login/completed') {
        if (params.success) { await readManagedAccount(); state.authMode = 'codex'; await saveState(state); event('notice', 'Codex browser sign-in completed.'); await continueInitialVision(); }
        else event('error', params.error || 'Codex browser sign-in did not complete.');
        publish();
      } else if (method === 'account/updated') { if (state.authMode === 'codex') await readManagedAccount(); publish(); }
      else if (method === 'error') event('error', params.error?.message || 'Codex reported an error.');
    } catch (error) { event('error', error.message); }
  });
  async function readManagedAccount() {
    const response = await codex.request('account/read', { refreshToken: false });
    account = response.account?.type === 'chatgpt' ? { type: 'chatgpt', email: response.account.email, planType: response.account.planType, source: 'Codex-managed ChatGPT sign-in' } : null;
    return account;
  }
  async function continueInitialVision() {
    if (activeTurn || (automation?.saved.enabled && automation.saved.paused)) return;
    if (initialContinuation) return initialContinuation;
    // Repeated account notifications share startup without resetting an in-flight queue.
    initialContinuation = (async () => {
      // Authorization wakes a ready queue; only an explicit resume clears saved stops.
      if (automation?.saved.enabled) { await automation.tick(); return; }
      if (!state.autoContinueVision || !account) return;
      await actions['agent/vision']();
      state.autoContinueVision = false; await saveState(state);
    })();
    try { await initialContinuation; }
    finally { initialContinuation = null; }
  }
  async function ensureRuntime(mode = state.authMode) {
    if (runtimeStart) await runtimeStart;
    const token = mode === 'siwc' ? await auth.accessToken() : null;
    if (codex.child && token !== runtimeToken) {
      if (activeTurn) throw new Error('Finish or interrupt the current job before renewing the runtime connection.');
      runtimeReady = false; await codex.stop(); loadedThread = null;
    }
    if (!codex.child) {
      runtimeReady = false;
      runtimeToken = token;
      runtimeStart = codex.start(token).finally(() => { runtimeStart = null; });
      await runtimeStart;
    }
    if (mode !== 'siwc') await readManagedAccount();
    runtimeReady = true;
    publish();
  }
  async function ensureThread() {
    const project = selected();
    if (!project) throw new Error('Open a persistent project folder first.');
    if (!state.authMode) throw new Error('Connect ChatGPT or your existing Codex account first.');
    await ensureRuntime();
    if (!account && state.authMode === 'codex') throw new Error('Sign in to Codex using ChatGPT before starting work.');
    if (loadedThread === project.threadId && loadedThread) return project;
    const options = { cwd: project.path, sandbox: 'workspace-write', approvalPolicy: 'on-request' };
    let hostRestrictions = '';
    try { hostRestrictions = await fs.readFile(path.join(stateDirectory, 'approval-blocks.txt'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = project.threadId ? await codex.request('thread/resume', { ...options, threadId: project.threadId })
      : await codex.request('thread/start', { ...options, developerInstructions: 'Read AGENTS.md and PROJECT_BRIEF.md. The user authorized autonomous development, tested source commits to main and staged helper updates. Work in the automatic OS root; original application source is under Volterra. Keep kernel/driver/boot changes in the verified offline-image and recovery workflow. Preserve Windows 11, EFI and recovery partitions. Never restart automatically. Report missing proof and required restarts. Do not publish vendor OS binaries or credentials. The host preview must not alter the current Windows installation.\n' + hostRestrictions });
    project.threadId = result.thread.id; loadedThread = project.threadId; await saveState(state); publish(); return project;
  }
  async function checkRestart() {
    if (!powershell) return;
    try {
      const result = await run(powershell, ['-NoProfile', '-File', path.join(root, 'scripts', 'Get-RestartStatus.ps1')]);
      const detected = JSON.parse(result).required;
      if (detected !== restartRequired) { restartRequired = detected; publish(); }
    } catch { /* An unavailable registry probe must not stop the project helper. */ }
  }
  const actions = {
    'chatgpt/sign-in': body => actions['codex/sign-in'](body || {}),
    'chatgpt/cancel': async () => { auth.cancel(); return {}; },
    'codex/connect': async () => { if (activeTurn) throw new Error('Interrupt the active job before changing accounts.'); await ensureRuntime('codex'); state.authMode = 'codex'; await saveState(state); publish(); return { connected: !!account }; },
    'codex/sign-in': async body => {
      if (activeTurn) throw new Error('Interrupt the active job before signing in again.');
      await ensureRuntime('codex'); state.authMode = 'codex'; await saveState(state);
      const result = await codex.request('account/login/start', { type: body.device ? 'chatgptDeviceCode' : 'chatgpt' });
      await browserOpener(result.authUrl || result.verificationUrl);
      // Do not expose an authorization URL with state or identity hints to logs.
      return { status: 'Waiting for browser sign-in', userCode: result.userCode || null };
    },
    'project/open': async body => {
      if (activeTurn) throw new Error('Pause or interrupt the current job before opening another folder.');
      await automation?.pause();
      const entered = body.browse ? await chooseFolder() : body.path;
      if (!entered) return { cancelled: true };
      if (typeof entered !== 'string' || !path.isAbsolute(entered)) throw new Error('Enter an absolute project folder path.');
      const resolved = await fs.realpath(entered);
      if (!(await fs.stat(resolved)).isDirectory()) throw new Error('The selected path is not a folder.');
      await fs.access(resolved, fs.constants.W_OK);
      state.projects[resolved] ||= { path: resolved, name: path.basename(resolved), threadId: null };
      state.selected = resolved; loadedThread = null; paused = false; await saveState(state); publish();
      return { project: selected() };
    },
    'project/resume': async () => { const project = await ensureThread(); return { project }; },
    'agent/send': async body => {
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 100_000) throw new Error('Enter a message of up to 100,000 characters.');
      let tool, query;
      for (const candidate of inventoryTools) {
        const parsed = candidate.query(body.text);
        if (parsed) { tool = candidate; query = parsed; break; }
      }
      if (tool) {
        if (systemTool) throw new Error('A system inventory is already running.');
        event('user', body.text);
        systemTool = { kind: tool.kind, since: new Date().toISOString() }; publish();
        if (tool.script) event('command', { command: powershell ? `${powershell} -NoProfile -NonInteractive -File "${path.join(root, 'scripts', tool.script)}"` : `Windows ${tool.kind} collector unavailable on this platform`, cwd: root });
        else event('notice', tool.notice);
        try {
          const result = await tool.inspect(query);
          event('output', { itemId: `${tool.kind}-${randomBytes(8).toString('hex')}`, delta: tool.report(result) });
          return { tool: tool.kind, ...result };
        } finally { systemTool = null; publish(); }
      }
      const project = await ensureThread();
      const input = [{ type: 'text', text: body.text, text_elements: [] }];
      event('user', body.text);
      if (activeTurn) return codex.request('turn/steer', { threadId: project.threadId, expectedTurnId: activeTurn, input });
      const result = await codex.request('turn/start', { threadId: project.threadId, input });
      activeTurn = result.turn.id; paused = false; publish(); return { turnId: activeTurn };
    },
    'agent/vision': async () => {
      const brief = await fs.readFile(path.join(root, 'PROJECT_BRIEF.md'), 'utf8');
      return actions['agent/send']({ text: `Continue the authorized Microsoft Volterra implementation in this project. Inspect the current files first, preserve existing work, carry the requirements below into the project, and make verifiable progress. Do not restart this machine.\n\n${brief}` });
    },
    'agent/interrupt': async body => {
      pauseRequested = !!activeTurn;
      await automation?.pause();
      if (!activeTurn) return { status: 'No active turn' };
      const threadId = selected().threadId, turnId = activeTurn;
      await codex.request('turn/interrupt', { threadId, turnId });
      try { await codex.request('thread/backgroundTerminals/clean', { threadId }); }
      catch (error) { event('error', `The turn was interrupted, but stopping background terminals could not be confirmed: ${error.message}`); }
      return { status: 'Interruption requested; waiting for confirmation' };
    },
    'agent/review': async () => {
      if (activeTurn) throw new Error('Finish or interrupt the current job before starting a review.');
      const project = await ensureThread();
      const result = await codex.request('review/start', { threadId: project.threadId, target: { type: 'uncommittedChanges' }, delivery: 'inline' });
      activeTurn = result.turn.id; publish(); return { turnId: activeTurn };
    },
    'approval/reply': async body => {
      const request = approvals.get(String(body.id));
      if (!request) throw new Error('This request is no longer pending.');
      let result;
      if (request.method === 'item/tool/requestUserInput') {
        if (!body.answers || typeof body.answers !== 'object') throw new Error('Answer each question before continuing.');
        result = { answers: body.answers };
      } else if (request.method === 'item/permissions/requestApproval') {
        result = { permissions: body.allow ? request.params.permissions : {}, scope: 'turn' };
      } else result = { decision: body.allow ? 'accept' : 'decline' };
      codex.reply(body.id, result);
      event('user', request.method === 'item/tool/requestUserInput' ? Object.values(body.answers).map(answer => answer.answers.join('\n')).join('\n') : body.allow ? 'Allow this action.' : 'Decline this action.');
      approvals.delete(String(body.id)); publish(); return {};
    },
    'file/read': async body => {
      const target = await projectPath(selected()?.path, body.path);
      if ((await fs.stat(target)).size > 1_000_000) throw new Error('Open a text file smaller than 1 MB.');
      return { path: body.path, content: await fs.readFile(target, 'utf8') };
    },
    'file/save': async body => {
      if (activeTurn) throw new Error('Pause the agent before saving this file to avoid competing edits.');
      if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > 1_000_000) throw new Error('Save a text file smaller than 1 MB.');
      const target = await projectPath(selected()?.path, body.path, true);
      await fs.writeFile(target, body.content, { flag: 'w' }); event('notice', `Saved ${body.path}`); return { saved: true };
    },
    'github/sign-in': async () => {
      if (github?.pending) throw new Error('GitHub browser sign-in is already pending.');
      const env = { ...process.env };
      env.VOLTERRA_BROWSER_PROFILE = path.join(stateDirectory, 'browser');
      if (process.platform === 'win32') env.GH_BROWSER = githubBrowserCommand(process.execPath, path.join(root, 'scripts', 'Open-Browser.mjs'));
      const child = spawn(executable('gh'), ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      github = { pending: true }; publish();
      child.stdin.end();
      let signInOutput = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
        const text = chunk.toString(); event('notice', redact(text));
        signInOutput = (signInOutput + text).slice(-4000);
        const code = signInOutput.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
        if (code && github?.pending) { github.userCode = code[1]; publish(); }
      });
      child.once('error', error => { github = null; event('error', error.message); publish(); });
      child.once('exit', async code => {
        try { github = code === 0 ? { login: await run(executable('gh'), ['api', 'user', '--jq', '.login']) } : null; if (code !== 0) event('error', 'GitHub sign-in did not complete.'); }
        catch (error) { event('error', error.message); github = null; }
        publish();
        if (github?.login && automation?.saved.enabled) await automation.tick();
      });
      return { status: 'Follow the GitHub browser sign-in instructions in the journal' };
    },
    'github/inspect': async body => {
      if (!/^[\w.-]+\/[\w.-]+$/.test(body.repository || '')) throw new Error('Enter a GitHub repository as owner/name.');
      const repo = body.repository;
      const details = JSON.parse(await run(executable('gh'), ['api', `repos/${repo}`]));
      let release = null;
      try { const data = JSON.parse(await run(executable('gh'), ['api', `repos/${repo}/releases/latest`])); release = { tag: data.tag_name, name: data.name, url: data.html_url }; } catch { /* A repository need not have a release. */ }
      const result = { repository: details.full_name, url: details.html_url, defaultBranch: details.default_branch, release, installation: 'Updates are review-only until a publisher verification key and recovery path are configured.' };
      event('notice', result); return result;
    },
    'automation/resume': async () => { await automation.resume(); return { automation: automation.snapshot() }; },
    'automation/pause': async () => actions['agent/interrupt']({ pause: true }),
    'usage/open': async () => { await openBrowser('https://chatgpt.com/settings/usage'); return {}; },
    'restart/check': async () => { await checkRestart(); return { required: restartRequired }; }
  };
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) { response.writeHead(403).end(); return; }
      const url = new URL(request.url, origin);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
      if (url.pathname === '/' && request.method === 'GET') {
        const source = await fs.readFile(path.join(root, 'app', 'public', 'index.html'), 'utf8');
        response.setHeader('Set-Cookie', `${sessionCookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
        response.writeHead(200, { 'Content-Type': mime['.html'] }).end(source.replace('SESSION_TOKEN', session)); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!request.headers.cookie?.split(';').some(value => value.trim() === `${sessionCookieName}=${session}`)) { response.writeHead(403).end(); return; }
        if (url.pathname === '/api/state' && request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(snapshot())); return; }
        if (url.pathname === '/api/events' && request.method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' });
          clients.add(response); response.write(`data: ${JSON.stringify({ type: 'state', data: snapshot() })}\n\n`);
          const keepalive = setInterval(() => response.write(': keepalive\n\n'), 20_000);
          request.on('close', () => { clearInterval(keepalive); clients.delete(response); }); return;
        }
        if (request.method !== 'POST' || request.headers['x-volterra-client'] !== session || !request.headers['content-type']?.startsWith('application/json')) { response.writeHead(403).end(); return; }
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 1_200_000) throw new Error('Request too large.'); }
        const action = actions[url.pathname.slice(5)]; if (!action) { response.writeHead(404).end(); return; }
        const result = await action(body ? JSON.parse(body) : {});
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result || {})); return;
      }
      const assets = { '/app.js': path.join(root, 'app/public/app.js'), '/progress.js': path.join(root, 'app/public/progress.js'), '/style.css': path.join(root, 'app/public/style.css') };
      for (const screen of ['desktop', 'system', 'maintenance', 'connections']) assets[`/design/${screen}.png`] = path.join(root, `design/approved-v1/${screen}.png`);
      const asset = assets[url.pathname];
      if (!asset || request.method !== 'GET') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': mime[path.extname(asset)] }); response.end(await fs.readFile(asset));
    } catch (error) {
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: redact(error.message) }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  sessionCookieName = 'volterra_session_' + server.address().port;
  const config = await readAutomationConfig();
  async function automaticTurn(text, review = false) {
    const project = await ensureThread();
    const result = await codex.request('turn/start', {
      threadId: project.threadId, input: [{ type: 'text', text, text_elements: [] }], outputSchema: outcomeSchema,
      sandboxPolicy: review ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [root], networkAccess: false }
    });
    activeTurn = result.turn.id; paused = false; publish();
  }
  automation = new Automation({ config, repository, enabled: autostart, hooks: {
    connected: () => !!account, active: () => !!activeTurn,
    changed: publish, notice: message => event('notice', message),
    work: async (task, saved) => {
      let restrictions = '';
      try { restrictions = await fs.readFile(path.join(stateDirectory, 'approval-blocks.txt'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return automaticTurn(`Continue the saved thread. This is the authorized automatic queue for ${config.repository}, branch main.\nTask: ${task.title}\n${task.instruction}\nPrevious issue: ${saved.lastError || 'None'}\nImplement one verifiable increment. Do not commit or push yourself: the controller runs independent checks and publishes after review. Stay within the existing sandbox permissions. Do not request sandbox escape or retry denied operations; record the specific missing prerequisite and continue independent work. The user wants a live log and chat, with automatic progress and questions only when an answer is necessary. Return status progress for a tested increment, complete when this task's acceptance evidence exists, or blocked with a specific prerequisite.\nHost restrictions: ${restrictions || 'No additional host restriction recorded.'}\n\n${await fs.readFile(path.join(root, 'PROJECT_BRIEF.md'), 'utf8')}`);
    },
    review: outcome => automaticTurn(`Review the current source changes independently. Read the diff, inspect tests, preserve the approved reference hashes, and check for credentials or vendor binaries. Do not edit or publish. Return complete only if the increment is correct and safe to checkpoint; otherwise return blocked with actionable findings. Work summary: ${outcome.summary}`, true),
    reviewRemote: comparison => automaticTurn(`Review GitHub main changes from ${comparison.current} to ${comparison.latest} in repository ${config.repository}. Use git -C "${root}" to inspect the fetched diff. Do not edit, checkout or publish. Return complete only if the change fits the project and contains no protected OS/credential/vendor files. The controller separately validates and tests a detached snapshot before staging it for restart. Otherwise return blocked with actionable findings.`, true)
  } });
  const restartTimer = setInterval(checkRestart, 30_000); restartTimer.unref();
  if (state.authMode === 'siwc') { const credential = await readCredential(); if (credential) account = { type: 'chatgpt', email: credential.email, source: 'This app’s ChatGPT plan authorization' }; }
  if (state.authMode === 'codex' || autostart) {
    try { await ensureRuntime('codex'); if (account && !state.authMode) { state.authMode = 'codex'; await saveState(state); } }
    catch (error) { event('error', error.message); }
  }
  try { github = { login: await run(executable('gh'), ['api', 'user', '--jq', '.login']) }; } catch { github = null; }
  connectionsChecked = true;
  await automation.start(); publish();
  if (autostart && !account) event('notice', 'Automatic work is waiting for this OS’s first browser sign-in. No project folder setup is needed.');
  return { server, origin, state, actions, snapshot, automation, close: async () => { automation.close(); clearInterval(restartTimer); auth.cancel(); await codex.stop(); await journalWrites; for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const application = await createApplication(); process.stdout.write(`Microsoft Volterra workspace: ${application.origin}\n`); for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await application.close(); process.exit(0); }); }
  catch (error) { process.stderr.write(redact(error.message) + '\n'); process.exit(1); }
}
