# test/archive/tests-dir-orphans/ — 2026-10-13 从 tests/ 归档的七个文件

这些文件在 `tests/` 目录里，**被 git 跟踪，却从未被任何仪器执行过**。

## 为什么从未执行

`test/run-all.js` 的发现起点是 `TEST_DIR = __dirname`，即 `test/`。兄弟目录 `tests/`
**不在扫描范围内**。全仓 grep：`scripts/` 与 `.github/workflows/` 零引用。
`package.json` 的 `test` 写作 `node test/run-all.js || node tests/integration.test.js`
—— `||` 意味着 integration 只在门禁**失败**时才跑。

所以这 14 个文件（7 个有用的已移去 `test/`，7 个在此归档）的共性是：
**进了版本控制，因此看起来像有覆盖；从未被运行，因此坏成什么样都没人知道。**

## 逐个说明归档理由

| 文件 | 直接死因 | 目标模块在 git 里的记录 |
|---|---|---|
| `core.test.js` | `require('../src/code/code-executor.js')` MODULE_NOT_FOUND | 0 条（从未入库） |
| `memory-system.test.js` | 不测引擎——它在自己文件里定义了一个 50 行的 `TestMemorySystem`（Map 包装），测的是那个玩具类。文件名写着「记忆系统端到端流程」，实际与引擎记忆系统无关 | 不适用 |
| `v2_0_19.test.js` | 两层：① 从 `tests/legacy/` 里 `require('../src/core/heartflow.js')` 少写一层，解析到 `tests/src/`；② 即使补上，它还 require `src/core/blind-spot-breaker.js` | 0 条（从未入库） |
| `unit-async-queue.test.js` | 路径写成 `../../src/src/utils/async-queue.js`（多一层 `src`），且目标文件本身不存在 | 0 条（从未入库） |
| `unit-entity-extractor.test.js` | `src/memory/entity-extractor.js` 不存在；`EntityExtractor` 在 src/ 里只剩 heartflow.js:620 一个返回空数组的桩 | 0 条（从未入库） |
| `unit-memory-cache.test.js` | `src/utils/memory-cache.js` 不存在 | 0 条（从未入库） |
| `unit-code-verifier.test.js` | 不是死文件，是**更弱的重复品**：`test/code-verifier.test.js`（5 条断言）已在门禁里；本文件第 4 条用例「安全代码应通过」的函数体被整段注释掉，且末尾无条件 `console.log('code-verifier: PASSED ✅')` —— 除了 require 抛错，它不可能失败 | 不适用 |

## 「0 条（从未入库）」是什么意思

`git log --all -- <path>` 对这些模块返回空。它们从未进入过版本控制，
只存在于某个人本地磁盘上。所以这些测试**从干净克隆的那一刻起就是不可运行的**，
不是"后来模块被删了"的回归。这也是把它们归档而不是修的原因：
修好路径也指向一个不存在的模块。

## 有用的七个已移去 test/

`decision-routing` / `integration` / `decision-upgrade` / `heartflow-benchmark` /
`udah-field-tracking` / `unit/path-guard` / `decision-router-v3`。
其中 `decision-routing.test.js` 是抓住 `src/core/decision-router.js` 那个
`ReferenceError: activeRules is not defined` 的测试——修复前它 0/26 全红，
修复后 26/26。把它拉进门禁是这一轮的主要目的。
