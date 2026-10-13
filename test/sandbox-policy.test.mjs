import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSandboxPolicy, verifyNativeSandbox } from '../app/sandbox-policy.mjs';
const policy = () => ({ version: 1, kind: 'volterraSandboxPolicy', mode: 'unelevated', userApproved: true, hostWindowsExcluded: true });
test('approved live policy cannot select a host, unknown mode or unapproved configuration', () => {
  assert.equal(inspectSandboxPolicy(policy(), { edition: 'WinVOS', ramdisk: true }), 'unelevated');
  for (const context of [{ edition: 'Professional', ramdisk: true }, { edition: 'WinVOS', ramdisk: false }]) assert.throws(() => inspectSandboxPolicy(policy(), context));
  for (const alteration of [{ userApproved: false }, { hostWindowsExcluded: false }, { mode: 'mxc' }, { mode: 'elevated' }, { version: 2 }, { extra: true }]) assert.throws(() => inspectSandboxPolicy({ ...policy(), ...alteration }, { edition: 'WinVOS', ramdisk: true }));
});
test('readiness alone never enables an agent whose sandbox cannot execute', async () => {
  const calls = [];
  const bridge = { request: async (method, params) => { calls.push({ method, params }); return method === 'windowsSandbox/readiness' ? { status: 'ready' } : { exitCode: 0, stdout: '10.0.26100' }; } };
  assert.equal(await verifyNativeSandbox(bridge, { cwd: 'A:\\', command: ['node.exe', '-p', 'version'] }), true);
  assert.deepEqual(calls[1].params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  const failed = { request: async method => method === 'windowsSandbox/readiness' ? { status: 'ready' } : { exitCode: 1, stdout: '' } };
  await assert.rejects(verifyNativeSandbox(failed, { cwd: 'A:\\', command: [] }), /execution check failed/);
  const missing = { request: async () => ({ status: 'notConfigured' }) };
  await assert.rejects(verifyNativeSandbox(missing, { cwd: 'A:\\', command: [] }), /not ready/);
});
