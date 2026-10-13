#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>

// The original native StartupSupervisor remains the registered shell. This
// child bridges its fixed DesktopShell.exe launch to the Blackrock helper.
// A helper failure returns to that supervisor; it never restarts Windows.
namespace {
constexpr wchar_t windowsRoot[] = L"X:\\Windows";
constexpr wchar_t applicationRoot[] = L"X:\\Volterra";
constexpr wchar_t nodePath[] = L"X:\\Volterra\\private\\tools\\node.exe";
constexpr wchar_t scriptPath[] = L"X:\\Volterra\\scripts\\Start-Volterra.mjs";
HANDLE logFile = INVALID_HANDLE_VALUE;

bool LiveEnvironment() {
    wchar_t directory[MAX_PATH] = {};
    const UINT length = GetSystemWindowsDirectoryW(directory, MAX_PATH);
    if (!length || length >= MAX_PATH || _wcsicmp(directory, windowsRoot) != 0) return false;
    wchar_t edition[64] = {};
    DWORD bytes = sizeof(edition);
    return RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
                        L"EditionID", RRF_RT_REG_SZ,
                        nullptr, edition, &bytes) == ERROR_SUCCESS &&
           _wcsicmp(edition, L"WinVOS") == 0;
}

bool OrdinaryPath(const std::wstring& path, bool directory) {
    if (path.size() < 3 || _wcsnicmp(path.c_str(), L"X:\\", 3) != 0) return false;
    for (size_t end = 3;;) {
        const DWORD attributes = GetFileAttributesW(path.substr(0, end).c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
        const bool expectedDirectory = end != path.size() || directory;
        if (((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != expectedDirectory) return false;
        if (end == path.size()) return true;
        const size_t next = path.find(L'\\', end + 1);
        end = next == std::wstring::npos ? path.size() : next;
    }
}

void Record(const char* event, DWORD value = 0) {
    char line[512];
    const int length = std::snprintf(line, sizeof(line), "tick=%llu %s value=%lu\r\n",
                                   GetTickCount64(), event, value);
    if (length <= 0 || static_cast<size_t>(length) >= sizeof(line)) return;
    std::fwrite(line, 1, static_cast<size_t>(length), stdout);
    std::fflush(stdout);
    if (logFile != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        WriteFile(logFile, line, static_cast<DWORD>(length), &written, nullptr);
        FlushFileBuffers(logFile);
    }
}

void OpenRamLog() {
    // Never use TEMP or the inherited supervisor log: either can name persistent
    // storage. The supervisor owns its log and receives this child's exit code.
    const std::wstring directory = L"X:\\Windows\\Temp\\VolterraLauncher";
    if (!OrdinaryPath(L"X:\\Windows\\Temp", true)) return;
    if (!CreateDirectoryW(directory.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return;
    if (!OrdinaryPath(directory, true)) return;
    const std::wstring name = directory + L"\\launcher-" + std::to_wstring(GetCurrentProcessId()) +
                              L"-" + std::to_wstring(GetTickCount64()) + L".log";
    logFile = CreateFileW(name.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                          CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
}

int Finish(DWORD code) {
    Record("Launcher returning to the original startup supervisor", code);
    if (logFile != INVALID_HANDLE_VALUE) CloseHandle(logFile);
    return static_cast<int>(code);
}
}

int wmain(int argc, wchar_t**) {
    // Run this check before console configuration, file creation or child launch.
    if (!LiveEnvironment()) {
        std::fputs("Microsoft Volterra launcher requires X:\\Windows Validation OS (WinVOS).\n", stderr);
        return 78;
    }
    if (argc != 1) return 79;
    SetConsoleTitleW(L"Microsoft Volterra startup");
    OpenRamLog();
    Record("Native Blackrock launcher started");
    if (!OrdinaryPath(nodePath, false) || !OrdinaryPath(scriptPath, false)) {
        Record("The fixed Node runtime or startup script is missing or redirected");
        return Finish(ERROR_FILE_NOT_FOUND);
    }
    // Both executable and script are fixed absolute paths. No shell, environment
    // expansion, caller command line or inherited authorization argument is used.
    wchar_t command[] = L"\"X:\\Volterra\\private\\tools\\node.exe\" \"X:\\Volterra\\scripts\\Start-Volterra.mjs\" --boot";
    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child = {};
    if (!CreateProcessW(nodePath, command, nullptr, nullptr, FALSE, 0, nullptr,
                        applicationRoot, &startup, &child)) {
        const DWORD error = GetLastError();
        Record("Node startup failed", error);
        return Finish(error);
    }
    CloseHandle(child.hThread);
    Record("Node startup process created", child.dwProcessId);
    const DWORD waited = WaitForSingleObject(child.hProcess, INFINITE);
    DWORD code = ERROR_GEN_FAILURE;
    if (waited != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &code)) {
        code = GetLastError();
        if (!code) code = ERROR_GEN_FAILURE;
        Record("Could not collect the startup process exit", code);
    }
    CloseHandle(child.hProcess);
    return Finish(code);
}
