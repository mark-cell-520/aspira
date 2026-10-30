/**
 * 新愿自主升级补的 TDD (counterfactual-verifier, 未测试模块)
 */
const CounterfactualVerifier = require('../src/core/counterfactual-verifier.js');

module.exports = function ({ test, assertEqual, assertTrue, assertFalse, assertDefined }) {
  test('CounterfactualVerifier 是构造函数且含 verify/getStats', () => {
    assertTrue(typeof CounterfactualVerifier === 'function', '应为构造函数');
    const c = new CounterfactualVerifier();
    assertTrue(typeof c.verify === 'function', 'verify 应为函数');
    assertTrue(typeof c.getStats === 'function', 'getStats 应为函数');
  });

  // ── [反事实验证接线] reasoning/verifier.js 的消费侧接线 ──
  // 这条用例钉住的是一个从写下起就没通过过的接线: Verifier 里
  // require('./counterfactual-verifier.js') 路径指向 src/reasoning/(该处无此文件),
  // 且把 class 当零参工厂调用、又读命名导出 .CounterfactualVerifier,
  // 三层叠错的结果是 this.counterfactualVerifier 恒为 null,
  // 反事实验证整段不可达。修好后此处才可能为非 null。
  const { Verifier } = require('../src/reasoning/verifier.js');

  test('Verifier 默认路径必须真正装上 counterfactualVerifier', () => {
    const v = new Verifier();
    assertTrue(v.counterfactualVerifier !== null,
      'counterfactualVerifier 仍为 null —— 反事实验证那一步依然是死代码');
    assertTrue(typeof v.counterfactualVerifier.verify === 'function',
      '装上的对象没有 verify 方法');
    assertTrue(v.counterfactualVerifier instanceof CounterfactualVerifier,
      '装上的不是 CounterfactualVerifier 实例');
  });

  test('Verifier 必须读取构造器声明过的 options.counterfactualVerifier', () => {
    // 实例注入
    const byInstance = new Verifier({ counterfactualVerifier: new CounterfactualVerifier() });
    assertTrue(byInstance.counterfactualVerifier instanceof CounterfactualVerifier,
      '显式注入实例被无视');
    // class 注入
    const byClass = new Verifier({ counterfactualVerifier: CounterfactualVerifier });
    assertTrue(byClass.counterfactualVerifier instanceof CounterfactualVerifier,
      '显式注入 class 被无视');
    // 命名导出形状注入
    const byNamed = new Verifier({ counterfactualVerifier: { CounterfactualVerifier } });
    assertTrue(byNamed.counterfactualVerifier instanceof CounterfactualVerifier,
      '显式注入命名导出形状被无视');
  });

  test('注入垃圾值不得炸，也不得顶掉默认实现', () => {
    const v = new Verifier({ counterfactualVerifier: 42 });
    assertTrue(v.counterfactualVerifier instanceof CounterfactualVerifier,
      '注入非对象时应回落到默认实现');
  });

  test('有 alternatives 时反事实验证必须真的跑起来', async () => {
    const v = new Verifier();
    const r = await v.verifyCrossDomainConclusion({
      text: '我们应当全面推进该方案。',
      alternatives: [
        { conclusion: '方案甲', evidence: [{ type: 'a' }, { type: 'b' }], risks: ['r1'] },
        { conclusion: '方案乙', evidence: [{ type: 'a' }, { type: 'b' }], risks: ['r1'] }
      ]
    }, { mode: 'analogical' });

    assertTrue(r.counterfactualResult !== null,
      'counterfactualResult 恒为 null —— 第 3 步反事实验证没有执行');
    assertDefined(r.counterfactualResult.margin, '结果里没有 margin');
    assertEqual(typeof r.counterfactualResult.margin, 'number', 'margin 不是数值');
    assertFalse(r.counterfactualResult.verified,
      '两个等分备选应当判不出边际(margin 应为 0)');
    assertEqual(r.counterfactualResult.margin, 0, '等分备选的 margin 应为 0');
  });

  test('反事实验证不通过时必须推出 counterfactual_margin_low', async () => {
    const v = new Verifier();
    const r = await v.verifyCrossDomainConclusion({
      text: '我们应当全面推进该方案。',
      alternatives: [
        { conclusion: '方案甲', evidence: [{ type: 'a' }, { type: 'b' }], risks: ['r1'] },
        { conclusion: '方案乙', evidence: [{ type: 'a' }, { type: 'b' }], risks: ['r1'] }
      ]
    }, { mode: 'analogical' });

    const hit = r.issues.find(i => i.type === 'counterfactual_margin_low');
    assertTrue(!!hit, 'counterfactual_margin_low 这条 issue 从未被推出过');
    assertEqual(hit.severity, 'medium', '严重度应为 medium');
    assertDefined(hit.result, 'issue 里没带反事实结果');
  });

  test('没有 alternatives 时反事实验证应保持跳过', async () => {
    const v = new Verifier();
    const r = await v.verifyCrossDomainConclusion({ text: '一句普通结论。' }, { mode: 'analogical' });
    assertEqual(r.counterfactualResult, null, '无备选时不该跑反事实验证');
  });
};
