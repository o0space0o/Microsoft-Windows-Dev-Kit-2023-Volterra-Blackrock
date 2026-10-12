import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('actual PowerShell refresh guard refuses retired foundation creation before bootstrap', { skip: process.platform !== 'win32' }, () => {
  const file = fileURLToPath(new URL('./retired-foundation-refresh.pure.ps1', import.meta.url));
  // A PowerShell7 parent can otherwise hand PowerShell5 incompatible module paths.
  const env = { ...process.env }; delete env.PSModulePath;
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const result = spawnSync(shell, ['-NoProfile', '-File', file], { encoding: 'utf8', timeout: 20000, windowsHide: true, env });
    if (shell === 'pwsh.exe' && result.error?.code === 'ENOENT') continue;
    assert.equal(result.status, 0, `${shell}: ${result.stderr || result.error?.message || result.stdout}`);
    const proof = JSON.parse(result.stdout.trim());
    assert.equal(proof.passed, 11, shell);
    assert.equal(proof.operatorInvoked, false, shell);
    assert.equal(proof.nativeOrVMCalls, false, shell);
    assert.equal(proof.filesCreatedCopiedOrDeleted, false, shell);
  }
});
