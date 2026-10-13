import fs from 'node:fs/promises';
import path from 'node:path';

export function inspectSandboxPolicy(value, { edition, ramdisk }) {
  if (edition !== 'WinVOS' || ramdisk !== true || value?.version !== 1 || value.kind !== 'volterraSandboxPolicy' || value.mode !== 'unelevated' || value.userApproved !== true || value.hostWindowsExcluded !== true || Object.keys(value).length !== 5) throw new Error('The live OS sandbox policy is missing or outside its approved scope.');
  return value.mode;
}
export async function readSandboxPolicy({ root, edition, ramdisk, guard }) {
  const file = path.join(root, 'private/bootstrap/sandbox-policy.json'); await guard(file);
  if ((await fs.stat(file)).size > 1024) throw new Error('The live sandbox policy is oversized.');
  return inspectSandboxPolicy(JSON.parse(await fs.readFile(file, 'utf8')), { edition, ramdisk });
}
export async function verifyNativeSandbox(bridge, { cwd, command }) {
  const readiness = await bridge.request('windowsSandbox/readiness', null);
  if (readiness.status !== 'ready') throw new Error('The native Codex sandbox is not ready. Automatic work remains paused.');
  const execution = await bridge.request('command/exec', { command, cwd, sandboxPolicy: { type: 'readOnly', networkAccess: false }, timeoutMs: 10000 });
  if (execution.exitCode !== 0 || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(execution.stdout.trim())) throw new Error('The native Codex sandbox execution check failed. Automatic work remains paused.');
  return true;
}
