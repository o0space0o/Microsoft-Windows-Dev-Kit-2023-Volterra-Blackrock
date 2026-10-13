import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateState, readPrivateInput } from './private-state.mjs';

const namePattern = /^launcher-[1-9]\d{0,9}-\d{1,20}(?:-node)?\.log$/;
const maximumFiles = 4, maximumTail = 65536, maximumEntries = 256, maximumSnapshot = 2_000_000;
const snapshotName = 'native-launcher-logs.json', previousName = 'native-launcher-logs.previous.json';
const same = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';
const within = (base, file) => { const relative = path.relative(base, file); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const sameFile = (a, b) => ['dev', 'ino', 'birthtimeNs'].every(key => typeof a[key] === 'bigint' && a[key] === b[key]) && a.nlink === 1n && b.nlink === 1n;
const ordinaryLog = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
  && typeof info.size === 'bigint' && info.size >= 0n && info.size <= BigInt(Number.MAX_SAFE_INTEGER);

async function tail(file, guard, boot) {
  // Only the fixed native log source from prepareBootPaths' verified WinVOS
  // RAM boot admits differing device numbers between named and handle stats.
  const ramLog = boot.ramdisk && /^X:\\$/i.test(boot.systemRoot)
    && path.win32.dirname(file).toLowerCase() === 'x:\\windows\\temp\\volterralauncher'
    && namePattern.test(path.win32.basename(file));
  await guard(file);
  const namedBefore = await fs.lstat(file, { bigint: true });
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!ordinaryLog(before) || !ordinaryLog(namedBefore)) throw new Error('Unsupported launcher log.');
    const sourceBytes = Number(before.size), offset = Math.max(0, sourceBytes - maximumTail), bytes = Buffer.alloc(sourceBytes - offset);
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, offset + read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true }), namedAfter = await fs.lstat(file, { bigint: true });
    await guard(file);
    // The measured RAM provider reports lstat.dev=0 and a nonzero fstat.dev.
    // Check each API against itself with exact 64-bit identities; preserve the
    // cross-API check everywhere else. Appends are allowed, truncation is not.
    const measuredRamMetadata = ramLog && namedBefore.dev === 0n && namedAfter.dev === 0n && before.dev > 0n && after.dev > 0n;
    if (read !== bytes.length || !ordinaryLog(after) || !ordinaryLog(namedAfter)
      || !sameFile(before, after) || !sameFile(namedBefore, namedAfter) || (!measuredRamMetadata && !sameFile(after, namedAfter))
      || before.size < namedBefore.size || after.size < before.size || namedAfter.size < after.size) throw new Error('Launcher log changed identity.');
    return { name: path.basename(file), sourceBytes, offset, text: bytes.toString('utf8') };
  } finally { await handle.close(); }
}

// This owns only two bounded JSON files in already verified private state.
// It never copies arbitrary files, scans account directories or changes ACLs.
export function startLauncherDiagnostics({ boot, root, guard, privacy = ensurePrivateState, interval = setInterval, cancel = clearInterval }) {
  let pending = null, closing = null, stopped = false, rotated = false, failure = null;
  const captureId = randomUUID();
  async function snapshot() {
    if (!boot?.ramdisk || boot.projectRootPersistent !== true || typeof guard !== 'function'
      || !same(boot.stateDirectory, path.join(boot.storageRoot, 'VolterraState'))
      || within(boot.systemRoot, boot.stateDirectory) || within(root, boot.stateDirectory)) throw new Error('No verified persistent diagnostic destination.');
    const source = path.join(boot.systemRoot, 'Windows', 'Temp', 'VolterraLauncher');
    await guard(source, 'directory');
    const files = [];
    let count = 0;
    const directory = await fs.opendir(source);
    for await (const entry of directory) {
      if (++count > maximumEntries) throw new Error('Launcher log directory exceeds its bound.');
      if (!namePattern.test(entry.name)) continue;
      const file = path.join(source, entry.name);
      await guard(file);
      const stat = await fs.lstat(file);
      files.push({ file, modified: stat.mtimeMs });
    }
    if (!files.length) return { status: 'unavailable' };
    files.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
    const logs = [];
    // Captured text is untrusted diagnostic content, never boot acceptance or
    // authority to execute a command. Persistent input checks remain strict.
    for (const item of files.slice(0, maximumFiles)) logs.push(await tail(item.file, guard, boot));
    await privacy({ directory: boot.stateDirectory, volume: boot.volume, scope: 'state', root });
    await guard(boot.stateDirectory, 'directory');
    async function write(name, bytes) {
      if (bytes.length > maximumSnapshot) throw new Error('Diagnostic snapshot exceeds its bound.');
      const destination = path.join(boot.stateDirectory, name);
      try { await guard(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temporary = path.join(boot.stateDirectory, `.native-launcher-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
        await guard(temporary); await guard(boot.stateDirectory, 'directory');
        try { await guard(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(temporary, destination);
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    if (!rotated) {
      let previous;
      try {
        const file = path.join(boot.stateDirectory, snapshotName);
        await guard(file);
        previous = await readPrivateInput(file, maximumSnapshot, { guard });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous) {
        const value = JSON.parse(previous.toString('utf8'));
        if (value.version !== 1 || value.kind !== 'volterraNativeLauncherLogs' || !Array.isArray(value.logs) || value.logs.length > maximumFiles) throw new Error('Unsupported prior diagnostic snapshot.');
        await write(previousName, previous);
      }
      rotated = true;
    }
    const value = { version: 1, kind: 'volterraNativeLauncherLogs', captureId, observedAt: new Date().toISOString(), systemRoot: boot.systemRoot,
      sourceDirectory: source, maximumFiles, maximumTailBytes: maximumTail, logs, startupFailure: failure };
    await write(snapshotName, Buffer.from(JSON.stringify(value)));
    return { status: 'captured', files: logs.length };
  }
  function flush() {
    if (!pending) pending = snapshot().catch(() => ({ status: 'unavailable' })).finally(() => { pending = null; });
    return pending;
  }
  // Capture failure is diagnostic only: it cannot reject or delay startup.
  const timer = interval(() => { if (!stopped) void flush(); }, 15000);
  timer.unref?.();
  void flush();
  return {
    flush,
    stop(error) {
      if (closing) return closing;
      stopped = true; cancel(timer);
      failure = error ? String(error.message || 'Startup failed.').slice(0, 2048) : null;
      closing = (async () => { if (pending) await pending; return flush(); })();
      return closing;
    }
  };
}
