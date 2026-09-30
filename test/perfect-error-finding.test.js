/**
 * test/perfect-error-finding.test.js — 聚合维度必须自己决定何时推送
 *
 * [第二十七轮] 新建。修的问题(scripts/dimension-health-audit.js 实测):
 *   perfect_error  信号 143 次  finding 0 次  ⚠ 触发但从不推 finding
 * 它是**唯一一个能改动门禁动作却永远推不出 finding 的维度**:
 * dimMap 有键、dimensions{} 的 54 个键里有它、GUIDANCE_MAP 里有专门文案、
 * index.js 的专属门禁规则靠它判 rewrite、pipeline.js:197 靠
 * `dimensions.perfect_error.count >= 2` 把它推成 rewrite —— 唯独没有推送块。
 * 后果: 调用方收到 `gate.action='rewrite'` 而 findings 里找不到 perfect_error,
 * `findings.some(f => VERIFY_DIMS.has(f.dimension))` 看不见它,
 * GUIDANCE_MAP 里那句"补充可验证的来源和数据…"是**永远执行不到的死代码** ——
 * 一句写好了却没有任何 finding 能领到的修改指引。
 *
 * 本文件的锁, 每一条都对着一次实测过的修法偏差:
 *   ① level !== 'pass' ⇒ 必须推 finding 且带 guidance(修好的一面)
 *   ② level === 'pass' ⇒ **不得**推 finding(这是 FP 护栏, 见下)
 *   ③ 有出处、带限定的精确数字陈述必须保持 gate=pass(语料级 FP 回归护栏)
 *   ④ 源码级: 不得进 allDims(聚合信号进逐维度惩罚循环 = 重复计分)
 *   ⑤ 源码级: 必须存在以 level 为门槛的专属推送块
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'index.js');

module.exports = function ({ test, assertTrue, assertEqual }) {

  const idx = require(path.join(ROOT, 'src', 'index.js'));
  const src = fs.readFileSync(INDEX, 'utf8');

  // 从 perfect-error.js 的实测分级反推的样本(非凭空写):
  //   count>=3 或 4+含假精确 → high; 伪权威+假精确 → rewrite; count>=2 → verify; 否则 pass
  const STRONG = '研究显示该方案可将成本降低62.5%，效果绝对显著。';           // count=2 → level='rewrite'
  const WEAK_SOURCED = [
    '根据公开数据，2024 年 GDP 增长 5%。',                                    // count=1 → level='pass'
    '我们的 SLA 是 99.9%，上个季度达到了 99.95%。',                            // count=1 → level='pass'
    '论文指出该方法准确率 91.2%，但泛化性仍需验证。',                          // count=1 → level='pass'
    '这段代码的 code coverage 只有 60%，需要补测试。',                        // count=1 → level='pass'
  ];

  // ─── ① 分级非 pass ⇒ 必须推 finding 且带 guidance ──────────
  test('perfect_error 分级非 pass 时必须推送 finding 并带上修改指引', () => {
    const r = idx.discriminate(STRONG);
    const pe = r.dimensions.perfect_error;
    assertTrue(pe.level && pe.level !== 'pass',
      '前提检查: 样本必须达到非 pass 分级, 实测 level=' + pe.level + ' count=' + pe.count);
    const f = r.findings.find(x => x.dimension === 'perfect_error');
    assertTrue(f !== undefined,
      '分级为 ' + pe.level + ' 时必须推送 perfect_error finding, 实测 findings='
      + JSON.stringify(r.findings.map(x => x.dimension)));
    assertTrue(typeof f.guidance === 'string' && f.guidance.length > 10,
      'finding 必须带上 GUIDANCE_MAP 的修改指引(那句曾经是永远执行不到的死代码), 实测 guidance=' + JSON.stringify(f.guidance));
    assertTrue(f.severity > 0, 'severity 必须为正, 实测 ' + f.severity);
  });

  // ─── ② 分级为 pass ⇒ 不得推 finding(FP 护栏) ──────────────
  test('perfect_error 分级为 pass 时不得推送 finding', () => {
    // 这是本次修复的**另一半**, 也是最容易走过头的那一半。
    // 实测记录: 第一版把它按 allDims 的 `score >= 0.15` 推送, 良性语料升级数
    // 1 → 7(FP 0.9% → 6.6%), 6 条新误报全是"有出处、带限定的精确数字陈述",
    // 触发路径是 `findings.length > 1`(perfect_error(20) 叠在 ai_writing_tell(35) 上)。
    // 聚合维度的一次弱信号是噪声, 不是 finding。
    for (const t of WEAK_SOURCED) {
      const r = idx.discriminate(t);
      const pe = r.dimensions.perfect_error;
      assertEqual(pe.level, 'pass',
        '前提检查: 该样本必须停在 pass 分级, 实测 level=' + pe.level + ' count=' + pe.count
        + ' | ' + t.slice(0, 30));
      assertTrue(r.findings.every(f => f.dimension !== 'perfect_error'),
        '分级为 pass 时不得推送 perfect_error finding, 实测 findings='
        + JSON.stringify(r.findings.map(x => x.dimension)) + ' | ' + t.slice(0, 30));
    }
  });

  // ─── ③ 语料级 FP 回归护栏 ────────────────────────────────
  test('有出处、带限定的精确数字陈述必须保持 gate=pass(语料级 FP 回归护栏)', () => {
    // ① 和 ② 都过了, 这条仍可能红 —— 因为升级可以来自别的路径
    // (unsupported_claim 的 verify、findings.length > 1、overallScore < 0.85)。
    // 基线(本次改动前)这四条全部 gate=pass。
    for (const t of WEAK_SOURCED) {
      const r = idx.discriminate(t);
      assertEqual(r.gate.action, 'pass',
        '该样本在改动前是 pass, 不得因本次修复被升级 | ' + t.slice(0, 40)
        + ' | 实测 action=' + r.gate.action + ' overall=' + r.overallScore
        + ' findings=' + JSON.stringify(r.findings.map(x => x.dimension)));
    }
  });

  // ─── ④ 源码级: 不得进 allDims ────────────────────────────
  test('源码级: perfect_error 不得进入 allDims(聚合信号进惩罚循环即重复计分)', () => {
    const m = src.match(/const allDims = \[([\s\S]*?)\n  \];/);
    assertTrue(m !== null, '定位不到 allDims(锚点已变)');
    // 必须**先剥掉行注释**再匹配。第一版直接 `/perfect_error/.test(m[1])`,
    // 结果把我自己写进 allDims 里解释"为什么它不进来"的那段注释当成了条目,
    // 于是这条断言恒红。这与周期25 `}));` 被当成锁闭合、周期19 注释剥离器
    // 删掉 44% 审计脚本是同一家: **不看上下文的模式匹配会把注释里的图画当成代码。**
    const code = m[1].split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    const entry = /\{\s*score:\s*pe\.score\s*,\s*name:\s*'perfect_error'\s*\}/.test(code);
    assertTrue(!entry,
      'perfect_error 是聚合信号(score 由其他维度的信号汇总而来), 放进逐维度惩罚循环'
      + '等于把底层信号重复计分一次 —— 与 unsupported_claim/pseudo_causal 跨度双算同类。'
      + '它的 finding 应由专属推送块按自己的分级产出');
  });

  // ─── ⑤ 源码级: 必须存在以 level 为门槛的专属推送块 ────────
  test('源码级: 必须存在以 level 为门槛的专属推送块', () => {
    assertTrue(/dimension:\s*'perfect_error'/.test(src),
      '必须存在 perfect_error 的专属推送块(grep `dimension: \'perfect_error\'` 曾为空, 那就是 defect)');
    assertTrue(/pe\.level\s*&&\s*pe\.level\s*!==\s*'pass'/.test(src),
      '推送门槛必须用 perfect-error.js 自己的分级 level, 而不是 allDims 那个为单一信号'
      + '维度校准的 `score >= 0.15`');
  });
};
