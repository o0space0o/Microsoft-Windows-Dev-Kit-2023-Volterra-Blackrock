import { waitForHelperRuntime } from '../app/runtime-verification.mjs';
const port = Number(process.argv[2] || 43123);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid local helper port.');
const report = await waitForHelperRuntime(`http://127.0.0.1:${port}`, { timeoutMs: Number(process.argv[3] || 120000) });
console.log(JSON.stringify(report));
if (!report.helperRuntimeReady) process.exitCode = 1;
