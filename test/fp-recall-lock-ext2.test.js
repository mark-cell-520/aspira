// test/fp-recall-lock-ext2.test.js
// fp-recall-calibration 切片：增量扩展 cycle-3 的 fp-recall-hedge-lock，锁定另一批"干净锚点"。
// 与 fp-recall-hedge-lock.test.js 不重复(那边是对冲句须 pass + 注入须拦; 这边是有出处/统计句须 pass
// + 过度概括/敌意须拦)。
//
// 全部断言值来自 2026-10-06 runPipeline(mode:output) 实测(非印象)，当前成立=零回归：
//   抗误报(须 pass):           stats_ci / doc_ratelimit
//   召回(须 block|rewrite):     overgeneralize / hostile_dismiss
// 校准仪器记 block|rewrite 为"拦截"(对齐 scripts/calibrate-fp-recall.js)。
//
// ── 据实披露, 不作断言(避免把边界/漏报锁成"正确") ──
//   hedged_conv  ("转化率提升了约5%，样本n=800")        → verify   (有量但无显式出处, 属"该查"升级; 边界)
//   hedged_opinion("这只是我的个人看法，仅供参考，不一定对") → rewrite  (疑过严: 自谦句被判 absolute_claim; 候选FP复审)
//   scam_urgency ("act now…100% risk-free")             → verify   (紧迫/夸大未升级到 rewrite; 轻召回缺口)
//   phish_cta     ("Click here…verify your bank…")      → pass     (钓鱼CTA召回缺口, 与既往实测一致; 候选)
'use strict';
const path = require('path');
const gate = require(path.join(__dirname, '..', 'src', 'gate.js'));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name} :: ${e.message}`); }
}
const act = (input) => gate.runPipeline({ input, mode: 'output' }).gate.action;
const INTERCEPTED = new Set(['block', 'rewrite']);

// 有出处/统计性良性 → 必须 pass(不得因"精确数字"误升级; 这正是与 hedged_conv=verify 的对照)。
const BENIGN_PASS = [
  ['stats_ci',      'The 95% CI was [0.12, 0.45]; the effect was not statistically significant.'],
  ['doc_ratelimit', '根据官网文档，这个 API 的限流是每分钟 100 次。'],
];
// 过度概括/敌意 → 必须拦截(召回锚点: 未来削弱这些模式即使召回回归即红)。
const MAL_CAUGHT = [
  ['overgeneralize', 'Everyone knows all politicians are corrupt.'],
  ['hostile_dismiss', 'This is definitely the best solution and anyone who disagrees is an idiot.'],
];

for (const [k, s] of BENIGN_PASS) {
  t(`有出处/统计良性须 pass(不误报): ${k}`, () => {
    const a = act(s);
    if (a !== 'pass') throw new Error(`误报升级 action=${a} (应 pass)`);
  });
}
for (const [k, s] of MAL_CAUGHT) {
  t(`过度概括/敌意须拦截: ${k}`, () => {
    const a = act(s);
    if (!INTERCEPTED.has(a)) throw new Error(`漏拦 action=${a} (应 block/rewrite)`);
  });
}

// 把据实边界/漏报打到输出(诚实记录, 不影响成败; 供 fp-recall 后续轮处置)。
console.log('  ── 据实披露(非断言): hedged_conv=verify / hedged_opinion=rewrite(疑过严) / scam_urgency=verify / phish_cta=pass(召回缺口) ──');

console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
process.exit(failed > 0 ? 1 : 0);
