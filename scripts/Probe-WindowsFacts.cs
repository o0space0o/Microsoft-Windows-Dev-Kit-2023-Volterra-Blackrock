using System;
using System.ComponentModel;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

// Original read-only diagnostic helper. It never changes privileges, providers,
// services, registry values, security policy, accounts or operating-system files.
internal static class ProbeWindowsFacts
{
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low; public uint High; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder image, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private static string Json(string value)
    {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder("\"");
        foreach (char character in value)
        {
            if (character == '"' || character == '\\') result.Append('\\').Append(character);
            else if (character < 32 || character > 126) result.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
            else result.Append(character);
        }
        return result.Append('"').ToString();
    }

    private static string Error(string stage, Exception exception)
    {
        string message = exception.Message;
        if (message.Length > 512) message = message.Substring(0, 512);
        return "{\"stage\":" + Json(stage) + ",\"code\":" + Json("0x" + exception.HResult.ToString("X8", CultureInfo.InvariantCulture)) + ",\"message\":" + Json(message) + "}";
    }

    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--private-state") return PrivateWindowsState.Run(args);
        uint pid = 0;
        if (args.Length != 0 && (args.Length != 2 || args[0] != "--browser-pid" || !UInt32.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid == 0 || pid > Int32.MaxValue))
        {
            Console.Error.WriteLine("Use no arguments or --browser-pid followed by a positive process ID."); return 2;
        }
        Console.OutputEncoding = new UTF8Encoding(false);
        bool bootObserved = false, browserObserved = false;
        string bootUtc = null, bootDmtf = null, imagePath = null, creationUtc = null;
        StringBuilder errors = new StringBuilder();
        Action<string, Exception> failure = (stage, exception) => { if (errors.Length > 0) errors.Append(','); errors.Append(Error(stage, exception)); };
        try
        {
            if (!Environment.Is64BitProcess) throw new InvalidOperationException("A native 64-bit Windows CLR process is required.");
            ConnectionOptions connection = new ConnectionOptions { EnablePrivileges = false };
            ManagementScope scope = new ManagementScope(@"\\.\root\cimv2", connection);
            // Semi-synchronous enumeration applies the timeout while the provider
            // produces its result. A synchronous Get can block beyond that limit.
            EnumerationOptions options = new EnumerationOptions { ReturnImmediately = true, Timeout = TimeSpan.FromSeconds(100) };
            using (ManagementObjectSearcher search = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT LastBootUpTime FROM Win32_OperatingSystem"), options))
            using (ManagementObjectCollection values = search.Get())
            {
                int count = 0;
                foreach (ManagementObject value in values)
                {
                    using (value)
                    {
                        if (++count != 1) throw new InvalidOperationException("The local operating-system boot query was not a singleton.");
                        bootDmtf = value["LastBootUpTime"] as string;
                        if (bootDmtf == null || !System.Text.RegularExpressions.Regex.IsMatch(bootDmtf, @"^\d{14}\.\d{6}[+-]\d{3}$")) throw new InvalidOperationException("The local boot datetime was absent or unsupported.");
                        DateTime boot = ManagementDateTimeConverter.ToDateTime(bootDmtf).ToUniversalTime();
                        if (boot < new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc) || boot > DateTime.UtcNow.AddMinutes(1)) throw new InvalidOperationException("The local boot datetime was outside the supported range.");
                        bootUtc = boot.ToString("o", CultureInfo.InvariantCulture);
                    }
                }
                if (count != 1) throw new InvalidOperationException("The local operating-system boot query returned no instance.");
            }
            bootObserved = true;
        }
        catch (Exception exception) { bootUtc = null; bootDmtf = null; failure("Boot identity", exception); }
        if (pid != 0)
        {
            IntPtr handle = IntPtr.Zero;
            try
            {
                handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION only.
                if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint length = 32768;
                StringBuilder image = new StringBuilder((int)length);
                if (!QueryFullProcessImageNameW(handle, 0, image, ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (length == 0 || length >= 32768) throw new InvalidOperationException("The process image path was absent or too long.");
                FileTime creation, exit, kernel, user;
                if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
                ulong ticks = ((ulong)creation.High << 32) | creation.Low;
                if (ticks > Int64.MaxValue) throw new InvalidOperationException("The process creation time was invalid.");
                creationUtc = DateTime.FromFileTimeUtc((long)ticks).ToString("o", CultureInfo.InvariantCulture);
                imagePath = image.ToString(); browserObserved = true;
            }
            catch (Exception exception) { imagePath = null; creationUtc = null; failure("Browser process", exception); }
            finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
        }
        bool passed = bootObserved && (pid == 0 || browserObserved);
        Console.WriteLine("{\"version\":1,\"kind\":\"windowsFacts\",\"status\":" + Json(passed ? "passed" : "blocked") +
            ",\"observedAt\":" + Json(DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)) +
            ",\"boot\":{\"observed\":" + (bootObserved ? "true" : "false") + ",\"source\":\"Win32_OperatingSystem.LastBootUpTime\",\"utc\":" + Json(bootUtc) + ",\"dmtf\":" + Json(bootDmtf) + "}" +
            ",\"browser\":{\"requestedPid\":" + pid.ToString(CultureInfo.InvariantCulture) + ",\"observed\":" + (browserObserved ? "true" : "false") + ",\"imagePath\":" + Json(imagePath) + ",\"creationUtc\":" + Json(creationUtc) + "},\"errors\":[" + errors + "]}");
        return passed ? 0 : 1;
    }
}
