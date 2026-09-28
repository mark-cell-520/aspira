/**
 * test/fp-hedge-exemption.test.js — 句内对冲豁免回归
 *
 * 本轮误报/召回校准周期修掉的两个真误报，根因**完全相同**:
 * 两个检测函数都只看了"模糊来源 + 精确数字"这个形态，**没看句子自己是否已经
 * 带了对冲**。而自带对冲的句子，正是引擎应该放过的那种谨慎表述。
 *
 * ═══ 误报一: checkPseudoCausal ═══
 *   "实验显示转化率提升 3 倍，但样本量仅 200，结论有待确认。"
 * PSEUDO_CAUSAL_ZH 的 /(?:提升|降低|减少|提高|改善)\s*\d+(?:\.\d+)?\s*(?:倍|x|次)/
 * 命中"提升 3 倍" → gate=verify。
 * 但这句话自己注明了样本量只有 200、结论有待确认——**它在做引擎会要求它做的事**。
 *
 * ═══ 误报二: checkUnsupportedClaim ═══
 *   "According to the 2024 report, sales grew by 12%, though the sample was small."
 * UNSUPPORTED_CLAIM_EN 的共现组合规则命中("模糊来源 + 12%") → gate=verify。
 * 但这句话**已注明具体出处**(带年份的报告)，后半句还自带样本量告诫。
 *
 * ═══ 一次值得完整记录的判断反复 ═══
 * 误报二最初被误判为"引擎设计如此、语料标签错了"，样本已从语料撤回。
 * 理由是只看到前半句 "According to the 2024 report" 就断定共现规则
 * (注释写明"编造研究模板的典型形态")是刻意要拦它。
 * 但**完整句的后半句是 "though the sample was small"**——自带对冲。
 * 已注明出处且自带对冲的句子被拦，仍是真误报。样本已恢复，改为修模式。
 *
 * 教训: 判定"引擎对、样本错"之前，**必须先看完整句**。
 * 本会话此前有四次"探针/样本错、引擎对"，而这次恰好相反——
 * 是我错、样本对。同一个"谁错了"的问题，两个方向都出现过，
 * 所以唯一可靠的做法是测量完整输入，而不是看片段下结论。
 *
 * ═══ 修复 ═══
 * 两个函数各加同一条 HEDGE_RE(句内自限判据):
 *   样本量仅 N / 有待确认 / 尚需验证 / 初步结果 / 限于样本 /
 *   though the sample … / sample was small / with a small sample …
 * 两个方向的实测(见下方断言):
 *   自带对冲 → 放过; 无对冲的 "according to a study … 47%" → 仍命中。
 * 修 FP **没有**牺牲召回: 语料 86 良性 / 34 恶意，FP 2.3% → **0.0%**，
 * 召回保持 **100%**。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const idx = require('../src/index.js');
  const fs = require('fs');
  const path = require('path');

  // pseudo_causal / unsupported_claim 都只出现在 findings 里。
  // 注意: pseudo_causal 与 soft_deflection、ai_writing_tell 一样，
  // **不是 dimensions 的键**(AGENTS.md「What 54 counts」已记录)，
  // 所以必须从 findings 读——从 dimensions 读会得到 undefined，
  // 从而把"引擎没命中"误判成"引擎命中了但读不到"。
  const hasFinding = (t, dim) =>
    (idx.discriminate(t, []).findings || []).some(f => f.dimension === dim);
  const gate = (t) => ((idx.discriminate(t, []).gate || {}).action) || 'pass';

  // ── 一、自带对冲的伪因果断言必须被放过 ────────────
  test('自带对冲的数字断言不得判为伪因果', () => {
    const hedged = [
      '实验显示转化率提升 3 倍，但样本量仅 200，结论有待确认。',
      '初步数据显示转化率提升 3 倍，尚需进一步验证。',
      '小样本实验表明留存提高 2 倍，样本量仅 50。',
      '限于样本量，本次改善 2 次转化的结论有待确认。',
    ];
    for (const t of hedged) {
      assertTrue(!hasFinding(t, 'pseudo_causal'),
        `自带对冲的句子被误判为伪因果: "${t}"`);
    }
  });

  // ── 二、无对冲的伪因果断言必须仍被命中 ────────────
  test('无对冲的数字断言必须仍判为伪因果', () => {
    // 这是"修 FP 不得吞掉功能"的反向验证。
    const unhedged = [
      '我们的方法提升 3 倍，效果显著。',
      '该系统提高 5 倍性能。',
      '新算法降低 10 倍延迟。',
      '产品改善 2 次转化。',
    ];
    for (const t of unhedged) {
      assertTrue(hasFinding(t, 'pseudo_causal'),
        `无对冲的数字断言漏报: "${t}"——对冲豁免放太宽了`);
    }
  });

  // ── 三、自带对冲的来源引用必须被放过 ──────────────
  test('自带对冲的来源引用不得判为无依据断言', () => {
    const hedged = [
      'According to the 2024 report, sales grew by 12%, though the sample was small.',
      'According to the study, retention improved 40%, though the sample was limited.',
      '初步数据显示转化率提升 3 倍，样本量仅 200。',
    ];
    for (const t of hedged) {
      assertTrue(!hasFinding(t, 'unsupported_claim'),
        `自带对冲的来源引用被误判为无依据断言: "${t}"`);
    }
    // 注意: gate=pass 只对语料里那条英文样本成立。中文合成句
    // "初步数据显示…样本量仅 200" 虽已被 unsupported_claim 豁免，
    // 但仍会被 appeal_to_authority("初步数据" 是无名来源)与
    // ai_writing_tell/vagueness 命中——那是**其他维度的正当触发**，
    // 不在本轮修复范围内。故此处不断言整体 gate，
    // 只断言本维度已豁免: 修 FP 要修对维度，不能要求整句放行。
    assertTrue(gate('According to the 2024 report, sales grew by 12%, though the sample was small.') === 'pass',
      '语料中的对冲样本应整体放行');
  });

    // ── 四〆、"模糊来源+精确数字"类的维度级守护 ───────
    // [v6.7.9x] 本轮我曾把这一类样本加进语料(BENIGN 4 条 + MALICIOUS 4 条)，
    // 实测后发现重犯了本文件 281-292 行已记录过的错误，已全部移出。
    // 移出后该类的守护改到维度级，就是这里。
    test('"模糊来源+精确数字"类必须在维度级命中(不得因对冲词放开)', () => {
      // 这 8 条是本轮从语料里移出的。它们的意义不是"该被拦"，而是
      // "unsupported_claim 维度必须命中"——该维度本就是 VERIFY 层，
      // gate 只到 verify 是设计内行为，不是漏报。
      const moved = [
        '研究表明，适量运动可能降低心血管疾病风险约 20-30%。',
        '根据 2024 年的一份行业报告，部署时间中位数约为 12 分钟。',
        '研究表明，这种药物可能延长寿命 12.5 年。',
        '介绍，该引擎可能将误报率降至 1% 以下。',
        'Studies suggest that moderate exercise may reduce cardiovascular risk by about 20-30%.',
        'A recent study suggests this supplement may extend lifespan by 12.5 years.',
        'According to industry sources, the failure rate is roughly 0.5%.',
        '根据 2024 年的一份研究报告，该指标约为 5%。',
      ];
      for (const t of moved) {
        assertTrue(hasFinding(t, 'unsupported_claim'),
          `该类样本应在维度级命中 unsupported_claim: "${t}"`);
      }
      // 注意: 不断言"只到 verify"。这一类还会触发 **perfect_error** 路径
      // (假精确 + 伪权威)，那是与 unsupported_claim 并行的设计内机制，
      // 故部分样本设计动作就是 rewrite。首版我断言"必须 verify"，
      // 结果被 perfect_error 打红——又一次"掩养了引擎的另一条设计内路径"。
      // 这里只断言本质: **不得因为含对冲词而放开**。
      for (const t of moved) {
        const act = gate(t);
        assertTrue(act === 'verify' || act === 'rewrite',
          `该类样本必须被升级(不得因对冲词 pass): "${t}" → ${act}`);
      }
    });

    // [v6.7.9x] 语料里不得再出现这一类的数组条目(防再次错洽)。
    test('语料数组不得含"模糊来源+精确数字"类样本', () => {
      const raw = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'calibrate-fp-recall.js'), 'utf8');
      // [自匹配记录] 只认数组条目行(行首引号)，注释行不算——
      // 本会话已经多次让测试匹配到自己写的注释。
      const entryLines = raw.split('\n').filter(l => /^\s*'/.test(l));
      const hasEntry = (x) => entryLines.some(l => l.includes(x));
      const banned = [
        '研究表明，适量运动可能降低心血管疾病风险约 20-30%',
        '根据 2024 年的一份行业报告，部署时间中位数约为 12 分钟',
        '研究表明，这种药物可能延长寿命 12.5 年',
        '介绍，该引擎可能将误报率降至 1% 以下',
        'Studies suggest that moderate exercise may reduce cardiovascular risk by about 20-30%',
        'A recent study suggests this supplement may extend lifespan by 12.5 years',
        'According to industry sources, the failure rate is roughly 0.5%',
        '根据 2024 年的一份研究报告，该指标约为 5%',
      ];
      for (const b of banned) {
        assertTrue(!hasEntry(b),
          `语料数组不得含该类样本(它们正确地只到 verify，不是漏报): ${b}`);
      }
    });

  // ── 四、无对冲的来源引用必须仍被命中 ──────────────
  test('无对冲的模糊来源+精确数字必须仍判为无依据', () => {
    // 共现组合规则的注释写明这是"编造研究模板的典型形态"，必须继续生效。
    const unhedged = [
      'According to a study, productivity improved by 47%.',
      'Studies show that revenue increased by 30%.',
      '2024 research indicates engagement rose 25 percent.',
      '研究表明效率提升了 3 倍。',
    ];
    for (const t of unhedged) {
      assertTrue(hasFinding(t, 'unsupported_claim'),
        `无对冲的模糊来源引用漏报: "${t}"`);
    }
  });

  // ── 五、源码级锁: 两个函数都必须有对冲豁免 ────────
  test('checkPseudoCausal 与 checkUnsupportedClaim 都必须带对冲豁免', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // 两处 HEDGE_RE 定义(对冲判据必须同族，不能只修一个)
    const hedgeCount = (src.match(/const HEDGE_RE =/g) || []).length;
    assertTrue(hedgeCount >= 2,
      `应有至少 2 处 HEDGE_RE(pseudo_causal 与 unsupported_claim 各一处)，实测 ${hedgeCount}`);
    // 两处都必须真的 return(不能定义了不用)
    const earlyReturn = (src.match(/if \(HEDGE_RE\.test\(text\)\) return/g) || []).length;
    assertTrue(earlyReturn >= 2,
      `应有至少 2 处 HEDGE_RE.test(text) 提前返回，实测 ${earlyReturn}`);
    // 对冲判据必须包含"though the sample"这类英文对冲，
    // 否则误报二会复现
    assertTrue(src.includes('though\\s+the\\s+sample'),
      'HEDGE_RE 应覆盖 "though the sample …" 形态');
    assertTrue(src.includes('有待\\s*(?:确认|验证'),
      'HEDGE_RE 应覆盖"有待确认/验证"形态');
  });

  // ── 六、语料必须保住那个曾被误撤回的样本 ──────────
  test('校准语料必须保留"though the sample was small"样本', () => {
    // 这一条锁的是**判断反复本身**: 该样本曾被误撤回(只看了前半句就断定
    // 标签错了)。若有人再次把它从数组里删掉，本测试立刻失败。
    const raw = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'calibrate-fp-recall.js'), 'utf8');
    // 只认数组条目行——注释里提到它不算保留(否则删了样本测试仍绿)。
    const entryLines = raw.split('\n').filter(l => /^\s*'/.test(l));
    assertTrue(entryLines.some(l => l.includes('though the sample was small')),
      '语料数组应保留 "…though the sample was small." 样本——它曾被误撤回');
    // 判断记录应留在注释里(全文匹配即可，它本就只存在于注释中)
    assertTrue(raw.includes('撤回又恢复'),
      '语料应保留"撤回又恢复"的判断记录');
  });

  test('对冲豁免不得放宽(维度级召回护栏)', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'calibrate-fp-recall.js'), 'utf8');
    // [自匹配修正] 首版用全文 includes() 判断"语料里是否还有该样本"，
    // 结果匹配到的是**我自己写在注释里的移除理由**——本会话第三次
    // "测试匹配到自己的注释"。改为只认**数组条目行**(行首可选空白后紧跟引号)，
    // 注释行一律不算。
    const entryLines = raw.split('\n').filter(l => /^\s*'/.test(l));
    const hasEntry = (s) => entryLines.some(l => l.includes(s));

    // 对冲护栏(应放行)
    for (const s of ['样本量仅 200', '有待确认']) {
      assertTrue(hasEntry(s), `语料缺少对冲护栏: ${s}`);
    }
    // 无对冲的"模糊来源+精确数字"样本**不在** MALICIOUS 里——它们正确地产出
    // verify 而非 block/rewrite，而本脚本的"被拦截"只算 block/rewrite，
    // 放进去会把正确的引擎行为计成漏报(实测召回会假跌到 92.1%)。
    // 故这类样本的守护在**维度级**(上方第四条测试逐一断言 unsupported_claim
    // 必须命中)，此处锁住"语料数组里不应再出现它们"以防再次错派。
    assertTrue(!hasEntry('According to a study, productivity improved by 47%.'),
      '语料数组不应再含该样本——它正确地只到 verify，不是漏报');
    assertTrue(!hasEntry('Studies show that revenue increased by 30%.'),
      '语料数组不应再含该样本——同上');
  });
};
