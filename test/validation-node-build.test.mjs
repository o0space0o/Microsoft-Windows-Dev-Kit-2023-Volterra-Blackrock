import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { allowedSource, isBuildAutomationSource, hash } from '../app/source-policy.mjs';

const root = new URL('../', import.meta.url);
const read = file => fs.readFile(new URL(file, root));
const delivery = ['.github/workflows/build-validation-node.yml', 'patches/node-v26.10.0-validationos.patch', 'patches/node-v26.10.0-validationos.json', 'patches/README.md'];
const paths = ['deps/uv/src/win/util.c', 'deps/uv/src/win/process.c', 'deps/uv/src/win/winapi.c', 'deps/uv/src/win/winapi.h', 'deps/uv/uv.gyp', 'deps/cares/src/lib/util/ares_rand.c', 'deps/cares/cares.gyp'];
// Application snapshots omit all delivery inputs; a partially missing delivery
// must still fail the public source check rather than silently skip validation.
const deliveryExists = await Promise.all(delivery.map(async file => { try { await fs.access(new URL(file, root)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }));
assert.ok(deliveryExists.every(Boolean) || deliveryExists.every(value => !value), 'Build delivery must be complete or wholly absent from an application snapshot.');
const withoutDelivery = { skip: deliveryExists.every(value => !value) ? 'Optional CI delivery is omitted from this application snapshot.' : false };

test('only the four fixed public build delivery paths receive the optional CI exception', () => {
  for (const file of delivery) { assert.equal(allowedSource(file), true, file); assert.equal(isBuildAutomationSource(file), true, file); }
  for (const file of ['.github/workflows/unknown.yml', '.github/workflows/build-validation-node.yaml', 'patches/private.patch', 'patches/auth.json', 'private/node.patch', '../patches/README.md', 'patches\\README.md', 'patches/../README.md']) {
    assert.equal(allowedSource(file), false, file); assert.equal(isBuildAutomationSource(file), false, file);
  }
  assert.equal(allowedSource('app/fixture.mjs'), true); assert.equal(isBuildAutomationSource('app/fixture.mjs'), false);
});

test('the delivered patch is the exact reviewed seven-file byte sequence', withoutDelivery, async () => {
  const patch = await read(delivery[1]), manifest = JSON.parse(await read(delivery[2]));
  assert.equal(patch.length, 9940); assert.equal(hash(patch).toUpperCase(), 'E7AC4A086B6AA359BD6A17FDD14878E7CAD074D1B828A18D15A96C41F3F1CBF6');
  assert.equal(manifest.patchSHA256, hash(patch).toUpperCase());
  assert.equal(manifest.sourceBytes, 62055788); assert.equal(manifest.sourceSHA256, '7B3A546D33CB7E15A43BDD7A57E0BE5D5FD5FFC553E6E4C120033E66F0BA20C5');
  assert.equal(manifest.upstreamCommit, '151845ab90d3926ceb36eedf1eade09619c3adc9');
  assert.deepEqual(manifest.modifiedFiles.map(row => row.relative), paths);
  assert.deepEqual([...patch.toString('utf8').matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(m => { assert.equal(m[1], m[2]); return m[1]; }), paths);
  for (const row of manifest.modifiedFiles) { assert.match(row.beforeSHA256, /^[A-F0-9]{64}$/); assert.match(row.afterSHA256, /^[A-F0-9]{64}$/); assert.ok(Number.isSafeInteger(row.afterBytes) && row.afterBytes > 0); }
  assert.equal(manifest.compiled, false); assert.equal(manifest.staticApiComplianceAccepted, false); assert.equal(manifest.guestRuntimeAccepted, false);
});

test('all upstream licenses remain exact build and artifact inputs', withoutDelivery, async () => {
  const manifest = JSON.parse(await read(delivery[2])), workflow = (await read(delivery[0])).toString();
  for (const [relative, sha] of [['LICENSE', '6B85EE1983D01FA2CDCDD5D1A3053C6221FAE41D6A54E43B416BF35969FC4128'], ['deps/uv/LICENSE', '16DE0C32B265CB7D46A6D3BD614F259DD4D693A5E26B3407B04AAE8D73041F0C'], ['deps/cares/LICENSE.md', '460F5E768FDA3752CA2169A95DF062578A10FB126BFD65F3B9B1A1BED2F84807']]) {
    assert.equal(manifest.unchangedInputs.find(row => row.relative === relative)?.SHA256, sha);
    assert.ok(workflow.includes(sha));
  }
  const notice = (await read(delivery[3])).toString();
  for (const owner of ['Node.js contributors', 'Joyent, Inc.', 'libuv project contributors', 'Massachusetts Institute of Technology', 'Daniel Stenberg']) assert.ok(notice.includes(owner));
  assert.ok(notice.includes('including the next paragraph'));
});

test('workflow is manual, read-only to the repository and pins official actions', withoutDelivery, async () => {
  const text = (await read(delivery[0])).toString();
  assert.match(text, /\non:\r?\n  workflow_dispatch:\r?\n/);
  assert.doesNotMatch(text, /^  (push|pull_request|schedule):/m);
  assert.match(text, /permissions:\r?\n  contents: read/);
  assert.match(text, /persist-credentials: false/);
  assert.deepEqual([...text.matchAll(/uses: ([^\s#]+)/g)].map(m => m[1]), ['actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02']);
  assert.match(text, /runs-on: windows-2022/); assert.match(text, /release arm64 vs2022 v8temporal/);
  assert.doesNotMatch(text, /without-(?:temporal|ssl)|VCTargetsPath|pull_request_target|secrets\./);
  assert.match(text, /nativeRuntimeSmokePerformed=\$false/);
  const artifact = text.split('          path: |')[1].split('          if-no-files-found:')[0];
  assert.deepEqual(artifact.trim().split(/\r?\n/).map(s => s.trim().split('/').at(-1)), ['node.exe', 'LICENSE', 'libuv-LICENSE', 'c-ares-LICENSE.md', 'input-receipt.json', 'build-exit.json', 'candidate-receipt.json']);
});
