#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winioctl.h>
#include <sddl.h>
#include <cstdio>
#include <cstring>
#include <string>

// Temporary physical-startup diagnostic. This is the registered native shell
// for a diagnostic image only. It performs no driver, registry, firmware,
// authorization or power operation. The approved overlay is untouched.
namespace {
constexpr wchar_t originalShell[] = L"X:\\Programs\\Volterra\\StartupSupervisorOriginal.exe";
constexpr wchar_t programRoot[] = L"X:\\Programs\\Volterra";
constexpr char markerText[] = "Microsoft Volterra persistent workspace";
constexpr GUID physicalPartition = {0x4123f0b8, 0x677c, 0x4c8f, {0x9e,0xcc,0x5b,0x70,0x64,0xe2,0xa5,0x7d}};
constexpr GUID privateVmPartition = {0x749bcec2, 0xbf20, 0x486b, {0x92,0x40,0xa0,0x25,0x79,0xec,0x3b,0xba}};
HANDLE logFile = INVALID_HANDLE_VALUE;
HANDLE directoryLock = INVALID_HANDLE_VALUE;
unsigned logBytes = 0;
const ULONGLONG startTick = GetTickCount64();

bool Ordinary(const std::wstring& path, bool directory) {
    if (path.size() < 3 || path[1] != L':' || path[2] != L'\\') return false;
    for (size_t end = 3;;) {
        const DWORD attrs = GetFileAttributesW(path.substr(0, end).c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
        if (((attrs & FILE_ATTRIBUTE_DIRECTORY) != 0) != (end != path.size() || directory)) return false;
        if (end == path.size()) return true;
        const size_t next = path.find(L'\\', end + 1);
        end = next == std::wstring::npos ? path.size() : next;
    }
}

bool LiveEnvironment() {
    wchar_t directory[MAX_PATH] = {}, edition[64] = {};
    const UINT count = GetSystemWindowsDirectoryW(directory, MAX_PATH);
    DWORD bytes = sizeof(edition);
    return count && count < MAX_PATH && _wcsicmp(directory, L"X:\\Windows") == 0 &&
        RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
          L"EditionID", RRF_RT_REG_SZ, nullptr, edition, &bytes) == ERROR_SUCCESS && _wcsicmp(edition, L"WinVOS") == 0;
}

void Record(const char* event, DWORD value = 0) {
    if (logFile == INVALID_HANDLE_VALUE) return;
    SYSTEMTIME utc; GetSystemTime(&utc);
    char line[512];
    const int count = std::snprintf(line, sizeof(line),
        "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ tick=%llu elapsedMs=%llu %s value=%lu\r\n",
        utc.wYear, utc.wMonth, utc.wDay, utc.wHour, utc.wMinute, utc.wSecond, utc.wMilliseconds,
        GetTickCount64(), GetTickCount64() - startTick, event, value);
    if (count <= 0 || static_cast<size_t>(count) >= sizeof(line)) return;
    if (logBytes + static_cast<unsigned>(count) > 262144) return;
    DWORD written = 0;
    WriteFile(logFile, line, static_cast<DWORD>(count), &written, nullptr);
    FlushFileBuffers(logFile);
    logBytes += written;
}

bool MarkedPartition(const wchar_t* root) {
    if (root[0] == L'X' || root[0] == L'x' || GetDriveTypeW(root) != DRIVE_FIXED || !Ordinary(root, true)) return false;
    wchar_t fileSystem[32] = {};
    if (!GetVolumeInformationW(root, nullptr, 0, nullptr, nullptr, nullptr, fileSystem, 32) || _wcsicmp(fileSystem, L"NTFS") != 0) return false;
    const std::wstring device = L"\\\\.\\" + std::wstring(root, 2);
    HANDLE volume = CreateFileW(device.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                nullptr, OPEN_EXISTING, 0, nullptr);
    if (volume == INVALID_HANDLE_VALUE) return false;
    PARTITION_INFORMATION_EX part = {}; DWORD bytes = 0;
    const bool partition = DeviceIoControl(volume, IOCTL_DISK_GET_PARTITION_INFO_EX, nullptr, 0,
                                          &part, sizeof(part), &bytes, nullptr) != FALSE &&
        bytes >= sizeof(part) && part.PartitionStyle == PARTITION_STYLE_GPT &&
        (IsEqualGUID(part.Gpt.PartitionId, physicalPartition) || IsEqualGUID(part.Gpt.PartitionId, privateVmPartition));
    CloseHandle(volume);
    if (!partition) return false;
    const std::wstring marker = std::wstring(root) + L"Volterra-persistent.tag";
    if (!Ordinary(marker, false)) return false;
    HANDLE file = CreateFileW(marker.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    BY_HANDLE_FILE_INFORMATION info = {}; char content[128] = {}; DWORD read = 0;
    bool valid = GetFileInformationByHandle(file, &info) && info.nNumberOfLinks == 1 &&
        !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
        info.nFileSizeHigh == 0 && info.nFileSizeLow >= sizeof(markerText) - 1 && info.nFileSizeLow < sizeof(content) &&
        ReadFile(file, content, sizeof(content), &read, nullptr) && read == info.nFileSizeLow;
    CloseHandle(file);
    if (!valid) return false;
    while (read && (content[read - 1] == '\r' || content[read - 1] == '\n')) --read;
    return read == sizeof(markerText) - 1 && std::memcmp(content, markerText, read) == 0;
}

void OpenPersistentLog() {
    if (directoryLock != INVALID_HANDLE_VALUE) { CloseHandle(directoryLock); directoryLock = INVALID_HANDLE_VALUE; }
    wchar_t drives[512] = {}; const DWORD count = GetLogicalDriveStringsW(512, drives);
    if (!count || count >= 512) return;
    std::wstring root;
    unsigned matches = 0;
    for (const wchar_t* drive = drives; *drive; drive += wcslen(drive) + 1) {
        if (MarkedPartition(drive)) { root = drive; ++matches; }
    }
    if (matches != 1) return;
    const std::wstring directory = root + L"VolterraBootDiagnostics";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;FA;;;SY)(A;;FA;;;BA)", SDDL_REVISION_1,
                                                               &descriptor, nullptr)) return;
    SECURITY_ATTRIBUTES security = {sizeof(security), descriptor, FALSE};
    const bool created = CreateDirectoryW(directory.c_str(), &security) != FALSE;
    const DWORD error = created ? ERROR_SUCCESS : GetLastError();
    if ((!created && error != ERROR_ALREADY_EXISTS) || !Ordinary(directory, true)) { LocalFree(descriptor); return; }
    directoryLock = CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (directoryLock == INVALID_HANDLE_VALUE) { LocalFree(descriptor); return; }
    WIN32_FIND_DATAW found = {}; unsigned entries = 0;
    HANDLE search = FindFirstFileW((directory + L"\\*").c_str(), &found);
    if (search != INVALID_HANDLE_VALUE) {
        do { if (wcscmp(found.cFileName, L".") && wcscmp(found.cFileName, L"..")) ++entries; } while (entries < 64 && FindNextFileW(search, &found));
        FindClose(search);
    }
    if (entries >= 64) { CloseHandle(directoryLock); directoryLock = INVALID_HANDLE_VALUE; LocalFree(descriptor); return; }
    SYSTEMTIME utc; GetSystemTime(&utc);
    wchar_t name[160];
    swprintf(name, 160, L"\\early-%04u%02u%02u-%02u%02u%02u-%lu-%llu.log",
        utc.wYear, utc.wMonth, utc.wDay, utc.wHour, utc.wMinute, utc.wSecond, GetCurrentProcessId(), startTick);
    logFile = CreateFileW((directory + name).c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, &security, CREATE_NEW,
                          FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    LocalFree(descriptor);
}

void Hold() {
    Record("Startup stopped; registered shell remains alive; no restart requested");
    for (;;) Sleep(60000);
}
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    if (!LiveEnvironment()) return 78;
    // No GUI, CLR, Node, Chrome or helper is started during this interval.
    // The registered shell remains alive if a child exits; it never reboots.
    OpenPersistentLog();
    Record("Early native shell entered; diagnostic version 1", GetCurrentProcessId());
    for (unsigned second = 0; second < 60; ++second) {
        if (logFile == INVALID_HANDLE_VALUE && second && second % 5 == 0) {
            OpenPersistentLog();
            Record("Persistent diagnostics became available", second);
        }
        Record("Core OS observation; overlay not started", second);
        Sleep(1000);
    }
    Record("Core OS survived 60 seconds; starting preserved native supervisor");
    if (!Ordinary(originalShell, false) || !Ordinary(programRoot, true)) { Record("Preserved supervisor missing or redirected"); Hold(); }
    wchar_t command[] = L"\"X:\\Programs\\Volterra\\StartupSupervisorOriginal.exe\"";
    STARTUPINFOW startup = {}; startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_SHOWNORMAL;
    PROCESS_INFORMATION child = {};
    if (!CreateProcessW(originalShell, command, nullptr, nullptr, FALSE, 0, nullptr, programRoot, &startup, &child)) {
        Record("Preserved supervisor CreateProcess failed", GetLastError()); Hold();
    }
    CloseHandle(child.hThread);
    Record("Preserved supervisor process created", child.dwProcessId);
    for (unsigned heartbeat = 0;; ++heartbeat) {
        const DWORD result = WaitForSingleObject(child.hProcess, 5000);
        if (result == WAIT_TIMEOUT) { if (heartbeat < 12 || heartbeat % 12 == 0) Record("Preserved supervisor still running", heartbeat); continue; }
        DWORD code = ERROR_GEN_FAILURE;
        if (result == WAIT_OBJECT_0) GetExitCodeProcess(child.hProcess, &code);
        else code = GetLastError();
        Record("Preserved supervisor stopped", code);
        CloseHandle(child.hProcess); Hold();
    }
}
