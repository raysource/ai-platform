---
name: dev-python
description: 定义 Python 模块开发规范（分层包结构、公开函数类型标注、Decimal 金额、异常层级、pathlib 路径、日志脱敏）并按本平台可执行形态（python3 + 标准库 unittest）把源码与测试真跑起来。当开发、评审或落地 Python 模块的包结构、数据建模、异常处理、日志与测试时使用；不适用于非 Python 项目的源码改动、纯架构或部署文档撰写。 Use when writing or reviewing Python standard-library modules.
metadata:
  stage: development
  tech: python
  label: 模块开发 · Python 规范
---

# Python 模块开发规范

## Overview
规定 Python 模块的包分层、数据建模、类型标注、金额/时间处理、异常与日志口径，并给出本平台内可被真执行验证的落地形态，让模块源码与测试都能被 `python3` 独立跑通。

## When to Use
- 适用：新建或改动 Python 模块、调整包结构、定义领域数据模型、写异常层级或日志、编写并运行模块测试。
- 不适用：非 Python 项目的源码改动；只写架构与部署文档、不落可执行模块的场景。

## Core Process

落地形态：本平台按技术栈判定语言档案 —— **Python 项目走 python3 + 标准库 unittest 真执行**：模块源码落 `src/<层>/<snake_case>.py`，测试落 `test/<层>/<名>.test.py`（把源码目录加进 `sys.path` 后 import，文件尾部 `unittest.main()`）。执行侧不装第三方包：**只用标准库**，Django/Flask/FastAPI/pytest 的写法用在架构与部署文档里。两者冲突时以平台可执行要求为准。

- 结构：包按职责分层（`domain`/`service`/`adapter`），业务规则是纯函数或纯类，不依赖框架；入口（CLI/web）只做参数解析与调用。
- 类型标注写在公开函数上（参数与返回值），数据用 `dataclass`/`pydantic` 显式建模，不用裸 dict 传递领域数据。
- 禁止可变默认参数（`def f(x=[])`）；需要默认就 `None` + 内部构造。
- 异常具体化：不写裸 `except:`/`except Exception: pass`；自定义异常层级（`DomainError` → 子类），错误信息带上下文（哪个实体、哪个字段）。
- 金额用 `decimal.Decimal`（显式精度与舍入 `ROUND_HALF_UP`），时间用带时区的 `datetime`（存 UTC、展示再转），不用 float 存金额。
- 文件路径用 `pathlib`，编码显式 `encoding="utf-8"`；不字符串拼路径。
- 依赖治理：`pyproject.toml`/`requirements.txt` 锁定版本，虚拟环境隔离；标准库优先，新增依赖要写理由。
- 测试用 `pytest`：`parametrize` 覆盖正常 + 边界（空/0/极值/重复）+ 错误分支，断言具体值；不依赖测试执行顺序与真实网络。
- 日志用 `logging`（结构化字段），不用 `print` 做输出；日志里不落密码/令牌/个人数据。

## Common Rationalizations
| 借口 | 事实 |
|---|---|
| 就一个 dict，先传着，回头再建模 | 裸 dict 的字段名靠约定，拼错要跑起来才炸；`dataclass`/`pydantic` 是几行的事，越晚补越贵。 |
| 金额用 float 也行，反正是示例 | float 有二进制舍入误差，金额路径必须 `Decimal` 且显式 `ROUND_HALF_UP`，示例会被复制到真实代码。 |
| 本地跑 pytest 通过了，够了 | 本平台执行侧只装标准库、不装 pytest；不被 `python3` + unittest 真跑的模块等于没验证。 |
| 这条异常先 `except Exception: pass` 吞掉 | 吞异常会让失败静默通过，测试假绿；该抛 `DomainError` 子类并带实体/字段上下文。 |
| 日志先 `print` 调试，后面换 `logging` | `print` 不进日志系统、丢了级别与结构化字段，且极易把密码/令牌打出去。 |

## Red Flags
- 出现 `def f(x=[])` 之类的可变默认参数，或裸 `except:` / `except Exception: pass`。
- 金额字段是 `float`，或时间不带时区（`datetime.now()` 而非存 UTC）。
- 公开函数没有参数与返回值类型标注，领域数据用裸 dict 传递。
- 路径靠字符串拼接、读写文件不带 `encoding="utf-8"`。
- 用 `print` 输出，或日志里出现密码/令牌/个人数据。

## Verification
- [ ] `python3 -m unittest`（或 `python3 test/<层>/<名>.test.py`）真跑通过，测试文件尾部有 `unittest.main()`。
- [ ] 测试只用标准库、把源码目录加进 `sys.path`，覆盖正常 + 边界（空/0/极值/重复）+ 错误分支并断言具体值。
- [ ] 公开函数均有参数与返回值类型标注，领域数据由 `dataclass`/`pydantic` 显式建模。
- [ ] 金额走 `decimal.Decimal` 且指定 `ROUND_HALF_UP`；时间存 UTC、带时区。
- [ ] 依赖锁定在 `pyproject.toml`/`requirements.txt`，新增依赖附理由。
- [ ] 日志走 `logging` 且已核实不含密码/令牌/个人数据。
