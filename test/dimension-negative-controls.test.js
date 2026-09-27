/**
 * test/dimension-negative-controls.test.js — 薄覆盖维度的近邻负对照
 *
 * 保护对象：15 个只有 1 个测试文件的维度(实测分布 1:15 2:25 3:5 4:4 5:2 6:1 18:1 27:1)。
 *
 * 与 test/dimension-firing.test.js 的分工：
 *   firing      测试证明"该抓的能抓"——防模式失效
 *   本文件      证明"不该抓的不抓"——防模式被改宽
 * 两者缺一不可。只有 firing 的维度，模式可以无限放宽而不会有任何测试叫住；
 * 那正是本轮查出 dehumanization 误报的原因。
 *
 * 方法论(同 firing，重犯过同一错误)：
 *   探针必须是"近邻"——与该维度模式共享词汇或结构，但语义正常。
 *   本轮实测发现两类陷阱：
 *   (a) moral_foundations 是**道德基础词汇分类器**，不是违规检测器。
 *       "从公平角度考虑"点名了 foundation 名称，命中是正确行为。
 *       首版探针因此误报——是探针错，不是模式错。
 *   (b) dehumanization 的 /这些(?:人|家伙|货色|垃圾人)/i 是**真误报**：
 *       裸短语"这些人"即判非人化，而"这些人应当受到公正审判"是在伸张正义。
 *       同组其它模式都要求贬义谓语，只有这一条没有。已修。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
const { discriminate } = require('../src/index.js');

// 维度 -> 近邻负例(语义正常，但与该维度模式共享词汇/结构)
const NEAR_MISS = {
  double_bind: ['你可以选择离开，也可以选择留下，两者都可以。'],
  info_deprivation: ['我暂时没有全部数据，但可以说明已知部分。'],
  false_urgency: ['这件事这周内完成比较好，不着急。'],
  // 注意: moral_foundations 是词汇分类器，负例必须**不点名任何基础名称**
  // (公平/关爱/忠诚/权威/纯洁/自由)。点名即命中，那是正确行为而非误报。
  moral_foundations: ['这个方案的收益和成本需要再核算。', '我们先看数据再下结论。'],
  dehumanization: ['这些人需要我们的帮助。', '感谢这些人的付出。', '这些人的意见都很中肯。'],
  // 注: "数据显示转化率提升了 12%。"曾被选作负例，实测 gate=rewrite。
  // 那不是误报——"数据显示"是无来源的笼统归因、"12%"是无引证的精确数字，
  // 引擎 guidance 正是"补充可验证的数据来源"，行为正确。是探针选错了。
  // 真正的负例应含明确来源或样本量。
  bullshit_recognition: ['根据内部周报，本周转化率为 12%。', '实验组转化率 12%，对照组 9%，样本各 500。'],
  victim_blaming: ['她受到了伤害，我们需要追责加害方。'],
  // 注: "我们应该尊重不同的文化背景。"曾被选作负例。dogwhistle 本身 count=0(正确)，
  // 但 gate=verify——"尊重"命中 moral_foundations 的权威/颠覆词汇表(severity 20)，
  // 叠加 ai_writing_tell(35)后聚合分越过阈值。moral_foundations 是**词汇分类器**，
  // 命中即正确；门禁对道德判断性文字建议"降低道德判断语气"也是设计行为。
  // 这不是缺陷，但说明门禁级负例必须避开道德基础词汇，否则测的是门禁而非本维度。
  dogwhistle: ['不同地区有不同的风俗习惯。', '不同文化对礼貌的定义不同。'],
  false_equivalence: ['这两件事性质不同，不能相提并论。'],
  hasty_generalization: ['我见过三个这样的人，样本还太小。'],
  slippery_slope: ['这个改动有风险，需要评估影响范围。'],
  appeal_to_authority_boost: ['这位专家的论证有数据支撑，可以采纳。'],
  social_norm: ['在那个场合，多数人选择了安静。'],
  pseudo_profundity: ['这个问题的关键在于资源分配。'],
  premature_termination: ['结论如下，依据分三点说明。'],
};

// 这些维度用 count 之外的字段承载命中数
const SCORE_FIELD = { sycophancy: 'totalHits', evidence: 'issues' };

function hitCount(dim, d) {
  if (!d) return -1;
  if (d.count != null) return d.count;
  if (dim === 'reasoning_coherence') {
    return (d.score > 0 || (d.issues && d.issues.length > 0)) ? 1 : 0;
  }
  const f = SCORE_FIELD[dim];
  if (f && d[f]) {
    if (Array.isArray(d[f])) return d[f].length;
    if (typeof d[f] === 'string' && d[f] !== 'no_text') return 1;
  }
  return d.totalHits || (d.issues && d.issues.length) || 0;
}

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('每个薄覆盖维度的近邻负例都不得命中', () => {
    for (const [dim, probes] of Object.entries(NEAR_MISS)) {
      for (const p of probes) {
        const r = discriminate(p, []);
        const n = hitCount(dim, r.dimensions[dim]);
        assertEqual(n, 0, `维度误报: ${dim} (探针="${p}", count=${n})`);
      }
    }
  });

  test('dehumanization 不再把中性"这些人"当非人化', () => {
    // 这一条对应一个真实修复: /这些(?:人|家伙|货色|垃圾人)/i 曾裸匹配"这些人"。
    // 回归防护: 若有人把该模式改回无谓语形式，这里立刻失败。
    //
    // 注: 「这些人应当受到公正审判。」的 dehumanization count 也是 0(修复生效)，
    // 但它的 gate.action 是 verify——因为"公正"命中了 moral_foundations
    // (severity 20)，叠加 ai_writing_tell(35)把聚合分推到 0.91。
    // moral_foundations 是**词汇分类器**，命中"公正"是正确行为；门禁据此建议
    // "降低道德判断语气"也是设计行为。故该句不作为门禁负例，只作维度负例。
    const neutral = ['这些人需要我们的帮助。', '感谢这些人的付出。', '这些人应当受到公正审判。'];
    for (const t of neutral) {
      const r = discriminate(t, []);
      assertEqual(r.dimensions.dehumanization.count, 0, `中性表述被误判非人化: ${t}`);
    }
  });

  test('dehumanization 仍能抓住真正的非人化', () => {
    // 修误报不得顺手造成漏报——这是本仓库反复出现的教训:
    // 一个误报可能一直在伪装成漏报的补丁。
    const bad = [
      '你们这些人根本不配活着，应该全部清除',
      '你们这些人是社会渣滓',
      '你们这些人应该被清除',
      '这些人就是垃圾',
      '这些家伙简直是废物',
      '这些人不算人',
    ];
    for (const t of bad) {
      const r = discriminate(t, []);
      assertTrue(r.dimensions.dehumanization.count > 0, `真非人化漏报: ${t}`);
    }
  });

  test('近邻负例不得触发门禁升级', () => {
    // 维度命中为 0 还不够——还要确认门禁动作也是 pass。
    for (const [, probes] of Object.entries(NEAR_MISS)) {
      for (const p of probes) {
        const r = discriminate(p, []);
        const act = r.gate && r.gate.action;
        assertTrue(act === 'pass' || act === undefined,
          `近邻负例被门禁升级: ${act} (探针="${p}")`);
      }
    }
  });
};
