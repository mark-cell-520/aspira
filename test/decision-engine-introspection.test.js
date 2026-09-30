/**
 * test/decision-engine-introspection.test.js — [第二十三轮]
 *
 * 锁什么: scripts/autonomous-upgrade.js 的 introspection 是**喂给决策自己的数**。
 * 决策引擎靠它判断"这个仓库有多大、有多少测试"，从而给各升级切片打分。
 * 周期23 实测: 它原报 dimCount=59、testCount=241，而真相是 **54** 维、
 * **310** 个测试文件、1369 个用例。两个数都是"数了一个相邻的东西，然后用了它的名字"。
 *
 *   dimCount  数的是 `const dimMap = {...}` 的键。dimMap 带 5 个别名
 *             (bullshit / appeal_to_authority / pseudo_causal / soft_deflection /
 *             ai_writing_tell)，它们是 dimMap 的键却不是 dimensions 的键。
 *             实测 dimMap 59 键、discriminate().dimensions 54 键，多出的正是那 5 个。
 *   testCount 用 readdirSync('test') —— 只数**顶层**，漏掉 test/compliance 等子目录
 *             (实测顶层 241、递归 310)；且它数的是**文件**，却被 prompt 写成
 *             "241测试"，读起来像用例数(实测 1369)。
 *
 * 为什么值得一个锁而不是记住: 这两个数不参与算术(切片分数来自静态表)，
 * 它们只进决策的**推理文本**。于是一个错的数不会让任何断言变红，只会让每一次
 * 自主决策都基于虚假的规模 —— 正是本仓库反复记载的形状:
 * **一个从没被测量过的数，在全绿的报告里和一个锁住的数无法区分。**
 *
 * 本锁的做法: 每个数都同时钉住"它必须等于什么"和"它必须不等于什么"。
 * 只钉前者，实现可以换一个错法仍然通过；钉住"不等于 dimMap 键数"，
 * 才把旧的错法真正关在门外。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'scripts', 'autonomous-upgrade.js');

// 走 --introspect-only: 这个脚本正常运行会 writeFileSync 一个 journal，
// 测试每跑一遍套件就多一份 journal —— 那是用污染换覆盖。
function introspect() {
  const out = execFileSync('node', [ENGINE, '--introspect-only'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

function walkTestFiles(dir) {
  let n = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += walkTestFiles(p);
    else if (e.name.endsWith('.test.js')) n++;
  }
  return n;
}

module.exports = function ({ test, assertTrue, assertEqual }) {

  test('自省的 dimCount 必须等于 discriminate().dimensions 的实测键数', () => {
    const { dimCount } = introspect().introspection;
    const gate = require(path.join(ROOT, 'src', 'gate.js'));
    const real = Object.keys(gate.discriminate('hello world', []).dimensions || {});
    assertEqual(dimCount, real.length,
      `dimCount 必须等于运行时 dimensions 键数；引擎报 ${dimCount}，实测 ${real.length}`);
    assertEqual(dimCount, 54, '与仓库各处声称的 54 维一致');
  });

  test('dimCount 不得等于 dimMap 的键数(那正是周期23 修掉的错法)', () => {
    const { dimCount } = introspect().introspection;
    const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
    const m = indexSrc.match(/const dimMap = \{([\s\S]*?)\n\s*\};/);
    const dimMapKeys = [...m[1].matchAll(/([a-z_]+)\s*:/g)].length;
    assertTrue(dimMapKeys !== dimCount,
      `引擎仍在数 dimMap(${dimMapKeys} 键)而不是 dimensions(${dimCount} 键)—— 那 5 个别名又被算成了维度`);
    // 反向证据: dimMap 确实比 dimensions 多，所以这条断言不是恒真的。
    const gate = require(path.join(ROOT, 'src', 'gate.js'));
    const real = Object.keys(gate.discriminate('hello world', []).dimensions || {}).length;
    assertTrue(dimMapKeys > real,
      `本断言的前提失效了: dimMap(${dimMapKeys}) 现已不多于 dimensions(${real})，请重新设计这条锁`);
  });

  test('自省的 testCount 必须等于递归数出的测试文件数', () => {
    const { testCount } = introspect().introspection;
    const recursive = walkTestFiles(path.join(ROOT, 'test'));
    assertEqual(testCount, recursive,
      `testCount 必须等于递归计数；引擎报 ${testCount}，实测 ${recursive}`);
  });

  test('testCount 不得等于只数顶层的结果(那正是周期23 修掉的另一个错法)', () => {
    const { testCount } = introspect().introspection;
    let topLevel = 0;
    try {
      topLevel = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).length;
    } catch (_) {}
    assertTrue(testCount !== topLevel,
      `引擎仍在只数 test/ 顶层(${topLevel})而不是递归(${testCount}) —— 子目录里的测试文件没被数到`);
    const recursive = walkTestFiles(path.join(ROOT, 'test'));
    assertTrue(recursive > topLevel,
      `本断言的前提失效了: 递归(${recursive}) 现已不多于顶层(${topLevel})，请重新设计这条锁`);
  });

  test('自省数不得被当成用例数使用(prompt 里必须标注它是文件数)', () => {
    // 数字对了但标注错了，读者仍会把它当用例数 —— 周期23 的"241测试"就是这种。
    // 所以锁措辞: 用到 testCount 的地方必须说明它是文件、且用例数未在此实测。
    const src = fs.readFileSync(ENGINE, 'utf8');
    assertTrue(/测试文件/.test(src),
      '引擎源码里必须出现"测试文件"字样，说明 testCount 的身份已被标注');
    assertTrue(/用例数未在此实测/.test(src),
      '必须明确写出用例数没有在这里实测，而不是留一个会被误读的裸数字');
    assertTrue(!/\$\{testCount\}测试/.test(src),
      '不得再把 ${testCount} 直接接在"测试"二字后面——那读起来就是用例数');
  });
};
