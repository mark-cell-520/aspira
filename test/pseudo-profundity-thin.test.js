/**
 * test/pseudo-profundity-thin.test.js — 维度健康审计抓到的"薄覆盖"可行动维度
 *
 * 背景（第九十三轮, dimension-health-audit 切片）:
 * scripts/dimension-health-audit.js 报告的信号分布是
 *   <5 信号 6 个 | 5-19 信号 14 个 | 20-99 信号 27 个 | >=100 信号 7 个
 * 最薄的六个里, 四个(counterfactual / privacy_boundary / goal_misalignment /
 * pseudo_profundity)按设计就是"仅打分"维度, 薄是正常的。
 *
 * 但 **pseudo_profundity 是 verify 级(可行动)维度**, 信号数只有 3。原以为
 * 这是引擎缺口, 实测证明是**仪器输入池缺口**: 从它自己的模式字面量推导措辞,
 * 七个探针全部命中并推 gate=verify。也就是说维度是健康的, 只是审计的输入池
 * (校准语料 + test/ 字符串字面量 + 引擎正则碎片)里没有出现过这些句式。
 *
 * **方法论(承 test/thin-dimension-bidirectional.test.js 的教训)**:
 * 每个正例的措辞必须从该维度**自身的模式字面量**推导, 不凭语感写。
 * 我第一版凭语感写了七个("生活的本质就是生活本身"这类同义反复), **七个全 0**;
 * 按 PSEUDO_PROFUNDITY_PATTERNS 的 zh/en 字面量重写, **七个全中**。
 * 这条对照也写进了测试, 让"语感探针"这个失败模式可复现地红。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=mount 函数导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const idx = require('../src/index.js');

  const dim = (t) => {
    const r = idx.discriminate(t, []);
    return { count: (r.dimensions || {}).pseudo_profundity ? r.dimensions.pseudo_profundity.count : 0, r };
  };

  // 措辞来源(逐个对应 PSEUDO_PROFUNDITY_PATTERNS 的字面量):
  //   /从[^。]*?出发[，,]我们需要/        → "从用户需求出发，我们需要重新思考"
  //   /在[^。]*?(时代|背景|语境|层面|维度|视角)下/ → "在当前时代背景下，我们要创新"
  //   /深刻(的|地)?(认识|理解|洞察|…)/     → "深刻认识到这个问题的重要性"
  //   /in (today'?s|this|our).*(world|era|age|landscape|environment)/ → "In today's world, …"
  //   /it (is|'s) (not|important).*…/     → "It is not what we know but how we use it"
  const POSITIVE = [
    '从用户需求出发，我们需要重新思考',
    '在当前时代背景下，我们要创新',
    '深刻认识到这个问题的重要性',
    '深刻地理解事物的本质',
    "In today's world, we must innovate",
    'It is not what we know but how we use it',
    '从这个维度出发，我们需要系统思维',
  ];

  // 反向控制: 不满足任何字面量的句子必须保持安静。
  // 注意这些都是**具体的、有信息量的**陈述——伪深度的反面是可检验的具体。
  const NEGATIVE = [
    '本季度可用性是 99.95%, 比上季度高 0.02 个百分点',
    '测试覆盖从 1435 升到 1472, 新增 37 个用例',
    'The service returned 200 in 38ms across 12 runs',
    '请把 logs 目录下的 *.tmp 文件删掉再重跑',
  ];

  test('pseudo_profundity: 按模式字面量推导的正例必须全部命中', () => {
    const missed = POSITIVE.filter(t => dim(t).count === 0);
    assertEqual(missed.length, 0, '以下探针未命中: ' + JSON.stringify(missed));
  });

  test('pseudo_profundity: 命中的必须推 finding 并抬到 verify(它是可行动维度)', () => {
    const noFinding = [], notVerify = [];
    for (const t of POSITIVE) {
      const { r } = dim(t);
      const dims = (r.findings || []).map(f => f.dimension);
      if (dims.indexOf('pseudo_profundity') < 0) noFinding.push(t);
      if (r.gate.action !== 'verify' && r.gate.action !== 'rewrite' && r.gate.action !== 'block') notVerify.push(t);
    }
    assertEqual(noFinding.length, 0, '以下命中但没推 finding: ' + JSON.stringify(noFinding));
    assertEqual(notVerify.length, 0, '以下命中但门禁没抬级: ' + JSON.stringify(notVerify));
  });

  test('反向控制: 具体陈述不得命中 pseudo_profundity', () => {
    const fired = NEGATIVE.filter(t => dim(t).count !== 0);
    assertEqual(fired.length, 0, '以下具体陈述被误判为伪深度: ' + JSON.stringify(fired));
  });

  test('教训钉住: 凭语感写的第一版探针必须是全 0(它们是同义反复, 不是伪深度)', () => {
    // 第一版我凭语感写了这七个同义反复句, 实测七个全 0——因为模式要求的是
    // "从X出发我们需要" / "在X背景下" / "深刻的认识到" 这类**措辞**,
    // 不是语义上的空。这条让那个错误可复现地失败。
    const VIBES = [
      '生活的本质就是生活本身',
      '这句话的深意在于它本身的深意',
      '成功的秘诀就是做一个成功的人',
      '时间会告诉我们答案, 而答案是时间',
      'The meaning of life is to live a life of meaning',
      '真相就是真相, 因为真相之所以是真相',
    ];
    const fired = VIBES.filter(t => dim(t).count !== 0);
    assertEqual(fired.length, 0, '同义反复类不得命中: ' + JSON.stringify(fired));
  });

  test('pseudo_profundity 是 dimensions{} 的键之一(不是只存在于 findings)', () => {
    const r = idx.discriminate(POSITIVE[0], []);
    assertTrue(Object.prototype.hasOwnProperty.call(r.dimensions || {}, 'pseudo_profundity'),
      'dimensions{} 应含 pseudo_profundity 键');
  });
};
