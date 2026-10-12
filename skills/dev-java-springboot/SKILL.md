---
name: dev-java-springboot
description: 规定 Java Spring Boot 模块的分层、DTO、注入、事务、校验、异常、配置与测试约束，并按本平台可执行形态（javac/java 真编译、纯 JDK）落地。当开发、修改或评审 Spring Boot 模块的分层与事务边界时使用；不适用于 Java Struts2 + JDBC 栈、Node.js/Python 模块或纯架构文档写作。 Use when writing or reviewing Spring Boot modules.
metadata:
  stage: development
  tech: java-springboot
  label: 模块开发 · Java Spring Boot 规范
---

# 模块开发 · Java Spring Boot 规范

## Overview
Java Spring Boot 模块的分层契约与落地约束：分层、DTO 边界、构造器注入、事务位置、校验、异常收敛、配置外置、时间/金额类型与测试分层。本平台按技术栈判定语言档案，Java 项目走 `javac`/`java` 真编译执行，因此这些规则必须同时满足平台可执行要求。

## When to Use
- 适用：新建或修改 Java Spring Boot 模块；评审 controller/service/repository 分层、事务边界、DTO 与实体分离。
- 适用：为 Java 模块补测试、排分层违规或硬编码配置问题。
- 不适用：Java Struts2 + JDBC 栈（改用 `dev-java-struts`）；Node.js 模块（`dev-nodejs`）。
- 不适用：只写架构、部署与迁移文档（那些文档里可以写 Spring Boot 注解与起步依赖）。

## Core Process
（落地形态：本平台按技术栈判定语言档案 —— **Java 项目走 javac/java 真编译执行**：模块源码落 `src/main/java/<层>/`，测试落 `src/test/java/<层>/M<NN>Test.java`（`main` + `check(name, ok)` + 打印 `tests/pass/fail` 三行 + `System.exit(fail==0?0:1)`），门禁读的是真实退出码。执行侧只有 JDK、没有 Maven 仓库：**只能用 JDK 标准库**，Spring Boot 注解与起步依赖写不进可执行模块，它们用在架构、部署与迁移文档里。两条冲突时以平台可执行要求为准。）

1. 分层固定：`controller`（只做协议转换与校验）、`service`（事务与业务规则）、`repository`（持久化）、`domain`（实体与值对象），调用顺序不可跨层反转；禁止 controller 直接调 repository。
2. 对外 DTO 与持久化实体分离，禁止把 Entity 直接当接口出入参；转换用显式 mapper 方法。
3. 依赖注入一律构造器注入（字段 `@Autowired` 禁止），Bean 保持无状态；单例里不放请求级数据。
4. 事务只在 service 公有方法上（`@Transactional`），不要在 controller 或 repository 上开事务；跨服务调用不进同一事务。
5. 校验走 `@Valid` + 约束注解（`@NotNull/@Size/@Pattern`），业务规则校验放 service，失败抛领域异常。
6. 异常统一由 `@ControllerAdvice` 收敛成错误码枚举 + HTTP 状态码，禁止把堆栈或 SQL 回给调用方。
7. 配置全部来自 `application.yml` + `@ConfigurationProperties`（含默认值），不硬编码地址/端口/密钥。
8. 时间用 `java.time`（存 UTC），金额用 `BigDecimal`（指定 scale 与 RoundingMode），ID 用 UUID 或数据库序列。
9. 测试分层：纯逻辑单测（不起 Spring 上下文）、`@WebMvcTest`/MockMvc 测协议、`@DataJpaTest` 测持久化；断言具体值而非「不为空」。

## Common Rationalizations
| 借口 | 事实 |
|---|---|
| 「就一个 controller，直接注入 repository 省一层」 | 分层是本技能的硬契约；绕过 service 意味着事务与业务规则没有落点，后续加规则要回头拆。 |
| 「字段注入写起来短」 | 字段 `@Autowired` 让依赖不可见、测试要反射注入；构造器注入既满足无状态约束也可直接 new 出被测对象。 |
| 「注解写不进模块，那这些规则就不用管」 | 平台可执行要求只约束「什么能编译进模块」，分层、DTO、事务语义这些设计约束照样成立，只是体现在源码结构与文档里。 |
| 「先不对齐 `java.time`/`BigDecimal`，能跑就行」 | 时间/金额类型一旦用错，后面改回来要动全链路；平台测试阶段会以断言具体值的形式暴露。 |
| 「测试断言不为空就够了」 | 「不为空」几乎不失败；必须是具体值的断言，否则门禁退出码无法区分真通过。 |

## Red Flags
- controller 里出现 repository 调用、SQL 或事务注解。
- Entity 直接作为接口出入参，或缺少显式 mapper 方法。
- 出现字段级 `@Autowired`，或在单例 Bean 里存请求级数据。
- 地址、端口、密钥硬编码在源码里，而非 `application.yml` + `@ConfigurationProperties`。
- 测试里只断言「不为空」，或模块测试没有 `check(...)` 与 `tests/pass/fail` 三行输出。

## Verification
- [ ] `src/main/java/<层>/` 下源码可用 JDK 真编译：`javac` 通过、无第三方依赖。
- [ ] `src/test/java/<层>/M<NN>Test.java` 存在，`main` + `check(name, ok)`，打印 `tests/pass/fail` 三行并以 `System.exit(fail==0?0:1)` 收尾。
- [ ] 门禁读到真实退出码为 0（非 0 即失败，不接受「跑过就算」）。
- [ ] 分层检查无违规：controller 不直接调 repository，事务只在 service 公有方法上。
- [ ] 配置项全部来自 `application.yml` + `@ConfigurationProperties`（含默认值），源码无硬编码地址/端口/密钥。
- [ ] 时间/金额/ID 类型符合 `java.time`（UTC）、`BigDecimal`（带 scale 与 RoundingMode）、UUID 或数据库序列。
