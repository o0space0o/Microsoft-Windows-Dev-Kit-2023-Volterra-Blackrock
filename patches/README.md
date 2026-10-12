# Validation OS Node build inputs

The manual `build-validation-node.yml` workflow cross-compiles Node.js v26.10.0 for ARM64 on an x64 Windows Server 2022 runner using the upstream VS2022 17.14+ route, Visual Studio supplied Clang and enabled Temporal. It checks the official source archive, the exact seven-file patch and every resulting modified-file hash. The JSON manifest records the reviewed bytes and provenance.

This patch replaces the libuv and c-ares random-number imports with BCrypt and guards libuv's optional known-folder query through the observed API set. It is a candidate compatibility change. Compilation, a passing official Validation OS API scan and a successful guest runtime rehearsal are separate requirements; this source does not establish those results. The workflow does not install the candidate or change an OS image.

The three delivery files in this directory and `.github/workflows/build-validation-node.yml` are optional public build metadata. They are excluded from application image snapshots. The historical application snapshot at `7284f02c6f9057b4f45b5a04c5690d0276d16ca0` remains bound to its original source and verification receipts.

The source is downloaded from [the official Node.js v26.10.0 release](https://nodejs.org/download/release/v26.10.0/), with SHA-256 recorded in the manifest. The workflow follows [the pinned upstream build instructions](https://github.com/nodejs/node/blob/v26.10.0/BUILDING.md). Actions are pinned to the official [checkout v4.4.0 commit](https://github.com/actions/checkout/commit/11d5960a326750d5838078e36cf38b85af677262) and [upload-artifact v4.6.2 commit](https://github.com/actions/upload-artifact/commit/ea165f8d65b6e75b540449e92b4886f43607fa02). The documented [Windows 2022 runner inventory](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md) is checked against the actual tools during each build.

The artifact preserves the complete unchanged upstream Node.js `LICENSE`, libuv `LICENSE` and c-ares `LICENSE.md`. It contains only the candidate executable, these licenses and bounded build receipts. Node's full license also preserves notices for bundled dependencies. No Microsoft OS, driver or personal runtime asset is included.

## Node.js attribution

Copyright Node.js contributors. All rights reserved.

Copyright Joyent, Inc. and other Node contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## libuv attribution

Copyright (c) 2015-present libuv project contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## c-ares attribution

MIT License

Copyright (c) 1998 Massachusetts Institute of Technology

Copyright (c) 2007 - 2023 Daniel Stenberg with many contributors, see AUTHORS file.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice (including the next paragraph) shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
