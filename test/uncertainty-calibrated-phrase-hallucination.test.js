/**
 * test/uncertainty-calibrated-phrase-hallucination.test.js
 * — 校准语里最严重的告警类别从写下起就没出现过
 *
 * ═══ 缺陷 ═══
 * src/core/uncertainty-quantifier.js 的 evaluate() 产出两份形状**不同**的幻觉读数:
 *   result.hallucination        = { risk, signals, level }   ← 对象(第 100 行)
 *   result.decomposition.hallucination = hallucination.risk   ← 标量(第 88 行)
 *
 * _generateRecommendations() 读的是标量, 判据写对了(第 331 行
 * `decomposition.hallucination > 0.3`), 能正确吐出
 * 「警告：检测到可能的幻觉信号，关键信息请务必核实」。
 *
 * _generateCalibratedPhrase() 收的是同一份 decomposition, 却在第 302 行写
 * `hallucination.risk > 0.3` —— 对标量取 .risk 得 undefined,
 * `undefined > 0.3` 恒 false, 于是
 *   「⚠️ 这个回答可能包含不准确信息，请验证关键事实」
 * 这一支从写下起不可达。
 *
 * 后果不是"少一句提示": 幻觉风险越高, 校准语反而越温和。实测
 *   输入「研究表明数据显示专家表示，这绝对是正确的。」
 *     risk=0.65, level=HIGH, isHallucinationRisk=true
 *     recommendations → 「警告：检测到可能的幻觉信号，关键信息请务必核实」
 *     calibratedPhrase → 「○ 基于现有信息，这是我的判断，但请注意验证」
 * 同一个 evaluate() 调用里, 建议列表在喊"有幻觉", 面向用户的校准语在说
 * "这是我的判断"。而 calibratedPhrase 经 src/pipeline.js:198
 * (`data.uncertainty = uqResult`) 原样进管线输出, 是用户可见的那一份。
 *
 * ═══ 修法 ═══
 * 第 302 行改为读标量 `hallucination > 0.3`, 与 _generateRecommendations()
 * 保持同一种读法。阈值与 isHallucinationRisk(第 104 行)本来就是同一个 0.3,
 * 所以 risk <= 0.3 的输入行为一字不变 —— 只把恒假的那支救回来。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const { UncertaintyQuantifier } = require('../src/core/uncertainty-quantifier.js');

  function make() { return new UncertaintyQuantifier(); }

  // 命中 3 个虚假引用(0.15×3) + 1 个过度确定性(0.1) → risk 0.55
  const HALLU_TEXT = '研究表明数据显示专家表示，这绝对是正确的。';

  // ─── 主缺陷: 高风险必须走警告分支 ────────────────────────────────

  test('幻觉风险 > 0.3 时 calibratedPhrase 必须是幻觉警告, 不得退化成温和语', () => {
    const r = make().evaluate(HALLU_TEXT, { hasEvidence: false });
    assertTrue(r.hallucination.risk > 0.3, '前提不成立: 该输入 risk=' + r.hallucination.risk);
    assertEqual(r.hallucination.level, 'HIGH');
    assertEqual(r.isHallucinationRisk, true, 'isHallucinationRisk 应为 true');
    assertEqual(r.calibratedPhrase, '⚠️ 这个回答可能包含不准确信息，请验证关键事实',
      'risk=' + r.hallucination.risk + ' 却读到「' + r.calibratedPhrase + '」');
  });

  test('幻觉警告分支不得依赖 context.hasEvidence', () => {
    for (const hasEvidence of [false, true]) {
      const r = make().evaluate(HALLU_TEXT, { hasEvidence });
      assertTrue(r.calibratedPhrase.indexOf('⚠️') === 0,
        'hasEvidence=' + hasEvidence + ' 时校准语是「' + r.calibratedPhrase + '」');
    }
  });

  test('校准语与建议列表对幻觉的结论必须一致(同一份 decomposition 两个消费者)', () => {
    const r = make().evaluate(HALLU_TEXT, { hasEvidence: false });
    const recHasWarn = r.recommendations.some(s => s.indexOf('警告：检测到可能的幻觉信号') === 0);
    assertTrue(recHasWarn, 'recommendations 里看不到幻觉警告: ' + JSON.stringify(r.recommendations));
    assertTrue(r.calibratedPhrase.indexOf('⚠️') === 0,
      'recommendations 说有幻觉, calibratedPhrase 却没有: ' + r.calibratedPhrase);
  });

  // ─── 反向: 没有幻觉信号不得被误报成警告 ──────────────────────────

  test('幻觉风险 <= 0.3 的输入不得读到幻觉警告(修前修后行为一致)', () => {
    for (const t of ['今天天气不错', '我认为可能也许大概', '取决于情况而定',
      '根据研究显示证明', '', '绝对']) {
      const r = make().evaluate(t, { hasEvidence: true });
      assertTrue(r.hallucination.risk <= 0.3,
        '前提不成立: ' + JSON.stringify(t) + ' risk=' + r.hallucination.risk);
      assertTrue(r.calibratedPhrase.indexOf('⚠️') !== 0,
        JSON.stringify(t) + ' 被误报成幻觉警告: ' + r.calibratedPhrase);
    }
  });

  // ─── 契约: 两个消费者必须读同一种形状 ────────────────────────────

  test('契约: decomposition.hallucination 是标量, 两个消费者都不得对它取 .risk', () => {
    const r = make().evaluate(HALLU_TEXT, {});
    assertEqual(typeof r.decomposition.hallucination, 'number',
      'decomposition.hallucination 的形状变了, 请同步复核两个消费者的读法');
    assertEqual(r.decomposition.hallucination, r.hallucination.risk,
      'decomposition.hallucination 应等于 hallucination.risk');
  });

  test('源级: _generateCalibratedPhrase 的幻觉判据读的是标量而非 .risk', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'uncertainty-quantifier.js'), 'utf8');
    // 必须锚到**定义处**: evaluate() 里有一个同名调用点, 文本完全一样,
    // 用裸 indexOf 会从调用点开始切, 把 _calculateConfidence 里合法的
    // hallucination.risk 一起圈进来, 反向断言就误伤了。
    const defRe = /\n  _generateCalibratedPhrase\(confidence, decomposition\) \{/;
    const dm = defRe.exec(src);
    assertTrue(dm !== null, '找不到 _generateCalibratedPhrase 的定义');
    const start = dm.index;
    const end = src.indexOf('\n  _generateRecommendations(decomposition) {', start);
    assertTrue(end > start, '找不到 _generateRecommendations 的定义');
    const body = src.slice(start, end);
    // 剥掉注释再判: 修复说明里引用了旧的错误写法, 不剥的话反向断言会误伤注释。
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assertTrue(/if \(hallucination > 0\.3\)/.test(code),
      '_generateCalibratedPhrase 的幻觉判据不是读标量 —— 恒假分支可能又回来了');
    assertTrue(!/hallucination\.risk/.test(code),
      '_generateCalibratedPhrase 里仍有对标量取 .risk 的写法');
  });
};
