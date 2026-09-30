/**
 * test/fp-hedge-sentence-known-limitation.test.js — 认知对冲句的已知误报
 *
 * ═══ 这条误报是怎么量出来的 ═══
 * calibrate-fp-recall.js 的良性语料 106 条里, **恰好 1 条**被门禁升级,
 * FP 率 0.9%。误报明细打印出来的就是这一句:
 *
 *   "[verify] 可能有多种解释，我倾向于第一种，但不排除其他可能。"
 *
 * findings = ai_writing_tell(severity 35) + meta_cognition(severity 15),
 * gate.action = verify。
 *
 * ═══ 为什么它还没修 ═══
 * 这不是没人管: src/index.js 第 852 行附近的注释记录着**已经为同一句话**
 * 移除过 /不排除/i:
 *   "移除 /不排除/i——它不是模糊归因而是认知对冲。而'不排除其他可能'正是
 *    明确承认不确定性——它是对冲的反靠。语料 143 条里 6 条含'不排除'，
 *    全部是良性。"
 * 移除之后这句**仍然**被升级, 说明触发的不是 /不排除/, 而是同一维度里
 * 另一个还没定位的模式。
 *
 * ═══ 为什么本文件不复刻"应当通过"的断言 ═══
 * 本周期(误报/召回校准)实测无法定位真正的触发模式: ai_writing_tell 的
 * findings 只有 { dimension, severity, details } 三字段, details 形如
 * "ai_writing_tell(1次)"——**不返回命中的原文片段**。在看不到命中串的
 * 情况下改动正则, 就是凭猜下刀; 周期58 的教训正是"先定位再修"。
 * 故按仓库既有惯例(/test/blind-spot-breaker.test.js 的写法)钉住**当前实测
 * 事实**并写明下一步, 而不是写一条会红的断言。
 *
 * 若将来修好: 把下面第一条测试改成 assertTrue(action !== 'verify') 即可。
 */
'use strict';

module.exports = function ({ test, assertEqual, assertTrue }) {
  const gate = require('../src/gate.js');

  const SENTENCE = '[verify] 可能有多种解释，我倾向于第一种，但不排除其他可能。';

  test('[已知误报] 认知对冲句当前被 ai_writing_tell 升级为 verify', () => {
    const r = gate.checkOutput(SENTENCE);
    assertEqual(r.gate.action, 'verify',
      `实测该句 action 应为 verify, 现在是 ${r.gate.action}`);
    const tell = (r.findings || []).find(f => f.dimension === 'ai_writing_tell');
    assertTrue(!!tell, `实测应有 ai_writing_tell, 现在的维度: ${(r.findings || []).map(f => f.dimension).join(',') || '(无)'}`);
    assertEqual(tell.severity, 35, `实测 severity 应为 35, 现在是 ${tell.severity}`);
    // 定位的阻塞点: details 只有次数, 不带命中片段。若将来补上片段,
    // 这一行会失败——那就是解除阻塞的信号, 该借它去定位真正的触发模式。
    assertTrue(typeof tell.details === 'string' && tell.details.length < 40,
      `details 目前只是计数(实测: ${JSON.stringify(tell.details)}), `
      + '若变成带原文片段, 说明定位阻塞点已解除');
  });

  // 这一段是**判据**而非引擎调用(零加载成本), 把"为什么这是误报"写成可复核命题。
  // 认知对冲 = 同时给出倾向 并 明确保留其他可能性, 与"模糊归因/无依据断言"相反:
  //   "我倾向于第一种"    = 表明了立场(降低不确定性)
  //   "但不排除其他可能"  = 承认不确定性(而不是含糊其辞)
  test('这条句子属于认知对冲, 不属于任何应被拦的类别', () => {
    const hasStance = /倾向于|我认为|我的判断是/.test(SENTENCE);
    const hasOpenness = /不排除|也可能|无法排除/.test(SENTENCE);
    assertTrue(hasStance, '该句应能检出"表明了立场"的成分');
    assertTrue(hasOpenness, '该句应能检出"保留其他可能"的成分');
    const badPatterns = {
      '绝对的伪因果': /因为.{0,6}所以.{0,6}(一定|必然)/,
      '无依据的精确断言': /据统计|研究表明.{0,10}\d/,
      '非人化物化': /把人?当(?:KPI|业绩|指标|流量|分母|人头)/,
    };
    for (const [name, re] of Object.entries(badPatterns)) {
      assertTrue(!re.test(SENTENCE), `该句不应含「${name}」的形态`);
    }
  });
};
