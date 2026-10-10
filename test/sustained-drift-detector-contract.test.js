/**
 * test/sustained-drift-detector-contract.test.js —
 * 一个被调用了十几轮的名字, 从未被导入过; 而吞掉它的 catch 写着"公式不可用"
 *
 * [test-coverage-gap·第一百九十一轮] 新建。
 *
 * ═══ 本轮切口 ═══
 * `coverage-sweep.js` 实测: src 模块 380 个 / A 疑似死代码 12 / B 活着但没测 100 /
 * C 有测试引用 268 —— 与 SKILL.md 的声称逐字一致, 所以本轮的缺口在 B 类里。
 * B 类榜首是 self-play.js(891 行)与 agent-philosophy.js(889 行), 但 cycle 28 已记下
 * 选模块的标准: **逐个 require 一遍是覆盖戏剧, 只证明它能加载**。要找的是契约清晰、
 * 可往返、且**已经有人记录过它坏**的那一个。
 *
 * AGENTS.md 里正躺着一条: `sustained-drift-detector.js:312 getFormulaBridge 未导入`,
 * 标注"连续十余轮披露未修"。实测确认它还在:
 *   整个文件只 require 了 safe-fs 和 path, `getFormulaBridge()` 既未导入也未定义。
 *
 * ═══ 缺陷形状 ═══
 * 它每次被调用都抛 `ReferenceError: getFormulaBridge is not defined`, 而被紧跟的
 *   一个 catch 块静默吞掉, 那个 catch 的注释写着"公式不可用"。
 * 于是: 不抛错、不告警、返回值结构完全合法, 而
 * `this._history[last].phaseTransition` **永远不会被设置**。
 *
 * 这是本仓库记录最多的形状 —— *调用成功, 不抛错, 结构合法, 内容已死* ——
 * 且 catch 的注释让它看起来是**设计**: "公式不可用时跳过"。它确实会在公式真不可用
 * 时跳过, 但它同时也在公式可用时跳过, 而没有任何东西能区分这两种情况。
 * 同族: 第一百七十一轮 think-pipeline 的 getFormulaBridge、第一百七十九轮
 * value-internalizer 的 `_makeScoreResult`(守卫自己是坏的)。
 *
 * ═══ 修法 ═══
 * 函数内 `require('../formula/formula-bridge.js')`, 与 src/core/engine-memory.js:751
 * 同型。不放模块顶部的两个理由都写进了源码注释:
 * ① 顶部 require 会改变本模块的加载时序(它被 heartflow 懒加载);
 * ② 若 formula-bridge 自身加载失败, 顶部 require 会让**整个探测器**起不来,
 *    而这里要的只是"公式不可用时跳过相变计算"。
 *
 * ═══ 锁什么 ═══
 * ① 行为: 漂移超过阈值后, history 里必须出现**真实的** phaseTransition
 *    (不是空对象、不是占位 —— 要有 ginzburgLandau 的真实字段);
 * ② 行为: 该结果必须与直接调 bridge.ginzburgLandau 的输出一致(防止锁被假实现买通);
 * ③ 源级: 调用点之前必须出现 getFormulaBridge 的导入(防回归);
 * ④ 反向: 把导入删掉, ①②必须按名红 —— 证明这把锁真的能看见这个缺陷;
 * ⑤ 边界: 公式真的不可用时不得抛出去(catch 的正当用途必须保留)。
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'cortex', 'sustained-drift-detector.js');

function makeDetector() {
  const { SustainedDriftDetector } = require(SRC);
  return new SustainedDriftDetector();
}
// 喂一串高漂移状态, 让 emaScore 超过阈值从而进入相变分支
function feedDrift(d, n = 12, score = 0.95) {
  for (let i = 0; i < n; i++) {
    d.recordState({ identityHash: 'a'.repeat(8), score, drift: score });
  }
  return d._history || [];
}

module.exports = function ({ test, assertEqual, assertTrue }) {

  // ── 一、相变结果必须真实存在 ────────────────────────────
  test('漂移超阈值后 history 必须带真实的 phaseTransition', () => {
    const d = makeDetector();
    const hist = feedDrift(d);
    assertTrue(hist.length > 0, '前提失效: 没有产生任何 history 记录');
    const withPhase = hist.filter(h => h.phaseTransition !== undefined && h.phaseTransition !== null);
    assertTrue(withPhase.length > 0,
      'history 里没有任何一条带 phaseTransition —— getFormulaBridge 未被导入时, '
      + 'ReferenceError 被 catch(e){/* formula unavailable */} 静默吞掉, 字段永不设置');
    // 必须是 ginzburgLandau 的真实输出, 不是空对象/占位
    const last = withPhase[withPhase.length - 1].phaseTransition;
    assertEqual(typeof last, 'object', 'phaseTransition 必须是对象');
    assertTrue('orderParameter' in last, 'phaseTransition 缺少 ginzburgLandau 的 orderParameter 字段');
    assertTrue('phase' in last, 'phaseTransition 缺少 ginzburgLandau 的 phase 字段');
  });

  // ── 二、结果必须与直接调 bridge 一致(防假实现买通) ───────
  test('phaseTransition 必须与直接调 ginzburgLandau 的输出一致', () => {
    const d = makeDetector();
    // ⚠️ 复算参数必须取自 recordState 的返回值, 不能自以为传进去的 score 就是 emaScore:
    // 代码用的是 `this._ema(dims.rawScore)` 平滑后的值, 首版喂 0.95 却拿 0.95 复算,
    // 实测 reducedTemp 差 1.5(3.166667 vs 1.666667)—— 是我的锁自己算错了参数,
    // 而它报错的样子和"实现是假的"一模一样。
    let lastRet = null;
    for (let i = 0; i < 12; i++) {
      lastRet = d.recordState({ identityHash: 'a'.repeat(8), score: 0.95, drift: 0.95 });
    }
    const hist = d._history || [];
    const withPhase = hist.filter(h => h.phaseTransition);
    assertTrue(withPhase.length > 0, '前提失效: 没有 phaseTransition, 无法比对');
    assertTrue(lastRet && typeof lastRet.emaScore === 'number',
      '前提失效: recordState 未返回 emaScore, 无法复算');
    const got = withPhase[withPhase.length - 1].phaseTransition;
    const { getFormulaBridge } = require(path.join(ROOT, 'src', 'formula', 'formula-bridge.js'));
    const bridge = getFormulaBridge();
    // 与源码完全相同的两个入参
    const orderParam = 1 - Math.min(1, lastRet.emaScore);
    const expect = bridge.ginzburgLandau(orderParam, lastRet.emaScore, d.driftThreshold);
    assertEqual(JSON.stringify(got), JSON.stringify(expect),
      'phaseTransition 与直接调 bridge.ginzburgLandau 的结果不一致 —— '
      + '说明这条数据不是来自公式引擎, 本条锁可能被假实现买通');
  });

  // ── 三、源级: 调用点之前必须导入 ────────────────────────
  test('源级: getFormulaBridge 调用点之前必须出现它的导入', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    // ⚠️ 必须用 lastIndexOf: 首版用 indexOf, 它命中的是**我自己写在注释里的**
    // 「`getFormulaBridge()` 在这里被调用了十几轮」——那一处在导入行之前,
    // 于是 `before` 不含导入, 用例恒红。注释里的同名文本不是调用点。
    const callAt = src.lastIndexOf('getFormulaBridge()');
    assertTrue(callAt > 0, '前提失效: 找不到 getFormulaBridge() 调用点(锚点已变)');
    const before = src.slice(0, callAt);
    assertTrue(/const\s*\{\s*getFormulaBridge\s*\}\s*=\s*require\(/.test(before),
      'getFormulaBridge() 调用点之前没有 `const { getFormulaBridge } = require(...)` —— '
      + '这正是缺陷本身: 调用一个从未导入的名字, ReferenceError 被 catch 静默吞掉');
  });

  // ── 四、反向: 删掉导入, ①②必须按名红 ───────────────────
  test('反向: 删掉导入后, 行为用例必须失败', () => {
    const orig = fs.readFileSync(SRC, 'utf8');
    const IMPORT = "      const { getFormulaBridge } = require('../formula/formula-bridge.js');\n";
    assertTrue(orig.includes(IMPORT), '前提失效: 未匹配导入行(锚点已变)');
    const broken = orig.replace(IMPORT, '');
    assertTrue(broken !== orig, '变异未生效');
    // 在一个临时副本上验证, 不动共享源
    const tmp = path.join(ROOT, 'src', 'cortex', '_sdd-probe.js');
    try {
      fs.writeFileSync(tmp, broken);
      const { SustainedDriftDetector } = require(tmp);
      const d = new SustainedDriftDetector();
      const hist = feedDrift(d);
      const withPhase = hist.filter(h => h.phaseTransition);
      assertEqual(withPhase.length, 0,
        '反向证明失效: 删掉导入后 history 仍带 phaseTransition —— 说明这条数据不依赖该导入, '
        + '本条锁的通过是被别处买通的');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    assertEqual(fs.readFileSync(SRC, 'utf8'), orig, '共享源必须未被本测试改动');
  });

  // ── 五、边界: 公式真不可用时不得抛出去 ──────────────────
  test('边界: 公式桥真的不可用时, recordState 不得向外抛错', () => {
    // 复刻缺陷现场的 catch 语义: 用一个 require 必然失败的副本来跑
    const orig = fs.readFileSync(SRC, 'utf8');
    const OLD = "      const { getFormulaBridge } = require('../formula/formula-bridge.js');";
    assertTrue(orig.includes(OLD), '前提失效: 未匹配导入行');
    const broken = orig.replace(OLD,
      "      const { getFormulaBridge } = require('./__no_such_formula_bridge__');");
    const tmp = path.join(ROOT, 'src', 'cortex', '_sdd-probe.js');
    try {
      fs.writeFileSync(tmp, broken);
      const { SustainedDriftDetector } = require(tmp);
      const d = new SustainedDriftDetector();
      // 不得抛 —— catch 的正当用途(公式不可用时跳过)必须保留
      let threw = null;
      try { feedDrift(d); } catch (e) { threw = e; }
      assertTrue(threw === null,
        `公式不可用时 recordState 向外抛出了 ${threw && threw.message} —— `
        + 'catch 的正当用途是"公式不可用时跳过", 修导入不该把这份容错也修掉');
      // 且历史仍然记录了(漂移检测本身不能因公式缺失而停止)
      assertTrue((d._history || []).length > 0,
        '公式不可用时 history 为空 —— 相变计算失败不应让漂移记录本身停止');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    assertEqual(fs.readFileSync(SRC, 'utf8'), orig, '共享源必须未被本测试改动');
  });
};
