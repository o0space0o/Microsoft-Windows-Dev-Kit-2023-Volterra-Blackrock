using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

// Original private-storage prerequisite. Only fresh directories get an explicit
// descriptor. Existing objects are metadata-only: no content, ACL reset,
// account/credential query, privilege adjustment or machine-policy operation.
internal static class PrivateWindowsState
{
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo { public uint Attributes; public FileTime Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public uint Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct StreamInfo { public long Bytes; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=296)] public string Name; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern uint GetFileAttributesW(string path);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, IntPtr buffer, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder name, uint count, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern bool GetVolumePathNameW(string path, StringBuilder root, uint count);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern bool GetVolumeNameForVolumeMountPointW(string root, StringBuilder volume, uint count);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern bool GetVolumeInformationW(string root, StringBuilder name, uint nameCount, out uint serial, out uint componentLength, out uint flags, StringBuilder filesystem, uint filesystemCount);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern IntPtr FindFirstStreamW(string path, int level, out StreamInfo value, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] private static extern bool FindNextStreamW(IntPtr search, out StreamInfo value);
    [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)] private static extern bool FindClose(IntPtr search);
    [DllImport("kernel32.dll", ExactSpelling=true)] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", ExactSpelling=true)] private static extern IntPtr LocalFree(IntPtr pointer);
    [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", ExactSpelling=true, SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", ExactSpelling=true, SetLastError=true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, uint count, out uint needed);
    [DllImport("advapi32.dll", ExactSpelling=true)] private static extern uint GetSecurityInfo(SafeFileHandle file, int kind, uint flags, out IntPtr owner, out IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", ExactSpelling=true)] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("advapi32.dll", ExactSpelling=true)] private static extern bool IsValidSecurityDescriptor(IntPtr descriptor);

    private static readonly Regex Volume = new Regex(@"\A\\\\\?\\Volume\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}\\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private sealed class Context { public string Root, Volume, User, Group; public HashSet<string> Principals; public int Count; public List<string> Created = new List<string>(); public bool RootCreated; }
    private sealed class HeldParent : IDisposable {
        internal SafeFileHandle Handle; internal string Named, Expected; internal FileInfo Before;
        internal void Check(){FileInfo now=Information(Handle);if(now.Attributes!=Before.Attributes||now.Volume!=Before.Volume||now.IndexHigh!=Before.IndexHigh||now.IndexLow!=Before.IndexLow||!String.Equals(Final(Handle),Expected,StringComparison.OrdinalIgnoreCase)||GetFileAttributesW(Named)!=now.Attributes)throw new InvalidOperationException("PRIVATE_PARENT_IDENTITY_REFUSED");}
        public void Dispose(){if(Handle!=null)Handle.Dispose();}
    }
    private sealed class Entry { public string Name; public uint Attributes; public ulong Id; }
    private static Exception Native(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    private static string Json(string value) { if(value==null)return "null";StringBuilder text=new StringBuilder("\"");foreach(char c in value){if(c=='\"'||c=='\\')text.Append('\\').Append(c);else if(c<32||c>126)text.Append("\\u").Append(((int)c).ToString("x4",CultureInfo.InvariantCulture));else text.Append(c);}return text.Append('"').ToString(); }
    internal static string Canonical(string value) {
        string checkedText=value!=null&&value.StartsWith(@"\\?\Volume{",StringComparison.OrdinalIgnoreCase)?value.Substring(4):value;
        if(String.IsNullOrEmpty(value)||value.Length>32000||value.IndexOf('/')>=0||Regex.IsMatch(checkedText,@"[\x00-\x1f\x7f<>\""|?*]"))throw new InvalidOperationException("PRIVATE_PATH_REFUSED");
        string path=value.TrimEnd('\\'); if(path.Length<4)throw new InvalidOperationException("PRIVATE_PATH_REFUSED");
        bool guid=path.StartsWith(@"\\?\Volume{",StringComparison.OrdinalIgnoreCase); if(!guid&&!Regex.IsMatch(path,@"\A[A-Za-z]:\\"))throw new InvalidOperationException("PRIVATE_PATH_REFUSED");
        if(guid){int end=path.IndexOf("}\\",StringComparison.Ordinal);if(end<0||!Volume.IsMatch(path.Substring(0,end+2)))throw new InvalidOperationException("PRIVATE_PATH_REFUSED");}
        string canonical=Path.GetFullPath(path);if(!String.Equals(canonical,path,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PRIVATE_PATH_REFUSED");
        string remainder=guid?path.Substring(path.IndexOf("}\\",StringComparison.Ordinal)+2):path.Substring(3);foreach(string part in remainder.Split('\\'))CheckName(part);
        return path;
    }
    internal static void CheckName(string name) { if(String.IsNullOrEmpty(name)||name=="."||name==".."||name.TrimEnd(' ','.')!=name||name.IndexOfAny(new char[]{'\\','/',':','\0','<','>','"','|','?','*'})>=0)throw new InvalidOperationException("PRIVATE_PATH_REFUSED"); }
    internal static void FreshLocation(string root,string scope) {
        string name=Path.GetFileName(root),parentName=Path.GetFileName(Path.GetDirectoryName(root));bool managedParent=parentName=="VolterraState"||parentName=="VolterraWorkspace";bool allowed=scope=="state"&&(name=="VolterraState"||name=="VolterraWorkspace")||managedParent&&(scope=="codex"&&name=="codex"||scope=="github"&&name=="github"||scope=="browser"&&name=="browser");if(!allowed)throw new InvalidOperationException("PRIVATE_FRESH_LOCATION_REFUSED");
    }
    private static bool Exists(string path) { uint a=GetFileAttributesW(path);if(a!=0xFFFFFFFF){if((a&0x400)!=0||(a&0x10)==0)throw new InvalidOperationException("PRIVATE_DIRECTORY_REFUSED");return true;}int code=Marshal.GetLastWin32Error();if(code==2||code==3)return false;throw new Win32Exception(code,"PRIVATE_METADATA_DENIED"); }
    private static FileInfo Information(SafeFileHandle handle) { FileInfo info;if(!GetFileInformationByHandle(handle,out info))throw Native("PRIVATE_HANDLE_METADATA_FAILED");if((info.Attributes&0x400)!=0||info.Links!=1)throw new InvalidOperationException("PRIVATE_LINK_REFUSED");return info; }
    private static string Final(SafeFileHandle handle) { var text=new StringBuilder(32768);uint count=GetFinalPathNameByHandleW(handle,text,32768,9);if(count==0)throw Native("PRIVATE_FINAL_PATH_FAILED");if(count>=32768)throw new InvalidOperationException("PRIVATE_PATH_REFUSED");return text.ToString().TrimEnd('\\'); }
    private static string PrimaryGroup() {
        IntPtr token=IntPtr.Zero,memory=IntPtr.Zero;try{if(!OpenProcessToken(GetCurrentProcess(),8,out token))throw Native("PRIVATE_TOKEN_QUERY_FAILED");uint needed;bool ok=GetTokenInformation(token,5,IntPtr.Zero,0,out needed);int code=Marshal.GetLastWin32Error();if(ok||code!=122||needed<IntPtr.Size||needed>65536)throw new InvalidOperationException("PRIVATE_TOKEN_QUERY_FAILED");memory=Marshal.AllocHGlobal((int)needed);uint returned;if(!GetTokenInformation(token,5,memory,needed,out returned)||returned>needed)throw Native("PRIVATE_TOKEN_QUERY_FAILED");return new SecurityIdentifier(Marshal.ReadIntPtr(memory)).Value;}finally{if(memory!=IntPtr.Zero)Marshal.FreeHGlobal(memory);if(token!=IntPtr.Zero&&!CloseHandle(token))throw Native("PRIVATE_TOKEN_CLOSE_FAILED");}
    }
    private static RawSecurityDescriptor Descriptor(SafeFileHandle handle) {
        IntPtr owner,group,dacl,descriptor=IntPtr.Zero;try{uint code=GetSecurityInfo(handle,1,7,out owner,out group,out dacl,IntPtr.Zero,out descriptor);if(code!=0)throw new Win32Exception((int)code,"PRIVATE_SECURITY_DENIED");if(descriptor==IntPtr.Zero||!IsValidSecurityDescriptor(descriptor))throw new InvalidOperationException("PRIVATE_SECURITY_REFUSED");uint size=GetSecurityDescriptorLength(descriptor);if(size<20||size>65536)throw new InvalidOperationException("PRIVATE_SECURITY_REFUSED");byte[] bytes=new byte[size];Marshal.Copy(descriptor,bytes,0,(int)size);return new RawSecurityDescriptor(bytes,0);}finally{if(descriptor!=IntPtr.Zero&&LocalFree(descriptor)!=IntPtr.Zero)throw new InvalidOperationException("PRIVATE_SECURITY_RELEASE_FAILED");}
    }
    internal static void PrivateAccess(RawSecurityDescriptor descriptor, HashSet<string> principals, bool directory, bool root) {
        if(descriptor.Owner==null||!principals.Contains(descriptor.Owner.Value)||descriptor.DiscretionaryAcl==null||descriptor.DiscretionaryAcl.Count!=principals.Count||(descriptor.ControlFlags&ControlFlags.DiscretionaryAclPresent)==0||(root&&(descriptor.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0))throw new InvalidOperationException("PRIVATE_ACCESS_REFUSED");
        HashSet<string> seen=new HashSet<string>(StringComparer.Ordinal);foreach(GenericAce item in descriptor.DiscretionaryAcl){CommonAce ace=item as CommonAce;if(ace==null||ace.IsCallback||ace.AceQualifier!=AceQualifier.AccessAllowed||ace.AccessMask!=2032127||!principals.Contains(ace.SecurityIdentifier.Value)||!seen.Add(ace.SecurityIdentifier.Value))throw new InvalidOperationException("PRIVATE_ACCESS_REFUSED");AceFlags explicitFlags=directory?(AceFlags.ObjectInherit|AceFlags.ContainerInherit):AceFlags.None;AceFlags inheritedFlags=explicitFlags|AceFlags.Inherited;if(ace.AceFlags!=explicitFlags&&(root||ace.AceFlags!=inheritedFlags))throw new InvalidOperationException("PRIVATE_ACCESS_REFUSED");}if(!seen.SetEquals(principals))throw new InvalidOperationException("PRIVATE_ACCESS_REFUSED");
    }
    private static void Streams(string path,bool directory) {
        StreamInfo value;IntPtr search=FindFirstStreamW(path,0,out value,0);if(search==new IntPtr(-1)){int code=Marshal.GetLastWin32Error();if(directory&&code==38)return;throw new Win32Exception(code,"PRIVATE_STREAM_METADATA_FAILED");}
        try{int count=0;do{if(++count>1||value.Name!="::$DATA")throw new InvalidOperationException("PRIVATE_STREAM_REFUSED");}while(FindNextStreamW(search,out value));int code=Marshal.GetLastWin32Error();if(code!=38)throw new Win32Exception(code,"PRIVATE_STREAM_METADATA_FAILED");}finally{if(!FindClose(search))throw Native("PRIVATE_STREAM_CLOSE_FAILED");}
    }
    private static List<Entry> Entries(SafeFileHandle handle) {
        var rows=new List<Entry>();var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);IntPtr buffer=Marshal.AllocHGlobal(65536);try{bool restart=true;for(int batch=0;batch<256;batch++){bool ok=GetFileInformationByHandleEx(handle,restart?11:10,buffer,65536);restart=false;if(!ok){int code=Marshal.GetLastWin32Error();if(code==18)return rows;throw new Win32Exception(code,"PRIVATE_DIRECTORY_METADATA_FAILED");}int offset=0;for(int record=0;record<4096;record++){if(offset<0||offset>65536-104)throw new InvalidOperationException("PRIVATE_DIRECTORY_LAYOUT_REFUSED");uint next=unchecked((uint)Marshal.ReadInt32(buffer,offset));uint attrs=unchecked((uint)Marshal.ReadInt32(buffer,offset+56));uint length=unchecked((uint)Marshal.ReadInt32(buffer,offset+60));ulong id=unchecked((ulong)Marshal.ReadInt64(buffer,offset+96));int end=next==0?65536:checked(offset+(int)next);if(length==0||(length&1)!=0||length>510||end>65536||end<offset+104||(next!=0&&(next%8!=0||next<104))||104UL+length>(ulong)(end-offset))throw new InvalidOperationException("PRIVATE_DIRECTORY_LAYOUT_REFUSED");string name=Marshal.PtrToStringUni(IntPtr.Add(buffer,offset+104),(int)length/2);if(name!="."&&name!=".."){CheckName(name);if(!seen.Add(name)||rows.Count>=4096)throw new InvalidOperationException("PRIVATE_DIRECTORY_BOUND_REFUSED");rows.Add(new Entry{Name=name,Attributes=attrs,Id=id});}if(next==0)break;offset=end;if(record==4095)throw new InvalidOperationException("PRIVATE_DIRECTORY_BOUND_REFUSED");}}throw new InvalidOperationException("PRIVATE_DIRECTORY_BOUND_REFUSED");}finally{Marshal.FreeHGlobal(buffer);}
    }
    private static void Walk(Context context,string named,string final,int depth,Entry expected) {
        if(depth>32||++context.Count>100000)throw new InvalidOperationException("PRIVATE_TREE_BOUND_REFUSED");
        uint attributes=GetFileAttributesW(named);if(attributes==0xFFFFFFFF)throw Native("PRIVATE_METADATA_DENIED");bool directory=(attributes&0x10)!=0;if((attributes&0x400)!=0)throw new InvalidOperationException("PRIVATE_LINK_REFUSED");
        // Ancestor directory handles stay open without delete sharing while
        // descendants are inspected. Enumeration uses the held directory.
        using(SafeFileHandle file=CreateFileW(named,0x20080u|(directory?1u:0u),3,IntPtr.Zero,3,0x02200000u,IntPtr.Zero)){
            if(file.IsInvalid)throw Native("PRIVATE_METADATA_DENIED");FileInfo info=Information(file);ulong id=((ulong)info.IndexHigh<<32)|info.IndexLow;
            if(info.Attributes!=attributes||!String.Equals(Final(file),final,StringComparison.OrdinalIgnoreCase)||(expected!=null&&(expected.Id!=id||expected.Attributes!=info.Attributes)))throw new InvalidOperationException("PRIVATE_IDENTITY_REFUSED");PrivateAccess(Descriptor(file),context.Principals,directory,depth==0);Streams(named,directory);
            if(directory)foreach(Entry child in Entries(file)){if((child.Attributes&0x400)!=0)throw new InvalidOperationException("PRIVATE_LINK_REFUSED");Walk(context,named+"\\"+child.Name,final+"\\"+child.Name,depth+1,child);}
            FileInfo after=Information(file);if(after.Attributes!=info.Attributes||after.Volume!=info.Volume||after.IndexHigh!=info.IndexHigh||after.IndexLow!=info.IndexLow||after.SizeHigh!=info.SizeHigh||after.SizeLow!=info.SizeLow||!String.Equals(Final(file),final,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PRIVATE_IDENTITY_REFUSED");PrivateAccess(Descriptor(file),context.Principals,directory,depth==0);
        }
    }
    private static void Fresh(Context context,string directory) {
        RawAcl dacl=new RawAcl(2,context.Principals.Count);foreach(string principal in context.Principals)dacl.InsertAce(dacl.Count,new CommonAce(AceFlags.ObjectInherit|AceFlags.ContainerInherit,AceQualifier.AccessAllowed,2032127,new SecurityIdentifier(principal),false,null));
        var descriptor=new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent|ControlFlags.DiscretionaryAclProtected|ControlFlags.SelfRelative,new SecurityIdentifier(context.User),new SecurityIdentifier(context.Group),null,dacl);byte[] bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);IntPtr memory=Marshal.AllocHGlobal(bytes.Length);try{Marshal.Copy(bytes,0,memory,bytes.Length);var attributes=new SecurityAttributes{Length=(uint)Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=memory,Inherit=false};if(!CreateDirectoryW(directory,ref attributes))throw Native("PRIVATE_CREATE_NEW_FAILED");}finally{Marshal.FreeHGlobal(memory);}
    }
    private static void RequirePrivateFreshParent(Context context,string parent) {
        // Standalone account/profile callers may create a managed child only
        // inside an already protected private State parent. Metadata-only held
        // ancestors alone do not establish that creation prerequisite.
        using(var handle=CreateFileW(parent,0x20080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)){
            if(handle.IsInvalid)throw Native("PRIVATE_PARENT_SECURITY_DENIED");FileInfo info=Information(handle);if((info.Attributes&0x10)==0||!String.Equals(Final(handle),ExpectedFinal(parent,context.Volume),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PRIVATE_PARENT_IDENTITY_REFUSED");PrivateAccess(Descriptor(handle),context.Principals,true,true);
        }
    }
    private static string BindVolume(string parent,string expected) {
        var mount=new StringBuilder(32768);if(!GetVolumePathNameW(parent.TrimEnd('\\')+"\\",mount,32768))throw Native("PRIVATE_VOLUME_MAPPING_FAILED");var volume=new StringBuilder(128);if(!GetVolumeNameForVolumeMountPointW(mount.ToString(),volume,128)||!Volume.IsMatch(volume.ToString()))throw Native("PRIVATE_VOLUME_MAPPING_FAILED");if(expected!="-"&&!String.Equals(expected,volume.ToString(),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PRIVATE_VOLUME_REFUSED");uint serial,length,flags;var name=new StringBuilder(260);var filesystem=new StringBuilder(32);if(!GetVolumeInformationW(volume.ToString(),name,260,out serial,out length,out flags,filesystem,32))throw Native("PRIVATE_VOLUME_METADATA_FAILED");if(!String.Equals(filesystem.ToString(),"NTFS",StringComparison.OrdinalIgnoreCase)||(flags&8)==0)throw new InvalidOperationException("PRIVATE_FILESYSTEM_REFUSED");return volume.ToString();
    }
    internal static string ExpectedFinal(string named,string volume) {
        if(!Volume.IsMatch(volume))throw new InvalidOperationException("PRIVATE_VOLUME_REFUSED");
        if(named.StartsWith(@"\\?\Volume{",StringComparison.OrdinalIgnoreCase)){int end=named.IndexOf("}\\",StringComparison.Ordinal);if(end<0||!String.Equals(named.Substring(0,end+2),volume,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PRIVATE_VOLUME_REFUSED");return named.TrimEnd('\\');}
        if(!Regex.IsMatch(named,@"\A[A-Za-z]:\\"))throw new InvalidOperationException("PRIVATE_PATH_REFUSED");return (volume+named.Substring(3)).TrimEnd('\\');
    }
    private static List<HeldParent> HoldParents(string parent,string volume) {
        var paths=new List<string>();for(string cursor=parent;cursor!=null;cursor=Path.GetDirectoryName(cursor)){paths.Add(cursor);if(paths.Count>64)throw new InvalidOperationException("PRIVATE_PARENT_BOUND_REFUSED");}paths.Reverse();var held=new List<HeldParent>();
        try{foreach(string named in paths){uint attributes=GetFileAttributesW(named);if(attributes==0xFFFFFFFF)throw Native("PRIVATE_PARENT_METADATA_FAILED");if((attributes&0x400)!=0||(attributes&0x10)==0)throw new InvalidOperationException("PRIVATE_PARENT_REFUSED");var handle=CreateFileW(named,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(handle.IsInvalid){handle.Dispose();throw Native("PRIVATE_PARENT_METADATA_FAILED");}var item=new HeldParent{Handle=handle,Named=named,Expected=ExpectedFinal(named,volume)};held.Add(item);item.Before=Information(handle);item.Check();}return held;}catch{foreach(var item in held)item.Dispose();throw;}
    }
    internal static int Run(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);Context context=new Context();string mode=null,scope=null,error=null;int code=0;bool success=false;List<HeldParent> parents=null;
        try{if(!Environment.Is64BitProcess||args.Length!=5||args[0]!="--private-state"||(args[1]!="create"&&args[1]!="verify")||(args[2]!="state"&&args[2]!="codex"&&args[2]!="github"&&args[2]!="browser"))throw new InvalidOperationException("PRIVATE_ARGUMENTS_REFUSED");mode=args[1];scope=args[2];context.Root=Canonical(args[3]);if(args[4]!="-"&&!Volume.IsMatch(args[4]))throw new InvalidOperationException("PRIVATE_VOLUME_REFUSED");string parent=Path.GetDirectoryName(context.Root);if(String.IsNullOrEmpty(parent))throw new InvalidOperationException("PRIVATE_PATH_REFUSED");
            context.Volume=BindVolume(parent,args[4]);parents=HoldParents(parent,context.Volume);using(WindowsIdentity identity=WindowsIdentity.GetCurrent()){context.User=identity.User.Value;}context.Group=PrimaryGroup();context.Principals=new HashSet<string>(StringComparer.Ordinal){context.User,"S-1-5-18","S-1-5-32-544"};bool exists=Exists(context.Root);if(!exists){if(mode!="create")throw new InvalidOperationException("PRIVATE_ROOT_ABSENT");FreshLocation(context.Root,scope);foreach(var item in parents)item.Check();if(scope!="state")RequirePrivateFreshParent(context,parent);Fresh(context,context.Root);context.RootCreated=true;}
            string physical=ExpectedFinal(context.Root,context.Volume);using(SafeFileHandle root=CreateFileW(context.Root,0x20081,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)){if(root.IsInvalid)throw Native("PRIVATE_METADATA_DENIED");if(!String.Equals(Final(root),physical,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PRIVATE_IDENTITY_REFUSED");Information(root);
            Walk(context,context.Root,physical,0,null);
            // First inspect every existing child. An unsafe existing child
            // prevents even empty managed-directory creation and all writers.
            if(mode=="create"&&scope=="state"){foreach(string name in new string[]{"codex","github","browser"}){string child=context.Root+"\\"+name;if(!Exists(child)){Fresh(context,child);context.Created.Add(name);}}context.Count=0;Walk(context,context.Root,physical,0,null);}
            foreach(var item in parents)item.Check();if(!String.Equals(Final(root),physical,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("PRIVATE_IDENTITY_REFUSED");success=true;}
        }catch(Exception exception){Win32Exception native=exception as Win32Exception;if(native!=null)code=native.NativeErrorCode;error="PRIVATE_STATE_UNVERIFIED";}finally{if(parents!=null)foreach(var item in parents)item.Dispose();}
        var created=new StringBuilder();foreach(string name in context.Created){if(created.Length>0)created.Append(',');created.Append(Json(name));}
        Console.WriteLine("{\"version\":1,\"kind\":\"windowsPrivateState\",\"status\":"+Json(success?"private":"blocked")+",\"observedAt\":"+Json(DateTime.UtcNow.ToString("o",CultureInfo.InvariantCulture))+",\"mode\":"+Json(mode)+",\"scope\":"+Json(scope)+",\"directory\":"+Json(context.Root)+",\"volume\":"+Json(context.Volume)+",\"userSID\":"+Json(context.User)+",\"rootCreated\":"+(context.RootCreated?"true":"false")+",\"managedDirectoriesCreated\":["+created+"],\"entriesChecked\":"+context.Count.ToString(CultureInfo.InvariantCulture)+",\"allEntriesPrivate\":"+(success?"true":"false")+",\"rootDACLProtected\":"+(success?"true":"false")+",\"contentsRead\":false,\"existingACLsChanged\":false,\"privilegesChanged\":false,\"errorClass\":"+Json(error)+",\"nativeCode\":"+code.ToString(CultureInfo.InvariantCulture)+"}");return success?0:1;
    }
}
