# Microsoft Volterra

A private ARM64 Validation OS development image and a space-themed local helper for the Windows Dev Kit 2023. The project belongs to Kevin Thienpont.

The helper configures its workspace automatically. On the installed development OS, the workspace is the OS root. On ordinary Windows, the preview uses this build project. Browser sign-in uses the ChatGPT plan or Codex-managed ChatGPT authentication; GitHub has a separate browser sign-in. No OpenAI API key is required. Account profiles and credentials are excluded from image staging.

Run the preview with `npm start`, then open `http://127.0.0.1:43123/?screen=connections`. Press Ctrl+` to show the live workspace. It supports messages, streamed command output, project history, pause, interrupt, resume, file editing and Codex review. The approved artwork remains byte-identical. Exact pixel comparison passes for all four baseline screens at 1672 × 941; the working panel is a new prototype state and needs separate visual approval.

The first browser sign-in on the new OS starts work from PROJECT_BRIEF.md automatically. Subsequent jobs use the saved thread and user messages. The helper reports Windows restart requirements. It does not restart the machine automatically. GitHub release inspection currently reviews metadata; automatic update installation needs a verified publisher and tested recovery mechanism.

`npm test` checks file boundaries, local endpoint authorization, agent interruption/resumption and automatic system workspace selection. `node test/live-codex.mjs` checks actual ChatGPT-backed Codex inference. The visual test uses Playwright and pngjs from the configured bundled runtime.

Image composition uses an isolated ARM64 Windows PE technician VM because this host rejects offline Validation OS registry hives. The technician attaches only its own virtual disks, has no network adapter, and stages the original Microsoft image, runtime packages, verified device-driver catalogs and credential-free helper payload. Firmware update packages are excluded. Servicing receipts are distinct from OS boot, runtime and physical-device acceptance.

The existing Windows 11 default boot entry is preserved. The A: candidate description has been renamed to Microsoft Volterra and a boot configuration backup is saved under build/boot-rename. Installation and runtime acceptance remain pending until the composed image passes its VM boot checks.

Microsoft Validation OS is licensed for development, testing, validation and hardware bring-up. Its local license does not grant standalone public redistribution. Keep the ISO, Microsoft/Qualcomm drivers and private runtime binaries out of GitHub. Only publish original source and build instructions after choosing a source license; this repository does not assign redistribution rights to third-party files. No public repository or release has been created.
