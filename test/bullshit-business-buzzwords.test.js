/**
 * test/bullshit-business-buzzwords.test.js — 中文商务空话的叠加密度判据
 *
 * [dimension-health-audit·第一百四十四轮] 新建。
 *
 * ═══ 起点是仪器自己披露的盲区 ═══
 * `scripts/dimension-health-audit.js` 的 corpus-only 覆盖报告显示 179 条语料只触达
 * 17/54 个维度，`bullshit_recognition` 属于"仅由测试字面量锁定"的那批 ——
 * 校准的 FP/recall 读数对它零表达力。对它做真实形状探针，量出沉默族:
 * 原表是**字面枚举**(赋能/闭环/底层逻辑…)，而中文商务空话的高频变体几乎全在
 * 表外。实测 8 个常见形状只命中 1 个，其余 score=0:
 *     "这是一个系统性、结构性、范式化的全面升级" —— 三个词都不在表内。
 *
 * ═══ 为什么不能直接加词 ═══
 * 这些词在正常语境里**单个出现完全无害**("这个 bug 是系统性的"、"多层次缓存能
 * 降低延迟")，加进字面表等于把良性技术讨论变成误报 —— 实测 12 个良性句里
 * 3 个含 2 个以上这类词。所以判据不是"出现即算"，而是**叠加密度**:
 * 同一文本里命中 >=3 个**不同**的商务空话词才算。
 * 这与 gaslighting 的"单弱信号不触发"(checkGaslighting 里 count===1 时
 * score 压到 0.12)是同一条设计原则 —— **密度才是信号，单个词只是词汇**。
 *
 * ═══ 一处被实测抓住的缺陷 ═══
 * 首版让新表**单独计数**，于是"打通底层逻辑，实现战略升级，构建全新生态"漏了:
 * "底层逻辑"属原表、"战略升级/全新生态"属新表，跨表叠加不累计，密度只有 2。
 * 攻击者(或普通的空话写手)并不关心词归属哪张表，故判据必须是**同一文本内
 * 两表的并集密度**。修后该样本命中(并集 3)。
 *
 * ═══ 实测 ═══
 *   攻击形状 8/8 命中(3-5 个词); 良性句 0/12 误报(最多 2 个词);
 *   全量语料(123 benign / 58 malicious): FP 0/123、recall 58/58 不变;
 *   新维度样本已入语料，此后它的行为进入 FP/recall 读数。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const idx = require('../src/index.js');
  const fs = require('fs');
  const path = require('path');

  const bsOf = (t) => (idx.discriminate(t, []).dimensions || {}).bullshit_recognition || {};
  const hasFinding = (t) => (idx.discriminate(t, []).findings || []).some(f => f.dimension === 'bullshit');

  // ── 一、商务空话族必须被判为废话 ────────────────────
  test('中文商务空话(叠加形态)必须判为 bullshit', () => {
    const shapes = [
      '这是一个系统性、结构性、范式化的全面升级，具有深远的战略意义。',
      '我们从战略高度统筹推进，构建多维度、多层次的立体化格局。',
      '以用户为中心，以价值为导向，打造行业领先的一体化解决方案。',
      '全方位赋能，端到端拉通，形成业务闭环。',
      '打通底层逻辑，实现战略升级，构建全新生态。',
      '我们要对齐目标，找到抓手，把方案落地，持续深耕。',
      '这是一次端到端的全方位重构，撬动全域增长。',
      '从战略高度出发，统筹推进多维度、多层次的生态布局。',
    ];
    const bad = [];
    for (const t of shapes) {
      if (!hasFinding(t)) bad.push('"' + t.slice(0, 34) + '" → score=' + bsOf(t).score);
    }
    assertEqual(bad.join('\n'), '', '以下商务空话形状未判为废话:\n' + bad.join('\n'));
  });

  // ── 二、单个商务词不得误报(密度判据的反向控制) ────────
  test('单个商务词出现在正常技术讨论里不得判为废话', () => {
    // 这是本判据唯一真正的风险面: 这些词在正常语境高频且无害。
    // 少这条锁，本轮改动就是把良性技术讨论变成误报。
    const benign = [
      '这个 bug 是系统性的，需要从架构层面解决。',
      '我们做了一次系统性的性能优化。',
      '请从多个维度分析这个问题，我们做一次端到端测试。',   // 含 2 个词, 低于阈值 3
      '这个方案需要端到端地考虑。',
      '系统性地复习比临时抱佛脚更有效。',
      '多层次缓存能显著降低延迟。',
      '我们需要一个全方位的备份策略。',
      '这次重构涉及三个模块。',
      '我们对齐了接口契约，然后落地了第一阶段。',
      '多维度的数据分析帮助我们发现系统性问题。',
    ];
    const bad = [];
    for (const t of benign) {
      if (hasFinding(t)) bad.push('"' + t.slice(0, 34) + '"');
    }
    assertEqual(bad.join('\n'), '', '良性技术讨论被误判为商务空话:\n' + bad.join('\n'));
  });

  // ── 三、跨表叠加必须累计(本轮修的那个缺陷) ────────────
  test('原表与新表的商务词必须并集计数', () => {
    // "打通底层逻辑"属原表、"战略升级/全新生态"属新表 —— 若两表分别计数,
    // 该句密度只有 2 会漏。首版正是如此(实测抓住)。
    const mixed = '打通底层逻辑，实现战略升级，构建全新生态。';
    assertTrue(hasFinding(mixed),
      '跨表叠加的商务空话漏报 —— 判据退回了"新表单独计数"');
    assertTrue(bsOf(mixed).count >= 3,
      '并集密度应 >=3(实测 count=' + bsOf(mixed).count + ')');
  });

  // ── 四、语料护栏: 新维度必须进入校准视野 ──────────────
  test('校准语料必须含商务空话样本与其单出现护栏', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'calibrate-fp-recall.js'), 'utf8');
    // [自匹配防护] 只认数组条目行, 注释不算
    const entryLines = raw.split('\n').filter(l => /^\s*'/.test(l));
    const hasEntry = (s) => entryLines.some(l => l.includes(s));
    assertTrue(hasEntry('这是一个系统性、结构性、范式化的全面升级'),
      'MALICIOUS 应含商务空话样本 —— 否则该维度仍在校准视野外');
    assertTrue(hasEntry('请从多个维度分析这个问题，我们做一次端到端测试'),
      'BENIGN 应含"含 2 个商务词但不触发"的单出现护栏');
    // 护栏样本必须真的 pass(否则它是 FP 而不是护栏)
    assertTrue((idx.discriminate('请从多个维度分析这个问题，我们做一次端到端测试。', []).gate || {}).action === 'pass',
      '护栏样本本身必须 pass');
  });

  // ── 五、源级: 词表与密度判据都必须在 ────────────────
  test('源级: 商务空话词表与并集密度判据必须在', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assertTrue(src.includes('ZH_BUSINESS_BUZZWORDS'),
      '商务空话词表(模块级常量)必须在');
    assertTrue(/seen\.size >= 3/.test(src),
      '叠加密度阈值 >=3 必须在 —— 降到 1-2 会把良性技术讨论变成误报');
    // 并集: 必须同时遍历新表与 zhPatterns
    assertTrue(/for \(const p of zhPatterns\) \{\s*if \(text\.includes\(p\)\) seen\.add\(p\);/.test(src),
      '判据必须把原表 zhPatterns 也并入 seen —— 只扫新表会漏掉跨表叠加(本轮修的缺陷)');
    assertTrue(src.includes('zh_business_buzzword'),
      '命中类型 zh_business_buzzword 必须在(供 findings 详情区分)');
  });
};
