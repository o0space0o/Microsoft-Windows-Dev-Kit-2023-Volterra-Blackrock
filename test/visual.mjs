import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createApplication } from '../app/server.mjs';

const require = createRequire(import.meta.url);
const moduleRoot = process.env.VOLTERRA_TEST_MODULES;
if (!moduleRoot) throw new Error('Set VOLTERRA_TEST_MODULES to the bundled Node package directory.');
const { chromium } = require(require.resolve('playwright', { paths: [moduleRoot] }));
const { PNG } = require(require.resolve('pngjs', { paths: [moduleRoot] }));
const application = await createApplication({ port: 0 });
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
  await fs.writeFile('build/verification/visual-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || Object.values(report.screens).some(value => value.differentPixels)) process.exitCode = 1;
} finally { await browser.close(); await application.close(); }
