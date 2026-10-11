import fs from 'node:fs/promises';
import { evaluateBootRuntime, probePersistentHistory } from '../app/runtime-verification.mjs';
const report = JSON.parse((await fs.readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''));
if (report.edition === 'WinVOS' && report.historyContext) report.history = await probePersistentHistory(report.historyContext);
Object.assign(report, evaluateBootRuntime(report));
console.log(JSON.stringify(report));
