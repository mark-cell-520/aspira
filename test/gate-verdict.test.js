/**
 * gate-verdict.test.js — Aspira（新愿）GateVerdict 聚合器回归测试
 *
 * 保护从心虫吸收的 src/gate-verdict.js：
 *   buildGateVerdict / isAllowed / BLOCK_SIGNALS / REWRITE_SIGNALS / VERIFY_SIGNALS
 *
 * 背景：think() 产出 30+ 个辨别信号散落在 result 的下划线字段里，调用方要么自己
 * 解读每个字段，要么不读。本模块把散落信号收敛成一条可执行门禁命令，优先级
 * block > rewrite > verify > pass，宁可漏判降级不可误判升级(fail-open 到 verify)。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出，
 * 由 run-all.js 递归发现经 _mount.js 子进程执行。
 */
const {
  buildGateVerdict,
  isAllowed,
  BLOCK_SIGNALS,
  REWRITE_SIGNALS,
  VERIFY_SIGNALS
} = require('../src/gate-verdict.js');

module.exports = function ({ test, assertEqual, assertTrue, assertFalse, assertDefined }) {

  test('buildGateVerdict: 无效输入 → pass 安全默认', () => {
    for (const bad of [null, undefined, 'str', 42]) {
      const v = buildGateVerdict(bad);
      assertEqual(v.action, 'pass', '无效输入应 fail 到 pass');
      assertEqual(v.score, 1, 'pass 分数 1');
      assertEqual(v.signals.length, 0, '无信号');
    }
  });

  test('buildGateVerdict: 空 result → pass', () => {
    const v = buildGateVerdict({});
    assertEqual(v.action, 'pass', '无信号 → pass');
    assertEqual(v.score, 1, '分数 1');
  });

  test('buildGateVerdict: block 信号(_blockedByFirewall) → block/score0', () => {
    const v = buildGateVerdict({ _blockedByFirewall: true });
    assertEqual(v.action, 'block', '防火墙 → block');
    assertEqual(v.score, 0, 'block 分数 0');
    assertEqual(v.signals[0], '防火墙拦截', '信号名');
    assertTrue(v.reason.includes('防火墙'), 'reason 说明原因');
    assertTrue(v.guidance.length > 0, '有 guidance');
  });

  test('buildGateVerdict: block 信号(_highRiskOutput 字符串) → block 带细节', () => {
    const v = buildGateVerdict({ _highRiskOutput: '检测到危险指令' });
    assertEqual(v.action, 'block');
    assertEqual(v.score, 0);
    assertEqual(v.signals[0], '高风险输出');
    assertTrue(v.reason.includes('危险指令'), 'reason 带出字符串细节');
  });

  test('buildGateVerdict: rewrite 信号(_selfContradictory) → rewrite/score0.3', () => {
    const v = buildGateVerdict({ _selfContradictory: true });
    assertEqual(v.action, 'rewrite', '自相矛盾 → rewrite');
    assertEqual(v.score, 0.3, 'rewrite 分数 0.3');
    assertEqual(v.signals[0], '自相矛盾');
  });

  test('buildGateVerdict: verify 信号(_verification 低分) → verify/取低分', () => {
    const v = buildGateVerdict({ _verification: { score: 0.3, issues: [{ message: '缺依据' }] } });
    assertEqual(v.action, 'verify', '自验证未过 → verify');
    assertEqual(v.score, 0.3, 'verify 分数取最低 score');
    assertEqual(v.signals[0], '自验证未过');
  });

  test('buildGateVerdict: verify 信号(_inputCheck.passed=false) → verify/0.5', () => {
    const v = buildGateVerdict({ _inputCheck: { passed: false } });
    assertEqual(v.action, 'verify');
    assertEqual(v.score, 0.5, '无 score 字段时 verify 默认 0.5');
  });

  test('buildGateVerdict: _verification 高于阈值且无 issues → 不触发', () => {
    const v = buildGateVerdict({ _verification: { score: 0.8 } });
    assertEqual(v.action, 'pass', 'score≥阈值且无 issues 不应触发 verify');
  });

  test('buildGateVerdict: 空数组信号值 → 不触发', () => {
    const v = buildGateVerdict({ _inputCheckIssues: [], _outputChecklistIssues: [] });
    assertEqual(v.action, 'pass', '空数组 = 未命中');
  });

  test('buildGateVerdict: 优先级 block > rewrite(同时命中取 block)', () => {
    const v = buildGateVerdict({ _blockedByFirewall: true, _selfContradictory: true });
    assertEqual(v.action, 'block', 'block 优先于 rewrite');
  });

  test('buildGateVerdict: 优先级 rewrite > verify(同时命中取 rewrite)', () => {
    const v = buildGateVerdict({ _selfContradictory: true, _verification: { score: 0.2 } });
    assertEqual(v.action, 'rewrite', 'rewrite 优先于 verify');
  });

  test('buildGateVerdict: 多个 verify 信号都记录, score 取自带阈值的 _verification', () => {
    const v = buildGateVerdict({
      _verification: { score: 0.4 },
      _inputCheck: { passed: false }
    });
    assertEqual(v.action, 'verify');
    assertEqual(v.score, 0.4, 'score 取自 _verification(唯一带 scoreThreshold)');
    assertEqual(v.signals.length, 2, '两个信号都记录');
  });

  test('isAllowed: pass/verify 放行, block/rewrite 拦截', () => {
    assertTrue(isAllowed({ action: 'pass' }), 'pass 放行');
    assertTrue(isAllowed({ action: 'verify' }), 'verify 放行(需证据但不拦)');
    assertFalse(isAllowed({ action: 'block' }), 'block 拦截');
    assertFalse(isAllowed({ action: 'rewrite' }), 'rewrite 拦截');
    assertTrue(isAllowed(null), '无判定默认放行');
  });

  test('信号清单: 三级优先级齐备且字段合法', () => {
    assertTrue(BLOCK_SIGNALS.length >= 2, 'block 信号');
    assertTrue(REWRITE_SIGNALS.length >= 3, 'rewrite 信号');
    assertTrue(VERIFY_SIGNALS.length >= 5, 'verify 信号');
    for (const spec of [...BLOCK_SIGNALS, ...REWRITE_SIGNALS, ...VERIFY_SIGNALS]) {
      assertTrue(typeof spec.key === 'string' && spec.key.startsWith('_'), '键名为 _ 前缀');
      assertTrue(typeof spec.label === 'string' && spec.label.length > 0, '有 label');
      assertTrue(typeof spec.reason === 'string' && spec.reason.length > 0, '有 reason');
    }
  });
};
