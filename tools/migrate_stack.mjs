#!/usr/bin/env node
/* ============================================================
   migrate_stack.mjs — 一次性数据迁移：把「跑在支持多语言之前」的项目按技术栈重新规约。
   症状：技术方案写的是 Java/CAP，产物却全是 .mjs（那时只有 Node 通道）。
   做法：重算 arch.profile + 每个模块的 dir / test_path_planned / profile，模块退回 pending，
         开发及之后的阶段退回 pending（已有文档产物保留，重新生成时版本号 +1）。
   用法：
     node tools/migrate_stack.mjs                  # 只看差异（dry-run）
     node tools/migrate_stack.mjs --apply           # 落库（先备份 data/projects.json）
     node tools/migrate_stack.mjs --apply --clean   # 顺带删掉与新语言档案不符的旧源码/测试文件
     node tools/migrate_stack.mjs --apply --project P-xxxx
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CLEAN = args.includes('--clean');
const ONLY = (args.includes('--project') ? args[args.indexOf('--project') + 1] : '').trim();

const DIR = path.dirname(fileURLToPath(import.meta.url));
process.env.AI_PLATFORM_SPEED = process.env.AI_PLATFORM_SPEED || '0';
const H = await import(path.join(DIR, '..', 'harness.mjs'));
const agent = await import(path.join(DIR, '..', 'agent.mjs'));
const exec = await import(path.join(DIR, '..', 'exec.mjs'));
H.load();

const DATA = process.env.AI_PLATFORM_DATA || path.join(DIR, '..', 'data', 'projects.json');
const rows = [];
const plans = [];

for (const p of (H.state().projects || [])) {
  if (ONLY && p.id !== ONLY) continue;
  const pro = H.prof(p);
  const mods = (p.modules || []).map(m => {
    const i = Number(String(m.id || 'M1').replace(/\D/g, '')) - 1 || 0;
    return { m, dir: agent.modDirOf(pro, m.layer, i, m.name), test: agent.testPathOf(pro, m.layer, i, m.name, m.id) };
  });
  // 只认「已有目录且路径规约真的变了」的模块：Node 项目重算后路径一样，老数据没 dir 的也不碰
  const stale = mods.filter(x => x.m.dir && (x.m.dir !== x.dir || x.m.test_path_planned !== x.test));
  rows.push([p.id, p.name, ((p.arch && p.arch.stack) || p.tech || '（未指定）').slice(0, 44), pro.id, `${p.modules.length} 个模块 / ${stale.length} 个需重规约`]);
  if (!mods.length || !stale.length) continue;
  plans.push({ p, pro, mods, stale });
}

console.log('项目\t\t\t技术栈\t\t\t\t\t语言档案\t模块');
for (const r of rows) console.log(r.join('\t'));
if (!plans.length) { console.log('\n没有需要迁移的模块（技术栈判定与模块档案一致）。'); process.exit(0); }
if (!APPLY) { console.log(`\n[dry-run] ${plans.length} 个项目待迁移；加 --apply 落库。`); process.exit(0); }

const backup = `${DATA}.bak-${Date.now().toString(36)}`;
fs.copyFileSync(DATA, backup);
console.log(`\n已备份 → ${backup}`);

// 所有项目都打上语言档案戳（界面「模块开发」里能看到当前语言），但不因此重置任何模块
for (const p of (H.state().projects || [])) {
  if (ONLY && p.id !== ONLY) continue;
  const pro = H.prof(p);
  p.arch = { ...(p.arch || {}), profile: pro.id, profileLabel: pro.label };
  for (const m of p.modules || []) m.profile = m.profile || pro.id;
}

for (const { p, pro, mods, stale } of plans) {
  const root = exec.wsDir(p.id);
  let removed = 0;
  for (const { m, dir, test } of stale) {
    const old = { dir: m.dir, test: m.test_path_planned, profile: m.profile };
    m.dir = dir; m.test_path_planned = test; m.profile = pro.id;
    m.status = 'pending'; m.files = []; m.unit_tests = null; m.artifacts = []; m.error = null; m.review = null; m.version = (m.version || 0) + 1;
    if (CLEAN && old.dir && old.dir !== dir && fs.existsSync(path.join(root, old.dir))) { fs.rmSync(path.join(root, old.dir), { recursive: true, force: true }); removed++; }
    if (CLEAN && old.test && old.test !== test && fs.existsSync(path.join(root, old.test))) { fs.rmSync(path.join(root, old.test), { force: true }); removed++; }
  }
  p.arch = { ...(p.arch || {}), profile: pro.id, profileLabel: pro.label, migrated_at: new Date().toISOString() };
  const di = p.stages.findIndex(s => s.id === 'development');
  for (const s of p.stages.slice(di)) { s.status = 'pending'; s.error = null; s.review = null; }
  const ev = { ts: new Date().toISOString(), stage: 'development', kind: 'step', text: `↻ 技术栈重新规约：语言档案 ${pro.label}；${p.modules.length} 个模块退回待开发（原产物按 ${pro.ext} 重做）${removed ? `，清理旧文件 ${removed} 处` : ''}` };
  p.events.push(ev);
  p.updated_at = ev.ts;
  console.log(`  ${p.id} ${p.name} → ${pro.label}${removed ? `（清理 ${removed} 处旧文件）` : ''}`);
}
H.flush();
await new Promise(r => setTimeout(r, 300));                 // 等 save 的防抖落盘
console.log('\n完成。现在到界面点「▶ 开始开发」/「运行」，模块会按新语言档案重新生成（Java 走 javac/java，CAP 额外产 CDS）。');
