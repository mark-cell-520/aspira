/**
 * discrimination-trace.test.js — Aspira（新愿）判别可解释性 trace 模块回归测试
 *
 * 保护从心虫吸收的 src/discrimination-trace.js：
 *   buildTrace / summarizeTrace / extractDimensionEvidence / EVIDENCE_FIELDS
 *
 * 诊断实证背景：block 判定的 findings 只有 {dimension, severity, details}——
 * 调用方看到 "dangerous_instruction(4次)" 不知道哪句话触发、命中哪个模式、
 * 文本有没有被归一化还原。本模块把各维度 checkXxx() 返回值里的证据数组
 * (hits/claims/signals/...) 透出成可读 trace。纯函数、零依赖。
 *
 * 遵循 aspira 约定 #4：本文件位于 test/ 根目录、以 module.exports=函数 导出，
 * 会被 test/run-all.js 递归发现并经 _mount.js 在子进程中执行。
 */
const {
  buildTrace,
  summarizeTrace,
  extractDimensionEvidence,
  EVIDENCE_FIELDS
} = require('../src/discrimination-trace.js');

module.exports = function ({ test, assertEqual, assertTrue, assertFalse, assertDefined }) {

  // ---- extractDimensionEvidence ----

  test('extractDimensionEvidence: hits 数组透出样本/模式/计数', () => {
    const ev = extractDimensionEvidence('dangerous_instruction', {
      count: 4,
      hits: [
        { matched: 'ignore previous instructions', type: 'override' },
        { matched: 'disregard all rules', type: 'override' }
      ]
    });
    assertTrue(ev.hasEvidence, '应有证据');
    assertEqual(ev.count, 4, 'count 取自 dimResult.count');
    assertEqual(ev.samples.length, 2, '两条命中样本');
    assertEqual(ev.samples[0], 'ignore previous instructions', '取 matched 原文');
    assertEqual(ev.patternTypes[0], 'override', 'patternTypes 取自 el.type');
  });

  test('extractDimensionEvidence: 无 count 时取 totalHits 兜底', () => {
    const ev = extractDimensionEvidence('x', { totalHits: 3, signals: ['a', 'b'] });
    assertEqual(ev.count, 3, 'totalHits 兜底计数');
    assertTrue(ev.hasEvidence, 'signals 数组应有证据');
  });

  test('extractDimensionEvidence: 无证据字段 → hasEvidence=false', () => {
    const ev = extractDimensionEvidence('x', { count: 0 });
    assertFalse(ev.hasEvidence, '无证据数组');
    assertEqual(ev.count, 0, '计数 0');
    assertEqual(ev.samples.length, 0, '无样本');
  });

  test('extractDimensionEvidence: 非对象输入安全返回空', () => {
    for (const bad of [null, undefined, 'str', 42]) {
      const ev = extractDimensionEvidence('x', bad);
      assertFalse(ev.hasEvidence, `非对象 ${typeof bad} 应无证据`);
      assertEqual(ev.count, 0, '计数 0');
    }
  });

  // ---- buildTrace ----

  test('buildTrace: findings+dimensions 收敛成 trace 条目', () => {
    const trace = buildTrace({
      findings: [{ dimension: 'dangerous_instruction', severity: 90 }],
      dimensions: { dangerous_instruction: { count: 4, hits: [{ matched: 'ignore rules', type: 'override' }] } }
    });
    assertEqual(trace.length, 1, '一个命中维度一条');
    assertEqual(trace[0].dimension, 'dangerous_instruction');
    assertEqual(trace[0].severity, 90, 'severity 透出');
    assertEqual(trace[0].count, 4, 'count 透出');
    assertEqual(trace[0].evidence[0], 'ignore rules', '证据样本透出');
    assertEqual(trace[0].patternTypes[0], 'override', '模式类型透出');
  });

  test('buildTrace: 零命中且无证据的维度被过滤', () => {
    const trace = buildTrace({
      findings: [{ dimension: 'foo', severity: 10 }],
      dimensions: { foo: { count: 0 } }
    });
    assertEqual(trace.length, 0, '零命中应被过滤, 避免 ×0 噪音');
  });

  test('buildTrace: 按严重度降序排列', () => {
    const trace = buildTrace({
      findings: [
        { dimension: 'low', severity: 20 },
        { dimension: 'high', severity: 90 },
        { dimension: 'mid', severity: 50 }
      ],
      dimensions: {
        low: { count: 1, hits: [{ matched: 'l' }] },
        high: { count: 1, hits: [{ matched: 'h' }] },
        mid: { count: 1, hits: [{ matched: 'm' }] }
      }
    });
    assertEqual(trace.map(t => t.dimension).join(','), 'high,mid,low', 'severity 降序');
  });

  test('buildTrace: none 维度被跳过', () => {
    const trace = buildTrace({ findings: [{ dimension: 'none' }], dimensions: {} });
    assertEqual(trace.length, 0, 'none 不应入 trace');
  });

  test('buildTrace: 归一化手段链追加 _normalization 条目', () => {
    const trace = buildTrace(
      {
        findings: [{ dimension: 'd', severity: 90 }],
        dimensions: { d: { count: 1, hits: [{ matched: 'x' }] } }
      },
      { applied: ['fullwidth', 'homoglyph'], normalized: 'text' }
    );
    const norm = trace.find(t => t.dimension === '_normalization');
    assertDefined(norm, '应有 _normalization 条目');
    assertEqual(norm.count, 2, '归一化手段数');
    assertEqual(norm.evidence[0], '归一化手段: fullwidth → homoglyph', '手段链可读');
    assertTrue(norm.note.length > 0, '有归一化说明');
  });

  test('buildTrace: 无效输入安全返回空数组', () => {
    for (const bad of [null, undefined, 'str', 42, {}]) {
      const trace = buildTrace(bad);
      assertTrue(Array.isArray(trace), '应返回数组');
      assertEqual(trace.length, 0, '无效输入 → 空 trace');
    }
  });

  // ---- summarizeTrace ----

  test('summarizeTrace: 空/无效 trace → 无命中', () => {
    assertEqual(summarizeTrace([]), '无命中');
    assertEqual(summarizeTrace(null), '无命中');
  });

  test('summarizeTrace: 一句话摘要含 维度×计数(证据)', () => {
    const s = summarizeTrace([
      { dimension: 'dangerous_instruction', count: 4, evidence: ['ignore rules'], patternTypes: [] },
      { dimension: 'phishing_coercion', count: 2, evidence: [], patternTypes: [] }
    ]);
    assertEqual(s, 'dangerous_instruction×4("ignore rules") + phishing_coercion×2', '摘要格式');
  });

  test('summarizeTrace: 归一化信息附在末尾', () => {
    const s = summarizeTrace([
      { dimension: 'd', count: 1, evidence: ['x'], patternTypes: [] },
      { dimension: '_normalization', count: 1, evidence: ['归一化手段: fullwidth'], note: '' }
    ]);
    assertEqual(s, 'd×1("x") | 归一化: fullwidth', '归一化附加');
  });

  // ---- EVIDENCE_FIELDS ----

  test('EVIDENCE_FIELDS: 覆盖关键证据字段', () => {
    assertTrue(Array.isArray(EVIDENCE_FIELDS), '应为数组');
    assertTrue(EVIDENCE_FIELDS.includes('hits'), '含 hits');
    assertTrue(EVIDENCE_FIELDS.includes('signals'), '含 signals');
    assertTrue(EVIDENCE_FIELDS.includes('claims'), '含 claims');
    assertTrue(EVIDENCE_FIELDS.includes('matches'), '含 matches');
  });
};
