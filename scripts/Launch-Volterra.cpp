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
std::wstring ramLogPrefix;
std::wstring childOutputPath;

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
    ramLogPrefix = directory + L"\\launcher-" + std::to_wstring(GetCurrentProcessId()) +
                   L"-" + std::to_wstring(GetTickCount64());
    const std::wstring name = ramLogPrefix + L".log";
    logFile = CreateFileW(name.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                          CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
}

struct ChildCapture {
    HANDLE output = INVALID_HANDLE_VALUE;
    HANDLE input = INVALID_HANDLE_VALUE;
    HANDLE inherited[2] = { INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE };
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = nullptr;
    bool initialized = false;

    ~ChildCapture() {
        if (initialized) DeleteProcThreadAttributeList(attributes);
        if (attributes) HeapFree(GetProcessHeap(), 0, attributes);
        if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
        if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
    }

    bool Prepare(STARTUPINFOEXW& startup) {
        if (ramLogPrefix.empty()) { SetLastError(ERROR_PATH_NOT_FOUND); return false; }
        childOutputPath = ramLogPrefix + L"-node.log";
        SECURITY_ATTRIBUTES security = { sizeof(security), nullptr, TRUE };
        output = CreateFileW(childOutputPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ,
                             &security, CREATE_NEW,
                             FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
        if (output == INVALID_HANDLE_VALUE) return false;
        // No terminal input is needed: messages and questions use the overlay.
        input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                            &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (input == INVALID_HANDLE_VALUE) return false;
        SIZE_T bytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
        if (!bytes || bytes > 65536) { SetLastError(ERROR_INVALID_DATA); return false; }
        attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
        if (!attributes) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return false; }
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, &bytes)) return false;
        initialized = true;
        inherited[0] = output;
        inherited[1] = input;
        if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                       inherited, sizeof(inherited), nullptr, nullptr)) return false;
        startup.StartupInfo.cb = sizeof(startup);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = input;
        startup.StartupInfo.hStdOutput = output;
        startup.StartupInfo.hStdError = output;
        startup.lpAttributeList = attributes;
        return true;
    }
};

std::wstring ChildOutputTail() {
    if (childOutputPath.empty() || !OrdinaryPath(childOutputPath, false)) return L"No child output was captured.";
    HANDLE file = CreateFileW(childOutputPath.c_str(), GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) return L"The child output log could not be read.";
    LARGE_INTEGER size = {};
    char bytes[12000];
    DWORD count = 0;
    bool read = GetFileSizeEx(file, &size) != FALSE && size.QuadPart >= 0;
    if (read) {
        LARGE_INTEGER offset = {};
        offset.QuadPart = size.QuadPart > static_cast<LONGLONG>(sizeof(bytes)) ? size.QuadPart - sizeof(bytes) : 0;
        read = SetFilePointerEx(file, offset, nullptr, FILE_BEGIN) != FALSE &&
               ReadFile(file, bytes, sizeof(bytes), &count, nullptr) != FALSE;
    }
    CloseHandle(file);
    if (!read || !count) return L"No child output was captured.";
    const int length = MultiByteToWideChar(CP_UTF8, 0, bytes, static_cast<int>(count), nullptr, 0);
    if (length <= 0) return L"The child output log could not be decoded.";
    std::wstring text(static_cast<size_t>(length), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, bytes, static_cast<int>(count), text.data(), length);
    if (text.size() > 3000) text.erase(0, text.size() - 3000);
    for (wchar_t& character : text) {
        if (character < L' ' && character != L'\r' && character != L'\n' && character != L'\t') character = L' ';
    }
    return text;
}

void ShowFailure(DWORD code) {
    const std::wstring message = L"The workspace could not start. Exit code: " + std::to_wstring(code) +
        L"\r\n\r\nRAM log: " + (childOutputPath.empty() ? L"Unavailable" : childOutputPath) +
        L"\r\n\r\nLast child output:\r\n" + ChildOutputTail() +
        L"\r\n\r\nDismiss this message to return to the original startup supervisor.";
    MessageBoxW(nullptr, message.c_str(), L"Microsoft Volterra startup stopped",
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TASKMODAL);
}

int Finish(DWORD code) {
    if (code) ShowFailure(code);
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
    STARTUPINFOEXW startup = {};
    ChildCapture capture;
    if (!capture.Prepare(startup)) {
        const DWORD error = GetLastError();
        Record("The RAM child-output capture could not be prepared", error);
        return Finish(error ? error : ERROR_GEN_FAILURE);
    }
    PROCESS_INFORMATION child = {};
    // Only the explicit RAM log and NUL input handles cross this boundary.
    if (!CreateProcessW(nodePath, command, nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT, nullptr,
                        applicationRoot, &startup.StartupInfo, &child)) {
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
    FlushFileBuffers(capture.output);
    return Finish(code);
}
