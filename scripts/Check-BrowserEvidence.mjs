import fs from 'node:fs/promises';
import { inspectBrowserCapture } from '../app/runtime-verification.mjs';
const [dom, png] = await Promise.all([fs.readFile(process.argv[2], 'utf8'), fs.readFile(process.argv[3])]);
console.log(JSON.stringify(inspectBrowserCapture(dom, png)));
