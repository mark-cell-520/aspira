'use strict';
/**
 * crowdtest-evaluate MCP handler 兜底分支的键名契约测试
 *
 * 钉住的缺陷: handler 的两条兜底分支(空答案 / 判分器抛异常)返回的是另一套
 * 中文键 { 判定, 硬失败项, 需人工陪审 }, 而成功路径返回
 * { verdict, hardFail, needsHumanReview, ... }。调用方按成功路径的契约读
 * result.verdict, 在兜底分支上一律得到 undefined —— "判分器自己炸了"和
 * "答案不合格"在消费侧看起来都是"没有 verdict"。
 *
 * 修前: 空答案路径的 .verdict === undefined, 且 '判定'/'硬失败项'/'需人工陪审'
 *       三个中文键全仓无任何读取方(grep 实证), 属于单向丢失。
 * 修后: 三条路径(成功 / 空答案 / 判分器异常)都给出 verdict + hardFail,
 *       兜底体还多带一个 judgeSelfError 说明"这不是对被测模型的判决"。
 */
const handle = require('../src/mcp/handlers/crowdtest-evaluate.js');

const GOOD = `【结论】本周期下滑主要发生在访客获取环节。
【依据】M1 : 访客数下降导致销售额下降 → 访客是主因。M2 : 转化率同步下滑。
【拆解】访客获取 | 17.4 | M1 分日销售表访客列
【行动】投放负责人 / 14 天内 / 日预算占比降到 ≤20% / 看次周 ROI 是否回到 1.5
【缺口】缺分 SKU 退货原因明细。
【自评】高置信：访客下滑。
[自检A] 引用条数：2   [自检B] 【缺口】与【自评】非空：是   [自检C] 【行动】条数：1、四要素齐全：是`;

module.exports = function ({ test, assertEqual, assertTrue }) {
  test('空答案路径给出 verdict=FAIL（而不是中文键 判定）', () => {
    const r = handle({ answer: '' });
    assertEqual(r.verdict, 'FAIL', '空答案应报 verdict=FAIL, got: ' + JSON.stringify(r.verdict));
    assertTrue(Array.isArray(r.hardFail) && r.hardFail.length > 0, '应列硬失败项');
    assertTrue(r.hardFail.some(x => x.includes('未提供答案')), '应说明是未提供答案: ' + r.hardFail.join('|'));
  });

  test('判分器抛异常时 verdict 仍是 FAIL 且说明是判分器故障', () => {
    // 让 evaluate() 内部抛: requiredCounts 的读取发生在 handler 的 try 里,
    // 用 getter 抛错即可真实走一遍最外层 catch(不改动被测模块)。
    const poison = {
      answer: GOOD,
      get requiredCounts() { throw new Error('boom'); },
    };
    const r = handle(poison);
    assertEqual(r.verdict, 'FAIL', '判分器异常应报 verdict=FAIL, got: ' + JSON.stringify(r.verdict));
    assertTrue(r.hardFail.some(x => x.includes('判分器异常')), '应说明判分器异常: ' + r.hardFail.join('|'));
    assertTrue(r.hardFail.some(x => x.includes('boom')), '应带上原始错误信息: ' + r.hardFail.join('|'));
    assertTrue(typeof r.needsHumanReview.judgeSelfError === 'string' && r.needsHumanReview.judgeSelfError.length > 0,
      '应明确这不是对被测模型的判决');
  });

  test('三条路径的键名集合互相兼容（兜底体是成功体的子集加一个说明键）', () => {
    const ok = handle({ answer: GOOD, runGate: false });
    const empty = handle({ answer: '   ' });
    for (const k of ['verdict', 'hardFail', 'needsHumanReview']) {
      assertTrue(k in ok, `成功路径应有 ${k}`);
      assertTrue(k in empty, `空答案路径也应有 ${k}, got keys: ${Object.keys(empty).join(',')}`);
    }
    // 兜底体不得残留中文旧键
    for (const k of ['判定', '硬失败项', '需人工陪审']) {
      assertTrue(!(k in empty), `空答案路径不应再返回旧中文键 ${k}`);
      assertTrue(!(k in ok), `成功路径不应出现 ${k}`);
    }
  });
};
