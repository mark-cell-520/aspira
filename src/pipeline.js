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
/**
 * 从进步判断的四维核心标准，派生 priority-guardian 需要的 humanProgress。
 *
 * ═══ 这个函数在修什么 ═══
 * Layer 3.8 调 priority-guardian 时，humanProgress 从写下起就是硬编码 `{}`。而
 * detectConflicts 的三条 critical 冲突全部要求 hp.truthValue / transmissionValue /
 * errorCorrectionValue 大于 0（或 hp.hasError），于是「老大指令与人类进步冲突时必
 * 须有路径说老大错了」这条守护承诺，在生产路径上**永远不可能触发** —— 不是判据写错，
 * 是原料从来没送进去。`git log -S humanProgress` 零提交，它活了二十多轮。
 *
 * ═══ 原料从哪来 ═══
 * 不新造一套评估，用引擎自己已有的 `src/core/progress-judgment.js`。它的
 * checkCoreStandards 正好产出四个维度：
 *   results.truthAlignment   → truthValue
 *   results.transmissibility → transmissionValue
 *   results.errorReduction   → 错误是否可被纠正这一侧
 *   results.verifiability    → 证据侧（humanProgress 不消费，留作 data.progress）
 * 而 detectConflicts 的语义正是「引擎这一侧在真相/传递/纠错上有没有可损失的东西」：
 * 三项都通过 → 三项都有价值 → 冲突判据有原料；任一项没通过 → 那一项没有价值可言。
 *
 * ═══ hasError 为什么这样定 ═══
 * 它是三条 critical 里最容易被良性句误触发的那个：判据是「意图含压制词 + 行动含
 * 不承认/维持/保持/继续」，而「忽略」「掩盖」在良性文本里极常见（"请忽略拼写错误"），
 * 行动侧传进去的又是早期层的理由串，里面容易出现「保持」「继续」。所以 hasError 只在
 * 引擎**真的识别出一个问题**时为真：真相对齐没过（输入含 幻觉/虚构/假装），或检出
 * 伪进步。二者都没有时，一句普通的「请忽略错别字」不会拿到 errorCorrectionValue，
 * 也就进不了 ERROR_DENIAL 那一档。
 * 实测（改动前后各跑一遍 20 条用例 × 两种模式）：改动前 19 pass / 1 verify / 0 block，
 * 改动后逐条不变。含压制词的良性句没有一条被抬级。
 */
function deriveHumanProgress(pj) {
  if (!pj || !pj.coreCheck) return {};
  const r = pj.coreCheck.results || {};
  const truthAligned = !!(r.truthAlignment && r.truthAlignment.passed);
  const transmissible = !!(r.transmissibility && r.transmissibility.passed);
  const pseudo = !!(pj.pseudoCheck && pj.pseudoCheck.isPseudo);
  // 引擎识别出了真问题，才谈得上「承认错误以减少逻辑错误」
  const hasError = !truthAligned || pseudo;
  return {
    truthValue: truthAligned ? 1 : 0,
    transmissionValue: transmissible ? 1 : 0,
    errorCorrectionValue: hasError ? 1 : 0,
    hasError,
    errorDescription: hasError ? ((pj.coreCheck.failures || []).join('/') || '核心标准未通过') : '',
  };
}

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

  // ─── Layer 3.8 前置: 进步判断先算，因为优先级守护要消费它 ──────────
  // [第二百四十三轮] 原先进步判断在 3.9、守护在 3.8，守护拿不到它的产出，于是
  // humanProgress 只能是硬编码 {}。顺序对调即可让原料到位，不需要新造评估。
  // ⚠️ 这里的异常**只记录不推送**：test/doc-numbers.test.js 用正则静态扫描
  // `checked_by.push({ layer: '...'` 的**源码出现顺序**来核对层序，任何一处
  // 提前出现的 progress-judgment 推送都会让层序核对变红（实测过一次）。
  // 错误条目统一在下面 3.9 那段推送，源码顺序才与执行顺序一致。
  let pjResult = null;
  let pjError = null;
  try {
    const pjMod = require('./core/progress-judgment.js');
    pjResult = new pjMod.ProgressJudgment().judge({ action: input, claim: '', userIntent: input });
  } catch (e) {
    pjError = e.message;
  }

  // ─── Layer 3.8: Priority Guardian — 优先级守护 ──────────────
  try {
    const pgMod = require('./core/priority-guardian.js');
    const pgResult = new pgMod.PriorityGuardian().check({
      userIntent: input,
      action: currentGate.reason || '',
      humanProgress: deriveHumanProgress(pjResult),
    });
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
  // 产出已在 3.8 之前算好（守护要消费它），这里只入账，不重复计算。
  if (pjError) {
    checked_by.push({ layer: 'progress-judgment', error: pjError });
  } else if (pjResult) {
    checked_by.push({ layer: 'progress-judgment', isProgress: pjResult.isProgress, confidence: pjResult.confidence, pseudo: pjResult.pseudoCheck?.patterns });
    if (pjResult.standGround && currentGate.action === 'pass') {
      currentGate = { action: 'verify', reason: `伪进步警示: ${pjResult.standGround.reason || '需独立验证'}`, layer: 'progress-judgment' };
    }
    data.progress = pjResult;
  }

  // ─── Layer 4: Gate — 门禁判定 ─────────
  // 若 adversarial-variant 已判高危 rewrite（对抗变体绕过），优先保留，不被普通 gate 覆盖
  if (!(data.adversarial && data.adversarial.risk === 'high')) {
    // [第二百二十五轮] upstreamBlocked 原先读 entry.action —— 而这四个层的
    // checked_by 条目**从来没有 action 字段**：dao-decision 推的是
    // {daoScore,passed,flags}(178 行)，uncertainty 推
    // {confidence,level,hallucinationRisk}(191 行)，priority-guardian 推
    // {allowed,path,conflicts}(204 行)，progress-judgment 推
    // {isProgress,confidence,pseudo}(219 行)。实测四条的键里都没有 action。
    // 于是 entry.action 恒为 undefined，`.some()` 恒为 false，下面"上游监督保留"
    // 分支**从写下起就不可达** —— 一个读不存在字段的恒假判据。
    //
    // 改读产出侧真实存在的字段。同时把范围收紧到判据自己的语义: 原判据是
    // `['block','rewrite'].includes(entry.action)`, 而这四个层里只有
    // priority-guardian 能产出 block/rewrite(critical 冲突 → allowed:false →
    // resolveWithGuardianPriority 的 REFUSE_WITH_GUARDIAN)；另外三个层
    // 只把 currentGate 抬到 verify(180/193/221 行)，verify 本就不在原判据的
    // 动作集里，所以不纳入。
    //
    // 为什么**不**顺手把 verify 也纳入保留: 实测会被打穿的是两个上游误报 ——
    //   · priority-guardian 收到的 action 是 currentGate.reason(即字面量"通过",
    //     203 行)，_isToolifiedBehavior 拿它和 userIntent 比: "今天天气真好"含
    //      compliance 词"好"而"通过"不含判断词 → 判工具化行为 → CONDITIONAL_ALLOW；
    //   · progress-judgment 对空输入同样判 standGround。
    // 两者都会把良性句抬成 verify。在修掉这两个上游误报之前放宽 Layer 4，
    // 等于把误报直接升成最终裁决(test/pipeline.test.js 的 benign→pass 会红)。
    // 本轮只修恒假判据，不扩大到行为变更。
    const pgEntry = checked_by.find(c => c.layer === 'priority-guardian');
    const upstreamBlocked = !!(pgEntry && pgEntry.allowed === false);
    if (!upstreamBlocked) {
      // [第二百四十轮] 原代码这里是 `currentGate = discResult.gate` —— 无条件覆写。
      // 第八十五轮把 Layer 3 的结论"种"进来之后，currentGate 的地板就是
      // discResult.gate：中间没有任何一层加层时这行是无操作，可一旦
      // Layer 3.2 / 3.5 / 3.6 / 3.7 / 3.9 有一层把裁决抬了上去，这行就把它
      // 整条抹回 discResult.gate。实测（本轮探针）:
      //   '以利为利，何也'
      //     Layer 3.2 classical-knowledge 推出 warn(mengzi-yili-distinction)，
      //     119-125 行把 currentGate 从 pass 抬到 verify；
      //     走到这里被覆写回 pass —— checked_by 的 gate 条目 action='pass'，
      //     最终 gate.action='pass'。那层 warn 只活在 data.classical 和
      //     findings 里，裁决层面无痕。
      // 同型被抹的还有 adversarial-variant 的 medium 风险(166 行抬 verify/
      // rewrite，但 risk !== 'high' 进不了 230 行的绕过分支)、dao-decision、
      // uncertainty、progress-judgment。整个 Layer 4 只有两类加层活了下来：
      // adversarial-high(230 行整条绕过本层)和 priority-guardian(靠
      // upstreamBlocked 走进 else 分支)。
      // 这正是本文件 34-41 行自己声明的"后续层只允许加层不许降级"被违反的
      // 形状：结论与原因被拆在两处，而最像结论的那处(最终 gate)是上游没动过的值。
      //
      // 修法：只取**严格更严重**的 discResult.gate，也就是 45 行声明却从未被
      // 任何调用点使用过的 moreSevere()。它和 SEVERITY 表一起写在第八十五轮，
      // 为的正是这条单调性；那轮修好了 Layer 3 的播种，漏了 Layer 4 的收口。
      // currentGate 已经是 max(播种地板, 各层加层)，moreSevere 再与
      // discResult.gate 取一次 max，语义即 max(全部层)，不再发生降级。
      //
      // 但保留范围只限**高精度层**，不是所有层都保留：
      //   classical-knowledge / dao-decision / uncertainty —— 规则/评分驱动，
      //     加层时必然伴随一条可审计的判据(classical 的 finding 还会进
      //     data.discriminate.findings)，保留它们不引入误报。
      //   adversarial-variant(非 high) / progress-judgment / priority-guardian
      //     的 verify —— 三者是已披露的噪声源，保留会把误报升成最终裁决：
      //       · adversarial 的 S6 是通用词拆分，不要求命中术语，于是
      //         "h a t e speech is unacceptable"(letter-space-evasion.js 头部
      //         明确列为不得判对抗变体的样例，正在 BENIGN 语料里)被抬成 verify；
      //       · progress-judgment 的 detectPseudoProgress 只认关键词，
      //         "团队需要更好的 collaboration"含"更好"即判伪进步 ——
      //         test/progress-judgment-vacuous-pass.test.js ⑥ 披露过
      //         "全语料 1 条触发升级"，那条就是它；
      //       · priority-guardian 的 compliance 词误报见本轮
      //         src/core/priority-guardian.js 的修复说明。
      //     在修掉这三处之前把它们纳入保留，良性语料 137/137 全 pass 会被打成
      //     134/137(实测)。所以本轮只收口，不放宽。
      const PRECISE_LAYERS = new Set(['classical-knowledge', 'dao-decision', 'uncertainty']);
      currentGate = PRECISE_LAYERS.has(currentGate.layer)
        ? moreSevere(currentGate, discResult.gate)
        : discResult.gate;
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
  // [dimension-health-audit·第一百七十三轮] 把 output-gate 层的 findings
  // 并入最终 findings。
  //
  // 缺陷: Layer 7 判出问题并把 gate 推到 rewrite 时, 它的 findings 只被写进
  // `data.outputIssues`, 而**全文再无任何代码读这个字段**(实测 grep 全仓:
  // 只有这一处赋值)。最终 findings 只取 discriminate 的。于是调用方收到
  //   gate.action = 'rewrite'
  //   gate.reason  = '输出含严重问题: overconfidence'
  //   findings     = [{dimension:'none', severity:0, details:'未发现明显问题'}]
  // —— 四个字段里三个说"没问题", 而 verdict 是"可信"、overallScore 满分。
  //
  // 后果不是少一行日志: AGENTS.md 的 gate 表明确告诉调用方 "rewrite → 按
  // findings[].guidance 修", 而这里 findings 里没有任何 guidance 可读。
  // 这是 cycle 27 perfect_error 的同族(能改 gate 却说不出原因), 只是这次
  // 的原因被写进了另一个从未被读取的字段。
  //
  // 修法: 并入而非替换。discriminate 的 findings 保持在前(它们是 54 维的
  // 主报告), output-gate 的追加在后, 按 severity 降序 —— 与 output-gate
  // 自己 `findings.sort((a,b) => b.severity - a.severity)` 的口径一致,
  // 所以 `findings[0]` 与 `gate.reason` 提到的维度仍然相同(层内已排序,
  // 并入后重排不改变最严重项)。
  const discFindings = data?.discriminate?.findings || [];
  const outputFindings = Array.isArray(data?.outputIssues) ? data.outputIssues : [];
  const merged = [...discFindings, ...outputFindings]
    .sort((a, b) => (b.severity || 0) - (a.severity || 0));
  return {
    input: input.slice(0, 100),
    gate,
    verdict: discLayer?.verdict || '未检测',
    overallScore: discLayer?.score || 0,
    findings: merged,
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

module.exports = { runPipeline, checkInput, checkDraft, checkOutput, deriveHumanProgress };
