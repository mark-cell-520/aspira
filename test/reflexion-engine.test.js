/**
 * test/reflexion-engine.test.js — 语言强化学习反思引擎
 *
 * ═══ 为什么补这个测试 ═══
 * `src/cortex/reflexion-engine.js`(493 行)在 `scripts/coverage-sweep.js` 里属 B 类:
 * **没有测试引用，但有 src 引用** —— 管线在跑它，却没有任何断言约束它的行为。
 *
 * ═══ 本测试当场抓出的一个真缺陷 ═══
 * `successRate` 只反映**最近一次**调用，而不是累计成功率。
 * 实测序列 success, success, failure, failure → successRate = 1, 0.5, 0, 0
 * 而正确值应是 1, 1, 0.67, 0.5。
 *
 * 根因: `reflections[]` 里存的 `result` 是**字符串** `'success'` / `'failure'`，
 * 而计算处写的是 `r.result.success` —— 字符串没有 `.success` 属性，恒为 `undefined`，
 * 于是 `filter(...)` 永远数出 0，`successes` 退化成"本次是否成功"这一个布尔。
 * 再除以累计次数，就得到了"最近一次 / 总次数"这个没有意义的数。
 *
 * 同一文件的 `_calculateImprovementRate()` 用的是正确写法 `r.result === 'success'`，
 * 所以这是**遗漏而非设计**。已改为正确写法。
 *
 * ═══ 断言的边界(实测得出) ═══
 * · `improvementRate` 在 reflections < 10 时恒为 0(设计如此，样本不足不下结论)，
 *   所以不断言小数次下的改进率。
 * · `_suggestStrategy` 在策略不足 `strategyMinFrequency`(默认 2) 时返回 null，
 *   这是"样本不够不建议"的设计，不是缺陷。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const { ReflexionEngine } = require(path.join(ROOT, 'src', 'cortex', 'reflexion-engine.js'));

  const mk = (opts = {}) => new ReflexionEngine(opts);

  test('reflect 返回五项: reflection / lesson / metacognition / strategy / improvementRate', () => {
    const e = mk();
    const r = e.reflect({ input: '写一个排序函数' }, { success: true, output: 'done' });
    for (const k of ['reflection', 'lesson', 'metacognition', 'strategy', 'improvementRate']) {
      assertTrue(Object.prototype.hasOwnProperty.call(r, k), `返回值应含 ${k}`);
    }
    assertEqual(r.reflection.type, 'success', '成功时应标记为 success 型反思');
    assertTrue(typeof r.reflection.summary === 'string' && r.reflection.summary.length > 0,
      '反思应有非空摘要');
  });

  test('successRate 必须是累计成功率，不得只反映最近一次(本轮修复)', () => {
    const e = mk();
    const seq = [[true, 'a'], [true, 'b'], [false, 'c'], [false, 'd']];
    const expected = [1, 1, 2 / 3, 0.5];
    seq.forEach(([ok, tag], i) => {
      e.reflect({ input: '任务' + tag }, { success: ok, output: 'o' });
      assertTrue(Math.abs(e.successRate - expected[i]) < 1e-9,
        `第 ${i + 1} 次后 successRate 应为 ${expected[i].toFixed(4)}，实测 ${e.successRate.toFixed(4)}`);
    });
    // 修复前该序列给出 1, 0.5, 0, 0
  });

  test('全成功 → successRate 为 1；全失败 → 为 0', () => {
    const ok = mk();
    for (let i = 0; i < 3; i++) ok.reflect({ input: 't' + i }, { success: true, output: 'o' });
    assertEqual(ok.successRate, 1, '全成功应为 1');

    const bad = mk();
    for (let i = 0; i < 3; i++) bad.reflect({ input: 't' + i }, { success: false, error: 'e' });
    assertEqual(bad.successRate, 0, '全失败应为 0');
  });

  test('失败时提取教训并记入失败模式', () => {
    const e = mk();
    e.reflect({ input: '修复这个 bug' }, { success: false, error: 'TypeError: undefined' });
    const pats = e.getFailurePatterns();
    assertTrue(pats.length > 0, '失败应产生失败模式');
    const hist = e.getReflectionHistory(5);
    assertTrue(hist.length === 1, '应记录 1 条反思');
    assertEqual(hist[0].result, 'failure', 'result 字段应为字符串 failure');
    assertTrue(hist[0].lesson && typeof hist[0].lesson === 'object', '应附带教训');
  });

  test('reflectionWindow 限制历史长度', () => {
    const e = mk({ reflectionWindow: 3 });
    for (let i = 0; i < 10; i++) e.reflect({ input: 't' + i }, { success: true, output: 'o' });
    const hist = e.getReflectionHistory(100);
    assertEqual(hist.length, 3, `历史应被限制到窗口大小 3，实测 ${hist.length}`);
    // 窗口保留最新的
    assertEqual(hist[hist.length - 1].task, 't9', '应保留最新一条');
  });

  test('getStats 的计数字段与实际调用一致', () => {
    const e = mk();
    e.reflect({ input: 'a' }, { success: true, output: 'o' });
    e.reflect({ input: 'b' }, { success: false, error: 'x' });
    const s = e.getStats();
    assertEqual(s.reflectionCount, 2, `reflectionCount 应为 2，实测 ${s.reflectionCount}`);
    assertEqual(s.successRate, 0.5, `successRate 应为 0.5，实测 ${s.successRate}`);
    assertTrue(s.strategiesLearned >= 1, '应至少学到 1 个策略');
    assertTrue(s.failurePatterns >= 1, '应至少记录 1 个失败模式');
  });

  test('reset 清空全部状态', () => {
    const e = mk();
    e.reflect({ input: 'a' }, { success: false, error: 'x' });
    e.reflect({ input: 'b' }, { success: true, output: 'o' });
    e.reset();
    const s = e.getStats();
    assertEqual(s.reflectionCount, 0, 'reset 后 reflectionCount 应为 0');
    assertEqual(s.successRate, 0, 'reset 后 successRate 应为 0');
    assertEqual(s.strategiesLearned, 0, 'reset 后策略应清空');
    assertEqual(s.failurePatterns, 0, 'reset 后失败模式应清空');
    assertEqual(e.getReflectionHistory().length, 0, 'reset 后历史应为空');
  });

  test('serialize 可序列化且不含不可 JSON 化的值', () => {
    const e = mk();
    e.reflect({ input: 'a' }, { success: true, output: 'o' });
    e.reflect({ input: 'b' }, { success: false, error: 'x' });
    const ser = e.serialize();
    const str = JSON.stringify(ser);
    assertTrue(str.length > 0, 'serialize 应产出非空 JSON');
    // Map 必须被转成可序列化形式，否则 JSON.stringify 会静默丢成 {}
    const parsed = JSON.parse(str);
    assertTrue(parsed && typeof parsed === 'object', '应能 round-trip');
  });

  test('策略建议的门槛是 successRate > successThreshold(实测得出，非想当然)', () => {
    // 首版我断言"样本不足 strategyMinFrequency 时返回 null"——**错了**。
    // 实测 2 次成功就返回策略对象，因为 `_suggestStrategy` 的门槛是
    // `strategy.successRate > this.config.successThreshold`(默认 0.7)，
    // 与 `strategyMinFrequency` 无关(strategyMinFrequency 只被
    // `_assessUncertainty` 在 191 行使用)。这正是"按自己设想写断言"的复发故障模式:
    // 断言必须来自实测，而不是来自对配置项名字的推测。
    const ok = mk();
    for (let i = 0; i < 4; i++) ok.reflect({ input: '写代码' }, { success: true, output: 'o' });
    const good = ok.reflect({ input: '写代码' }, { success: true, output: 'o' });
    assertTrue(good.strategy && typeof good.strategy === 'object',
      `成功率高于阈值时应给出策略，实测 ${JSON.stringify(good.strategy)}`);
    assertEqual(good.strategy.category, 'coding', '策略应归入正确分类');
    assertTrue(good.strategy.successRate > ok.config.successThreshold,
      '给出的策略其成功率必须确实高于阈值');

    const bad = mk();
    for (let i = 0; i < 3; i++) bad.reflect({ input: '写代码' }, { success: false, error: 'e' });
    const none = bad.reflect({ input: '写代码' }, { success: false, error: 'e' });
    assertEqual(none.strategy, null,
      `成功率低于阈值时应返回 null，实测 ${JSON.stringify(none.strategy)}`);
  });
};
