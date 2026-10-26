'use strict';
/**
 * crowdtest-evaluate detail.blocks 回归测试
 *
 * 钉住的缺陷形状（与近几轮 output-checklist 九处维度明细、memory-integrity
 * criticalAnomalies 同族）：消费侧对产出侧已经折算过的值再折算一次。
 *
 * acceptance-checker 的 return 里 blocks 已经是 { key: 字符数 }：
 *   blocks: Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, v.length]))
 * 而 evaluate-answer 的 detail.blocks 又写了一遍 (v || '').length。
 * 数字没有 .length，(21 || '').length === undefined，JSON.stringify 会把
 * undefined 值的键整个丢掉 —— 于是 detail.blocks 从写下起恒为 {}，
 * MCP 工具 aspira_crowdtest_evaluate 与 CLI 的调用方拿不到任何区块长度。
 *
 * 修前：detail.blocks === {}（六个键全部 undefined 被序列化丢弃）。
 * 修后：六个键齐全，且数值与 acceptance-checker 自己报的字符数一致。
 */
const a = require('../src/crowdtest/acceptance-checker.js');
const ev = require('../src/crowdtest/evaluate-answer.js');

const GOOD = `【结论】本周期下滑主要发生在访客获取环节，其次是详情页转化环节。
【依据】M1 : 访客数下降导致销售额下降 → 访客是主因。M2 : 转化率同步下滑。
【拆解】访客获取 | 17.4 | M1 分日销售表访客列
转化环节 | 8.8 | M1 转化率列
【行动】投放负责人 / 14 天内 / 日预算占比降到 ≤20% / 看次周 ROI 是否回到 1.5
运营负责人 / 30 天内 / 断货天数降到 ≤5 天 / 看次月缺货率
【缺口】缺分 SKU 退货原因明细；缺用户分层数据。
【自评】高置信：访客下滑，三处入口均指向同一方向。
[自检A] 引用条数：2   [自检B] 【缺口】与【自评】非空：是   [自检C] 【行动】条数：2、四要素齐全：是`;

module.exports = function ({ test, assertTrue, assertEqual }) {
  test('detail.blocks 六个键齐全且为有限数', () => {
    const r = ev.evaluate(GOOD, { runGate: false });
    const keys = Object.keys(r.detail.blocks);
    assertEqual(keys.length, 6, '六个区块键应齐全, got: ' + JSON.stringify(r.detail.blocks));
    for (const k of keys) {
      const v = r.detail.blocks[k];
      assertTrue(typeof v === 'number' && Number.isFinite(v),
        `blocks.${k} 应为有限数, got: ${typeof v} ${v}`);
    }
  });

  test('detail.blocks 与 acceptance-checker 自报的字符数逐键相等', () => {
    const formal = a.check(GOOD);
    const r = ev.evaluate(GOOD, { runGate: false });
    for (const [k, v] of Object.entries(formal.blocks)) {
      assertEqual(r.detail.blocks[k], v,
        `blocks.${k} 应与 acceptance-checker 一致(${v}), got ${r.detail.blocks[k]}`);
    }
  });

  test('无格式答案的 detail.blocks 是全 0 而不是空对象', () => {
    const r = ev.evaluate('我认为这次下滑主要是因为访客变少了。', { runGate: false });
    assertEqual(r.verdict, 'FAIL', '无格式答案应 FAIL');
    const keys = Object.keys(r.detail.blocks);
    assertEqual(keys.length, 6, '区块缺失时也应给出六个 0, got: ' + JSON.stringify(r.detail.blocks));
    assertTrue(Object.values(r.detail.blocks).every(v => v === 0),
      '缺失区块长度应报 0, got: ' + JSON.stringify(r.detail.blocks));
  });
};
