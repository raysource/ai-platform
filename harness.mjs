/* ============================================================
   harness.mjs — 交付状态机（本项目的大脑）
   规则（不可绕过，服务端强制）：
     1. 阶段按顺序推进，前一阶段未批准，后一阶段不可执行。
     2. 每个阶段 AI 执行完 → 进入「等待审核」，必须人工批准才推进。
     3. 驳回 → 回到执行（attempts/version +1），反馈喂回模型，重做后再次送审。
     4. WBS 阶段的交付物 = 模块清单；开发阶段逐模块执行：
        真实生成代码 → 真实执行 node --test → 必须 FAIL=0 且人工批准，
        才能进入下一个模块；全部模块批准后开发阶段闭合，进入集成测试。
   证据来源：所有测试数字都来自 exec.mjs 真实执行，不是编出来的。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sim from './sim.mjs';
import * as agent from './agent.mjs';
import * as exec from './exec.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(DIR, 'data');
export const DATA_FILE = process.env.AI_PLATFORM_DATA || path.join(DATA_DIR, 'projects.json');

/** 'live' = 调真实模型（默认）；'sim' = 离线模板通道（显式选择，界面会标明）。 */
const PROVIDER = process.env.AI_PLATFORM_PROVIDER === 'sim' ? 'sim' : 'live';
export const channelInfo = () => PROVIDER === 'sim'
  ? { channel: 'sim', provider: 'offline', model: null }
  : { ...agent.info(), channel: 'live' };

/** 开发阶段的并行度：同时几个 Dev Agent 在写代码。1 = 老的串行语义。 */
const CONC = Math.max(1, Math.min(8, Number(process.env.AI_PLATFORM_CONCURRENCY || 3) || 3));
const AGENTS = Array.from({ length: CONC }, (_, i) => `Dev-Agent-${i + 1}`);
export const runtimeInfo = () => ({ concurrency: CONC, agents: AGENTS, provider: PROVIDER });

/** 找一个空闲的 Agent 名（正在跑的模块占着槽位）。 */
function freeAgent(p) {
  const used = new Set(p.modules.filter(m => m.status === 'running').map(m => m.agent));
  return AGENTS.find(a => !used.has(a)) || AGENTS[0];
}

export const STAGES = [
  { id: 'requirements', name: '需求分析', agent: 'BA Agent', kind: 'artifacts' },
  { id: 'ux', name: 'UI/UX 设计', agent: 'UX Agent', kind: 'artifacts' },
  { id: 'architecture', name: '架构设计', agent: 'Architecture Agent', kind: 'artifacts' },
  { id: 'wbs', name: 'WBS 分解', agent: 'Task Planner', kind: 'wbs' },
  { id: 'development', name: '模块开发', agent: 'Dev Agent', kind: 'development' },
  { id: 'testing', name: '集成测试', agent: 'QA Agent', kind: 'artifacts' },
  { id: 'deployment', name: '部署', agent: 'DevOps Agent', kind: 'artifacts' },
  { id: 'operations', name: '运维', agent: 'SRE Agent', kind: 'artifacts' },
];

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ---------- 工作流（harness 变体）：按客户的项目需求选不同的阶段序列 ----------
   预设而已：一条工作流就是「阶段 id 的有序子集」。约束两条 ——
   ① id 必须来自 STAGES；② 带 development 的必须同时带 wbs（模块是 WBS 计划出来的，没 WBS 就没模块可开发）。
   老项目没有 workflow 字段 = 全流程，照旧。 */
export const WORKFLOWS = [
  { id: 'full', name: '标准全流程', hint: '需求 → UX → 架构 → WBS → 开发 → 测试 → 部署 → 运维',
    stages: ['requirements', 'ux', 'architecture', 'wbs', 'development', 'testing', 'deployment', 'operations'] },
  { id: 'lean', name: '精简交付', hint: '需求 → 架构 → WBS → 开发 → 测试（不做 UX / 部署 / 运维，常见的后台/接口类项目）',
    stages: ['requirements', 'architecture', 'wbs', 'development', 'testing'] },
  { id: 'prototype', name: '原型验证', hint: '需求 → UX → WBS → 开发（先跑起来看效果，不出测试/部署/运维）',
    stages: ['requirements', 'ux', 'wbs', 'development'] },
  { id: 'change', name: '变更 / 维护', hint: '需求 → WBS → 开发 → 测试 → 部署（改存量系统：跳过 UX 与架构，只做变更）',
    stages: ['requirements', 'wbs', 'development', 'testing', 'deployment'] },
  { id: 'design', name: '方案设计', hint: '需求 → UX → 架构 → WBS（只出方案与任务计划，不写代码）',
    stages: ['requirements', 'ux', 'architecture', 'wbs'] },
  { id: 'website', name: '网站 / 静态站', hint: '需求 → UX → 架构 → WBS → 开发 → 测试 → 部署（内容型站点：不做运维）',
    stages: ['requirements', 'ux', 'architecture', 'wbs', 'development', 'testing', 'deployment'] },
  { id: 'service', name: '后端服务 / API', hint: '需求 → 架构 → WBS → 开发 → 测试 → 部署 → 运维（没有界面：跳过 UX）',
    stages: ['requirements', 'architecture', 'wbs', 'development', 'testing', 'deployment', 'operations'] },
  { id: 'data', name: '数据处理 / 迁移', hint: '需求 → 架构 → WBS → 开发 → 测试 → 部署（批处理 / 迁移 / 报表：跳过 UX 与运维）',
    stages: ['requirements', 'architecture', 'wbs', 'development', 'testing', 'deployment'] },
];
export const workflowOf = (p) => WORKFLOWS.find(w => w.id === ((p && p.workflow) || 'full')) || WORKFLOWS[0];
/** 项目实际要走的阶段（按工作流的顺序，对象取自 STAGES）。 */
export const stagesOf = (p) => workflowOf(p).stages.map(id => STAGES.find(s => s.id === id)).filter(Boolean);
/** 工作流自检：id 唯一、阶段都在 STAGES 里、带开发就必须带 WBS。加工作流时先跑这个（单测会调）。 */
export function checkWorkflows() {
  const ids = new Set(STAGES.map(s => s.id));
  const errs = [];
  for (const w of WORKFLOWS) {
    if (!w.id || !w.name || !w.stages.length) errs.push(`${w.id || '(无 id)'}: 缺 id/name/stages`);
    const dup = w.stages.filter((x, i) => w.stages.indexOf(x) !== i);
    if (dup.length) errs.push(`${w.id}: 阶段重复 ${dup.join('、')}`);
    for (const s of w.stages) if (!ids.has(s)) errs.push(`${w.id}: 未知阶段 ${s}`);
    if (w.stages.includes('development') && !w.stages.includes('wbs')) errs.push(`${w.id}: 有开发但没有 WBS（无模块可开发）`);
  }
  if (!WORKFLOWS.some(w => w.id === 'full')) errs.push('缺少 full');
  return errs;
}

/* ---------- 项目类型：选完自动带出默认流程 + 技术栈建议（建议都落在平台真能跑的四种运行时内） ---------- */

export const TYPES = [
  { id: 'webapp', name: 'Web 应用', workflow: 'full', hint: '前后端 + 数据库的完整应用，走全流程',
    techs: ['Next.js + NestJS + PostgreSQL', 'Java 21 + Spring Boot 3.3 + PostgreSQL 16', 'Vue 3 + Express + SQLite'],
    layers: ['core', 'domain', 'service', 'api', 'ui'],
    skills: ['development-general-conventions', 'dev-code-layout', 'security-baseline', 'env-bootstrap',
      'dev-nodejs', 'dev-java-springboot', 'architecture-layering-contracts', 'testing-coverage-matrix',
      'agx-code-review-and-quality', 'agx-test-driven-development'] },
  { id: 'website', name: '网站 / 静态站', workflow: 'website', hint: '内容型站点：把界面与页面做出来，不做运维',
    techs: ['HTML5 + CSS3 + 原生 JavaScript（ES Modules）静态站点', 'React + Vite 静态站', 'SAP CAP Node.js（内容 + OData 接口）'],
    layers: ['core', 'content', 'ui', 'app'],
    skills: ['development-general-conventions', 'dev-code-layout', 'security-baseline', 'env-bootstrap',
      'dev-static-site', 'dev-react-vite', 'ux-information-architecture', 'deployment-release-and-rollback',
      'agx-frontend-ui-engineering', 'agx-performance-optimization'] },
  { id: 'service', name: '后端服务 / API', workflow: 'service', hint: '没有界面：接口 + 数据 + 上线与运维',
    techs: ['Java 21 + Spring Boot 3.3 + PostgreSQL 16', 'Node.js 22 + Fastify + SQLite', 'Python 3.12 + FastAPI + PostgreSQL'],
    layers: ['core', 'domain', 'api', 'repo'],
    skills: ['development-general-conventions', 'dev-code-layout', 'security-baseline', 'env-bootstrap',
      'dev-java-springboot', 'dev-nodejs', 'dev-python', 'architecture-data-consistency', 'operations-monitoring-runbook',
      'agx-security-and-hardening', 'agx-observability-and-instrumentation'] },
  { id: 'cli', name: '工具 / 脚本', workflow: 'lean', hint: '命令行工具：能跑起来、有测试即可，不部署',
    techs: ['Node.js 22（零依赖 CLI）', 'Python 3.12（argparse + unittest）', 'Java 21（单 jar 命令行工具）'],
    layers: ['core', 'cli', 'io'],
    skills: ['development-general-conventions', 'dev-code-layout', 'security-baseline', 'env-bootstrap',
      'dev-nodejs', 'dev-python', 'development-review-checklist', 'agx-debugging-and-error-recovery'] },
  { id: 'data', name: '数据处理 / 迁移', workflow: 'data', hint: '批处理 / 迁移 / 报表：要校验与切换',
    techs: ['Python 3.12（stdlib csv/json + unittest）', 'Python 3.12 + 内存表（批量 ETL + 校验）', 'Node.js 22（流式读写 + 校验）'],
    layers: ['core', 'io', 'transform', 'report'],
    skills: ['development-general-conventions', 'dev-code-layout', 'security-baseline', 'env-bootstrap',
      'dev-python', 'dev-nodejs', 'architecture-data-consistency', 'testing-perf-and-security',
      'agx-incremental-implementation', 'agx-performance-optimization'] },
];
/** 未知/空类型 = 第一项（Web 应用）。 */
export const typeOf = (id) => TYPES.find(t => t.id === id) || TYPES[0];
/** 类型自检：id 唯一、指向的流程必须存在、技术栈建议/技能/目录规约都要有（单测会调）。 */
export function checkTypes() {
  const errs = [], seen = new Set();
  const cat = new Set(skillCatalog().map(c => c.id));
  for (const t of TYPES) {
    if (!t.id || !t.name) errs.push(`${t.id || '(无 id)'}: 缺 id/name`);
    if (seen.has(t.id)) errs.push(`${t.id}: id 重复`);
    seen.add(t.id);
    if (!WORKFLOWS.some(w => w.id === t.workflow)) errs.push(`${t.id}: 指向不存在的流程 ${t.workflow}`);
    if (!Array.isArray(t.techs) || t.techs.length < 2) errs.push(`${t.id}: 至少要给 2 条技术栈建议`);
    for (const s of t.techs || []) if (!String(s).trim()) errs.push(`${t.id}: 有空的技术栈建议`);
    if (!Array.isArray(t.skills) || !t.skills.length) errs.push(`${t.id}: 没配技能`);
    for (const s of t.skills || []) if (!cat.has(s)) errs.push(`${t.id}: 技能 ${s} 不在预设技能库里`);
    if (!Array.isArray(t.layers) || !t.layers.length) errs.push(`${t.id}: 没配目录规约（层清单）`);
    const dup = (t.layers || []).filter((x, i) => t.layers.indexOf(x) !== i);
    if (dup.length) errs.push(`${t.id}: 层清单重复 ${dup.join('、')}`);
    for (const l of t.layers || []) if (!/^[a-z][a-z0-9-]*$/.test(l)) errs.push(`${t.id}: 层名 ${l} 不合法（小写字母/数字/连字符）`);
  }
  return errs;
}
/** 分类自带的配置包（技能 + 目录规约），供界面与创建流程用。 */
export const packOf = (id) => { const t = typeOf(id); return { skills: t.skills || [], layers: t.layers || [], techs: t.techs || [] }; };

/* ---------- 各阶段的调用模型 ----------
   项目里按阶段定义（p.models[stageId]）；没定义 → 缺省 DeepSeek（agent.DEFAULT_MODEL）。
   定义只在「本轮要调模型」时读一次，已批准阶段/已完成模块的历史不受影响。 */

export const stagesMeta = () => STAGES.map(({ id, name, agent: a, kind }) => ({ id, name, agent: a, kind }));
export const DEFAULT_MODEL = agent.DEFAULT_MODEL;
export const modelFor = (p, stageId) => agent.modelFor(p, stageId);
/** 事件流里的通道描述：sim 通道不报模型名。 */
const channelTag = (p, stageId) => (PROVIDER === 'sim' ? '离线模板' : modelFor(p, stageId));

/** 只认流水线里的阶段 id；值必须是非空字符串（≤64 字符）；空值 = 未定义（回到缺省）。 */
export function sanitizeModels(input) {
  const ids = new Set(STAGES.map(s => s.id));
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    const m = String(v ?? '').trim();
    if (ids.has(k) && m && m.length <= 64) out[k] = m;
  }
  return out;
}

/** 合并式更新：传空串即删除该阶段的定义（回到缺省 deepseek）。 */
export function setStageModels(p, models) {
  const next = sanitizeModels({ ...(p.models || {}), ...models });
  const before = p.models || {};
  for (const s of STAGES) {
    const a = before[s.id] || '', b = next[s.id] || '';
    if (a === b) continue;
    pushEvent(p, { stage: 'project', kind: 'info', text: `阶段调用模型：${s.name} ${a ? `自定义 ${a}` : `缺省 ${DEFAULT_MODEL}`} → ${b ? `自定义 ${b}` : `缺省 ${DEFAULT_MODEL}`}` });
  }
  p.models = next;
  save();
  return next;
}


const SPEED = (() => { const v = Number(process.env.AI_PLATFORM_SPEED); return Number.isFinite(v) ? v : 1; })();
const delay = (ms) => new Promise(r => setTimeout(r, SPEED <= 0 ? 1 : Math.max(1, ms / SPEED)));

let db = { version: 1, active: null, projects: [] };
const subs = new Set();
const busy = new Set();
const timers = new Map();

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit(ev) { for (const fn of subs) { try { fn(ev); } catch { /* 订阅者出错不影响主流程 */ } } }

const now = () => new Date().toISOString();

/* ---------- 持久化 ---------- */

export function load() {
  try { if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { console.error('[harness] 载入失败：', e.message); }
  if (!db.projects) db = { version: 1, active: null, projects: [] };
  // 进程重启后没有「正在执行」可言：把残留的 running 归位，否则项目看起来永远在跑（也挡住重建/重跑）
  let fixed = 0;
  for (const p of db.projects) {
    const stuck = [...p.stages.filter(s => s.status === 'running'), ...p.modules.filter(m => m.status === 'running')];
    for (const x of stuck) { x.status = 'failed'; x.error = '服务重启中断（进程内执行不可能跨重启存活）—— 重跑即可'; }
    if (stuck.length) { fixed += stuck.length; pushEvent(p, { stage: 'project', kind: 'error', text: `⚠ 服务重启：${stuck.length} 个「执行中」任务已归位为「失败」（${stuck.map(x => x.id).join('、')}），重跑即可` }); }
    // 老逻辑遗留：模块单测没过也被标成「等待批准」→ 重试循环看不见它，人也没得批。归位为失败，让自动重试接手。
    const parked = (p.modules || []).filter(m => m.status === 'awaiting_review' && m.unit_tests
      && (m.unit_tests.exit_code !== 0 || m.unit_tests.failed > 0 || !m.unit_tests.total));
    for (const m of parked) {
      m.status = 'failed';
      m.error = `单元测试未通过：PASS=${m.unit_tests.passed} FAIL=${m.unit_tests.failed}（退出码 ${m.unit_tests.exit_code}）—— 归位为失败，将自动重排重试`;
    }
    if (parked.length) {
      fixed += parked.length;
      pushEvent(p, { stage: 'development', kind: 'error', text: `⚠ ${parked.length} 个模块的单测未通过却被标成「等待批准」（老逻辑遗留）→ 归位为失败并自动重排：${parked.map(m => m.id).join('、')}` });
      syncDevelopment(p);
    }
    if ((p.modules || []).some(m => m.status === 'failed' && (m.attempts || 0) < 3)) resume.add(p);   // 有可重试的失败模块 → 启动后接着跑
    else {
      const st = (p.stages || []).find(s => s.status === 'failed' && (s.attempts || 0) < 3);          // 失败阶段同理（重试封顶 3 轮）
      if (st) resume.add(p);
    }
  }
  if (fixed) save();
  for (const p of resume) kick(p);          // 不用等人点：重试由门禁与 attempts<3 兜住
}
const resume = new Set();
let saveT = null;
export function save() { clearTimeout(saveT); saveT = setTimeout(flush, 120); }
export function flush() {
  clearTimeout(saveT); saveT = null;
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('[harness] 保存失败：', e.message); }
}

/* ---------- 查询 ---------- */

export const state = () => db;
export const get = (id) => db.projects.find(p => p.id === id);
export function must(id) { const p = get(id); if (!p) throw new HttpError(404, `项目不存在：${id}`); return p; }
export function currentStage(p) { return p.stages.find(s => s.status !== 'approved') || null; }
const lastFeedback = (x) => {
  if (x.review && x.review.decision === 'rejected') return { category: x.review.category, comment: x.review.comment };
  // 自动重试：把上一轮**真实测试输出**喂回去，模型才知道哪条断言挂了（否则只会盲目重生成）
  const u = x.unit_tests;
  if (u && (u.failed > 0 || u.exit_code !== 0 || !u.total)) {
    const ev = {
      category: '单元测试未通过',
      comment: `上一轮真实执行「${u.cmd}」→ PASS=${u.passed} FAIL=${u.failed}，退出码 ${u.exit_code}。`
        + `必须修到 FAIL=0 再输出（关键：你写的每条断言在你自己实现上都必须通过；显式传入的参数按传入值处理，不要静默回落到全局对象）。真实输出末尾：\n${String(u.tail || '').slice(-1200)}`,
    };
    if (x.error) ev.comment = `${x.error}\n${ev.comment}`;
    return ev;
  }
  return null;
};

/** 瞬时故障（空响应 / 网络 / 限流 / 网关）——不是模型的「答案」，不该吃掉 3 轮重试预算。 */
export const isTransientModelError = (msg) => /空内容|EMPTY|Invalid JSON|Unexpected end|Unexpected token|timeout|timed out|ECONNRESET|fetch failed|socket hang up|\b429\b|\b50[234]\b/i.test(String(msg || ''));

/** 瞬时故障统一处理（阶段 / 模块共用）：原地重排、attempts 回退，最多 2 次；返回 true = 已按瞬时故障处理。 */
export function transientBounce(p, x, stageId, label, msg) {
  if (!(isTransientModelError(msg) && (x.transient || 0) < 2)) return false;
  x.transient = (x.transient || 0) + 1;
  x.attempts = Math.max(0, (x.attempts || 0) - 1);
  x.status = 'failed';
  x.error = `${msg}（瞬时故障，原地重排，不计入 3 轮预算 ${x.transient}/2）`;
  pushEvent(p, { stage: stageId, kind: 'error', text: `⚠ ${label} ${x.id}${x.name ? `「${x.name}」` : ''}${msg} → 瞬时故障，原地重排（不计入 3 轮重试预算）` });
  return true;
}

/* ---------- 事件流 ---------- */

function pushEvent(p, { stage = 'system', kind = 'info', text }) {
  const ev = { ts: now(), stage, kind, text };
  p.events.push(ev);
  if (p.events.length > 800) p.events.splice(0, p.events.length - 800);
  p.updated_at = ev.ts;
  emit({ type: 'event', projectId: p.id, event: ev });
  emit({ type: 'state', projectId: p.id });
}

/* ---------- 创建项目（初始入口） ---------- */

/** 分类自带的源码目录规约（新建/重建/换分类都回到它；架构阶段声明合法层清单时可覆盖）。 */
const typeArch = (ty, tech = '') => ({
  layers: [...ty.layers], declared: false, from: 'type-default',
  stack: '', stackFrom: 'none', profile: exec.profileOf(tech).id, at: now(),
});

export function createProject(input = {}) {
  const id = 'P-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const ty = typeOf(input.type);
  const wf = WORKFLOWS.find(w => w.id === input.workflow)                     // 显式指定的工作流优先
    || WORKFLOWS.find(w => w.id === ty.workflow) || WORKFLOWS[0];             // 否则用类型带来的默认流程
  const p = {
    id,
    type: ty.id,
    name: (input.name || '').trim() || '未命名项目',
    brief: (input.brief || '').trim(),
    tech: (input.tech || '').trim(),
    mode: input.mode === 'auto' ? 'auto' : 'human_gate',
    workflow: wf.id,
    provider: channelInfo().channel,
    created_at: now(), updated_at: now(),
    stages: buildStages(wf),
    wbs: { epics: [], task_count: 0 },
    arch: typeArch(ty, (input.tech || '').trim()),                          // 分类自带的源码目录规约（架构阶段可覆盖）
    models: sanitizeModels(input.models),           // 各阶段调用模型；未定义 = 缺省 deepseek
    modules: [],
    inputs: [],                                    // 新建项目时上传的输入资料
    skills: [],                                    // 项目技能库：用户写的工程约定 + 分类自带技能，每次模型调用都带上
    events: [],
  };
  db.projects.push(p);
  db.active = id;
  const ci = channelInfo();
  pushEvent(p, { stage: 'project', kind: 'created', text: `项目「${p.name}」已创建 · 类型：${ty.name} · 工作流：${wf.name}（${p.stages.length} 个阶段）· 分类技能包 ${ty.skills.length} 条（技能页可一键导入）· 目录规约 ${ty.layers.join(' / ')} · 入口模式：${p.mode === 'auto' ? 'AI 自动审批' : '人工审批'} · 执行通道：${ci.channel === 'live' ? `真实模型（缺省 ${DEFAULT_MODEL}）` : '离线模板'}` });
  if (Array.isArray(input.files) && input.files.length) {          // 新建项目时上传的输入资料
    const { inputs, skipped } = exec.writeInputs(exec.wsDir(p.id), input.files);
    p.inputs = inputs;
    if (inputs.length) pushEvent(p, { stage: 'project', kind: 'artifact', text: `已接收 ${inputs.length} 份输入资料：${inputs.map(i => `${i.name}（${(i.bytes / 1024).toFixed(1)}K）`).join('、')} → workspace/${p.id}/inputs/` });
    if (skipped.length) pushEvent(p, { stage: 'project', kind: 'error', text: `跳过 ${skipped.length} 份文件：${skipped.map(s => `${s.name}（${s.why}）`).join('、')}` });
  }
  save();
  kick(p);
  return p;
}

/** 老数据没有 inputs 字段——读到就补上。 */
export const inputsOf = (p) => (p.inputs ||= []);

/** 给已有项目补输入资料（和新建时同一套落盘与限制）：同名文件覆盖旧的。 */
export function addInputs(p, files) {
  const { inputs, skipped } = exec.writeInputs(exec.wsDir(p.id), files);
  if (!inputs.length && !skipped.length) throw new HttpError(400, '没有文件');
  for (const f of inputs) {
    const i = inputsOf(p).findIndex(x => x.name === f.name);
    if (i >= 0) inputsOf(p)[i] = f; else inputsOf(p).push(f);        // 同名 = 覆盖
  }
  if (inputs.length) pushEvent(p, { stage: 'project', kind: 'artifact', text: `补充输入资料 ${inputs.length} 份：${inputs.map(i => `${i.name}（${(i.bytes / 1024).toFixed(1)}K）`).join('、')} → workspace/${p.id}/inputs/` });
  if (skipped.length) pushEvent(p, { stage: 'project', kind: 'error', text: `跳过 ${skipped.length} 份文件：${skipped.map(s => `${s.name}（${s.why}）`).join('、')}` });
  p.updated_at = now();
  save();
  return { inputs: inputsOf(p), added: inputs.length, skipped };
}

export function activate(id) { if (!get(id)) throw new HttpError(404, '项目不存在'); db.active = id; save(); return db; }

/* ---------- 项目信息：建完还能改（名称 / 需求 / 技术栈 / 入口模式；软件分类与工作流不在这儿改） ---------- */

const PROJ_MAX = { name: 80, tech: 200, brief: 20000 };
const PROJ_FIELD = { type: '软件分类', workflow: '工作流', name: '项目名', tech: '技术栈', brief: '需求描述', mode: '入口模式' };

/** 一个全新的阶段记录。 */
const freshStage = (sid) => {
  const s = STAGES.find(x => x.id === sid);
  return { id: s.id, name: s.name, agent: s.agent, kind: s.kind, status: 'pending', attempts: 0, artifacts: [], review: null, error: null, started_at: null, finished_at: null };
};

/** 按工作流造一套全新阶段记录（新建项目用）。 */
export const buildStages = (wf) => wf.stages.map(freshStage);

/** 改分类 / 流程时的重排：按新流程的顺序排，**能对上的阶段保留状态与产物**，多的补 pending、少的移除记录。 */
function mergeStages(p, wf) {
  const kept = [], added = [], gone = [];
  const stages = wf.stages.map(sid => {
    const old = (p.stages || []).find(s => s.id === sid);
    if (old) { kept.push(sid); return old; }
    added.push(sid); return freshStage(sid);
  });
  for (const s of p.stages || []) if (!wf.stages.includes(s.id)) gone.push(s.id);
  return { stages, kept, added, gone };
}

export function updateProject(p, input = {}) {
  const base = { type: p.type || TYPES[0].id, workflow: workflowOf(p).id };
  const next = {
    ...base,
    type: input.type === undefined ? base.type : typeOf(input.type).id,
    workflow: input.workflow !== undefined ? (WORKFLOWS.find(w => w.id === input.workflow) || workflowOf(p)).id
      : input.type !== undefined ? typeOf(input.type).workflow                                    // 只给分类 → 用它带来的默认流程（与新建一致）
      : base.workflow,
    name: String(input.name ?? p.name ?? '').trim().slice(0, PROJ_MAX.name),      // 单项夹住上限，防手滑贴进来的长文本撑爆界面
    tech: String(input.tech ?? p.tech ?? '').trim().slice(0, PROJ_MAX.tech),
    brief: String(input.brief ?? p.brief ?? '').trim().slice(0, PROJ_MAX.brief),
    mode: input.mode === undefined ? p.mode : (input.mode === 'auto' ? 'auto' : 'human_gate'),
  };
  if (!next.name) throw new HttpError(400, '项目名不能为空');
  const retarget = next.type !== base.type || next.workflow !== base.workflow;
  if (retarget && (p.stages || []).some(s => s.status === 'running')) throw new HttpError(409, '有阶段正在执行：等这一步跑完再改软件分类 / 工作流');
  const changed = Object.keys(PROJ_FIELD).filter(k => (p[k] || '') !== (next[k] || ''));
  if (!changed.length) return p;                                                  // 没改动就别记事件
  const beforeName = p.name, beforeType = base.type, beforeWf = workflowOf(p);
  let note = '';
  if (retarget) {
    const wf = WORKFLOWS.find(w => w.id === next.workflow);
    const m = mergeStages(p, wf);
    p.type = next.type; p.workflow = wf.id; p.stages = m.stages;
    p.arch = typeArch(typeOf(next.type), next.tech);                              // 换分类/流程 = 目录规约回到新分类自带的那套
    note = ` · 重排为「${wf.name}」（${p.stages.length} 个阶段：保留 ${m.kept.length} 个已有阶段`
      + `${m.added.length ? `、新增 ${m.added.map(id => STAGES.find(s => s.id === id).name).join('、')}` : ''}`
      + `${m.gone.length ? `、去掉 ${m.gone.map(id => STAGES.find(s => s.id === id).name).join('、')}（其交付物记录已移除，workspace 文件保留）` : ''}）`;
  }
  p.name = next.name; p.tech = next.tech; p.brief = next.brief; p.mode = next.mode;
  p.updated_at = now();
  pushEvent(p, { stage: 'project', kind: 'info', text: `项目信息已编辑（${changed.map(k => PROJ_FIELD[k]).join('、')}）：`
    + (changed.includes('name') ? `${beforeName} → ${p.name}` : p.name)
    + (retarget ? ` · 分类 ${beforeType} → ${p.type}、流程 ${beforeWf.name} → ${WORKFLOWS.find(w => w.id === p.workflow).name}${note}` : '') });
  save();
  return p;
}

/* ---------- 技能库：用户写的工程约定，注入每次模型调用 ---------- */

/** 老数据没有 skills 字段——读到就补上，避免各处判空。 */
export const skillsOf = (p) => (p.skills ||= []);
const SKILL_LIMIT = { name: 60, body: 4000, count: 60 };

const cleanSkill = (s = {}) => {
  const name = String(s.name || '').trim().slice(0, SKILL_LIMIT.name);
  const body = String(s.body || '').trim().slice(0, SKILL_LIMIT.body);
  if (!name) throw new HttpError(400, '技能名不能为空');
  if (!body) throw new HttpError(400, '技能正文不能为空（要写清楚「做什么/不许做什么」）');
  const raw = String(s.stage ?? '').trim();
  const stage = raw && STAGES.some(x => x.id === raw) ? raw : '';    // 空 = 所有阶段；未知 id 当空（不报错，别卡住用户）
  return { name, body, stage };
};

const stageName = (id) => (STAGES.find(s => s.id === id) || {}).name || '所有阶段';

export function addSkill(p, input = {}, { silent = false } = {}) {
  const list = skillsOf(p);
  if (list.length >= SKILL_LIMIT.count) throw new HttpError(400, `技能最多 ${SKILL_LIMIT.count} 条`);
  const { name, body, stage } = cleanSkill(input);
  const n = list.reduce((mx, s) => Math.max(mx, Number(String(s.id).replace(/\D/g, '')) || 0), 0) + 1;
  const skill = { id: `SK-${n}`, name, body, stage, added_at: now(), by: String(input.editor || '人工').slice(0, 40) };
  list.push(skill);
  if (!silent) pushEvent(p, { stage: 'project', kind: 'artifact', text: `新增技能 ${skill.id}「${skill.name}」· 适用：${stageName(stage)} · 之后每次模型调用都会带上（共 ${list.length} 条）` });
  save();
  return skill;
}

export function updateSkill(p, sid, input = {}) {
  const skill = skillsOf(p).find(s => s.id === sid);
  if (!skill) throw new HttpError(404, `技能不存在：${sid}`);
  const { name, body, stage } = cleanSkill({ name: input.name ?? skill.name, body: input.body ?? skill.body, stage: input.stage ?? skill.stage });
  skill.name = name; skill.body = body; skill.stage = stage;
  pushEvent(p, { stage: 'project', kind: 'artifact', text: `技能 ${sid}「${skill.name}」已更新 · 适用：${stageName(stage)}` });
  save();
  return skill;
}

export function removeSkill(p, sid) {
  const list = skillsOf(p);
  const i = list.findIndex(s => s.id === sid);
  if (i < 0) throw new HttpError(404, `技能不存在：${sid}`);
  const [gone] = list.splice(i, 1);
  pushEvent(p, { stage: 'project', kind: 'error', text: `删除技能 ${gone.id}「${gone.name}」（剩 ${list.length} 条）` });
  save();
  return { ok: true, id: gone.id, count: list.length };
}

/** 批量删除：一次事件记账，逐条删；不存在的 id 忽略（幂等，别让整批因为一条失效而失败）。 */
export function removeSkills(p, ids) {
  const list = skillsOf(p);
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const gone = list.filter(s => want.has(s.id));
  if (!gone.length) throw new HttpError(404, '没有匹配的技能可删');
  for (const g of gone) list.splice(list.indexOf(g), 1);
  pushEvent(p, { stage: 'project', kind: 'error', text: `批量删除技能 ${gone.length} 条：${gone.map(g => `${g.id}「${g.name}」`).join('、')}（剩 ${list.length} 条）` });
  save();
  return { ok: true, deleted: gone.map(g => g.id), missing: [...want].filter(id => !gone.some(g => g.id === id)), count: list.length };
}

/* ---------- 预设技能库：skills/*.md（随仓库走，改文件即生效） ---------- */

const SKILL_DIR = path.join(DIR, 'skills');

/* ---------- 上游技能（vendor/agent-skills，MIT）：只取「验收 / 红线 / 反合理化」三段 ----------
   上游单个 SKILL.md 均值 13.7KB，比本平台单次注入预算（agent.SKILL_PROMPT_MAX = 12000 字符）还大，
   所以不搬原文：只抽可执行的三段（24/25 个技能都有「Verification / Red Flags / Common Rationalizations」），
   按每条上限截断。导入进项目的是这份切片文本 —— 之后不再依赖 vendor 目录（离线也能用）。 */
const AGX_DIR = path.join(DIR, 'vendor', 'agent-skills');
const AGX_SECTIONS = [/^Verification\b/i, /^Red Flags\b/i, /^Common Rationalizations\b/i];
/** 上游技能 → 本平台阶段 + 抽取上限（字符）。没进这张表的上游技能不暴露（宁缺勿滥）。 */
export const AGX_MAP = {
  'using-agent-skills':               { stage: '',            max: 800 },
  'context-engineering':              { stage: '',            max: 800 },
  'doubt-driven-development':         { stage: '',            max: 800 },
  'constraint-driven-development':    { stage: '',            max: 1000 },
  'security-and-hardening':           { stage: '',            max: 1000 },
  'interview-me':                     { stage: 'requirements', max: 1000 },
  'idea-refine':                      { stage: 'requirements', max: 900 },
  'spec-driven-development':          { stage: 'requirements', max: 1200 },
  'planning-and-task-breakdown':      { stage: 'wbs',          max: 1200 },
  'api-and-interface-design':         { stage: 'architecture', max: 1200 },
  'documentation-and-adrs':           { stage: 'architecture', max: 1000 },
  'frontend-ui-engineering':          { stage: 'ux',           max: 1200 },
  'incremental-implementation':       { stage: 'development',  max: 1000 },
  'test-driven-development':          { stage: 'development',  max: 1200 },
  'code-review-and-quality':          { stage: 'development',  max: 1200 },
  'code-simplification':              { stage: 'development',  max: 1000 },
  'git-workflow-and-versioning':      { stage: 'development',  max: 1000 },
  'deprecation-and-migration':        { stage: 'development',  max: 1000 },
  'debugging-and-error-recovery':     { stage: 'development',  max: 1200 },
  'source-driven-development':        { stage: 'development',  max: 800 },
  'browser-testing-with-devtools':    { stage: 'testing',      max: 1200 },
  'performance-optimization':         { stage: 'testing',      max: 1000 },
  'ci-cd-and-automation':             { stage: 'deployment',   max: 1200 },
  'shipping-and-launch':              { stage: 'deployment',   max: 1200 },
  'observability-and-instrumentation': { stage: 'operations',  max: 1200 },
};

/** vendor/agent-skills/SOURCE 里记的 commit（没 vendor 过就空 → 整个上游技能层不出现）。 */
export const agxSha = () => { try { return (fs.readFileSync(path.join(AGX_DIR, 'SOURCE'), 'utf8').match(/^sha:\s*(\w+)/m) || [])[1] || ''; } catch { return ''; } };

/** 抽三段拼到 max 字符为止（三段一个都没有就退回各节，照样截断兜底）。 */
function agxSlice(body, max) {
  const secs = body.split(/^## +/m).map((chunk) => {
    const [title, ...rest] = chunk.split('\n');
    return { title: title.trim(), text: rest.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
  });
  const picked = AGX_SECTIONS.map(re => secs.find(s => re.test(s.title))).filter(Boolean);
  const use = picked.length ? picked : secs.filter(s => s.title && s.title.length < 40);
  const out = []; let used = 0;
  for (const s of use) {
    const block = `【${s.title}】${s.text}`;
    if (used + block.length <= max) { out.push(block); used += block.length + 1; continue; }
    const room = max - used - 2;
    if (room > 240) out.push(`${block.slice(0, room).trimEnd()} …`);
    break;
  }
  return out.join('\n');
}

/** 上游技能（vendor 目录在才有）：id = agx-<上游名>，stage 由 AGX_MAP 定，body = 切片。 */
export function agxCatalog() {
  const sha = agxSha(); if (!sha) return [];
  let dirs = []; try { dirs = fs.readdirSync(path.join(AGX_DIR, 'skills')).sort(); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    const cfg = AGX_MAP[d]; if (!cfg) continue;
    const f = path.join(AGX_DIR, 'skills', d, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const body = agxSlice(raw.replace(/^---[\s\S]*?---\s*/, '').trim(), cfg.max);
    if (!body) continue;
    out.push({
      id: `agx-${d}`,
      name: `上游规范 · ${d}`,
      stage: STAGES.some(s => s.id === cfg.stage) ? cfg.stage : '',
      tech: '',
      body: `（节选自上游 addyosmani/agent-skills@${sha.slice(0, 8)}：${d}｜全文 vendor/agent-skills/skills/${d}/SKILL.md）\n${body}`,
      bytes: Buffer.byteLength(body),
    });
  }
  return out;
}
const fmValue = (raw, key) => {
  const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
/** frontmatter 里 `metadata:` 块的某个子键（平台扩展：stage / tech / label）。 */
const metaValue = (raw, key) => {
  const block = (raw.match(/^metadata:[^\n]*\n((?:[ \t]+[^\n]*\n?)*)/m) || [])[1] || '';
  const m = block.match(new RegExp(`^\\s+${key}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};

/** AI Agent Skills 标准格式的标准小节（顺序固定，见 vendor/agent-skills/docs/skill-anatomy.md）。 */
export const SKILL_SECTIONS = ['Overview', 'When to Use', 'Core Process', 'Common Rationalizations', 'Red Flags', 'Verification'];

/** 解析一份标准格式技能（skills/<name>/SKILL.md）：平台预设与「生成项目工作区自带技能」共用。 */
function parseSkill(id, raw) {
  const stage = metaValue(raw, 'stage');
  return {
    id,
    name: metaValue(raw, 'label') || id,
    desc: fmValue(raw, 'description'),
    stage: STAGES.some(s => s.id === stage) ? stage : '',
    tech: metaValue(raw, 'tech'),
    body: raw.replace(/^---[\s\S]*?---\s*/, '').trim(),
    bytes: Buffer.byteLength(raw),
  };
}

/** 工作区自带技能：生成的项目里自己放的 skills/<name>/SKILL.md（同一套标准格式）。有就优先用。 */
export function workspaceSkills(p) {
  const dir = path.join(exec.wsDir(p.id), 'skills');
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const f = path.join(dir, n, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    try { out.push({ ...parseSkill(n, fs.readFileSync(f, 'utf8')), from: 'workspace' }); } catch {}
  }
  return out;
}

/** 调模型前刷一次：工作区技能以磁盘为准（不落库、不拷贝），顺手在集合变化时记账。 */
export function refreshWsSkills(p) {
  const before = (p.ws_skills || []).map(s => s.id).join(',');
  p.ws_skills = workspaceSkills(p);
  const after = p.ws_skills.map(s => s.id).join(',');
  if (after !== before) {
    pushEvent(p, { stage: 'project', kind: 'step', text: p.ws_skills.length
      ? `本项目工作区自带 ${p.ws_skills.length} 条技能（skills/*/SKILL.md）：${p.ws_skills.map(s => s.name).join('、')} → 优先于项目技能库与平台预设`
      : '本项目工作区已无自带技能（skills/*/SKILL.md）' });
  }
  return p.ws_skills;
}

/** 读 skills/<name>/SKILL.md（标准格式：frontmatter `name`（=目录名）+ `description` + `metadata.{stage,tech,label}`，正文六节）。 */
export function skillCatalog() {
  let dirs = [];
  try { dirs = fs.readdirSync(SKILL_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); }
  catch { return agxCatalog(); }
  return [...dirs.map(id => {
    const f = path.join(SKILL_DIR, id, 'SKILL.md');
    if (!fs.existsSync(f)) return null;
    return parseSkill(id, fs.readFileSync(f, 'utf8'));
  }).filter(Boolean), ...agxCatalog()];
}

/** 把预设技能导入项目技能库：同名+同阶段视为已存在，跳过；超出条数上限的算 dropped（不中断导入）。 */
export function importSkills(p, ids) {
  const cat = skillCatalog();
  const want = (Array.isArray(ids) && ids.length) ? cat.filter(c => ids.includes(c.id)) : cat;
  if (!want.length) throw new HttpError(404, '没有匹配的预设技能');
  const has = new Set(skillsOf(p).map(s => `${s.name}|${s.stage}`));
  let added = 0, skipped = 0, dropped = 0;
  for (const c of want) {
    if (has.has(`${c.name}|${c.stage}`)) { skipped++; continue; }
    if (skillsOf(p).length >= SKILL_LIMIT.count) { dropped++; continue; }    // 到顶了也别把整批导入搞挂
    addSkill(p, { name: c.name, body: c.body, stage: c.stage, editor: `预设 ${c.id}` }, { silent: true });
    has.add(`${c.name}|${c.stage}`);
    added++;
  }
  if (added || dropped) {
    pushEvent(p, { stage: 'project', kind: 'artifact', text: `从预设技能库导入 ${added} 条技能${skipped ? `（${skipped} 条已存在，跳过）` : ''}${dropped ? `（${dropped} 条超过 ${SKILL_LIMIT.count} 条上限，未导入）` : ''} · 共 ${skillsOf(p).length} 条` });
  }
  return { added, skipped, dropped, total: skillsOf(p).length };
}
export function removeProject(id, { force = false } = {}) {
  const p = get(id);
  if (p) {
    const running = p.stages.some(s => s.status === 'running') || p.modules.some(m => m.status === 'running');
    if (running && !force)
      throw new HttpError(409, '项目正在执行中：等它跑完、或再次确认强制删除（在飞的模型调用会被丢弃）');
    p._removed = true;                                     // 打墓碑：迟到的写入全部作废
    for (const k of [...timers.keys()]) if (k.startsWith(`${id}:`)) { clearTimeout(timers.get(k)); timers.delete(k); }
  }
  db.projects = db.projects.filter(p => p.id !== id);
  if (db.active === id) db.active = db.projects[0]?.id || null;
  try { exec.rmWorkspace(id); } catch { /* 目录不存在即可 */ }
  save();
  return { ok: true, deleted: id, forced: force, remaining: db.projects.length };
}

/* ---------- 重新构建：清空产物与历史痕迹，技能保留 ---------- */

/** 重新构建项目：清空全部阶段产物 / WBS / 架构规约 / 模块与源码·测试文件 / 事件流 / workspace 里的生成目录，
    保留技能库、输入资料、技术栈与各阶段模型配置。规则见 README「重新构建」。
    在飞的任务：先停掉该项目的定时器；仍显示 running 且未 force ⇒ 409（与删除项目同一套口径）。 */
export function rebuildProject(id, { force = false } = {}) {
  const p = get(id);
  if (!p) throw new HttpError(404, '项目不存在');
  const running = p.stages.some(s => s.status === 'running') || p.modules.some(m => m.status === 'running');
  if (running && !force)
    throw new HttpError(409, '项目正在执行中：等它跑完、或再次确认强制重新构建（在飞的模型调用结果会被丢弃）');
  for (const k of [...timers.keys()]) if (k.startsWith(`${id}:`)) { clearTimeout(timers.get(k)); timers.delete(k); }

  const stat = {
    artifacts: p.stages.reduce((a, s) => a + s.artifacts.length, 0) + p.modules.reduce((a, m) => a + m.artifacts.length, 0),
    modules: p.modules.length,
    files: p.modules.reduce((a, m) => a + (m.files?.length || 0), 0),
    events: p.events.length,
    dirs: [],
  };
  for (const s of p.stages)
    Object.assign(s, { status: 'pending', attempts: 0, artifacts: [], review: null, error: null, started_at: null, finished_at: null });
  p.wbs = { epics: [], task_count: 0 };
  p.arch = typeArch(typeOf(p.type), p.tech);   // 架构规约回到分类自带的那套，重跑架构阶段再定
  p.modules = [];
  p.events = [];                       // 历史痕迹清零（紧接着写下重建这一条）
  try { stat.dirs = exec.clearWorkspace(id); } catch (e) { stat.dirs = [`（清理失败：${e.message}）`]; }
  save();
  pushEvent(p, {
    stage: 'project', kind: 'rebuild',
    text: `♻ 重新构建：清空 ${stat.artifacts} 份产物、${stat.modules} 个模块（${stat.files} 个源码/测试文件）、${stat.events} 条执行记录`
      + `，删掉 workspace/${id}/ 下 ${stat.dirs.length} 项生成内容${stat.dirs.length ? `（${stat.dirs.join('、')}）` : ''}`
      + `；技能 ${skillsOf(p).length} 条、输入资料 ${(p.inputs || []).length} 份保留`,
  });
  return { ok: true, cleared: { ...stat, dirs: stat.dirs.length }, kept: { skills: skillsOf(p).length, inputs: (p.inputs || []).length } };
}

/* ---------- 执行器 ---------- */

async function guarded(id, fn) {
  if (busy.has(id)) return;
  busy.add(id);
  try { await fn(); } finally { busy.delete(id); }
}

function later(key, ms, fn) {
  if (timers.has(key)) return;
  timers.set(key, setTimeout(async () => { timers.delete(key); try { await fn(); } catch (e) { console.error('[harness]', e.message); } }, SPEED <= 0 ? 5 : Math.max(5, ms / SPEED)));
}

/** 推动流程：从当前阶段继续推进到下一个「需要人」的位置。 */
export function kick(p, opts = {}) {
  if (p._removed) return;                         // 项目已删：迟到的回调不再推进
  const st = currentStage(p);
  if (!st) return;

  if (st.kind === 'development') {
    // 多 Agent 并行：把空闲的 Agent 槽位补满（状态机自己就是锁——
    // runModule 在第一个 await 之前就把模块置为 running，所以这里的 find 不会重复领取）。
    const slots = CONC - p.modules.filter(m => m.status === 'running').length;
    for (let i = 0; i < slots; i++) {
      // 只领取「没做过」或「人驳回」的模块；失败重试最多 3 轮，避免模型反复失败时无限循环
      const next = p.modules.find(m => m.status === 'pending' || m.status === 'rejected' || (m.status === 'failed' && (m.attempts || 0) < 3));
      if (!next) break;
      runModule(p, next, opts).catch(e => console.error('[harness]', e.message));
    }
    // 已完成的模块在人（或 auto 模式）批准后才把槽位还回来
    const rev = p.modules.filter(m => m.status === 'awaiting_review');
    if (rev.length && p.mode === 'auto') rev.forEach(m => later(`${p.id}:${m.id}`, 700, () => approveModule(p, m.id, 'AI 自动审批')));
    return;
  }

  if (st.status === 'awaiting_review') {
    if (p.mode === 'auto') later(`${p.id}:${st.id}`, 700, () => approveStage(p, st.id, 'AI 自动审批'));
    return;
  }
  if (st.status === 'pending' || st.status === 'rejected' || st.status === 'failed') {
    if (st.status === 'failed' && (st.attempts || 0) >= 3) return;   // 自动重试封顶（3 轮）；再多就得人点「重跑」，别一直刷真实模型
    guarded(p.id, () => runStage(p, st.id, opts));
  }
}

function guardAdvance(p, st) {
  const idx = p.stages.indexOf(st);
  const pendingBefore = p.stages.slice(0, idx).find(s => s.status !== 'approved');
  if (pendingBefore) throw new HttpError(409, `前置阶段「${pendingBefore.name}」未批准，不能执行「${st.name}」`);
}

/* ---------- 阶段执行 ---------- */

export function checkStageRunnable(p, stageId) {
  const st = p.stages.find(s => s.id === stageId);
  if (!st) throw new HttpError(404, `阶段不存在：${stageId}`);
  if (st.status === 'approved') throw new HttpError(409, '阶段已批准，不能重跑');
  if (st.status === 'running') throw new HttpError(409, '阶段正在执行');
  if (st.status === 'awaiting_review') throw new HttpError(409, '阶段等待审核，请先批准或驳回');
  guardAdvance(p, st);
  if (st.kind === 'development' && !p.modules.length) throw new HttpError(409, 'WBS 尚未完成，无模块可开发');
  return st;
}

export async function runStage(p, stageId, opts = {}) {
  const st = checkStageRunnable(p, stageId);
  if (st.kind === 'development') return runDevelopment(p, st, opts);

  st.status = 'running'; st.attempts += 1; st.started_at = st.started_at || now(); st.error = null;
  pushEvent(p, { stage: st.id, kind: 'run', text: `▶ ${st.name} · ${st.agent} 开始执行（第 ${st.attempts} 轮，模型：${channelTag(p, st.id)}）` });
  refreshWsSkills(p);                                    // 工作区自带技能优先：每次调模型前按磁盘刷一次

  const d = opts.delay || delay;
  // 「重新构建」会把 st.attempts 归零 / 项目被删 → 这一轮的结果一律不落地（人点了重建，旧结果不该再回来）
  const stale = () => p._removed || st.attempts === 0;
  try {
    for (const s of sim.planSteps(p, st)) { await d(s.ms); if (stale()) return; pushEvent(p, { stage: st.id, kind: 'step', text: s.text }); }

    if (st.kind === 'wbs') {
      pushEvent(p, { stage: st.id, kind: 'step', text: PROVIDER === 'sim' ? '离线通道 · 生成 WBS' : `调用 ${modelFor(p, 'wbs')} 拆解任务…` });
      const r = PROVIDER === 'sim' ? sim.planWbs(p) : await agent.wbs(p);
      if (stale()) return;
      p.wbs = { epics: r.epics, task_count: r.task_count, generated_at: r.generated_at || now(), model: r.model || null };
      p.modules = planModules(p, p.wbs, archLayers(p));
      pushEvent(p, { stage: st.id, kind: 'artifact', text: `已分解 ${p.wbs.epics.length} 个 Epic / ${p.wbs.task_count} 个 Task → 生成 ${p.modules.length} 个开发模块（按架构规约分派到 ${archLayers(p).join(' / ')} 层；语言：${prof(p).label}）` });
    } else {
      const r = PROVIDER === 'sim'
        ? { artifacts: sim.planArtifacts(p, st).map(a => ({ ...a, status: 'generated', version: st.attempts })) }
        : await agent.stageArtifacts(p, st, lastFeedback(st), (n, total, a) =>
            pushEvent(p, { stage: st.id, kind: 'step', text: `模型已写完 ${n}/${total}：《${a.name}》（${a.content.length} 字符）` }));
      if (stale()) return;
      st.artifacts = r.artifacts.map(a => ({ ...a, status: 'generated', version: st.attempts, at: now() }));
      const docs = writeDocs(p, st);
      if (r.model) pushEvent(p, { stage: st.id, kind: 'step', text: `模型 ${r.model} 返回，token 用量 ${r.usage?.total_tokens ?? '—'}` });
      pushEvent(p, { stage: st.id, kind: 'artifact', text: `产出 ${st.artifacts.length} 份产物：${st.artifacts.map(a => a.name).join('、')}${docs ? `（已写入 workspace/${p.id}/docs/）` : ''}` });
      if (st.id === 'architecture') p.arch = readLayout(p, st);
    }

    // 真实执行证据：测试 / 部署阶段跑的是工作区里真实存在的代码
    const real = await runRealEvidence(p, st, d);
    if (stale()) return;
    real.forEach(t => pushEvent(p, { stage: st.id, kind: 'test', text: t }));

    st.status = 'awaiting_review';
    pushEvent(p, { stage: st.id, kind: 'gate', text: `⏸ ${st.name} 完成 → 等待人工审核（门禁：人工必批）` });
  } catch (e) {
    const msg = e.message || String(e);
    if (!transientBounce(p, st, st.id, '阶段', msg)) {
      st.status = 'failed'; st.error = msg;
      pushEvent(p, { stage: st.id, kind: 'error', text: `✕ ${st.name} 执行失败：${st.error}` });
    }
  }
  save();
  kick(p, opts);
}

/** 测试/部署阶段：真的在工作区跑一遍代码与用例。 */
async function runRealEvidence(p, st, d) {
  if (st.id !== 'testing' && st.id !== 'deployment') return [];
  const root = exec.wsDir(p.id);
  const files = exec.listFiles(root);
  if (!files.length) {
    st.artifacts.push({ id: 'TST-99', name: '执行报告', type: 'markdown', status: 'generated', version: st.attempts, at: now(), content: '工作区为空：还没有模块产物，无法执行集成测试。' });
    return ['工作区为空，未执行'];
  }
  const lines = [];
  if (st.id === 'deployment') {
    await d(150);
    const syn = await exec.checkSyntax(root);
    lines.push(`语法检查 ${syn.checked} 个文件（${Object.entries(syn.byLang || {}).map(([k, v]) => `${k} ${v}`).join(' / ')}；java 由 javac 编译覆盖）→ ${syn.ok ? '全部通过' : syn.errors.length + ' 个错误'}`);
    st.artifacts.push({
      id: 'DPL-02', name: '构建校验报告（真实执行）', type: 'markdown', status: generated(st), version: st.attempts, at: now(),
      content: `# 构建校验报告 · ${p.name}\n\n工作区：\`workspace/${p.id}\`\n\n- 语法检查：${syn.checked} 个文件，${syn.ok ? '全部通过' : '存在错误'}\n${syn.errors.map(e => `  - \`${e.file}\`：${e.error}`).join('\n')}\n`,
    });
  }
  const cdsAll = exec.checkCds(root);
  if (cdsAll.files) {
    await d(120);
    lines.push(`CDS 结构性校验：${cdsAll.files} 个 .cds → ${cdsAll.ok ? '结构正常' : cdsAll.errors.length + ' 处问题'}`);
    st.artifacts.push({
      id: st.id === 'testing' ? 'TST-03' : 'DPL-04', name: 'CDS 模型报告（结构性校验）', type: 'markdown', status: generated(st), version: st.attempts, at: now(),
      content: `# CDS 模型报告 · ${p.name}\n\n文件：${cdsAll.files} 个\n\n${
        cdsAll.ok ? '- 结构正常（花括号配对 / 含 namespace 或 entity / 每个实体都有 key）' : cdsAll.errors.map(e => `- \`${e.file}\`：${e.error}`).join('\n')}\n\n> 说明：本机没有 cds-dk（@sap/cds-dk），**这不是 \`cds compile\` 的编译结果**，只做结构性校验；要真编译请装 cds-dk 后跑 \`cds compile db/ srv/\`。\n`,
    });
  }
  await d(200);
  const tr = await exec.runWorkspaceTests(root);            // 工作区里有什么语言就真跑什么
  lines.push(`真实执行 \`${tr.cmd}\`（工作区） → PASS=${tr.passed} FAIL=${tr.failed} 退出码=${tr.exit_code} ${tr.ms}ms`);
  st.artifacts.push({
    id: st.id === 'testing' ? 'TST-02' : 'DPL-03',
    name: st.id === 'testing' ? '集成测试报告（真实执行）' : '冒烟测试报告（真实执行）',
    type: 'markdown', status: generated(st), version: st.attempts, at: now(),
    content: `# ${st.id === 'testing' ? '集成测试' : '冒烟测试'}报告 · ${p.name}

命令：\`${tr.cmd}\`（cwd = \`workspace/${p.id}\`）
退出码：${tr.exit_code} · 耗时 ${tr.ms}ms
PASS=${tr.passed} FAIL=${tr.failed} TESTS=${tr.total}

| 指标 | 值 |
|---|---|
| tests | ${tr.total} |
| pass | ${tr.passed} |
| fail | ${tr.failed} |

\`\`\`
${tr.tail}
\`\`\`
`,
  });
  if (tr.failed > 0) throw new Error(`真实测试未通过：FAIL=${tr.failed}（见集成测试报告）`);
  return lines;
}
const generated = (st) => (st.review?.decision === 'approved' ? 'approved' : 'generated');

/* ---------- 产物落盘路径规约：docs/<两位流程序号>-<流程名>/<产物ID>.md ---------- */
/** 阶段 doc 目录：序号 + 服务端阶段名（磁盘路径不跟界面语言走，保证同一份产物的路径稳定）。模块产物归到「模块开发」。
    名字里的 `/`（UI/UX 设计）折成 `-`，否则会被当成多级目录。 */
export const docDirOf = (ownerId, p = null) => {
  const list = (p && Array.isArray(p.stages) && p.stages.length) ? p.stages : STAGES;   // 序号跟项目自己的工作流走（精简流程没有 UX，架构就是 02）
  let i = list.findIndex(s => s.id === ownerId);
  if (i < 0 && /^M\d+$/i.test(String(ownerId || ''))) i = list.findIndex(s => s.id === 'development');
  if (i < 0) return `docs/${ownerId}`;
  return `docs/${String(i + 1).padStart(2, '0')}-${list[i].name.replace(/[/\\]/g, '-')}`;
};
export const docPathOf = (ownerId, artifactId, p = null) => `${docDirOf(ownerId, p)}/${artifactId}.md`;

function writeArtifactFile(p, ownerId, artifact) {
  if (p._removed) return null;                    // 已删除的项目不许再把文件写回来
  const file = { path: docPathOf(ownerId, artifact.id, p), content: artifact.content };
  try { exec.writeFiles(exec.wsDir(p.id), [file]); return file.path; } catch { return null; }
}

function writeDocs(p, st) {
  return st.artifacts.map(a => writeArtifactFile(p, st.id, a)).filter(Boolean).length;
}

/* ---------- 人工编辑产物 / 工作区文件 ---------- */

const unitTestsOf = (tr) => ({ total: tr.total, passed: tr.passed, failed: tr.failed, exit_code: tr.exit_code, cmd: tr.cmd, ms: tr.ms, at: tr.at, timed_out: !!tr.timed_out, tail: tr.tail });

function buildModuleReport(p, mod, tr, cdsChk) {
  return {
    id: `${mod.id}-CODE`, name: `${mod.name} · 代码与单测`, type: 'markdown',
    status: mod.status === 'approved' ? 'approved' : 'generated', version: mod.attempts, at: now(),
    content: `# 模块 ${mod.id} · ${mod.name}

**目标**：${mod.goal || '—'}
**说明**：${mod.summary || '—'}
**语言档案**：${prof(p).label}
**架构层**：${mod.layer || '—'} · **代码位置**：\`${mod.dir || '—'}/\` · **测试位置**：\`${mod.test_path_planned || mod.test_path || '—'}\`

## 交付文件（workspace/${p.id}）
${mod.files.map(f => `- \`${f.path}\`（${f.loc} 行）`).join('\n')}
${cdsChk ? `\n## CDS 模型（结构性校验，非 cds-dk 编译）\n${cdsChk.files} 个 .cds 文件 · ${cdsChk.ok ? '结构正常（花括号配对 / 有 namespace 或 entity / 实体都有 key）' : cdsChk.errors.map(e => `- \`${e.file}\`：${e.error}`).join('\n')}\n` : ''}
## 单元测试（真实执行）
命令：\`${tr.cmd}\` · 退出码 ${tr.exit_code} · ${tr.ms}ms

| tests | pass | fail |
|---|---|---|
| ${tr.total} | ${tr.passed} | ${tr.failed} |

\`\`\`
${tr.tail}
\`\`\`

> 规则：本模块单元测试 FAIL=0 且人工批准，才进入下一个模块。
`,
  };
}

export function findArtifact(p, aid) {
  for (const s of p.stages) { const a = s.artifacts.find(x => x.id === aid); if (a) return { owner: s, ownerId: s.id, artifact: a }; }
  for (const m of p.modules) { const a = m.artifacts.find(x => x.id === aid); if (a) return { owner: m, ownerId: 'development', artifact: a }; }
  return null;
}

/** 工作区文件 → 归属模块：先按模块生成记录里的原路径精确匹配；否则看文件所在的层目录里是否只有一个模块。
    （文件名不带 WBS 序号，所以不再靠名字里的模块号认领 —— 记录 + 目录唯一性就够了。） */
function moduleOfFile(p, rel) {
  for (const m of p.modules) if ((m.files || []).some(f => f.path === rel)) return m;
  const dir = String(rel || '').split('/').slice(0, -1).join('/');
  const cands = p.modules.filter(m => m.dir === dir);
  return cands.length === 1 ? cands[0] : null;
}
/** 该文件是否属于这个模块：测试文件精确匹配 → 生成记录 → 该层目录里只有这一个模块。 */
function belongsToModule(p, mod, f, testRel) {
  if (f === testRel || (mod.files || []).some(x => x.path === f)) return true;
  const dir = String(f || '').split('/').slice(0, -1).join('/');
  return mod.dir === dir && p.modules.filter(m => m.dir === dir).length === 1;
}

function assertEditable(owner) {
  if (owner.status === 'approved') throw new HttpError(409, `「${owner.name}」已批准，内容已锁定；如需修改请先驳回重做`);
}

/** 人工编辑产物正文：落库 + 落盘。已批准的阶段/模块锁定，避免批准后偷改。 */
export function editArtifact(p, aid, { content, editor = '人工' } = {}) {
  const hit = findArtifact(p, aid);
  if (!hit) throw new HttpError(404, `产物不存在：${aid}`);
  if (typeof content !== 'string') throw new HttpError(400, 'content 必须是字符串');
  assertEditable(hit.owner);
  const a = hit.artifact;
  if (a.content === content) return a;
  a.content = content;
  a.version = (a.version || 1) + 1;
  a.edited = { by: editor, at: now(), count: (a.edited?.count || 0) + 1 };
  a.status = 'edited';
  const path = writeArtifactFile(p, hit.ownerId, a);
  pushEvent(p, { stage: hit.ownerId, kind: 'edit', text: `✎ 人工修改产物《${a.name}》→ v${a.version}（${content.length} 字符${path ? `，已写入 ${path}` : ''}）` });
  save();
  return a;
}

/** 人工编辑工作区文件：真实写盘；若是模块代码/测试，必须重跑真实测试，否则门禁会基于过期结果放行。 */
export async function editWorkspaceFile(p, relPath, content, { editor = '人工' } = {}) {
  if (p._removed) throw new HttpError(409, '项目已删除，不能再写它的工作区');
  const rel = exec.safeRel(relPath);
  if (!rel) throw new HttpError(400, '非法路径');
  if (typeof content !== 'string') throw new HttpError(400, 'content 必须是字符串');
  const mod = moduleOfFile(p, rel);
  if (mod) assertEditable(mod);
  const root = exec.wsDir(p.id);
  const written = exec.writeFiles(root, [{ path: rel, content }])[0];
  if (!written) throw new HttpError(400, '文件未写入（路径或内容不合法）');
  pushEvent(p, { stage: mod ? 'development' : 'system', kind: 'edit', text: `✎ 人工修改工作区文件 ${rel}（${written.loc} 行）` });

  const out = { path: rel, bytes: written.bytes };
  if (mod && rel.endsWith(prof(p).ext)) {                          // 按语言档案判「这是不是源码」（Java/Python 也要重跑，不再只认 .mjs）
    const testRel = mod.test_path || (mod.files.find(f => !f.path.startsWith((mod.dir || '') + '/')) || {}).path;
    if (testRel) {
      const tr = await exec.runTests(root, testRel, prof(p), [...mod.files.map(f => f.path), rel]);   // ← 改过代码就必须真跑（只编本模块 + 刚改的文件）
      mod.unit_tests = unitTestsOf(tr);
      mod.files = exec.listFiles(root)
        .filter(f => belongsToModule(p, mod, f, testRel))
        .map(f => ({ path: f, ...exec.statOf(root, f) }));
      const old = mod.artifacts[0];
      mod.artifacts = [{ ...buildModuleReport(p, mod, tr), version: (old?.version || 1) + 1, edited: { by: editor, at: now() } }];
      if (!tr.ok) mod.error = `人工修改后单元测试未通过：FAIL=${tr.failed}（退出码 ${tr.exit_code}）`;
      else mod.error = null;
      // 人工改过的模块不再自动重生成（否则会把人的改动冲掉），交回人工处理
      if (mod.status !== 'approved') mod.status = 'awaiting_review';
      pushEvent(p, { stage: 'development', kind: 'test', text: `改后重跑 ${tr.cmd} → PASS=${tr.passed} FAIL=${tr.failed} 退出码 ${tr.exit_code}` });
      out.test = { total: tr.total, passed: tr.passed, failed: tr.failed, exit_code: tr.exit_code };
    }
  }
  syncDevelopment(p);
  save();
  return out;
}

/* ---------- 开发阶段：逐模块 ---------- */

async function runDevelopment(p, st, opts = {}) {
  kick(p, opts);            // 统一由 kick 按并发槽位补满（并行）
}

export function checkModuleRunnable(p, moduleId) {
  const mod = p.modules.find(m => m.id === moduleId);
  if (!mod) throw new HttpError(404, '模块不存在');
  if (mod.status === 'approved') throw new HttpError(409, '模块已批准');
  if (mod.status === 'awaiting_review') throw new HttpError(409, '模块等待审核，请先批准或驳回');
  if (mod.status === 'running') throw new HttpError(409, '模块正在开发');
  const st = p.stages.find(s => s.id === 'development');
  guardAdvance(p, st);
  // 串行模式（并发=1）才要求前序模块先批准；并行模式下发令顺序由 Agent 池决定
  if (CONC === 1) {
    const idx = p.modules.indexOf(mod);
    const prev = p.modules.slice(0, idx).find(m => m.status !== 'approved');
    if (prev) throw new HttpError(409, `前置模块「${prev.name}」未批准`);
  }
  return mod;
}

export async function runModule(p, mod, opts = {}) {
  checkModuleRunnable(p, mod.id);
  const st = p.stages.find(s => s.id === 'development');
  mod.status = 'running'; mod.attempts += 1; mod.error = null;
  mod.agent = freeAgent(p);                      // 先占 Agent 槽位，事件里能看出是谁在做
  st.status = 'running'; st.started_at = st.started_at || now();
  pushEvent(p, { stage: 'development', kind: 'run', text: `▶ ${mod.agent} 领取模块 ${mod.id}「${mod.name}」（第 ${mod.attempts} 轮，模型：${channelTag(p, 'development')}；并发 ${CONC}）` });
  refreshWsSkills(p);                                    // 工作区自带技能优先：每次调模型前按磁盘刷一次

  const d = opts.delay || delay;
  const root = exec.wsDir(p.id);
  try {
    for (const s of sim.planSteps(p, { id: 'development', agent: st.agent })) { await d(s.ms); pushEvent(p, { stage: 'development', kind: 'step', text: s.text }); }
    pushEvent(p, { stage: 'development', kind: 'step', text: PROVIDER === 'sim' ? '离线通道 · 生成模板代码' : `调用 ${modelFor(p, 'development')} 生成代码与单元测试…` });

    const code = PROVIDER === 'sim' ? sim.moduleCode(p, mod) : await agent.moduleCode(p, mod, lastFeedback(mod));
    if (p._removed || !p.modules.includes(mod)) return;      // 项目已删 / 已被「重新构建」清掉：别把文件写回已清理的工作区
    const testRel = exec.safeRel(code.test.path);
    if (!testRel) throw new Error(`模型给的测试路径不合法：${code.test.path}`);
    mod.files = exec.writeFiles(root, [...code.files, code.test]);
    if (!mod.files.length) throw new Error('模型未产出可写入的文件');
    if (code.usage) pushEvent(p, { stage: 'development', kind: 'step', text: `模型返回，token 用量 ${code.usage.total_tokens ?? '—'}` });
    pushEvent(p, { stage: 'development', kind: 'artifact', text: `写入 ${mod.files.length} 个文件：${mod.files.map(f => f.path).join('、')}` });
    // 规约偏差可见：不许建模块子目录、文件名不许带 WBS 序号；不合规不拦截，但必须在事件流里看得见
    const wbsNo = /^m?\d+/i;                                     // M1OrderService / m1_order_service / 1_order 这类
    const off = mod.files.filter(f => {
      if (f.path === testRel || /^(db|srv)\/.*\.cds$/.test(f.path)) return false;
      if (!(mod.dir && f.path.startsWith(mod.dir + '/'))) return true;   // 没落进这一层的目录
      const rest = f.path.slice(mod.dir.length + 1);
      return rest.includes('/') || wbsNo.test(rest);                     // 又建了一层模块子目录 / 文件名带了 WBS 序号
    });
    if (off.length) pushEvent(p, { stage: 'development', kind: 'step', text: `⚠ ${mod.id} 有 ${off.length} 个文件不符合层目录规则（要求：直接放在 ${mod.dir}/ 这一层、用业务语义命名、**不带 WBS 模块号/任务号**，不许建模块子目录）：${off.map(f => f.path).join('、')}` });
    // 同层重名会互相覆盖：写盘前先跟别的模块的记录比一遍，撞了就报出来
    const dup = [...(code.files || []), code.test].filter(x => x && x.path)
      .filter(x => p.modules.some(m => m !== mod && (m.files || []).some(f => f.path === x.path)));
    if (dup.length) pushEvent(p, { stage: 'development', kind: 'error', text: `⚠ ${mod.id} 的文件与其它模块重名（会同层互相覆盖，请换更具体的业务名）：${dup.map(x => x.path).join('、')}` });

    await d(200);
    const tr = await exec.runTests(root, testRel, prof(p), mod.files.map(f => f.path));   // ← 真实执行（按栈选运行器；Java 只编本模块，别的层同名类不该拖垮它）
    mod.unit_tests = unitTestsOf(tr);
    mod.summary = code.summary || mod.summary || '';
    mod.test_path = testRel;
    const cdsChk = prof(p).cds ? exec.checkCds(root) : null;
    mod.artifacts = [buildModuleReport(p, mod, tr, cdsChk)];
    pushEvent(p, { stage: 'development', kind: 'test', text: `真实执行 ${tr.cmd} → PASS=${tr.passed} FAIL=${tr.failed}，退出码 ${tr.exit_code}` });
    if (cdsChk) {
      pushEvent(p, { stage: 'development', kind: 'step', text: cdsChk.files
        ? `CDS 结构性校验：${cdsChk.files} 个 .cds 文件 ${cdsChk.ok ? '结构正常' : '有问题 —— ' + cdsChk.errors.map(e => `${e.file}：${e.error}`).join('；')}`
        : 'CDS 结构性校验：本模块未产出 .cds（CAP 项目的 DB/服务层应有 db/schema.cds、srv/*.cds）' });
    }
    if (tr.ok === false && tr.exit_code === -1 && /缺 JDK|缺 python3/.test(tr.tail)) throw new Error(`模块 ${mod.id} 未能真跑测试：${tr.tail.split('\n')[0]}`);
    const pass = tr.exit_code === 0 && tr.failed === 0 && tr.total > 0;
    if (pass) {
      const broken = await reverifyApprovedModules(p, mod);      // 本模块可能重写了同层文件 → 复核别人还成不成立
      mod.status = 'awaiting_review';
      pushEvent(p, { stage: 'development', kind: 'gate', text: `⏸ 模块 ${mod.id}「${mod.name}」完成 → 等待人工批准（单元测试 FAIL=0：PASS=${tr.passed}）${broken.length ? `· 同层复核发现 ${broken.length} 个模块被打回：${broken.join('、')}` : ''}` });
    } else {
      // 门禁不通过 = 模块失败（不是「等人批准」）：这样 kick() 才会重排重试，并把真实失败输出喂回模型
      const bad = (tr.tail || '').split('\n').filter(l => /^✖ /.test(l)).map(l => l.replace(/^✖ /, '').replace(/\s*\(\d[\d.]*ms\)\s*$/, '').trim()).slice(0, 3);
      const more = (mod.attempts || 0) < 3 ? `→ 自动重排重试（第 ${(mod.attempts || 0) + 1}/3 轮）` : '→ 已重试 3 轮仍未通过，需人工处理（可看模块详情的真实输出，或驳回该模块重跑）';
      mod.status = 'failed';
      mod.error = (tr.timed_out
        ? `单元测试超时（${tr.ms}ms 内没跑完：测试进程跑完不退出，多半是没关掉的句柄/定时器或挂起的 Promise）`
        : `单元测试未通过：PASS=${tr.passed} FAIL=${tr.failed}（退出码 ${tr.exit_code}）`)
        + (bad.length ? `· 失败用例：${bad.join('；')}` : '');
      pushEvent(p, { stage: 'development', kind: 'error', text: `✕ 模块 ${mod.id}「${mod.name}」${mod.error} ${more}` });
    }
  } catch (e) {
    const msg = e.message || String(e);
    if (!transientBounce(p, mod, 'development', '模块', msg)) {
      mod.status = 'failed'; mod.error = msg;
      pushEvent(p, { stage: 'development', kind: 'error', text: `✕ 模块 ${mod.id}「${mod.name}」失败：${mod.error}` });
    }
  }
  syncDevelopment(p);
  save();
  kick(p, opts);
}

function syncDevelopment(p) {
  const st = p.stages.find(s => s.id === 'development');
  if (!st) return;
  const mods = p.modules;
  if (!mods.length) return;
  if (mods.every(m => m.status === 'approved')) {
    if (st.status !== 'approved') {
      st.status = 'approved'; st.finished_at = now();
      st.review = { decision: 'approved', by: '逐模块批准', at: now() };
      const n = mods.reduce((a, m) => a + (m.unit_tests?.total || 0), 0);
      pushEvent(p, { stage: 'development', kind: 'gate', text: `✓ 全部 ${mods.length} 个模块批准 · 累计真实单元测试 ${n} 条 · 开发阶段闭合 → 进入集成测试` });
    }
  } else if (mods.some(m => m.status === 'failed')) st.status = 'failed';
  else if (mods.some(m => m.status === 'running')) st.status = 'running';
  else if (mods.some(m => m.status === 'awaiting_review')) st.status = 'awaiting_review';
  else st.status = 'running';
}

/* 「批准」= 对**当前代码树**成立：同一层的文件会被别的模块重写，所以一个模块跑完（真通过）后，
   复核其它已批准模块的用例，谁的用例挂了就把谁打回 failed —— 重试循环会带着真实错误让它重做（≤3 轮）。
   ponytail: 逐个模块重跑它的测试文件（ms 级）；要更省就把依赖图建起来只测受影响的模块，等真的变慢再说。 */
export async function reverifyApprovedModules(p, changed, opts = {}) {
  const root = exec.wsDir(p.id);
  const broken = [];
  for (const other of (p.modules || []).filter(m => m !== changed && m.status === 'approved' && m.test_path)) {
    const rel = exec.safeRel(other.test_path);
    if (!rel || !fs.existsSync(path.join(root, rel))) continue;
    const tr = await exec.runTests(root, rel, prof(p), (other.files || []).map(f => f.path));
    if (tr.ok) continue;
    other.unit_tests = unitTestsOf(tr);
    other.status = 'failed';
    other.error = `同层文件被 ${changed.id} 重写后单元测试不再通过：PASS=${tr.passed} FAIL=${tr.failed}（退出码 ${tr.exit_code}）`;
    broken.push(other.id);
    pushEvent(p, { stage: 'development', kind: 'error', text: `⚠ 模块 ${other.id}「${other.name}」的用例在 ${changed.id} 重写同层文件后失败 → 打回重做：${other.error}` });
  }
  return broken;
}

/* ---------- 审核（核心门禁） ---------- */

export function approveStage(p, stageId, reviewer = '人工') {
  const st = p.stages.find(s => s.id === stageId);
  if (!st) throw new HttpError(404, '阶段不存在');
  if (st.kind === 'development') throw new HttpError(409, '开发阶段按模块审批，不能整阶段批准');
  if (st.status !== 'awaiting_review') throw new HttpError(409, `当前状态为「${st.status}」，不可批准`);
  st.status = 'approved'; st.finished_at = now();
  st.review = { decision: 'approved', by: reviewer, at: now() };
  st.artifacts.forEach(a => { a.status = 'approved'; });
  pushEvent(p, { stage: st.id, kind: 'gate', text: `✓ ${st.name} 已批准（${reviewer}）→ 释放下一阶段` });
  save(); kick(p); return st;
}

export function rejectStage(p, stageId, { category = '未分类', comment = '', reviewer = '人工' } = {}) {
  const st = p.stages.find(s => s.id === stageId);
  if (!st) throw new HttpError(404, '阶段不存在');
  if (st.kind === 'development') throw new HttpError(409, '开发阶段按模块驳回');
  if (st.status !== 'awaiting_review') throw new HttpError(409, `当前状态为「${st.status}」，不可驳回`);
  st.status = 'rejected';
  st.review = { decision: 'rejected', by: reviewer, at: now(), category, comment };
  pushEvent(p, { stage: st.id, kind: 'gate', text: `✕ ${st.name} 被驳回〔${category}〕${comment ? '：' + comment : ''} → 反馈已喂回模型，重做` });
  save();
  guarded(p.id, () => runStage(p, st.id));
  return st;
}

export function approveModule(p, moduleId, reviewer = '人工') {
  const mod = p.modules.find(m => m.id === moduleId);
  if (!mod) throw new HttpError(404, '模块不存在');
  if (mod.status !== 'awaiting_review') throw new HttpError(409, `模块当前状态为「${mod.status}」，不可批准`);
  if (!mod.unit_tests) throw new HttpError(409, '缺少单元测试记录，不能批准');
  if (mod.unit_tests.exit_code !== 0 || mod.unit_tests.failed > 0) {
    const u = mod.unit_tests;
    // total=0 一般是「编译就没过」/「跑崩了」——别一律报「缺少单元测试记录」，那会把人引到错方向
    const why = u.total > 0 ? `FAIL=${u.failed}`
      : /编译失败/.test(u.tail || '') ? '编译失败'
      : '测试没产出结果（看记录里的原始输出）';
    throw new HttpError(409, `单元测试未通过（${why}，退出码 ${u.exit_code}），不能批准`);
  }
  if (mod.unit_tests.total <= 0) throw new HttpError(409, '单元测试没有产出任何用例（total=0），不能批准');
  if (CONC === 1) {                              // 串行模式才要求前序模块先批准
    const idx = p.modules.indexOf(mod);
    const prev = p.modules.slice(0, idx).find(m => m.status !== 'approved');
    if (prev) throw new HttpError(409, `前置模块「${prev.name}」未批准`);
  }

  mod.status = 'approved';
  mod.review = { decision: 'approved', by: reviewer, at: now() };
  mod.artifacts.forEach(a => { a.status = 'approved'; });
  pushEvent(p, { stage: 'development', kind: 'gate', text: `✓ ${mod.agent || 'Dev-Agent'} 的模块 ${mod.id}「${mod.name}」已批准（${reviewer}）· ${mod.unit_tests.cmd} PASS=${mod.unit_tests.passed}` });
  syncDevelopment(p);
  save(); kick(p); return mod;
}

export function rejectModule(p, moduleId, { category = '未分类', comment = '', reviewer = '人工' } = {}) {
  const mod = p.modules.find(m => m.id === moduleId);
  if (!mod) throw new HttpError(404, '模块不存在');
  if (mod.status !== 'awaiting_review' && mod.status !== 'approved') throw new HttpError(409, `模块当前状态为「${mod.status}」，不可驳回`);
  const wasApproved = mod.status === 'approved';               // 已批准也能撤回重做：后来发现它把同层别的模块写坏了是常事
  mod.status = 'rejected'; mod.version += 1; mod.attempts = wasApproved ? 0 : mod.attempts;   // 人给的机会不计入自动重试的 3 轮
  mod.review = { decision: 'rejected', by: reviewer, at: now(), category, comment };
  pushEvent(p, { stage: 'development', kind: 'gate', text: `✕ 模块 ${mod.id}「${mod.name}」${wasApproved ? '（已批准 → 撤回）' : ''}被驳回〔${category}〕${comment ? '：' + comment : ''} → 反馈已喂回模型，重做` });
  syncDevelopment(p);
  save();
  kick(p);                  // 驳回即重做，并由 kick 把其余并发槽位也补上
  return mod;
}

/* ---------- 汇总指标 ---------- */

/** 架构阶段的 ARC-01 声明「源码目录结构」→ 解析成层清单；没声明/非法 → 平台默认层。
    不阻断流水线：模型格式不合规只是退回默认，并由事件流标明来源。 */
function readLayout(p, st) {
  const arc = st.artifacts.find(a => a.id === 'ARC-01');
  const { layers: declared, stack } = agent.parseLayout(arc ? arc.content : '');
  const layers = declared.length ? declared : (p.arch && p.arch.layers && p.arch.layers.length ? p.arch.layers : agent.DEFAULT_LAYERS);   // ARC-01 优先 → 分类自带的目录规约 → 平台默认
  const resolved = stack || p.tech || '';
  const pro = exec.profileOf(resolved);
  pushEvent(p, { stage: 'architecture', kind: 'step', text: `技术栈：${resolved || '（未指定）'}${stack ? '（取自 ARC-01；' + (p.tech ? '与用户输入一致' : '用户未指定，由模型选型') + '）' : ''}` });
  pushEvent(p, { stage: 'architecture', kind: 'step', text: `语言档案：${pro.label} → 源码 ${pro.id === 'java' || pro.id === 'cap-java' ? 'src/main/java/<层>/' : 'src/<层>/'}、测试 ${pro.testPath('layer', 'order-service.test' + pro.ext)}；${pro.cds ? '含 CDS 建模（db/schema.cds、srv/*.cds）' : '不含 CDS'}；门禁按真实运行器退出码判定` });
  pushEvent(p, { stage: 'architecture', kind: 'step', text: declared.length
    ? `源码目录规约：${layers.join(' / ')}（取自 ARC-01「源码目录结构」）→ 模块源码直接落在层目录 src/<层>/（业务语义命名，不带 WBS 序号）`
    : `ARC-01 未声明合法层清单 → 源码目录规约按分类自带的目录规约：${layers.join(' / ')}（分类 ${typeOf(p.type).name}；改分类或重建都会回到它）` });
  return { layers, declared: declared.length > 0, from: declared.length ? 'ARC-01' : (p.arch && p.arch.from === 'type-default' ? 'type-default' : 'platform-default'), stack: resolved, stackFrom: stack ? 'ARC-01' : (p.tech ? 'user-input' : 'none'), profile: pro.id, at: now() };
}
const archLayers = (p) => (p.arch && p.arch.layers && p.arch.layers.length) ? p.arch.layers : agent.DEFAULT_LAYERS;

/* ---------- 技术栈 → 语言档案（决定代码扩展名、目录规约、真跑命令） ---------- */
export const stackOf = (p) => (p.arch && p.arch.stack) || p.tech || '';
export const prof = (p) => exec.profileOf(stackOf(p));

/** 每个 Epic 一个模块；层目录来自架构规约（Epic 自报 layer，非法则按序回落）。 */
function planModules(p, wbs, layers) {
  const ls = (layers && layers.length) ? layers : agent.DEFAULT_LAYERS;
  const profile = prof(p);                                    // 语言决定目录/测试路径规约
  const used = new Set();
  return wbs.epics.map((e, i) => {
    const layer = agent.validLayer(ls, String(e.layer || '').toLowerCase()) || agent.layerAt(ls, i);
    let slugName = agent.slug(e.name);                        // 业务名（不带 WBS 序号）；重名才加 -2/-3 兜底
    for (let k = 2; used.has(slugName); k++) slugName = `${agent.slug(e.name)}-${k}`;
    used.add(slugName);
    return {
      id: `M${i + 1}`, epic: e.id, name: e.name, goal: e.goal, layer,
      slug: slugName, dir: agent.modDirOf(profile, layer), test_path_planned: agent.testPathOf(profile, layer, i, e.name),
      profile: profile.id,
      status: 'pending', version: 0, attempts: 0, agent: null, files: [], unit_tests: null, artifacts: [], review: null, error: null,
    };
  });
}

export function summary(p) {
  const done = p.stages.filter(s => s.status === 'approved').length;
  const cur = currentStage(p);
  const unitTests = p.modules.reduce((a, m) => a + (m.unit_tests?.total || 0), 0);
  return {
    stages_total: p.stages.length, stages_done: done,
    current: cur ? { id: cur.id, name: cur.name, status: cur.status } : null,
    progress: p.stages.length ? done / p.stages.length : 0,
    epics: p.wbs.epics.length, tasks: p.wbs.task_count,
    modules_total: p.modules.length, modules_done: p.modules.filter(m => m.status === 'approved').length,
    modules_running: p.modules.filter(m => m.status === 'running').length,
    concurrency: CONC, agents: AGENTS,
    unit_tests: unitTests,
  };
}
