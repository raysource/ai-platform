/* ============================================================
   agent.mjs — 真实模型通道（OpenAI 兼容 /chat/completions）
   默认 DeepSeek；Key 取 AI_PLATFORM_API_KEY → DEEPSEEK_API_KEY → ~/.hermes/.env。
   产出的是真实模型生成的内容；没有 Key 时不会假装成功（除非显式 AI_PLATFORM_PROVIDER=sim）。
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import { PROFILES, profileOf } from './exec.mjs';

const TIMEOUT_MS = Number(process.env.AI_PLATFORM_TIMEOUT_MS || 180000);

function loadKey() {
  if (process.env.AI_PLATFORM_API_KEY) return process.env.AI_PLATFORM_API_KEY;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  for (const f of [`${os.homedir()}/.hermes/.env`]) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/^\s*(?:DEEPSEEK|AI_PLATFORM)_API_KEY\s*=\s*"?([^"\n\r]+)"?/m);
      if (m) return m[1].trim();
    } catch { /* 没有就没有 */ }
  }
  return null;
}

const KEY = loadKey();
/** 缺省模型：某阶段没有单独定义时用它（DeepSeek）。可用 AI_PLATFORM_MODEL 覆盖。 */
const MODEL = process.env.AI_PLATFORM_MODEL || 'deepseek-v4-flash';
const BASE = process.env.AI_PLATFORM_BASE_URL || 'https://api.deepseek.com/v1';

export const DEFAULT_MODEL = MODEL;

/** 该阶段实际用哪个模型：项目里按阶段定义优先，未定义 / 空值 → 缺省（deepseek）。 */
export const modelFor = (project, stageId) => {
  const m = project && project.models && project.models[stageId];
  return (typeof m === 'string' && m.trim()) ? m.trim() : MODEL;
};

export const available = () => !!KEY && process.env.AI_PLATFORM_PROVIDER !== 'sim';
export const info = () => available()
  ? { channel: 'live', provider: new URL(BASE).host, model: MODEL }
  : { channel: 'sim', provider: 'offline', model: null };

export class ProviderError extends Error {}

const MAX_OUT = 65536;             // 单次输出上限：实测本通道 40000 也能一路吐到 stop（27k tokens），8192 是平台自己的天花板，不是模型的

async function chat(messages, { json = false, maxTokens = 4000, temperature = 0.3, model = MODEL } = {}) {
  if (!available()) throw new ProviderError('未配置模型 API Key（AI_PLATFORM_API_KEY / DEEPSEEK_API_KEY），或已显式切到 sim 通道');

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const budget = attempt === 1 ? maxTokens : MAX_OUT;      // 被截断就别小步试探：重试直接给到上限
    const body = { model, messages, max_tokens: budget, temperature, stream: false };
    if (json) body.response_format = { type: 'json_object' };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ProviderError(`模型返回 ${r.status}：${j.error?.message || 'unknown'}`);
      const choice = j.choices?.[0] || {};
      const text = choice.message?.content || '';
      if (!text.trim()) throw new ProviderError('模型返回空内容');
      // 输出被 max_tokens 截断（JSON 一定会坏）→ 加大预算重试一次
      if (choice.finish_reason === 'length') {
        lastErr = new ProviderError(`模型输出被截断（finish_reason=length，已达 ${budget} tokens）`);
        continue;
      }
      return { text, usage: j.usage, model: j.model, finishReason: choice.finish_reason };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new ProviderError(`模型调用超时（${TIMEOUT_MS}ms）`) : e;
    } finally { clearTimeout(timer); }
    if (attempt === 1) await new Promise(r => setTimeout(r, 1200));
  }
  throw lastErr;
}

const stripFences = (t) => String(t).trim().replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();

function parseJSON(text, what) {
  const t = stripFences(text);
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  try { return JSON.parse(i >= 0 && j > i ? t.slice(i, j + 1) : t); }
  catch (e) { throw new ProviderError(`${what}：模型未返回合法 JSON（${e.message}）`); }
}

/* ---------- 源码目录结构规约（结构由平台定，层清单由架构阶段填） ----------
   架构设计阶段必须在 ARC-01 里声明「源码目录结构」；模块生成按层归类：
   **不为模块建文件夹、文件名也不带 WBS 序号** —— 源码直接放在层目录里、用业务语义命名：
     src/<层>/OrderService.mjs     一个 Epic = 一个模块 = 一个（或几个）业务命名的文件
     test/<层>/order-service.test.mjs   单元测试与源码同业务名，镜像到测试目录
   文件名叫什么由「模块做什么」决定（Java OrderService.java = public 类名，Node order-service.mjs，
   Python order_service.py）；M1/E2 这类 WBS 编号是平台内部的追踪号，不进交付物。
   ARC-01 没声明或声明非法 → 用 DEFAULT_LAYERS（平台默认），不阻断流水线。 */

export const DEFAULT_LAYERS = ['core', 'domain', 'service', 'api'];

/** 从架构设计说明书里抽「技术栈 + 层清单」：取第一个含 layers 的 ```json 代码块。 */
export function parseLayout(md) {
  for (const m of String(md || '').matchAll(/```json\s*([\s\S]*?)```/g)) {
    try {
      const o = JSON.parse(m[1]);
      const arr = Array.isArray(o);
      const dirs = arr ? o : (o.layers || []);
      const out = dirs
        .map(d => String(typeof d === 'string' ? d : (d && d.dir) || '').trim().toLowerCase())
        .filter(d => /^[a-z][a-z0-9_-]*$/.test(d));
      if (out.length) return { layers: [...new Set(out)], stack: String((arr ? '' : o.stack) || '').trim().slice(0, 160) };
    } catch { /* 这个块不是 JSON，跳过 */ }
  }
  return { layers: [], stack: '' };
}

/** 只要层清单（兼容旧调用）。 */
export const parseLayers = (md) => parseLayout(md).layers;

/** 层名是否在声明里；不在就返回 null（调用方再落到默认层）。 */
export const validLayer = (layers, name) => ((layers || []).includes(name) ? name : null);
export const layerAt = (layers, i) => (layers && layers.length ? layers[i % layers.length] : DEFAULT_LAYERS[i % DEFAULT_LAYERS.length]);

/* ---------- 路径规约（按栈档案：Node/Python 一套，Java 一套） ---------- */

/** 模块目录 = 该模块所属的层目录（不建模块子目录）。 */
export function modDirOf(profile, layer) { return profile.modDir(layer); }
/** 代码里的名字：业务语义、**不带 WBS 序号** —— Node kebab-case / Python snake_case / Java PascalCase。 */
export function codeNameOf(profile, name) {
  const s = slug(name || 'module');
  if (profile.id === 'java' || profile.id === 'cap-java')
    return s.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Module';
  if (profile.id === 'python') return s.replace(/-/g, '_');
  return s;
}
/** 源码文件名（Java 文件名必须等于 public 类名）。 */
export const srcFileOf = (profile, name) => `${codeNameOf(profile, name)}${profile.ext}`;
/** 单元测试文件名（按语言习惯，镜像到测试目录）。 */
export const testFileOf = (profile, name) => (profile.id === 'java' || profile.id === 'cap-java')
  ? `${codeNameOf(profile, name)}Test.java` : `${codeNameOf(profile, name)}.test${profile.ext}`;
/** 单元测试路径：与源码同一个业务名，镜像到测试目录（Node/Python 在 test/<层>/，Java 在 src/test/java/<层>/）。 */
export function testPathOf(profile, layer, i, name) { return profile.testPath(layer, testFileOf(profile, name)); }
/** 模型没给 files 时的兜底文件名（业务名，不带 WBS 序号）。 */
function defaultFiles(layers, i, profile, name) {
  return `${profile.modDir(layerAt(layers, i))}/${srcFileOf(profile, name || 'module')}`;
}

/** 目录名用的 slug：保留 CJK/假名（目录可读），其余非字母数字折成 '-'；空则回落 'mod'。 */
export const slug = (s) => String(s).normalize('NFC').toLowerCase()
  .replace(/[^\w\u3040-\u30ff\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'mod';

/** 上传的输入资料 → 提示词片段（每份截断，总量有上限，避免顶爆上下文）。 */
export function inputsBrief(project, totalCap = 6000, perCap = 1800) {
  const ins = (project && project.inputs) || [];
  if (!ins.length) return '';
  let left = totalCap;
  const parts = [];
  for (const f of ins) {
    if (left <= 0) break;
    const take = Math.min(perCap, left);
    const text = String(f.excerpt || '').slice(0, take);
    left -= text.length;
    parts.push(`--- 文件：${f.name}（${f.bytes} 字节）---\n${text}${(f.excerpt || '').length > take ? '\n…（截断）' : ''}`);
  }
  return `\n项目输入资料（用户上传，共 ${ins.length} 份；以这些内容为准，不要自己臆造）：
${parts.join('\n\n')}\n`;
}

/* ---------- 项目技能库 → 提示词片段（用户写的工程约定，按阶段过滤后带上） ---------- */

const SKILL_PROMPT_MAX = 18000;    // 单次注入的字符上限（≈6k tokens）；技能太多时先按顺序截断并说明，别把提示词顶爆
                                   // （技能改成 AI Agent Skills 标准格式后，每条正文含 Overview/When to Use/反合理化/红线/验收，均值 ~1.7KB；18k 刚好容下分类自带的 8–10 条）

/** stageId 为空 = 拿所有技能；否则 = 通用技能（stage 空）+ 该阶段专属技能。
    顺序即优先级：**工作区自带技能（生成的项目里 skills/<name>/SKILL.md）> 项目技能库 > 平台通用默认**；
    工作区技能排在最前，预算是按顺序截断的，所以它们绝不会先被丢掉。 */
export function skillsBrief(project, stageId = '') {
  const ok = (s) => s && s.name && s.body;
  const forStage = (a) => (stageId ? a.filter(s => !s.stage || s.stage === stageId) : a);
  const ws = forStage((project && Array.isArray(project.ws_skills) ? project.ws_skills : []).filter(ok));
  const own = forStage((project && Array.isArray(project.skills) ? project.skills : []).filter(ok));
  const list = [...ws, ...own];
  if (!list.length) return '';
  const kept = []; let used = 0, dropped = 0;
  for (const s of list) {
    const mark = s.from === 'workspace' ? '（本项目工作区自带 · 优先）' : '';
    const line = `- 【${s.name}】${mark}${s.body}`;
    if (used + line.length > SKILL_PROMPT_MAX) { dropped++; continue; }
    kept.push(line); used += line.length;
  }
  const tag = '本项目「技能库」（逐条遵守；**优先级：工作区自带技能 > 项目技能库 > 平台通用默认**——冲突时以更靠前的为准；与本阶段硬性要求冲突时按更严的那条来）'
    + (stageId ? '' : '（本次不带阶段过滤）');
  const tail = dropped ? `\n- （另有 ${dropped} 条技能因提示词预算未注入：请精简技能或按阶段拆分）` : '';
  return `\n${tag}：\n${kept.join('\n')}${tail}\n`;
}

/* ---------- 阶段交付物：结构由平台定义，内容由模型填 ---------- */

const ARTIFACT_SPECS = {
  requirements: [['REQ-01', '需求规格说明书'], ['US-01', '用户故事集'], ['AC-01', '验收标准']],
  ux: [['UX-01', '信息架构与导航'], ['UX-02', '界面原型说明']],
  architecture: [['ARC-01', '架构设计说明书'], ['ARC-02', '数据库设计'], ['ARC-03', 'API 规格']],
  operations: [['SRE-01', '监控与告警方案'], ['SRE-02', '运维手册']],
  testing: [['TST-01', '测试计划']],
  deployment: [['DPL-01', '部署方案']],
};
const LAYOUT_RULE =
`本文档的附加硬性要求（技术栈与源码目录结构规约）：
- 必须明确写出最终技术栈：用户指定了技术栈就照抄；用户**没有指定**时，由你选定一套最合适的（运行时 / 框架 / 数据库 / 测试方式）并说明选型理由。
- 正文必须有一节「源码目录结构」，先用 Markdown 表格列出各层目录（\`src/<层>/\`）的职责，再给一个 json 代码块，格式固定为：
\`\`\`json
{"stack":"Next.js + NestJS + PostgreSQL","layers":[{"dir":"core","responsibility":"…"},{"dir":"domain","responsibility":"…"}]}
\`\`\`
- 层名只用小写字母/数字/连字符，3–6 层；后续每个开发模块的源码都会按这个清单归档到 \`src/<层>/（直接放在层目录里，**不许再建模块子目录、文件名也不带 WBS 序号**；用业务语义命名，如 OrderService.java、order-service.mjs、order_service.py）\`，层要与模块划分对得上。
- 技术栈要与实际能落地的代码一致（本项目代码是零第三方依赖的 Node ESM，技术栈里可以写目标架构，但目录规约必须是可执行的）。`;

/** 一次只让模型写一份交付物：单份短、不会撞输出上限，坏了也只重试这一份。 */
async function oneArtifact(project, stage, spec, feedback, allNames, extra = '') {
  const [id, name] = spec;
  const sys = `你是软件交付流水线里的${stage.agent}，负责「${stage.name}」阶段，正在写其中一份交付物。`;
  const user =
`项目名称：${project.name}
项目概要：${project.brief || '（未提供）'}
技术栈：${project.tech || '（未指定）'}
${inputsBrief(project)}${skillsBrief(project, stage.id)}${feedback ? `上一轮被驳回的意见（必须吸收）：〔${feedback.category}〕${feedback.comment}\n` : ''}
请写出这一份交付物：**${id} ${name}**
（本阶段共 ${allNames.length} 份：${allNames.join('、')}；本份与其他份不重复）

${extra}要求：
1. 针对上面这个具体项目，Markdown 正文，中文，不要空话模板。
2. 篇幅 800–1500 字；表格用 Markdown 表格。
3. 只输出 JSON：{"content":"# ${name}\\n\\n..."}`;
  const { text, usage, model } = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, maxTokens: 4096, model: modelFor(project, stage.id) });
  let content;
  try { content = String(parseJSON(text, `${name}`).content || '').trim(); }
  catch { content = stripFences(text); }          // 宽容：拿不到 JSON 就用原文
  return { artifact: { id, name, type: 'markdown', content: content || `# ${name}\n\n（模型未返回内容）`, status: 'generated' }, usage, model };
}

export const artifactSpec = (stageId) => ARTIFACT_SPECS[stageId] || [['DOC-01', '阶段产物']];

export async function stageArtifacts(project, stage, feedback, onProgress) {
  const specs = artifactSpec(stage.id);
  const names = specs.map(s => s[1]);
  const artifacts = [];
  let usage = null, model = null;
  for (let i = 0; i < specs.length; i++) {          // 串行逐份写，日志里能看到进度
    const extra = (stage.id === 'architecture' && specs[i][0] === 'ARC-01') ? LAYOUT_RULE : '';
    const r = await oneArtifact(project, stage, specs[i], feedback, names, extra);
    artifacts.push(r.artifact);
    usage = r.usage || usage; model = r.model || model;
    if (onProgress) onProgress(i + 1, specs.length, r.artifact);
  }
  return { artifacts, usage, model };
}

/* ---------- WBS ---------- */

export async function wbs(project) {
  const layers = (project.arch && project.arch.layers && project.arch.layers.length) ? project.arch.layers : DEFAULT_LAYERS;
  const stack = (project.arch && project.arch.stack) || project.tech || '（未指定）';
  const profile = profileOf(stack);
  const sys = '你是任务规划师，负责把软件需求拆成可独立开发、可单元测试的模块。你只输出 JSON。';
  const user =
`项目：${project.name}
概要：${project.brief || '（未提供）'}
技术栈：${stack}
${inputsBrief(project)}${skillsBrief(project, 'wbs')}架构已定的源码层目录（一个 Epic 一个模块，源码就落在它所属的层目录下）：${layers.join(' / ')}

把项目拆成 4–7 个 Epic，每个 Epic 2–4 个 Task。每个 Epic 之后会作为一个开发模块，由工程师写代码 + 单元测试。
要求：
1. 每个 Epic 必须带 layer，值只能取上面列出的层之一（决定源码落到哪一层目录）。
2. Task 要小到能用一个模块实现并写单测；files 写成 ${defaultFiles(layers, 0, profile, '基础框架')}。
3. 只输出 JSON：
{"epics":[{"name":"基础框架","layer":"${layers[0]}","goal":"一句话目标","tasks":[{"name":"任务名","files":"${defaultFiles(layers, 0, profile, '基础框架')}","acceptance":"可机器判定的验收标准"}]}]}`;
  const { text, usage, model } = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, maxTokens: 4000, model: modelFor(project, 'wbs') });
  const out = parseJSON(text, 'WBS');
  const epics = (Array.isArray(out.epics) ? out.epics : []).slice(0, 8).map((e, i) => ({
    id: `E${i + 1}`,
    name: String(e.name || `Epic ${i + 1}`).slice(0, 60),
    layer: validLayer(layers, String(e.layer || '').trim().toLowerCase()) || layerAt(layers, i),
    goal: String(e.goal || '').slice(0, 200),
    tasks: (Array.isArray(e.tasks) ? e.tasks : []).slice(0, 6).map((t, j) => ({
      id: `E${i + 1}-T${j + 1}`,
      name: String(t.name || `Task ${j + 1}`).slice(0, 80),
      files: String(t.files || defaultFiles(layers, i, profile, e.name)).slice(0, 120),
      acceptance: String(t.acceptance || '单元测试通过').slice(0, 200),
      status: 'todo',
    })),
  })).filter(e => e.tasks.length);
  if (!epics.length) throw new ProviderError('WBS：模型没有给出可用的 Epic');
  return { epics, task_count: epics.reduce((a, e) => a + e.tasks.length, 0), layers, generated_at: new Date().toISOString(), usage, model };
}

/* ---------- 模块：真实生成代码 + 单测（按技术栈选语言，工具链真跑） ---------- */

/** 按栈档案给「语言规约」提示词块：代码路径、命名、测试入口、禁用项。 */
function langSpec(profile, dir, testPath) {
  const testClass = testPath.split('/').pop().replace(/\.[a-z]+$/, '');      // 测试类名 = 测试文件名（Java 要求一致）
  if (profile.id === 'java' || profile.id === 'cap-java') return {
    role: '你是资深 Java 工程师，产出能被 javac 编译、被 java 真跑通的 Java 代码。你只输出 JSON。',
    rules: `1. 只用 JDK 标准库（java.util / java.math / java.time / java.util.stream 等）；**禁止任何第三方依赖，也禁止 Spring / JPA / SAP CAP 注解**——执行侧只有 javac，没有 Maven 仓库，import 不到的包会直接编译失败。需要存储/状态就用内存集合模拟。
2. 不要写 package 声明（编译走默认包）；类名用**业务语义**的 PascalCase 英文（例：OrderRule / OrderService），文件名 = public 类名；**整个工作区里类名必须全局唯一**——没有 package，各层的 .java 一起进同一个 classpath，两个层各写一个 Order 或 ApiResponse 就是 「クラスOrderが重複しています」、整个项目全红：同一个业务实体的实体类**只在一个层定义**，别的层复用它或换更具体的名字（写 OrderRepositoryItem 而不是再写一个 Order）；**类名里不要带 WBS 模块号/任务号**（不写 M1OrderRule、E2T1OrderRule）。
3. 不要 System.currentTimeMillis / new Random()（时间、随机等外部输入请作为参数传入）。`,
    files: `源码只能放 ${dir}/ 下的 .java（架构规约指定的层目录，不许改到别处）`,
    test: `单元测试放 ${testPath}，public 类名 = 被测模块名 + Test（如 ${testClass}），且必须是可直接执行的 main（执行侧就是 \`java ${testClass}\`）：
public class ${testClass} {
  static int pass = 0, fail = 0;
  static void check(String name, boolean ok) { if (ok) pass++; else { fail++; System.out.println("not ok - " + name); } }
  public static void main(String[] args) {
    check("具体断言名", 期望值 == 实际值);   // 断言要具体，别只 check("ok", true)
    System.out.println("tests " + (pass + fail));
    System.out.println("pass " + pass);
    System.out.println("fail " + fail);
    System.exit(fail == 0 ? 0 : 1);
  }
}`,
  };
  if (profile.id === 'python') return {
    role: '你是资深 Python 工程师，产出能被 python3 + 标准库 unittest 真跑通的代码。你只输出 JSON。',
    rules: `1. 只用 Python 标准库；**禁止第三方包**（fastapi/flask/pydantic/requests/pytest 一律不要——它们没安装，import 就 ModuleNotFoundError）。需要存储/状态就用内存结构模拟。
2. 模块文件名用 ASCII snake_case 的业务语义名（例：order_service.py），不要带模块号，不要有 import 时的副作用。
3. 不要 time.time() / random（时间、随机等外部输入请作为参数传入）。`,
    files: `源码只能放 ${dir}/ 下的 .py（架构规约指定的层目录，不许改到别处）；**不许建模块子目录**，文件名用业务语义的 snake_case（如 order_service.py），**不要带 WBS 模块号/任务号**（不写 m1_order_service.py），同层靠业务名区分`,
    test: `单元测试放 ${testPath}：标准库 unittest，头部把源码目录加进 sys.path 再按文件名 import，文件尾部必须有 unittest.main()：
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '${dir}'))
from <你的模块文件名去 .py> import <被测函数>

class TestX(unittest.TestCase):
    def test_xxx(self): self.assertEqual(...)

if __name__ == '__main__':
    unittest.main()`,
  };
  return {
    role: '你是资深 Node.js 工程师，产出可运行、可测试的 ES Module 代码。你只输出 JSON。',
    rules: `1. 只允许 Node 内置模块与纯函数；**禁止引入任何第三方包**（pg / express / axios / dotenv / uuid 等一律不要——它们没安装，import 会直接报 ERR_MODULE_NOT_FOUND）。需要存储/状态就用内存对象或纯数据结构模拟。
2. 不要网络、不要文件系统、不要 Date.now/Math.random（时间请由参数传入）。`,
    files: `源码只能放 ${dir}/ 下的 .mjs（架构规约指定的层目录，不许改到别处）；**不许建模块子目录**，文件名用业务语义的 kebab-case（如 order-service.mjs），**不要带 WBS 模块号/任务号**（不写 m1-order-service.mjs、M1OrderService.mjs），同层靠业务名区分`,
    test: `单元测试放 ${testPath}，必须用：
import { test } from 'node:test'; import assert from 'node:assert/strict';
并从 '${'../'.repeat(testPath.split('/').length - 1)}${dir}/xxx.mjs' 导入被测函数（测试目录比源码浅一层，相对路径以 ${'../'.repeat(testPath.split('/').length - 1)} 开头）。`,
  };
}

export async function moduleCode(project, mod, feedback) {
  // 目录不在这里决定：harness 按架构规约算好 mod.dir / mod.test_path_planned，本函数照写。
  const stack = (project.arch && project.arch.stack) || project.tech || 'Node.js';
  const profile = profileOf(stack);
  const dir = mod.dir || `src/${mod.layer || 'core'}`;      // 层目录（不再有模块子目录）
  const testPath = mod.test_path_planned || testPathOf(profile, mod.layer || 'core', 0, mod.name);
  const tasks = (project.wbs.epics.find(e => e.id === mod.epic)?.tasks) || [];
  const spec = langSpec(profile, dir, testPath);
  const cds = profile.cds ? `\n8. 本项目是 SAP CAP：本模块若涉及数据模型或服务定义，必须同时产出真实 CDS 文件（db/schema.cds、srv/<名>-service.cds）：namespace + entity（**每个实体必须有 key**）+ service/projection；不要用 Java 注解或任何 ORM 替代 CDS 建模。` : '';
  const exFile = profile.ext;
  const sys = spec.role;
  const user =
`项目：${project.name}（技术栈：${stack} → 语言档案：${profile.label}）
模块：${mod.name}
模块所属源码层：${mod.layer || 'core'}（架构规约；源码直接放在 ${dir}/ 这一层，**不要再建模块子目录**）
模块目标：${mod.goal || '（未给出）'}
任务清单：
${tasks.map(t => `- ${t.name}${t.acceptance ? `（验收：${t.acceptance}）` : ''}`).join('\n') || '- （无）'}
${feedback ? `\n上一轮被驳回的意见（必须修正）：〔${feedback.category}〕${feedback.comment}\n` : ''}${skillsBrief(project, 'development')}
硬性要求：
${spec.rules}
4. ${spec.files}；单元测试放 ${testPath}。
5. ${spec.test}
6. 每个文件 ≤ 150 行；被测函数要导出（Java 用 public static）。
7. 单元测试要确实覆盖任务清单里的行为，断言要具体（断言值，不要只 check("ok", true) / assert.ok(x)）。${cds}
9. 只输出 JSON：
{"summary":"本模块实现了什么","files":[{"path":"${dir}/<业务文件名>${exFile}","content":"..."}],"test":{"path":"${testPath}","content":"..."}}`;
  const budget = profile.id === 'java' || profile.id === 'cap-java' ? 24000 : 8000;   // Java 一个模块常要 8–10 个文件 + 测试，8000 容易写不完
  let out = null, usage = null, model = null, text = '';
  for (let attempt = 1; attempt <= 2; attempt++) {           // 模型漏 test 字段/文件为空 → 补一次明确要求，不直接判死
    const retryNote = attempt === 1 ? '' : `\n\n上一次返回不合格：${!out ? 'JSON 解析失败' : (!(out.files || []).length ? 'files 为空' : '缺少 test 字段（必须是 {path, content}）')}。这次务必带上 test，且保证 JSON 完整：必要时减少源码文件数、精简每段代码，宁可少而全，不要多而缺。`;
    const r = await chat([{ role: 'system', content: sys }, { role: 'user', content: user + retryNote }], { json: true, maxTokens: budget, temperature: attempt === 1 ? 0.2 : 0.1, model: modelFor(project, 'development') });
    text = r.text; usage = r.usage; model = r.model;
    try { out = parseJSON(text, `模块 ${mod.id} 代码`); } catch (e) { out = null; if (attempt === 2) throw e; continue; }
    if ((out.files || []).length && out.test && typeof out.test.content === 'string') break;
    if (attempt === 2) break;
  }
  const files = Array.isArray(out && out.files) ? out.files : [];
  const test = out && out.test && typeof out.test.content === 'string' ? out.test : null;
  const shape = `（返回字段：${Object.keys(out || {}).join('、') || '空'}；files=${files.length} 个${test ? '' : '，test 缺失或不是 {path,content}'}；${text.length} 字符）`;
  if (!files.length) throw new ProviderError(`模块 ${mod.id}：模型没有返回源码文件${shape}`);
  if (!test) throw new ProviderError(`模块 ${mod.id}：模型没有返回单元测试${shape}`);
  return { summary: String(out.summary || '').slice(0, 300), files, test, usage, model, profile: profile.id };
}
