import { CodexBridge } from '../app/codex.mjs';
import { powershell, root } from '../app/platform.mjs';
const bridge = new CodexBridge();
try {
  await bridge.start();
  const execution = await bridge.request('command/exec', { command: [powershell, '-NoProfile', '-Command', '[Environment]::OSVersion.Version.ToString()'], cwd: process.env.VOLTERRA_OS_ROOT || root, sandboxPolicy: { type: 'readOnly', networkAccess: false }, timeoutMs: 10000 });
  if (execution.exitCode !== 0) throw new Error('The sandbox command probe did not complete successfully.');
  console.log(JSON.stringify({ appServerInitialized: true, sandboxCommandCompleted: true, osVersion: execution.stdout.trim() }));
} catch (error) {
  console.log(JSON.stringify({ appServerInitialized: false, error: error.message }));
  process.exitCode = 1;
} finally { await bridge.stop(); }
