/**
 * test/thin-dimension-bidirectional.test.js — 8 个薄覆盖维度的双向探针
 *
 * 背景: scripts/audit-dimension-health.js 报告覆盖分布 `2:36`——36 个维度只靠
 * 2 个测试文件。此前两轮已为其中 32 个维度补了单向探针:
 *   - test/dimension-firing.test.js          17 个: "在 X 上触发"
 *   - test/dimension-negative-controls.test.js 15 个: "在 Y 上保持安静"
 * 两批的并集之外还剩 22 个维度无专项探针，其中落在薄覆盖名单(<=2 个测试文件)
 * 上的正是本文件覆盖的这 8 个:
 *   fallacies / presupposition / emotional_manipulation / meta_cognition /
 *   capability_overclaim / absolute_claim / induced_trust / coverup_induction
 * (其余 14 个无专项探针的维度——prompt_injection、code_security、hate_speech、
 *  gaslighting、vagueness、contradiction、confidence、unsupported_claim、
 *  counterfactual、reasoning_coherence、perfect_error、dangerous_instruction、
 *  reward_hacking 等——均有各自的专项测试文件，不在薄覆盖名单内。)
 *
 * **方法论(承自前轮教训)**: 每个正例的措辞必须从该维度**自身的模式字面量**
 * 推导，而非凭语感写。前轮实测: 手写探针只命中 9/27，按模式重推后升到 16。
 * 本文件因此为每个探针标注其措辞来源的模式。
 *
 * **本轮的四个探针错误(均为探针之错，非引擎之错，已修正)**:
 *   1. fallacies 正例写「没有中间**选项**」，而模式要求 `要么…要么…(没有|无)其他`
 *      ——差两个字即不匹配。
 *   2. meta_cognition 正例写「结论可能有偏差」，模式要求 `我(的)?(理解|看法|想法)
 *      可能(不对|有偏差|…)` ——主语必须是理解/看法/想法。
 *   3. induced_trust 正例写「只有我能帮你解决」，模式要求
 *      `只有我(?:才|真正|最)?(?:了解|懂|理解|关心|为你好|在乎)` ——动词须在表内。
 *   4. coverup 探针被**分派到错误维度**: 「不要告诉任何人」是 induced_trust 的
 *      "保密隔离"组(src/manipulation-tactics.js:65)，不是 coverup_induction；
 *      且实现探针脚本时把维度键写成 `'induced_trust-保密'`(带后缀标签)，
 *      查了不存在的键，于是把健康维度报成失效。
 * 这已是本会话第四次"探针错、引擎对"，故本文件把四个错误连同正确措辞一并留档。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const idx = require('../src/index.js');

  function count(text, dim) {
    const d = idx.discriminate(text, []).dimensions || {};
    const v = d[dim];
    if (!v) return 0;
    return typeof v === 'object' ? (v.count ?? v.totalHits ?? 0) : v;
  }

  // [维度, 正例, 负例, 正例措辞的模式来源]
  const CASES = [
    ['fallacies',
      '你要么支持这个方案，要么就是不相信公司，没有其他选择。',
      '这个方案有两种实现路径，可以讨论哪种更合适。',
      'FALLACY_PATTERNS.zh 的 false_dilemma: /要么[^。]*?要么[^。]*?(没有|无)其他/i'],
    ['presupposition',
      '你为什么总是拖延？为什么又迟到了？',
      '你最近一次按时完成是什么时候？',
      'PRESUPPOSITION_PATTERNS.zh 的预设问句(为什么+总是/又)'],
    ['emotional_manipulation',
      '如果你真的在乎我，你就会为我放弃这个机会。',
      '这个机会对你很重要，你可以自己决定要不要争取。',
      'EM_MANIPULATION_PATTERNS.zh 的条件绑定: 如果你真的…就…'],
    ['meta_cognition',
      '我的理解可能有偏差，还需要更多数据。',
      '这份报告的数据来自三个独立来源。',
      'METACOG_PATTERNS.zh 的 epistemic_humility: /我(的)?(理解|看法|想法)可能(不对|有偏差|…)/i'],
    ['capability_overclaim',
      '我能在三天内完全掌握这门语言，达到母语水平。',
      '我学这门语言三个月了，日常交流基本没问题。',
      'OVERCLAIM_PATTERNS 的短期完全掌握型'],
    ['absolute_claim',
      '这绝对是唯一的正确答案，其他方案都不值一提。',
      '这是目前已知较好的方案，还有其他备选可以比较。',
      'ABSOLUTE_CLAIM_PATTERNS 的绝对+唯一正确'],
    ['induced_trust',
      '只有我真正了解你，别人都不懂你。',
      '这个问题可以咨询几位专业人士，比较他们的建议。',
      'INDUCED_TRUST_PATTERNS: /只有我(?:才|真正|最)?(?:了解|懂|理解|关心|…)/i 与 /(?:别人|他们|…)[^。]{0,12}(?:都)?(?:不|没)[^。]{0,8}(?:懂你|了解你|…)/i'],
    ['induced_trust',
      '不要告诉任何人，这是我们之间的秘密。',
      '这件事需要向团队同步，确保信息透明。',
      'INDUCED_TRUST_PATTERNS 的"保密隔离"组: /(?:不要|别|不能|不许)(?:告诉|跟|和|对)(?:任何人|别人|…)/i —— 注意此模式属 induced_trust 而非 coverup_induction'],
    ['coverup_induction',
      '这件事别说出去，咱们是一条船上的。',
      '这件事需要向团队同步，确保信息透明。',
      'COVERUP_PATTERNS: /(?:不要|别)(?:承认|说出去|举报|揭发|声张|上报)/i 与 /(?:咱们|我们)(?:是)?(?:一条船|一条心|共同体|捆绑)/i'],
  ];

  test('每个薄覆盖维度的正例都能被自身模式触发', () => {
    for (const [dim, pos, , src] of CASES) {
      const n = count(pos, dim);
      assertTrue(n > 0,
        `${dim} 正例未命中(count=0)。措辞来源: ${src}`);
    }
  });

  test('每个薄覆盖维度的负例都不得命中', () => {
    for (const [dim, pos, neg, src] of CASES) {
      const n = count(neg, dim);
      assertEqual(n, 0,
        `${dim} 负例被误判(count=${n}): "${neg}"。对应正例来源: ${src}`);
    }
  });

  test('探针须与实现同源——模式字面量改变时本测试应失败', () => {
    // 这条锁的是方法论本身: 若某维度的模式被改写成不再包含本探针所依据的
    // 字面量，测试必须失败，而不是静默通过(那意味着探针已与实现脱钩)。
    const fs = require('fs');
    const path = require('path');
    const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const mtSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'manipulation-tactics.js'), 'utf8');
    const all = idxSrc + '\n' + mtSrc;
    // 四个曾被写错的探针所依据的模式，须仍在源码中
    const anchors = [
      /要么\[\^。\]\*\?要么\[\^。\]\*\?\(没有\|无\)其他/,
      /我\(的\)\?\(理解\|看法\|想法\)可能\(不对\|有偏差/,
      /只有我\(\?:才\|真正\|最\)\?\(\?:了解\|懂\|理解\|关心/,
      /\(\?:不要\|别\|不能\|不许\)\(\?:告诉\|跟\|和\|对\)\(\?:任何人\|别人/,
    ];
    for (const a of anchors) {
      assertTrue(a.test(all), `模式锚点 ${a} 已不在源码中——探针与实现脱钩`);
    }
  });

  test('维度键不得带后缀标签(本会话探针脚本的真实 bug)', () => {
    // 实现层 bug: 探针脚本把维度键写成 'induced_trust-保密'，查了不存在的键，
    // 于是把健康维度报成失效。锁住: CASES 的维度名必须是 dimensions 的真实键。
    const dims = Object.keys(idx.discriminate('测试句子', []).dimensions || {});
    for (const [dim] of CASES) {
      assertTrue(dims.includes(dim),
        `"${dim}" 不是 dimensions 的真实键——探针键名写错了`);
    }
  });
};
