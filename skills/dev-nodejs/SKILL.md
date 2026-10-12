---
name: dev-nodejs
description: 规定零依赖 Node ESM 模块的导入导出、纯函数、错误显式化、异步与不阻塞事件循环、时间/ID 注入、依赖治理与 node:test 测试约束，对应本平台默认可直接执行的模块形态。当开发、修改或评审 Node.js 模块时使用；不适用于 Java/Python 模块或需要第三方依赖的场景。 Use when writing or reviewing zero-dependency Node ESM modules.
metadata:
  stage: development
  tech: nodejs
  label: 模块开发 · Node.js 规范
---

# 模块开发 · Node.js 规范

## Overview
本平台默认的模块落地形态就是这条：零依赖 Node ESM + `node:test`，`exec.mjs` 会真跑测试；所以这条技能对开发阶段是「直接可执行」的约束。规则覆盖模块边界、纯函数、零依赖、错误处理、异步一致性、事件循环、时间/ID 注入与测试要求。

## When to Use
- 适用：新建或修改零依赖 Node ESM（`.mjs`）模块；补 `node:test` 测试；评审纯函数与异步写法。
- 适用：排查模块读全局/时间/随机导致测试不稳定，或事件循环被大循环阻塞。
- 不适用：Java 模块（`dev-java-springboot` / `dev-java-struts`）；Python 或前端构建产物。
- 不适用：确实需要第三方依赖的场景（此时先确认平台是否允许，再按依赖治理条款处理）。

## Core Process
（本平台默认的模块落地形态就是这条：零依赖 Node ESM + `node:test`，`exec.mjs` 会真跑测试；所以这条技能对开发阶段是「直接可执行」的约束。）

1. ESM 显式导入导出（`.mjs` / `import`），不混用 `require`；一个文件一个职责，导出的函数是模块的公开契约。
2. 纯函数优先：同输入同输出，不读全局、不用 `Date.now()`/`Math.random()`/文件系统/网络——需要就由参数传入。
3. 零第三方依赖：只用 Node 内置模块；需要存储/状态就用内存对象或纯数据结构模拟。
4. 错误显式化：返回 `{ ok: false, code, message }` 或抛自定义错误类；不吞异常、不 `catch {}` 后继续。
5. 异步要么全 `await` 要么全回调，不混用；并行用 `Promise.all`，串行依赖就顺序 `await`，别写「先发起再靠时序」的代码。
6. 不阻塞事件循环：大循环切片或改流式；同步 IO（`readFileSync`）只允许出现在启动期一次性的代码里。
7. 时间与 ID 由外部注入（`now` 参数、`id` 生成器函数），金额用整数最小单位或 `BigInt`，浮点只用于展示。
8. 测试用 `node:test` + `node:assert/strict`：每个导出至少一条正常路径 + 边界（空/0/极值/重复）+ 错误分支，断言具体值。
9. 依赖治理：真有依赖时锁定版本并提交 lockfile，禁止 `postinstall` 脚本；`engines` 写清支持的 Node 版本。

## Common Rationalizations
| 借口 | 事实 |
|---|---|
| 「就用 `Date.now()` 生成 ID，简单」 | 读全局时间/随机会让模块不可复现、测试必挂；把 `now`/`id` 生成器作为参数传入即可。 |
| 「就加一个小依赖，不用自己写」 | 本平台默认形态是零依赖；第三方依赖写不进可执行模块的契约，先问是否真需要，再走依赖治理。 |
| 「`catch {}` 先兜住，别让流程断」 | 吞异常等于把失败改成静默错值；必须返回 `{ ok: false, code, message }` 或抛自定义错误。 |
| 「测试断言不为空/不报错就行」 | 断言具体值才能区分真通过与假通过，`node:test` 的失败才有意义。 |
| 「先发起请求，后面靠时序等它回来」 | 时序等待是随机失败源；并行用 `Promise.all`，串行就顺序 `await`。 |

## Red Flags
- `.mjs` 里混用 `require`，或一个文件塞多个职责、导出不是模块公开契约。
- 模块内部读全局、`Date.now()`/`Math.random()`/文件系统/网络，或使用第三方依赖。
- `catch {}` 后继续、异常被吞，或错误分支没有显式返回值。
- `await` 与回调混用，或有靠时序而非 `Promise.all`/顺序 `await` 的并发代码。
- 测试未用 `node:test` + `node:assert/strict`，或缺少边界/错误分支、只断言「不为空」。

## Verification
- [ ] `node --test` 全绿，退出码为 0（`exec.mjs` 真跑该命令）。
- [ ] 测试用 `node:test` + `node:assert/strict`，每个导出覆盖正常路径 + 边界（空/0/极值/重复）+ 错误分支，断言具体值。
- [ ] 模块仅用 Node 内置模块与零第三方依赖；无 `postinstall`，`engines` 写明支持的 Node 版本。
- [ ] 全模块无 `Date.now()`/`Math.random()`/文件系统/网络直读；时间与 ID 由参数注入。
- [ ] 错误路径显式返回 `{ ok: false, code, message }` 或抛自定义错误，无 `catch {}` 静默吞异常。
- [ ] 异步写法一致（全 `await` 或全回调），并发用 `Promise.all`，同步 IO 仅在启动期一次性代码中。
