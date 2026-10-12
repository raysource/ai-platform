---
name: dev-static-site
description: 定义无构建、零第三方依赖的静态网站开发规范，并按本平台可执行形态把内容做成数据、模板做成纯函数、页面做成字符串，用 node --test 真跑数据聚合/渲染/路由/分页/SEO meta/i18n。当开发或评审纯 HTML 静态站的数据与模板、路由表、转义、分页排序、SEO 与无障碍时使用；不适用于带构建工具链或 React+Vite 的站点（见 dev-react-vite）或需要在平台内真跑浏览器交互脚本的场景。 Use when building a plain HTML/CSS/ES-module static site.
metadata:
  stage: development
  tech: static
  label: 模块开发 · 静态网站规范
---

# 静态网站规范

## Overview
规定无构建静态站的数据/模板分离、模板纯函数、转义防 XSS、路由表真源、分页排序、SEO 与无障碍产物、资源归属，并给出本平台内可被 `node --test` 真执行验证的落地形态。

## When to Use
- 适用：开发或评审无构建纯 HTML 静态站的内容数据、模板函数、路由与链接、分页排序、SEO meta 与 i18n 模块。
- 不适用：使用构建工具链或 React + Vite 的站点，改用 `dev-react-vite`；需要在平台内真跑浏览器交互脚本的场景。

## Core Process

落地形态：执行侧只有 Node 标准库 + `node --test`，**没有 npm install、没有打包器、不能引 CDN**。所以静态站在本平台的**可执行形态**是「模板是纯函数、内容是数据、页面是字符串」—— 数据聚合、模板渲染、路由与链接、分页、SEO meta、i18n 都写成零依赖 ESM 模块并被真跑；真正的 CSS / 字体 / 图片 / 构建工具（Astro / Hugo / 11ty / Vite）落进**架构与部署文档**，不进可执行模块，也不要在模块里 import 外部资源。

- **数据与模板分开**：`content`（纯数据对象）→ 模板函数 `(data) => html 字符串` → 页面拼装（模板 + 数据 + 路由）→ 构建遍历路由出全站。文案/链接/条目都属于数据，**不要写死在模板函数里**。
- **模板函数必须纯**：同输入同输出；不读全局、不取 `Date.now()`/`Math.random()`——时间与随机由参数注入，否则测试不可重复。
- **转义即安全（静态站第一大坑）**：任何来自数据或用户的文本进 HTML 前一律过 `esc()`（`& < > " '`），属性值必须带引号；**禁止**把未转义数据拼进 `<script>`、`on*=`、`href="javascript:"`；URL 只允许白名单协议（http/https/mailto/相对路径）。
- **产物可断言**：每个页面函数至少一条测试断言**具体产物**——`<title>` 文本、`<meta name="description">`、canonical、`<h1>` 唯一、当前页在导航里带 active。不要只断言「包含 `<div>`」。
- **路由表是唯一真源**：一个 `routes()` 产出全站 `{path, title, template}`；页面间链接由它生成。断链用测试拦：每个 `href` 要么在路由表里，要么在外链白名单里。
- **分页 / 列表 / 排序**：分页参数 `{page, perPage}` 由调用方传入，返回 `{items, total, hasNext}`；排序写显式比较器（`Array#sort` 默认按字符串序，数值/日期会排错）。
- **SEO 与无障碍是产物的一部分，也要断言**：`<html lang>`、语义标签（header/nav/main/footer）、标题层级不跳级、图片 `alt`、表单 `label`——这些在模块里就能测，别只写进文档。
- **样式与资源只管自己的目录**：CSS 写 `assets/`，不在模板里嵌大段行内样式；压缩、合并、CDN、部署脚本属于部署阶段，不塞进模块。
- **静态化不免测试**：平台内真跑的是「数据 + 渲染 + 路由」；浏览器交互脚本（轮播、表单提交）要在文档/集成测试清单里标明**未在平台内真跑**，别当成已验证。
- **零第三方依赖**：图标用内联 SVG 或字符，字体走系统字体栈；需要外部资源时写进部署文档，不写进可执行模块。

## Common Rationalizations
| 借口 | 事实 |
|---|---|
| 文案和链接直接写在模板字符串里更省事 | 数据与模板必须分开；写死后无法复用与测试，文案/链接/条目都属于 `content` 数据。 |
| 内容都是我们自己写的，不用转义 | 数据一进 HTML 就得过 `esc()`（`& < > " '`），未转义数据拼进 `<script>`/`on*=`/`href="javascript:"` 就是 XSS。 |
| 断言 `html.includes('<div>')` 就够了 | 要断言具体产物：`<title>` 文本、`<meta name="description">`、canonical、`<h1>` 唯一、导航 active。 |
| 排序直接 `arr.sort()` 就行 | `Array#sort` 默认按字符串序，数值/日期会排错；必须写显式比较器。 |
| SEO 和无障碍写进文档即可 | 这些标签在模块里就能断言，落文档等于没人验证。 |

## Red Flags
- 模板函数里读全局、取 `Date.now()`/`Math.random()`，或把文案/链接写死在模板里。
- 输出未转义文本，或把数据拼进 `<script>`/`on*=`/`href="javascript:"`；属性值不带引号。
- 手写页面链接、没有 `routes()` 全站路由表；排序用默认 `Array#sort`。
- 在模块里 import 外部资源（CDN、字体、图标库）而非零依赖 ESM。
- 断言只写「包含 `<div>`」，或把浏览器交互脚本当成已验证。

## Verification
- [ ] `node --test` 真跑通过，模块为零依赖 ESM，覆盖「数据 + 渲染 + 路由」。
- [ ] 模板函数为纯函数：同输入同输出，时间/随机由参数注入，文案/链接来自 `content` 数据。
- [ ] `esc()` 覆盖 `& < > " '` 并已用于所有数据文本，URL 走白名单协议（http/https/mailto/相对路径）。
- [ ] 每个页面函数至少一条断言具体产物（`<title>`、`<meta name="description">`、canonical、`<h1>` 唯一、导航 active）。
- [ ] 断链测试通过：每个 `href` 要么在 `routes()` 里，要么在外链白名单里。
- [ ] 集成测试清单标明浏览器交互脚本与外部资源未在平台内真跑。
