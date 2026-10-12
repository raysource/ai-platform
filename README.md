# AI Dev Platform · 软件开发可视化平台

把「AI 驱动软件开发」做成**真的能跑**的平台：项目入口 → 真实模型产出交付物 → 人工批准才进入下一阶段 → WBS 分解 → **真实生成代码 + 真实执行单元测试** → 人工批准才进入下一模块 → 集成测试 → 部署 → 运维。全过程在界面上实时可见。

不是演示数据：交付物由真实大模型生成，模块代码真实落盘，**单元测试按技术栈用真工具链执行**（Node → `node --test`；Java → `javac` 编译 + `java` 跑测试类；Python → `python3` + 标准库 `unittest`；SAP CAP 另产 `db/schema.cds`/`srv/*.cds` 并做结构性校验），门禁读的是真实退出码。

零依赖（Node 标准库），`node server.mjs` 即跑。界面沿用 `~/Desktop/work/pm/design` 的设计系统（仪器灰 + 单一琥珀 + IBM Plex，暗/亮主题、密度切换）。

## 运行

```bash
cd ~/Desktop/work/pm/ai-platform
node server.mjs                 # → http://127.0.0.1:8788
```

装环境 / 写配置 / 启停 / 体检 / 验收有命令行入口：`bash setup/install.sh <check|install|configure|verify|start|status|stop|selftest>`，
说明见 `setup/README.md`（含前置要求表、环境变量表、配置优先级、多实例与锁文件、常见问题）。

模型 Key 取值顺序：`AI_PLATFORM_API_KEY` → `DEEPSEEK_API_KEY` → `~/.hermes/.env` 里的 `DEEPSEEK_API_KEY`。
**没有 Key 时不会假装成功**：阶段会明确失败并提示未配置 Key。要跑离线模板通道，显式设置 `AI_PLATFORM_PROVIDER=sim`（顶栏会标出「离线模板通道」）。

| 环境变量 | 说明 |
|---|---|
| `AI_PLATFORM_PORT` / `AI_PLATFORM_HOST` | 监听地址，默认 8788 / 127.0.0.1 |
| `AI_PLATFORM_PROVIDER` | `live`（默认，调真实模型）/ `sim`（离线模板） |
| 单次输出上限 | 平台自己给的 `max_tokens` 上限 **65536**（不是模型的上限）：正常调用用各阶段的预算，一旦 `finish_reason=length` 就用 65536 重试一次，两次都截断才判失败。实测本通道 `max_tokens=40000` 能一路吐到 `stop`（27k tokens） |
| `AI_PLATFORM_API_KEY` / `AI_PLATFORM_BASE_URL` / `AI_PLATFORM_MODEL` | 模型通道，默认 DeepSeek `deepseek-v4-flash`；`AI_PLATFORM_MODEL` 是**缺省模型**，可被项目里逐阶段定义覆盖 |
| `AI_PLATFORM_DATA` | 状态文件，默认 `data/projects.json` |
| `AI_PLATFORM_WORKSPACE` | 生成代码的工作区，默认 `workspace/` |
| `AI_PLATFORM_CONCURRENCY` | **开发阶段并行度**（同时几个 Dev Agent 写代码），默认 3，范围 1–8；`1` = 串行且要求前序模块先批准 |
| `AI_PLATFORM_SPEED` | 步骤节奏倍数，`0` = 不等（测试用） |

## 核心模型

```
项目入口（名称 / 概要 / 技术栈 / 执行模式）
        │
        ▼
① 需求分析 ──▶ 真实模型产出交付物 ──▶ ⏸ 人工门禁 ✓/✕
② UI/UX 设计 ─▶ 真实模型产出交付物 ──▶ ⏸ 人工门禁
③ 架构设计 ──▶ 真实模型产出交付物 ──▶ ⏸ 人工门禁
④ WBS 分解 ──▶ 真实模型拆出 Epic/Task ─▶ ⏸ 人工门禁
⑤ 模块开发 ──▶ Dev-Agent-1..N 并行领取模块
                每个模块：模型写代码 → 落盘 → 按技术栈真跑测试（Node/Java/Python） → ⏸ 各自人工批准
                全部模块批准后阶段闭合（批准不要求顺序）
⑥ 集成测试 ──▶ 在工作区真跑全套用例 ──▶ ⏸ 人工门禁
⑦ 部署 ─────▶ 真跑语法检查 + 冒烟 ────▶ ⏸ 人工门禁
⑧ 运维 ─────▶ 真实模型产出方案 ──────▶ ⏸ 人工门禁
```


**门禁是服务端强制的**（不是界面装饰）：

- 前序阶段未批准时执行后续阶段 → `409 前置阶段「X」未批准`
- 阶段/模块不在「待审核」状态 → 批准/驳回均 `409`
- 模块**真实**单元测试缺失、`FAIL>0` 或退出码非 0 → 批准 `409`，按钮置灰
- 前序模块未批准 → 后一模块不可开发
- 驳回必须带原因分类 + 说明，**反馈喂回模型**重做（`attempts+1`）后再次送审

**执行模式**：`human_gate`（默认，每步等人批准）/ `auto`（门禁自动放行，用于演示完整流水线）。

**工作流（harness 变体，按客户的项目需求选）**：新建项目时选一条工作流，它决定这个项目**走哪些阶段**（阶段越多交付越完整、耗时与费用也越高）。预设 8 条（`harness.mjs` 的 `WORKFLOWS`，加一条就往表里加一行）：

| id | 名称 | 阶段 |
|---|---|---|
| `full` | 标准全流程（默认） | 需求 → UX → 架构 → WBS → 开发 → 测试 → 部署 → 运维 |
| `lean` | 精简交付 | 需求 → 架构 → WBS → 开发 → 测试（后端/接口类项目，不做 UX·部署·运维） |
| `prototype` | 原型验证 | 需求 → UX → WBS → 开发（先跑起来看效果） |
| `change` | 变更 / 维护 | 需求 → WBS → 开发 → 测试 → 部署（改存量系统） |
| `design` | 方案设计 | 需求 → UX → 架构 → WBS（只出方案与计划，不写码） |
| `website` | 网站 / 静态站 | 需求 → UX → 架构 → WBS → 开发 → 测试 → 部署（内容型站点，不做运维） |
| `service` | 后端服务 / API | 需求 → 架构 → WBS → 开发 → 测试 → 部署 → 运维（没有界面，跳过 UX） |
| `data` | 数据处理 / 迁移 | 需求 → 架构 → WBS → 开发 → 测试 → 部署（批处理/迁移/报表，跳过 UX·运维） |

- **一条工作流 = 阶段 id 的有序子集**；约束是「id 必须来自 `STAGES`」+「带 development 必带 wbs」（模块由 WBS 计划出来）。`checkWorkflows()` 做这个自检，单测会调它。
- 项目数据自带 `workflow` 字段，**老项目没有这个字段 = 标准全流程**（不用迁移）；未知 id 也回落全流程，不会建成空流水线。
- 不在工作流里的阶段：`POST …/stages/<id>/run` 直接 `404 阶段不存在`，不会偷偷跑起来。
- **产物落盘序号跟项目自己的工作流走**（`docDirOf(ownerId, p)`）：精简流程没有 UX，架构产物就是 `docs/02-架构设计/`。界面上的阶段序号同理（`stageNo` 用 `p.stages` 下标）。

**软件分类（选完自动带出上面那条默认流程）**：新建项目表单的第一项是**软件分类**——它表达「这是个什么东西」，并带出它的默认流程；**技术栈输入框就排在分类下面**（选完分类，它的 placeholder 立刻换成该分类的示例），下面的工作流下拉**仍可就地改**（显式指定的工作流优先于分类）。预设 5 类（`harness.mjs` 的 `TYPES`）：

表单顺序：**名称 → 项目概要 → 软件分类 → 技术栈 → 工作流 → 执行模式 → 输入资料**（先定「做什么、什么类型」，再定「用什么栈、走哪些阶段」）。

| 类型 id | 名称 | 默认流程 | 阶段数 | 技能包 | 目录规约（层） |
|---|---|---|---|---|---|
| `webapp` | Web 应用（前后端 + 数据库） | `full` | 8 | 8 条（通用规范 / 代码目录 / 安全底线 / 环境自举 / Node.js / Spring Boot / 分层契约 / 覆盖矩阵） | `core / domain / service / api / ui` |
| `website` | 网站 / 静态站（内容型） | `website` | 7 | 8 条（… / 静态网站 / React+Vite / 信息架构 / 发布回滚） | `core / content / ui / app` |
| `service` | 后端服务 / API（无界面） | `service` | 7 | 9 条（… / Spring Boot / Node.js / Python / 数据一致性 / 监控运维） | `core / domain / api / repo` |
| `cli` | 工具 / 脚本（命令行） | `lean` | 5 | 7 条（… / Node.js / Python / 评审清单） | `core / cli / io` |
| `data` | 数据处理 / 迁移 / 报表 | `data` | 6 | 8 条（… / Python / Node.js / 数据一致性 / 性能与安全测试） | `core / io / transform / report` |

**每个分类 = 一套「流程 + 技能包 + 目录规约」的通用配置**（都在 `harness.mjs` 的 `TYPES` 里，一个分类一行）：

- **流程**：分类带出默认工作流（上表；工作流下拉仍可就地改，显式工作流优先）。
- **技能包**（`TYPES[].skills`，指向 `skills/*.md` 的预设技能）：技能页有一键按钮「⬇ 分类技能包（N）」（`data-type-import` → 复用 `POST …/skills/import`），点了就把该分类适用的技能**导进这个项目**（幂等）。仍是「显式导入才生效」——预设库只是模板，导入后在项目里可改可删，调用时以项目自己那份为准（与「项目技能库优先」的规则一致）。
- **目录规约**（`TYPES[].layers`）：新建项目就带上，**自动生效**（`p.arch.from = 'type-default'`）——架构阶段提示词里给出的就是这套层清单，模块源码直接落在 `src/<层>/`；架构阶段若在 ARC-01 里声明了合法层清单则**以它为准**（`from: 'ARC-01'`）。**点 ♻ 重新构建、或在编辑里换了分类/流程，目录规约都会回到分类自带的那套**（不再是「清空」）。
- 分类自检 `checkTypes()`：id 唯一、流程存在、技术栈建议 2–4 条、**技能都在预设库里**、层清单 ≥1 且不重复、层名合法（小写字母/数字/连字符）——单测会调。
- 新分类自检还会跟着跑：`/api/state` 把 `types`（含 skills / layers / techs）发给界面，所以「新建项目」提示行会写出 `分类技能包 N 条（技能页可一键导入）· 目录规约 a / b / c`。

- 软件分类落在 `project.type`：**老项目没有这个字段 = 不显示分类**（界面不报错、数据零迁移）；`typeOf()` 未知/空分类回落第一项（Web 应用），`checkTypes()` 自检「id 唯一 + 指向的流程存在」（单测会调）。
- 软件分类带**技术栈建议**（`TYPES[].techs`，每类 2–4 条）：选完分类，紧挨它下面的技术栈输入框① placeholder 换成头号建议，② 挂上原生 `<datalist>`（点/写输入框就出下拉）——**建议跟着分类换**，也可以自己写。建议**只给平台真能跑的运行时**（Node / Java / Python / SAP CAP），不推荐跑不了的栈。
- **技术栈仍然是「用户输入优先」**：会按它判语言档案（`profileOf`，见上文语言档案表）决定产出什么、用什么命令真跑测试；分类的建议只是打字时的候选，不自动填值（避免用户没注意就带着示例提交）。选完分类提示行立刻显示该分类的默认流程（例：网站 / 静态站 → 需求分析 → UI/UX → 架构 → WBS → 模块开发 → 集成测试 → 部署，不做运维），建出来的项目阶段就是这条流程。
- **软件分类与工作流创建后都不可改**（改它等于重排阶段、孤儿产物）——「✎ 编辑」的提示里写明了。
- 验证：单测「项目类型：每个类型带出自己的默认流程…」（阶段 = 流程 / 显式工作流优先 / 未知分类回落 / 老客户端不传分类照常建 / 每类 2–4 条建议且不重复、无首尾空格 / 网站分类头号建议判成 node 档案）+ e2e `[2g]`（建 3 个项目：7 阶段、5 阶段、显式工作流 4 阶段，分类与建议落库、事件带分类）+ UI 检查 `[8.25]`（12 条：分类下拉 / **技术栈就排在分类下面**（断言 DOM 顺序）/ 标签是「软件分类」/ 默认分类 3 条建议 / 挂上 datalist / 选分类→工作流自动切 / 提示行排出流程 / placeholder 换头号建议 / **建议跟着分类换** / 从建议选一条能填进技术栈 / 建出来真 7 阶段 / 卡片标出分类），截图 `out/61-proj-type.png`。
- 界面：新建表单「工作流」下拉（选项里直接排出阶段序列）、项目卡与总览的流程徽标、侧栏「流程与门禁」角标 = 该项目阶段数。
- 验证：单测「按客户需求选工作流…」（预设自检 / 精简与原型序列 / 未知值回落 / doc 序号 / 非工作流阶段 404）+ UI 检查 `[8.22]`（精简项目流水线 5 节点、角标 5、表单选「方案设计」真落库 4 阶段、项目卡标出工作流）。

## 真实执行（不是数字游戏）

- 模型返回代码后，`exec.mjs` 把文件写进 `workspace/<项目ID>/`（路径做白名单校验，拒绝 `..`/绝对路径）。
- 随即在工作区按**语言档案**真实执行：Node → `node --test <测试文件>`；Java → `javac -d .build *.java && java -cp .build <测试类>`；Python → `python3 <测试文件>`（stdlib unittest）。解析真实输出得到 `tests/pass/fail/exit_code/耗时`，原始输出一并存进产物。工具链缺失（没 JDK / 没 python3）时模块**明确失败并说明缺什么**，不会偷偷退回 Node。
- 集成测试/部署阶段同样真跑，产出「集成测试报告（真实执行）」「构建校验报告」。
- 只测纯函数不测不确定行为；测试没真正跑起来（零输出）会被判为失败，不会出现「假绿」。

## 语言档案（技术栈决定产出什么、怎么跑）

`exec.mjs` 的 `profileOf(tech)` 从 `arch.stack`（架构阶段声明）→ `project.tech` 里判语言，判不出回落 Node：

| 档案 | 判定关键词 | 源码 / 测试路径 | 真跑命令 |
|---|---|---|---|
| `node` | 默认 | `src/<层>/order-service.mjs`、`test/<层>/order-service.test.mjs` | `node --test <测试文件>` |
| `java` | java / spring / struts / kotlin / quarkus（**`java(?!script)`：`JavaScript / JS / 静态站` 不算 Java**） | `src/main/java/<层>/OrderService.java`（文件名 = public 类名）、`src/test/java/<层>/OrderServiceTest.java` | `javac -d .build <所有 .java>` → `java -cp .build <测试类>` |
| `cap-java` | SAP CAP / CAP / RAP / CDS + java（同样用 `java(?!script)`） | 同 java，另 `db/schema.cds`、`srv/<名>-service.cds` | 同 java + CDS 结构性校验 |
| `cap-node` | SAP CAP + node | 同 node，另 CDS | `node --test` + CDS 结构性校验 |
| `python` | python / django / flask / fastapi | `src/<层>/order_service.py`、`test/<层>/order_service.test.py` | `python3 <测试文件>`（stdlib unittest） |

- **Java 测试类约定**（写进提示词，模型照做）：`public class M<NN>Test` + `main`，用 `check(name, ok)` 累计 `pass/fail`，结束时打印 `tests N` / `pass N` / `fail N` 三行并以 `System.exit(fail==0?0:1)` 退出 —— 平台就是靠这个退出码与三行统计做门禁。
- **CDS 不是编译器**：本机没装 `@sap/cds-dk` 时只做结构性校验（花括号配对 / 有 `namespace|entity` / 每个实体有 `key`），报告里写明「这不是 `cds compile` 的结果」；装了 cds-dk 才谈真编译。
- **工具链发现**：`JAVA_HOME` → `PATH` → Homebrew keg（`/opt/homebrew/opt/openjdk@21|27/bin`，keg-only 不在 PATH 里）；找到的 `javac` 会先真跑一次 `javac -version` 验证（macOS 的 `/usr/bin/javac` 是「没装 JDK」的桩，光看可执行位会被骗）。Python 用 `python3`。
- **缺工具链 → 自己装**（预设技能 `env-bootstrap` 的落地）：探不到 JDK / python3 时，`exec.mjs` 的 `ensureToolchain()` 先用系统包管理器装一次（`brew install openjdk@21` / `python@3.12`，超时 15 分钟）再重探；装上了就照常真跑。**装不上才失败**，且失败原因里写明「试过哪条命令、退出码多少」，绝不静默改用 Node 跑、也不假装装过。关掉自举：`AI_PLATFORM_NO_INSTALL=1`；自定义安装通道：`AI_PLATFORM_INSTALL_CMD='<整条命令>'`（走 `sh -c`）。
- **Java 编译域 = 本模块**：模块级执行只编 `mod.files`（本模块自己的 `.java` + 本模块的测试），**集成/部署阶段**（`runWorkspaceTests`）才编全工作区。原因：没有 package、全工作区共用一个 classpath，两个层各写一个同名类（`Order` / `ApiResponse`）就是「クラスOrderが重複しています」，一个层的问题会让**每个**模块全红（实测：一个 CAP 项目 6 个模块全 rc=1，按模块编各自 0 错误、287 条断言全绿）。命令串里写明范围：`<N 个 .java · 本模块>` / `<N 个 .java · 全工作区>`。验证：`test/exec.test.mjs` 的「Java 模块级执行只编本模块」（同名类：本模块范围真跑通、全工作区范围必须报重名）。提示词同步：`agent.mjs` 的 Java 语言规约第 2 条改为**类名全局唯一**（同一实体只在一个层定义，别的层复用或换具体名），`test/agent.test.mjs` 盯着这条。
- **门禁报错分档**：`缺少单元测试记录` 只在真的没有记录时出现；有记录但没跑出结果（编译没过、缺工具链）时报 `单元测试未通过（编译失败 / 测试没产出结果 …，退出码 N）`——原来一律报「缺少记录」，把人引到错方向。验证：`test/harness.test.mjs` 的「模块未完成单元测试不能批准」。
- 集成测试与部署阶段用 `runWorkspaceTests()`：工作区里有哪些语言的产物就都真跑一遍（Java 编译全部 `.java` 后在同一个 classpath 里依次跑各测试类；Python 逐个文件；Node 跑 `test/`）。
- **老项目迁移**：`node tools/migrate_stack.mjs`（`--apply` 落库、`--clean` 清掉与新档案不符的旧源码）把「技术方案写 Java、产物却是 .mjs」的项目重算模块目录并退回待开发，已批准阶段与文档产物保留。

## 显示规约：流程名与产物名（界面统一口径）

- **流程名（阶段）**：一律「两位序号 + 名称」，序号跟流水线顺序（`01 需求分析` … `08 运维`）；名称按界面语言显示（中文 / English / 日本語，词条是 `public/i18n.mjs` 的 `stage.<阶段id>`；服务端只存中文名，翻译在渲染时做，缺词条回落原名）。出现位置：流水线节点、阶段详情标题、门禁提示、项目卡与 KPI 的「当前阶段」、产物归属列、技能页的「适用阶段」。
- **产物名**：显示成 `序号-流程点名-生成的名字`（例：`01-需求分析-需求规格说明书`、`05-模块开发-基础框架 · 代码与单测`）。序号与流程点名跟着流水线与语言走；**生成的名字本身是模型产出的领域内容，不翻译、不改写**。
- **流水线节点（`pipe()`）**：8 个阶段点在**一条行内等分撑满界面宽度**（`flex: 1 1 0` + `min-width: 96px`，窄屏 84px；放不下才在卡片内横向滚动），节点内容居中；每个节点在序号与名称之间**居中显示一个内联线性 SVG 图标**（`public/app.js` 的 `STAGE_ICO`，`stroke: currentColor`，选中态跟 `--accent`）—— 零依赖、不用 emoji 或图标字体，加阶段只改这一处。总览与流程与门禁共用 `pipe()`，改一处两处都变。**右上角另有一枚「谁在执行」的机器人图标**（`STAGE_ROBOT` + `stageBadge()`，20px，贴 top:5/right:6）：每个阶段一只**不同的机器人**、各自**真彩色**（需求蓝 / UX 紫 / 架构青 / WBS 琥珀 / 开发绿 / 测试红 / 部署靛蓝 / 运维青绿），差异用头型（方/圆）、天线（单/双/圆环/三叉/耳）、眼型（双点/三点/方眼/眼罩/独眼/脉搏）、手臂表达，`title` 写「<Agent 名> 执行」；同样是内联 SVG、零依赖，加阶段在 `STAGE_ROBOT` 加一条。验证：UI 检查 `[8.19]`（8 节点等宽、右端余量 0、中间图标 28px 居中）另加 4 条机器人断言（20px / 8 种图形 / 8 种颜色 / 贴右上角 + title），截图 `out/57-flow-rail.png`。
- **WBS 顶部页签（任务树 / 模块开发）**：图标在上、文字在下（`.tab:has(.tico) { flex-direction: column }`，图标复用流程点那套 `ICO()` —— 任务树=层级树、模块开发=代码括号），两枚页签**等宽**且文字不折行（`.tabs-eq { display: grid; grid-template-columns: 1fr 1fr; width: max-content }`；**`width: max-content` 是关键**——只写 `1fr 1fr` 时容器宽度不定，fr 会退回按各自内容定宽，实测 59px ≠ 70px。CDP 现场试了 7 种写法只有这一种等宽）。验证：UI 检查 `[8.10]`（15px 图标在上、70px = 70px、`white-space: nowrap`、溢出 0）；zh/en/ja 三语实测等宽（70 / 135 / 105）。
- **模块开发页签两栏 4:6**：`devSection` 的网格带 `g-dev`（`.g-dev { grid-template-columns: 4fr 6fr }`，基础规则与 ≤1560 媒体查询里各写一遍——同特异性下后出现的赢），左「模块开发」4 : 右「模块详情」6。验证：UI 检查 `[8.10]`（568 / 852 = 0.400）。
- **界面标题图标**：每个界面的 `h1` 前一枚线性图标（`public/app.js` 的 `VIEW_ICO` + `viewTitle(id, text)`，复用同一套 `ICO()`），18px、`--muted`、与标题同一行（`.page-head h1 { display:flex; gap:8px }`）—— 加界面只改 `VIEW_ICO` 一处；无项目时的「项目入口」页同样有图标。验证：UI 检查 `[8.21]`（8 个界面标题 18px 且 `h1` 首位是 `.tico`）。
- **左侧菜单图标**：每项 = `图标 / 序号 / 菜单名 / 角标`——图标**在序号前面**（`paintNavIcons()` 入口调一次，幂等；同一枚 `VIEW_ICO`），15px、`--muted`、当前页转 `--accent`；`.navbtn` 网格 `16px 22px 1fr auto`。图标塞在 `.ic`（序号）外面而不是里面：换语言时 `[data-i18n]` 会 `textContent =` 覆盖子节点，塞进标签里会被冲掉。序号保留（数字键 1–7 的快捷键提示就是它）。验证：UI 检查 `[8.7]`（8 项都有 15px 图标 + `compareDocumentPosition` 证明在序号前面；数字键断言不变）。
- **执行记录的事件流**：时间戳列 140px + `white-space: nowrap`（`.steps-time .s`，`2026-10-11 17:44:02` 一整行不折行；文件清单那两处 `.steps-mini` 不受影响）。验证：UI 检查 `[8.27]`（列宽 140px、行数 1、`nowrap`）。
- **页头备注一行显示**：`.page-head p`（「流程与门禁」等页标题下那行灰字说明）**不设 `max-width`** —— 中文备注在常规窗口宽度下一行放得下就别折成两行（原来 `78ch` 的帽会把 CJK 折成两行）；窄屏仍由容器宽度自然折行，靠 `overflow-wrap: anywhere` 兜长词。验证：UI 检查 `[8.20]`（1680 下 55 字 1 行、备注与页面都不横向溢出）。
- 这套前缀只影响**显示**：产物 id（`REQ-01`/`US-01`/…）、阶段 id、落盘文件名一律不动 —— 别把展示口径写进数据或提示词，否则回读时会对不上。
- **产物落盘目录**（写进规则）：`docs/<两位流程序号>-<流程名>/<产物ID>.md`，例 `docs/01-需求分析/REQ-01.md`、`docs/03-架构设计/ARC-01.md`、`docs/07-部署/DPL-02.md`；模块类产物（`M1-CODE`…）归到 `docs/05-模块开发/`。目录名用**服务端阶段名**（中文）而不是界面语言名 —— 磁盘路径不能跟着界面语言变；名字里的 `/` 折成 `-`（`02-UI-UX 设计`）。规则在 `harness.mjs` 的 `docDirOf()`/`docPathOf()`，人工编辑产物重写文件走同一条路径。
- **内容区没内容就留空**（写进规则）：源码页与产物页「文件」页签的中间内容区（`codeBrowser()` 的 `mid`）只在**选中了文件**时渲染 `<pre>`/编辑框；新建项目、工作区被清空、或文件读不到时一律渲染**空**（不显示任何提示文案）。空态说明只放在**左侧列表**（`code.emptyList` / `code.emptyWs`）与页头，右侧内容区保持干净。

## 源码目录结构规约（架构阶段定，模块阶段照放）

模块源码不是各写各的，落位由**架构阶段的 ARC-01** 与**平台**共同决定：

```
docs/architecture/ARC-01.md   架构设计说明书 —— 含「源码目录结构」一节 + 一个 json 代码块声明层清单
        │  平台从 ARC-01 里解析出层清单（解析不到 → 平台默认 core/domain/service/api，事件流里写明来源）
        ▼
src/<层>/order-service.mjs         一个 Epic = 一个模块 = 一组业务命名的文件，**直接放在层目录里**
test/<层>/order-service.test.mjs   单元测试与源码同业务名、镜像到测试目录（相对导入 ../../src/<层>/…）
```

- WBS 阶段每个 Epic 必须带 `layer`（只能取 ARC-01 声明的层，非法就按序回落），模块对象上直接存 `layer / slug / dir / test_path_planned`。
- **真实模型通道与离线通道都只读这几个字段**，不再各自拼路径——换布局只改一处。
- 模型没按规约落位时不拦流水线，但在事件流里推一条 ⚠（哪个模块、几个文件、哪些路径），偏差看得见。

## 多 Agent 并行开发

开发阶段不是排队做模块，而是 **N 个 Dev Agent 并行领取**（默认 3，`AI_PLATFORM_CONCURRENCY` 可调）：

- `kick()` 按空闲槽位一次性补满：`slots = 并发数 - 正在跑的模块数`，同步领取（状态机自己就是锁——`runModule` 在第一个 `await` 之前就把模块置为 `running`，所以不会重复领取）。
- 每个 Agent 独立完成：模型写代码 → 落盘 → 真跑 `node --test` → 停下等**各自**的人工批准；批准一个就释放一个槽位，立刻领下一个模块。
- 批准**不要求顺序**（并行开发下 M4 可能先于 M1 完成）；开发阶段只在**全部模块批准**后闭合。
- 事件流与界面都标出「谁在做哪个模块」：`▶ Dev-Agent-2 领取模块 M4「借阅核心流程」`。
- 并发=1 时退回旧的串行语义（并要求前序模块先批准），用于需要严格顺序的场景。
- **单测没过 = 模块失败（不是「等待批准」）**：门禁要求 `PASS>0 & FAIL=0 & 退出码 0`，达不到就置为 `failed` 并记下真实失败用例，由重排循环自动重试（**≤3 轮**，只看 `attempts`）；重试时把**上一轮的真实测试输出**（末尾 1200 字符）喂回模型 —— 只喂人工驳回意见的话模型只能盲目重生成。3 轮用尽就停在 `failed`，界面写明「需人工处理（可看真实输出，或驳回该模块重跑）」，驳回=人给的第 4 次机会。
- **瞬时故障不吃重试预算**：模型空响应 / 超时 / 429 / 5xx / 连接重置（`isTransientModelError()`）原地重排且 `attempts` 回退（最多 2 次），否则一次网络抖动就吃掉 1/3 的额度。
- **测试有硬超时**：单条测试命令默认 120s（`AI_PLATFORM_TEST_TIMEOUT_MS`），到点**杀整个进程组**并如实报「测试超时」——`node --test` 会把测试文件当子进程跑，只杀父进程时孙进程还攥着管道，`close` 永不触发，整条流水线会卡死在这儿（实测踩过：20 分钟不动）。超时也不算通过。
- **服务单实例**：`data/projects.json.lock` 记 PID，第二个实例启动即退出——两个 server 各持一份内存副本、各自 `flush()` 会静默把对方的进度覆盖掉（实测踩过：已批准的模块被旧快照写回失败）。

## 产物可编辑（人工可改、可保存）

「产物」页每份交付物都有 **✎ 编辑**：改完保存 → 版本 +1、落库、并**真实写入** `workspace/<项目ID>/docs/…`。左栏切到「工作区文件」可以对**真实文件**直接编辑保存（含模型生成的代码与单测）。

两条硬规则（服务端强制）：

- **已批准即锁定**：阶段/模块批准后，其产物与代码都不再可改（`409`）。否则"批准的东西"和"后来的东西"就不是同一个，门禁失去意义；要改先驳回重做。
- **改了代码必须重跑测试**：编辑 `src/mN-*` 或 `test/mN-*` 下的 `.mjs` 后，平台**自动重跑该模块的真实 `node --test`**，用新结果刷新单元测试记录。测试不过 → 状态回到「待批准」但批准被 409 拦住（按钮置灰），提示 `FAIL=n 退出码=1`。**绝不会拿改之前的测试结果去放行改之后的代码。**
- 人工改过的模块**不会**被 Agent 自动重生成（`attempts` 不变），免得你的改动被下一次生成冲掉；要交给 Agent 重做请显式驳回。

## 重新构建（清空全部成果物与历史痕迹，技能保留）

每个项目卡上都有 `♻ 重新构建` 按钮（`POST /api/projects/:id/rebuild`）。它是**把项目退回起点**的一个动作，清什么、留什么是硬规则（`harness.mjs` 的 `rebuildProject()` + `exec.mjs` 的 `clearWorkspace()`）：

- **清掉**：全部阶段产物（`stage.artifacts`）、阶段状态/轮次/审核意见（回到 `pending`，`attempts=0`）、WBS（`wbs.epics=[]`）、架构规约（`arch=null`）、全部模块（含源码/单测记录，`modules=[]`）、事件流（`events=[]`）、以及 `workspace/<id>/` 下的**生成物**（`docs/`、`src/`、`db/`、`srv/`、`.build/` …——除 `inputs/` 外的工作区顶层条目全删）。
- **保留**：技能库（`skills[]`，含用户手写与从预设库导入的）、新建时上传的输入资料（`workspace/<id>/inputs/`）、技术栈 `tech`、项目名/概要、入口模式与各阶段模型配置（`models`）。
- **记账**：清空后用一条 `kind='rebuild'` 事件说明这次清掉了多少（产物 / 模块 / 源码·测试文件 / 执行记录 / 工作区条目）与保留了多少（技能 N 条、输入资料 M 份）——所以重建后**事件流里恰好只有这一条**。
- **在飞的任务**：项目正在执行时未 `force` 会 409（与删除项目同一套口径，UI 里再确认一次强制）；强制重建后，**旧那一轮的结果不再落地**（`runStage`/`runModule` 在每个 await 之后检查「我还在不在这一轮里」——阶段 `attempts` 被归零、模块已不在 `modules[]` 都直接 return），不会把产物/文件/事件写回来。
- 技能保留指的是**项目技能库**；`skills/*.md` 预设文件本来就在仓库里，不受影响。

验证：单测「重新构建：清空全部产物与历史痕迹…技能与输入资料保留」（含 409 与「迟到的结果不落地」两条断言）、离线 e2e `[7]`（HTTP 层记账与落盘清空）、UI 检查 `[8.11]`（按钮存在 + 确认文案 + 点完阶段回未开始、技能还在）。

## 任务树（开发页签）：状态上色 + 执行中自动展开与指示灯

「WBS / 开发 → 任务树」每一行是一条 `.tnode`（网格 `18px / 92px / 1fr / auto`：箭头 · **编号列（第一列，加宽到 92px）** · 名称 · 右侧状态区）。状态**取自任务所属模块**（平台不追踪任务级进度，模块在跑＝这个 Epic 的任务正在执行）：

- 颜色：待执行/未排模块=灰、**开发中=`--run`（蓝）**、待批准=`--warn`（琥珀）、已批准=`--ok`（绿）、驳回/失败=`--fail`（红）；除右侧状态药丸外，整行左侧还有同色 2px 色条（选中行仍用强调色条，不冲突）。Epic 行给状态药丸 + 任务数；任务子行给同色小圆点 + 落地文件路径。
- **正在执行**：该 Epic **自动展开**（用户手动折叠过就听用户的：`S.epicOpen[id] ?? (st === 'running')`），并显示呼吸指示灯 —— 复用 `.pulse`（`@keyframes pulse`，`prefers-reduced-motion` 下自动停），子行圆点同动画。
- 卡片底部有一行色图例（开发中/待执行/待批准/已批准/失败），文案复用 `MSTS`，跟着语言切换。
- 验证：UI 检查 `[8.10]` 段（真跑一个模块：驳回 → 执行 → 断言自动展开 + `animationName === 'pulse'` + 蓝点 `rgb(79,157,255)` + 子行同动画 → 跑完指示灯消失、状态变「待批准」），截图 `out/55-tree-running.png`。

## 项目信息可以编辑（建完还能改）

- 界面：项目卡右下角「✎ 编辑」→ **右侧那一栏从「新建项目」换成「编辑项目」**（不是弹窗、也不在卡片里嵌表单），**条目与新建项目完全一致**：项目名称 / 项目概要 / 软件分类 / 技术栈（带该分类的建议下拉）/ 工作流 / 执行模式 / 输入资料（可多选，保存时一起上传）。保存即生效、取消不落库（右侧换回「新建项目」）；表单聚焦时 SSE 刷新只更新页脚，不会把正在填的内容换掉（`PEDIT` 记状态，重渲染不丢）。
- **软件分类与工作流在编辑里同样能选**：改了会**按新流程重排阶段 —— 能对上的阶段（同 id）保留状态与交付物，多出来的补成 pending，去掉的阶段记录移除**（`mergeStages()`，去掉的阶段在事件里列名，`workspace` 里已落盘的旧文件保留），同时架构规约（层清单）作废重算。**有阶段正在执行时拒绝改**（409「等这一步跑完再改」），避免在跑的时候动阶段表。
- API：`PUT /api/projects/:id` —— 名称 / 需求 / 技术栈 / 入口模式（可只传要改的）+ 软件分类 `type` / 工作流 `workflow`（只给 `type` 时按该分类的默认流程走）；空名字 400；超长按上限截断（名称 80 / 技术栈 200 / 需求 20000 字符）；什么没变**不写事件**（幂等）。补输入资料走 `POST /api/projects/:id/inputs`（`{files:[{name,content}]}`，同名覆盖、二进制/空文件跳过并记事件）。
- 每次真改动写一条事件：「项目信息已编辑（软件分类、工作流）… 分类 x → y、流程 a → b · 重排为「精简交付」（5 个阶段：保留 5 个已有阶段、去掉 UI/UX 设计、部署）」，改名时前后名字都留在事件流里。
- 改名不动 `workspace/<项目ID>/`（目录用的是项目 id，不是名字）。
- 验证：单测「编辑里改软件分类 / 工作流：按新流程重排阶段…」（保留/新增/去掉、运行中 409、幂等、补资料 addInputs）+ e2e `[2f]` `[2g]`（HTTP 往返 + 读回一致 + 重排 + 补资料落盘可读回 + 400）+ UI 检查 `[8.24]`（右栏换表单 / 条目与标签和新建一致 / 分类工作流可选 / 真落库 / 取消不落库）与 `[8.26]`（**编辑里换分类 → 阶段真重排**），截图 `out/60-proj-edit.png`。

## 项目卡片的固定结构（按钮统一在最下面）

一张项目卡从上到下固定五段，改卡片时按这个来：

1. **卡头**：执行模式 + 工作流徽标并排。执行模式用**图标在上、文字在下**的方块（`modeBlock(p)` + `MODE_ICO`：人工审批 = 人形，AI 自动审批 = 机器人头，复用 `ICO()` 线性 SVG，20px、配色 acc/run，`title` 给全称）；工作流徽标（`wfChip`）字号 11.5px 且**允许换行**，长流程名不再挤成一行或截断。
2. 项目名（`pname`，一行省略号 + `title` 给需求全文）
3. 进度条
4. 统计行（分类 · 项目 id · 阶段/模块/单测 · 当前阶段 · 输入资料几份）
5. **按钮行**（`.card-acts`）：`✎ 编辑` / `♻ 重新构建` / `✕ 删除` 三枚同排、`margin-top:auto` 钉在卡片最下面 —— 等高卡片底边对齐（UI 检查按 `getBoundingClientRect` 断言每张卡贴底 ≤15px、卡头里没有按钮）。

表单里两条长说明（**工作流**：通用解释 + 当前流程阶段序列；**执行模式**：两种模式各是什么意思）一律放在下拉框**下面那行** `.hint.big`（12.5px、与正文同字号、会换行），不要塞进 `<option>` 里——原生下拉框不会换行，只会被截断。

## 新建项目可上传输入资料（多选）

- 入口表单可**多选**上传文本文件（`.md/.txt/.json/.yaml/.yml/.csv/.mjs/.js/.ts/.html/.css/.sql/...`）；也可把这批文件与 `name/tech/brief/mode` 一起 `POST /api/projects`。
- 约束：每份 ≤256KB、最多 10 份；空内容与二进制（含 NUL）文件**跳过并在事件流写明原因**，不静默吞掉。
- 存储：真实落盘到 `workspace/<项目ID>/inputs/<文件名>`（`basename` 归一，拒绝路径穿越；保留 CJK 与扩展名）。
- 用途：内容**进提示词**（需求/架构/WBS：每份截取 1.8K 字符、总量上限 6K，避免顶爆上下文），并记在 `project.inputs`（含 4K 摘录 + 字节数）。
- 界面：项目卡片显示「输入 N 份」，总览页头列文件名；文件本体在「产物 → 工作区文件」里可读。
- 真实模型端到端实测：上传「逾期罚金每册每天 0.50 元 / 押金 100 元」的业务规则 → 需求交付物里确实出现了该规则（断言 `0.50|30%|押金|5 册`）。

## 源码模块（左树 / 右预览+编辑，高度自适应）

侧栏「源码」（快捷键 `5`，排在「产物」之后）是**专门浏览产出代码**的模块：左边可收起的目录树，右边预览与编辑。

- **只列产出代码**：`isSource()`（`public/tree.mjs`，纯函数）只认代码扩展名，排除 `docs/` 阶段文档、`inputs/` 资料与 `.DS_Store` 这类点文件。你的工作区常有 50 个文件、其中一半是文档——「产物 → 工作区文件」是**磁盘真相**（全列），「源码」是**交付物视图**（只列代码）。
- **带上归属信息**：选中文件后，右栏元数据给出 归属模块 / 架构层 / 代码位置 / 模块状态 / 该模块单测 `PASS/FAIL/退出码` / 测试文件路径。这是「最后产出」的关键——代码和它过没过测试一起看。
- **右栏可编辑**：未批准的模块可直接改并保存（保存后自动重跑该模块真实单测）；已批准的模块显示「已批准锁定」只读。
- 两个视图共用同一套渲染（`codeBrowser()` + `codeGrid()`），所以子目录折叠、缩进、文件大小、锁定规则完全一致。
- 细节修正：工作区列表过滤点文件（Finder 的 `.DS_Store` 不再是节点）；默认打开**第一个源码文件**而不是列表最后一个。

### 高度自适应（宽屏分栏自滚 / 窄屏整页滚）

- 宽屏（>1120px）：`.app` 固定 `100vh` → `.page` 是 flex 子项 → `.grid.g-tree` 吃满剩余高度（下限 340px），三张卡片各自 `display:flex` 列布局，**卡片体 `overflow:auto`**——目录树与源码区各自按内容出滚动条，页面本身不滚。卡片头与 footer 不参与滚动（`flex:0 0 auto`）。
- 源码预览的 `max-height` 全部撤掉（原先 `<pre>` 写死 68vh）：高度由卡片决定，`overflow` 由 CSS 决定，一处改完两个视图都受益。
- 窄屏（≤1120px）：三栏折成单栏，此时**不再按窗口切高度**（否则三张卡被挤成一坨），改为每栏限高 `58vh` 自滚、整页再滚。
- 验证（`tools/ui_tree.mjs` 的 `[5]`/`[6]`）：矮窗口 1440×520 断言「文档不滚（520≤520）+ 卡片底部 482≤520 + 两栏 `overflow:auto` + 目录树 738>305 出滚动条 + 源码区 526>265 出滚动条」；窄窗口 900×700 断言「文档不滚 + 页面区自滚 1409>658 + 单栏 + 无横向溢出 + 卡片最小 336px」。截图 `out/21-code-fit-short.png`、`out/22-code-fit-narrow.png`。
- **滚动条要看得见**：`overflow:auto` 在 macOS 上用的是覆盖式滚动条——不滚动不显示，用户看不出「还能往下翻」。`public/app.css` 统一画占位式细滚动条：`::-webkit-scrollbar`（Chromium/Safari，10px、`--line-2` 滑块、hover 变 `--accent`）+ `scrollbar-width/color`（Firefox，用 `@supports selector(::-webkit-scrollbar)` 把它在 Chromium 里让回去，否则 Chromium 会退回覆盖式反而看不见）；两栏加 `scrollbar-gutter: stable` 免抖动。UI 检查 `[7]` 断言「两栏 `offsetWidth - clientWidth ≥ 8`（滚动条真的占位＝看得见）+ 加了滚动条也不横向溢出」，截图 `out/21-code-fit-short.png`。
- **总览、流程与门禁、开发页、项目页也吃满窗口**（`g-fill`）：`.grid:is(.g-tree, .g-fill)` 这一套规则同时给「项目页（项目列表 + 新建表单）」「总览（阶段流水线 + 活动流）」「流程与门禁（阶段详情 + 阶段交付物）」「开发页签（模块开发 + 模块详情）」「任务树」用——网格吃掉页面剩余高度、每张卡各自 `overflow:auto` 自滚，页面本身不滚；活动流给到最近 **60** 条（原来 14 条，卡片变高后填不满）。**开发阶段例外**：流程页选到「开发」时模块开发区块要跟在两卡下面，所以上层网格不套 `g-fill`（整页滚），模块开发区块自己带 `g-fill` 吃剩余高度。窄屏一律折叠成单栏、每栏 `max-height:58vh` 自滚、整页再滚；只有一张卡的 fill 网格（任务树）窄屏也照常吃满（`g-fill:has(> .card:only-child)`）。验证：UI 检查 `[8.8]`~`[8.11]`（总览 / 流程 / 开发页+任务树 / 项目页），各含 1000、1400 两档高度 + 窄屏一组断言；截图 `out/29-overview-fill.png`、`out/30-dev-fill.png`、`out/32-projects-fill.png`、`out/33-wbs-tree-fill.png`。
- 高屏也要跟着长（`[7.5]`）：左栏卡片本体带 `tablewrap` 类，而 `.tablewrap` 有 `max-height:460px`——窗口再高，目录树到 460px 就封顶，卡片里留一大片空白。加一条 `.grid.g-tree > .card > .body.tablewrap { max-height:none }` 修掉（源码页与产物页共用骨架）。高窗口 1440×1200 断言「树高 983px（突破 460）+ 卡片 − 卡头 − 树 = 留白 ≤2px + 卡片高度跟窗口走」，截图 `out/24-code-fit-tall.png`。

### 编辑保存（实测链路）

UI 检查会真的走一遍「点 ✎ 编辑 → 在文本域改内容 → 点保存文件」，然后断言：

- 接口读回的文件**已含**改动，且 `workspace/<id>/<path>` 磁盘文件也含（不是只改内存）；
- 保存后**右侧预览立刻显示新内容**（早先这里有 bug：`refreshWorkspace` 只刷新文件列表，预览还停在旧文本；修法是保存后再 `openFile()` 读回一次）；
- 该模块的**真实单测被自动重跑**、记录时间戳刷新（`node --test test/…`），页面弹「已保存并重跑该模块单测：PASS=6 FAIL=0 退出码=0」；
- 模块**不会被当成已批准**（仍 `awaiting_review`）——改过的代码必须重新过门禁；
- **已批准模块锁定**：界面不再给编辑按钮、显示「模块已批准 · 已锁定」，绕过界面直接 `PUT` 也被服务端拒 `409`（`「基础工具」已批准，内容已锁定；如需修改请先驳回重做`）。

## 源码文件浏览（左树 / 右预览+编辑）

「产物 → 工作区文件」是一套**源码浏览器**：左边是可收起的**目录树**，右边是预览与编辑。

- 树是纯函数产物：`public/tree.mjs` 的 `treeRows(paths, open)` 把扁平的 `paths` 折成「行列表」（目录行带 `depth/count/open`），前端只做 `map` 成 HTML——所以它可以被 `node --test` 直接断言（`test/tree.test.mjs`，4 条：多层嵌套/CJK 不乱序、默认展开与收起、同名目录各成节点、空与重复路径）。
- 目录行显示递归文件数，点一下收起/展开（`S.wsOpen[dir] = false` 表示收起，默认全展开）；文件行显示字节数，点一下在右侧预览**真实落盘**的内容。
- 右侧：`.md` 渲染成正文，代码走 `<pre>`；未批准的模块可点「✎ 编辑」改源码并保存（保存后自动重跑该模块真实单测，见上一节）；已批准锁定只读。
- 触发加载：切到该页签会拉文件列表；深链（`?view=artifacts&arttab=files`）也会自动补拉（否则左树空着）。
- 验证：`node tools/ui_tree.mjs`（自包含：自起隔离服务 + 自起 headless Chrome）断言树结构、缩放行为、预览与接口逐字一致、编辑态可用，并断言**页面无未捕获异常**（模块加载失败会整页白屏，靠这条抓）。已并入 `run_all.sh`，截图 `out/17-workspace-tree.png`、`out/18-workspace-edit.png`。

## 动态可视化

- 服务端把执行拆成带节奏的步骤，通过 **SSE（`/api/stream`）** 推给界面；阶段脉冲、进度、事件流毫秒级刷新。
- 视图：**项目入口 / 总览 / 流程与门禁 / WBS·开发 / 产物 / 源码 / 执行记录 / 技能库**，快捷键 `1–8`（按**菜单位置**，不写死在代码里：改菜单顺序快捷键跟着走），`t` 切主题，`d` 切密度。
- 「产物」页可切到**工作区文件**，直接读模型生成并落盘的真实代码与单测。
- URL 覆盖（截图/分享）：`?view=flow&wbstab=dev&stage=wbs&project=<id>`。

## 项目预览（把工作区里的站点真跑起来）

平台自己就能当预览服务器：`GET /p/<projectId>/…` → `workspace/<projectId>/…`（`.html` 注入 `<base href="/p/<id>/">`，找不到文件回落 `index.html`；所以 `/p/<id>/course/xx` 这类深链刷新也能直接打开，页面里的相对资源 `./app.mjs`、`./src/**` 还能找到）。

- 前提：工作区里要有站点外壳 `index.html`（`website` 分类的产物只有 `src/**` 模块与单测，外壳得补一个——本仓库示例 `workspace/P-mv4potv1-sw14/index.html` + `app.mjs`，把 `content` 层数据装配成 `app` 层要的 `{courses, glossary, quizzes}` 再交给 `start()`）。
- 挂载前缀由外壳自己处理：`app.mjs` 从 `location.pathname` 认出 `/p/<id>`，渲染出来的根路径链接补上前缀（app 层产出的 `href="/course/xx"` 否则会点到平台根）。
- 验证：`node tools/preview_check.mjs <projectId>`（自起 headless Chrome/CDP，逐页轮询「内容已挂载」再断言：渲染非空 / **无未捕获异常** / 所有根路径链接带前缀，截图落 `/tmp/preview-shots/`）。别用 `chrome --dump-dom`——它在模块脚本执行完成前就会 dump，随机只拿到空壳。

## API

```
GET    /api/state                                    全部状态 + 当前模型通道
GET    /api/stream                                   SSE 实时事件
POST   /api/projects                                 创建项目（初始入口）
GET    /api/projects/:id/workspace                   工作区真实文件清单
GET    /api/projects/:id/file?path=src/x.mjs         读真实文件内容
PUT    /api/projects/:id/file                        改工作区文件（代码类自动重跑单测）
POST   /api/projects/:id/artifacts/:aid              改产物正文（已批准则 409）
DELETE /api/projects/:id                             删除项目（连 workspace 一起删；执行中 409）
POST   /api/projects/:id/models                      定义各阶段调用模型（空串=回到缺省 deepseek）
POST   /api/projects/:id/skills                      新增技能 {name, body, stage?}（stage 空=所有阶段）
PUT    /api/projects/:id/skills/:sid                 改技能（name/body/stage 都可以只传一部分）
DELETE /api/projects/:id/skills/:sid                 删技能（不存在 404）
POST   /api/projects/:id/stages/:sid/{run|approve|reject}
POST   /api/projects/:id/modules/:mid/{run|approve|reject}
```

## 各阶段调用模型（不定义 = 缺省 DeepSeek）

每个阶段可以单独指定用哪个模型；**没定义的阶段走缺省模型**（`AI_PLATFORM_MODEL`，默认 `deepseek-v4-flash`）：

- 界面：「流程与门禁」→ 点阶段节点 → 阶段详情里的「调用模型」下拉（缺省 / `deepseek-v4-flash` / `deepseek-reasoner`）。改动立即落库，作用于该阶段**下一次**调用（阶段正在跑时下拉禁用）。
- API：`POST /api/projects/:id/models`，body `{"models":{"wbs":"deepseek-reasoner"}}`；传空串即删掉该阶段定义（回到缺省）；只认流水线里的 8 个阶段 id，未知 id 与空白值忽略。新建项目时也可以直接带 `models` 字段。
- 生效范围：需求 / UI-UX / 架构 / 集成测试 / 部署 / 运维 → 该阶段每份交付物的生成；WBS → Epic/Task 拆解；模块开发 → 所有 Dev Agent 的代码与单测生成。
- 已批准阶段与已完成模块的历史记录不受影响；事件流里有一条「阶段调用模型：X 缺省 deepseek-v4-flash → 自定义 …」，每轮执行的事件里也标出当轮用的模型名。

## 技能库（每个阶段都可以有自己的 skill 文档）

侧栏「技能」= 当前项目的 skill 文档：把工程约定（禁令 / 规范 / 验收口径）写成条目，**之后每次模型调用都带上**。

- **作用域**：`stage` 留空 = 所有阶段；选了阶段 = 只有那个阶段的调用带它（例：「测试文件必须镜像到 `test/<层>/`」只在模块开发时出现）。
- **注入点**（`agent.mjs` 的 `skillsBrief(project, stageId)`）：各阶段交付物（按本阶段过滤）、WBS 拆解（`wbs`）、模块代码与单测（`development`）；一条技能都没有时不产生这段提示词。
- **优先级（平台的通用规则）**：**生成项目工作区自带的技能 > 本项目技能库 > 平台通用默认** —— 提示词片段里就是这么写的，冲突时以更靠前的为准（与本阶段硬性要求冲突时按更严的那条来）。预设技能库（`skills/<name>/SKILL.md`）只是模板，必须显式导入到这个项目才生效。
- **工作区自带技能（生成的项目里自己定义的技能）**：把技能放进**生成项目自己的工作区** `workspace/<项目id>/skills/<name>/SKILL.md`（同一套 AI Agent Skills 标准格式，目录名 = `name`，`metadata.stage` 可选），平台就会**优先**用它们：
  - **扫描时机**：每次要调模型前刷一次（阶段执行、每个模块开发）——工作区技能**以磁盘为准，不落库、不拷贝**，改文件即生效；集合变化会在事件流里记账（`本项目工作区自带 N 条技能… → 优先于项目技能库与平台预设`）。
  - **怎么算「优先」**：注入顺序排在最前 + 每条带标记「（本项目工作区自带 · 优先）」+ 片段抬头写明三级优先级 —— 预算是按顺序截断的，所以它们绝不会先被丢掉；`stage` 过滤照旧生效（`stage: deployment` 的技能只在部署阶段的调用里出现）。
  - 工作区里没有 `skills/` 时一切照旧（不产生多余提示词）。**不做**在界面里编辑它们（那是生成物本身，用源码视图/编辑器改就行）。
- **上限**：技能名 ≤60 字、正文 ≤4000 字、每项目 ≤60 条；单次注入 18000 字符封顶（≈6k tokens），超出按顺序截断并在片段里写明「另有 N 条未注入」。
- **界面**：左侧窄栏（`minmax(300px,400px)`）列表，一行一条：编号 / **技能名与流程节点上下叠在同一列**（`.nmcol`，节点带流程序号）/ 编辑 / 删除；列表**按流程序号排序**（「所有阶段」在最前，其余按 `p.stages` 顺序 → 技能编号）；正文不铺在列表里、收进悬停 `title` 与右侧表单；右侧表单 + 预设库占其余宽度；表单是草稿式（`SKDRAFT`），SSE 刷新与重渲染不会吞掉正在输入的内容。
- **API**：`POST /api/projects/:id/skills`（`{name, body, stage?}`）、`PUT …/skills/:sid`、`DELETE …/:sid`、**`POST …/skills/delete`（`{ids:[…]}` 批量删除，一次事件记账、失效 id 忽略）**；未知阶段 id 归到「所有阶段」，空名字/空正文 400，不存在 404。
- **批量删除**（导入一堆预设后清理用）：列表每行一个勾选框（状态在 `SKPICK`，SSE 重渲染不丢，删完/换项目自动清掉不存在的 id）＋卡头「全选 / 取消全选」与「✕ 删除选中（N）」——没勾选时禁用，点了先 `confirm` 再删。
- **证明**：单测（增删改查 / 上限 / 阶段过滤 / 假模型服务断言**请求体里真的带上了**技能）+ e2e `[2d]`（HTTP 往返 + 校验）+ UI 检查 `[8.12]`（真点按钮 → 真落库 → 真改 → 真删，含「SSE 重渲染后草稿还在」），截图 `out/34-skills.png`。

### 预设技能库（`skills/*.md` 33 条本地 + `vendor/agent-skills` 25 条上游 = 58 条，按阶段分专业）

**上游技能（`vendor/agent-skills`，MIT，Addy Osmani 的 agent-skills）**：不搬原文，只抽「可执行的三段」。

- **为什么抽**：上游单个 `SKILL.md` 均值 13.7KB（最大 21KB），比本平台**单次注入预算**（`agent.SKILL_PROMPT_MAX = 18000` 字符）还大；而本平台是「一次性出稿」的调用模型，上游那些「逐 task commit / 开浏览器 devtools」的步骤在这里跑不了 —— 只有约束段能用。
- **抽什么**：24/25 个上游技能都有 `## Verification` / `## Red Flags` / `## Common Rationalizations` 三段（验收判据、红线、反合理化表），按这个优先级拼到每条上限（800–1200 字符）就停；一个都没有的（`using-agent-skills`）退回各节照样截断兜底。
- **怎么落地**：
  - `bash tools/vendor_agent_skills.sh` 一次性 `git clone --depth 1` 到 `vendor/agent-skills/`，把 commit 写进 `vendor/agent-skills/SOURCE`（更新用 `--update`）；**之后平台完全离线**。
  - `harness.mjs` 的 `AGX_MAP`（上游技能 → 本平台阶段 + 上限，25 行，一一对应）→ `agxSlice()` 抽段截断 → `agxCatalog()` 产出 `{ id: 'agx-<上游名>', name: '上游规范 · <上游名>', stage, body: '（节选自上游 addyosmani/agent-skills@<sha8>：<名>｜全文 …）' + 切片 }`，并进 `skillCatalog()`。
  - **导入进项目的是切片文本（拷贝），不是引用**：之后删掉 vendor 目录也不影响已导入的技能；正文里写着取自哪个 commit，可追溯。
  - 想改抽哪几段/上限：只改 `AGX_SECTIONS` 与 `AGX_MAP` 两处。
- **分类包挂法**（`TYPES[].skills`）：webapp +`agx-code-review-and-quality`/`agx-test-driven-development`；website +`agx-frontend-ui-engineering`/`agx-performance-optimization`；service +`agx-security-and-hardening`/`agx-observability-and-instrumentation`；cli +`agx-debugging-and-error-recovery`；data +`agx-incremental-implementation`/`agx-performance-optimization`（技能页「⬇ 分类技能包」一键导入，`checkTypes()` 会校验 id 真在库里）。
- **自检**：单测「上游技能（vendor/agent-skills）：映射表对得上、切片在预算内、导入后不依赖 vendor」——映射表与上游 25 个目录**一一对应（不多不少）**、每条切片 ≤ 上限、有内容、stage 合法、名字带「上游规范 ·」出处、能并进预设库、分类包挂的 id 都在库里、导入的是 ≤1400 字符的切片、以及**整包导入后开发阶段一次注入仍 ≤18000 且上游技能没被截掉**（实测 14,664 字符 / 8 条）。
- **不做**（YAGNI）：上游的 `commands/`（9 个 slash 命令，本平台的阶段 + 门禁就是编排器）、`evals/`（给宿主做技能路由评测，本平台有自己的 run_all）、`hooks/`、各宿主适配目录（`.claude/.codex/.gemini/…` 只管宿主）。
- 升级上游：`bash tools/vendor_agent_skills.sh --update` → SHA 变了，单测若报「映射表与上游目录不一致」就补/删 `AGX_MAP` 那几行。


**本地技能的标准格式（AI Agent Skills / [agentskills.io](https://agentskills.io) 规范，与 `vendor/agent-skills` 同一套）**：每个技能一个目录 `skills/<name>/SKILL.md`（目录名 = frontmatter 的 `name`，小写连字符）：

```yaml
---
name: dev-nodejs                                  # 标准字段：必须等于目录名
description: 模块开发的 Node.js 落地规范。当开发阶段按 Node 档案生成模块代码时使用；不适用于 Java/Python 档案。
metadata:                                         # 平台扩展放这里（规范允许的落点）
  stage: development                              # 本平台：只在本阶段注入（"" = 所有阶段）
  tech: nodejs                                    # 本平台：技术栈标签（界面/分类包筛选用）
  label: 模块开发 · Node.js 规范                    # 本平台：界面显示名
---
# 模块开发 · Node.js 规范

## Overview          ← 这条技能解决什么、为什么必须遵守
## When to Use       ← 适用 / 不适用（本平台会 100% 注入，所以只有 2 行）
## Core Process      ← 真正执行的规矩：事实、命令、`代码片段`、跨技能引用
## Common Rationalizations  ← 表格：借口 | 事实（防止模型找理由跳过）
## Red Flags         ← 可观察的违规信号
## Verification      ← 复选框：能拿证据证明的退出条件（`node --test`、门禁、产物）
```

- 六节是**规范推荐的固定顺序**（`harness.mjs SKILL_SECTIONS`），单测按这个顺序逐条校验（目录名=name、顶层只许 name/description/metadata、description ≤1024 且写明「何时用」、反合理化是表格、验收是复选框、≤500 行）。
- **命名规则（规范硬要求）**：目录名 = `name` = **ASCII lowercase-hyphen**（如 `architecture-security-design`、`env-bootstrap`）；中文显示名放 `metadata.label`，界面与提示词照旧用中文名 —— 中文目录名会被上游校验器拒掉。
- **description 双语**：中文写「做什么 + 当…时使用；不适用于…」，句尾再补一句英文 `Use when …`（规范的触发语约定，也是上游校验器唯一认的写法）。
- **自检直接跑上游的参考校验器**：单测里 `createRequire` 加载 `vendor/agent-skills/scripts/lib/skill-lint.js`（上游的 `scripts/validate-skills.js` 就调它），对 33 个技能逐个要求 **0 error / 0 warning**（含「交叉引用指向不存在的技能」这类警告）—— 比我自己写断言更硬。`vendor/agent-skills/package.json` 显式声明 `{"type":"commonjs"}`：上游仓库本身没有 package.json，本项目是 `type: module`，不声明的话它 scripts/ 下的 CJS 会被当 ESM 解析、require 拿到空对象。
- **平台扩展只放 `metadata`**（`stage` / `tech` / `label`）：顶层键留给规范；`skillCatalog()` 只读这三样，其余正文整段注入。
- 本平台**不做按需加载**（技能是被固定注入提示词的），所以正文要克制：Overview/When to Use 各 1–3 行，重心放在 Core Process 与三段判据上 —— 单次注入预算 18000 字符（`agent.SKILL_PROMPT_MAX`，≈6k tokens，够装分类自带的 8–10 条）。
- 加一条技能：建 `skills/<id>/SKILL.md` 照上面六节写，**不用改代码**（`skillCatalog()` 扫目录）；要挂进某个分类包就在 `TYPES[].skills` 加 id（`checkTypes()` 会校验它真在库里）。
- 界面用法：右侧「预设技能库 → 导入选中范围」一键进项目（重复导入自动跳过、超上限自动跳过并说明，可改可删）；下拉分两组——**按范围**（全部 / 各阶段通用 / 仅某阶段）与**按技能**（选项文字 = `流程序号_流程名称_技能名`，如 `01_需求分析_需求可编号、可验收`；无阶段的写成 `所有阶段_环境自举`），选中一条就只导这一条。

| 阶段 | 技能 |
|---|---|
| 所有阶段 | `security-baseline` · `env-bootstrap`（没有环境就自己装） |
| 需求分析 | `requirements-ids-and-acceptance` · `requirements-nonfunctional-metrics` · `requirements-interview-and-conflict` |
| UI/UX | `ux-information-architecture` · `ux-usability-checklist` · `ux-accessibility-and-copy` |
| 架构设计 | `architecture-layering-contracts` · `architecture-data-consistency` · `architecture-security-design` |
| WBS | `wbs-module-granularity` · `wbs-estimate-and-dependencies` |
| 开发 | `development-general-conventions`（含**命名规约：业务语义优先、文件名不带 WBS 序号**）· `development-review-checklist` · `dev-code-layout`（代码目录与命名细则：不建模块子目录）· 技术栈专属 7 条：`dev-nodejs` · `dev-java-springboot` · `dev-java-struts` · `dev-sap-cap-rap` · `dev-python` · `dev-static-site` · `dev-react-vite` |
| 集成测试 | `testing-coverage-matrix` · `testing-case-design` · `testing-perf-and-security` |
| 部署 | `deployment-release-and-rollback` · `deployment-config-and-secrets` · `deployment-pipeline-and-canary` |
| 运维 | `operations-monitoring-runbook` · `operations-incident-response` · `operations-backup-and-restore` · `operations-cost-and-capacity` |

各文件要点（挑几条代表）：

- `dev-java-springboot`：controller/service/repository/domain 分层、DTO 与实体分离、构造器注入、事务只在 service 公有方法、`@ControllerAdvice` + 错误码枚举、`BigDecimal`/`java.time`、切片测试。
- `dev-java-struts`：Action 无状态、`PreparedStatement`、事务在 Service、PRG、OGNL 转义、Struts2 CVE 版本策略。
- `dev-sap-cap-rap`：CDS 建模（managed/unmanaged、金额语义）、服务投影与 `@restrict`、handler 只做编排、draft 时机、RAP behavior definition + EML、双栈一致性。
- `dev-python`：分层与类型标注、禁可变默认参数、异常层级、`Decimal`/tz-aware、pytest parametrize、logging。
- `development-general-conventions`：命名业务语义优先，**文件名不带 WBS 分解序号**（`M1`/`E2`/`T3` 只是平台内部追踪号，不进交付物）。
- `dev-code-layout`：源码直落层目录、**不要按模块新建文件夹**，用业务名（`OrderService.java` / `order-service.mjs` / `order_service.py`），同层平铺不重名；平台按这条判规约偏差。
- `dev-static-site`（静态网站）：可执行形态 = 模板纯函数 + 内容数据 → HTML 字符串（执行侧没有 npm/打包器，CSS 与构建工具留文档）；重点是**转义即安全**、路由表是唯一真源、产物可断言（title/description/canonical/alt/标题层级）。
- `dev-react-vite`（React + Vite 静态站）：平台没有 npm/Vite、不认 JSX（`node --check` 会当语法错误）→ 视图一律用 `h(type, props, ...children)` 的元素对象（与 `React.createElement` 同构、能真跑能断言），JSX 组件/`vite.config`/`public/`/构建托管进文档；reducer + 路由表 + 元素对象是测试口径，`base` 子路径、`VITE_` 变量与密钥禁忌写进部署文档。
- `env-bootstrap`（所有阶段）：没有环境就自己装并配好（探测 → 安装 → 重探 → 装不上才失败，失败要可执行）；「自己装」指运行环境，产物里的依赖仍按架构规约。
- `architecture-security-design`：鉴权与授权分开、每个接口标注角色与数据范围、输入边界、密钥管理、审计日志、依赖漏洞响应。
- `operations-incident-response`：P0/P1/P2 分级与时限、止损→定位→修复→验证、时间线留痕、48h 内复盘且改进项带负责人。

> 说明：平台按项目技术栈判定**语言档案**并真跑对应工具链 —— `Node.js` → 零依赖 ESM + `node --test`；`Java/Spring Boot/Struts2` → `javac`+`java`（只用 JDK 标准库，没有 Maven 仓库）；`Python` → `python3` + 标准库 `unittest`；`SAP CAP(+Java)` → Java 同上 + 真实 CDS 文件（`db/schema.cds`、`srv/*.cds`，结构性校验；有 `@sap/cds-dk` 才真 `cds compile`）。框架专属写法（Spring 注解 / Struts2 Action / CAP Handler / Django 视图）落在架构、部署与迁移文档里，这几条栈规范文件的开头都写明了这条边界。
> 提示词预算：单次注入的技能片段上限 18000 字符（≈6k tokens），超出的条目会被截断并在片段里写明「另有 N 条未注入」，不会被静默丢掉。

## 架构阶段定代码结构（分层归档）

架构设计阶段除了写文档，还要**定下源码目录结构**，后续 WBS 与代码生成都按它落位：

- **技术栈有输入就照用**；**没输入就由模型选型**，写进 ARC-01 的结构化声明里，平台解析成 `project.arch.stack` 作为事实传给下游（WBS 提示词、代码提示词都用它）。
- ARC-01 正文里的固定格式 json 块是唯一契约：

  ```
  {"stack":"Node.js ESM + node:test（零第三方依赖）","layers":[{"dir":"core","responsibility":"…"},{"dir":"service","responsibility":"…"}]}
  ```

  解析失败或层名非法 → 退回平台默认层 `core / domain / service / api`，并**在事件流里标明「规约来自平台默认」**，不阻断流水线。
- **一个 Epic = 一个模块 = 一组业务命名的文件（不建模块目录、文件名不带 WBS 序号）**：WBS 给每个 Epic 自报 `layer`（必须是声明里的层，非法则按序回落），模块目录就是层目录 `src/<层>`（Java `src/main/java/<层>`）；**不建「模块命名的文件夹」，文件名也不带 `M1`/`E2`/`T3` 这类分解序号** —— 名字由「模块做什么」决定（`OrderService.java` = public 类名 / `order-service.mjs` / `order_service.py`），测试与源码同业务名镜像到 `test/<层>/order-service.test.mjs`（`src/test/java/<层>/OrderServiceTest.java`）。同层重名换更具体的业务名；真撞名时平台会在事件流里报「与其它模块重名，会同层互相覆盖」。
- **落位在盘上校验**：写盘后检查每个文件都在 `mod.dir/` **这一层**、文件名是业务语义（多一层子目录、或名字以 `M1`/`m1_` 这类 WBS 序号开头，都算偏差），偏离发事件告警；模块产物头部固定写 `**架构层** / **代码位置** / **测试位置**`，下面列真实交付文件与行数——「产物记录代码位置」因此可断言。
- 界面：「WBS / 开发」页头显示规约（技术栈 + 分层 + 来源），模块详情显示 架构层 / 代码位置 / 测试位置。

## 界面适配

- 布局按屏宽自适应：≥1560 三栏全宽；≤1360 起收窄 KPI 与多栏；≤1120 多栏一律折叠成单栏、左轨只剩标记方块、模块表隐藏次要列；≤820 KPI 单列。
- 项目概要在卡片里**按宽度换行**（最多 3 行，完整内容挂在 `title` 上），不再被固定高度裁成半行。
- 项目可直接在卡片上删除（原生确认框；会一并删掉 `workspace/<项目ID>/`；项目正在执行时返回 409 拒绝）。

## 目录

```
ai-platform/
├── server.mjs         零依赖 HTTP：静态资源 + REST + SSE
├── harness.mjs        交付状态机：阶段 / 门禁 / WBS / 模块 / 单测规则 / 持久化
├── agent.mjs          真实模型通道（OpenAI 兼容，默认 DeepSeek）+ 提示词与输出校验
├── exec.mjs           真实执行层：工作区写入 + 按语言档案真跑（node --test / javac+java / python3 unittest）+ CDS 结构性校验
├── sim.mjs            离线模板通道（显式 AI_PLATFORM_PROVIDER=sim 才用）
├── skills/*.md        预设技能库（每个阶段一条 + 开发阶段各技术栈专属），front matter: name/stage/tech
├── setup/             安装配置：install.sh（check/install/configure/verify/start/status/stop）+ README.md
├── public/            index.html · app.css · app.js
├── workspace/<项目ID>/  模型生成的真实代码与单测（可删）
├── data/projects.json   运行状态（可删）
├── test/harness.test.mjs 状态机与真实执行的单测（node --test）
├── tools/e2e.mjs      离线端到端（真起服务 + 真跑代码，sim 通道）
├── tools/e2e_live.mjs 真实模型端到端（需要 Key）
├── tools/run_all.sh   验收总入口
└── tools/shot.mjs     纯 Node CDP 截图（需自启 Chrome 调试端口）
```

## 验证

```bash
bash tools/run_all.sh            # 离线：单测 27 + HTTP 端到端 64 + UI 检查 65，FAIL=0
bash tools/run_all.sh --live     # 追加真实模型端到端（需要 Key + 网络）
```

要求 Node ≥ 20（截图脚本用内建 `WebSocket`，需 ≥ 22）。
