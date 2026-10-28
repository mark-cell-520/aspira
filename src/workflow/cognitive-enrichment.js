/**
 * cognitive-enrichment.js — 认知增强模块
 * Aspira v6.4.3: pipeline-config.js 依赖此文件
 */
class CognitiveEnrichment {
  constructor() { this.ready = true; }
  enrich(text, ctx) { return text; }
  healthCheck() { return { ok: true }; }
}
// 认知充实十个模块的产出字段名 → hf 上的属性名。
// pipeline-config.js 的 cognition 快照读的是左边这十个键
// (pipeline-config.js:832-850 与 1466-1484)，而本阶段从写下起只返回
// { enriched, ready, modules } —— 于是那十个读数恒为 null，靠它们汇总的
// enrichmentSummary.total 也恒为 0。映射表放产出侧，读方一个都不用改。
// 注意键名与属性名不完全同形：confidenceCalibrator 在 hf 上叫 confidence，
// 另三个带 Health/Metrics 后缀的键装的也是模块本身而非派生指标。
const MODULE_FIELDS = {
  confidenceCalibrator: 'confidence',
  desireCognitionHealth: 'desireCognition',
  threePoisonsHealth: 'threePoisons',
  logicReasoningMetrics: 'logicReasoning',
  decisionFeedback: 'decisionFeedback',
  decisionVerifier: 'decisionVerifier',
  loveCognition: 'loveCognition',
  cognitionGround: 'cognitionGround',
  debateConductor: 'debateConductor',
  dreamEngineV2: 'dreamEngineV2',
};

// 取模块自己的健康快照。没有 healthCheck/getStats/status 的模块只记"已加载"，
// 不让它变成 null —— 否则 enrichmentSummary 会把它整个漏掉。
// 抛错一律落成 error 字段：pipeline-config 的 enrichmentSummary 会跳过带
// error 的条目，一个炸掉的模块不会把健康度总数拖成假的。
function _snapshotModule(mod) {
  if (!mod) return null;
  try {
    for (const fn of ['healthCheck', 'getStats', 'status']) {
      if (typeof mod[fn] === 'function') {
        const raw = mod[fn]() || {};
        const bad = raw.ok === false || raw.status === 'error';
        return { loaded: true, health: bad ? 'error' : 'ok', snapshot: raw };
      }
    }
    return { loaded: true, health: 'ok', snapshot: null };
  } catch (e) {
    return { loaded: true, health: 'error', error: e.message };
  }
}

// pipeline 阶段的运行函数：调用 enrich 并返回结构化快照
async function cognitiveEnrichmentRun(ctx, hf) {
  const engine = new CognitiveEnrichment();
  const enriched = engine.enrich(typeof ctx.input === 'string' ? ctx.input : '', ctx);
  const result = {
    enriched: typeof enriched === 'string' ? enriched.slice(0, 500) : enriched,
    ready: engine.ready,
    modules: 20,
  };
  for (const [field, prop] of Object.entries(MODULE_FIELDS)) {
    let mod = null;
    // 惰性 getter 自己可能抛(见 heartflow.js 里几个 defineProperty)，接住
    try { mod = hf ? hf[prop] : null; } catch (_) { mod = null; }
    result[field] = _snapshotModule(mod);
  }
  return result;
}

module.exports = { CognitiveEnrichment, cognitiveEnrichmentRun };
