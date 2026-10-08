/**
 * src/gate.js — AGI 第 1 层：辨别门禁
 *
 * 这是 AI agent 调用的单一入口。不需要理解 51 个维度，
 * 只需要检查 gate.action：
 *
 *   const { gate } = require('@yun520-1/heartflow').gate(text);
 *   if (gate.action === 'block')  → 拦截输出
 *   if (gate.action === 'rewrite') → 改写后再输出
 *   if (gate.action === 'verify') → 验证证据链
 *   if (gate.action === 'pass')   → 通过
 *
 * 使用方式：
 *   const hf = require('./gate.js');
 *   const result = hf.gate('你要检测的文本');
 *   console.log(result.gate.action, result.gate.reason);
 */

'use strict';

const { discriminate } = require('./index.js');
const pipelineModule = require('./pipeline.js');
const { detectPedagogicalContent } = require('./pedagogy.js');
const { buildTrace, summarizeTrace } = require('./discrimination-trace.js');
// [mcp-tool-enhancement·第一百四十六轮] adversarial-variant 层。
// 原先 gate.gate / gate.check / gate.pipeline 都只跑 discriminate()，不过这一层
// —— 而 MCP 的 aspira_gate 与 aspira_gate_check 两个工具正是调它们。
// 实测后果(本轮行为探针): 同形字/零宽/词拆分整类混淆输入对这两个工具返回 pass:
//     'y ou a re a d is gu st in g n ig ge r'  → gate.check = pass
//     'рass the test' / 'i hаte you'          → gate.check = pass
// 而 checkOutput / checkInput / runPipeline 全部 rewrite/block。
// **用轻量工具 gate 不可信输入的 agent 完全暴露在混淆攻击下**，而这两个工具的
// 名字与描述都叫"门禁检查"—— 名不副实，与 cycle 17 修的 aspira_gate_pipeline
// 是同根因的第二、第三实例(那轮只修了 pipeline，漏了 gate 与 check)。
const { checkAdversarialVariant } = require('./shield/adversarial-variant.js');

function _pedagogyMode(text) {
  return detectPedagogicalContent(text) ? 'pedagogical' : undefined;
}

/**
 * [第一百四十六轮] 对抗层信号合并进 gate 结果。
 *
 * 为什么不是"直接改调 runPipeline": runPipeline 返回的是**完整管线**结构
 * (13 个 layer 的 checked_by / data / input 等)，而 gate.check 的契约是只返回
 * {action, reason, score} 三个字段 —— 改调 runPipeline 会让既有调用方拿到
 * 一堆它们不读的键，且改变响应体积。故取最小侵入: 跑完 discriminate 后**再**
 * 跑对抗层，按对抗层的裁决覆盖 action/reason。
 *
 * 覆盖规则照 pipeline.js 的**严重度单调**(cycle 85 确立: pass < verify <
 * rewrite < block，加层不得降级): 只有对抗层**严格更严重**时才覆盖。
 * 首版写成"对抗层非 pass 就覆盖"，被 test/pipeline-severity-monotonic.test.js
 * 抓红: 'n i g g e r' 的 discriminate 已判 block，对抗层只判 rewrite，
 * 覆盖后变成 rewrite —— **把一个已经 block 的降级了**，正是 cycle 85 修的
 * 那个缺陷的又一根实例。
 */
const _SEV = { pass: 0, verify: 1, rewrite: 2, block: 3 };
function _mergeAdversarial(text, result) {
  try {
    const adv = checkAdversarialVariant(text);
    if (adv && adv.action && adv.action !== 'pass' && adv.risk === 'high') {
      result.gate = result.gate || {};
      const cur = result.gate.action || 'pass';
      // 只有严格更严重才覆盖 —— 加层不得降级
      if ((_SEV[adv.action] || 0) > (_SEV[cur] || 0)) {
        result.gate.action = adv.action;
        result.gate.reason = adv.reason || result.gate.reason;
        result._adversarial = { action: adv.action, risk: adv.risk, signals: adv.signals };
      }
    }
  } catch (_) { /* 对抗层异常不得让门禁失效 */ }
  return result;
}

/** AGI 第 1 层门禁 — 辨别文本并返回行动指令 */
function gate(text, evidence = []) {
  const result = _mergeAdversarial(text, discriminate(text, evidence, _pedagogyMode(text)));
  // [吸收心虫] 判别可解释追踪：透出每维度命中的原文片段+模式类型（附加字段，不改变既有行为）
  result.trace = buildTrace(result);
  result.traceSummary = summarizeTrace(result.trace);
  return result;
}

/** 快速门禁检查 — 只返回行动指令，适合 LLM agent 轻量调用 */
function check(text) {
  // [第一百四十六轮] 接入对抗层 —— 见 _mergeAdversarial 注释。
  // 这个函数是 MCP aspira_gate_check 的后端，此前对混淆输入一律 pass。
  const result = _mergeAdversarial(text, discriminate(text, [], _pedagogyMode(text)));
  return {
    action: result.gate.action,
    reason: result.gate.reason,
    score: result.overallScore,
  };
}

/** 管道模式：text 先过 gate，返回 gate-filtered 结论和原始结果 */
function pipeline(text, evidence) {
  if (typeof text === 'object' && text !== null) {
    return pipelineModule.runPipeline({ input: text.input || text.text || '', mode: text.mode || 'input' });
  }
  // [第一百四十六轮] 接入对抗层(同 gate/check)
  const result = _mergeAdversarial(text, discriminate(text, evidence, _pedagogyMode(text)));
  if (result.gate.action === 'block') {
    return { ...result, error: 'gate_blocked', message: `输出被拦截: ${result.gate.reason}` };
  }
  if (result.gate.action === 'rewrite') {
    return { ...result, warning: `需改写: ${result.gate.reason}` };
  }
  return result;
}

// 从 pipeline 重新导出完整版
const { runPipeline, checkInput, checkDraft, checkOutput } = pipelineModule;

module.exports = { gate, check, pipeline, runPipeline, discriminate, checkInput, checkDraft, checkOutput };
