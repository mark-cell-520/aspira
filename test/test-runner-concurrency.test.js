/**
 * test/test-runner-concurrency.test.js — 测试运行器并发化的护栏
 *
 * ═══ 为什么改 ═══
 * run-all.js 原本用 `execSync` 严格串行: 246 个测试文件各起一个子进程，
 * 每次付 ~26ms 裸 node 启动，串行墙钟实测 **36 秒**。实测(而非估计):
 *   裸 node 启动            26ms
 *   引擎加载                 45ms
 *   套件平均                 146ms/文件
 *   246 × 26ms 启动地板     ~6.4s
 *
 * 改为有界并发后 **5.3 秒**(6.8 倍)，结果不变(930/0，连跑 3 次稳定)。
 *
 * ═══ 改之前先量了风险，没有假设 ═══
 *   写 data/ 或 memory/ 的测试文件   0 个
 *   调 listen( / createServer( 的   0 个
 *   CPU 核数                        12
 * 所以子进程之间不存在共享文件或端口竞争。**子进程隔离本身没动**——
 * run-all.js 头部注释第 3 条记录过: 曾把 ~137 个引擎加载文件并入 runner
 * 进程导致堆耗尽被 OOM kill，所以"每个测试文件一个子进程"是承重墙，
 * 本次只改"同时在飞几个"。
 *
 * ═══ 输出兼容性 ═══
 * 结果按**发现顺序**流式打印，与串行版逐行一致(diff 只剩并发度行与日志
 * 时间戳)。这保证 scripts/audit-doc-numbers.js 仍能工作——它用
 * matchAll(/测试结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败/g) 取**最后一条**，
 * 所以最终汇总行必须是整个输出里最后一次出现。
 *
 * ═══ 递归陷阱 ═══
 * 本测试若直接执行 `node test/run-all.js`，会触发
 *   run-all → 本测试 → run-all → 本测试 → …
 * 因为 run-all 递归发现 test/ 下所有 *.test.js。修法: run-all.js 给子进程
 * 设 ASPIRA_TEST_RUNNER=1，本测试见到该标记就跳过行为校验(见下方)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');
  const ROOT = path.join(__dirname, '..');
  const SRC = fs.readFileSync(path.join(ROOT, 'test', 'run-all.js'), 'utf8');

  test('运行器不得回退到 execSync 串行(核心回归护栏)', () => {
    // 这条是整个改造的关键: 一旦有人"简化"回 execSync，并发收益全部消失，
    // 而 930 个测试仍会全绿——不会有任何测试因此变红。
    assertTrue(!/\bexecSync\s*\(/.test(SRC),
      'run-all.js 不得再调用 execSync(串行执行，36s 墙钟)');
    assertTrue(/require\('child_process'\)/.test(SRC) && /\bexec\s*\(/.test(SRC),
      'run-all.js 应使用异步 exec');
  });

  test('并发度必须有界且可覆盖', () => {
    assertTrue(/CONCURRENCY/.test(SRC), '应存在 CONCURRENCY 常量');
    // 有界: 夹在 [2,12]，避免 246 个 node 进程同时起飞把机器打满
    assertTrue(/Math\.max\(2,\s*Math\.min\(12/.test(SRC),
      '并发度应夹在 [2,12]');
    // 可覆盖: 设 1 能退回串行，便于调试
    assertTrue(/ASPIRA_TEST_CONCURRENCY/.test(SRC),
      '应支持 ASPIRA_TEST_CONCURRENCY 环境变量覆盖');
  });

  test('子进程隔离必须保留(承重墙，见文件头注释第 3 条)', () => {
    // run-all.js 头部明确记录: 曾因把引擎加载文件并入 runner 进程导致 OOM。
    // 所以每个测试文件仍必须由独立的 `node ...` 子进程执行。
    assertTrue(/node \$\{JSON\.stringify\(path\.join\(TEST_DIR/.test(SRC) ||
               /`node \$\{JSON\.stringify/.test(SRC),
      '每个测试仍须以独立 node 子进程执行');
    // 三种执行方式都必须还在
    assertTrue(/_mount\.js/.test(SRC), 'mount 注入方式必须保留');
    assertTrue(/_jest-globals\.js/.test(SRC), 'jest 风格 -r 预加载必须保留');
  });

  test('汇总行格式必须保持不变(audit-doc-numbers.js 依赖它)', () => {
    // audit 用 matchAll 取最后一条，故格式字符串必须逐字保留
    assertTrue(/测试结果: \$\{passed\} 通过, \$\{failed\} 失败, 共 \$\{passed \+ failed\} 个/.test(SRC),
      '汇总行格式必须逐字保留');
    // 判定必须基于 failed 计数而非 failures.length(原注释记录的洗绿灯陷阱)
    assertTrue(/if \(failed > 0\)/.test(SRC), '判定必须基于 failed 计数');
  });

  test('递归保护标记必须存在', () => {
    assertTrue(/ASPIRA_TEST_RUNNER/.test(SRC),
      'run-all.js 必须给子进程设 ASPIRA_TEST_RUNNER 标记，否则本测试会无限递归');
  });

  test('历史修复不得被改回去', () => {
    // 1) archive 跳过: 历史失效测试的 MODULE_NOT_FOUND 不是回归信号
    assertTrue(/ent\.name === 'archive'/.test(SRC), '必须继续跳过 test/archive/');
    // 2) mount 检测的箭头式: 原正则只认 module.exports = function 且只查前 400
    //    字符，导致 15 个箭头式 mount 文件被当 plain 运行、export 永不被调用、
    //    103 个用例静默漏计。必须保留"查全文件 + 认箭头式"。
    assertTrue(/module\.exports\\s\*=\\s\*\(function\\b|\\\(\[\^\)\]\*\\\)\\s\*=>/.test(SRC),
      'mount 检测必须同时认 function 与箭头式');
    // 3) 递归发现: 曾用非递归 readdirSync，50 个测试从未执行
    assertTrue(/collectTestFiles\(full, base\)/.test(SRC), '必须递归发现测试文件');
  });

  // ─── 行为校验 ───
  // 只有在**不被 run-all 驱动**时才跑: 直接跑整套要 ~5.3s，且在 run-all
  // 内部跑会递归。被驱动时本测试仍在套件内执行(静态断言部分照跑)。
  const underRunner = process.env.ASPIRA_TEST_RUNNER === '1';

  test('并发跑完整套件: 汇总行必须是输出中最后一次出现且 0 失败', () => {
    if (underRunner) {
      // 由 run-all 驱动: 跳过(否则递归)。静态断言已覆盖回归面。
      return;
    }
    let out = '';
    try {
      out = execSync('node test/run-all.js', {
        cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 48 * 1024 * 1024,
      });
    } catch (e) {
      out = (e.stdout || '').toString();
    }
    const all = [...out.matchAll(/测试结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败/g)];
    assertTrue(all.length > 0, '输出中应能找到汇总行');
    const last = all[all.length - 1];

    // 1) 0 失败——这是零回归的判据
    assertEqual(parseInt(last[2], 10), 0, '并发跑完整套件必须 0 失败');

    // 2) 汇总行必须是输出中最后一次出现。
    //    audit-doc-numbers.js 用 matchAll 取最后一条，若最终汇总不是最后
    //    出现的那条，它读到的就是某个子文件的小数字(原注释记录过这个坑)。
    const tailAfterLast = out.slice(out.lastIndexOf('测试结果:'));
    assertTrue(!/测试结果:/.test(tailAfterLast.slice(1)),
      '最终汇总行之后不得再出现其它汇总行');

    // 3) 并发必须真的生效(不是退回串行)。运行器会打印当前并发度。
    const m = out.match(/并发度 (\d+)/);
    assertTrue(!!m, '输出中应打印当前并发度');
    if (m) assertTrue(parseInt(m[1], 10) > 1,
      `默认并发度应 >1(否则优化没生效)，实测 ${m[1]}`);

    // 4) 总数必须为正且与"套件里实际跑了的用例数"自洽。
    //    注意: 这里**不断言**"各子文件汇总之和 == 总计"。实测两者相差 59
    //    (143 条可见汇总行之和 871 vs 总计 930)，且该差异在串行版与并发版
    //    **完全相同**——是 keep 行过滤的既有特性(246 个文件里约 102 个的
    //    汇总行没进 keep 输出)，不是本次改动引入，也不是计数错误(总数自洽:
    //    加一个 7 用例的测试文件，总数从 930 变 937)。故不把它当不变量锁。
  });
};
