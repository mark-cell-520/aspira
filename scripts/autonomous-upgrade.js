#!/usr/bin/env node
/**
 * scripts/autonomous-upgrade.js — Aspira(新愿)自主升级决策引擎
 *
 * 新愿自主决策升级方向: 内省当前状态 → 生成候选升级切片 → AspiraDecision裁决 → 记录日志 → 输出选中切片。
 * 由每25分钟的定时任务调用; 定时任务据此执行选中切片 + 零回归门禁 + 同步技能副本 + 更新日志。
 *
 * 设计原则(对齐 aspira):
 * - 零依赖: 仅用 Node 内置 + aspira 自己的 AspiraDecision(判别器-first, 自决)。
 * - 可审计: 每个周期写一条 JSON 日志到 memory/autonomous-upgrades/(设计原则#3)。
 * - 不重复: 一次性切片完成后从候选空间移除(读历史 completed 集)。
 * - 自主: 升级方向由 AspiraDecision 综合可行性/风险/信心/后果值裁决, 非硬编码。
 *
 * 用法: node scripts/autonomous-upgrade.js   (stdout 输出选中切片 JSON)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { AspiraDecision } = require(path.join(ROOT, 'src', 'core', 'decision.js'));

const JOURNAL = path.join(ROOT, 'memory', 'autonomous-upgrades');
if (!fs.existsSync(JOURNAL)) fs.mkdirSync(JOURNAL, { recursive: true });

// ── 内省: 读取历史, 收集已完成的一次性切片(避免重复) + 统计各切片完成次数(轮换权重) ──
// [契约修复] `exhausted` 曾是**永久单向阀**: 一旦某轮 journal 标了 exhausted: true，
// `completed.add()` 让它从此退出候选空间，**再也不会回来**。
// 实测后果: `doc-honest-numbers` 在第 N 轮因"当时确已枯竭"被标 exhausted，
// 但"枯竭"是可恢复的 —— 文档数字会随代码增长再次出现偏差，
// 而该切片已永久消失，候选空间从 7 个降到 6 个，**轮换能力反而被削弱**。
// （这也解释了为何 test-coverage-gap 连续被选: 最能制衡它的那个选项不在了。）
//
// 修法: 把 exhausted 从"永久移除"改为"**冷却期**"——
// 按自标记起经过的周期数衰减，期满后重新进入候选空间。
// `once`(真正的一次性工作，如"接线 text-normalizer")仍是永久移除：
// 接线做完了就是做完了，不存在"再次需要接线"。
const completed = new Set();
const doneCount = new Map();
const exhaustedAt = new Map();   // chosen → 标记 exhausted 时的累计周期序号
let cycleSeq = 0;                // 递增周期序号(按 journal 文件名排序后的位置近似)
const doneSeq = [];              // 每轮 chosen 的先后顺序(用于"近期次数")
for (const f of fs.readdirSync(JOURNAL).sort()) {
  if (!f.endsWith('.json')) continue;
  cycleSeq++;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(JOURNAL, f), 'utf8'));
    if (j.status === 'done' && j.chosen) {
      doneCount.set(j.chosen, (doneCount.get(j.chosen) || 0) + 1);
      doneSeq.push(j.chosen);
      if (j.once) {
        completed.add(j.chosen);           // 真正一次性: 永久移出
      } else if (j.exhausted) {
        exhaustedAt.set(j.chosen, cycleSeq); // 记下标记位置, 冷却期后自动恢复
      }
    }
  } catch (_) { /* 跳过损坏条目 */ }
}

// ── 内省: 代码状态 ──
function readSrc(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return ''; } }
const indexSrc = readSrc('src/index.js');
const mcpSrc = readSrc('src/mcp-server.js');
const gateSrc = readSrc('src/gate.js');
const hfSrc = readSrc('src/core/heartflow.js');
const textNormWired = /require\(['"]\.\/text-normalizer/.test(indexSrc) || /text-normalizer/.test(gateSrc);
const fpFeedbackWired = /require\(['"]\.\/false-positive-feedback/.test(indexSrc) || /false-positive-feedback/.test(mcpSrc);
// gate-verdict 的接线点在 src/core/heartflow.js(紧邻 runThinkPipeline，
// 那里才是 _blockedByFirewall 等信号的产地)，不是 src/index.js。
// 原正则只查 index.js，属于检测器指错文件: 接得再对它也永远报 false。
// 现在两个文件都查，且要求确实是 require 形式而非注释里提到名字。
const gateVerdictWired = /require\(['"]\.\.?\/gate-verdict/.test(hfSrc) || /require\(['"]\.\/gate-verdict/.test(indexSrc) || /require\(['"]\.\.\/gate-verdict/.test(mcpSrc);
// [第二十三轮] 这两个数是喂给决策自己的，错了决策就基于虚假的规模做判断。
// 实测(周期23): 引擎原报 dimCount=59、testCount=241, 而真相是 54 维、310 个测试文件、
// 1369 个用例。两处都是"数了一个相邻的东西，然后用了它的名字"。
//
// dimCount 原数 `const dimMap = {...}` 的键。dimMap 带 5 个**别名**
// (bullshit / appeal_to_authority / pseudo_causal / soft_deflection / ai_writing_tell)，
// 它们是 dimMap 的键却不是 dimensions 的键 —— 实测 dimMap 59 键,
// 而 discriminate().dimensions 只有 54 键，多出的正是那 5 个。
// 现在改数 dimensions 字面量本身: 静态括号配平解析，与运行时逐键同序一致(实测验证过)。
const dimLit = indexSrc.match(/dimensions: \{/);
let dimCount = 0;
if (dimLit) {
  // 从 'dimensions: {' 起按花括号配平取到字面量结束，避免只匹配到同一行。
  const from = dimLit.index + dimLit[0].length - 1;
  let depth = 0, end = from;
  for (let i = from; i < indexSrc.length; i++) {
    if (indexSrc[i] === '{') depth++;
    else if (indexSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  dimCount = [...indexSrc.slice(from + 1, end).matchAll(/([a-z_]+):/g)].length;
}
// testCount 原用 readdirSync('test') —— 只数**顶层**，漏掉 test/compliance 等子目录
// (实测顶层 241、递归 310)；且它数的是**文件**，却被 prompt 写成"241测试"，
// 读起来像用例数(实测 1369)。现在递归数文件，并如实标注它是文件数。
// 用例数**不在此实测**: 跑一遍 run-all 要 32s，而本引擎 0.03s 就跑完，为拿一个数
// 慢一千倍不划算。宁可标注"未实测"，也不把一个错数说成测量结果。
let testFileCount = 0;
(function walk(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.test.js')) testFileCount++;
  }
})(path.join(ROOT, 'test'));
const testCount = testFileCount;


// ── 生成候选升级切片(新愿的机会空间) ──
const C = [];
// [契约修复] exhausted 的冷却期语义:
//   `once`  → 永久移出(一次性工作, 做完即完)
//   `exhausted` → 冷却 EXHAUST_COOLDOWN 个周期后自动恢复
// "枯竭"几乎总是**暂时**的: 文档数字会随代码增长重新偏差、
// 测试覆盖会随新模块重新出现缺口。永久移除一个可恢复的选项，
// 只会让候选空间单调收缩、轮换能力逐轮下降。
const EXHAUST_COOLDOWN = 6;
const add = (opt) => {
  if (completed.has(opt.id)) return;                       // once: 永久
  const at = exhaustedAt.get(opt.id);
  if (at !== undefined) {
    const elapsed = cycleSeq - at;
    if (elapsed < EXHAUST_COOLDOWN) return;                // 冷却中: 暂不参选
    // 冷却期满: 恢复参选(不再把它当 exhausted 处理)
  }
  C.push(opt);
};
// 一次性切片(once:true, 完成后移出候选空间)
if (!textNormWired) add({
  id: 'wire-text-normalizer', label: '接线 text-normalizer 归一化(抗混淆)',
  description: '把保留的 text-normalizer 接入 discriminate, 归一化对抗混淆文本(如 间.隔.字.符)提升检出; 接入最深, 高风险',
  feasibility: 0.5, risk: 0.6, confidence: 0.55, cost: 0.8, consequence_value: 0.85, once: true
});
if (!fpFeedbackWired) add({
  id: 'wire-false-positive-feedback', label: '接线 false-positive-feedback 误报反馈环',
  description: '把误报反馈自改进环接入 MCP(aspira_fp_feedback 工具), 支持标记误报以自校准; 中风险',
  feasibility: 0.65, risk: 0.35, confidence: 0.6, cost: 0.45, consequence_value: 0.55, once: true
});
if (!gateVerdictWired) add({
  id: 'assess-gate-verdict', label: '评估 gate-verdict 冗余性/是否接线',
  description: '评估 HeartFlow 的 gate-verdict 与 aspira 既有 verdict 是否冗余; 低风险低收益',
  feasibility: 0.85, risk: 0.15, confidence: 0.65, cost: 0.2, consequence_value: 0.35, once: true
});
// 常驻切片(可反复迭代; 被标记 exhausted 后移出候选空间, 实现健康轮换)
add({ id: 'dimension-health-audit', label: '维度健康审计与增强', description: '审计各维度触发率/误报, 强化弱维度或补语言覆盖; 中风险', feasibility: 0.6, risk: 0.4, confidence: 0.6, cost: 0.5, consequence_value: 0.7 });
add({ id: 'test-coverage-gap', label: '测试覆盖缺口填补', description: `为未覆盖模块补回归测试(当前 ${testCount} 个测试文件，含子目录；用例数未在此实测); 低风险`, feasibility: 0.75, risk: 0.2, confidence: 0.7, cost: 0.4, consequence_value: 0.6 });
add({ id: 'doc-honest-numbers', label: '文档诚实数字审计', description: '核对 SKILL/AGENTS/README 的维度/工具/测试数与代码一致; 低风险', feasibility: 0.85, risk: 0.15, confidence: 0.75, cost: 0.25, consequence_value: 0.5 });
add({ id: 'fp-recall-calibration', label: '误报/召回校准', description: '用良性/恶意样本校准判别阈值, 降低误报或补漏; 中风险', feasibility: 0.6, risk: 0.45, confidence: 0.55, cost: 0.5, consequence_value: 0.65 });
add({ id: 'mcp-tool-enhancement', label: 'MCP 工具增强', description: '增强 aspira_* 工具的参数/返回结构, 提升 agent 可用性; 低中风险', feasibility: 0.7, risk: 0.3, confidence: 0.65, cost: 0.4, consequence_value: 0.55 });
add({ id: 'adversarial-robustness', label: '对抗鲁棒性增强', description: '扩充混淆/绕过变体(leet/间隔/谐音)的判别模式; 中风险', feasibility: 0.55, risk: 0.45, confidence: 0.55, cost: 0.55, consequence_value: 0.7 });
add({ id: 'performance-optimization', label: '性能优化', description: '优化判别热路径/缓存, 降低延迟; 中风险', feasibility: 0.55, risk: 0.45, confidence: 0.55, cost: 0.55, consequence_value: 0.45 });

// ── 轮换权重: 按"近期被选中的次数"递减 consequence_value(边际收益递减) ──
// [契约修复·第二十六轮] 旧实现按**累计**完成次数衰减: `cv - 0.08*n`, 下限 0.05。
// 实测它已经饱和失效: doc-honest-numbers 完成 33 次、test-coverage-gap 37 次,
// 两者都被压到同一个下限 0.05 —— consequence_value 对所有候选变成**同一个常数**,
// 在复合分里不再有任何区分度。而复合分公式(decision.js:341)是
//   feasibility*.15 + identity*.25 + consequence_value*.25 + (1-risk_penalty)*.25 + confidence*.10
// cost 根本不在复合分里。于是排名永久退化成静态可行性/风险/置信表, 而那张表
// 结构性偏袒 doc-honest-numbers(feasibility 0.85 / risk 0.15 / confidence 0.75 全是最高),
// 于是它连选 8 个周期。**一个声称在轮换、实则 28 个周期前就饱和的机制。**
// 修法: 改成**近期窗口**计数。理由:
//   · 有界 —— 窗口内最多 RECENT_WINDOW 次, 永远不会把不同切片压到同一个值;
//   · 自愈 —— 某切片离开窗口后权重自动恢复, 不需要 exhausted 冷却期兜底;
//   · 直接编码"别反复做同一件事", 而这正是轮换想要的语义。
// 注意这是**脚本层**的候选调整, 不改 decision.js 的共享契约(aspira_decision_decide
// 也读那个复合分), 所以不触发"改变共享契约就继承所有旧调用方"那条。
const RECENT_WINDOW = 10;
const recentCount = new Map();
for (const id of doneSeq.slice(-RECENT_WINDOW)) {
  recentCount.set(id, (recentCount.get(id) || 0) + 1);
}
for (const opt of C) {
  const n = recentCount.get(opt.id) || 0;
  if (n > 0 && typeof opt.consequence_value === 'number') {
    // 窗口内每出现一次扣 0.14; 下限 0.05 —— 只是防止出现负的"后果值"，
    // 不再承担"让不同切片趋同"的副作用, 因为窗口计数彼此不同。
    opt.consequence_value = Math.max(0.05, Math.round((opt.consequence_value - 0.14 * n) * 100) / 100);
  }
}

if (C.length === 0) {
  console.log(JSON.stringify({ chosen: null, reason: 'no candidates' }));
  process.exit(0);
}

// [第二十六轮] 只打印候选表(含轮换权重作用后的 consequence_value)后退出,
// 不裁决、不写 journal。轮换权重以前只能从"最终选了谁"反推, 而复合分里
// feasibility/risk/confidence 也在起作用, 于是**权重是否还有区分度**根本
// 观测不到 —— 那正是它饱和了 28 个周期没人发现的原因。
if (process.argv.includes('--debug-candidates')) {
  console.log(JSON.stringify({
    debugCandidates: true,
    recentWindow: RECENT_WINDOW,
    candidates: C.map(o => ({
      id: o.id,
      recentCount: recentCount.get(o.id) || 0,
      totalDone: doneCount.get(o.id) || 0,
      consequence_value: o.consequence_value,
    })),
  }));
  process.exit(0);
}

// ── AspiraDecision 裁决(新愿自主决策升级方向) ──
let r;
try {
  const decision = new AspiraDecision();
  r = decision.decide({
    task: `Aspira 自主升级: 选定下一个升级切片(当前 ${dimCount}维[discriminate().dimensions 实测键数], ${testCount} 个测试文件[递归计数，用例数未在此实测])`,
    intent: 'genuinely upgrade aspira; maximize long-term discrimination quality; zero-regression; fully autonomous',
    constraints: { minFeasibility: 0.4, maxRisk: 0.78, minConfidence: 0.5 },
    options: C
  });
} catch (e) {
  console.log(JSON.stringify({ chosen: null, reason: 'decision error: ' + e.message }));
  process.exit(1);
}

// ── 平局自主打破: AspiraDecision 对并列弃权时(全自动无需人工), 顶层(within 0.01)中按 consequence_value 高 → risk 低 → cost 低抉择 ──
let chosen = r.chosen;
let tieNote = null;
if (!chosen && Array.isArray(r.all_options) && r.all_options.length) {
  const scored = r.all_options
    .map(o => ({ id: o.id, comp: (o.composite != null ? o.composite : o.score), opt: C.find(c => c.id === o.id) }))
    .filter(x => x.opt && typeof x.comp === 'number');
  if (scored.length) {
    const maxC = Math.max(...scored.map(s => s.comp));
    const top = scored.filter(s => s.comp >= maxC - 0.01);
    top.sort((a, b) => (b.opt.consequence_value - a.opt.consequence_value) || (a.opt.risk - b.opt.risk) || (a.opt.cost - b.opt.cost));
    chosen = top[0].id;
    tieNote = `AspiraDecision并列弃权, 自主打破: 顶层[${top.map(t => t.id).join(',')}], 按consequence_value最高选 ${chosen}`;
  }
}

// ── 记录日志(可审计) ──
// [第二十三轮] --introspect-only: 只打印自省数，不决策、不写 journal。
// 为什么需要它: 周期23 发现自省数本身是错的(dimCount 59 vs 实测 54,
// testCount 241 vs 递归 310)，要给这两个数上锁就得让测试能跑到它们。
// 而这个脚本每次运行都会 writeFileSync 一个 journal —— 测试每跑一遍套件就多一份
// journal，那是用污染换覆盖。加个开关，测试走开关，正常调度路径一个字节都不变。
const INTROSPECT_ONLY = process.argv.includes('--introspect-only');
const chosenOpt = C.find(o => o.id === chosen) || {};
const entry = {
  ts: new Date().toISOString(),
  chosen: chosen,
  tieBreak: tieNote,
  once: !!chosenOpt.once,
  composite: r.composite_score,
  confidence: r.confidence,
  reasoning: r.reasoning,
  all_options: r.all_options,
  introspection: { dimCount, testCount, textNormWired, fpFeedbackWired, gateVerdictWired },
  status: 'decided'
};
if (INTROSPECT_ONLY) {
  console.log(JSON.stringify({ introspectOnly: true, introspection: entry.introspection }, null, 2));
  process.exit(0);
}
const fname = path.join(JOURNAL, `upgrade-${Date.now()}.json`);
fs.writeFileSync(fname, JSON.stringify(entry, null, 2));

// ── 输出选中切片(供定时任务执行) ──
console.log(JSON.stringify({
  chosen: chosen,
  tieBreak: tieNote,
  label: chosenOpt.label,
  journal: path.relative(ROOT, fname),
  composite: r.composite_score,
  confidence: r.confidence,
  reasoning: r.reasoning,
  introspection: entry.introspection
}, null, 2));
