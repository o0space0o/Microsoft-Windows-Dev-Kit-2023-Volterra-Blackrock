import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fixturePrivateState } from './fixture-private-state.mjs';
import assert from 'node:assert/strict';
import { renderBrowser } from '../app/browser-probe.mjs';

const require = createRequire(import.meta.url);
const moduleRoot = process.env.VOLTERRA_TEST_MODULES;
if (!moduleRoot) throw new Error('Set VOLTERRA_TEST_MODULES to the bundled Node package directory.');
const { chromium } = require(require.resolve('playwright', { paths: [moduleRoot] }));
const { PNG } = require(require.resolve('pngjs', { paths: [moduleRoot] }));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'volterra-visual-'));
process.env.VOLTERRA_STATE_DIR = path.join(temporary, 'state');
process.env.CODEX_HOME = path.join(temporary, 'state', 'codex');
process.env.GH_CONFIG_DIR = path.join(temporary, 'state', 'github');
delete process.env.VOLTERRA_OS_ROOT;
const { inspectBrowserCapture } = await import('../app/runtime-verification.mjs');
const { createApplication } = await import('../app/server.mjs');
// This compares rendered artwork only. Private-storage and native-runtime
// acceptance have separate tests; never use a real account for a visual fixture.
const application = await createApplication({ port: 0, autostart: false, statePrivacy: fixturePrivateState(temporary), githubAccountReader: async () => { throw new Error('Visual fixture has no account.'); } });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--force-color-profile=srgb'] });
try {
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(application.origin); await page.waitForFunction(() => !!window.volterraNavigate);
  const report = { referenceViewport: '1672 × 941', bounds: await page.locator('#artwork').boundingBox(), screens: {}, browserErrors: errors };
  await fs.mkdir('build/verification', { recursive: true });
  for (const screen of ['desktop', 'system', 'maintenance', 'connections']) {
    await page.evaluate(screen => window.volterraNavigate(screen), screen);
    await page.locator('#artwork').evaluate(image => image.decode());
    const screenshot = await page.screenshot({ path: `build/verification/${screen}.png` });
    const reference = PNG.sync.read(await fs.readFile(`design/approved-v1/${screen}.png`));
    const actual = PNG.sync.read(screenshot);
    let differentPixels = 0;
    for (let i = 0; i < reference.data.length; i += 4) if (reference.data[i] !== actual.data[i] || reference.data[i + 1] !== actual.data[i + 1] || reference.data[i + 2] !== actual.data[i + 2] || reference.data[i + 3] !== actual.data[i + 3]) differentPixels++;
    report.screens[screen] = { differentPixels, totalPixels: reference.width * reference.height, method: 'Exact approved raster with invisible interactive hit areas; live panel closed' };
  }
  await page.keyboard.press('Control+Backquote');
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.screenshot({ path: 'build/verification/live-panel.png' });
  let signInRequests = 0;
  await page.route('**/api/state', route => route.fulfill({ json: { ...application.snapshot(), runtimeReady: true, account: null, automation: { enabled: true, phase: 'waiting-for-sign-in' } } }));
  await page.route('**/api/codex/sign-in', route => { signInRequests++; return route.fulfill({ json: { status: 'Fixture only' } }); });
  await page.goto(application.origin + '/?runtimeProbe=1'); await page.waitForFunction(() => !!window.volterraNavigate);
  assert.equal(signInRequests, 0, 'A render probe must not start account authorization.');
  await page.goto(application.origin); await page.waitForFunction(() => !!window.volterraNavigate);
  assert.equal(signInRequests, 1, 'The normal workspace still starts browser authorization.');
  const profile = path.join(temporary, 'render-profile'); await fs.mkdir(profile);
  const capture = path.join(profile, 'render.png');
  const guard = async file => {
    const relative = path.relative(temporary, file); assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    try { const info = await fs.lstat(file); assert.equal(info.isSymbolicLink(), false); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  const render = await renderBrowser({ executable: 'C:/Program Files/Google/Chrome/Application/chrome.exe', profile, capture, url: application.origin + '/?runtimeProbe=1', guard });
  assert.equal(inspectBrowserCapture(render.stdout, await fs.readFile(capture)).helperScriptExecuted, true);
  const rendered = PNG.sync.read(await fs.readFile(capture)); assert.equal(rendered.width, 1672); assert.equal(rendered.height, 941);
  report.protocolRenderPassed = true; report.probeSignInSuppressed = true;
  await fs.writeFile('build/verification/visual-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || Object.values(report.screens).some(value => value.differentPixels)) process.exitCode = 1;
} finally {
  await browser.close(); await application.close();
  if (path.dirname(await fs.realpath(temporary)).toLowerCase() !== (await fs.realpath(os.tmpdir())).toLowerCase() || !path.basename(temporary).startsWith('volterra-visual-')) throw new Error('Visual fixture cleanup escaped temporary storage.');
  await fs.rm(temporary, { recursive: true });
}
