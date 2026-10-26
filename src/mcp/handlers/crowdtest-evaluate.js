'use strict';
/**
 * mcp/handlers/crowdtest-evaluate.js — 新愿众测题判分 MCP 处理器
 * 只做参数适配与错误兜底；判分逻辑全在 src/crowdtest/evaluate-answer.js。
 */

const evaluator = require('../../crowdtest/evaluate-answer.js');

/**
 * 兜底返回体。键名与 evaluate() 成功路径逐字对齐。
 *
 * [缺陷修复] 原先两条兜底分支(空答案 / 判分器抛异常)返回的是另一套中文键:
 *     { 判定: 'FAIL', 硬失败项: [...], 需人工陪审: '...' }
 * 而成功路径返回 { verdict, hardFail, needsHumanReview, ... }。调用方按
 * 成功路径的契约读 result.verdict, 在两条兜底分支上一律得到 undefined ——
 * "判分器自己炸了"和"答案不合格"在消费侧看起来都是"没有 verdict", 分不出
 * 是判分器故障还是被测模型不合格。全仓 grep 过: 判定/硬失败项/需人工陪审
 * 这三个中文键没有任何读取方, 改键名不破坏任何现有消费侧。
 *
 * 兜底体保留 needsHumanReview 的两个固定子键, 因为成功路径的
 * gateFalsePositive 提示对"判分器故障"这一格同样适用(调用方需要知道
 * 这条不是对被测模型的判决)。
 */
function _fallback(hardFail, humanNote) {
  return {
    verdict: 'FAIL',
    hardFail: Array.isArray(hardFail) ? hardFail : [String(hardFail)],
    needsHumanReview: {
      semantic: '归因方向/方案优劣/话术效果——新愿判不了，必须人工或 LLM 陪审',
      judgeSelfError: humanNote,
    },
    note: '本条为判分器兜底返回，不是对被测模型的形式分判决；键名与正常返回一致',
  };
}

module.exports = function handleCrowdtestEvaluate(args) {
  args = args || {};
  const answer = args.answer || '';
  if (!answer.trim()) {
    return _fallback(['未提供答案文本'], '请提供被测模型答案全文');
  }

  try {
    return evaluator.evaluate(answer, {
      materials: Array.isArray(args.materials) ? args.materials : [],
      materialIds: Array.isArray(args.materialIds) ? args.materialIds : null,
      requiredDeliverables: Array.isArray(args.requiredDeliverables) ? args.requiredDeliverables : [],
      requiredCounts: (args.requiredCounts && typeof args.requiredCounts === 'object') ? args.requiredCounts : null,
      minCitations: typeof args.minCitations === 'number' ? args.minCitations : 3,
      runGate: args.runGate !== false,
    });
  } catch (e) {
    return _fallback(
      ['判分器异常: ' + e.message],
      '判分器自身故障，检查 src/crowdtest/（不视为被测模型不合格）'
    );
  }
};
