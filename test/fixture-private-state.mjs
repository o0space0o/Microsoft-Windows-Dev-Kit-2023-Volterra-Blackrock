// Explicit test injection only. This does not provide a Windows DACL claim or
// alter the production checker's environment/configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function fixturePrivateState(temporaryRoot) {
  const root = path.resolve(temporaryRoot), relative = path.relative(path.resolve(os.tmpdir()), root);
  assert.ok(relative.startsWith('volterra-') && !relative.includes(path.sep), 'One named ordinary temporary fixture root is required.');
  const contained = value => { const r = path.relative(root, path.resolve(value)); return r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
  async function ordinary(directory) {
    assert.ok(contained(directory), 'The fixture checker cannot access a host namespace.');
    for (let current = path.resolve(directory); ; current = path.dirname(current)) {
      const value = await fs.lstat(current);
      assert.ok(value.isDirectory() && !value.isSymbolicLink(), 'A fixture directory is redirected or not ordinary.');
      assert.equal(path.relative(await fs.realpath(current), current), '', 'A fixture directory is redirected.');
      if (current === root) return;
    }
  }
  return async ({ directory, scope = 'state', create = false }) => {
    assert.ok(['state', 'codex', 'github', 'browser'].includes(scope));
    assert.ok(contained(directory), 'The fixture checker cannot access a host namespace.');
    if (create) {
      const missing = []; let current = path.resolve(directory);
      while (true) {
        try { await ordinary(current); break; } catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(current); current = path.dirname(current); }
      }
      for (const value of missing.reverse()) { await fs.mkdir(value, { mode: 0o700 }); await ordinary(value); }
      if (scope === 'state') for (const name of ['codex', 'github', 'browser']) {
        const child = path.join(directory, name); try { await fs.mkdir(child, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } await ordinary(child);
      }
    }
    await ordinary(directory);
    return { status: 'private', directory, fixtureOnly: true, windowsDACLVerified: false, sourceBoundNativeProof: false, existingACLsChanged: false };
  };
}
