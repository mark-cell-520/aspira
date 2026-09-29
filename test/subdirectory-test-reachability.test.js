/**
 * test/subdirectory-test-reachability.test.js
 *
 * ═══ 由来(第十四周, test-coverage-gap 切片) ═══
 * 约定 #4 说: "Tests must be reachable by test/run-all.js. It walks test/
 * recursively and executes each file in a subprocess. A test file that
 * requires ../src/... from a subdirectory must use the correct relative
 * depth, or it will never run."
 *
 * 这条约定只警告了**相对深度**，而实测的缺口比它更靠前一层:
 * run-all.js 在风格检测**之前**就把子目录文件旁路掉了——
 *   if (rel.includes('/')) { jobs.push(subTestJob(...)); continue; }
 * 于是任何子目录里的 mount 风格文件(module.exports = function/箭头)
 * 被裸 `node` 运行，export 永不被调用: 退出码 0、零输出、
 * emitResult 匹配不到汇总行 → 计 0 个用例，也不计失败。
 *
 * 而根目录文件走的是完整的 mount/箭头/jest 检测(第 234-238 行为此专门修过一次，
 * 修的是"箭头式 export 被当 plain 跑")。**同一套规则只覆盖了一半的文件**，
 * 而这一半恰好是所有子目录。
 *
 * ═══ 实测代价 ═══
 *   test/identity/agent-psychology.test.js  21 个 test() 调用
 *       裸 node  → 0 输出;  经 _mount.js → 21 个用例
 *   test/knowledge/classics-value-mapper.test.js  10 个用例
 *       它在 CORE_TESTS 里被裸跑(export 不被调用)，且即使被调用也从不使用
 *       注入的 test，自建 cases 数组、打印不含"通过/失败"的自定义汇总行
 *       → 双重静默，10 个用例从未进过总数。
 * 合计 31 个用例存在、被遍历、然后从 run-all 的总数里消失。
 *
 * ═══ 为什么这值得一个测试 ═══
 * 这是仓库反复记载的形状: 一个数字被测量、被显示、却从未被比较。
 * run-all 报 "1253 通过"，其中 31 个从未被数过——而 1253 本身看起来完全正常。
 * 更糟的是 classics-value-mapper 的用例里有一条**期望本身就是错的**
 * (断言 parseHit('no-colon-here').file 为真，而真实契约是降级返回 file:null)，
 * 它在"从未被执行"的前提下一直是绿的。**一个从未运行的断言不是一条断言。**
 *
 * ═══ 关于执行成本 ═══
 * 本测试对**全部** mount 文件各起一个 node 进程实测超时(165 个进程)，
 * 因此拆成两层: 静态查覆盖全部 165 个文件(便宜，抓死 harness 形状)，
 * 行为查只跑子目录那 2 个(贵，但正是旁路伤害的位置)。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = __dirname;
const RUN_ALL = path.join(TEST_DIR, 'run-all.js');
const MOUNT = path.join(TEST_DIR, '_mount.js');

const MOUNT_RE = /module\.exports\s*=\s*(function\b|\([^)]*\)\s*=>)/;
const JEST_RE = /\bdescribe\s*\(/;
const MINI_EXPECT_RE = /require\(['"][^'"]*mini-expect/;

/** 递归收集非 archive 的 .test.js，与 run-all 的 collectTestFiles 同规则 */
function collect(dir, base = dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'archive') continue;
      out.push(...collect(full, base));
    } else if (ent.name.endsWith('.test.js') && ent.name !== 'run-all.test.js') {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

function classify(rel) {
  let src = '';
  try { src = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8'); } catch (e) {}
  if (MOUNT_RE.test(src)) return 'mount';
  if (JEST_RE.test(src) && !MINI_EXPECT_RE.test(src)) return 'jest';
  return 'plain';
}

module.exports = function ({ test, assertTrue, assertEqual }) {

  test('每个 mount 风格的测试文件都必须真的调用注入的 test()', () => {
    // 静态锁，覆盖全部 mount 文件。抓的是 classics-value-mapper 那种形状:
    // 声明了 mount 签名，函数体却一次都不调用 test()，自己建 cases 数组、
    // 打印一行不含"通过/失败"的自定义汇总——run-all 的 emitResult 匹配不到
    // 汇总行，于是计 0 个用例、也不计失败，而文件自己的失败只写在那行文本里。
    const mountFiles = collect(TEST_DIR).filter(r => classify(r) === 'mount');
    assertTrue(mountFiles.length > 0, '至少应存在 mount 风格测试文件');

    const dead = [];
    for (const rel of mountFiles) {
      const src = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8');
      const body = src.slice(src.indexOf('module.exports'));
      // 已知边界: 若某文件把 test 存进变量再调用(const t = test; t(...))，
      // 这条静态查会误报。误报是响的，漏报是静的——选响的那一边。
      if (!/\btest\s*\(/.test(body)) dead.push(rel);
    }
    assertEqual(dead.join('\n'), '',
      '这些文件声明了 mount 签名却从不调用 test()，用例不会进入 harness:\n' + dead.join('\n'));
  });

  test('子目录里的 mount 文件经 _mount.js 必须真的产出用例', () => {
    // 行为锁，只跑子目录那 2 个 mount 文件(贵，但旁路伤害的正是这个位置)。
    // 若有人重新引入 `rel.includes('/')` 旁路，这两个文件的用例会静默归零，
    // 本测试直接从 _mount.js 的汇总行上看出"共 0 个"。
    //
    // 这里同时要求 0 失败: 若挂载函数把注入的 test 改名/不用(例如
    // `function ({ test: _unused })` 却仍写 `test(...)`)，_mount.js 会报
    // "test is not defined" 并计 1 个失败——汇总行是"共 1 个"，
    // 只查"共 0 个"会漏掉它。加载失败同样是"没被锁住"。
    const subMount = collect(TEST_DIR).filter(r => r.includes('/') && classify(r) === 'mount');
    const bad = [];
    for (const rel of subMount) {
      const abs = path.join(TEST_DIR, rel);
      let out = '';
      try {
        out = execFileSync('node', [MOUNT, abs], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        out = (e.stdout || '') + (e.stderr || '');
      }
      const m = out.match(/测试结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败,\s*共\s*(\d+)\s*个/);
      if (!m) { bad.push(rel + ': 无汇总行(可能加载即抛错)'); continue; }
      if (parseInt(m[3], 10) === 0) bad.push(rel + ': 0 个用例');
      else if (parseInt(m[2], 10) > 0) bad.push(rel + ': ' + m[2] + ' 个失败');
    }
    assertEqual(bad.join('\n'), '',
      '这些子目录 mount 文件的用例没有正确进入 harness:\n' + bad.join('\n'));
  });

  test('run-all.js 不得把子目录文件旁路成裸 node 运行', () => {
    // 源码级锁。第 228 行的旁路是 `if (rel.includes('/')) { subTestJob; continue; }`，
    // 它让风格检测只覆盖根目录。删除它之后，所有文件走同一个 pickJob。
    // 这条锁是脆的，但它精确编码了"不要把规则重新拆成两半"——
    // 而真正的行为保证由上面两条给出(那些文件的用例必须真的被计数)。
    //
    // ⚠️ 必须先剥掉注释再匹配: pickJob 的 JSDoc 里**引用了**旧旁路的原文来说明
    // 它被删掉了什么，不剥注释就会把自己写的文档当成没删掉的代码——一个把
    // 说明当罪证的锁会永远红着，然后被人连同真锁一起删掉。
    const raw = fs.readFileSync(RUN_ALL, 'utf8');
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const bypass = src.match(/rel\.includes\(['"]\/['"]\)[\s\S]{0,300}?subTestJob/);
    assertTrue(!bypass,
      'run-all.js 仍存在子目录旁路——子目录 mount/jest 文件会被裸 node 跑，用例静默归零');
    assertTrue(/function pickJob\s*\(/.test(src),
      'run-all.js 应只有一个共享的风格选择函数 pickJob');
    const calls = (src.match(/pickJob\(/g) || []).length;
    assertTrue(calls >= 3, `pickJob 应被 CORE_TESTS 与动态收集两处共用(实测 ${calls} 处引用)`);
  });

  test('子目录里不应存在被漏计的 jest 风格文件', () => {
    // jest 风格靠 `-r ./test/_jest-globals.js` 注入全局，裸 node 会直接
    // "test is not defined"。当前实测 0 个，但这是前瞻锁:
    // 一旦有人在子目录里写 describe()，这条会立刻指出来。
    const sub = collect(TEST_DIR).filter(r => r.includes('/'));
    const jestFiles = sub.filter(r => classify(r) === 'jest');
    assertEqual(jestFiles.length, 0,
      '子目录里的 jest 风格文件必须经 _jest-globals 运行: ' + jestFiles.join(', '));
  });

  test('tmpdir 不得残留版本探测目录', () => {
    // 本测试与 test/version-consistency.test.js 都不往仓库里写东西;
    // 这条锁的是"临时目录探测必须自己清理"——周期 11 的教训:
    // 一个报告成功的工具其实写错了东西，比一个失败的工具更糟。
    const left = fs.readdirSync(os.tmpdir()).filter(f => /^aspira-version-probe-/.test(f));
    assertEqual(left.length, 0, 'tmpdir 里不应残留 aspira-version-probe-* 目录');
  });
};
