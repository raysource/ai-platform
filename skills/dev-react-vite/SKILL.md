---
name: dev-react-vite
description: 定义 React + Vite 静态站开发规范，并按本平台可执行形态把视图表达为元素对象 h(type, props, ...children)、逻辑表达为纯函数，用 node --test 真跑数据/reducer/路由表/元素对象。当开发或评审 React+Vite 静态站的数据流、reducer、路由、转义与 SEO/无障碍时使用；不适用于无构建的纯 HTML 静态站（见 dev-static-site）或需要在平台内真跑 JSX/构建流水线的场景。 Use when building a React + Vite static site or its view layer.
metadata:
  stage: development
  tech: react-vite
  label: 模块开发 · React + Vite 静态站规范
---

# React + Vite 静态站规范

## Overview
规定 React + Vite 静态站的视图/逻辑分层、reducer 状态管理、路由与链接真源、转义与 XSS 防护、SEO 与无障碍产物、构建托管口径，并给出本平台内可被 `node --test` 真执行验证的落地形态。

## When to Use
- 适用：开发或评审 React + Vite 静态站的数据/reducer/selector、路由表、元素对象渲染、转义与 SEO/无障碍标签。
- 不适用：无构建的纯 HTML 静态站，改用 `dev-static-site`；需要在平台内真跑 JSX 或跑 `vite build` 的场景。

## Core Process

落地形态：执行侧只有 Node 标准库 + `node --test`，**没有 npm install、没有 Vite、也不认 JSX** —— `node --check` 会把 `.jsx` 当语法错误。所以本平台里 React 静态站的**可执行形态**是「视图用元素对象表达、逻辑用纯函数表达」：`h(type, props, ...children)` 产出的 `{type, props, children}` 与 `React.createElement`/JSX 同构，能真跑、能断言；真正的 JSX 组件、`vite.config`、`public/`、构建与托管写进**架构与部署文档**，并在集成测试清单里标明**未在平台内真跑**。无构建的纯 HTML 静态站见 `dev-static-site`。

- **不许写 JSX、不许 import react/vite**：视图用元素对象 `h('section', { class: 'card' }, h('h2', null, title))`；`react` / `react-dom` / `vite` 只出现在文档与真实项目迁移说明里。断言直接查元素对象（类型 / 文本 / 属性 / 子节点数），比「包含 `<div>`」强得多。
- **逻辑与视图分离**：数据、reducer、selector、校验、路由匹配、分页筛选排序写成纯函数模块并被真跑；组件只做组装与事件绑定（事件处理函数是纯函数，返回新状态或动作）。
- **状态用 reducer**：`(state, action) => nextState` 纯函数，动作类型走常量表；时间/随机/网络（`fetchJson`）由调用方注入，测试里传假实现——不要 `Date.now()`、不要模块级可变单例。
- **组件约定照 React 习惯**（写进文档）：函数组件、props 只读、可推导的数据在渲染时算（别用 state 存）、列表 `key` 用稳定业务 id（不用下标）、条件渲染避免 `{count && <X/>}`（`0` 会渲染出来，用三元或提前 return）。
- **路由**：静态托管没有服务端路由 → 用 hash 路由或让托管方回落到 `dist/404.html`；`routes()` 出全站路由表（path → 页面 / 标题 / 是否需要数据）并作为唯一真源生成链接，断链用测试拦（href 要么在路由表里，要么是外链白名单）。
- **转义与 XSS**：React 默认转义，但 `dangerouslySetInnerHTML`、用户可控的 `href`/`style`、`javascript:` 协议一律禁止或白名单化；来自内容/接口的文本在**纯函数层**就过 `esc()`，别指望模板兜。
- **SEO 与无障碍也算产物**：`<html lang>`、`<title>`、`<meta name="description">`、canonical、语义标签（header/nav/main/footer）、图片 `alt`、标题层级不跳级、表单 `label` —— 这些在元素对象层就能断言，别只写文档。
- **构建与托管（文档 / 部署阶段）**：`vite build` 的 `base` 必须按托管子路径设置（否则静态托管下资源全 404）；`public/` 只放原样拷贝的文件；只有 `VITE_` 前缀的环境变量会进产物，**前端产物是公开的，任何密钥都不许塞进去**；产物目录 `dist/`，部署走对象存储/CDN，回滚靠保留上一版 `dist/`。
- **样式**：CSS Modules 或全局 CSS 都行，但组件里不写大段行内样式；主题色/间距走 CSS 变量；不引外链字体与图标库（用内联 SVG 或系统字体栈），避免首屏抖动与第三方依赖。
- **测试口径**：平台内真跑「数据 + reducer + 路由表 + 元素对象」；浏览器行为（焦点、滚动、动画、真实接口、Lighthouse 指标）写进集成测试清单并标明未在平台内真跑，别当成已验证。

## Common Rationalizations
| 借口 | 事实 |
|---|---|
| 写成 `.jsx` 更直观，`node --check` 报错就把扩展名换回去 | `node --check` 把 `.jsx` 当语法错误，平台里不认 JSX；视图必须写成 `h(type, props, ...children)` 元素对象才能真跑真断言。 |
| 就一个计数器，不用 reducer，直接存 state | 纯函数 reducer 才能被 `node --test` 真跑；组件内部 state 逻辑平台测不到，等于没验证。 |
| 数据就一个，不需要路由表，链接先手写 | 手写链接迟早断；`routes()` 是唯一真源，断链要由测试拦下。 |
| 内容是我们自己写的，不用转义 | 内容/接口文本一律先过 `esc()`，`javascript:` 协议与用户可控 `href`/`style` 必须白名单化。 |
| SEO 和无障碍写进文档就行 | 这些标签在元素对象层就能直接断言，落文档等于没人验证。 |

## Red Flags
- 模块里出现 JSX 或 `import react` / `import vite`。
- 组件里塞业务逻辑，时间/随机/网络直接调用（`Date.now()`、模块级可变单例）。
- 手写页面链接、没有 `routes()` 全站路由表；输出未转义文本或 `dangerouslySetInnerHTML`。
- 断言只写「包含 `<div>`」而不查元素对象的类型/文本/属性/子节点数。
- 在前端产物里塞密钥，或把浏览器行为（Lighthouse 指标等）当成已验证。

## Verification
- [ ] `node --test` 真跑通过，覆盖「数据 + reducer + 路由表 + 元素对象」四类纯函数模块。
- [ ] 视图由 `h(type, props, ...children)` 元素对象构成，仓库内无 JSX、无 `import react`/`vite`。
- [ ] reducer 为 `(state, action) => nextState` 纯函数，时间/随机/网络由入参注入、测试传假实现。
- [ ] 断链测试通过：每个 `href` 要么在 `routes()` 里，要么在外链白名单里。
- [ ] 元素对象层已断言 `<html lang>`、`<title>`、`<meta name="description">`、canonical、标题层级与图片 `alt`。
- [ ] 集成测试清单标明浏览器行为与 `vite build` 未在平台内真跑；已核实产物不含任何密钥。
