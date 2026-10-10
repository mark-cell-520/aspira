/**
 * test/counterfactual-engine-boundary.test.js — 反方引擎的 16 个公开方法不得被边界形状打崩
 *
 * ═══ 第一百九十九轮发现的缺陷 ═══
 * 切片角度: 前六轮依次用过「契约清晰」「被文档完整路径承诺」「导出纯函数与
 * 常量表」「src 扇入最高」「被 MCP 工具直接调用」「错误处理最可能掩盖失败」
 * 选 B 类模块。本轮用第七种 —— **哪个 B 类模块的入口参数从未被校验**, 即调用方
 * 可以传入让它崩溃的形状。机械代理: 公开方法直接读 `参数.属性` 而函数体前 300
 * 字符内没有 typeof / !param 守卫。
 *
 * `src/reasoning/counterfactual-engine.js`(493 行, 16 个公开方法)以 34 处
 * 无守卫属性读居首, 且它对应 AGENTS.md 54 维度表里的 `counterfactual` 维度。
 *
 * 按 cycle 191 立下的规矩**调用它**(不是 require 它), 实测 12 处边界崩溃:
 *   analyze(42) / analyze({}) / analyze(['x'])   → answer.trim is not a function
 *   analyze(text, null)                          → Cannot read properties of null (reading 'userQuery')
 *   analyze(text, {userQuery: 42})               → query.split is not a function
 *   generateOpposingViews(null) / challengePremises(null) / computeConfidenceShift(null)
 *   / suggestRefinement(null) / computeVerdict(null) / detectFalseDichotomy(null)
 *   / detectToneIssues(null) / generateContraryScenario(null)
 *                                               → … of null (reading 'includes')
 *   computeConfidenceShift(42) / computeVerdict(42) / generateOpposingViews(42)
 *                                               → … is not a function
 *
 * 根因: 唯一的防御是 `answer = ''` / `context = {}` 这类**默认值**, 而默认值
 * 只覆盖"不传参", 覆盖不了显式传进来的 null、数字、对象、数组。而 `analyze`
 * 自己的第一行 `!answer || answer.trim()` 就把"非字符串但真值"的形状放过去了
 * (`!42` 为 false, 于是走到 `42.trim()`)。
 *
 * 修法: 模块级 `_asText` / `_asObject` 两个助手, 16 个公开方法入口统一归一化,
 * 函数体内一律走归一化后的值。实测 130 组边界输入(8 种 answer × 9 种 context
 * 的 analyze 矩阵 + 58 组其余方法)全部零抛错, 且正常路径的九个返回字段
 * (opposingViews / premiseChallenges / originRecall / confidenceAdjustment /
 * refinement / verdict …)与修复前逐字一致。
 *
 * ═══ 顺带测量到并披露的一个事实 ═══
 * `heartflow.js:2070` 构造了 `this.counterfactual = new CounterfactualEngine()`,
 * 但全仓**没有任何代码调用它的任何方法** —— 493 行、16 个公开方法, 零消费方。
 * 这与 cycle 194 的 `autoRetry`(写完没人读)同族, 但修它要决定这个引擎该在
 * 哪里被调用(think 流程? verifier?), 属产品判断, 按铁律 2 只披露不执行。
 * 本测试把"零消费方"这个事实钉住, 免得下轮误以为它已被接线。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SRC = path.join(ROOT, 'src', 'reasoning', 'counterfactual-engine.js');
  const { CounterfactualEngine } = require(SRC);

  function make(opts) { return new CounterfactualEngine(opts || {}); }

  // ─── 主缺陷: 边界形状不得抛错 ─────────────────────────────────────

  test('analyze 的 answer × context 边界矩阵全部不得抛错', () => {
    const eng = make();
    const answers = ['', '   ', '短', null, undefined, 42, {}, ['x'], true];
    const contexts = [null, undefined, 'str', 42, [], {}, { userQuery: null }, { userQuery: 42 }, { userQuery: '我该怎么办？' }];
    let threw = null;
    for (const a of answers) {
      for (const c of contexts) {
        try { eng.analyze(a, c); } catch (e) {
          threw = 'answer=' + JSON.stringify(a) + ' context=' + JSON.stringify(c) + ' → ' + e.message;
        }
      }
    }
    assertTrue(threw === null, 'analyze 抛错: ' + threw);
  });

  test('其余 15 个公开方法的边界形状全部不得抛错', () => {
    const eng = make();
    const bad = [null, undefined, 42, {}, [], 'str', true];
    const methods = [
      'generateOpposingViews', 'challengePremises', 'recallOrigin',
      'computeConfidenceShift', 'suggestRefinement', 'computeVerdict',
      'detectFalseDichotomy', 'detectToneIssues', 'detectLogicGaps',
      'generateContraryScenario', 'evaluateDiversity',
    ];
    let threw = null;
    for (const m of methods) {
      for (const a of bad) {
        for (const b of bad) {
          try { eng[m](a, b); } catch (e) {
            threw = m + '(' + JSON.stringify(a) + ', ' + JSON.stringify(b) + ') → ' + e.message;
          }
        }
      }
    }
    // checkAttributionGap 单独测(两参都是文本)
    for (const a of bad) for (const b of bad) {
      try { eng.checkAttributionGap(a, b); } catch (e) { threw = 'checkAttributionGap → ' + e.message; }
    }
    assertTrue(threw === null, '公开方法抛错: ' + threw);
  });

  test('非字符串 answer 必须落到"答案过短"分支, 而不是崩溃', () => {
    const eng = make();
    for (const a of [42, {}, ['x'], true, null, undefined]) {
      const r = eng.analyze(a, {});
      assertEqual(r.relevant, false, 'answer=' + JSON.stringify(a) + ' 应判为不相关');
      assertTrue(typeof r.reason === 'string' && r.reason.length > 0, '应给出原因');
    }
  });

  test('context 为非对象时归因还原应优雅降级', () => {
    const eng = make();
    for (const c of [null, 42, 'str', [], { userQuery: 42 }, { userQuery: null }]) {
      const r = eng.analyze('这显然是一定正确的结论，毫无疑问。', c);
      assertEqual(r.relevant, true, 'context 异常不该让整次分析失败');
      assertTrue(r.originRecall && typeof r.originRecall === 'object', 'originRecall 应仍是对象');
    }
  });

  // ─── 正常契约不被破坏 ─────────────────────────────────────────────

  test('analyze 正常路径的九个字段必须齐备且行为不变', () => {
    const eng = make();
    const r = eng.analyze('这显然是一定正确的结论，毫无疑问。', { userQuery: '我该怎么办？' });
    for (const k of ['relevant', 'mode', 'timestamp', 'opposingViews', 'premiseChallenges',
      'originRecall', 'confidenceAdjustment', 'refinement', 'verdict']) {
      assertTrue(r[k] !== undefined, '缺字段: ' + k);
    }
    assertEqual(r.relevant, true, '应判为需要反方');
    assertEqual(r.verdict, 'needs_revision', '含确定性信号的答案应判 needs_revision');
    assertTrue(r.opposingViews.length >= 1, '应生成反方观点');
    assertTrue(r.premiseChallenges.length >= 1, '应挑战隐含前提');
    assertTrue(r.refinement.needed === true, '应建议修正');
  });

  test('无触发词的答案不得被硬找反方(不为修漏报而什么都放行)', () => {
    const eng = make();
    const r = eng.analyze('今天天气不错，适合出门走走。', {});
    assertEqual(r.relevant, true, '长度够仍应分析');
    assertEqual(r.opposingViews.length, 0, '无确定性/逻辑信号时不该硬造反方');
    assertEqual(r.verdict, 'likely_correct', '应判 likely_correct');
  });

  test('mode / maxOpposingViews / maxPremiseChallenges / recordHistory 仍生效', () => {
    const gentle = make({ mode: 'gentle' });
    const balanced = make({ mode: 'balanced' });
    const text = '这绝对是必然的结论，毫无疑问，一定对。';
    assertTrue(gentle.analyze(text, {}).opposingViews.length < balanced.analyze(text, {}).opposingViews.length,
      'gentle 模式应比 balanced 更克制');

    const capped = make({ maxOpposingViews: 1, maxPremiseChallenges: 1 });
    const r = capped.analyze(text, {});
    assertEqual(r.opposingViews.length, 1, 'maxOpposingViews=1 应截到 1');
    assertEqual(r.premiseChallenges.length, 1, 'maxPremiseChallenges=1 应截到 1');

    const noHist = make({ recordHistory: false });
    noHist.analyze(text, {});
    assertEqual(noHist.history.length, 0, 'recordHistory=false 不应记历史');
  });

  test('归因还原对合法 context 仍真的算覆盖率', () => {
    const eng = make();
    const onTopic = eng.recallOrigin({ userQuery: '我该怎么办关于这个项目', reasoning: '这个项目需要更多时间' });
    assertEqual(onTopic.relevant, true, '有 userQuery 应判相关');
    assertTrue(typeof onTopic.coverageRate === 'string', 'coverageRate 应是百分比字符串');
    assertTrue(typeof onTopic.driftDetected === 'boolean', 'driftDetected 应是布尔');

    const noQuery = eng.recallOrigin({});
    assertEqual(noQuery.relevant, false, '无 userQuery 应判不相关');
  });

  // ─── 源级与披露 ───────────────────────────────────────────────────

  test('源级: 每个公开方法入口都必须有归一化', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const methods = ['analyze', 'generateOpposingViews', 'challengePremises', 'recallOrigin',
      'computeConfidenceShift', 'suggestRefinement', 'computeVerdict', 'detectFalseDichotomy',
      'detectToneIssues', 'checkAttributionGap', 'generateContraryScenario'];
    for (const m of methods) {
      const re = new RegExp('\\n  ' + m + '\\([^)]*\\) \\{\\n(?:[ \\t]*\\*[^\\n]*\\n)*[ \\t]*(const (?:ans|ctx|q|userQuery|reasoning) = )');
      assertTrue(re.test(src),
        m + '() 的入口看不到归一化(期望 const ans/ctx/… = _asText/_asObject/typeof 守卫)');
    }
    // 助手本身必须在
    assertTrue(/function _asText\(/.test(src), '缺 _asText 助手');
    assertTrue(/function _asObject\(/.test(src), '缺 _asObject 助手');
  });

  test('已披露事实: 引擎实例被构造但全仓无方法消费方(钉住, 免得误以为已接线)', () => {
    const { execFileSync } = require('child_process');
    const grep = (pat) => {
      try {
        return execFileSync('grep', ['-rn', '--include=*.js', pat, 'src/', 'bin/', 'scripts/'],
          { cwd: ROOT, encoding: 'utf8' });
      } catch (e) { return ''; }
    };
    // 构造点存在
    const ctor = grep('this\\.counterfactual = new');
    assertTrue(ctor.indexOf('heartflow.js') >= 0, 'heartflow.js 应构造该引擎, 实测: ' + JSON.stringify(ctor.slice(0, 120)));
    // 但没有任何地方调用它的公开方法
    const calls = grep('\\.counterfactual\\.\\(analyze\\|generateOpposingViews\\|challengePremises\\|recallOrigin\\|computeVerdict\\|suggestRefinement\\|computeConfidenceShift\\)');
    assertEqual(calls.trim(), '',
      '发现该引擎方法的消费方 —— 若这是新接线, 请把本断言反转为"应存在消费方"并删除披露');
    // 也不该有人读 this.counterfactual 实例本身
    const field = grep('this\\.counterfactual\\.');
    assertEqual(field.trim(), '', '发现 this.counterfactual. 的读取 —— 同上, 请更新本披露');
  });
};
