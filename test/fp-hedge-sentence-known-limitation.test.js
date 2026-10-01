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

  // [周期60→63 事实变更] 本条原为"[已知误报]"——那时该句被 ai_writing_tell
  // 以 severity 35 升级为 verify, 而 findings.details 只给次数、不给定中片段,
  // 无法定位是哪个模式。周期63 绕过 findings 直接探模块, 定位到真凶:
  // shield/ai-writing-tell.js 的 INVISIBLE_HOMOGLYPH 第二式
  //   /[^\x00-\x7F\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g
  // 只放行 ASCII 与 CJK **表意文字**, 于是所有中文标点都被当成"不可见同形字"。
  // 实测误报: 。(U+3002) 「」(U+300C/D) 《》(U+300A/B) …(U+2026) ——(U+2014)。
  // 修法: 补入 \u3000-\u303f / \uff00-\uffef / \ufe30-\ufe4f /
  //       \u2018-\u201d / \u2013-\u2014 / \u2026, 刻意不含 \u2000-\u206F。
  // 量得效果: 语料 FP 0.9% → 0.0%, 明文召回维持 41/41。
  test('认知对冲句现在不得被 ai_writing_tell 升级(周期63 已修)', () => {
    const r = gate.checkOutput(SENTENCE);
    assertEqual(r.gate.action, 'pass',
      `修复后该句应放行, 现在是 ${r.gate.action}`);
    const dims = (r.findings || []).map(f => f.dimension);
    assertTrue(!dims.includes('ai_writing_tell'),
      `修复后不应再有 ai_writing_tell, 现在有: ${dims.join(',')}`);
  });

  // 修复的**边界**: 真正该抓的字符必须仍然被抓到。
  // 这两条是防"修 FP 把召回一起打下去"的护栏——周期56 曾这样翻过车。
  // 这一条钉住修复的**边界**: 规范中文标点必须一个 findings 都不产生。
  // 这是"修 FP 没有顺手把该抓的也放掉"的直接护栏。
  test('规范中文标点不得产生任何 ai_writing_tell findings', () => {
    const tell = require('../src/shield/ai-writing-tell.js');
    const clean = '正常中文。标点「测试」《用例》，分号；冒号：问号？感叹！省略……破折——';
    const r = tell.detect(clean);
    assertEqual((r.findings || []).length, 0,
      `规范中文标点应零 findings, 实测 ${JSON.stringify(r.findings)}`);
    assertEqual(r.count, 0, `count 应为 0, 实测 ${r.count}`);
  });

  // ⚠️ 已知局限(本周期新测出, 不在本轮修复范围): detect() 内部会先跑
  // normalizeText(), 而它把 U+200B 等零宽字符**直接删掉**——于是第一式
  // (INVISIBLE_HOMOGLYPH 的零宽字符表)在 detect() 路径上永远不会命中。
  // 即"零宽字符注入"这一攻击面目前实际是漏的。这里钉住这个事实, 提醒下轮:
  // 要修就得让 detect() 在 normalizeText **之前**先看一眼原文。
  test('[已知局限] 零宽字符会被 normalizeText 先吃掉, 第一式形同虚设', () => {
    const tell = require('../src/shield/ai-writing-tell.js');
    const zwsp = 'hello\u200Bworld';
    assertEqual(tell.normalizeText(zwsp), 'helloworld',
      `normalizeText 应已删掉零宽空格, 实测 ${JSON.stringify(tell.normalizeText(zwsp))}`);
    assertEqual((tell.detect(zwsp).findings || []).length, 0,
      '经 normalizeText 后零宽字符已消失, 故 detect() 抓不到它');
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
