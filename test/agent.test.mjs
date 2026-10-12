/* ============================================================
   agent.test.mjs — 各阶段真的把「该阶段定义的那个模型」发给了模型服务
   做法：本地起一个假模型服务（记录每个请求体），把 agent.mjs 指过去，
   然后按阶段调用，断言请求体里的 model 字段——这是线上真正会发出去的字节。
   运行：AI_PLATFORM_SPEED=0 node --test test/
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const KEY = 'test-key';
let reply = {};
let seen = [];
let finishSeq = [];                                    // 模拟被截断：按顺序发 finish_reason
const calls = () => seen;

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    seen.push({ model: body.model, auth: req.headers.authorization, url: req.url, maxTokens: body.max_tokens, messages: JSON.stringify(body.messages) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'stub-model', usage: { total_tokens: 1 },
      choices: [{ finish_reason: finishSeq.length ? finishSeq.shift() : 'stop', message: { content: JSON.stringify(reply) } }],
    }));
  });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
stub.unref();                                          // 别让假服务把测试进程挂住
process.on('exit', () => { try { stub.close(); } catch {} });

// agent.mjs 在 import 时读环境变量，所以先备好环境再动态导入
process.env.AI_PLATFORM_API_KEY = KEY;
process.env.AI_PLATFORM_BASE_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AI_PLATFORM_PROVIDER = 'live';
delete process.env.AI_PLATFORM_MODEL;                 // 缺省 = deepseek-v4-flash

const agent = await import('../agent.mjs');
const proj = (models) => ({ name: '模型路由测试', brief: 'b', tech: 't', models, inputs: [] });
const stage = (id, name) => ({ id, name, agent: 'Test Agent' });

test('阶段模型真的发到模型服务：定义优先，未定义发缺省 deepseek-v4-flash', async () => {
  reply = { content: '# 交付物正文' };
  seen = [];
  const r = await agent.stageArtifacts(proj({ requirements: 'stage-model-A' }), stage('requirements', '需求分析'), null);
  assert.equal(r.artifacts.length, 3, '需求阶段 3 份交付物');
  assert.equal(seen.length, 3, `3 份交付物 = 3 次真实调用（实际 ${seen.length}）`);
  assert.deepEqual([...new Set(seen.map(s => s.model))], ['stage-model-A'], `每次请求都带该阶段的模型：${seen.map(s => s.model).join('、')}`);
  assert.ok(seen.every(s => s.auth === `Bearer ${KEY}`), 'API Key 随请求发出');
  assert.ok(seen.every(s => s.url === '/v1/chat/completions'), `打到 /chat/completions：${seen[0].url}`);
  assert.equal(r.model, 'stub-model', '记录模型服务实际返回的模型名');

  seen = [];
  await agent.stageArtifacts(proj({}), stage('ux', 'UI/UX 设计'), null);   // 没定义 → 缺省
  assert.deepEqual([...new Set(seen.map(s => s.model))], ['deepseek-v4-flash'], `未定义的阶段发缺省 deepseek：${seen.map(s => s.model).join('、')}`);

  seen = [];
  await agent.stageArtifacts(proj({ ux: '  ' }), stage('ux', 'UI/UX 设计'), null);   // 空白值也当没定义
  assert.deepEqual([...new Set(seen.map(s => s.model))], ['deepseek-v4-flash'], '空白值算未定义');
});

test('WBS 与模块开发各自用自己阶段定义的模型', async () => {
  reply = { epics: [{ name: '核心', layer: 'core', goal: 'g', tasks: [{ name: 't', files: 'src/core/m1-核心/index.mjs' }] }] };
  seen = [];
  const w = await agent.wbs(proj({ wbs: 'model-B' }));
  assert.equal(seen.length, 1, 'WBS 一次调用');
  assert.equal(seen[0].model, 'model-B', `WBS 用 wbs 阶段的模型：${seen[0].model}`);
  assert.equal(w.epics.length, 1);

  seen = [];
  reply = { summary: 's', files: [{ path: 'src/core/m1-核心/index.mjs', content: 'export const a = 1;' }], test: { path: 'test/core/m1-核心.test.mjs', content: 'x' } };
  const project = { ...proj({ development: 'model-C' }), wbs: w };
  const code = await agent.moduleCode(project, { id: 'M1', name: '核心', epic: 'E1', layer: 'core', dir: 'src/core/m1-核心' });
  assert.equal(seen.length, 1, '一个模块一次调用');
  assert.equal(seen[0].model, 'model-C', `模块开发用 development 阶段的模型：${seen[0].model}`);
  assert.equal(code.files.length, 1);

  seen = [];
  reply = { epics: [{ name: '核心', layer: 'core', goal: 'g', tasks: [{ name: 't' }] }] };
  await agent.wbs(proj({}));
  assert.equal(seen[0].model, 'deepseek-v4-flash', 'WBS 未定义时回落缺省');
});

test('modelFor：定义优先，未定义 / 空白 / 没项目都回落缺省', () => {
  assert.equal(agent.DEFAULT_MODEL, 'deepseek-v4-flash');
  assert.equal(agent.modelFor(proj({ wbs: 'x' }), 'wbs'), 'x');
  assert.equal(agent.modelFor(proj({ wbs: '  ' }), 'wbs'), 'deepseek-v4-flash');
  assert.equal(agent.modelFor(proj({}), 'wbs'), 'deepseek-v4-flash');
  assert.equal(agent.modelFor(null, 'wbs'), 'deepseek-v4-flash');
  assert.equal(agent.modelFor(proj({ wbs: 'x' }), 'development'), 'deepseek-v4-flash', '别的阶段不受影响');
});

test('输出被截断（finish_reason=length）→ 重试直接把预算顶到上限；两次都被截断才算失败', async () => {
  reply = { epics: [{ name: '核心', layer: 'core', goal: 'g', tasks: [{ name: 't' }] }] };

  // 第一次截断、第二次正常 → 重试用的 max_tokens 必须比第一次大得多（不是小步翻倍）
  seen = []; finishSeq = ['length', 'stop'];
  const w = await agent.wbs(proj({}));
  assert.equal(seen.length, 2, `截断后重试一次（实际 ${seen.length} 次调用）`);
  assert.equal(seen[1].maxTokens, 65536, `重试把预算顶到上限（实际 ${seen[1].maxTokens}，第一次 ${seen[0].maxTokens}）`);
  assert.ok(seen[1].maxTokens > seen[0].maxTokens * 2, '重试预算明显加大，不是小步试探');
  assert.equal(w.epics.length, 1, '重试成功后正常返回');

  // 两次都截断 → 明确失败，不静默降级成半截内容
  seen = []; finishSeq = ['length', 'length'];
  await assert.rejects(() => agent.wbs(proj({})), /被截断（finish_reason=length，已达 65536 tokens）/);
  assert.equal(seen.length, 2, '只重试一次就放弃（不无限烧钱）');
});

test('技能库真的随提示词发出去了：阶段交付物 / WBS / 模块代码三条路径都带', async () => {
  const skills = [
    { id: 'SK-1', name: '禁止第三方依赖', body: '只允许 Node 内置模块，存储用内存对象。' },
    { id: 'SK-2', name: '测试必须覆盖边界', body: '空输入、极值、错误分支各至少一条断言。' },
  ];
  // 1) 阶段交付物
  reply = { content: '# 交付物正文' };
  seen = [];
  await agent.stageArtifacts({ ...proj({}), skills }, stage('requirements', '需求分析'), null);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(s => /本项目「技能库」/.test(s.messages) && /【禁止第三方依赖】/.test(s.messages) && /【测试必须覆盖边界】/.test(s.messages)),
    `每份交付物的请求体都带技能库：${seen.map(s => /技能库/.test(s.messages)).join('、')}`);
  assert.ok(seen.every(s => /优先级：工作区自带技能 > 项目技能库 > 平台通用默认/.test(s.messages)), '技能片段写明优先级：工作区自带 > 项目技能库 > 平台通用默认');

  // 2) WBS
  reply = { epics: [{ name: '核心', layer: 'core', goal: 'g', tasks: [{ name: 't' }] }] };
  seen = [];
  await agent.wbs({ ...proj({}), skills });
  assert.match(seen[0].messages, /【测试必须覆盖边界】/, 'WBS 请求体带技能库');

  // 3) 模块代码
  reply = { summary: 's', files: [{ path: 'src/core/m1-核心/index.mjs', content: 'export const a = 1;' }], test: { path: 'test/core/m1-核心.test.mjs', content: 'x' } };
  seen = [];
  await agent.moduleCode({ ...proj({}), skills, wbs: { epics: [] } }, { id: 'M1', name: '核心', epic: 'E1', layer: 'core', dir: 'src/core/m1-核心' });
  assert.match(seen[0].messages, /【禁止第三方依赖】/, '模块代码请求体带技能库');

  // 4) 没技能就不带这一段（别塞空壳进提示词）
  reply = { epics: [{ name: '核心', layer: 'core', goal: 'g', tasks: [{ name: 't' }] }] };
  seen = [];
  await agent.wbs(proj({}));
  assert.ok(!/技能库/.test(seen[0].messages), '空技能库不产生多余提示词');
  assert.equal(agent.skillsBrief({ skills: [] }), '', '空库返回空串');
  assert.equal(agent.skillsBrief(null), '', '没项目也返回空串');
  assert.match(agent.skillsBrief({ skills }), /^- 【禁止第三方依赖】只允许 Node 内置模块/m, '渲染成「- 【名】正文」列表');
});

test('阶段专属技能只进对应阶段的提示词（别的阶段看不到）', async () => {
  const skills = [
    { id: 'SK-1', name: '通用禁令', body: '不许引入第三方包。', stage: '' },
    { id: 'SK-2', name: '开发阶段专属', body: '每个模块的测试文件必须镜像到 test/<层>/。', stage: 'development' },
    { id: 'SK-3', name: '需求阶段专属', body: '每条需求都要有编号与验收口径。', stage: 'requirements' },
  ];
  const project = () => ({ ...proj({}), skills, wbs: { epics: [] } });

  // 需求阶段：通用 + 需求专属；不该看到开发专属
  reply = { content: '# 交付物正文' };
  seen = [];
  await agent.stageArtifacts(project(), stage('requirements', '需求分析'), null);
  assert.match(seen[0].messages, /【通用禁令】/, '通用技能进任何阶段');
  assert.match(seen[0].messages, /【需求阶段专属】/, '本阶段专属技能带上');
  assert.ok(!/【开发阶段专属】/.test(seen[0].messages), '别的阶段的专属技能不带');

  // 模块开发：通用 + 开发专属
  reply = { summary: 's', files: [{ path: 'src/core/m1-核心/index.mjs', content: 'export const a = 1;' }], test: { path: 'test/core/m1-核心.test.mjs', content: 'x' } };
  seen = [];
  await agent.moduleCode(project(), { id: 'M1', name: '核心', epic: 'E1', layer: 'core', dir: 'src/core/m1-核心' });
  assert.match(seen[0].messages, /【开发阶段专属】/);
  assert.ok(!/【需求阶段专属】/.test(seen[0].messages), '需求专属不进模块代码');

  // 纯函数层：按阶段过滤
  assert.equal(agent.skillsBrief({ skills: [skills[1]] }, 'requirements'), '', '只剩别的阶段专属 → 这一段根本不出现');
  assert.match(agent.skillsBrief({ skills: [skills[1]] }, 'development'), /【开发阶段专属】/);
  assert.match(agent.skillsBrief({ skills: [skills[2]] }), /【需求阶段专属】/, '不传阶段 = 全带');
});

test('Java 档案的提示词要求类名全局唯一（无 package 单 classpath，重名=整个项目全红）', async () => {
  reply = { summary: 's', files: [{ path: 'src/main/java/core/Order.java', content: 'public class Order {}' }], test: { path: 'src/test/java/core/CoreTest.java', content: 'x' } };
  seen = [];
  await agent.moduleCode({ ...proj({}), tech: 'Java 21 + Spring Boot 3', wbs: { epics: [] } }, { id: 'M1', name: '核心', epic: 'E1', layer: 'core', dir: 'src/main/java/core' });
  assert.match(seen[0].messages, /类名必须全局唯一/, 'Java 档案要求类名全局唯一');
  assert.match(seen[0].messages, /不要写 package/, '仍然禁止 package 声明');
});

test('技能太多时按预算截断注入（不把提示词顶爆）', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `SK-${i}`, name: `规则 ${i}`, body: 'x'.repeat(900), stage: '' }));
  const brief = agent.skillsBrief({ skills: many }, 'development');
  assert.ok(brief.length < 19000, `注入长度被压住（${brief.length} 字符 ≤ 18000 + 头部）`);
  assert.match(brief, /另有 \d+ 条技能因提示词预算未注入/, '截断时说明原因，不静默丢');
  assert.match(brief, /规则 0】/, '靠前的技能优先保留');
});

test('模型服务返回错误时，阶段失败并带上真实状态码（不静默降级）', async () => {
  const bad = http.createServer((req, res) => { res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Insufficient Balance' } })); });
  await new Promise(r => bad.listen(0, '127.0.0.1', r));
  bad.unref();
  const base = process.env.AI_PLATFORM_BASE_URL;
  process.env.AI_PLATFORM_BASE_URL = `http://127.0.0.1:${bad.address().port}/v1`;
  const fresh = await import('../agent.mjs?v=bad');       // 重新加载：BASE 在 import 时固定
  await assert.rejects(() => fresh.wbs(proj({ wbs: 'model-B' })), /402.*Insufficient Balance/);
  process.env.AI_PLATFORM_BASE_URL = base;
  bad.close();
});
