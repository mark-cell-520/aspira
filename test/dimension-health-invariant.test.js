// test/dimension-health-invariant.test.js
// dimension-health-audit 切片：锁定维度健康仪器当前实测健康的不变量(防回归)。
//
// 背景(诚实数字，先测后写)：2026-10-06 手动跑 scripts/dimension-health-audit.js 实测汇总——
//   "曾触发但从不推 finding: 0 ✓"、"SCORE_ONLY 与引擎真实门禁集完全一致 ✓"、别名一致 ✓。
// 即 AGENTS.md 第27轮记录的"仪器把 score-only 维度误报成从不推 finding"的缺陷**已被后续修复**；
// 本轮不为修复它(已修)，而是**把这份健康与契约钉住**，使其 regression 即红。
//
// 为什么用子进程跑真仪器而非重述：
//   · dimension-health-audit.js 纯计算、**零文件写入/无网络/无子进程**(只按结果置 exitCode)，故可
//     安全并入 run-all 的并发执行(不违反 runner 的"无共享文件写"安全前提)。
//   · 它正是喂语料判"哪个维度该推 finding 却沉默"的仪器；用真仪器才能锁真契约。
//
// 锁两条(均当前成立=零回归)：
//   ① 退出码 === 0。该脚本只在下列真实缺陷时置 1：非仅打分维度"触发却从不推 finding"(silentButShouldPush)、
//      门禁集自洽核对不符、别名不一致。exit==0 ⟺ 维度登记健康。
//      顺带钉住 tail 里那个"exitCode 只升不降"的修复——若回归成"打印 ✗ 却返回 0"，①即失败。
//   ② stdout 含「SCORE_ONLY 与引擎真实门禁集完全一致」——分数型维度豁免学习仍在(第27轮误报不复发)。
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AUDIT = path.join(ROOT, 'scripts', 'dimension-health-audit.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name} :: ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

let out = '';
let code = 0;
t('维度健康仪器可用(可 spawn 且返回)', () => {
  try {
    out = execFileSync('node', [AUDIT], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 48 * 1024 * 1024 });
  } catch (e) {
    code = (typeof e.status === 'number') ? e.status : 1;
    out = (e.stdout || '') + (e.stderr || '');
    if (code === 0) throw new Error('子进程异常但退出码 0? ' + (e.message || ''));
  }
});

// 证据：把实测汇总行打出来(诚实数字，非依赖)。
const keepLines = out.split('\n').filter(l =>
  /从不推 finding/.test(l) || /从未触发/.test(l) ||
  /SCORE_ONLY 与引擎真实门禁集/.test(l) || /别名一致性/.test(l) || /自洽/.test(l));
if (keepLines.length) console.log('  ── 仪器实测汇总 ──\n' + keepLines.map(l => '     ' + l.trim()).join('\n'));

t('仪器健康: 退出码===0(无"触发却从不推 finding"维度; 门禁/别名自洽)', () => {
  ok(code === 0, `exit != 0(=${code}) → 维度健康回归，见上方仪器输出`);
});

t('SCORE_ONLY 与引擎真实门禁集完全一致(分数型豁免学习在)', () => {
  ok(/SCORE_ONLY 与引擎真实门禁集完全一致/.test(out), '未见"完全一致"行 → 第27轮误报可能回归');
});

console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
process.exit(failed > 0 ? 1 : 0);
