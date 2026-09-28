/**
 * test/failure-analyzer.test.js — src/cortex/failure-analyzer.js
 *
 * ═══ 为什么补这个测试 ═══
 * test-coverage-gap 切片。用 require 追踪实测(非 basename 匹配——后者会把间接
 * 覆盖算成缺口)跑完整个套件，再单独追踪引擎启动 + 调用全部 177 个只读 handler，
 * 求差集得到 **15 个"活着但没测"** 的模块。failure-analyzer.js(309 行)是其中之一:
 *   引擎确实加载它(src/core/heartflow.js 与 src/mcp-server.js 都引用)，
 *   但套件里没有任何测试进程加载过它。
 *
 * ═══ 断言全部来自实测，不凭印象 ═══
 * 本会话有"测试断言写得比实现弱/强、或凭印象写错"的前科，故每条断言先跑真实
 * 模块拿到值再写。特别是: analyzeMultiple 返回**数组**而非带 total 的对象
 * (第一版探针按对象取 .total 取到 undefined，差点误判成 bug)。
 */
module.exports = function ({ test, assertEqual, assertTrue, assertDefined }) {
  const path = require('path');
  const { FailureAnalyzer } = require(path.join(__dirname, '..', 'src', 'cortex', 'failure-analyzer.js'));

  function fresh() { return new FailureAnalyzer(); }

  test('五类内置错误模式应各自命中正确 category(实测值)', () => {
    const a = fresh();
    const cases = [
      ['SyntaxError: Unexpected token', 'syntax'],
      ['ReferenceError: x is not defined', 'runtime'],
      ['Cannot find module foo', 'dependency'],
      ['EACCES: permission denied', 'permission'],
      ['ETIMEDOUT: operation timed out', 'timeout'],
    ];
    for (const [msg, cat] of cases) {
      const r = a.analyze(msg);
      assertTrue(r.analyzed, `「${msg}」应被识别`);
      assertEqual(r.category, cat, `「${msg}」的 category 应为 ${cat}，实测 ${r.category}`);
      assertEqual(r.confidence, 0.9, `「${msg}」的 confidence 实测 0.9`);
      assertTrue(Array.isArray(r.patterns) && r.patterns.length >= 1, '应列出命中的模式名');
      assertDefined(r.suggestedFix, '应给出修复建议');
      assertDefined(r.rootCause, '应给出根因');
    }
  });

  test('无法识别的输入必须 analyzed=false + category=unknown + confidence=0', () => {
    const r = fresh().analyze('完全无关的随机文本');
    assertEqual(r.analyzed, false, '未命中任何模式时 analyzed 应为 false');
    assertEqual(r.category, 'unknown', 'category 应为 unknown');
    assertEqual(r.confidence, 0, 'confidence 应为 0(无匹配即无置信)');
    assertEqual(r.rootCause, '未知错误', 'rootCause 应为"未知错误"');
  });

  test('Error 对象输入应与字符串输入等效(取 message)', () => {
    const a = fresh();
    const e = new TypeError("Cannot read properties of undefined (reading 'x')");
    const r = a.analyze(e);
    assertTrue(r.analyzed, 'TypeError 应被识别为 runtime');
    assertEqual(r.category, 'runtime', 'TypeError 应归 runtime');
    assertEqual(r.errorMessage, e.message, 'errorMessage 应取自 Error.message');
  });

  test('analyzeMultiple 返回数组且每项带 index(注意: 不是带 total 的对象)', () => {
    const a = fresh();
    const m = a.analyzeMultiple(['Cannot find module a', 'EACCES denied', 'zzz']);
    assertTrue(Array.isArray(m), 'analyzeMultiple 应返回数组(实测为数组，非 {total} 对象)');
    assertEqual(m.length, 3, '应有 3 项');
    assertEqual(m[0].index, 0, '首项 index 应为 0');
    assertEqual(m[1].index, 1, '次项 index 应为 1');
    assertEqual(m[2].index, 2, '三项 index 应为 2');
    assertEqual(m[2].analyzed, false, '第三项 "zzz" 无法识别');
  });

  test('getCategoryStats 应正确聚合并统计未解析数', () => {
    const a = fresh();
    const m = a.analyzeMultiple(['Cannot find module a', 'EACCES denied', 'zzz']);
    const s = a.getCategoryStats(m);
    assertEqual(s.total, 3, 'total 应为 3');
    assertEqual(s.byCategory.dependency, 1, 'dependency 应 1 条');
    assertEqual(s.byCategory.permission, 1, 'permission 应 1 条');
    assertEqual(s.unresolved, 1, '未解析应 1 条');
  });

  test('registerPattern 应能扩展自定义模式并即时生效', () => {
    const a = fresh();
    a.registerPattern('my_custom', {
      patterns: [/zzz-special/], category: 'custom', rootCause: 'r', suggestedFix: 'f',
    });
    const r = a.analyze('zzz-special happened');
    assertTrue(r.analyzed, '自定义模式应命中');
    assertEqual(r.category, 'custom', 'category 应为 custom');
    assertEqual(r.suggestedFix, 'f', 'suggestedFix 应取自定义值');
    // getPatterns 应反映新增
    assertTrue(!!a.getPatterns().my_custom, 'getPatterns 应包含新注册的 my_custom');
  });

  test('getPatterns 应含实测的内置模式且不少于 10 个', () => {
    const p = fresh().getPatterns();
    assertTrue(p && typeof p === 'object', 'getPatterns 应返回对象');
    const names = Object.keys(p);
    assertTrue(names.length >= 10, `内置模式实测 10 个，应不少于 10，实测 ${names.length}`);
    for (const n of ['syntax_error', 'runtime_error', 'dependency_error', 'permission_error', 'timeout_error']) {
      assertTrue(!!p[n], `应包含内置模式 ${n}`);
    }
  });

  test('空/异常输入不得抛错(降级为 unknown)', () => {
    const a = fresh();
    for (const bad of ['', null, undefined, 123, {}]) {
      let r;
      try { r = a.analyze(bad); } catch (e) {
        assertTrue(false, `输入 ${JSON.stringify(bad)} 抛错了: ${e.message}`);
        return;
      }
      assertEqual(r.analyzed, false, `输入 ${JSON.stringify(bad)} 应 analyzed=false`);
      assertEqual(r.category, 'unknown', `输入 ${JSON.stringify(bad)} 应 category=unknown`);
    }
  });
};
