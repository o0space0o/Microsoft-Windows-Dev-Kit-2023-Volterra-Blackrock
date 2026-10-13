import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {prepareLiveWorkspace,liveSeedPath,hashLiveFile} from '../app/live-workspace.mjs';
import {ownedPath} from '../scripts/Start-Volterra.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex').toUpperCase();
async function fixture(t) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'volterra-live-seed-'));
 t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert.ok(path.basename(directory).startsWith('volterra-live-seed-'));assert.equal((await fs.lstat(directory)).isSymbolicLink(),false);await fs.rm(directory,{recursive:true});});
 const root=path.join(directory,'ram','Volterra'),storageRoot=path.join(directory,'persistent');await fs.mkdir(root,{recursive:true});await fs.mkdir(storageRoot);
 const files={};
 for(const file of ['app/server.mjs','scripts/Start-Volterra.mjs','private/source-version.json','private/tools/node.exe','private/tools/volterra-facts.exe','private/tools/volterra-facts-build.json']) {
  const bytes=Buffer.from('Credential-free fixture: '+file);const target=path.join(root,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);files[file]=digest(bytes);
 }
 const seed={version:1,kind:'volterraLiveSeed',repository:'o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock',commit:'a'.repeat(40),files};
 const save=()=>fs.writeFile(path.join(root,'private','live-seed.json'),JSON.stringify(seed));await save();
 return {root,storageRoot,guard:ownedPath,seed,save};
}
test('RAM overlay automatically seeds one persistent workspace and retains later project edits',async t=>{
 const f=await fixture(t);const first=await prepareLiveWorkspace(f);assert.equal(first.projectRoot,f.storageRoot);assert.equal(first.applicationRoot,path.join(f.storageRoot,'Volterra'));assert.equal(first.seeded,true);
 const source=path.join(first.applicationRoot,'app','server.mjs');await fs.writeFile(source,'Saved project edit');const again=await prepareLiveWorkspace(f);assert.equal(again.seeded,false);assert.equal(await fs.readFile(source,'utf8'),'Saved project edit');assert.deepEqual(await fs.readdir(f.storageRoot),['Volterra']);
});
test('live seeding excludes account files and source escapes before writing',async t=>{
 const f=await fixture(t);for(const file of ['../outside','private/auth.json','private/tools/codex/auth.json','private/tools/chrome/Default/Cookies','private/tools/chrome/SetupMetrics/fixture.pma','private/tools/../auth.json'])assert.equal(liveSeedPath(file),false);
 f.seed.files['private/auth.json']='A'.repeat(64);await f.save();await assert.rejects(prepareLiveWorkspace(f),/protected path/);assert.deepEqual(await fs.readdir(f.storageRoot),[]);
});
test('unrecognized existing project directories are retained',async t=>{
 const f=await fixture(t),target=path.join(f.storageRoot,'Volterra');await fs.mkdir(target);await fs.writeFile(path.join(target,'work.txt'),'Retained');await assert.rejects(prepareLiveWorkspace(f));assert.equal(await fs.readFile(path.join(target,'work.txt'),'utf8'),'Retained');
});
test('changed runtime bytes never become an existing live executable',async t=>{
 const f=await fixture(t);const result=await prepareLiveWorkspace(f);await fs.writeFile(path.join(result.applicationRoot,'private','tools','node.exe'),'Changed fixture');await assert.rejects(prepareLiveWorkspace(f),/differs from its verified image/);
});
test('linked source leaves cannot be seeded',async t=>{
 const f=await fixture(t);await fs.link(path.join(f.root,'app','server.mjs'),path.join(f.storageRoot,'linked-source'));await assert.rejects(prepareLiveWorkspace(f),/multiple links/);await assert.rejects(fs.access(path.join(f.storageRoot,'Volterra')),{code:'ENOENT'});
});

test('large live runtimes are hashed with bounded reads and no whole-file buffer',async t=>{
 const f=await fixture(t),file=path.join(f.root,'private','tools','large-fixture.dat');
 const bytes=64*1024*1024,writer=await fs.open(file,'wx');await writer.truncate(bytes);await writer.close();
 const expected=createHash('sha256'),zero=Buffer.alloc(1024*1024);for(let i=0;i<64;i++)expected.update(zero);
 let maximumRead=0,totalRead=0;
 const io={open:async(...args)=>{const handle=await fs.open(...args);return {stat:options=>handle.stat(options),close:()=>handle.close(),read:async(buffer,offset,count,position)=>{maximumRead=Math.max(maximumRead,count);assert.ok(buffer.length<=1024*1024);const result=await handle.read(buffer,offset,count,position);totalRead+=result.bytesRead;return result;}};}};
 assert.equal(await hashLiveFile(file,{io,guard:ownedPath}),expected.digest('hex').toUpperCase());assert.equal(totalRead,bytes);assert.equal(maximumRead,1024*1024);
});

test('live runtime hashing rejects changes during an opened-file read',async t=>{
 const f=await fixture(t),file=path.join(f.root,'private','tools','node.exe');let changed=false;
 const io={open:async(...args)=>{const handle=await fs.open(...args);return {stat:options=>handle.stat(options),close:()=>handle.close(),read:async(...readArgs)=>{const result=await handle.read(...readArgs);if(!changed){changed=true;await fs.appendFile(file,'Changed after read');}return result;}};}};
 await assert.rejects(hashLiveFile(file,{io,guard:ownedPath}),/changed during verification/);
});
