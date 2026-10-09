/**
 * test/value-internalizer-input-guard.test.js —
 * 一条本该是最安全防御的分支, 调用了整个文件里只出现一次的名字
 *
 * [test-coverage-gap·第一百八十二轮] 新建。
 *
 * B 类之王 src/shield/ethics/value-internalizer.js(913 行, ValueInternalizer 类,
 * 被 heartflow.js 经懒加载引用, 是真活模块, 零测试)。按 cycle 28/148/156/159/
 * 167/170/171/179 的纪律 probing by calling 全景调用。
 *
 * ═══ 缺陷一: 守卫自己调用了不存在的方法 ═══
 * `calculateValueAlignmentScore` 的参数验证分支:
 *   if (action === null || action === undefined) {
 *     return this._makeScoreResult(0, false, [], '行动为空');
 *   }
 * 而 **`_makeScoreResult` 在整个 913 行的文件里只出现这一次** —— 从未定义、
 * 从未导入。于是"action 为 null"这条本该是最安全的防御分支, 反而是唯一会崩
 * 的路径: 实测 evaluateAction(null) → TypeError: this._makeScoreResult is not
 * a function。
 *
 * 这与第一百七十一轮 think-pipeline 的 getFormulaBridge 是同型缺陷(调用一个
 * 从未导入/定义的名字), 且更讽刺: **守卫自己是坏的**。调用方以为传 null 会
 * 拿到一个"行动为空"的低分结果, 实际拿到一个异常。
 *
 * ═══ 缺陷二: 默认值参数的经典陷阱(null 不生效) ═══
 * 三处 `param = {}` 形式的默认值, 在调用方显式传 **null** 时全部崩溃:
 *   calculateValueAlignmentScore('x', {}, null) → context.severity 处 TypeError
 *   adaptWeights(null)                          → 读取 'persist' 处 TypeError
 *   generateBoundaryRequest(42)                 → actionStr.substring 处 TypeError
 *     (这一处的根因是 JSON.stringify(undefined) 返回 **undefined** 而非字符串)
 * 默认值参数只对 undefined 生效, 显式传 null 不生效 —— 这是 JS 的既定语义,
 * 但**一个把 null 当合法的调用方(JSON 解析、MCP 参数、外部 API)会直接踩中**。
 *
 * 同文件的 logBoundaryNegotiation 已有正确的结构化校验(makeError +
 * ErrorType.VALIDATION), 是本轮对齐的形状。
 *
 * ═══ 修法 ═══
 * ① `_makeScoreResult` 改成内联构造与成功路径同一形状的结果对象(实测 10 键,
 *    与正常路径逐键一致);
 * ② 三处入口归一化: null/undefined 静默兜底成 {}, 其他非法类型抛结构化错误;
 * ③ `generateBoundaryRequest` 的 actionStr 兜底成空串。
 *
 * ═══ 锁什么 ═══
 * ① evaluateAction 对 null/undefined/数字/对象/数组/context 非法 全部不抛错,
 *    且 null 走防御分支时返回的形状与正常路径**逐键一致**;
 * ② adaptWeights 对 null/undefined 静默兜底, 对其他非法类型抛结构化错误;
 * ③ generateBoundaryRequest 对无参/null/数字/context 非法全部不抛错;
 * ④ 合法路径不得回归(决策计数 / passRate / 权重自适应 / 状态);
 * ⑤ 源级: `_makeScoreResult` 不得再出现(它是未定义的名字), 三处入口必须有
 *    归一化(含自证)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const ROOT = path.join(__dirname, '..');
  const { ValueInternalizer } = require(path.join(ROOT, 'src', 'shield', 'ethics', 'value-internalizer.js'));

  const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vi-guard-'));

  // ── 一、evaluateAction 全景不抛错且形状一致 ─────────────
  test('evaluateAction 对各类非法输入必须不抛错, 且 null 分支的形状与正常路径逐键一致', () => {
    const tmp = mkTmp();
    try {
      const vi = new ValueInternalizer(tmp);
      const bad = [];
      for (const [label, action, selfModel, context] of [
        ['null', null, {}, {}],
        ['undefined', undefined, {}, {}],
        ['数字', 42, {}, {}],
        ['对象', { text: 'x' }, {}, {}],
        ['数组', ['a'], {}, {}],
        ['context null', '帮我写报告', {}, null],
        ['context 数组', '帮我写报告', {}, [1, 2]],
        ['context 字符串', '帮我写报告', {}, 'x'],
        ['三个全 null', null, null, null],
      ]) {
        let out = null, err = null;
        try { out = vi.evaluateAction(action, selfModel, context); } catch (e) { err = e.message; }
        if (err) { bad.push(`${label} → 抛 ${err.slice(0, 60)}`); continue; }
        // 结构合法: 必须有 details 且 details 有 10 个键
        if (!out || !out.details) { bad.push(`${label} → 返回无 details`); continue; }
        if (Object.keys(out.details).length !== 10) {
          bad.push(`${label} → details 键数 ${Object.keys(out.details).length}(期望 10, 与正常路径一致)`);
        }
      }
      assertEqual(bad.join('\n'), '', '以下输入抛错或形状不完整:\n' + bad.join('\n'));

      // 关键: null 走防御分支时的 details 键集必须与正常路径**完全相同**
      const normal = vi.evaluateAction('帮我写一份报告', {}, {});
      const nullCase = vi.evaluateAction(null, {}, {});
      const kn = Object.keys(normal.details).sort().join(',');
      const k0 = Object.keys(nullCase.details).sort().join(',');
      assertEqual(k0, kn,
        `null 分支的 details 键集必须与正常路径一致\n  null: ${k0}\n  正常: ${kn}`);
      assertEqual(nullCase.details.score, 0, 'null 分支的 score 应为 0');
      assertEqual(nullCase.details.passed, false, 'null 分支的 passed 应为 false');
      assertEqual(nullCase.canProceed, false, 'null 分支的 canProceed 应为 false');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── 二、adaptWeights 的入口归一化 ───────────────────────
  test('adaptWeights: null/undefined 静默兜底, 其他非法类型抛结构化错误', () => {
    const tmp = mkTmp();
    try {
      const vi = new ValueInternalizer(tmp);
      // null / undefined 不得抛(与修复前相反)
      for (const [label, v] of [['null', null], ['undefined', undefined], ['合法对象', { persist: false }]]) {
        let err = null;
        try { vi.adaptWeights(v); } catch (e) { err = e.message; }
        assertEqual(err, null, `adaptWeights(${label}) 不应抛错: ${err}`);
      }
      // 其他非法类型必须抛**结构化**错误(与 logBoundaryNegotiation 同形状)
      for (const [label, v] of [['字符串', 'x'], ['数字', 5], ['数组', [1]]]) {
        let err = null, e = null;
        try { vi.adaptWeights(v); } catch (ex) { err = ex.message; e = ex; }
        assertTrue(!!err, `adaptWeights(${label}) 应抛错`);
        assertTrue(/options 必须是对象/.test(err),
          `adaptWeights(${label}) 的错误消息应说明 options 必须是对象, 实测 "${err}"`);
        // 注意 makeError 用的是 err.**code**(不是 err.type), 见文件顶部的
        // makeError 工厂: err.code = type; err.context = ...; err.timestamp = ...
        assertTrue(!!(e && e.code === 'VALIDATION'),
          `adaptWeights(${label}) 应抛 VALIDATION 错误(makeError 的 code 字段), 实测 code=${e && e.code}`);
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── 三、generateBoundaryRequest 全景不抛错 ──────────────
  test('generateBoundaryRequest 对无参/null/数字/context 非法必须不抛错', () => {
    const tmp = mkTmp();
    try {
      const vi = new ValueInternalizer(tmp);
      const bad = [];
      for (const [label, action, context] of [
        ['无参', undefined, undefined],
        ['null', null, null],
        ['数字', 42, undefined],
        ['字符串', 'x', undefined],
        ['context null', 'x', null],
        ['context 数组', 'x', [1]],
      ]) {
        let out = null, err = null;
        try { out = vi.generateBoundaryRequest(action, context); } catch (e) { err = e.message; }
        if (err) { bad.push(`${label} → 抛 ${err.slice(0, 60)}`); continue; }
        if (!out || typeof out !== 'object') bad.push(`${label} → 返回非对象`);
      }
      assertEqual(bad.join('\n'), '', '以下输入抛错:\n' + bad.join('\n'));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── 四、合法路径不得回归 ────────────────────────────────
  test('合法路径不得回归(决策计数 / passRate / 权重自适应 / 状态)', () => {
    const tmp = mkTmp();
    try {
      const vi = new ValueInternalizer(tmp);
      // 注意 adaptWeights 有"决策历史不足 5 条则跳过"的设计内守卫, 所以这里
      // 喂 7 条(首版只喂 4 条, 断言 threshold 放宽失败 —— 是我的样本数不够,
      // 不是代码错)。
      const seq = ['帮我写报告', '帮我查证数据', '做危险的事', '帮我分析', '再一条', '再二条', '再三条'];
      for (const a of seq) vi.evaluateAction(a, {}, { severity: 'medium' });
      const stats = vi.getDecisionStats();
      assertEqual(stats.total, seq.length, `决策计数应为 ${seq.length}, 实测 ${stats.total}`);
      assertEqual(typeof stats.passRate, 'number', 'passRate 必须是数字');
      const before = vi.getValueWeights().threshold;
      vi.adaptWeights({ persist: false });
      const after = vi.getValueWeights().threshold;
      assertEqual(typeof after, 'number', 'threshold 必须是数字');
      // 通过率 0(< 0.3) → 阈值应放宽(下调 0.02), 这是设计内行为
      assertEqual(after, Math.max(0.4, before - 0.02),
        `通过率过低应放宽阈值, 实测 ${before} → ${after}`);
      assertEqual(vi.getStatus().state, 'READY', '状态应保持 READY');
      // generateBoundaryRequest 合法路径
      const req = vi.generateBoundaryRequest('帮我写报告', { severity: 'high' });
      assertTrue(req && typeof req === 'object', '合法调用必须返回对象');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── 五、源级: 未定义名字不得再出现 + 三处入口必须有归一化 ─
  test('源级: _makeScoreResult 不得再出现, 三处入口必须有归一化', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'shield', 'ethics', 'value-internalizer.js'), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, m => ' '.repeat(m.length))).join('\n');
    // 5.1 _makeScoreResult 是未定义的名字(修复前全文只出现 1 次, 就在调用处)
    assertEqual(src.includes('_makeScoreResult'), false,
      '_makeScoreResult 从未定义 —— 它必须不再出现在代码里(注释已剥离, 所以这是真代码)');
    // 5.2 calculateValueAlignmentScore 必须有 ctx 归一化
    const iC = src.indexOf('calculateValueAlignmentScore(action');
    assertTrue(iC > 0, '前提失效: 找不到 calculateValueAlignmentScore');
    const segC = src.slice(iC, src.indexOf('\n  }', iC));
    assertTrue(/const ctx = \(context && typeof context === 'object' && !Array\.isArray\(context\)\)/.test(segC),
      'calculateValueAlignmentScore 必须归一化 context(默认值对 null 不生效)');
    // 5.3 adaptWeights 必须有入口校验
    const iA = src.indexOf('adaptWeights(options = {})');
    assertTrue(iA > 0, '前提失效: 找不到 adaptWeights');
    const segA = src.slice(iA, src.indexOf('\n  }', iA));
    assertTrue(/makeError\(ErrorType\.VALIDATION/.test(segA),
      'adaptWeights 必须用 makeError + ErrorType.VALIDATION 抛结构化错误(与 logBoundaryNegotiation 同形状)');
    // 5.4 generateBoundaryRequest 的 actionStr 必须有兜底
    const iG = src.indexOf('generateBoundaryRequest(action');
    assertTrue(iG > 0, '前提失效: 找不到 generateBoundaryRequest');
    const segG = src.slice(iG, src.indexOf('\n  }', iG));
    assertTrue(/JSON\.stringify\(action\) \|\| ''/.test(segG),
      'generateBoundaryRequest 的 actionStr 必须兜底(JSON.stringify(undefined) 返回 undefined 而非字符串)');
    // 5.5 自证: 谓词必须分得清"有归一化"与"只有默认值参数"
    const naiveOnly = 'calculateValueAlignmentScore(action, selfModel = {}, context = {}) {\n    const x = context.severity;';
    assertTrue(/const ctx = \(context && typeof context === 'object' && !Array\.isArray\(context\)\)/.test(naiveOnly) === false,
      '自证失效: 谓词分不清有归一化与只有默认值参数, 本条是恒真锁');
  });
};
