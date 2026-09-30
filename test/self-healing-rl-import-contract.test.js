/**
 * test/self-healing-rl-import-contract.test.js
 *
 * 第三十九轮 —— HealingMemoryRL.import() 的合同锁定(plain 自述风格)。
 *
 * ═══ 为什么测这个 ═══
 * `src/cortex/self-healing-rl.js`(1779 行)在 coverage-sweep 的 B 类里:
 * 没有测试引用，但有 src 引用 —— 管线在跑它，却没有任何断言说它该怎样工作。
 * 本轮探它，`import()` 当场露出两种失效方向**同时存在**:
 *   · import(null) / import(undefined) → 裸 TypeError
 *     "Cannot read properties of null (reading 'qTable')" —— 报的是引擎内部
 *     细节，与"调用方给错了"这件事实无关;
 *   · import({}) / import([]) / import("s") / import(42) → **静默无操作**，
 *     返回 undefined，调用方无从得知"什么都没导进去"。
 *
 * 一个在安全输入上崩溃、在垃圾输入上沉默的合同，比直接抛错更糟:
 * 它把"导入了"和"没导入"变得无法区分 —— 结构合法、内容为空，
 * 正是本仓库反复记录的失败形状。
 *
 * ═══ 本测试的风格说明 ═══
 * 第一版用了 node:test 的 test()，run-all 把它判成 plain 风格后裸跑，
 * 用例数为 0 —— **一个从未被收集的锁，与一个不存在的锁无法区分**。
 * 改为本仓的 plain 自述风格(let passed/failed + exitCode)。
 */
'use strict';

const { HealingMemoryRL } = require('../src/cortex/self-healing-rl.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}
function throwsContract(fn, msg) {
  try { fn(); failed++; console.log('  ✗ ' + msg + ' (未抛错)'); }
  catch (e) {
    const good = e instanceof TypeError && /expects an export object/.test(e.message);
    if (good) { passed++; console.log('  ✓ ' + msg); }
    else { failed++; console.log('  ✗ ' + msg + ' (错了异常: ' + e.message.slice(0, 50) + ')'); }
  }
}

const mk = () => new HealingMemoryRL({});
function seeded() {
  const h = mk();
  h.setContext({ domain: 'repair', severity: 'high' });
  h.updateFromRepair('ETIMEDOUT', 'retry', true);
  h.updateFromRepair('ETIMEDOUT', 'fallback', false);
  h.updateFromRepair('ECONNREFUSED', 'escalate', true);
  return h;
}

// ① 真往返: 导入后必须恢复 Q 表**与行为**
{
  const a = seeded();
  const ex = a.export();
  const b = mk();
  const r = b.import(ex);
  ok(r && r.imported === true, '标准导出物导入应被如实确认');
  // 注意 qEntries 数的是**上下文键**条目数, 不是策略-Q 对数:
  // seeded() 三次 updateFromRepair 只产生 2 个不同的 context key
  // (ETIMEDOUT@… / ECONNREFUSED@…)，其中 ETIMEDOUT 下有两个策略。
  // 第一版断言 qEntries >= 3, 把自己对指标口径的误读当成了引擎缺陷。
  ok(r && r.qEntries === 2, `应导入 2 个上下文键(实际 ${r && r.qEntries})`);
  const inner = [...b.qTable.values()].reduce((n, v) => n + Object.keys(v).length, 0);
  ok(inner === 3, `应导入 3 个策略-Q 对(实际 ${inner})`);
  const best = b.getBestStrategy('ETIMEDOUT');
  const bestA = a.getBestStrategy('ETIMEDOUT');
  // ── [第四十六轮] 本测试是 audit 间歇性红灯的真凶, 已定位并修 ──
  // getBestStrategy 是 **ε-greedy**: 实测 epsilon=0.1, 即约 10% 的调用
  // 返回 mode:'explore' 并**随机**挑一个策略。我原来断言
  //   best.strategy === 'retry'                             (约 90% 通过)
  //   best.qValue === bestA.qValue                          (约 90% 通过)
  // 两条都建立在随机路径上, 所以连续八个周期里 audit 约每三次红一次
  // (tests=1416/1), 而这条 flaky 是我自己在周期39 引进来的。
  // **一个断言在随机路径上的测试, 与一个断言错误的测试无法区分。**
  // 改法: 断言确定性表面(getRankedStrategies 与 qTable), 把随机的那一层
  // 只作为"能取回 retry 或任一策略"的弱断言保留。
  const ranked = b.getRankedStrategies('ETIMEDOUT');
  const rankedA = a.getRankedStrategies('ETIMEDOUT');
  ok(ranked.length === rankedA.length && ranked.every((r, i) =>
    r.strategy === rankedA[i].strategy && r.qValue === rankedA[i].qValue),
    '导入后排序表应逐位一致(确定性表面, 不受 ε-greedy 影响)');
  ok(ranked[0].strategy === 'retry' && ranked[0].qValue > ranked[1].qValue,
    '学到的 retry 应排在首位');
  ok(best && ['retry', 'fallback'].includes(best.strategy),
    'getBestStrategy 应返回已知策略之一(ε-greedy 允许探索, 故不指定是哪个)');
}

// ② null/undefined 不再抛内部错误, 且如实回报
for (const empty of [null, undefined]) {
  const b = mk();
  let r;
  try { r = b.import(empty); } catch (e) { ok(false, `import(${String(empty)}) 不应抛内部错误: ${e.message.slice(0, 40)}`); continue; }
  ok(r && r.imported === false && r.reason === 'no-data', `import(${String(empty)}) 应回报 no-data 而非崩溃`);
}

// ③ 垃圾输入得到明确合同错误, 不再是静默无操作
for (const bad of [[], 'string', 42, true]) {
  throwsContract(() => mk().import(bad), `import(${JSON.stringify(bad)}) 应被合同明确拒绝`);
}

// ④ 空对象导入如实回报 0 条, 而不是伪装成功
{
  const b = mk();
  const r = b.import({});
  ok(r && r.imported === true && r.qEntries === 0 && r.history === 0,
    '空对象应如实回报导入了 0 条(而不是静默或伪装)');
  ok(b.qTable.size === 0, '空对象导入后 qTable 应为空');
}

// ⑤ 原型污染: 外部数据不得借 import 改写原型
{
  const b = mk();
  const evil = JSON.parse('{"qTable":{"x":{"retry":1}},"constructor":{"polluted":1}}');
  b.import(evil);
  ok(({}).polluted === undefined, 'Object.prototype 不得被污染');
  ok(b.constructor.polluted === undefined, 'constructor 不得被污染');
  ok(b.qTable.size === 1, '合法键仍应正常导入');
}

console.log(`\n  测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
if (failed > 0) process.exitCode = 1;
