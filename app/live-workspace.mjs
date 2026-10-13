import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { allowedSource } from './source-policy.mjs';

const repository = 'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock';
const hash = value => createHash('sha256').update(value).digest('hex').toUpperCase();
const generated = new Set(['private/source-version.json','private/bootstrap/Apply-SourceUpdate.mjs','private/bootstrap/private-state.mjs','private/bootstrap/sandbox-policy.json']);

// Runtime files can exceed hundreds of megabytes. Keep verification memory
// independent of file size, including when reopening the persistent workspace.
export async function hashLiveFile(file, {io = fs, guard} = {}) {
  await guard?.(file);
  const handle = await io.open(file,'r');
  try {
    const before = await handle.stat({bigint:true});
    if(!before.isFile() || before.nlink !== 1n || before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsupported live runtime file.');
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while(position < Number(before.size)) {
      const count = Math.min(buffer.length,Number(before.size)-position);
      const result = await handle.read(buffer,0,count,position);
      if(!Number.isInteger(result.bytesRead) || result.bytesRead < 1 || result.bytesRead > count) throw new Error('Live runtime verification ended early.');
      digest.update(buffer.subarray(0,result.bytesRead));position += result.bytesRead;
    }
    const after = await handle.stat({bigint:true});
    if(!after.isFile() || ['dev','ino','size','nlink','birthtimeNs','ctimeNs','mtimeNs'].some(key => typeof before[key] !== 'bigint' || before[key] !== after[key])) throw new Error('Live runtime changed during verification.');
    await guard?.(file);
    return digest.digest('hex').toUpperCase();
  } finally {await handle.close();}
}
export function liveSeedPath(file) {
  return typeof file === 'string' && !file.includes('\\') && !file.includes(':') && !file.startsWith('/') && !file.split('/').some(part => !part || part === '.' || part === '..')
    && !/(^|\/)(auth\.json|hosts\.yml|Cookies|Login Data|History)$/i.test(file)
    && !/^private\/tools\/chrome\/SetupMetrics(?:\/|$)/i.test(file)
    && (allowedSource(file) || generated.has(file) || file.startsWith('private/tools/'));
}

export async function prepareLiveWorkspace({ root, storageRoot, guard, notify = () => {} }) {
  root = await guard(root,'directory'); storageRoot = await guard(storageRoot,'directory');
  const manifestPath = path.join(root,'private','live-seed.json'); await guard(manifestPath);
  const info = await fs.stat(manifestPath); if(info.size < 1 || info.size > 512000) throw new Error('The live workspace seed manifest is invalid.');
  const bytes = await fs.readFile(manifestPath), seed = JSON.parse(bytes);
  const entries = Object.entries(seed.files || {});
  if(seed.version !== 1 || seed.kind !== 'volterraLiveSeed' || seed.repository !== repository || !/^[a-f0-9]{40}$/.test(seed.commit || '') || !entries.length || entries.length > 5000
    || entries.some(([file,value]) => !liveSeedPath(file) || !/^[A-F0-9]{64}$/.test(value || ''))
    || !['app/server.mjs','scripts/Start-Volterra.mjs','private/source-version.json','private/tools/node.exe','private/tools/volterra-facts.exe','private/tools/volterra-facts-build.json'].every(file => Object.hasOwn(seed.files,file))) throw new Error('The live workspace seed is incomplete or contains a protected path.');
  const target = path.join(storageRoot,'Volterra'), origin = {version:1,kind:'volterraLiveOrigin',repository,commit:seed.commit,seedSHA256:hash(bytes)};
  let exists = false;
  try { await guard(target,'directory'); exists = true; } catch(error) { if(error.code !== 'ENOENT') throw error; }
  if(exists) {
    const witness = path.join(target,'private','live-origin.json'); await guard(witness);
    if((await fs.stat(witness)).size > 2048) throw new Error('The existing live workspace origin is invalid. Existing work is retained.');
    const existing = JSON.parse(await fs.readFile(witness));
    if(Object.keys(origin).some(key => existing[key] !== origin[key])) throw new Error('The existing live workspace needs a verified image transition. Existing work is retained.');
    // Source may contain reviewed updates or work in progress. Only the sealed
    // runtime/bootstrap is compared here; startup applies its checked queue.
    for(const [file,expected] of entries.filter(([file]) => file.startsWith('private/tools/') || file.startsWith('private/bootstrap/'))) {
      const destination = path.join(target,file); await guard(destination);
      if(await hashLiveFile(destination,{guard}) !== expected) throw new Error('A persistent live runtime differs from its verified image. Existing work is retained.');
    }
    return {applicationRoot:target,projectRoot:storageRoot,seeded:false};
  }
  notify('Preparing the persistent live workspace automatically.');
  const temporary = path.join(storageRoot,`.Volterra-seed-${randomUUID()}`);
  await fs.mkdir(temporary); await guard(temporary,'directory');
  // Failed preparation stays isolated and is never selected as a workspace.
  // No existing project or account directory is deleted or replaced.
  for(const [file,expected] of entries) {
    const source = path.join(root,file); await guard(source);
    if(await hashLiveFile(source,{guard}) !== expected) throw new Error('The live source differs from its image manifest.');
    const destination = path.join(temporary,file); await fs.mkdir(path.dirname(destination),{recursive:true});
    await guard(path.dirname(destination),'directory'); await fs.copyFile(source,destination); await guard(destination);
    if(await hashLiveFile(destination,{guard}) !== expected) throw new Error('Persistent live workspace readback differs.');
  }
  await fs.writeFile(path.join(temporary,'private','live-origin.json'),JSON.stringify(origin),{flag:'wx',flush:true});
  await guard(storageRoot,'directory');
  try { await fs.lstat(target); throw new Error('A live workspace appeared during preparation. Existing work is retained.'); } catch(error) { if(error.code !== 'ENOENT') throw error; }
  await fs.rename(temporary,target); await guard(target,'directory');
  return {applicationRoot:target,projectRoot:storageRoot,seeded:true};
}
