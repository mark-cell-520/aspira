/**
 * test/dimension-guidance-coverage.test.js — 每个会推 finding 的维度都必须带 guidance
 *
 * [dimension-health-audit·第一百五十五轮] 新建。
 *
 * ═══ 缺口 ═══
 * AGENTS.md 的门禁动作表对调用方说: rewrite → "Follow findings[].guidance"，
 * block → "Do not output. Use gate.reason"。也就是说 **guidance 是调用方唯一的
 * 行动依据**。
 *
 * 而 `GUIDANCE_MAP`(src/index.js) 是 dimension → 中文修改指引的映射，
 * 附加逻辑是一行静默跳过:
 *
 *     for (const f of findings) { if (GUIDANCE_MAP[f.dimension]) f.guidance = …; }
 *
 * 键缺失时**没有任何提示**。前两轮补过 9 个能决定 gate.action 的维度
 * (BLOCK/REWRITE/VERIFY 成员)，本轮量剩下的一遍，发现还有 **13 个**从未进过:
 *
 *   · 11 个 score-only 维度(AGENTS.md 说它们"不强制 gate 行动")
 *     theory_of_mind / goal_misalignment / counterfactual / social_norm /
 *     meta_cognition / capability_overclaim / instrumental_reasoning /
 *     factual_consistency / sarcasm / privacy_boundary / ai_writing_tell
 *   · evidence(polarity 相反的评分维度)
 *   · multi_turn_escalation(源码注释写明 "finding-only，不强制 gate action")
 *
 * "不强制 gate 行动"不等于"不会到调用方手里": 实测 **ai_writing_tell 在 190 条
 * 语料上推 21 条 finding，全部没有 guidance**；meta_cognition 推 1 条。
 * 一个高频维度只给 severity 与 details 却不告诉对方往哪改，消费者要么忽略它、
 * 要么自己猜。
 *
 * ═══ 第二处: 古典 finding 整条路绕过了附加循环 ═══
 * `src/pipeline.js` 的 classical-knowledge 层直接往
 * `data.discriminate.findings` 里 push，那条路径**不经过** discriminate 内部的
 * guidance 附加循环。实测:
 *     `本研究存在局限：样本集中于一线城市，外推需谨慎。`
 *   → 推出 dimension=moral_foundations 的古典 finding，guidance 缺失。
 *
 * 修法: GUIDANCE_MAP 提到 src/index.js 模块级并导出 `guidanceFor()`，
 * pipeline 复用同一份(不维护第二份映射)。
 * ⚠️ pipeline 里必须**函数内** require —— src/index.js 的 module.exports 有
 * `checkIndirectInjection: require('./pipeline').checkIndirectInjection`，
 * 顶部 require 会成循环依赖，拿到还没赋完的 exports。
 *
 * ═══ 实测 ═══
 *   finding 可能出现的 dimension: 58 → GUIDANCE_MAP 键 58，差集 0
 *   语料 190 条: 非 'none' 的 finding 87 条全部带 guidance
 *   ('none' 是"未发现明显问题"的占位哨兵，severity=0，不是维度)
 *   明文 132 benign / FP 0.0%, 58 malicious / recall 100.0% 逐项不变
 *   (纯数据补充: 不动任何门禁阈值与 gate 逻辑)
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const idx = require(path.join(ROOT, 'src', 'index.js'));
  const pl = require(path.join(ROOT, 'src', 'pipeline.js'));

  // ── 一、静态: finding 可能出现的每个维度都必须在映射里 ──
  test('静态: 每个会推 finding 的维度都必须有 guidance', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
    const gi = src.indexOf('const GUIDANCE_MAP = {');
    assertTrue(gi > 0, '前提失效: 找不到 GUIDANCE_MAP');
    const gEnd = src.indexOf('\n};', gi);
    const gKeys = [...src.slice(gi, gEnd).matchAll(/^\s+([a-z_]+):\s*'/gm)].map(m => m[1]);
    assertTrue(gKeys.length >= 50,
      `前提失效: GUIDANCE_MAP 只解析到 ${gKeys.length} 个键, 解析失效会让本条恒绿`);

    // finding 可能出现的全集 = allDims 的 name + 专属 push 块的 dimension
    const ai = src.indexOf('const allDims = [');
    const aEnd = src.indexOf('\n  ];', ai);
    const aNames = [...src.slice(ai, aEnd).matchAll(/name:\s*'([a-zA-Z_]+)'/g)].map(m => m[1]);
    const pushDims = [...src.matchAll(/findings\.push\(\{[^}]*?dimension:\s*'([a-zA-Z_]+)'/g)].map(m => m[1]);
    const all = [...new Set([...aNames, ...pushDims])];

    const missing = all.filter(d => !gKeys.includes(d));
    assertEqual(missing.join(', '), '',
      `以下维度会推 finding 却没有 guidance(本轮修的就是这 13 个):\n  ${missing.join('\n  ')}`);
  });

  // ── 二、行为: 语料上所有真 finding 都必须带 guidance ───
  test('行为: 语料上所有非占位的 finding 都必须带 guidance', () => {
    const corpus = fs.existsSync('/tmp/corpus149.json')
      ? JSON.parse(fs.readFileSync('/tmp/corpus149.json', 'utf8')) : null;
    // 语料文件可能在别的机器上不存在 —— 用一组固定样本兜底，保证本条永远可跑
    const SAMPLES = corpus
      ? [...corpus.BENIGN, ...corpus.MALICIOUS]
      : [
        '您说得太对了，我完全同意您的看法。',
        '毫无疑问，这是目前最好的选择。',
        '本研究存在局限：样本集中于一线城市，外推需谨慎。',
        '综合所有线索进行总结之后，我们认为这台机器是新而且快的。',
        '今天天气不错，适合出去走走。',
      ];
    const bad = [];
    let checked = 0;
    for (const s of SAMPLES) {
      let r;
      try { r = pl.runPipeline({ input: s, mode: 'output' }); } catch (_) { continue; }
      for (const f of (r.findings || [])) {
        // 'none' 是"未发现明显问题"的占位哨兵(severity=0)，不是维度
        if (f.dimension === 'none') continue;
        checked++;
        if (!f.guidance) bad.push(`${f.dimension} | ${String(f.details).slice(0, 40)}`);
      }
    }
    assertTrue(checked > 0, `前提失效: 一条 finding 都没跑到(实测 ${checked})`);
    assertEqual([...new Set(bad)].join('\n'), '',
      `以下 finding 没有 guidance:\n${[...new Set(bad)].join('\n')}`);
  });

  // ── 三、古典 finding 必须带 guidance(第二条路径) ────────
  test('古典 finding 必须带 guidance(pipeline 那条绕过附加循环的路径)', () => {
    const s = '本研究存在局限：样本集中于一线城市，外推需谨慎。';
    const r = pl.runPipeline({ input: s, mode: 'output' });
    const classical = (r.findings || []).filter(f => f.classical);
    assertTrue(classical.length > 0, `前提失效: 该句当前推不出古典 finding(实测 ${classical.length})`);
    const bad = classical.filter(f => !f.guidance);
    assertEqual(bad.map(f => f.dimension).join(', '), '',
      '古典 finding 没有 guidance —— src/pipeline.js 的 classical-knowledge 层' +
      '绕过 discriminate() 的附加循环，需在 push 后补一层(见本轮修复)');
  });

  // ── 四、必须复用同一份映射，不维护第二份 ────────────────
  test('GUIDANCE_MAP 必须模块级导出 guidanceFor，pipeline 复用同一份', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
    assertTrue(/^const GUIDANCE_MAP = \{/m.test(src),
      'GUIDANCE_MAP 必须是模块级常量(本轮从 discriminate() 内部提出来，供 pipeline 复用)');
    assertTrue(typeof idx.guidanceFor === 'function', 'index.js 必须导出 guidanceFor()');
    // 取两个已知维度验证映射内容仍在
    assertEqual(idx.guidanceFor('sycophancy'), '去掉过度附和，用中性语言重述观点',
      'guidanceFor(sycophancy) 的内容变了');
    assertTrue(typeof idx.guidanceFor('ai_writing_tell') === 'string' && idx.guidanceFor('ai_writing_tell').length > 0,
      'guidanceFor(ai_writing_tell) 必须有内容 —— 它是语料上最高频的维度(21/190)');
    assertEqual(idx.guidanceFor('__nope__'), undefined,
      '未知维度应返回 undefined(与旧行为一致)');
    // pipeline 必须真的调用它，而不是自己抄一份
    const pl2 = fs.readFileSync(path.join(ROOT, 'src', 'pipeline.js'), 'utf8');
    assertTrue(/guidanceFor/.test(pl2), 'pipeline.js 必须使用 guidanceFor');
    assertTrue(!/const GUIDANCE_MAP\s*=/.test(pl2),
      'pipeline.js 不得自己维护第二份 GUIDANCE_MAP —— 两份映射会漂移');
  });

  // ── [dimension-health-audit·第一百六十六轮] dimensions{} 的 54 个键也必须能查到 guidance ──
  // AGENTS.md 记录的键名不一致残余: findings[].dimension 用 bullshit，
  // dimensions{} 的 54 个键用 bullshit_recognition。上面第一条锁的是
  // "会推 finding 的维度有 guidance"(别名路径)，本条锁的是另一条路径 ——
  // 调用方按 dimensions{} 的键集查 guidance 时不能落空。
  // 实测(本轮修复前): 54 键里 bullshit_recognition 与 appeal_to_authority_boost
  // 查不到 guidance，而它们的别名 bullshit / appeal_to_authority 都有。
  test('dimensions{} 的 54 个键必须都能查到 guidance', () => {
    const dkeys = Object.keys(idx.discriminate('test', []).dimensions || {});
    assertEqual(dkeys.length, 54, `dimensions{} 应有 54 键, 实测 ${dkeys.length}`);
    const missing = dkeys.filter(k => !idx.guidanceFor(k));
    assertEqual(missing.join(', '), '',
      `以下 dimensions{} 键查不到 guidance(调用方按文档化键集查会落空):\n  ${missing.join('\n  ')}`);
  });
};
