import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyImageSource } from '../app/image-source.mjs';
import { hash } from '../app/source-policy.mjs';
import { ownedPath } from './Start-Volterra.mjs';

const sourceFile = 'scripts/Launch-Volterra.cpp';
const buildScript = 'scripts/Build-VolterraLauncher.ps1';
const executable = 'private/rebase-tools/DesktopShell.exe';
const archiveSHA256 = 'a317514a7a63badd692032c0c2b8e165f630bbaebbe7a3254348051f43a64949';
const compilerSHA256 = '7b8f98d3990acae9f0132fbc74937d7597529f5e9d9f28ce1e0b0be70f717f78';
// These read-only SOFTWARE identities admit the already inspected Winlogon
// handoffs. A changed OS hive needs a separately reviewed base admission.
const nativeSoftwareSHA256 = '182a8b1454b07dc0fd9b0a0e63b5ae8100670e6b8cb32e8e251297eed685d994';
// The same native handoff after official 26100.9549 Hyper-V guest servicing.
// Hash the pristine WIM projection before DISM package queries load its hives.
// Independent read-only parsing confirmed every key/value matches the guest
// inspection, including Shell and EditionID; the supervisor is unchanged.
const guestSoftwareSHA256 = '8018fdfee5171f1269d1fdc59ef646b8273fa85ecc2e41044609c009c97c4c90';
// The same handoff after the official 26100.9549 WPF feature restores Segoe UI
// faces. Independent pristine readback matched all five guest hive hashes,
// the native supervisor, the official font bytes and all 387 retained INFs.
const wpfSoftwareSHA256 = 'cc6c6ee49702405dc2f8d8b1e12642692831bdfad873f34e783d9a0e5c6f999c';
const commandSoftwareSHA256 = '8d8589c2bb2aa62aa498e0736fa9232121f100c94c2a2d255ca9bc58c5b6a956';
const supervisorSHA256 = '488b67f8368d206dabcf36ea4d6bfe23fe13bbd887cea275840b2d577a1953d7';
const validHash = value => typeof value === 'string' && /^[a-f\d]{64}$/i.test(value);
const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const same = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';

async function readFile(file, maximum) {
  await ownedPath(file);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw new Error('A native launcher input is not a bounded ordinary file.');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    await ownedPath(file);
    if (bytes.length !== before.size || !unchanged(before, after) || !unchanged(after, await fs.lstat(file))) throw new Error('A native launcher input changed during reading.');
    return bytes;
  } finally { await handle.close(); }
}

export function validateBaseHandoff(softwareHash, supervisorHash) {
  if ([nativeSoftwareSHA256, guestSoftwareSHA256, wpfSoftwareSHA256].includes(softwareHash) && supervisorHash === supervisorSHA256) return 'originalNativeSupervisor';
  if (softwareHash === commandSoftwareSHA256 && supervisorHash === null) return 'commandShell';
  throw new Error(`The image has an unsupported SOFTWARE hive or native supervisor handoff (SOFTWARE ${softwareHash}; supervisor ${supervisorHash ?? 'missing'}).`);
}

export async function inspectBaseHandoff(mount) {
  const software = path.join(mount, 'Windows/System32/config/SOFTWARE');
  const supervisor = path.join(mount, 'Programs/Volterra/StartupSupervisor.exe');
  const softwareHash = hash(await readFile(software, 64_000_000));
  let supervisorHash = null;
  try { supervisorHash = hash(await readFile(supervisor, 2_000_000)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { mode: validateBaseHandoff(softwareHash, supervisorHash), softwareSHA256: softwareHash, supervisorSHA256: supervisorHash };
}

export function validateLauncherBuild(manifest, source, binary) {
  if (manifest?.version !== 1 || manifest.kind !== 'volterraNativeLauncherBuild' || manifest.source !== sourceFile
    || manifest.executable !== executable || manifest.architecture !== 'arm64' || manifest.subsystem !== 'console'
    || manifest.guestCompatibilityVerified !== false || manifest.hostBootChanged !== false) throw new Error('The native launcher build receipt is unsupported.');
  for (const [file, expected] of [[sourceFile, manifest.sourceSHA256], [buildScript, manifest.buildScriptSHA256]]) {
    if (!validHash(expected) || source.files?.[file]?.toLowerCase() !== expected.toLowerCase()) throw new Error('Native launcher source or build-script hashes differ from the selected checked source.');
  }
  if (manifest.toolchainArchiveSHA256?.toLowerCase() !== archiveSHA256 || manifest.compilerSHA256?.toLowerCase() !== compilerSHA256
    || manifest.toolchainVerifiedFiles !== 9052) throw new Error('The native launcher lacks the pinned, fully checked compiler provenance.');
  if (manifest.executableSHA256?.toLowerCase() !== hash(binary) || manifest.executableBytes !== binary.length
    || binary.length < 1024 || binary.length > 2_097_152) throw new Error('The native launcher executable differs from its build receipt.');
  const pe = binary.readUInt32LE(0x3c);
  if (binary.readUInt16LE(0) !== 0x5a4d || pe > binary.length - 96 || binary.readUInt32LE(pe) !== 0x4550
    || binary.readUInt16LE(pe + 4) !== 0xaa64 || binary.readUInt16LE(pe + 24) !== 0x20b
    || binary.readUInt16LE(pe + 24 + 68) !== 3) throw new Error('The native launcher must be an ARM64 PE32+ console executable.');
  for (const expected of ['X:\\Windows', 'WinVOS', 'X:\\Volterra\\private\\tools\\node.exe', 'X:\\Volterra\\scripts\\Start-Volterra.mjs',
    '"X:\\Volterra\\private\\tools\\node.exe" "X:\\Volterra\\scripts\\Start-Volterra.mjs" --boot']) {
    if (!binary.includes(Buffer.from(expected + '\0', 'utf16le'))) throw new Error('The native launcher does not contain the reviewed fixed live startup paths.');
  }
}

export async function stageVolterraLauncher({ workspace, mount, source, launcherReceipt = '', inspect = inspectBaseHandoff }) {
  if (!source || !/^[a-f\d]{40}$/.test(source.commit ?? '')) throw new Error('A checked source commit is required for the native handoff.');
  const root = await fs.realpath(workspace);
  if (!same(mount, path.join(root, 'build/current/final-boot'))) throw new Error('Only the current offline live image can receive the native launcher.');
  await ownedPath(mount, 'directory');
  const admitted = await inspect(mount);
  const result = { version: 1, kind: 'volterraLiveLauncherStaging', sourceCommit: source.commit, ...admitted,
    supervisorPreserved: true, softwarePreserved: true, guestCompatibilityVerified: false, physicalHardwareAccepted: false };
  if (admitted.mode === 'commandShell') {
    if (launcherReceipt) throw new Error('A native launcher receipt cannot be applied to the command-shell base.');
    const bytes = await readFile(path.join(mount, 'Windows/Volterra-Startup.cmd'), 64_000);
    if (hash(bytes) !== source.files?.['image/Volterra-Startup.cmd']?.toLowerCase()) throw new Error('The command-shell startup does not match the checked source.');
    if (JSON.stringify(await inspect(mount)) !== JSON.stringify(admitted)) throw new Error('The preserved command-shell handoff changed.');
    return { ...result, startupCommandSHA256: hash(bytes), launcherStaged: false };
  }
  if (admitted.mode !== 'originalNativeSupervisor') throw new Error('Unsupported live startup handoff.');
  if (!launcherReceipt || !same(launcherReceipt, path.join(root, 'private/rebase-tools/launcher-build.json'))) throw new Error('The native-supervisor base requires its explicit staged launcher-build.json receipt.');
  const receiptBytes = await readFile(launcherReceipt, 64_000);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes).replace(/^\uFEFF/, ''));
  const binaryPath = path.join(root, executable), binary = await readFile(binaryPath, 2_097_152);
  validateLauncherBuild(manifest, source, binary);
  const destination = path.join(mount, 'Programs/Volterra/DesktopShell.exe');
  const previous = await readFile(destination, 64_000_000);
  const pending = path.join(path.dirname(destination), `.volterra-launcher-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(pending, binary, { flag: 'wx', flush: true });
    if (hash(await readFile(launcherReceipt, 64_000)) !== hash(receiptBytes) || hash(await readFile(binaryPath, 2_097_152)) !== hash(binary)
      || hash(await readFile(destination, 64_000_000)) !== hash(previous)) throw new Error('A native launcher staging input changed.');
    await fs.rename(pending, destination);
  } finally { await fs.unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  if (hash(await readFile(destination, 2_097_152)) !== hash(binary) || JSON.stringify(await inspect(mount)) !== JSON.stringify(admitted)) throw new Error('The staged launcher or preserved base handoff changed.');
  return { ...result, launcherStaged: true, launcherPath: 'Programs/Volterra/DesktopShell.exe', previousLauncherSHA256: hash(previous),
    launcherSHA256: hash(binary), launcherBuildReceiptSHA256: hash(receiptBytes), build: manifest };
}

if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const [receiptFile, workspace, mount, launcherReceipt = ''] = process.argv.slice(2);
    if (![3, 4].includes(process.argv.length - 2) || !receiptFile || !workspace || !mount) throw new Error('Expected source receipt, workspace, current mount and optional launcher receipt.');
    const source = await verifyImageSource(receiptFile, workspace);
    console.log(JSON.stringify(await stageVolterraLauncher({ workspace, mount, source, launcherReceipt })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
