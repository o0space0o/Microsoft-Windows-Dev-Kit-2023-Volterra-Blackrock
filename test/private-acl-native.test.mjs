import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const source = fileURLToPath(new URL('../scripts/Private-WindowsState.cs', import.meta.url));
const fixture = `using System;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
internal static class PrivateAclFixture {
 static readonly string User="S-1-5-21-1-2-3-1000", World="S-1-1-0";
 static readonly HashSet<string> Principals=new HashSet<string>{User,"S-1-5-18","S-1-5-32-544"};
 static RawSecurityDescriptor Descriptor(bool directory) {
  var acl=new RawAcl(2,3);
  foreach(string sid in Principals)acl.InsertAce(acl.Count,new CommonAce(directory?AceFlags.ObjectInherit|AceFlags.ContainerInherit:AceFlags.Inherited,AceQualifier.AccessAllowed,2032127,new SecurityIdentifier(sid),false,null));
  return new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent|ControlFlags.DiscretionaryAclProtected|ControlFlags.SelfRelative,new SecurityIdentifier(User),new SecurityIdentifier("S-1-5-32-544"),null,acl);
 }
 static void Add(RawSecurityDescriptor value,AceQualifier kind,int mask,string sid,bool callback=false) { value.DiscretionaryAcl.InsertAce(0,new CommonAce(AceFlags.None,kind,mask,new SecurityIdentifier(sid),callback,callback?new byte[0]:null)); }
 static int count;
 static void Check(bool directory,bool pass,Action<RawSecurityDescriptor> alter) { var value=Descriptor(directory);alter(value);bool accepted=false;try{PrivateWindowsState.PrivateAccess(value,Principals,directory,directory);accepted=true;}catch(InvalidOperationException){}if(accepted!=pass)throw new Exception("ACL fixture failed: "+count);count++; }
 static int Main() {
  Check(false,true,v=>{});
  Check(true,true,v=>{});
  Check(false,true,v=>Add(v,AceQualifier.AccessDenied,0x20,World));
  Check(false,false,v=>Add(v,AceQualifier.AccessAllowed,0x1,World));
  Check(false,false,v=>Add(v,AceQualifier.AccessDenied,0x2,World));
  Check(true,false,v=>Add(v,AceQualifier.AccessDenied,0x20,World));
  Check(false,false,v=>Add(v,AceQualifier.AccessDenied,0x20,World,true));
  Check(false,false,v=>Add(v,AceQualifier.AccessDenied,0x20,"S-1-5-32-545"));
  Check(false,false,v=>{Add(v,AceQualifier.AccessDenied,0x20,World);Add(v,AceQualifier.AccessDenied,0x20,World);});
  Check(false,false,v=>v.DiscretionaryAcl.RemoveAce(0));
  Check(false,false,v=>v.Owner=new SecurityIdentifier(World));
  Console.WriteLine("{\\\"passed\\\":"+count+"}");return 0;
 }
}`;

test('native ACL checker accepts Chromium execution denial and rejects additional grants', {skip:process.platform!=='win32'||process.arch!=='arm64',timeout:30000}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'volterra-private-acl-'));
  try {
    const compiler = path.join(process.env.SystemRoot,'Microsoft.NET','FrameworkArm64','v4.0.30319','csc.exe');
    const fixtureSource = path.join(directory,'Fixture.cs'), executable=path.join(directory,'Fixture.exe');
    await fs.writeFile(fixtureSource,fixture,{flag:'wx'});
    await execute(compiler,['/nologo','/noconfig','/target:exe','/platform:anycpu',`/reference:${path.join(path.dirname(compiler),'System.dll')}`,`/reference:${path.join(path.dirname(compiler),'System.Core.dll')}`,`/out:${executable}`,source,fixtureSource],{windowsHide:true,timeout:20000});
    const result=await execute(executable,[],{windowsHide:true,timeout:5000});
    assert.equal(result.stderr,'');
    assert.deepEqual(JSON.parse(result.stdout),{passed:11});
  } finally {
    const absolute=path.resolve(directory);
    assert.equal(path.dirname(absolute).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(absolute).startsWith('volterra-private-acl-'));
    assert.equal((await fs.lstat(absolute)).isSymbolicLink(),false);
    assert.equal((await fs.realpath(absolute)).toLowerCase(),absolute.toLowerCase());
    await fs.rm(absolute,{recursive:true});
  }
});
