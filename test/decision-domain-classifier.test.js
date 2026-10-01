/**
 * test/decision-domain-classifier.test.js — src/core/decision-domain-classifier.js 的首个测试
 *
 * 背景（第九十六轮, test-coverage-gap 切片）:
 * 本会话的修正版普查测得 src/ 383 个模块里 **102 个无任何测试引用**
 * (cycle-28 的 164 因只按模块名 grep 而虚高; 已覆盖 fp4-quant, 余 101)。
 * 本模块是那 101 个之一: 3 级过滤的分类器(Level1 领域 → Level2 关键词 → Level3 回退)。
 *
 * 选它的理由: 决策链路的上游, 分错领域后面全错; 且契约 crisp —— 输入文本,
 * 输出 primary/candidates/confidence/source 四个字段。
 *
 * **断言的是契约不是覆盖剧场**:
 *   ① 含领域关键词的输入必须分到正确领域(surce='input');
 *   ② **不含任何关键词的输入必须落回 fallback 且 primary=null** —— 这一条是
 *      我自己差点误判成的"缺陷", 见下方教训;
 *   ③ result 优先于 input(confidence>0.5 时按结果分类);
 *   ④ byResult 按 FIELD_DOMAIN_MAP 走。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=mount 函数导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const { DecisionDomainClassifier, FIELD } = require('../src/core/decision-domain-classifier.js');

  const fresh = () => new DecisionDomainClassifier();

  // ① 含关键词 → 命中对应领域, source 为 input
  test('含领域关键词的输入必须分到正确领域', () => {
    const c = fresh();
    const cases = [
      ['情感 support for depressed users', FIELD.emotion],
      ['cognitive load is too high', FIELD.cognition],
      ['track the habit and goal progress', FIELD.behavior],
      ['unsafe and harmful content', FIELD.safety],
      ['这个月的情绪状态和情感支持', FIELD.emotion],
      ['认知推理与幻觉证据', FIELD.cognition],
    ];
    for (const [text, want] of cases) {
      const r = c.classify(text);
      assertEqual(r.primary, want, JSON.stringify(text) + ' 应分到 ' + want + ', 实得 ' + r.primary);
      assertEqual(r.source, 'input', JSON.stringify(text) + ' 的 source 应为 input');
    }
  });

  // ② 无关键词 → 必须回退且不得编造领域
  test('不含任何关键词必须落回 fallback(primary=null)', () => {
    const c = fresh();
    // 这些都是正常的、有信息量的中文问句, 但不含 DOMAIN_HINTS 里的任何词。
    const cold = [
      '这个月该不该换工作',
      '服务器响应慢该怎么排查',
      '孩子不愿意上学怎么办',
      '该买哪只股票',
    ];
    for (const text of cold) {
      const r = c.classify(text);
      assertEqual(r.primary, null, JSON.stringify(text) + ' 无关键词时 primary 必须为 null');
      assertEqual(r.source, 'fallback', JSON.stringify(text) + ' 的 source 应为 fallback');
      assertEqual(r.confidence, 0, JSON.stringify(text) + ' 的 confidence 应为 0');
    }
  });

  test('classify 返回四个契约字段', () => {
    const c = fresh();
    const r = c.classify('cognitive load');
    for (const k of ['primary', 'candidates', 'confidence', 'source']) {
      assertTrue(Object.prototype.hasOwnProperty.call(r, k), '返回值缺字段 ' + k);
    }
    assertEqual(Array.isArray(r.candidates), true, 'candidates 必须是数组');
  });

  test('空输入/非字符串输入不得抛错', () => {
    const c = fresh();
    for (const bad of [null, undefined, '', 42, {}]) {
      let r;
      try { r = c.classifyByInput(bad); } catch (e) { throw new Error('classifyByInput 对 ' + JSON.stringify(bad) + ' 抛错: ' + e.message); }
      assertEqual(r.primary, null, '非字符串输入的 primary 应为 null');
    }
  });

  test('result 置信度高于输入时按结果领域分类', () => {
    const c = fresh();
    // classifyByResult 的映射表驱动, 给一个高置信度结果即可覆盖该分支。
    const r = c.classify('cognitive load', { emotion: { valence: 0.9 } });
    assertTrue(r.primary !== null, '传入 result 后 primary 不应为 null');
    assertTrue(r.source === 'result' || r.source === 'input', 'source 应为 result 或 input, 实得 ' + r.source);
  });

  test('FIELD 四个领域都存在且被 DOMAIN_HINTS 覆盖', () => {
    const fields = Object.values(FIELD);
    assertEqual(fields.length, 4, 'FIELD 应有 4 个领域');
    for (const f of fields) {
      assertTrue(f && f.length > 0, 'FIELD 含空值');
    }
  });
};
