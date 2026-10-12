---
name: dev-code-layout
description: 约定生成代码的目录层级与文件命名：源码平铺进架构阶段声明的层目录（Node/Python `src/<层>/`，Java `src/main/java/<层>/`），文件名按业务语义命名、不带 WBS 模块号，单元测试镜像到测试目录。当新建源码文件、决定落盘路径或命名文件/测试时使用；不适用于架构阶段规划层目录本身，也不适用于 SAP CAP/RAP 的 CDS/behavior 专用建模。 Use when placing source files or naming modules.
metadata:
  stage: development
  tech: ""
  label: 模块开发 · 代码目录与命名（不建模块子目录）
---

# 代码目录与命名规范

## Overview
约定生成代码的目录层级与文件命名：架构阶段定的层目录 + 业务语义的文件名就够了，不再增加模块名的子目录，文件名也不带 WBS 分解序号。

## When to Use
- 适用：新建源码文件、决定文件落盘路径。
- 适用：命名源文件、类、函数或单元测试文件。
- 适用：判断跨模块复用代码该放到哪个层目录。
- 不适用：架构阶段规划层目录本身（那要改架构文档）。
- 不适用：SAP CAP/RAP 的 CDS 实体、service、behavior 等专用建模（见 `dev-sap-cap-rap`）。

## Core Process
生成代码**不需要也不允许**再增加一层「以模块命名的文件夹」，文件名也**不带 WBS 分解序号** —— 架构阶段定的层目录 + 业务语义的文件名就够了。

- 源码直接放在层目录里：Node/Python `src/<层>/`，Java `src/main/java/<层>/`；**不要**出现 `src/<层>/m1-order-service/xxx.mjs` 这种按模块新建的层级。平台会把这类文件记进事件流（「M1 有 N 个文件不符合层目录规则」）。
- **文件名按业务语义命名，不带 WBS 模块号/任务号**：写 `order-service.mjs`、`OrderService.java`、`order_service.py`，不写 `M1OrderService.java`、`m1_order_service.py`、`E2T1…`。`M1`/`E2`/`T3` 是平台内部的追踪号（状态机、事件流、门禁用它），不进交付物。
- 命名跟语言习惯走：Java 类名 PascalCase 且**文件名 = public 类名**；Node kebab-case；Python snake_case。同层多个模块靠业务名区分，重名就换更具体的业务名（`OrderRefundService`），不要加数字后缀。
- 一个模块的多个文件同样平铺：`OrderService.java` + `OrderRepository.java`；层内不再分层。需要跨模块复用的东西放到更下层的层目录（`core`/`domain`），而不是新建 `shared/`、`common/` 这类没在架构规约里登记的目录。
- 单元测试与源码同业务名并镜像到测试目录：`src/test/java/<层>/OrderServiceTest.java`、`test/<层>/order-service.test.mjs`、`test/<层>/order_service.test.py`。
- 落盘位置由平台按架构规约算好后写进提示词（`mod.dir` / `mod.test_path_planned`），照写即可；**不要自己发明目录层级**，也不要为了「整齐」把文件挪到别处——挪了平台就找不到模块归属，改代码后不会自动重跑该模块的单测。
- 层名只能用架构规约里声明过的那几个（`ARC-01` 的 json 块），新增层要先改架构文档。

## Common Rationalizations
| 借口 | 事实 |
|---|---|
| 按模块建个子目录更整齐 | 平台按层目录判定模块归属，多一层会让文件失去归属并记进「不符合层目录规则」事件流。 |
| 文件名带上 `M1`/`E2` 便于追踪 | 追踪号是平台内部的，不进交付物；业务语义名才稳定可读。 |
| 重名了加个数字后缀最省事 | 数字后缀无意义；换更具体的业务名（如 `OrderRefundService`）。 |
| 复用代码放 `shared/`、`common/` 通用些 | 这些目录没在架构规约登记，属于自造层级；应放进 `core`/`domain`。 |
| 把文件挪到别处更好看 | 挪动会让平台丢失模块归属，改代码后不会自动重跑该模块单测。 |

## Red Flags
- 出现 `src/<层>/<模块名>/xxx` 这种按模块新建的目录层级。
- 文件名带 `M1`/`E2`/`T3` 等 WBS 序号或数字后缀。
- 自造 `shared/`、`common/` 等没在 `ARC-01` 登记的层目录。
- 层名不在架构规约声明的集合内。
- 单元测试没镜像到测试目录，或测试文件名与源码业务名不一致。

## Verification
- [ ] 源码落在架构规约声明的层目录下，无按模块新建的子目录。
- [ ] 文件名按业务语义命名，无 WBS 模块号/任务号、无数字后缀。
- [ ] Java 文件名 = public 类名；Node kebab-case；Python snake_case。
- [ ] 测试文件镜像到测试目录，且与源码同业务名。
- [ ] 未新增架构规约未登记的层目录（`shared/`、`common/` 等）。
