import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// The browser's own DevTools protocol observes page readiness and captures the
// render. A long-lived event stream must not keep a dump-dom subprocess alive.
export async function renderBrowser({ executable, profile, url, capture, guard, timeoutMs = 30000 }) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.username || address.password || address.search !== '?runtimeProbe=1') throw new Error('The render probe needs the local helper probe URL.');
  await guard(profile);
  const child = spawn(executable, ['--headless=new', '--no-first-run', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket, sequence = 0, failure, exited = false;
  const pending = new Map(), deadline = Date.now() + timeoutMs;
  child.once('error', error => { failure = error; }); child.once('exit', () => { exited = true; });
  const wait = async () => { if (failure) throw failure; if (exited || Date.now() >= deadline) throw new Error('The browser render probe stopped or timed out.'); await delay(100); };
  const request = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The browser did not acknowledge ' + method)); }, Math.max(1, deadline - Date.now()));
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    const portFile = path.join(profile, 'DevToolsActivePort'); let port, browserPath;
    while (!port) {
      try {
        await guard(portFile); const value = await fs.readFile(portFile, 'utf8');
        if (value.length > 1024) throw new Error('The browser endpoint file is oversized.');
        const rows = value.trim().split(/\r?\n/);
        if (rows.length !== 2 || !/^\d{1,5}$/.test(rows[0]) || +rows[0] < 1 || +rows[0] > 65535 || !/^\/devtools\/browser\/[a-f0-9-]{36}$/.test(rows[1])) throw new Error('The browser endpoint is invalid.');
        [port, browserPath] = rows;
      } catch (error) { if (error.code !== 'ENOENT') throw error; await wait(); }
    }
    socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The browser connection timed out.')), Math.max(1, deadline - Date.now()));
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('The local browser connection failed.')); }, { once: true });
    });
    socket.addEventListener('message', event => {
      let value; try { value = JSON.parse(event.data); } catch { return; }
      const call = pending.get(value.id); if (!call) return;
      clearTimeout(call.timer); pending.delete(value.id);
      value.error ? call.reject(new Error(value.error.message)) : call.resolve(value.result);
    });
    socket.addEventListener('close', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('The browser connection closed.')); } pending.clear(); });
    const { targetId } = await request('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await request('Target.attachToTarget', { targetId, flatten: true });
    await request('Emulation.setDeviceMetricsOverride', { width: 1672, height: 941, deviceScaleFactor: 1, mobile: false }, sessionId);
    await request('Page.enable', {}, sessionId); await request('Page.navigate', { url }, sessionId);
    while (!(await request('Runtime.evaluate', { expression: 'typeof window.volterraNavigate === "function" && document.querySelector("#artwork").complete', returnByValue: true }, sessionId)).result?.value) await wait();
    const dom = await request('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId);
    const png = await request('Page.captureScreenshot', { format: 'png' }, sessionId);
    if (typeof dom.result?.value !== 'string' || dom.result.value.length > 5_000_000 || typeof png.data !== 'string' || png.data.length > 20_000_000) throw new Error('The browser capture is invalid or oversized.');
    await guard(capture); await fs.writeFile(capture, Buffer.from(png.data, 'base64'), { flag: 'wx', flush: true }); await guard(capture);
    return { stdout: dom.result.value, pid: child.pid };
  } finally {
    if (socket?.readyState === WebSocket.OPEN) { await request('Browser.close').catch(() => {}); socket.close(); }
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('The browser probe closed.')); } pending.clear();
    if (!exited) { child.kill(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]); }
  }
}
