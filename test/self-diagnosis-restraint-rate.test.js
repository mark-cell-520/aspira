'use strict';
/**
 * SelfDiagnosis 克制读数与 StrategicRestraint 产出形状一致性回归测试
 *
 * 钉住的缺陷: _collectData() 读 restraintStats.evaluationsTotal，
 * 而产出侧 StrategicRestraint.getStats() 展开的是 this._stats，字段名是
 * evaluations / restrained / approved / challenges 这一族。evaluationsTotal
 * 只存在于 evaluate() 返回值的 stats 子对象里，是另一个对象、另一条路径，
 * getStats() 从来不写它。
 *
 * 对外影响面: 「战略克制」这一整段自检从写下起只有一种输出。读数为 undefined 时
 *   - `undefined === 0` 为假 → 「尚无克制决策记录」分支不可达；
 *   - `undefined > 0` 为假 → restraintRate 结构性恒 0；
 *   - 于是 _diagnoseRestraint 永远只能吐出「克制力度 0% —— 拦得很少」，
 *     而 StrategicRestraint 明明在持久化真实账本（实测 evaluations=17 万+）。
 *
 * 修前: evaluationsTotal=undefined、restraintRate=0，克制段落恒为「拦得很少」。
 * 修后: evaluationsTotal 取到真实 evaluations，restraintRate 按 restrained/evaluations 算，
 *       克制力度按阈值分档；无克制模块时仍走「尚无克制决策记录」。
 */
const { SelfDiagnosis } = require('../src/core/self-diagnosis.js');
const { StrategicRestraint } = require('../src/cortex/strategic-restraint.js');

// 与 src/cortex/strategic-restraint.js 的 getStats() 产出形状对齐的真实 mock
function makeHF(stats) {
  return {
    constructor: { VERSION: '6.0.0' },
    _startTime: Date.now() - 3600000,
    strategicRestraint: { getStats: () => stats },
    learningOrchestrator: { status: () => ({}) },
  };
}

module.exports = function ({ test, assertEqual, assertTrue }) {
  test('克制读数取产出侧真实的 evaluations 字段，不读不存在的 evaluationsTotal', () => {
    const hf = makeHF({ evaluations: 30, restrained: 5, approved: 25, challenges: 0 });
    const data = new SelfDiagnosis(hf).run().data;
    assertEqual(data.evaluationsTotal, 30, 'evaluationsTotal 应取 getStats() 的 evaluations');
    assertEqual(data.restrainedCount, 5, 'restrainedCount 应取 getStats() 的 restrained');
    assertEqual(data.restraintRate, 0.167, 'restraintRate 应为 5/30');
  });

  test('克制力度按真实比率分档，不再恒为「拦得很少」', () => {
    // 5/30 = 16.7% → 「适度」档
    const moderate = new SelfDiagnosis(makeHF({ evaluations: 30, restrained: 5, approved: 25 })).run().diagnosis.restraint;
    assertTrue(
      moderate.some(x => x.msg.includes('适度')),
      '16.7% 应落在「适度」档, got: ' + JSON.stringify(moderate)
    );
    // 40/40 = 100% → 「过于保守」档
    const harsh = new SelfDiagnosis(makeHF({ evaluations: 40, restrained: 40, approved: 0 })).run().diagnosis.restraint;
    assertTrue(
      harsh.some(x => x.msg.includes('过于保守')),
      '100% 应落在「过于保守」档, got: ' + JSON.stringify(harsh)
    );
  });

  test('没有克制模块时仍然报告「尚无克制决策记录」', () => {
    const hf = makeHF(null);
    const items = new SelfDiagnosis(hf).run().diagnosis.restraint;
    assertTrue(
      items.some(x => x.msg.includes('尚无克制决策记录')),
      '无克制数据时应明确说没有记录, got: ' + JSON.stringify(items)
    );
  });

  test('产出侧字段名若改名成 evaluationsTotal 也认（双名字兼容）', () => {
    const hf = makeHF({ evaluationsTotal: 20, restrained: 10, approved: 10 });
    const data = new SelfDiagnosis(hf).run().data;
    assertEqual(data.evaluationsTotal, 20, '旧字段名也应被读到');
    assertEqual(data.restraintRate, 0.5, 'restraintRate 应为 10/20');
  });

  test('真实 StrategicRestraint.getStats() 的产出形状确实不含 evaluationsTotal', () => {
    const sr = new StrategicRestraint();
    const stats = sr.getStats();
    assertTrue(Number.isFinite(stats.evaluations), 'getStats() 应给出数值型 evaluations');
    assertEqual(stats.evaluationsTotal, undefined, 'getStats() 从不写 evaluationsTotal');
  });
};
