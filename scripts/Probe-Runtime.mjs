import { CodexBridge } from '../app/codex.mjs';
import { powershell, root } from '../app/platform.mjs';
import { probeCodexRuntime } from '../app/runtime-verification.mjs';
const bridge = new CodexBridge();
const report = await probeCodexRuntime(bridge, { powershell, cwd: process.env.VOLTERRA_OS_ROOT || root, threadId: process.env.VOLTERRA_PROBE_THREAD_ID });
console.log(JSON.stringify(report));
if (!report.appServerInitialized || !report.nativeSandboxReady || !report.sandboxCommandCompleted || !report.chatgptAccountObserved) process.exitCode = 1;
