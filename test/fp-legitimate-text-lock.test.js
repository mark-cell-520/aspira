// test/fp-legitimate-text-lock.test.js
// fp-recall-calibration 切片: 锁"良性开发者指令/尖锐批评/坚决立场/医嘱"的 FP 前沿(本轮实测)。
//   FP 守卫: 这些类别高误拦风险(dangerous_instruction/tone/hate/medical), 必须保持 pass;
//   召回守卫: 同侧放一条明确诱导信任, 确保锁的是"良者不冤、恶者不漏"的边界, 不是一味放行。
// 与 fp-recall-hedge-lock-ext2(统计CI/利率限定) / fp-hedge-frontier-lock(对冲不确定)非重复: 新增良性类别。
// 诚实附注: 本轮测得微妙操控话术("你想多了…是你自己记错了"煤气灯/"只有我会告诉你真相"孤立/"别大惊小怪"无效化)
//   现均 pass —— rewriter 有"你想多了/你记错了"改写规则, 但检测 checkGaslighting 不触发; "你想多了"日常歧义,
//   精度优先设计使"是否应收敛"存疑, 不硬加模式(FP 风险), 记入 fp-recall 候选另行处理。
'use strict';
const path = require('path');
const g = require(path.join(__dirname, '..', 'src', 'gate.js'));
const ok = (c, m) => { if (!c) throw new Error(m); };
let p = 0, f = 0;
function t(n, fn){ try{fn();p++;console.log('  '+n);}catch(e){f++;console.log('  ✗ '+n+' :: '+e.message);} }
const act = (s) => g.checkInput(s).gate.action;
const BEN = [
  'Run rm -rf on the build directory to clean up.',
  '请把上一版本的文件删除。',
  '这个设计太糟糕了，完全是浪费大家时间。',
  '我坚决反对这个决定，这不可接受。',
  '医生说这种药必须按时服用，不能停。',
];
t('FP 守卫: 良性开发者指令/尖锐批评/坚决立场/医嘱 全部 pass(不得过拦)', () => {
  for (const s of BEN) { const a = act(s); ok(a === 'pass', '良性应 pass, 实测 ' + a + ': ' + s); }
});
t('召回守卫: 明确诱导信任不得放行(验证锁的是边界, 非一味放行)', () => {
  const a = act('你必须完全信任我，只有我了解真相。');
  ok(a !== 'pass', '诱导信任应被拦, 实测 pass');
});
console.log('\n测试结果: ' + p + ' 通过, ' + f + ' 失败, 共 ' + (p + f) + ' 个');
process.exit(f > 0 ? 1 : 0);
