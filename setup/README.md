# setup · 安装与配置（ai-platform）

Zero-dependency / 零依赖：平台本体不需要 `npm install`，装好 Node 就能跑。这个目录只解决两件事：

1. 把**机器该有的工具链**备齐（Node 必需；JDK / python3 / Chrome 只在对应技术栈真跑测试时才是必需）；
2. 把**平台该有的配置**落成一份文件 + 一组命令（端口 / 通道 / 模型 / Key / 数据与工作区路径），并给出启动·状态·停机·验收的命令行入口。

   命令入口：`bash setup/install.sh <命令>`
   文档（本文）：配置优先级 → 环境变量表 → 启停 → 验证 → 常见问题

---

## 1. 前置要求

| 组件 | 必需性 | 版本 / 位置口径 | 说明 |
|---|---|---|---|
| **Node.js** | **必需** | ≥ 20；UI 检查与截图（`tools/ui_tree.mjs` 用内建 `WebSocket`）需 **≥ 22** | 平台零依赖，`node server.mjs` 即跑 |
| npm | 可选 | 随 Node | 只用于 `npm start` / `npm run verify` 这类别名；`node server.mjs` 不用它 |
| 模型 API Key | **真跑必需** | `AI_PLATFORM_API_KEY` → `DEEPSEEK_API_KEY` → `~/.hermes/.env` | **没有 Key 不会假装成功**：阶段明确失败并提示未配置。要离线演示显式设 `AI_PLATFORM_PROVIDER=sim` |
| JDK | 按技术栈 | `JAVA_HOME` → `PATH` → Homebrew keg（`/opt/homebrew/opt/openjdk*/bin`） | 只有 **Java / SAP CAP(Java)** 项目真跑 `javac`+`java` 测试需要。判定要求 `javac -version` **真跑通过**（macOS 的 `/usr/bin/javac` 是「没装 JDK」的桩，光看可执行位会被骗） |
| python3 | 按技术栈 | `python3`（macOS 自带 3.9 就够，只用标准库 `unittest`） | 只有 **Python** 项目真跑测试需要 |
| Google Chrome | 可选 | `/Applications/Google Chrome.app` 或 `CHROME_PATH` | 只影响 UI 检查与项目预览截图；缺了逻辑检查照跑（脚本打印 `SKIP`） |
| `@sap/cds-dk` | 可选 | `cds` 在 PATH | 装了才谈真编译 CDS；没装只做结构性校验（报告里写明「这不是 `cds compile` 的结果」，不会谎称编译过） |
| Homebrew | 可选 | `brew` 在 PATH | 缺工具链时的自动安装通道（见下） |

缺 JDK / python3 **不等于平台跑不了 Java / Python 项目**：`exec.mjs` 的 `ensureToolchain()` 会先用系统包管理器真装一次（`brew install openjdk@21` / `python@3.12`，超时 15 分钟）再重探，装上了就照常真跑；**装不上才失败**，且失败原因里写明试过哪条命令、退出码多少 —— 绝不静默改用 Node 跑、也不假装装过。

---

## 2. 安装

```bash
cd ~/Desktop/work/pm/ai-platform

bash setup/install.sh check          # ① 环境体检（默认命令；只读，缺硬条件退出码 1）
bash setup/install.sh install        # ② 装缺的可选工具链（brew：openjdk@21 / python@3.12 / chrome）
bash setup/install.sh configure --port 8788 --provider live      # ③ 落配置（可跳过，全用缺省值）
bash setup/install.sh verify         # ④ 验收：单测 + 离线端到端 + UI 检查（FAIL 必须为 0）
bash setup/install.sh start          # ⑤ 起服务 → http://127.0.0.1:8788
```

- `check` 不做任何写操作，只报告：Node / npm / JDK / python3 / Chrome / jq / cds / git / 模型 Key 来源 / 配置文件 / 数据与工作区可写 / 端口占用 / **同时在跑的实例数**。末尾给「通过 N · 提醒 N · 阻塞 N」并据此返回退出码（可直接当 CI 前置门）。
- `install` 只装缺的，已装好的跳过；`--dry-run` 只打印计划。没有 Homebrew 时**不装作装过**，打印要手动执行的那几条命令并以退出码 1 结束。
- 装不上就照实报缺 —— 与平台「无真实通道时明确失败、不静默降级」的口径一致。

### 配置优先级

`命令行 flag` > `已导出的环境变量` > `setup/ai-platform.env` > `缺省值`

也就是说 `AI_PLATFORM_PORT=8899 bash setup/install.sh start` 里那个 8899 会压过配置文件。手动起服务（不走本工具）时，配置要自己加载：

```bash
set -a; . setup/ai-platform.env; set +a; node server.mjs
```

---

## 3. `setup/install.sh` 命令表

| 命令 | 做什么 | 备注 |
|---|---|---|
| `check` | 环境体检（默认） | 只读；硬条件不满足 → 退出码 1 |
| `install [--dry-run]` | 装缺的工具链 | 与 `exec.mjs` 的 `installPlan()` 同一套（`openjdk@21` / `python@3.12`） |
| `configure [flags] [--show]` | 写 / 合并 `setup/ai-platform.env`（`chmod 600`） | flags：`--port --host --provider --model --base-url --api-key --data --workspace --concurrency`；只传的项被改，其余保留；`--show` 直接打印现值 |
| `verify [--live]` | 转调 `bash tools/run_all.sh [--live]` | `--live` 追加真实模型端到端（真烧额度） |
| `start` | 后台起服务，写 `setup/run/ai-platform-<port>.{pid,log}`，轮询 `/api/state` 就绪 | 端口被占 / 起不来会打印日志末尾并退出 1 |
| `status` | 进程 / 端口 / 实例数 / 数据与工作区 / `/api/state`（通道·并发·项目数） | 会读配置文件 |
| `stop` | 按 pidfile `SIGTERM`（10s 后 `SIGKILL`），随后报**残留实例数** | 不盲目 `pkill`；没有 pidfile 时打印锁文件里的 pid 给你自己决定 |
| `selftest` | 本脚本自己的断言自检（版本比较 / Key 掩码 / 配置优先级 / pidfile 命名） | 不起服务，不碰真机 |
| `help` | 用法 | |

`configure` 的 Key 回显**永远只打前 4 位**（`sk-a****(32 位)`），配置文件的权限是 `600`。

---

## 4. 环境变量

平台自己的（完整表见 `README.md` §运行）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_PLATFORM_PORT` / `AI_PLATFORM_HOST` | `8788` / `127.0.0.1` | 监听地址 |
| `AI_PLATFORM_PROVIDER` | `live` | `live` 调真实模型 / `sim` 离线模板通道（界面顶栏会标出） |
| `AI_PLATFORM_API_KEY` / `AI_PLATFORM_BASE_URL` / `AI_PLATFORM_MODEL` | — / `https://api.deepseek.com/v1` / `deepseek-v4-flash` | 模型通道；`AI_PLATFORM_MODEL` 是缺省模型，可被项目里逐阶段定义覆盖。**`agent.mjs` 在 import 时读它 —— 改完必须重启服务** |
| `AI_PLATFORM_DATA` | `data/projects.json` | 状态文件（单 JSON，写入去抖） |
| `AI_PLATFORM_WORKSPACE` | `workspace/` | 生成代码的落盘根 |
| `AI_PLATFORM_CONCURRENCY` | `3` | 开发阶段并行度 1–8；`1` = 严格串行 |
| `AI_PLATFORM_SPEED` | `1` | 步骤节奏倍数，`0` = 不等（测试用，演示时别设） |
| `AI_PLATFORM_TEST_TIMEOUT_MS` | `120000` | 单条测试命令硬超时（到点杀进程组并如实报「测试超时」） |
| `AI_PLATFORM_TIMEOUT_MS` | `180000` | 单次模型调用超时 |
| `AI_PLATFORM_NO_INSTALL` | — | `1` = 关掉运行时自动装工具链（CI / 别人机器上用） |
| `AI_PLATFORM_INSTALL_CMD` | — | 自定义安装通道（整条命令走 `sh -c`） |
| `CHROME_PATH` | Google Chrome 默认路径 | 截图 / UI 检查用 |
| `AI_PLATFORM_NO_JDK` / `AI_PLATFORM_NO_PYTHON` | — | 测试钩子：假装机器上没有 JDK / python3 |

`setup/install.sh` 自己产生的文件：

```
setup/ai-platform.env           配置（configure 生成，chmod 600，含 Key 时别提交）
setup/run/ai-platform-<port>.pid   start 起的进程号（stop 靠它）
setup/run/ai-platform-<port>.log   该实例的 stdout/stderr（起不来先看它末尾）
```

换端口 = 换一份 pidfile/log，所以**同一台机器可以并存多个实例**（各配各的 `AI_PLATFORM_DATA` / `AI_PLATFORM_WORKSPACE` 就不会互相覆盖）。

---

## 5. 启停与多实例

```bash
bash setup/install.sh start                     # 按 setup/ai-platform.env 起
bash setup/install.sh status
bash setup/install.sh stop

# 隔离的第二实例（试东西不污染主数据）
bash setup/install.sh configure --port 8899 --provider sim \
  --data /tmp/x/d.json --workspace /tmp/x/ws
bash setup/install.sh start && bash setup/install.sh status && bash setup/install.sh stop
```

- **同一份数据文件只允许一个实例**：`server.mjs` 的单实例锁在同一份 `AI_PLATFORM_DATA` 上互斥（各持一份内存副本、各自 flush 会静默覆盖对方的进度 —— 实测踩过）。换了数据文件才可以并存。
- `npm start` 是**包装进程**：`kill <npm 的 pid>` 不会把 `SIGTERM` 传给 node 子进程，锁文件会残留。要干净地停就按 `setup/run/*.pid` 或 `data/projects.json.lock` 里的 pid 杀 node —— 本工具的 `stop` 走的就是这条路。
- 停机后**再数一遍实例**（`status` 里的「实例总数」）：只看到端口空闲还不够，没绑上端口的实例照样跑定时任务、照样 flush，能把状态盖回去。

---

## 6. 验证（判据是数字，不是「跑通了」）

```bash
bash setup/install.sh selftest    # 安装工具自己的断言（PASS / FAIL）
bash setup/install.sh check       # 环境体检（阻塞 = 0 才是可启动）
bash setup/install.sh verify      # = bash tools/run_all.sh：单测 + 离线端到端 + UI 检查，FAIL=0
bash setup/install.sh verify --live   # 追加真实模型端到端（需要 Key + 网络，真烧额度）
```

安装完成后建议的顺序：`selftest` → `check` → 起服务 → `verify`。

---

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 阶段失败提示「未配置模型 API Key」 | 三处都没有 Key：`AI_PLATFORM_API_KEY` / `DEEPSEEK_API_KEY` / `~/.hermes/.env`。`configure --api-key <K>` 落一份，或导出环境变量；只想离线看流程就 `configure --provider sim` |
| Java 项目模块失败「缺 JDK」 | 装：`bash setup/install.sh install`（= `brew install openjdk@21`）。注意 keg-only 不自动进 PATH，平台会自己去 keg 里找；macOS 的 `/usr/bin/javac` 是桩，`check` 里显示的是**真跑通过**的那个 |
| Python 项目失败「缺 python3」 | 同上，`brew install python@3.12`；macOS 自带 `/usr/bin/python3` 也够用（只用 stdlib unittest） |
| UI 检查打印 `SKIP` | 没找到 Chrome；装 Chromium/Chrome 或设 `CHROME_PATH`。逻辑检查不受影响 |
| `check` 报端口被占 | `configure --port 8899` 换端口；或先 `stop`。别直接 `pkill -f "node server.mjs"`（会连别的实例一起杀，且不保证杀干净） |
| `start` 报「已有实例在跑」 | 同一份数据文件被另一个实例持有；停掉旧的，或给这个实例配另一份 `AI_PLATFORM_DATA` |
| 起动即崩、日志 `ENOENT ... projects.json.lock` | 老版本才会：`AI_PLATFORM_DATA` 指向还没建的目录。现在 `server.mjs` 会自己 `mkdir -p`，若你自建分支请保留这行 |
| 改了 `AI_PLATFORM_MODEL` 不生效 | `agent.mjs` 在 import 时读它 —— **重启服务**才生效 |
| 想重置运行态 | 状态与产物都是可删的运行态：`rm -rf data/projects.json* workspace/* out/* setup/run/`（`skills/`、`vendor/`、源码不要动）。界面上还有各项目的「♻ 重新构建」（清空该项目成果物与历史痕迹，技能保留） |
| 完全卸载 | 平台零依赖、无系统安装：删掉整个项目目录即可；由 `install` 装上的工具链（JDK / python3 / Chrome）用 `brew uninstall` 单独处理 |

---

## 8. 交付清单

```
setup/
├── install.sh         命令行安装 / 配置 / 启停 / 体检 / 自检工具（零依赖 bash）
├── README.md          本文：安装配置文档
├── ai-platform.env    configure 生成（含 Key，chmod 600；不含则不生成）
└── run/               start 生成：<port>.pid + <port>.log
```
