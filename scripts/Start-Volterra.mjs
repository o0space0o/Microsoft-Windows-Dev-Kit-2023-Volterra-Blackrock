import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensurePrivateState } from '../app/private-state.mjs';
import { prepareLiveWorkspace } from '../app/live-workspace.mjs';

const execute = promisify(execFile);
const samePath = (left, right) => path.relative(path.resolve(left), path.resolve(right)) === '';
const contained = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

export function parseArguments(arguments_) {
  const options = { boot: false, noBrowser: false, port: 43123 };
  for (let index = 0; index < arguments_.length; index++) {
    const value = arguments_[index];
    if (value === '--boot' && !options.boot) options.boot = true;
    else if (value === '--no-browser' && !options.noBrowser) options.noBrowser = true;
    else if (value === '--port' && /^\d+$/.test(arguments_[index + 1] || '')) {
      options.port = Number(arguments_[++index]);
      if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('Choose a loopback port from 1024 to 65535.');
    } else throw new Error(`Unsupported launch argument: ${value}`);
  }
  return options;
}

export async function ownedPath(target, kind = 'file', allowHardlinks = false) {
  target = path.resolve(target);
  let current = target;
  while (true) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !samePath(await fs.realpath(current), current)) throw new Error(`A launch path is redirected: ${current}`);
    if (current === target) {
      if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new Error(`A launch path is not a regular ${kind}: ${current}`);
      if (kind === 'file' && !allowHardlinks && stat.nlink !== 1) throw new Error(`A launch file has multiple links: ${current}`);
    } else if (!stat.isDirectory()) throw new Error(`A launch parent is not a directory: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}

async function ensureDirectory(target) {
  const missing = [];
  let current = path.resolve(target);
  while (true) {
    try { await ownedPath(current, 'directory'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(current); current = path.dirname(current); }
  }
  for (const directory of missing.reverse()) { await fs.mkdir(directory, { mode: 0o700 }); await ownedPath(directory, 'directory'); }
  return ownedPath(target, 'directory');
}

export function volumeIdentity(output) {
  const values = String(output).trim().split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (values.length !== 1 || !/^\\\\\?\\Volume\{[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\}\\$/i.test(values[0])) throw new Error('Persistent storage must belong to one local Windows volume.');
  return values[0];
}

export async function selectPersistentStorage({ systemRoot, roots, readVolume }) {
  const candidates = [];
  for (const root of roots) {
    if (samePath(root, systemRoot)) continue;
    const marker = path.join(root, 'Volterra-persistent.tag');
    try {
      await ownedPath(marker);
      const stat = await fs.stat(marker);
      if (stat.size < 1 || stat.size > 1024) throw new Error('The persistent volume marker is invalid.');
      candidates.push({ root: await ownedPath(root, 'directory'), volume: volumeIdentity(await readVolume(root)) });
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENODEV' && error.code !== 'ENXIO') throw error; }
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? 'Multiple marked persistent volumes were found. Automatic startup cannot choose safely.' : 'No marked persistent volume was found. The image needs its prepared persistent disk before automatic startup.');
  return candidates[0];
}

export async function prepareBootPaths({ root, systemRoot, ramdisk, edition, roots, readVolume, privacy = ensurePrivateState }) {
  if (edition !== 'WinVOS') throw new Error('OS root mode is restricted to the Validation OS image.');
  root = await ownedPath(root, 'directory');
  systemRoot = await ownedPath(systemRoot, 'directory');
  if (!samePath(root, path.join(systemRoot, 'Volterra'))) throw new Error('The boot payload must belong to this OS root.');
  const storage = ramdisk ? await selectPersistentStorage({ systemRoot, roots, readVolume }) : { root: systemRoot, volume: volumeIdentity(await readVolume(systemRoot)) };
  const directory = path.join(storage.root, 'VolterraState');
  if (contained(root, directory) || (ramdisk && contained(systemRoot, directory))) throw new Error('Persistent account and project state must stay outside the boot payload and RAM disk.');
  await privacy({ directory, volume: storage.volume, scope: 'state', create: true, root });
  await ownedPath(directory, 'directory');
  const witness = path.join(directory, `.write-check-${randomUUID()}`);
  await fs.writeFile(witness, 'Persistent state write check', { flag: 'wx', mode: 0o600 });
  await ownedPath(witness);
  await fs.unlink(witness);
  return { systemRoot, projectRoot: storage.root, stateDirectory: directory, storageRoot: storage.root, volume: storage.volume, projectRootPersistent: true, ramdisk };
}

export async function writeLaunchEvidence(directory, value, { privacy = ensurePrivateState } = {}) {
  await privacy({ directory, volume: value.volume || '', scope: 'state' });
  await ownedPath(directory, 'directory');
  const destination = path.join(directory, 'boot-launch.json');
  try { await ownedPath(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.boot-launch-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify({ version: 1, ...value, bootAccepted: false, runtimeAccepted: false, physicalHardwareAccepted: false }, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    await ownedPath(directory, 'directory');
    try { await ownedPath(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(temporary, destination);
  } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}

async function nativeOutput(command, arguments_, env) {
  const result = await execute(command, arguments_, { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8', env });
  return result.stdout;
}

async function reservePort(port) {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
}

async function waitForListening(port, stopped) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stopped()) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      await response.body?.cancel();
      if (response.ok && !stopped()) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(stopped() ? 'The helper exited before opening its workspace.' : 'The helper did not open its loopback workspace within one minute.');
}

async function runChild(command, arguments_, options = {}) {
  const child = spawn(command, arguments_, { windowsHide: true, stdio: 'inherit', ...options });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`The native launch prerequisite failed (${code}).`);
}

export async function launch(options) {
  if (process.platform !== 'win32' || process.arch !== 'arm64') throw new Error('This launcher requires the staged Windows ARM64 runtime.');
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let tools = path.join(root, 'private', 'tools');
  let node = await ownedPath(path.join(tools, 'node.exe'));
  if (!samePath(process.execPath, node)) throw new Error('Start the helper with its staged Node runtime.');
  let codex = await ownedPath(path.join(tools, 'codex.exe'));
  let gh = await ownedPath(path.join(tools, 'gh.exe'));
  let git = await ownedPath(path.join(tools, 'git', 'cmd', 'git.exe'));
  let chrome = options.noBrowser ? null : await ownedPath(path.join(tools, 'chrome', 'chrome.exe'));
  const env = { ...process.env, VOLTERRA_CODEX_PATH: codex, VOLTERRA_GH_PATH: gh, VOLTERRA_GIT_PATH: git, VOLTERRA_PORT: String(options.port), PATH: `${path.dirname(git)};${tools};${process.env.PATH || ''}` };
  delete env.VOLTERRA_BROWSER_PID;
  delete env.VOLTERRA_BROWSER_STARTED_UTC;
  let boot;
  if (options.boot) {
    if (!/^[A-Z]:$/i.test(env.SystemDrive || '') || !env.SystemRoot) throw new Error('The boot environment has no valid Windows system drive.');
    const systemRoot = `${env.SystemDrive}\\`;
    const reg = await ownedPath(path.join(env.SystemRoot, 'System32', 'reg.exe'), 'file', true);
    const mountvol = await ownedPath(path.join(env.SystemRoot, 'System32', 'mountvol.exe'), 'file', true);
    const editionOutput = await nativeOutput(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'EditionID'], env);
    const edition = /^\s*EditionID\s+REG_SZ\s+(\S+)\s*$/mi.exec(editionOutput)?.[1];
    const roots = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
    const ramdisk = env.SystemDrive.toUpperCase() === 'X:';
    let live;
    // The public, credential-free seed is checked against its sealed image
    // hashes first. Private-state input handles are then verified on NTFS,
    // rather than treating RAM-image file identities as persistent identities.
    const bootPrivacy = ramdisk ? async options => {
      live ||= await prepareLiveWorkspace({root,storageRoot:path.dirname(options.directory),guard:ownedPath,notify:console.log});
      return ensurePrivateState({...options,root:live.applicationRoot});
    } : ensurePrivateState;
    boot = await prepareBootPaths({ root, systemRoot, ramdisk, edition, roots, privacy:bootPrivacy, readVolume: volume => nativeOutput(mountvol, [volume, '/L'], env) });
    if(boot.ramdisk) {
      root=live.applicationRoot; tools=path.join(root,'private','tools'); node=await ownedPath(path.join(tools,'node.exe'));
      codex=await ownedPath(path.join(tools,'codex.exe'));gh=await ownedPath(path.join(tools,'gh.exe'));git=await ownedPath(path.join(tools,'git','cmd','git.exe'));
      chrome=options.noBrowser?null:await ownedPath(path.join(tools,'chrome','chrome.exe'));boot.applicationRoot=root;
      Object.assign(env,{VOLTERRA_CODEX_PATH:codex,VOLTERRA_GH_PATH:gh,VOLTERRA_GIT_PATH:git,PATH:`${path.dirname(git)};${tools};${process.env.PATH||''}`});
      for(const name of ['AGENTS.md','PROJECT_BRIEF.md']) {
        const destination=path.join(boot.projectRoot,name);
        try {await ownedPath(destination);} catch(error) {if(error.code!=='ENOENT')throw error;const source=await ownedPath(path.join(systemRoot,name));await fs.copyFile(source,destination,fs.constants.COPYFILE_EXCL);}
      }
    }
    Object.assign(env, { VOLTERRA_OS_ROOT: boot.projectRoot, VOLTERRA_STATE_DIR: boot.stateDirectory, VOLTERRA_STATE_VOLUME: boot.volume, CODEX_HOME: path.join(boot.stateDirectory, 'codex'), GH_CONFIG_DIR: path.join(boot.stateDirectory, 'github'), VOLTERRA_AUTOSTART: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: root });
    await writeLaunchEvidence(boot.stateDirectory, { stage: 'Preparing', edition, ...boot, stateWritable: true, stateSurvivedRestart: false, sourceHealthConfirmed: false }, {privacy:options=>ensurePrivateState({...options,root})});
    const updater = await ownedPath(path.join(root, 'private', 'bootstrap', 'Apply-SourceUpdate.mjs'));
    await runChild(node, [updater, boot.stateDirectory, root, 'apply', git], { cwd: root, env });
  }
  if (!boot) {
    env.VOLTERRA_STATE_DIR ||= path.join(env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', '.local', 'share'), 'VolterraWorkspace');
    await ensurePrivateState({ directory: env.VOLTERRA_STATE_DIR, scope: 'state', create: true, root });
  }
  env.VOLTERRA_BROWSER_PROFILE = boot ? path.join(boot.stateDirectory, 'browser') : (env.VOLTERRA_BROWSER_PROFILE || path.join(env.VOLTERRA_STATE_DIR, 'browser'));
  await ensurePrivateState({ directory: env.VOLTERRA_BROWSER_PROFILE, scope: 'browser', create: true, root });
  await reservePort(options.port);
  const server = await ownedPath(path.join(root, 'app', 'server.mjs'));
  console.log(`Microsoft Volterra workspace: http://127.0.0.1:${options.port}`);
  console.log('Live progress appears in this terminal and in the workspace. Send messages or questions in its conversation.');
  console.log('ChatGPT and GitHub use separate official browser sign-ins. No API key is required.');
  if (boot?.ramdisk) console.log('Validation OS runs in RAM. The live overlay, project files and account history use the prepared persistent drive.');
  const child = spawn(node, [server], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  let stopped = false, exitCode;
  const closed = new Promise((resolve, reject) => { child.once('error', error => { stopped = true; reject(error); }); child.once('close', code => { stopped = true; exitCode = code; resolve(code); }); });
  closed.catch(() => {});
  const stop = () => { if (!stopped) child.kill(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await waitForListening(options.port, () => stopped);
    if (boot) await writeLaunchEvidence(boot.stateDirectory, { stage: 'Listening', edition: 'WinVOS', ...boot, stateWritable: true, stateSurvivedRestart: false, helperPid: child.pid, helperListening: true, sourceHealthConfirmed: false }, {privacy:options=>ensurePrivateState({...options,root})});
    if (chrome) {
      env.VOLTERRA_BROWSER_STARTED_UTC = new Date().toISOString();
      const browser = spawn(chrome, ['--no-first-run', '--start-fullscreen', `--user-data-dir=${env.VOLTERRA_BROWSER_PROFILE}`, `--app=http://127.0.0.1:${options.port}/?screen=connections`], { cwd: root, env, windowsHide: false, stdio: 'ignore' });
      await new Promise(resolve => {
        browser.once('spawn', () => { if (Number.isSafeInteger(browser.pid) && browser.pid > 0) env.VOLTERRA_BROWSER_PID = String(browser.pid); resolve(); });
        browser.once('error', () => { console.error('The browser could not start. Runtime acceptance remains pending.'); resolve(); });
      });
      browser.unref();
    }
    if (boot) {
      const probe = path.join(root, 'scripts', 'Test-BootRuntime.mjs');
      try {
        await ownedPath(probe);
        const verifier = spawn(node, [probe, '--port', String(options.port)], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
        verifier.once('error', () => console.error('The native runtime verifier could not start. Source health remains unconfirmed.'));
        verifier.once('close', code => { if (code !== 0) console.error('Runtime verification is incomplete. See the persistent boot-runtime report.'); });
        verifier.unref();
      } catch (error) { if (error.code !== 'ENOENT') throw error; console.log('The native runtime verifier is unavailable. Source health and runtime acceptance remain pending.'); }
    }
    exitCode = await closed;
    if (boot) await writeLaunchEvidence(boot.stateDirectory, { stage: 'Stopped', edition: 'WinVOS', ...boot, stateWritable: true, stateSurvivedRestart: false, helperExitCode: exitCode, sourceHealthConfirmed: false }, {privacy:options=>ensurePrivateState({...options,root})});
    return exitCode === 0 ? 0 : 1;
  } catch (error) {
    if (boot) await writeLaunchEvidence(boot.stateDirectory, { stage: 'Failed', edition: 'WinVOS', ...boot, stateWritable: true, stateSurvivedRestart: false, helperExitCode: exitCode ?? null, sourceHealthConfirmed: false }, {privacy:options=>ensurePrivateState({...options,root})});
    throw error;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); if (!stopped) child.kill(); }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try { process.exitCode = await launch(parseArguments(process.argv.slice(2))); }
  catch (error) { console.error(`Automatic startup stopped: ${error.message}`); process.exitCode = 1; }
}
