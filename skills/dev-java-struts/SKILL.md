---
name: dev-java-struts
description: 规定 Java Struts2 + JDBC 模块的分层、Action 生命周期、PreparedStatement、事务边界、PRG、OGNL/JSP 安全与版本补丁约束，并按本平台可执行形态（javac/java 真编译、纯 JDK）落地。当开发、修改或评审 Struts2 + JDBC（含遗留系统迁移）模块时使用；不适用于 Spring Boot 模块、Node.js/Python 模块或纯架构文档写作。 Use when writing or reviewing Struts2 actions or JDBC code.
metadata:
  stage: development
  tech: java-struts
  label: 模块开发 · Java Struts2 + JDBC 规范
---

# 模块开发 · Java Struts2 + JDBC 规范

## Overview
Struts2 + 原生 JDBC 模块的分层契约与安全底线：Action/Service/DAO 职责、Action 生命周期、SQL 绑定参数、事务边界、PRG、OGNL/JSP 转义与 Struts2 版本补丁。本平台按技术栈判定语言档案，Java 项目走 `javac`/`java` 真编译执行，Struts2 的 Action/Result 与 Servlet API 只出现在架构与部署文档里。

## When to Use
- 适用：新建或修改 Java Struts2 + JDBC 模块；评审 Action/Service/DAO 分层、SQL 拼接、事务边界与 OGNL 安全。
- 适用：维护遗留 Struts2 系统、跟踪 Struts2 版本补丁与 CVE。
- 不适用：Java Spring Boot 模块（改用 `dev-java-springboot`）；Node.js 模块（`dev-nodejs`）。
- 不适用：只写架构与部署文档（那些文档里可以写 Action/Result 与 Servlet API）。

## Core Process
（落地形态：本平台按技术栈判定语言档案 —— **Java 项目走 javac/java 真编译执行**：模块源码落 `src/main/java/<层>/`，测试落 `src/test/java/<层>/M<NN>Test.java`（`main` + `check` + `tests/pass/fail` 三行 + 非 0 退出）。执行侧只有 JDK、没有 Maven 仓库：**只能用 JDK 标准库**，Struts2 的 Action/Result 与 Servlet API 写不进可执行模块，它们用在架构与部署文档里。两者冲突时以平台可执行要求为准。）

1. 分层：`Action`（取参、校验、选结果页）→ `Service`（业务规则 + 事务边界）→ `DAO`（SQL 与映射）；Action 里禁止写 SQL 与业务规则。
2. **Action 实例是每请求创建的，但不能靠实例字段攒状态**：不把 Service/DAO 存成可变实例字段参与并发；跨请求的东西一律走 request/session。
3. SQL 用 `PreparedStatement` + 绑定参数，禁止字符串拼接；动态条件用明确的白名单拼（列名/排序字段必须来自枚举常量）。
4. 事务边界放 Service：一个业务动作一个连接/一个事务；DAO 不自己提交（`setAutoCommit(false)` 由上层统一管）。
5. 结果页走 POST-Redirect-GET，避免刷新重复提交；列表页参数（分页/排序）显式校验范围。
6. 入参校验：Action 的 `validate()` 或 XML validator；失败回填字段并给中文错误，不用异常当流程控制。
7. OGNL/JSP 安全：`<s:property>` 必须转义，禁止把用户输入拼进 `%{...}`；JSP 里不写业务逻辑，只做展示与循环。
8. 版本与补丁：Struts2 历史上多次远程代码执行（CVE-2017-5638、CVE-2018-11776 等），必须锁定具体版本、跟踪官方公告、禁用不必要的插件与开发模式。
9. 测试：Service/DAO 用内存数据库或桩连接做单测；Action 用最小桩测「参数 → 结果码 + 回填」，断言具体错误信息。

## Common Rationalizations
| 借口 | 事实 |
|---|---|
| 「快点上线，SQL 先拼接，回头再改参数绑定」 | 拼接 SQL 是注入漏洞，且是全链路口径；改回来要动所有 DAO 调用点，先写对最省事。 |
| 「Action 是每请求 new 的，实例字段随便存」 | Action 生命周期不保证并发下安全语义，存可变实例字段参与并发就是竞态来源；跨请求状态必须走 request/session。 |
| 「OGNL 不转义没事，反正页面看不到」 | 历史上多次远程代码执行（CVE-2017-5638、CVE-2018-11776 等）就是从表达式注入进来；转义与禁插件是硬底线。 |
| 「校验失败直接抛异常给前端更快」 | 异常当流程控制会让错误信息与回填字段全部丢失；走 `validate()` / XML validator 才能回填并给中文错误。 |
| 「DAO 自己 commit 也一样」 | 事务边界必须在 Service，一个业务动作一个连接/一个事务；DAO 自行提交会拆散原子性。 |

## Red Flags
- Action 里出现 SQL、业务规则或可变实例字段承载跨请求状态。
- SQL 用字符串拼接，或动态列名/排序字段不是来自枚举常量白名单。
- DAO 内自行 `commit()`，或在 controller/Action 层开事务。
- `<s:property>` 未转义、用户输入被拼进 `%{...}`，或 JSP 里写业务逻辑。
- 依赖未锁定具体 Struts2 版本、未跟踪官方公告，或开着不必要的插件与开发模式。

## Verification
- [ ] `src/main/java/<层>/` 下源码可用 JDK 真编译：`javac` 通过、无第三方依赖。
- [ ] `src/test/java/<层>/M<NN>Test.java` 存在，`main` + `check`，打印 `tests/pass/fail` 三行并以非 0 退出表示失败。
- [ ] 门禁读到真实退出码为 0；Action 测试覆盖「参数 → 结果码 + 回填」，断言具体错误信息。
- [ ] 全仓 `PreparedStatement` 绑定参数覆盖所有 DAO；动态列名/排序字段来自枚举常量白名单。
- [ ] 事务只在 Service 开启（`setAutoCommit(false)` 由上层统一管），DAO 无 `commit()`。
- [ ] 目标 Struts2 版本已锁定，插件与开发模式按官方公告处理，OGNL/JSP 转义检查通过。
