// test/dim-rewrite-tier-escalation.test.js
// dimension-health-audit 切片刻意做的"最小 + 零回归 + 可falsify"增强(cycle-4/6 之外的新面)：
// 锁 rewrite 级维度(v46.7.73 `absolute_claim`)在清晰输入上确实**驱动 gate=rewrite**(而非只打分)。
//   ——防的是 perfect_error 那种"只评分不产生门禁动作"的静默死规则;
//   `dimension-health.test.js` 只锁 absolute_claim 会命中(count>0), 未锁它会 gate 升级, 非重复。
// 诚实附注(非断言): 实测该 finding 的 per-finding guidance 为空、gateVerdict.guidance 亦为空——
//   `absolute_claim` 等约 20 个门禁动作维度未在 GUIDANCE_MAP 登记修复句, 属"维度健康增强"候选, 另行处理。
'use strict';
const path = require('path');
const { discriminate } = require(path.join(__dirname, '..', 'src', 'index.js'));
const ok = (c, m) => { if (!c) throw new Error(m); };
let passed = 0, failed = 0;
function t(n, fn){ try{fn();passed++;console.log('  '+n);}catch(e){failed++;console.log('  ✗ '+n+' :: '+e.message);} }

t('absolute_claim(rewrite级)在清晰绝对化输入上驱动 gate=rewrite 且 finding 含该维度', () => {
  const r = discriminate('这个方法百分之百有效，绝对不会有任何问题，绝对最好，绝对没问题。');
  ok(r.gate.action === 'rewrite', 'gate 应为 rewrite, 实测 ' + r.gate.action);
  const dims = (r.findings || []).map((f) => f.dimension);
  ok(dims.includes('absolute_claim'), 'findings 应含 absolute_claim, 实测 [' + dims.join(',') + ']');
});
console.log('\n测试结果: ' + passed + ' 通过, ' + failed + ' 失败, 共 ' + (passed + failed) + ' 个');
process.exit(failed > 0 ? 1 : 0);
