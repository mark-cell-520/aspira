// [测试隔离] data/auto-rules.json 是跨测试文件共享的可变状态，而 run-all.js
// 并发执行多个测试文件——本文件与 auto-rules-cache.test.js 都改写它，互相
// 踩踏导致偶发失败(实测连跑全量偶发 4 条失败)。覆盖成本文件私有的临时文件。
// 必须在 require 之前设置: RULES_FILE 在模块加载时求值。
process.env.ASPIRA_AUTO_RULES_FILE = require('path').join(
  require('os').tmpdir(), 'aspira-auto-rules-test-' + process.pid + '.json');
const auto = require('../src/auto-rules.js');

module.exports = ({ test, assertEqual, assertTrue, assertDefined }) => {

  test('tryGenerate creates rule for high-recurrence category', () => {
    auto.clearRules();
    const stats = { total: 3, byCategory: { overconfidence: 3 }, highRecurrence: 1 };
    const r = auto.tryGenerate(stats);
    assertEqual(r.generated, 1);
  });

  test('checkAutoRules detects triggered rules', () => {
    auto.clearRules();
    const stats = { total: 3, byCategory: { overconfidence: 3 }, highRecurrence: 1 };
    auto.tryGenerate(stats);
    const r = auto.checkAutoRules('毫无疑问这是唯一正确的');
    assertTrue(r.triggered.length > 0);
  });

  test('checkAutoRules safe for clean text', () => {
    auto.clearRules();
    const stats = { total: 3, byCategory: { overconfidence: 3 }, highRecurrence: 1 };
    auto.tryGenerate(stats);
    const r = auto.checkAutoRules('今天天气真好');
    assertEqual(r.safe, true);
  });

  test('duplicate rule not generated twice', () => {
    auto.clearRules();
    const stats = { total: 3, byCategory: { overconfidence: 3 }, highRecurrence: 1 };
    auto.tryGenerate(stats);
    const r = auto.tryGenerate(stats);
    assertEqual(r.generated, 0);
  });
};
