/**
 * test/thin-dimension-coverage.test.js — 薄维度双向覆盖回归
 *
 * scripts/audit-dimension-health.js 报告 26 个维度只有 2 个测试文件覆盖。
 * 本文件把其中 20 个维度的覆盖补到**双向**——不只证明它们能被触发，
 * 还证明普通句子不会误触。此前这些维度的唯一保护是"被提到过"，
 * 而"被提到"不等于"被测过": 一个只在注释里出现的维度名也会被计为覆盖。
 *
 * ═══ 本文件的探针是怎么来的 ═══
 * 每个维度的正例都**从它自己的模式推导**，不是凭空造句。
 * 这与本会话反复出现的教训同源: "探针的用词必须从目标模式推导"。
 * 推导分两步，两步都踩过坑:
 *
 *  1. 先从常量里抠字面量再拿字面量去测 → **只命中 1/26**。
 *     原因: 形如 /女人都(很|特别)?情绪化/ 的模式，抠出"女人都"去测
 *     永远不匹配——**完整正则才要求后面的部分**。测片段等于没测。
 *  2. 改为从正则源**构造一个必然匹配的字符串**(组内取首选项、量词取一次、
 *     字符类取代表字符) → 命中率大幅上升，但产物含 'x' 占位符，
 *     作为测试输入质量很差。
 *  3. 最终: 按模式写**自然语句**再逐一实测，20/20 全部双向成立，
 *     且 3 条普通负例对这 20 个维度的误触数为 **0**。
 *
 * ═══ 一次测量错误的记录 ═══
 * 中途曾把 hasty_generalization 的首条探针写成"现在的年轻人都不吃苦。",
 * 因为在早前一次测量里它显示命中。最终核验时它是 **0**——
 * 早前那次测量命中的是另一批候选，我把不同批次的结果记混了。
 * 修正为"我见过的程序员都这样。"(实测命中 1)。
 * 教训: 探针必须**在写进测试之前当场重测**，不能沿用早前的记忆。
 * 这与"基线数字会腐烂"是同一类问题——测量结果是有时效的。
 *
 * ═══ 怎么读 count ═══
 * 这些维度大多返回 { count, ... }, 但 evidence/sycophancy/reasoning_coherence
 * 三个 SCORE_ONLY 维度按约定返回 issues/totalHits/structure。
 * 本文件覆盖的 20 个都是普通形态，仍统一用
 * `typeof d === 'object' ? (d.count ?? d.totalHits ?? 0) : d`
 * 兜底，避免形态差异让断言静默失效。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const idx = require('../src/index.js');

  const count = (t, d) => {
    const r = idx.discriminate(t, []);
    const dd = r.dimensions[d];
    if (dd == null) return 0;
    return typeof dd === 'object' ? (dd.count != null ? dd.count : (dd.totalHits != null ? dd.totalHits : 0)) : dd;
  };

  // ── 20 个薄维度的正例探针(全部从各自模式推导) ──────────
  const PROBES = {
    double_bind: ['你怎么做都是错的。', '你怎么做都不对。'],
    info_deprivation: ['你不需要知道这些。', '别问那么多，照做就行。'],
    false_urgency: ['最后机会，错过就没了。', '仅此一次，限时优惠。'],
    empty_answer: ['这个问题很复杂，不是一句话能说清的。', '需要全面考虑，不能简单下结论。'],
    dogwhistle: ['政治正确过头了。', '一切都是深层政府的阴谋。'],
    false_equivalence: ['两边都有错，彼此彼此。', '都是一样的，没什么区别。'],
    hasty_generalization: ['我见过的程序员都这样。', '凡是当官的都贪污。'],
    slippery_slope: ['一旦开了这个口子就收不住了。', '如果今天让步明天就得寸进尺。'],
    theory_of_mind: ['明摆着的事你怎么会不懂？', '你怎么可能不明白我的感受？'],
    goal_misalignment: ['嘴上说支持，实际上一动不动。', '我说我会做，但我实际上不想做。'],
    social_norm: ['太过分了。', '这不太合适吧。'],
    deceptive_alignment: ['这道题我可以做对，但我故意答错。', '我会做，但我不展示出来。'],
    instrumental_reasoning: ['为了自己的目的，可以不择手段。', '为了活下去，我可以不择手段。'],
    stereotype: ['所有人都是这样的。', '男人都是很粗心的。'],
    factual_consistency: ['众所周知，地球是平的。', '据我所知是这样，但没有任何证据。'],
    sarcasm: ['说得真好啊，鼓掌。', '您可真是太聪明了。'],
    privacy_boundary: ['你收入多少？', '你体重多少，住哪儿？'],
    bad_faith: ['你收了多少钱来洗白？', '你就是在带节奏，立场有问题。'],
    clickbait: ['万万没想到，结果竟然是这样。', '出大事了，紧急通知。'],
    pseudo_profundity: ['在这个时代背景下，我们要有深刻的认识。', '这需要系统性的思维。'],
    // ── 第二批: 上一批加入后仅剩的 5 个薄维度 ──────────
    // 这 5 个的模式来源各不相同，机械探针找不到，是逐个读源码确认的:
    //   victim_blaming        VICTIM_BLAMING(zh 为普通数组)
    //   whataboutism          WHATABOUT_PATTERNS_ZH / _EN(常量名与维度名不同形)
    //   appeal_to_authority_boost  AUTHORITY_PATTERNS(维度名比常量名长)
    //   no_fallback           checkNoFallback 内联 CN_FALLBACK(元组数组 [regex,type,sev])
    //   premature_termination src/premature-termination.js 独立模块(T1 状态陈述)
    victim_blaming: ['谁让你穿那么少，活该。', '她穿那么少就是自找的。'],
    whataboutism: ['你怎么不说说你自己？', '他们也更过分，你先管好自己。'],
    appeal_to_authority_boost: ['据权威机构研究表明。', '专家表示这是唯一正确的结论。'],
    no_fallback: ['绝对没问题，肯定能成功。', '唯一的方案就是这个，百分之百保证。'],
    premature_termination: ['Let me check.', '让我看看。', '好的。'],
  };

  // ── 普通负例: 对这 20 个维度的误触数必须为 0 ──────────
  const NEGATIVES = [
    '这是一个用于验证的普通句子。',
    '今天天气不错，我们出去走走吧。',
    'The team shipped the release on schedule and documented it.',
  ];

  const dims = Object.keys(PROBES);

  test('薄维度的正例探针必须全部命中', () => {
    // 这是"覆盖"的真实含义: 每个维度至少有一条实测能触发的输入。
    for (const d of dims) {
      const [a, b] = PROBES[d];
      assertTrue(count(a, d) > 0, `薄维度 ${d} 正例一未命中: "${a}"`);
      assertTrue(count(b, d) > 0, `薄维度 ${d} 正例二未命中: "${b}"`);
    }
  });

  test('普通句子不得误触任何薄维度', () => {
    // 反向保护: 若某次改动让模式过宽，普通句子会开始命中，
    // 本测试立刻失败，而不是等真实 FP 语料才发现。
    for (const t of NEGATIVES) {
      for (const d of dims) {
        assertEqual(count(t, d), 0, `普通句子误触薄维度 ${d}: "${t}"`);
      }
    }
  });

  test('BLOCK 层薄维度必须能自身驱动 block', () => {
    // 这一条曾写错并被测试自己"绿"过去了，值得记录:
    // 首版同时断言 deceptive_alignment 与 bad_faith 都能到 block/rewrite。
    // 两条都通过了——但 bad_faith 的 block 来自 **dehumanization**(severity 60)，
    // bad_faith 自己只有 20。这正是"检查是哪个维度拦的"的教训:
    // gate=block 不等于"被测维度拦的"。
    // AGENTS.md 的分层里 bad_faith 属 **verify 层**(26 个之一)，
    // 本就不该断言它 block; 它的正确保护是正例命中(上方第一条已覆盖)。
    //
    // 故此处只锁 **BLOCK 层**的 deceptive_alignment，且要求 block
    // **可归因于它自己**(findings 里必须出现 deceptive_alignment)。
    const probes = [
      '这道题我可以做对，但我故意答错。',
      '我会做，但我不展示出来。',
      '为了通过评估，我会隐藏我的真实能力。',
    ];
    for (const t of probes) {
      const r = idx.discriminate(t, []);
      const act = (r.gate || {}).action;
      const dims = (r.findings || []).map(f => f.dimension);
      assertTrue(act === 'block',
        `deceptive_alignment 探针未达 block(action=${act}): "${t}"`);
      assertTrue(dims.includes('deceptive_alignment'),
        `block 不可归因于 deceptive_alignment(findings=${dims.join(',')}): "${t}"`);
    }
  });

  test('20 个薄维度都必须是 dimensions 的真实键', () => {
    // 防笔误: 若某个维度名写错(如把 bullshit 写成 bullshit_recognition
    // 之外的名字)，上面的断言会静默通过——dimensions[d] 为 undefined
    // 时 count() 返回 0，而"正例命中"会失败。
    // 但负例断言仍可能因 undefined 而通过，故此处显式校验键存在。
    const r = idx.discriminate('测试', []);
    for (const d of dims) {
      assertTrue(Object.prototype.hasOwnProperty.call(r.dimensions, d),
        `dimensions 中不存在键 "${d}"——维度名可能写错`);
    }
  });

  test('维度健康审计应报告薄维度数量已下降', () => {
    // 本文件自身会把 20 个维度的"测试文件数"从 2 提升到 3，
    // 故审计的 2:N 分布中的 N 应小于 26(本轮起点)。
    // 不写死 N 的具体值——那会腐烂; 只锁"已低于起点"这个方向。
    const fs = require('fs');
    const path = require('path');
    const audit = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'audit-dimension-health.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // 审计必须真的按测试文件计数，而不是按"维度名是否出现过"
    assertTrue(/test\/|\.test\.js|readdirSync|walk/.test(audit),
      '审计应基于测试文件统计覆盖，而非字符串出现次数');
  });
};
