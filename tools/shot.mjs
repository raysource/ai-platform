/* ============================================================
   shot.mjs — 纯 Node CDP 截图（不依赖 puppeteer）
   前置：已用 --remote-debugging-port=9223 启动 Chrome
   用法：node tools/shot.mjs [baseUrl] [outDir]
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const OUT = process.argv[3] || path.join(process.cwd(), 'out');
const CDP = process.env.BU_CDP_PORT || 9223;
fs.mkdirSync(OUT, { recursive: true });

const views = [
  ['00-projects', 'projects', 1680, 1300, ''],
  ['01-overview', 'overview', 1680, 1300, ''],
  ['02-flow', 'flow', 1680, 1200, ''],
  ['03-wbs-dev', 'wbs', 1680, 1400, 'wbstab=dev'],
  ['03b-wbs-tree', 'wbs', 1680, 1400, 'wbstab=tree'],
  ['04-artifacts', 'artifacts', 1680, 1100, ''],
  ['05-runs', 'runs', 1680, 1200, ''],
  ['06-workspace', 'artifacts', 1680, 1000, 'arttab=files'],
  ['07-skills', 'skills', 1680, 1100, ''],
  ['08-source', 'code', 1680, 1100, ''],
];

const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('找不到 page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const waits = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m.result); waits.delete(m.id); } });
await new Promise(r => ws.addEventListener('open', r));

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1300, deviceScaleFactor: 1, mobile: false });

const results = [];
for (const [file, view, w, h, qs] of views) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?v=${file}${qs ? '&' + qs : ''}#${view}` });
  await new Promise(r => setTimeout(r, 1800));
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const p = path.join(OUT, `${file}.png`);
  fs.writeFileSync(p, Buffer.from(data, 'base64'));
  const bytes = fs.statSync(p).size;
  results.push(`  ${file}.png  ${w}×${h}  ${(bytes / 1024).toFixed(0)} KB`);
}
console.log(`截图输出到 ${OUT}`);
console.log(results.join('\n'));
ws.close();
process.exit(results.length === views.length ? 0 : 1);
