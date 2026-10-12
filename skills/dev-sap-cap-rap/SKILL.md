---
name: dev-sap-cap-rap
description: 规范 SAP CAP（Node/Java）与 RAP（ABAP）双栈模块的建模与实现，要求先建模后写码、字段带语义、鉴权声明化、数据访问参数化、处理器只做编排，并保证两栈的错误码、字段名与状态机一致。当生成或评审 SAP CAP/RAP 的 CDS 建模、service 定义、处理器、behavior definition/implementation 或双栈一致性时使用；不适用于非 SAP 技术栈（Node/Python/Java 通用模块）或与 SAP 无关的目录命名、评审任务。 Use when modeling CAP CDS services or RAP behaviors.
metadata:
  stage: development
  tech: sap-cap-rap
  label: 模块开发 · SAP CAP / RAP 规范
---

# SAP CAP / RAP 模块开发规范

## Overview
约定 SAP CAP（Node/Java）与 RAP（ABAP）双栈模块从建模到测试的落地形态，让 CDS 建模真产出文件、处理器只做编排、鉴权与错误码声明化，并保证两栈在字段、必填与状态机上保持一致。

## When to Use
- 适用：生成或评审 SAP CAP 模块的 `db/` CDS 实体、`srv/` service 定义、handler 与数据访问。
- 适用：编写或评审 RAP 的 `behavior definition` 与 `behavior implementation`。
- 适用：核对 CAP 与 RAP 双栈的错误码、字段名、必填与状态机是否一致。
- 不适用：非 SAP 技术栈（通用 Node/Python/Java 模块）的开发规范。
- 不适用：与 SAP 无关的目录命名与代码评审清单（另见 `dev-code-layout` 与 `development-review-checklist`）。

## Core Process
（落地形态：本平台按技术栈判定语言档案 —— **SAP CAP + Java 项目**：Java 源码是真编译执行的（`src/main/java/<层>/`、`src/test/java/<层>/M<NN>Test.java`，只用 JDK 标准库，没有 Maven 仓库），**CDS 建模必须真产出文件**（`db/schema.cds`、`srv/<名>-service.cds`，实体带 `key`），平台做结构性校验（本机有 `@sap/cds-dk` 时才真 `cds compile`）。CAP 的 `@Service`/Handler/`@restrict` 注解写法用在架构与部署文档里；两者冲突时以平台可执行要求为准。）

- 先建模后写码：`db/` 里 CDS 实体定字段、类型、`key`、关联（`Association`/`Composition` 方向要写清）；managed 实体（`cuid`/`managed`）与 unmanaged 的选择要写明理由。
- 金额/数量带语义：`Decimal(15,2) @Semantics.amount.currencyCode: 'currency'`、单位字段成对出现，禁止用 float 存金额。
- 服务定义 `srv/service.cds` 只暴露需要的实体与动作（action/function）；投影用 `as select from ... { }` 明确字段，禁止 `*` 裸暴露整表。
- 处理器只做编排：用 `on/before/after` 挂钩做校验与副作用，业务规则放 `lib/domain` 里的纯函数（可单测），handler 里不写长逻辑。
- 数据访问走 `cds.ql`（`SELECT.from(...).where({...})`）或参数化查询，禁止字符串拼 SQL；批量操作先收集再一次查询，避免 N+1。
- 鉴权用注解声明（`@requires`/`@restrict`），不在 handler 里手写 if 判断用户角色；返回错误用 `req.reject(code, message)` 带稳定错误码。
- Draft 流：写明哪些实体启用 draft（`@odata.draft.enabled`）、草稿激活时机与校验点（保存时/激活时分别校验什么）。
- RAP（ABAP 栈）：`behavior definition`（managed/unmanaged、associated、validation、determination、action）+ `behavior implementation` 成对交付；写库只走 EML（`MODIFY ENTITIES`），不直接 `INSERT`/`UPDATE` 底表；校验放 validations、派生字段放 determinations；消息用 `%msg` 且带严重级别。
- 双栈一致性：CAP（Node/Java）与 RAP 的错误码、字段名、必填与状态机必须一致；差异要登记成白名单并写理由。
- 测试：CAP 用 `cds.test`/服务层单测覆盖 before/on/after 与拒绝路径；RAP 用 ABAP Unit；拒绝路径也要断言错误码。

## Common Rationalizations
| 借口 | 事实 |
|---|---|
| 先用 `*` 暴露整表，字段以后再说 | 裸暴露会把内部字段泄进服务契约，投影必须明确列字段。 |
| 业务规则直接写在 handler 里更快 | handler 逻辑不可单测；规则放 `lib/domain` 纯函数才能覆盖与复用。 |
| 金额用 float 无所谓，业务量不大 | 浮点累计误差会污染金额；金额必须 `Decimal(15,2)` 并带 `@Semantics`。 |
| 双栈有点小差异没关系 | 差异会让同一业务在 CAP/RAP 行为不一致；必须一致或登记白名单写理由。 |
| 拒绝路径不用测，正常路径通了就行 | 未断言的拒绝路径会在错误码漂移时静默通过，必须断言错误码。 |

## Red Flags
- `srv/` 里出现 `*` 裸暴露整表，或 service 暴露了不需要的实体/动作。
- handler 里堆长业务逻辑，而不是把规则放进 `lib/domain`。
- SQL 字符串拼接、循环内逐条查询（N+1）。
- 金额/数量用 float，或单位字段不成对。
- 用 `if` 手写角色判断而非 `@requires`/`@restrict`。
- RAP 直接 `INSERT`/`UPDATE` 底表，或 behavior definition 与 implementation 不成对。

## Verification
- [ ] `db/schema.cds`、`srv/<名>-service.cds` 真产出，实体带 `key`。
- [ ] 本机有 `@sap/cds-dk` 时 `cds compile` 通过。
- [ ] 服务投影显式列字段，无 `*` 裸暴露整表。
- [ ] 鉴权用 `@requires`/`@restrict`，错误经 `req.reject(code, message)` 返回稳定错误码。
- [ ] 测试覆盖 before/on/after 与拒绝路径，且断言了错误码。
- [ ] CAP 与 RAP 的错误码、字段名、必填、状态机一致，差异已登记白名单并写理由。
