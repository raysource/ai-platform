/* ============================================================
   sim.mjs — 离线通道（仅在 AI_PLATFORM_PROVIDER=sim 或没有 API Key 时使用）
   它不编造统计数字：只生成真实的模板代码/文档，交给 exec.mjs 真跑。
   界面与事件流会标明当前走的是离线通道还是真实模型。
   源码目录：与真实模型通道同一套规约（直接落在层目录 src/<层>/，文件名用业务语义、不带 WBS 序号，也不建模块子目录），
   层清单由本通道的 ARC-01 用同一个 json 代码块声明，走同一条解析路径。
   ============================================================ */
import { DEFAULT_LAYERS, srcFileOf, testFileOf, modDirOf, testPathOf } from './agent.mjs';
import { profileOf } from './exec.mjs';

export function hash(s) { let h = 2166136261; for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export function planSteps(project, stage) {
  const base = {
    requirements: ['读取项目概要', '识别用户角色与场景', '拆解功能需求', '定义业务规则与异常', '编写验收标准'],
    ux: ['推导信息架构', '设计导航与页面清单', '定义界面规格'],
    architecture: ['推导系统边界与分层', '设计数据模型', '定义 API 契约'],
    wbs: ['把需求映射到交付物', '按耦合度划分 Epic', '下发 Task 与文件归属'],
    testing: ['汇总工作区测试结果', '统计覆盖率与缺口'],
    deployment: ['构建校验', '冒烟测试'],
    operations: ['接入指标与日志', '配置告警阈值'],
  }[stage.id] || ['执行 Agent 任务'];
  return base.map((text, i) => ({ text: `${stage.agent} · ${text}`, ms: 200 + (hash(stage.id + i) % 4) * 100 }));
}

/* ---------- 文档产物（离线模板） ---------- */

export function planArtifacts(project, stage) {
  const t = project.tech || 'Node.js';
  const body = {
    requirements: [['REQ-01', '需求规格说明书'], ['US-01', '用户故事集'], ['AC-01', '验收标准']],
    ux: [['UX-01', '信息架构与导航'], ['UX-02', '界面原型说明']],
    architecture: [['ARC-01', '架构设计说明书'], ['ARC-02', '数据库设计'], ['ARC-03', 'API 规格']],
    operations: [['SRE-01', '监控与告警方案'], ['SRE-02', '运维手册']],
  }[stage.id] || [['DOC-01', '阶段产物']];
  return body.map(([id, name]) => ({
    id, name, type: 'markdown', status: 'generated',
    content: `# ${name} · ${project.name}

> 离线模板（sim 通道）产出的结构占位；配置 API Key 后由真实模型生成正文。

## 概要
${project.brief || '（未提供）'}

## 技术栈
${t}

## 条目
- 覆盖该阶段应有的交付内容
- 每条都能指向可验证的验收方式
` + (id === 'ARC-01' ? layoutSection(project) : ''),
  }));
}

/** ARC-01 的「源码目录结构」一节：模块生成按这里声明的层归档（与真实模型同一份格式）。
    离线通道也要跟用户填的技术栈一致 —— 否则会出现「技术方案写 Java、产物却是 .mjs」的错位。 */
const STACK_LABEL = {
  node: 'Node.js ESM + node:test（零第三方依赖）',
  python: 'Python 3 + 标准库 unittest（零第三方依赖）',
  java: 'Java 21 + Spring Boot 3.3 分层（javac/java 真编译执行；零第三方依赖）',
  'cap-java': 'SAP CAP Java（CDS + Java，javac/java 真编译执行；CDS 走结构性校验）',
  'cap-node': 'SAP CAP Node.js（CDS + Node.js ESM，node --test）',
};
const layoutSection = (project) => {
  const pro = profileOf(project.arch?.stack || project.tech || '');
  const dirEx = pro.modDir('domain', 'm2-业务规则');
  const testEx = pro.testPath('domain', 'm2-业务规则', 'M2');
  const cdsLine = pro.cds ? `\n数据模型与服务定义用 CDS 建模（\`db/schema.cds\`、\`srv/<名>-service.cds\`），实体必须带 \`key\`。\n` : '';
  return `
## 源码目录结构（规约）

一个 Epic = 一个开发模块；模块源码按层归档，目录与单元测试镜像：

| 层目录 | 职责 |
|---|---|
| \`src/core/\` | 领域模型与纯函数工具 |
| \`src/domain/\` | 业务规则与状态流转 |
| \`src/service/\` | 用例编排 |
| \`src/api/\` | 接口适配与 DTO |

源码落在 \`${dirEx}/\`（示例），测试落在 \`${testEx}\`。${cdsLine}
\`\`\`json
{"stack":"${STACK_LABEL[pro.id]}","layers":[{"dir":"core","responsibility":"领域模型与纯函数工具"},{"dir":"domain","responsibility":"业务规则与状态流转"},{"dir":"service","responsibility":"用例编排"},{"dir":"api","responsibility":"接口适配与 DTO"}]}
\`\`\`
`;
};

export function planWbs(project) {
  const ls = (project.arch && project.arch.layers && project.arch.layers.length) ? project.arch.layers : DEFAULT_LAYERS;
  const epics = ['基础工具', '数据模型', '核心业务', '接口层', '质量与交付'].map((name, i) => ({
    id: `E${i + 1}`, name, layer: ls[i % ls.length], goal: `${name}：提供可被单元测试覆盖的纯函数模块`,
    tasks: ['实现主函数', '补充边界处理'].map((t, j) => ({
      id: `E${i + 1}-T${j + 1}`, name: `${name} ${t}`,
      files: `src/${ls[i % ls.length]}/<业务名>.mjs`, acceptance: `任务「${name} ${t}」对应的单元测试全部通过`, status: 'todo',
    })),
  }));
  return { epics, task_count: epics.reduce((a, e) => a + e.tasks.length, 0), layers: ls, generated_at: new Date().toISOString() };
}

/* ---------- 模块代码（真实可运行的 ESM + 真单测） ---------- */

const SRC = `/** 离线通道生成的模板模块：纯函数、零依赖、可单测。 */
export function slugify(input) {
  return String(input).trim().toLowerCase().replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
}

export function clamp(n, min, max) {
  const v = Number(n);
  if (Number.isNaN(v)) throw new TypeError('n must be a number');
  return Math.min(Math.max(v, min), max);
}

export function summarize(list) {
  const arr = Array.isArray(list) ? list : [];
  return { count: arr.length, first: arr.length ? arr[0] : null, last: arr.length ? arr[arr.length - 1] : null };
}

export function groupBy(list, keyFn) {
  return (Array.isArray(list) ? list : []).reduce((acc, item) => {
    const k = String(keyFn(item));
    (acc[k] ||= []).push(item);
    return acc;
  }, {});
}
`;

const TEST = (dir, moduleName, srcFile = 'core.mjs') => `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, clamp, summarize, groupBy } from '../../${dir}/${srcFile}';

// 模块：${moduleName}

test('slugify 归一化并折叠分隔符', () => {
  assert.equal(slugify('  Hello World  '), 'hello-world');
  assert.equal(slugify('A__B  C'), 'a-b-c');
});

test('clamp 在区间内取原值、越界取边界', () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-3, 0, 8), 0);
  assert.equal(clamp(99, 0, 8), 8);
});

test('clamp 对非数字抛 TypeError', () => {
  assert.throws(() => clamp('abc', 0, 1), TypeError);
});

test('summarize 返回首尾与总数', () => {
  assert.deepEqual(summarize(['a', 'b', 'c']), { count: 3, first: 'a', last: 'c' });
  assert.deepEqual(summarize([]), { count: 0, first: null, last: null });
});

test('groupBy 按键聚合', () => {
  const r = groupBy([1, 2, 3, 4], (n) => (n % 2 === 0 ? 'even' : 'odd'));
  assert.deepEqual(r, { odd: [1, 3], even: [2, 4] });
});

test('groupBy 对非数组返回空对象', () => {
  assert.deepEqual(groupBy(null, String), {});
});
`;

const JAVA_SRC = (name, cls) => `import java.util.ArrayList;
import java.util.List;

/** 离线模板模块：${name} */
public class ${cls} {
  public static int clamp(int v, int lo, int hi) {
    if (lo > hi) throw new IllegalArgumentException("lo > hi");
    return v < lo ? lo : (v > hi ? hi : v);
  }

  public static List<Integer> evens(List<Integer> xs) {
    List<Integer> out = new ArrayList<>();
    for (int x : xs) if (x % 2 == 0) out.add(x);
    return out;
  }
}
`;

const JAVA_TEST = (name, cls) => `import java.util.Arrays;

// 模块：${name}
public class ${cls}Test {
  static int pass = 0, fail = 0;
  static void check(String name, boolean ok) { if (ok) pass++; else { fail++; System.out.println("not ok - " + name); } }

  public static void main(String[] args) {
    check("clamp 区间内取原值", ${cls}.clamp(5, 1, 10) == 5);
    check("clamp 低于下界取下界", ${cls}.clamp(-3, 0, 8) == 0);
    check("clamp 高于上界取上界", ${cls}.clamp(99, 0, 8) == 8);
    check("evens 只留偶数", ${cls}.evens(Arrays.asList(1, 2, 3, 4)).equals(Arrays.asList(2, 4)));
    System.out.println("tests " + (pass + fail));
    System.out.println("pass " + pass);
    System.out.println("fail " + fail);
    System.exit(fail == 0 ? 0 : 1);
  }
}
`;

const PY_SRC = (n, name) => `"""离线模板模块：${name}"""


def clamp(v, lo, hi):
    if lo > hi:
        raise ValueError("lo > hi")
    return lo if v < lo else (hi if v > hi else v)


def evens(xs):
    return [x for x in xs if x % 2 == 0]
`;

const PY_TEST = (name, dir, pyName = 'core') => `import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '${dir}'))
from ${pyName} import clamp, evens


class TestCore(unittest.TestCase):
    # 模块：${name}
    def test_clamp(self):
        self.assertEqual(clamp(5, 1, 10), 5)
        self.assertEqual(clamp(-3, 0, 8), 0)
        self.assertEqual(clamp(99, 0, 8), 8)

    def test_clamp_lo_gt_hi(self):
        with self.assertRaises(ValueError):
            clamp(1, 5, 0)

    def test_evens(self):
        self.assertEqual(evens([1, 2, 3, 4]), [2, 4])


if __name__ == '__main__':
    unittest.main()
`;

/** SAP CAP 的 CDS 数据模型（离线模板也是真实文件 + 结构性校验；没有 cds-dk 不假装编译）。 */
export const CDS_SCHEMA = `namespace order.manage;

entity Orders {
  key ID        : UUID;
  orderNo       : String(20);
  amount        : Decimal(15, 2);
  status        : String(10);
  createdAt     : Timestamp;
}
`;

export const CDS_SERVICE = `namespace order.manage;

using { Orders } from '../db/schema';

service OrderService {
  entity Orders as projection on order.manage.Orders;
}
`;

export function moduleCode(project, mod) {
  // 目录由 harness 按架构规约算好（mod.dir / mod.test_path_planned），这里只照写。
  const profile = profileOf((project.arch && project.arch.stack) || project.tech || '');
  const layer = mod.layer || 'core';
  const dir = mod.dir || profile.modDir(layer);                       // 层目录（没有模块子目录）
  const srcFile = srcFileOf(profile, mod.name);                        // 业务文件名（不带 WBS 号）
  const cls = srcFile.replace(/\.[a-z]+$/, '');                        // Java 类名 = 文件名
  const testPath = mod.test_path_planned || profile.testPath(layer, testFileOf(profile, mod.name));
  const cds = profile.cds ? [
    { path: 'db/schema.cds', content: CDS_SCHEMA },
    { path: 'srv/order-service.cds', content: CDS_SERVICE },
  ] : [];
  if (profile.id === 'java' || profile.id === 'cap-java') return {
    summary: `离线模板模块（Java · ${mod.name}）`,
    files: [{ path: `${dir}/${srcFile}`, content: JAVA_SRC(mod.name, cls) }, ...cds],
    test: { path: testPath, content: JAVA_TEST(mod.name, cls) },
  };
  if (profile.id === 'python') return {
    summary: `离线模板模块（Python · ${mod.name}）`,
    files: [{ path: `${dir}/${srcFile}`, content: PY_SRC(n, mod.name) }, ...cds],
    test: { path: testPath, content: PY_TEST(mod.name, dir, cls) },
  };
  return {
    summary: `离线模板模块（${mod.name}）`,
    files: [{ path: `${dir}/${srcFile}`, content: SRC }, ...cds],
    test: { path: testPath, content: TEST(dir, mod.name, srcFile) },
  };
}
