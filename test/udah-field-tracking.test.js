/**
 * U/D/A/H 场域追踪自测脚本
 * 
 * 验证 decision-router 的场域追踪在各类输入下是否产生非零的 A 值
 * 对标：luoxuejian000 ThinkCheck 的 68 点采样
 * 
 * 用法: node tests/test-udah-field-tracking.js
 */

const path = require('path');
const rootDir = path.resolve(__dirname, '..');

// 模拟 13 步分析的结果，模拟 heartflow.js think() 的 evaluate() 调用
function simulateResult(options = {}) {
  return {
    cognitiveLoad: options.cognitiveLoad ?? 0.3,
    directionClear: options.directionClear ?? 0.7,
    quality: options.quality ?? 0.8,
    identityCoherence: options.identityCoherence ?? 0.7,
    dissonance: options.dissonance,
    severity: options.severity,
    valueResonance: options.valueResonance ?? 0.5,
    confidence: options.confidence ?? 0.6,
    stability: options.stability ?? 0.6,
    success: options.success ?? true,
    goalValid: options.goalValid,
    goalEthical: options.goalEthical,
  };
}

async function main() {
  // 加载 decision-router
  const DR = require('../src/core/decision-router.js');
  const router = new DR.DecisionRouter(null, { debug: false });

  // ─── 测试场景 ─────────────────────────────────────────────

  const scenarios = [
    {
      name: '正常对话 — 无矛盾',
      // A 是矛盾/失谐轴：这个场景本来就没有矛盾信号，A 必须为 0。
      // 见下方判据处的说明——原实现要求所有场景 A 非零，与这个场景自相矛盾。
      expectZeroA: true,
      result: simulateResult({ dissonance: undefined }),
    },
    {
      name: '目标无效 — 单一矛盾',
      result: simulateResult({ dissonance: 0.15, goalValid: false }),
    },
    {
      name: '目标不道德 — 中等矛盾',
      result: simulateResult({ dissonance: 0.3, goalEthical: false }),
    },
    {
      name: '安全拦截 — 高矛盾',
      result: simulateResult({ dissonance: 0.45, severity: 'HIGH', success: false }),
    },
    {
      name: '多信号冲突 — 最高矛盾',
      result: simulateResult({
        dissonance: 0.6,
        severity: 'CRITICAL',
        success: false,
        goalValid: false,
        goalEthical: false,
        stability: 0.2,
      }),
    },
    {
      name: '价值观冲突 — 中等矛盾（模拟 valueResult.conflicts）',
      result: simulateResult({ dissonance: 0.3 }),
    },
    {
      name: '痛苦信号 — 低矛盾',
      result: simulateResult({ dissonance: 0.15, quality: 0.4 }),
    },
  ];

  console.log('=== U/D/A/H 场域追踪自测 ===\n');

  let allOk = true;
  let totalA = 0;
  let nonZeroACount = 0;
  let passCount = 0;

  for (const s of scenarios) {
    // 连续跑2次让场域历史积累（需要至少4步才能触发翻转检测）
    for (let step = 0; step < 2; step++) {
      router.evaluate(s.result, `test:${s.name}`);
    }

    const stats = router.getStats();
    const summary = router.getFieldSummary();
    const current = summary?.current || {};

    const hasA = current.A !== undefined && current.A !== null;

    // ═══ 原来的判据是"每个场景的 A 都必须非零"，而它内含一个自相矛盾 ═══
    // 场景列表第一个就叫「正常对话 — 无矛盾」（dissonance: undefined），
    // A 是矛盾/失谐轴，没有矛盾时 A 理应为 0。原判据却要求它非零，
    // 于是这个场景永远判 ⚠️，而 allOk 恒为 false —— 但进程照样 exit 0，
    // 所以这件事从来没人看见。
    // 修法：按场景声明的矛盾强度分别断言，而不是一刀切要求非零。
    //   · expectZeroA 为真的场景 → A 必须约等于 0
    //   · 其余场景               → A 必须 > 0.001
    const expectZeroA = s.expectZeroA === true;
    const ok = expectZeroA
      ? (hasA && current.A <= 0.001)
      : (hasA && current.A > 0.001);
    const status = ok ? '✅' : (expectZeroA ? '❌ A 应为 0' : '❌ A 应为非零');

    if (!ok) allOk = false;
    if (hasA) {
      totalA += current.A;
      if (current.A > 0.001) nonZeroACount++;
    }
    if (ok) passCount++;

    console.log(`  ${status} ${s.name}`);
    console.log(`      U=${(current.U || 0).toFixed(3)} D=${(current.D || 0).toFixed(3)} A=${(current.A || 0).toFixed(3)} H=${(current.H || 0).toFixed(3)}`);
    if (current.lastFlipAlert) {
      console.log(`      ⚡ 翻转预警: ${current.lastFlipAlert.message}`);
    }
    console.log();
  }

  // ─── 总结 ───────────────────────────────────────────────
  console.log('=== 汇总 ===');
  console.log(`  总场景数: ${scenarios.length}`);
  console.log(`  非零A值场景: ${nonZeroACount}/${scenarios.length}`);
  console.log(`  平均A值: ${(totalA / (nonZeroACount || 1)).toFixed(3)}`);

  // 额外测试：通过 getFieldSummary 查看完整轨迹
  const fullSummary = router.getFieldSummary();
  console.log(`\n  场域历史步数: ${fullSummary?.steps || 0}`);
  console.log(`  驱动分布: ${JSON.stringify(fullSummary?.driverDistribution || {})}`);
  console.log(`  翻转预警总数: ${fullSummary?.stats?.flipAlerts || 0}`);
  console.log(`  谐振态: ${fullSummary?.resonance?.active ? '活跃' : '未激活'}`);

  if (allOk) {
    console.log('\n✅ 所有场景符合各自声明：有矛盾的 A 非零，无矛盾的 A 为 0');
  } else {
    console.log('\n⚠️ 存在 A=0 场景 — 需要更多矛盾信号注入');
    // 原来到这里就结束，进程 exit 0 —— 检查失败了而门禁看不见。
    // 这个脚本的名字是「自测」，那就该在自测失败时红。
    process.exitCode = 1;
  }

  // 规范汇总行：没有它 parseChildSummary 返回 null，这些场景在门禁总数里计 0
  console.log(`测试结果: ${passCount} 通过, ${scenarios.length - passCount} 失败, 共 ${scenarios.length} 个`);

  // 输出兼容 ThinkCheck 的格式
  console.log('\n=== ThinkCheck 兼容输出 ===');
  const hist = router._fieldHistory || [];
  if (hist.length === 0) {
    console.log('(场域历史为空 — 需要至少一次 evaluate() 调用)');
  } else {
    hist.forEach(h => {
      console.log(`STEP ${h.step}: U=${h.U.toFixed(3)} D=${h.D.toFixed(3)} A=${h.A.toFixed(3)} H=${h.H.toFixed(3)} driver=${h.driver}${h.flipAlert ? ' ⚡'+h.flipAlert : ''}`);
    });
  }
}

main().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
