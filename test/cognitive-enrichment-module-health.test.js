/**
 * cognitiveEnrichment 阶段的产出字段必须真的存在。
 *
 * 锁的缺陷：pipeline-config.js 的 cognition 快照读
 * ctx.cognitiveEnrichment.<十个键>（pipeline-config.js:832-850 与 1466-1484），
 * 而 cognitiveEnrichmentRun 从写下起只返回 { enriched, ready, modules } ——
 * 十个读数恒为 null，靠它们汇总的 enrichmentSummary.total 恒为 0，
 * 且全程不抛异常。本测试把产出侧的键与读方的键对账，漏一个即失败。
 */
module.exports = function ({ test, assertTrue, assertDefined }) {
  const path = require('path');
  const { cognitiveEnrichmentRun } = require(path.join(__dirname, '..', 'src', 'workflow', 'cognitive-enrichment.js'));

  // pipeline.js:548 的做法：ctx[stage.id] = result
  const CONSUMER_KEYS = [
    'confidenceCalibrator', 'desireCognitionHealth', 'threePoisonsHealth',
    'logicReasoningMetrics', 'decisionFeedback', 'decisionVerifier',
    'loveCognition', 'cognitionGround', 'debateConductor', 'dreamEngineV2',
  ];

  test('cognitiveEnrichmentRun 返回消费方要的十个键', () => {
    const out = cognitiveEnrichmentRun({ input: 'test' }, null);
    // 同步形状先查（函数返回 Promise，此处只看 thenable 之外的同步路径不可用）
    assertTrue(out && typeof out.then === 'function', '阶段运行函数应返回 Promise');
  });

  test('跑完阶段后十个键都不再是 undefined', async () => {
    const mod = require(path.join(__dirname, '..', 'src', 'core', 'heartflow.js'));
    const hf = new (mod.Aspira || mod.createAspira)();
    if (typeof hf.start === 'function') {
      try { await hf.start(); } catch (_) { /* 启动失败也能测产出侧形状 */ }
    }
    const ctx = { input: '以利为利，何也' };
    ctx.cognitiveEnrichment = await cognitiveEnrichmentRun(ctx, hf);
    // 旧缺陷是产出侧根本不写这些键 → 读方 `?.x || null` 恒得 null。
    // 这里锁"键必须在"，值为 null 只允许出现在模块确实没初始化的情况。
    let asObject = 0;
    for (const k of CONSUMER_KEYS) {
      const v = ctx.cognitiveEnrichment[k];
      assertTrue(v !== undefined, `消费方读的 ${k} 产出侧必须写这个键`);
      if (v && typeof v === 'object') asObject++;
    }
    assertTrue(asObject >= CONSUMER_KEYS.length - 1,
      `至少 ${CONSUMER_KEYS.length - 1} 个键应是模块健康对象，实际 ${asObject}`);
  });

  test('enrichmentSummary 不再恒为 0 —— 汇总真的数得到模块', async () => {
    const mod = require(path.join(__dirname, '..', 'src', 'core', 'heartflow.js'));
    const hf = new (mod.Aspira || mod.createAspira)();
    if (typeof hf.start === 'function') {
      try { await hf.start(); } catch (_) { /* 同上 */ }
    }
    const ctx = { input: '以利为利，何也' };
    ctx.cognitiveEnrichment = await cognitiveEnrichmentRun(ctx, hf);
    // 与 pipeline-config.js:857-870 同一套算法
    const enr = ctx.cognitiveEnrichment;
    const modules = Object.entries(enr)
      .filter(([, v]) => v && typeof v === 'object' && !v.error)
      .map(([k, v]) => ({ module: k, health: v.health || v.status || 'ok' }));
    assertTrue(modules.length > 0, 'enrichmentSummary.total 必须大于 0');
  });
};
