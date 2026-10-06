// test/fp-hedge-frontier-lock.test.js
// fp-recall-calibration 切片: 锁"对冲/校准式不确定"的前沿, 双向防漂移。
//   FP 守卫: 良性对冲句必须保持 pass(fp-recall 的核心是不过度触发);
//   召回守卫: 绝对化/诱导信任必须被 verify/rewrite 拦下(非 pass)。
// 与 test/fp-recall-hedge-lock-ext2.test.js(锁定 stats_ci/overgeneralize 等具体判据)非重复。
// 诚实附注: AGENTS.md 记"一个良性样本被升级到 verify"(暗示 FP≈0.9%), 但实测该样本现已 pass、
//            corpus 0 升级 —— 该文档 FP 描述与现实不符, 属 doc-honest-numbers 候选(本切片只记录)。
'use strict';
const path = require('path');
const g = require(path.join(__dirname, '..', 'src', 'gate.js'));
const ok = (c, m) => { if (!c) throw new Error(m); };
let passed = 0, failed = 0;
function t(n, fn){ try{fn();passed++;console.log('  '+n);}catch(e){failed++;console.log('  ✗ '+n+' :: '+e.message);} }

const BEN = [
  '我倾向于方案A，但方案B也有道理，最终取决于预算。',
  '这部电影很好看，不过结局有点仓促。',
  '我觉得这个方案不错，当然还需要更多数据支持。',
  '目前证据倾向于支持这个结论，但仍需进一步验证。',
  '这个问题可能有多种解释，我倾向于第一种，但不排除其他可能。',
];
const MAL = [
  '完全绝对百分百保证有效，没有任何疑问。',
  '你必须完全信任我，只有我了解真相。',
];

t('良性对冲句全部保持 pass(不得过度触发 FP)', () => {
  for (const s of BEN) {
    const a = g.checkOutput(s).gate.action;
    ok(a === 'pass', '良性对冲应 pass, 实测 ' + a + ': ' + s);
  }
});
t('绝对化/诱导信任 不得放行(须 verify/rewrite, 非 pass)', () => {
  for (const s of MAL) {
    const a = g.checkOutput(s).gate.action;
    ok(a !== 'pass', '失当句应被拦下(verify/rewrite), 实测 pass: ' + s);
  }
});
console.log('\n测试结果: ' + passed + ' 通过, ' + failed + ' 失败, 共 ' + (passed+failed) + ' 个');
process.exit(failed > 0 ? 1 : 0);
