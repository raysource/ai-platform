/* ============================================================
   preview_check.mjs — 项目预览（server.mjs 的 /p/<projectId>/ 路由）真渲染检查
   用法：node tools/preview_check.mjs <projectId>
   起一个 headless Chrome（CDP 9224），逐页导航 → 轮询「内容已挂载」→ 断言 + 截图到 /tmp/preview-shots/。
   为什么不用 `chrome --dump-dom`：它在模块脚本执行完成前就会 dump，随机只拿到空壳（实测）。
   ============================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ID = process.argv[2];
if (!ID) { console.error('用法：node tools/preview_check.mjs <projectId>'); process.exit(2); }
const PORT = Number(process.env.AI_PLATFORM_PORT || 8788);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WS = path.join(process.env.AI_PLATFORM_WORKSPACE || path.join(import.meta.dirname, '..', 'workspace'), ID);
const BASE = `http://127.0.0.1:${PORT}/p/${ID}`;
const SHOTS = '/tmp/preview-shots';
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9224',
  `--user-data-dir=/tmp/preview-profile-${Date.now()}`, '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try { wsUrl = ((await (await fetch('http://127.0.0.1:9224/json/list')).json()).find((t) => t.type === 'page') || {}).webSocketDebuggerUrl || null; } catch { /* 还没起来 */ }
  if (!wsUrl) await sleep(250);
}
if (!wsUrl) { console.error('FAIL  Chrome/CDP 未就绪'); chrome.kill('SIGKILL'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pending = new Map(); const exceptions = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params?.exceptionDetails?.text || 'exception');
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(120); } return false; };
await send('Runtime.enable'); await send('Page.enable');

let ok = 0, fail = 0;
const chk = (cond, label) => { if (cond) { ok++; console.log(`  ok  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };

for (const [name, p] of [['home', '/'], ['deep', '/course/sd-pricing'], ['404', '/no-such-page']]) {
  exceptions.length = 0;
  await send('Page.navigate', { url: `${BASE}${p}` });
  const mounted = await waitFor(`!!document.querySelector('#main')?.textContent.trim()`);
  chk(mounted, `${name} ${p}：模块脚本执行并渲染出内容`);
  chk(exceptions.length === 0, `${name}：无未捕获 JS 异常${exceptions.length ? `（${exceptions[0]}）` : ''}`);
  if (mounted) {
    const links = await ev(`[...document.querySelectorAll('a[href^="/"]')].map(a => a.getAttribute('href'))`);
    chk(links.every((h) => h.startsWith(`/p/${ID}/`)), `${name}：所有根路径链接都带挂载前缀（${links.length} 条）`);
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(shot.result.data, 'base64'));
}

ws.close(); chrome.kill('SIGKILL');
console.log(`---\nok=${ok} fail=${fail}\n截图：${SHOTS}`);
process.exit(fail === 0 ? 0 : 1);
