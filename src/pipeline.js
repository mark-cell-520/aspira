/**
 * src/pipeline.js — 新愿全链路管线
 *
 * 将 12 个检测模块串成一条管道：
 *   scope-check → premise-check → discriminate → gate →
 *   doubt-engine → frame-check → output-gate → error-memory →
 *   auto-rules → intent-anchor
 *
 * 输入不变，输出统一 gate 格式。
 * 每条输出带完整检查链：checked_by[]
 */

'use strict';

const { checkScope } = require('./scope-check.js');
const { checkPremises } = require('./premise-check.js');
// NOTE: index.js <-> pipeline.js 存在循环依赖，若在此静态解构 discriminate
// 会在循环加载时序里拿到 undefined。改为运行时延迟取用。
const { doubt } = require('./doubt-engine.js');
const { check: frameCheck } = require('./frame-check.js');
const { screen } = require('./output-gate.js');
const em = require('./error-memory.js');
const auto = require('./auto-rules.js');
const { initAnchor, checkDrift } = require('./intent-anchor.js');
const { verify } = require('./verifier.js');
const { rewrite } = require('./rewriter.js');
const { checkAdversarialVariant } = require('./shield/adversarial-variant.js');
const { detectPedagogicalContent } = require('./pedagogy.js');
const { evaluateRules } = require('./knowledge/classics-value-mapper.js');

let pipelineAnchor = null;

/**
 * 闸禁动作的严重度序。单调比较是**加层不得降级**这一规则的依据。
 *
 * 为什么需要它: 第八十五轮跨入口实测发现, 同一句 "n i g g e r"
 * 在 aspira_gate_check(只跑 54 维判别器)读作 **block**,
 * 在 aspira_gate_pipeline(跑完整 pipeline, 层更多)读作 **rewrite**——
 * 入口更全的那个反而更宽松。因为 Layer 3.5 一见 rewrite 就整条覆盖 gate。
 * 一处发现, 两个工具的行为都错。
 */
const SEVERITY = { pass: 0, verify: 1, rewrite: 2, block: 3 };

/** 返回四个动作里的较严重者; 动作相同则返回 b(保持既有语义)。 */
function moreSevere(a, b) {
  const A = SEVERITY[a], B = SEVERITY[b];
  return B > A ? b : a;
}

/**
 * 运行全链路管线
 * @param {object} options
 * @param {string} options.input - 用户输入或 AI 草稿
 * @param {string} [options.mode='input'] - 'input' 或 'output' 或 'draft'
 * @param {string} [options.anchor] - 对话锚点（可选）
 * @returns {object} 统一 pipeline 结果
 */
function runPipeline({ input, mode = 'input', anchor, options = {} } = {}) {
  // 统一输入类型：非字符串（数字/对象/布尔）转字符串，避免下游 .slice/.match 崩溃
  if (input === null || input === undefined) return { error: 'no_input', gate: { action: 'pass', reason: '无输入' }, checked_by: [] };
  if (typeof input !== 'string') input = String(input);
  // Unicode 归一化（NFKC）：弯引号/全角/组合字符折回 ASCII，保证模式库（ASCII 撇号等）能命中
  // 例: U+2019 ' (curly apostrophe) → U+0027 ' —— godmode 类变体绕过依赖此修复
  if (/[\u2018\u2019\u201C\u201D\uFF01-\uFF5E]/.test(input)) {
    input = input.normalize('NFKC')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
  }

  const checked_by = [];
  let currentGate = { action: 'pass', reason: '通过' };
  let data = {};

  // ─── Layer 1: Scope Check — 可回答性预筛 ─────
  // 只对 input 模式执行: scope-check 语义是"新愿能否回答该请求",
  // AI 输出(output/draft)是解释/说明, 不该被"新愿能不能做"误杀。
  // (2026-08-14, DSH 桥接实战: checkOutput('搜索新闻需要外部接口') 被误 block)
  if (mode === 'input') {
    // options.canRealtime: 桥接场景执行者可联网时放行实时数据类 (2026-08-14)
    const scopeResult = checkScope(input, { canRealtime: options.canRealtime });
    checked_by.push({ layer: 'scope-check', action: scopeResult.action, pass: scopeResult.pass, reason: scopeResult.reason });
    if (!scopeResult.pass) {
      currentGate = { action: 'block', reason: scopeResult.reason, layer: 'scope-check' };
      return buildResult(input, currentGate, checked_by, data);
    }
  }

  // ─── Layer 2: Premise Check — 前提审核 ─────
  const premiseResult = checkPremises(input);
  checked_by.push({ layer: 'premise-check', issues: premiseResult.count, hasIssue: premiseResult.hasIssue });
  if (premiseResult.hasIssue) {
    data.premises = premiseResult.premises.slice(0, 3);
  }

  // ─── Layer 3: Discriminate — 45维辨别 ────
  const pedagogy = detectPedagogicalContent(input);
  const _discriminate = require('./index.js').discriminate || (typeof discriminate !== 'undefined' ? discriminate : null);
  const discResult = _discriminate(input, [], pedagogy ? 'pedagogical' : undefined);
  checked_by.push({ layer: 'discriminate', score: discResult.overallScore, verdict: discResult.verdict });
  data.discriminate = { verdict: discResult.verdict, score: discResult.overallScore, findings: discResult.findings };

  // [第八十五轮] 把 Layer 3 自己的闸禁结论**种进来**, 后续层只允许加层不许降级。
  // 在此之前 currentGate 从 pass 起步, discResult.gate 被整个丢掉(只记了
  // score 和 findings), 于是判别器判 block 的句子走完整 pipeline 可能只拿到
  // rewrite——实测 "n i g g e r": aspira_gate_check(判别器)读 block,
  // aspira_gate_pipeline(全层)读 rewrite。**入口更全的那个反而更宽松。**
  // 播种之后, 这个不一致随 monotonic 规则一起消失。
  if (discResult.gate && SEVERITY[discResult.gate.action] > SEVERITY[currentGate.action]) {
    currentGate = { action: discResult.gate.action, reason: discResult.gate.reason, layer: 'discriminate' };
  }

  // ─── Layer 3.2: Classical Knowledge — 古籍思想维度 ─────
  const classicalResult = evaluateRules(input);
  if (classicalResult.classicalRelevant) {
    checked_by.push({ layer: 'classical-knowledge', hits: classicalResult.hitCount, domain: classicalResult.domain });
    data.classical = classicalResult;
    if (classicalResult.findings?.length) {
      const warns = classicalResult.findings.filter(f => f.signal === 'warn');
      if (warns.length && currentGate.action === 'pass') {
        currentGate = {
          action: 'verify',
          reason: `古典思想警示: ${warns[0].reason}`,
          layer: 'classical-knowledge'
        };
      }
      // [dimension-health-audit·第一百五十五轮] 补 guidance。
      // 这条 push 走 data.discriminate.findings，**绕过了 discriminate() 内部的
      // guidance 附加循环**(那个 for..of 只处理它自己 push 的 findings)，于是古典
      // finding 永远不带 guidance。实测:
      //   本研究存在局限：样本集中于一线城市，外推需谨慎。
      // 推出 dimension=moral_foundations 的古典 finding，guidance 缺失。
      // GUIDANCE_MAP 已提到 src/index.js 模块级并导出 guidanceFor()，此处复用同一份。
      //
      // ⚠️ guidanceFor 必须**函数内** require: src/index.js 的 module.exports 里有
      // checkIndirectInjection: require('./pipeline').checkIndirectInjection，
      // 顶部 require 会成循环依赖，拿到还没赋完的 exports(guidanceFor=undefined)。
      // 与上面 Layer 3 的 require('./index.js').discriminate 同一风格。
      const guidanceFor = require('./index.js').guidanceFor;
      const _cf = classicalResult.findings.map(f => ({
        dimension: f.dimensions?.[0] || 'classical_knowledge',
        severity: f.signal === 'warn' ? 50 : f.signal === 'pass' ? 20 : 30,
        details: `[古典${f.ruleId}] ${f.reason}`,
        classical: true,
        signal: f.signal,
        evidence: f.evidence
      }));
      for (const _f of _cf) {
        const _g = guidanceFor && guidanceFor(_f.dimension);
        if (_g) _f.guidance = _g;
      }
      data.discriminate.findings.push(..._cf);
    }
  }

  // ─── Layer 3.5: Adversarial Variant — 对抗变体检测 ────
  // 启发：Hermes 专访「任何模型都可越狱，因为你有无限次尝试」——
  // 模式库修掉一个绕过，攻击者就用零宽/同形字/词拆分继续试。
  // 把攻击者的尝试内置成检测器的主动攻击面。
  const advResult = checkAdversarialVariant(input);
  checked_by.push({ layer: 'adversarial-variant', action: advResult.action, risk: advResult.risk });
  // data.adversarial 一律记录, 与动作无关——否则某个分支漏写就静默丢了整层证据。
  data.adversarial = { risk: advResult.risk, signals: advResult.signals, normalized: advResult.normalized };
  // [第八十五轮] 加层不得降级: 仅当 advResult 的动作**严格更严重**时才覆盖。
  // 修的是: "n i g g e r" 走到这里时 discriminate 层已判 block(hate_speech),
  // 而原代码一见 rewrite 就整条覆盖, 于是完整 pipeline 比判别器单跑更宽松。
  if (advResult.action && SEVERITY[advResult.action] > SEVERITY[currentGate.action]) {
    currentGate = {
      action: advResult.action,
      reason: `对抗变体: ${(advResult.signals || []).map(s => s.name).join('、')}`,
      layer: 'adversarial-variant',
    };
  }

  // ─── Layer 3.6: Dao Decision — 道论监督 ──────────────────────
  try {
    const daoMod = require('./core/dao-decision.js');
    const daoResult = new daoMod.DaoDecision().evaluate({ text: input, history: [] });
    checked_by.push({ layer: 'dao-decision', daoScore: daoResult.daoScore, passed: daoResult.passed, flags: (daoResult.flags || []).slice(0, 3) });
    if (daoResult.flags && daoResult.flags.length && currentGate.action === 'pass') {
      currentGate = { action: 'verify', reason: `道论警示: ${daoResult.flags[0].reason}`, layer: 'dao-decision' };
    }
    data.dao = daoResult;
  } catch (e) {
    checked_by.push({ layer: 'dao-decision', error: e.message });
  }

  // ─── Layer 3.7: Uncertainty Quantifier — 不确定性量化 ────────
  try {
    const uqMod = require('./core/uncertainty-quantifier.js');
    const uqResult = new uqMod.UncertaintyQuantifier().evaluate(input, { hasEvidence: !!data.evidence });
    checked_by.push({ layer: 'uncertainty', confidence: uqResult.confidence, level: uqResult.level, hallucinationRisk: uqResult.isHallucinationRisk });
    if (uqResult.isHallucinationRisk && currentGate.action === 'pass') {
      currentGate = { action: 'verify', reason: `幻觉风险: ${uqResult.hallucination?.signals?.join('; ') || '高'}`, layer: 'uncertainty' };
    }
    data.uncertainty = uqResult;
  } catch (e) {
    checked_by.push({ layer: 'uncertainty', error: e.message });
  }

  // ─── Layer 3.8: Priority Guardian — 优先级守护 ──────────────
  try {
    const pgMod = require('./core/priority-guardian.js');
    const pgResult = new pgMod.PriorityGuardian().check({ userIntent: input, action: currentGate.reason || '', humanProgress: {} });
    checked_by.push({ layer: 'priority-guardian', allowed: pgResult.allowed, path: pgResult.path, conflicts: (pgResult.conflicts || []).slice(0, 3) });
    if (!pgResult.allowed && currentGate.action !== 'block') {
      currentGate = { action: 'block', reason: pgResult.reason || '优先级守护拒绝', layer: 'priority-guardian' };
    } else if (pgResult.path === 'CONDITIONAL_ALLOW' && currentGate.action === 'pass') {
      currentGate = { action: 'verify', reason: '条件放行：需保持独立判断', layer: 'priority-guardian' };
    }
    data.priority = pgResult;
  } catch (e) {
    checked_by.push({ layer: 'priority-guardian', error: e.message });
  }

  // ─── Layer 3.9: Progress Judgment — 进步判断 ────────────────
  try {
    const pjMod = require('./core/progress-judgment.js');
    const pjResult = new pjMod.ProgressJudgment().judge({ action: input, claim: '', userIntent: input });
    checked_by.push({ layer: 'progress-judgment', isProgress: pjResult.isProgress, confidence: pjResult.confidence, pseudo: pjResult.pseudoCheck?.patterns });
    if (pjResult.standGround && currentGate.action === 'pass') {
      currentGate = { action: 'verify', reason: `伪进步警示: ${pjResult.standGround.reason || '需独立验证'}`, layer: 'progress-judgment' };
    }
    data.progress = pjResult;
  } catch (e) {
    checked_by.push({ layer: 'progress-judgment', error: e.message });
  }

  // ─── Layer 4: Gate — 门禁判定 ─────────
  // 若 adversarial-variant 已判高危 rewrite（对抗变体绕过），优先保留，不被普通 gate 覆盖
  if (!(data.adversarial && data.adversarial.risk === 'high')) {
    const upstreamBlocked = ['dao-decision', 'uncertainty', 'priority-guardian', 'progress-judgment'].some(layer => {
      const entry = checked_by.find(c => c.layer === layer);
      return entry && entry.action && ['block', 'rewrite'].includes(entry.action);
    });
    if (!upstreamBlocked) {
      currentGate = discResult.gate;
      checked_by.push({ layer: 'gate', action: currentGate.action, reason: currentGate.reason });
    } else {
      checked_by.push({ layer: 'gate', action: currentGate.action, reason: `上游监督保留: ${currentGate.reason}`, kept: true });
    }
  } else {
    checked_by.push({ layer: 'gate', action: 'rewrite', reason: `对抗变体优先: ${currentGate.reason}`, kept: true });
  }

  // ─── Layer 5: Evidence Verify (verify模式 + perfect_error rewrite 模式) ────
  // verify → 常规证据检查；rewrite(perfect_error) → 同样核查声明证据状态，标注疑似编造
  if (currentGate.action === 'verify' || (currentGate.action === 'rewrite' && discResult.dimensions?.perfect_error?.count >= 2)) {
    const evidenceResult = verify(input);
    checked_by.push({ layer: 'verifier', claims: evidenceResult.claims.length, verdict: evidenceResult.verdict });
    data.evidence = evidenceResult;
    // perfect_error 触发 rewrite 且声明全部需证据 → 给调用方"疑似编造"信号
    if (currentGate.action === 'rewrite' && evidenceResult.verdict === 'needs_evidence') {
      currentGate.reason = `${currentGate.reason}；证据核查: 声明无法验证(疑似编造)`;
      data.evidence.suspected_fabrication = true;
    }
  }

  // ─── Layer 6: Frame Check (仅output/draft模式) ─
  if (mode !== 'input') {
    const frameResult = frameCheck(input);
    checked_by.push({ layer: 'frame-check', issues: frameResult.issues.length });
    if (frameResult.issues.length > 0) {
      currentGate = frameResult.gate;
      data.frame = frameResult.issues;
    }
  }

  // ─── Layer 7: Output Gate (仅output模式) ────
  if (mode === 'output') {
    const screenResult = screen(input);
    checked_by.push({ layer: 'output-gate', issues: screenResult.findings.length });
    if (screenResult.findings.length > 0) {
      // 若已因 perfect_error 判 rewrite，保留更具体的原因（合并而非覆盖）
      const hadPerfectError = discResult.dimensions?.perfect_error?.count >= 2 && currentGate.action === 'rewrite';
      if (hadPerfectError && screenResult.gate.action === 'rewrite') {
        currentGate.reason = `${currentGate.reason}；输出门禁: ${screenResult.gate.reason || '需改写'}`;
      } else {
        currentGate = screenResult.gate;
      }
      data.outputIssues = screenResult.findings;
    }
  }

  // ─── Layer 8: Doubt Engine (仅draft/output模式) ────
  if (mode === 'draft' || mode === 'output') {
    const doubtResult = doubt(input);
    checked_by.push({ layer: 'doubt-engine', doubts: doubtResult.doubts.length, shouldStop: doubtResult.shouldStop });
    if (doubtResult.shouldStop) {
      // 合并而非覆盖：若已因 perfect_error/输出门禁判 rewrite，保留更具体的原因
      const hadPerfectError = discResult.dimensions?.perfect_error?.count >= 2 && currentGate.action === 'rewrite';
      if (hadPerfectError) {
        currentGate.reason = `${currentGate.reason}；doubt: ${doubtResult.gate.reason || '过度断言'}`;
      } else {
        currentGate = doubtResult.gate;
      }
      data.doubts = doubtResult.doubts;
    }
  }

  // ─── Layer 9: Error Memory — 检查历史错误 ──
  const recurrence = em.checkRecurrence(input);
  checked_by.push({ layer: 'error-memory', warnings: recurrence.warnings.length });
  if (recurrence.warnings.length > 0) {
    data.errorMemory = recurrence.warnings;
  }

  // ─── Layer 10: Auto Rules — 自生成规则 ────
  const autoResult = auto.checkAutoRules(input);
  checked_by.push({ layer: 'auto-rules', triggered: autoResult.triggered.length });
  if (autoResult.triggered.length > 0) {
    data.autoRules = autoResult.triggered;
    if (autoResult.triggered.some(t => t.action === 'block')) {
      currentGate = { action: 'block', reason: `自生成规则拦截: ${autoResult.triggered[0].trigger}`, layer: 'auto-rules' };
    }
  }

  // ─── Layer 11: Intent Anchor (可选) ────
  if (anchor) {
    if (!pipelineAnchor) { initAnchor(anchor); pipelineAnchor = anchor; }
    const driftResult = checkDrift(input);
    checked_by.push({ layer: 'intent-anchor', drifted: driftResult.drifted, hitRate: driftResult.hitRate });
    if (driftResult.drifted) {
      data.drift = driftResult;
    }
  }

  return buildResult(input, currentGate, checked_by, data);
}

function buildResult(input, gate, checked_by, data) {
  // 合并 discriminate 的顶层字段 (overallScore, verdict, findings, dimensions)
  const discLayer = checked_by.find(l => l.layer === 'discriminate');
  return {
    input: input.slice(0, 100),
    gate,
    verdict: discLayer?.verdict || '未检测',
    overallScore: discLayer?.score || 0,
    findings: data?.discriminate?.findings || [],
    checked_by,
    data: Object.keys(data).length > 0 ? data : undefined,
    summary: {
      layers_passed: checked_by.length,
      final_action: gate.action,
      block: gate.action === 'block',
      rewrite: gate.action === 'rewrite',
      verify: gate.action === 'verify',
      pass: gate.action === 'pass',
    },
  };
}

/**
 * 快捷：用 pipeline 检测用户输入
 */
function checkInput(text, options = {}) {
  // options.canRealtime: 桥接场景执行者能联网时, scope-check 放行实时数据类
  // (2026-08-14, DSH 桥接实战驱动 — 之前"搜索新闻"被误拦截)
  return runPipeline({ input: text, mode: 'input', options });
}

/**
 * 快捷：用 pipeline 检测 AI 草稿
 */
function checkDraft(text) {
  return runPipeline({ input: text, mode: 'draft' });
}

/**
 * 快捷：用 pipeline 检测 AI 输出（发出前）
 */
function checkOutput(text) {
  return runPipeline({ input: text, mode: 'output' });
}

module.exports = { runPipeline, checkInput, checkDraft, checkOutput };
