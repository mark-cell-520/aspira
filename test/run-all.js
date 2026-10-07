/**
 * test-runner.js — zero-dependency test runner
 *
 * Design notes (2026-09-17):
 *
 * 1. Recursive discovery. This previously used a non-recursive readdirSync, so the
 *    50 tests under test/core/, test/memory/, test/utils/ and others never executed.
 *
 * 2. test/archive/ is skipped. It holds historical tests whose target modules were
 *    deleted; their MODULE_NOT_FOUND is not a regression signal.
 *
 * 3. Every test file runs in its own child process. Requiring ~137 engine-loading
 *    files into the runner process exhausted the heap and got the runner OOM-killed
 *    mid-run, which is why the reported totals used to vary between runs.
 *    **This isolation is load-bearing and must not be removed** — see note 4.
 *
 * 4. [2026-09-28 性能优化] Bounded-concurrency execution. The runner was strictly
 *    sequential (`execSync` one file at a time): 246 files x ~26ms of bare `node`
 *    startup = ~6.4s of pure process-spawn floor, and the measured suite wall time
 *    was 36s. Each child still runs in its own process (note 3 unchanged); only the
 *    *number in flight* changed. Concurrency defaults to `max(2, min(12, cpus-2))`
 *    and is overridable with `ASPIRA_TEST_CONCURRENCY` (set 1 to get the old
 *    sequential behaviour for debugging).
 *
 *    Safety was measured before changing it, not assumed:
 *      - 0 test files write under `data/` or `memory/`
 *      - 0 test files call `listen(` / `createServer(`
 *      - 12 CPUs available
 *    So no shared-file or port contention is possible between children.
 *
 *    Output is printed **in discovery order**, exactly as the sequential runner did,
 *    so logs remain diffable and `scripts/audit-doc-numbers.js` — which takes the
 *    LAST `测试结果: N 通过, M 失败` line — still reads the final summary. Results
 *    are flushed in order as they become available, so progress is still visible.
 *
 * Usage: node test/run-all.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const TEST_DIR = __dirname;
const ROOT = path.join(__dirname, '..');
const CHILD_TIMEOUT = 240000; // [第一百三十二轮] 90s → 240s: 12 个 doc 探针(doc-probe lock 串行化, 每个持锁期 spawn 一次完整审计 ~10s, 并发 CPU 争抢下更慢)同窗排队时, 队尾等待实测可超 90s 被误杀 —— 连续三跑各有 6 个 mount 进程 "Command failed", 失败探针组合每次不同、单独跑全绿, 测试总数在 1613/1617 间抖。这是 cycle 20/21/31 记录过的并发脆弱性的新形态(那次是锁语义, 这次是子进程耐心)。同时已把 129/130 两把新锁的"恢复后确认"从再跑一次审计改为静态字节比对(spawn 4→2)。

// ─── 并发度 ───
// 默认取 cpus-2，夹在 [2,12]。可用环境变量覆盖；设为 1 即退化为原串行行为。
const CONCURRENCY = (() => {
  const v = parseInt(process.env.ASPIRA_TEST_CONCURRENCY || '', 10);
  if (Number.isFinite(v) && v > 0) return v;
  const cpus = (os.cpus() || []).length || 4;
  return Math.max(2, Math.min(12, cpus - 2));
})();

let passed = 0;
let failed = 0;
const failures = [];

/** 递归收集测试文件，跳过 test/archive/（历史失效测试，目标模块已删除） */
function collectTestFiles(dir, base = dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'archive') continue;
      out.push(...collectTestFiles(full, base));
    } else if (ent.name.endsWith('.test.js') && ent.name !== 'run-all.test.js') {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

/**
 * 在子进程中执行一条命令，原样返回其输出。
 * 与旧版 execSync 的差别只在异步: 选项(cwd/encoding/timeout/maxBuffer)完全一致，
 * 错误时同样能从 stdout 拿到汇总行(exec 的回调在失败时也给 stdout)。
 */
function runChildCapture(label, cmd, timeout = CHILD_TIMEOUT) {
  return new Promise((resolve) => {
    exec(cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout,
      maxBuffer: 48 * 1024 * 1024,
      // 标记"我正被 run-all 驱动"。测试文件据此跳过"再跑一遍 run-all"的
      // 行为校验，否则 run-all → 该测试 → run-all → … 会无限递归。
      env: Object.assign({}, process.env, { ASPIRA_TEST_RUNNER: '1' }),
    }, (err, stdout) => {
      resolve({ label, out: (stdout || '').toString(), err: err || null });
    });
  });
}

/**
 * 解析并打印一个子进程的结果——逻辑与旧版 runChild 的执行后段逐行对应，
 * 保证计数、失败定位、keep 行输出行为不变。
 */
function emitResult({ label, out, err }) {
  console.log(`\n${label}`);
  // 异常且输出里没有汇总行: 计一次失败(与旧版一致)
  if (err && !/(\d+) 通过, (\d+) 失败/.test(out)) {
    console.log(`  [异常] ${label.trim()}: ${(err.message || '').split('\n')[0]}`);
    failed++;
    failures.push({ name: label.trim(), error: (err.message || '').split('\n')[0] });
    return;
  }
  const m = out.match(/(\d+) 通过, (\d+) 失败/);
  if (!m) {
    const tail = out.trim().split('\n').slice(-3).join('\n');
    if (tail) console.log(tail);
    return;
  }
  passed += parseInt(m[1], 10);
  failed += parseInt(m[2], 10);
  for (const line of out.split('\n')) {
    const fm = line.match(/^\s*✗\s+(.+?)\s*$/);
    if (fm) failures.push({ name: fm[1], error: `(${label.trim()})` });
  }
  const keep = out.split('\n').filter(l => l.includes('通过') || l.includes('✗') || l.includes('失败'));
  console.log(keep.join('\n') || '  (无输出)');
}

/**
 * 有界并发执行一组作业，并按**提交顺序**流式打印结果。
 * 这样输出与旧串行版逐行一致(日志可 diff)，同时把 246 次 node 启动的开销叠起来。
 */
async function runJobs(jobs) {
  const results = new Array(jobs.length);
  let nextIdx = 0;      // 下一个待领取的作业
  let printIdx = 0;     // 下一个待打印的结果
  let doneCount = 0;

  const flushInOrder = () => {
    while (printIdx < jobs.length && results[printIdx] !== undefined) {
      emitResult(results[printIdx]);
      printIdx++;
    }
  };

  const worker = async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= jobs.length) return;
      results[i] = await runChildCapture(jobs[i].label, jobs[i].cmd, jobs[i].timeout);
      doneCount++;
      // 进度提示走 stderr，避免污染 stdout 的汇总行解析
      process.stderr.write(`\r  进度 ${doneCount}/${jobs.length}`);
      flushInOrder();
    }
  };

  const n = Math.max(1, Math.min(CONCURRENCY, jobs.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  flushInOrder();
  if (jobs.length) process.stderr.write('\r' + ' '.repeat(40) + '\r');
}

function subTestJob(name, rel, timeout) {
  return { label: name, cmd: `node ${JSON.stringify(path.join(TEST_DIR, rel))}`, timeout, kind: 'plain' };
}
function mountTestJob(name, rel, timeout) {
  return {
    label: name,
    cmd: `node ${JSON.stringify(path.join(TEST_DIR, '_mount.js'))} ${JSON.stringify(path.join(TEST_DIR, rel))}`,
    timeout,
    kind: 'mount'
  };
}
function jestStyleJob(name, rel, timeout) {
  return {
    label: name,
    cmd: `node -r ${JSON.stringify(path.join(TEST_DIR, '_jest-globals.js'))} ${JSON.stringify(path.join(TEST_DIR, rel))}`,
    timeout,
    kind: 'jest'
  };
}

/**
 * [第十四周修复] 按**文件自身风格**决定怎么跑——这是唯一的选择点。
 *
 * 此前这里有两套互相矛盾的选择逻辑:
 *   · 根目录文件走完整的 mount/箭头/jest 检测(第 234-238 行为此专门修过一次);
 *   · 而**任何子目录文件**在检测之前就被 `if (rel.includes('/')) { subTestJob; continue; }`
 *     旁路掉了,一律裸 `node` 运行。
 * 于是子目录里的 mount 风格文件(module.exports = function/箭头)export 永不被调用:
 * `node <file>` 退出码 0、零输出,`emitResult` 匹配不到汇总行,计 0 个用例也不计失败。
 *
 * 实测代价(第十四周量出): `test/identity/agent-psychology.test.js` 有 21 个 test() 调用,
 * 裸跑 0 输出、经 _mount.js 有 21 个用例——**21 个用例从未进过 run-all 的总数**。
 * 这正是仓库反复记载的形状: 一个数字被测量、被显示、却从未被比较;
 * 而这里更直白——**用例存在、被执行、然后静默归零**。
 *
 * 检测顺序与正则和原来的根目录分支逐字一致,只把作用域从"根目录"扩到"全部文件"。
 */
function pickJob(label, rel, timeout) {
  let src = '';
  try { src = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8'); } catch (e) {}
  // [修复] mount 检测：原正则只认 `module.exports = function` 且只查前 400 字符，
  // 导致 15 个箭头式 mount 文件（`module.exports = ({test,...}) =>`，含 gate/output-gate/
  // pipeline/index/doubt-engine 等核心测试）被当 plain 运行——export 永不被调用，
  // 测试静默漏计（实测 103 个用例全部通过却从未进过总数）。
  // 改为：匹配 function 或箭头式，且查全文件（长 JSDoc 头会把 export 挤到 400 字符之后）。
  if (/module\.exports\s*=\s*(function\b|\([^)]*\)\s*=>)/.test(src)) {
    // 导出 mount 函数：子进程 + 注入 harness
    return mountTestJob(label, rel, timeout);
  } else if (/\bdescribe\s*\(/.test(src) && !/require\(['"][^'"]*mini-expect/.test(src)) {
    // jest/mocha 风格：它自己调 describe/it，靠 -r 注入全局
    return jestStyleJob(label, rel, timeout);
  }
  return subTestJob(label, rel, timeout);
}

// === MAIN ===
async function runAllTests() {
  console.log('\n=== Aspira module tests ===\n');

  // 1-4. 已清理模块，保留占位说明历史
  console.log('CodeWriter / CodeGenerator / HeartLogic / DesireCognition — 模块已清理');

  // 显式列出的核心测试（与历史覆盖保持一致）
  const CORE_TESTS = [
    ['KnowledgeOntology', 'knowledge-ontology.test.js'],
    ['KnowledgeQuery', 'knowledge-query.test.js'],
    ['ClassicsValueMapper', 'knowledge/classics-value-mapper.test.js'],
    ['ClassicsRules', 'knowledge/classics-rules.test.js'],
    ['DualPerspectiveAuditor', 'dual-perspective.test.js'],
    ['SignalAbsorber', 'signal-absorber.test.js'],
    ['AgentBoundaryGuard', 'agent-boundary-guard.test.js'],
    ['MetacognitiveExecutive', 'metacognitive-executive.test.js'],
    ['RecoveredModules', 'recovered-modules.test.js'],
    ['RecoveredModules2', 'recovered-modules-2.test.js'],
    ['KnowledgeGraphAdapter', 'knowledge-graph-adapter.test.js'],
    ['SourceAnnotator', 'source-annotator.test.js'],
    ['SecurityAudit', 'security-audit.test.js'],
    ['IdentityCore', 'identity-core.test.js'],
    ['BigFivePersonality', 'big-five.test.js'],
    ['SelfModel', 'self-model.test.js'],
    ['LogicReasoning', 'logic-reasoning.test.js'],
    ['ReflectionLoop', 'reflection-loop.test.js'],
    ['ModuleRegistry (P4)', 'module-registry.test.js'],
    ['RouteWhitelist (P4)', 'route-whitelist.test.js'],
    ['SafeFS (P4)', 'safe-fs.test.js'],
  ];

  const explicit = new Set();
  const jobs = [];
  for (const [label, rel] of CORE_TESTS) {
    if (!fs.existsSync(path.join(TEST_DIR, rel))) continue;
    explicit.add(rel);
    // 显式列出的核心测试也走同一个选择点——否则 CORE_TESTS 里的 mount 风格文件
    // (knowledge/classics-value-mapper.test.js 就是)仍会被裸跑,export 不被调用。
    jobs.push(pickJob(`  ${label}`, rel));
  }

  // 动态接入其余测试文件（全部子进程隔离）
  console.log('\n=== 动态接入其余测试文件 ===');
  console.log(`  (并发度 ${CONCURRENCY}；可用 ASPIRA_TEST_CONCURRENCY 覆盖，设 1 退回串行)`);
  const allTests = collectTestFiles(TEST_DIR);
  for (const rel of allTests) {
    if (explicit.has(rel)) continue;
    // [第十四周修复] 删除 `if (rel.includes('/')) { subTestJob; continue; }` 旁路:
    // 子目录文件与根目录文件走同一套风格检测。标签前缀随选中的风格变化
    // (mount → '+', jest → 'j', plain → '·'),与原来的输出格式保持一致。
    const probe = pickJob(null, rel);
    const prefix = probe.kind === 'mount' ? '+' : (probe.kind === 'jest' ? 'j' : '·');
    probe.label = `  ${prefix} ${rel}`;
    jobs.push(probe);
  }

  await runJobs(jobs);

  // 汇总
  console.log('\n' + '='.repeat(50));
  console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
  // 判定必须基于 failed 计数，不能用 failures.length：后者只收集带 ✗ 前缀的用例，
  // 子测试若用其他格式报告失败（FAIL:/AssertionError/汇总行前移），会出现
  // "failed>0 但 failures 为空"——那时会打印"全部通过"且 exitCode=0，把回归洗成绿灯。
  if (failed > 0) {
    console.log('\n失败的测试:');
    for (const f of failures) console.log(`  - ${f.name} ${f.error}`);
    if (failures.length === 0) {
      console.log(`  （有 ${failed} 个失败，但未能从输出定位到具体用例——上方 keep 行应有线索，请上查原始输出）`);
    }
    process.exitCode = 1;
  } else {
    console.log('\n全部通过。');
  }
}

runAllTests().catch(err => {
  console.error('测试运行器错误:', err);
  process.exit(1);
});
