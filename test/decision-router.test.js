// 决策路由测试
const assert = require('assert');
const { DecisionRouter } = require('../src/core/decision-router.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '-', e.message); }
}

const dr = new DecisionRouter({}, { modelProfile: 'flash' });

ok('实例化成功', () => {
  assert.ok(dr);
});

ok('evaluate 方法存在', () => {
  assert.ok(typeof dr.evaluate === 'function');
});

ok('null 输入不崩溃', () => {
  assert.doesNotThrow(() => { try { dr.evaluate(null); } catch (e) {} });
});

ok('getStats 可调用', () => {
  assert.ok(typeof dr.getStats === 'function');
  assert.doesNotThrow(() => dr.getStats());
});

// ── 场域取值回归 ──────────────────────────────────────────────
// 病灶：_FIELD_EXTRACTORS 的 A 轴后三条（goalValid / valid / ok）写成
//   `v => v === false ? <值> : undefined`
// 表达「只在负面信号上取值，否则当这条不存在」，而 _extractField 原实现
// 直接 return 这个 undefined，调用方 Math.max(0, Math.min(1, undefined))
// 静默变成 NaN。于是任何产出侧带 goalValid:true / valid:true / ok:true
// 的结果（heart-logic.goalReview 的 goalValid 恒为 true 就是这条）都会让
// A 变 NaN、H 跟着 NaN，所有「H < 阈值」类场域规则静默失效，读数照样合法。
ok('A 轴 goalValid:true 不产生 NaN（原病灶）', () => {
  const v = dr._computeFieldValues({ goalValid: true, goalEthical: true, detail: 'no_input' });
  assert.ok(Number.isFinite(v.A), `A 应为有限数，实际 ${v.A}`);
  assert.ok(Number.isFinite(v.H), `H 应为有限数，实际 ${v.H}`);
  // goalValid:true 不是矛盾信号，A 应落到默认值 0
  assert.strictEqual(v.A, 0);
});

ok('A 轴 valid:true / ok:true 不产生 NaN', () => {
  for (const res of [{ valid: true }, { ok: true }, { ok: true, valid: true }]) {
    const v = dr._computeFieldValues(res);
    assert.ok(Number.isFinite(v.A), `${JSON.stringify(res)} -> A=${v.A}`);
    assert.ok(Number.isFinite(v.H), `${JSON.stringify(res)} -> H=${v.H}`);
  }
});

ok('A 轴负面信号仍然按原优先级取值', () => {
  // 同优先级顺序不变：dissonance > _fieldA > severity > goalValid > valid > ok
  assert.strictEqual(dr._computeFieldValues({ dissonance: 0.6, goalValid: false }).A, 0.6);
  assert.strictEqual(dr._computeFieldValues({ goalValid: false }).A, 0.5);
  assert.strictEqual(dr._computeFieldValues({ valid: false }).A, 0.4);
  assert.strictEqual(dr._computeFieldValues({ ok: false }).A, 0.3);
  assert.strictEqual(dr._computeFieldValues({ severity: 'critical' }).A, 0.8);
  assert.strictEqual(dr._computeFieldValues({ severity: 'high' }).A, 0.6);
  // goalValid:true 不再吞掉后面的 valid:false —— 这才是「本条不适用」的语义
  assert.strictEqual(dr._computeFieldValues({ goalValid: true, valid: false }).A, 0.4);
});

ok('非数字字段折成默认值而不是 NaN', () => {
  // confidence 走 U 轴、quality 走 D 轴；类型不对时不能污染整条轴
  const v = dr._computeFieldValues({ confidence: 'high', quality: null });
  assert.strictEqual(v.U, 0.3);
  assert.strictEqual(v.D, 0.3);
  assert.ok(Number.isFinite(v.H));
});

ok('wrapDispatchResult 不把 NaN 写进场域历史', () => {
  const r2 = new DecisionRouter({}, { modelProfile: 'flash' });
  r2.wrapDispatchResult('whatLearned.report', { ok: true, ts: 1 });
  const hist = r2.getFieldHistory(1);
  assert.ok(hist.length >= 1, '应留下一步场域历史');
  for (const h of hist) {
    assert.ok(Number.isFinite(h.A), `A=${h.A}`);
    assert.ok(Number.isFinite(h.H), `H=${h.H}`);
  }
  // getFieldSummary 原来会把 NaN 渲染成字面量字符串 "NaN"
  const sum = JSON.stringify(r2.getFieldSummary());
  assert.ok(!sum.includes('NaN'), `摘要里不该出现 NaN: ${sum.slice(0, 200)}`);
});

console.log(`\ndecision-router: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
