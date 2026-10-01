'use strict';

/**
 * test/error-handler.test.js — src/core/error-handler.js 的导出契约
 *
 * [周期70 修复] 本文件原先是 jest 风格(describe/test/expect().toBe()), 而
 * 仓库的 harness(test/_harness.js)只导出 { test, assertEqual, assertTrue,
 * assertFalse, assertDefined, assertThrows }。describe/expect 均未定义,
 * 于是这个文件**从未成功加载过**——它在 run-all 里是一条常驻红灯
 * ("加载失败: describe is not defined"), 却从没人发现。
 *
 * 一个从未运行的测试文件比没有文件更糟: 它占着"已验证"的名分, 实际零覆盖。
 * 现按仓库 mount 风格重写, 断言全部来自**实测**(见下方每个 expect 的类型)。
 */
const eh = require('../src/core/error-handler.js');

module.exports = function ({ test, assertTrue, assertEqual }) {

  test('exports errors array and maxHistory', () => {
    assertTrue(Array.isArray(eh.errors), 'errors 应为数组');
    assertEqual(typeof eh.maxHistory, 'number', 'maxHistory 应为数字');
  });

  test('exports internal state objects', () => {
    assertEqual(typeof eh._counters, 'object', '_counters 应为对象');
    assertEqual(typeof eh._dedup, 'object', '_dedup 应为对象');
  });

  test('exports isProduction flag', () => {
    assertEqual(typeof eh.isProduction, 'boolean', 'isProduction 应为布尔');
  });

  // 实测该模块另有这五个导出, 一并钉住, 免得将来悄悄消失
  test('其余导出一并钉住', () => {
    for (const k of ['_rateLimiter', '_oscillation', '_retry', '_correlation']) {
      assertEqual(typeof eh[k], 'object', `${k} 应为对象`);
    }
  });
};
