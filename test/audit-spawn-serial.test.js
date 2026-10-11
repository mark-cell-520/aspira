/**
 * test/audit-spawn-serial.test.js
 *
 * [doc-honest-numbers·第二百一十三轮] 新建。
 *
 * ═══ 缺口 ═══
 * 审计测测试数的方式是 spawn `test/run-all.js` 读它的汇总行。而那份 spawn
 * **没有传并发度**，于是子进程落进 run-all 的默认并发模式；铁律 3 的门禁与
 * 文档里的测试数读数却是**串行**实测的。
 *
 * 同一份代码，两种口径各测一次。而并发口径有已知的 1-2 个假象失败
 * (cycle 132/194/204/205/207/211 六轮记录: 每次组合不同、单独跑全绿)。
 *
 * 本轮实测的后果，用审计自己的 spawn 形态复现过:
 *   · 审计 spawn 读出 2248 通过 / 2 失败
 *   · 串行门禁读出   2257 通过 / 0 失败
 *   · 文档写         2257
 * 于是四条 tests 类声称**每一次都被判不一致**，而文档是对的。两个失败单独跑
 * 都是全绿(audit-doc-coverage 8/8、domains-title-vs-table 6/6)。
 *
 * 这不是文档数字错，是**仪器与被测口径不同**。而它的方向特别坏: 文档越诚实
 * (写串行实测值)，审计越红。一个把正确读数报成错误的仪器，比不报更糟 ——
 * 它训练人把文档数字改成并发读数，而那才是错的。
 *
 * ═══ 修法 ═══
 * 审计 spawn 时显式传 `ASPIRA_TEST_CONCURRENCY: '1'`，与门禁同口径。
 * 代价如实记: 审计从约 2 分钟变成约 8 分钟(串行一遍约 6 分钟，并发约 40 秒)。
 *
 * ═══ 本锁 ═══
 * ① 源级: 审计 spawn run-all 的那一整个语句块必须含 ASPIRA_TEST_CONCURRENCY='1'
 * ② 前提自证: run-all 必须真的读这个变量 —— 否则①恒真
 *    (cycle 29 的形状: 一个"必须"的前提 silently 变了，它就永远不能失败)
 * ③ 反向证明: 把 env 摘掉，①必须按名红
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');

  const ROOT = path.join(__dirname, '..');
  const AUDIT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
  const RUNNER = path.join(ROOT, 'test', 'run-all.js');

  // 取出"spawn run-all 的那一整个语句块": 从 spawnSync( 起，用括号配对找到它的
  // 结束括号。**不能逐行匹配** —— 本轮首版就是逐行的，而实际写法是多行的
  // (`spawnSync(...) \n cwd: ... \n env: ...`)，于是逐行只看到第一行、看不到
  // env，一把正确的锁报出不存在的违规。这是"按文本匹配而不看结构"的又一个变体:
  // 前几次是把注释当代码，这次是把多行语句当单行。
  function spawnBlock(src) {
    const start = src.search(/spawnSync\(\s*['"]node['"]\s*,\s*\[\s*['"]test\/run-all\.js['"]\s*\]/);
    if (start < 0) return null;
    const open = src.indexOf('(', start);
    let depth = 0, inStr = false, esc = false;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === "'" || c === '"') inStr = false;
        continue;
      }
      if (c === "'" || c === '"') { inStr = true; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    return null;
  }

  // ── 一、源级: 审计 spawn run-all 必须显式串行 ────────────
  test('审计 spawn run-all 的那一整个语句块必须传 ASPIRA_TEST_CONCURRENCY=1', () => {
    const src = fs.readFileSync(AUDIT, 'utf8');
    const block = spawnBlock(src);
    assertTrue(!!block, '审计里找不到 spawn run-all 的语句块 —— 它的写法变了?');

    assertTrue(/ASPIRA_TEST_CONCURRENCY/.test(block),
      '审计 spawn run-all 未传 ASPIRA_TEST_CONCURRENCY —— 子进程会落进默认并发模式, ' +
      '而门禁与文档读数是串行实测, 两者口径不同则读数必然不一致');

    // 值必须是 '1'(串行)，不能是别的
    const m = /ASPIRA_TEST_CONCURRENCY\s*:\s*['"]([^'"]*)['"]/.exec(block);
    assertTrue(!!m, 'ASPIRA_TEST_CONCURRENCY 必须以字面量形式传入(否则读不出值)');
    assertEqual(m[1], '1',
      `ASPIRA_TEST_CONCURRENCY 应为 '1'(串行), 实测 '${m[1]}' —— 传别的值仍是并发口径`);

    // 且必须真的继承原有环境(否则会丢掉 PATH 等)
    assertTrue(/\.\.\.process\.env/.test(block),
      'env 必须展开 process.env —— 直接传一个字面量对象会丢掉调用方环境');
  });

  // ── 二、前提自证: run-all 必须真的读这个变量 ─────────────
  // 没有这一条, 用例一可以是恒真的: 传给一个没人读的变量，形态对、效果零。
  test('前提自证: run-all 必须真的读 ASPIRA_TEST_CONCURRENCY', () => {
    const src = fs.readFileSync(RUNNER, 'utf8');
    assertTrue(/ASPIRA_TEST_CONCURRENCY/.test(src),
      'run-all.js 不读 ASPIRA_TEST_CONCURRENCY —— 那么用例一锁的那个变量没有任何效果, ' +
      '本锁恒真');
    // 且它必须真的影响并发度(而不只是被读一下)
    const m = /ASPIRA_TEST_CONCURRENCY[^\n]*\n[^\n]*CONCURRENCY/.exec(src)
      || /CONCURRENCY\s*=\s*\([\s\S]{0,300}?ASPIRA_TEST_CONCURRENCY[\s\S]{0,120}?\)/.exec(src);
    assertTrue(!!m,
      'ASPIRA_TEST_CONCURRENCY 必须参与 CONCURRENCY 的计算 —— 只读不用同样让用例一恒真');
  });

  // ── 三、反向证明: 摘掉 env，源级用例必须红 ───────────────
  test('反向证明: 摘掉 env 后源级用例必须红(证明它真能失败)', () => {
    const src = fs.readFileSync(AUDIT, 'utf8');
    const block = spawnBlock(src);
    assertTrue(!!block, '前提失效: 找不到 spawn 语句块');

    // 在内存里把 env 那一行摘掉，复用用例一的谓词
    const brokenBlock = block.replace(
      /\n\s*env: \{ \.\.\.process\.env, ASPIRA_TEST_CONCURRENCY: '1' \},/, '\n  /* env 已摘除 */');
    assertTrue(brokenBlock !== block,
      '变异未生效 —— 锚点没匹配上, 本次反向证明无效(cycle 32: 一个没变异的变异证明' +
      '与不能失败的锁无异)');
    assertTrue(!/ASPIRA_TEST_CONCURRENCY/.test(brokenBlock), '变异未把变量摘干净');

    // 用例一的谓词跑在变异版上，必须不通过
    assertTrue(!/ASPIRA_TEST_CONCURRENCY/.test(brokenBlock),
      '摘掉 env 后用例一的谓词仍然通过 —— 说明它抓不到"没传并发度"这个缺陷, 本锁是装饰');
  });
};
