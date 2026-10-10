/**
 * test/self-play-defend-purity.test.js — defend() 不得写回调用方传入的判断对象
 *
 * ═══ 第二百零一轮 ═══
 * 切片: test-coverage-gap。
 *
 * 选模块的第九种标准。前八轮依次用过「契约清晰」(191)、「被文档完整路径承诺」(194)、
 * 「导出纯函数与常量表」(195)、「src 扇入最高」(196)、「被 MCP 工具直接调用」(197)、
 * 「错误处理最可能掩盖失败」(198)、「入口参数从未被校验」(199)、
 * 「公开方法恒返回同一常量」(200)。本轮问的是 196 那个问题的**逆问题**:
 *   cycle 196 问"谁**直接** require 它" —— 直接扇入低的模块它就看不见。
 *   本轮问"**已测代码的传递闭包里能不能到达它**"?
 * 一个只有一两个直接消费者、却被几十个已测模块传递到达的模块, 它的缺陷一样会
 * 到达生产路径, 而 cycle 196 的判据对这种形状完全失明。
 *
 * 机械代理: 在仓库自己的 coverage-sweep.js 分类(B 92 / C 279 / A 12)之上建
 * require 图, 对每个 C 类模块 BFS 求传递可达集, 再按 B 类模块被多少个 C 模块
 * 可达来排序, 取"直接引用者少但传递可达高"里最大的那个。
 *
 * 命中: `src/reasoning/self-play.js` —— 891 行, B 类最大, **零测试引用**,
 * 唯一直接消费者是 heartflow.js(它自己是 C 类), 却被 23 个已测模块传递到达,
 * 而且 think-pipeline.js:72 / :150 真的在调 `engine.selfPlay.refine(...)`。
 * 它不是"构造了没人用"的 cycle-199 形状, 是生产路径上的活代码。
 *
 * ═══ 调用它(不是 require 它)实测到的缺陷 ═══
 * defend() 的第一行是 `const defended = { ...judgment }` —— **一层浅拷贝**。
 * 于是 _applyDefense() 里写 `judgment.chosenPath.metadata.defenses` 时,
 * `defended.chosenPath` 与调用方传入的 chosenPath 是**同一个引用**, 这一笔
 * 就落在了调用方的原始对象上。实测:
 *     challengeCount = 4 | addressed = 3
 *     调用方对象被改动? true
 *       变化字段: chosenPath → {... "metadata":{"defenses":[{...}]}}
 * 而这个方法的 JSDoc 把参数叫做「原始判断」、返回值叫做 strengthened ——
 * 契约本来是"输入原样不动, 输出强化版"。
 *
 * **本模块自己的 refine() 就是设计意图的证据**: 它在入口第一件事是
 * `let current = this._deepClone(judgment)`, 用深拷贝保护入参。同一个文件里,
 * 一个公开方法小心地不碰调用方对象, 另一个公开方法却把它改坏。
 *
 * 深层依赖: `chosenPath.metadata` 本身、`metadata.defenses` 数组本身也都是共享
 * 引用, 所以补一层 `chosenPath: {...judgment.chosenPath}` 不够 —— 实测那样改完,
 * 连续两次 defend() 仍会把 defenses 累积到调用方的数组里。必须整份深拷贝。
 *
 * 修法: `const defended = this._deepClone(judgment)`。用模块自己的 _deepClone
 * 而不是 structuredClone, 因为 refine() 早已对同一个对象做同样的变换, 不引入
 * 新的风险类别; 且 _deepClone 对非对象原样返回, defend(42, …) 这类形状的既有
 * 抛错点不变(见下面披露的第 4 条)。
 *
 * ═══ 同一轮测量到、但按铁律 2 只披露不修的四件事 ═══
 * ① **refine() 的 improvement 恒为 0, 于是两个生产消费点的 `> 0` 守卫全是死的。**
 *    `improvement = finalScore - initialScore`, 两者都是 evaluateRobustness() 的分;
 *    而 _applyDefense() 只写 chosenPath.metadata.defenses / judgment.metadata /
 *    confidence += 0.02 —— `_scoreDimension` 六个维度一个都不读这三个字段。
 *    所以"防御"这个动作在评分器眼里不存在, 分数对防御**恒不变**。
 *    后果不只是报告难看: think-pipeline.js:81 与 :159 都是
 *        `if (spResult && spResult.improvement > 0) { ... }`
 *    improvement 永远不 > 0, 于是"验证分低 → SelfPlay 定向精炼 → 重新验证"
 *    这个闭环**一次都没触发过**。让评分器认得一次成功防御, 要决定"一次成功防御
 *    值多少分", 属产品判断, 超出本轮一个最小变更。
 * ② `defend()` 在无挑战时返回 `score: NaN`(0/0), 它落在 refine() 的
 *    history[].defenseScore 里。同样是一行守卫, 但与本轮修的污染不是同一件事,
 *    留着不混。
 * ③ `_buildAlternative()` 用 `Math.random() > 0.4` 决定 `promising`,
 *    同一输入 12 次得到 9 种不同组合, 且这个值直接决定 RL 奖励 0.7/0.3。
 *    与 cycle 197 的 spontaneous-restraint 同族, 但那是另一个模块的另一轮。
 * ④ `refine(null)` → 读 options.maxCycles 抛错; `defend(坏形状, 有挑战)` →
 *    _generateDefense 读 judgment.chosenPath 抛错。与 cycle 199/200 同族
 *    (默认值只覆盖"不传参")。生产调用点自己构造对象, 目前不可达。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SRC = path.join(ROOT, 'src', 'reasoning', 'self-play.js');
  const { SelfPlay } = require(SRC);

  function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sp-defend-')); }
  function mk(opts) { return new SelfPlay(Object.assign({ dataDir: tmpdir() }, opts || {})); }

  const JUDGMENT = {
    id: 'j-1',
    input: 'should we refactor the auth module now',
    confidence: 0.62,
    reasoning: ['step one', 'step two'],
    paths: [
      { id: 'p1', score: 0.8, cost: 0.4, risk: 0.3, reversibility: true, alignment: 0.7 },
      { id: 'p2', score: 0.5, cost: 0.2, risk: 0.2, reversibility: true },
    ],
    chosenPath: { id: 'p1', score: 0.8, cost: 0.4, risk: 0.3, reversibility: true, alignment: 0.7 },
    context: { goal: 'ship safely' },
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ─── 主缺陷: defend() 不得写回调用方的判断对象 ───────────────────

  test('defend() 之后调用方传入的 judgment 必须逐字不变', () => {
    const sp = mk();
    const input = clone(JUDGMENT);
    const before = JSON.stringify(input);
    const ch = sp.challenge(input);
    assertTrue(ch.challengeCount > 0, '探针本身失效: 这个判断应当产生挑战, 实测 ' + ch.challengeCount);
    const d = sp.defend(input, ch);
    assertTrue(d.addressed.length > 0, '探针本身失效: 应当有被成功防御的挑战');
    const after = JSON.stringify(input);
    assertEqual(after, before,
      'defend() 写回了调用方对象。差异在: ' + firstDiff(JSON.parse(before), JSON.parse(after)));
  });

  test('嵌套的 chosenPath.metadata.defenses 也不得被累积到调用方数组里', () => {
    // 只补一层 chosenPath: {...} 不够 —— metadata 与 defenses 数组本身仍是共享引用。
    const sp = mk();
    const input = clone(JUDGMENT);
    const ch = sp.challenge(input);
    sp.defend(input, ch);
    sp.defend(input, ch);
    sp.defend(input, ch);
    assertEqual((input.chosenPath.metadata || {}).defenses, undefined,
      'chosenPath.metadata.defenses 被写进了调用方对象(浅拷贝修不干净的那一层)');
    assertEqual(input.metadata, undefined, 'judgment.metadata 被写进了调用方对象');
    assertEqual(input.confidence, 0.62, 'confidence 被 _applyDefense 抬高了');
  });

  test('refine() 同样不得改动调用方传入的 judgment', () => {
    const sp = mk({ maxCycles: 4 });
    const input = clone(JUDGMENT);
    const before = JSON.stringify(input);
    const r = sp.refine(input);
    assertTrue(r.history.length >= 1, 'refine 应至少跑一轮');
    assertEqual(JSON.stringify(input), before, 'refine() 改动了入参');
  });

  // ─── 修复没有把功能一起修掉 ─────────────────────────────────────

  test('strengthened 仍真的带着防御记录(不是把增强整个关掉)', () => {
    const sp = mk({ maxCycles: 4 });
    const input = clone(JUDGMENT);
    const r = sp.refine(input);
    const defenses = (r.refined.chosenPath.metadata || {}).defenses || [];
    assertTrue(defenses.length > 0, 'strengthened 上没有 defense 记录 —— 深拷贝把增强也关掉了');
    assertTrue((r.refined.metadata.selfPlayDefenses || []).length > 0, '缺 selfPlayDefenses');
    assertTrue(r.refined.confidence > 0.62, '成功防御仍应小幅抬高 confidence');
    // 引用必须独立, 不只是值相等
    assertTrue(r.refined.chosenPath !== input.chosenPath, 'chosenPath 仍与入参同一个引用');
    assertTrue(r.refined.metadata !== input.metadata, 'metadata 仍与入参同一个引用');
  });

  test('defend() 返回值本身的契约不变(challenges/score/addressed)', () => {
    const sp = mk();
    const input = clone(JUDGMENT);
    const ch = sp.challenge(input);
    const d = sp.defend(input, ch);
    assertEqual(d.defenses.length, ch.challengeCount, '每条挑战都应有一条防御');
    assertEqual(d.addressed.length + d.unaddressed.length, ch.challengeCount, 'addressed + unaddressed 应等于挑战数');
    assertTrue(d.score > 0 && d.score <= 1, 'score 应是 (0,1] 内的比率, 实测 ' + d.score);
  });

  // ─── 源级: 必须是深拷贝, 不能是浅拷贝 ───────────────────────────

  test('源级: defend() 必须整份深拷贝, 不得是 { ...judgment }', () => {
    // 先剥掉行注释再匹配: 修复说明里逐字引用了被删掉的那行浅拷贝,
    // 不剥注释的话这把锁会读自己的文档为犯规(cycle 19/25/194/195/197 同族,
    // 本轮是第六次)。
    const raw = fs.readFileSync(SRC, 'utf8');
    const src = raw.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assertTrue(src !== raw || raw.indexOf('//') < 0, '注释剥离不应改变代码语义');
    const start = src.indexOf('  defend(judgment, challengeResult) {');
    assertTrue(start >= 0, '找不到 defend() 定义(锚点已变)');
    // 方法体截到下一个双空格缩进的方法定义为止, 不让后续方法的内容混进来
    const rest = src.slice(start + 10);
    const nextDef = rest.search(/\n  (?!\*)[a-zA-Z_][\w]*\s*\(/);
    const body = nextDef >= 0 ? rest.slice(0, nextDef) : rest;
    assertTrue(body.indexOf('_deepClone(judgment)') >= 0,
      'defend() 里看不到 `const defended = this._deepClone(judgment)`');
    assertTrue(!/\{\s*\.\.\.judgment\s*\}/.test(body),
      'defend() 里仍有浅拷贝 `{ ...judgment }` —— 它写回的正是调用方的对象');
  });

  test('反向证明: 把深拷贝换回浅拷贝, 本锁必须红(证明它真能失败)', () => {
    const orig = fs.readFileSync(SRC, 'utf8');
    const anchor = 'const defended = this._deepClone(judgment);';
    assertTrue(orig.indexOf(anchor) >= 0, '锚点不在, 反向证明无效: ' + anchor);
    // 只在内存里改, 写到仓库外的临时文件; 模块只 require ../utils/safe-fs 和 path,
    // 所以把那一条相对路径改成绝对路径就能在 /tmp 下加载, 不往 src/ 留任何文件。
    const brokenSrc = orig.replace(anchor, 'const defended = { ...judgment };')
      .replace("require('../utils/safe-fs')", "require(" + JSON.stringify(path.join(ROOT, 'src', 'utils', 'safe-fs')) + ")");
    assertTrue(brokenSrc !== orig, '替换没有生效, 反向证明无效');
    const tmpJs = path.join(tmpdir(), 'self-play-broken.js');
    fs.writeFileSync(tmpJs, brokenSrc);
    let mod = null;
    try { mod = require(tmpJs); } finally { try { fs.unlinkSync(tmpJs); } catch (_) {} }
    const sp = new mod.SelfPlay({ dataDir: tmpdir() });
    const input = clone(JUDGMENT);
    const before = JSON.stringify(input);
    const ch = sp.challenge(input);
    sp.defend(input, ch);
    assertTrue(JSON.stringify(input) !== before,
      '浅拷贝居然也没有污染调用方对象 —— 要么缺陷已不存在, 要么本锁的探针失效了');
  });

  // ─── 已披露, 不修 ───────────────────────────────────────────────

  test('已披露①: refine() 的 improvement 恒为 0, 两个生产 `> 0` 守卫是死的', () => {
    const sp = mk({ maxCycles: 4 });
    const shapes = [
      clone(JUDGMENT),
      { id: 'a', input: 'q', confidence: 0.2, reasoning: [], paths: [], chosenPath: { id: 'x' } },
      { id: 'b', input: 'q', confidence: 0.95, reasoning: ['r'], paths: [{}, {}, {}],
        chosenPath: { id: 'y', constraints: { budget: 1 }, cost: 0.1, risk: 0.1, reversibility: true, feasibility: true, consequences: [1], alignment: 0.9, score: 0.9 } },
      { id: 'c', input: 'q', confidence: 0.5, reasoning: ['r1', 'r2'], paths: [{}, {}],
        chosenPath: { id: 'z', cost: 0.9, risk: 0.9, reversibility: false, alignment: 0.1, score: 0.1 } },
    ];
    const improvements = shapes.map(j => sp.refine(j).improvement);
    for (const imp of improvements) {
      assertEqual(imp, 0, 'improvement 不再是 0 —— 若评分器已认得防御, 请把本条披露反转为"应 > 0"并删除');
    }
    // 守卫本身: 两个消费点都是 `improvement > 0`, 恒为 0 即恒不进入
    for (const imp of improvements) assertTrue(!(imp > 0), 'improvement > 0 竟然成立了');
  });

  test('已披露②: 无挑战时 defend() 返回 score 为 NaN', () => {
    const sp = mk();
    const clean = { id: 'c', input: 'q', confidence: 0.9, reasoning: ['a', 'b', 'c'],
      paths: [{}, {}, {}],
      chosenPath: { constraints: { budget: 1 }, cost: 0.1, risk: 0.1, reversibility: true, feasibility: true, consequences: [1], alignment: 0.9, score: 0.9 } };
    const ch = sp.challenge(clean);
    const d = sp.defend(clean, ch);
    assertTrue(Number.isNaN(d.score),
      'score 不再是 NaN —— 若干候修好了, 请把本披露反转为"应是有限数"并删除');
  });

  test('已披露③: _buildAlternative 用 Math.random 决定 promising', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const body = src.slice(src.indexOf('_buildAlternative(problem, strategy, context)'));
    assertTrue(/Math\.random/.test(body),
      '_buildAlternative 里看不到 Math.random —— 若干候修好了, 请把本披露反转为"应确定性"并删除');
  });

  test('已披露④: refine(判断, null) / defend(坏形状, 有挑战) 仍会抛错', () => {
    const sp = mk();
    // 注意形状: refine(null) 单参**不**抛错(judgment 为空被它自己的守卫接住),
    // 抛错的是第二参显式传 null —— `options.maxCycles` 上的默认值只覆盖"不传参",
    // 覆盖不了显式传进来的 null。这与 cycle 199/200 是同一族。
    let threw = null;
    try { sp.refine(null); } catch (e) { threw = 'refine(null)'; }
    assertEqual(threw, null, 'refine(null) 单参不应抛错(它有空判断守卫), 实测却抛了');
    threw = null;
    try { sp.refine(clone(JUDGMENT), null); } catch (e) { threw = 'refine(J, null) → ' + e.message; }
    assertTrue(threw !== null, 'refine(判断, null) 不再抛错 —— 若干候修好了, 请更新本披露');
    threw = null;
    try { sp.defend({}, { challenges: [{ id: 'c1', type: 'feasibility' }], challengeCount: 1, topic: 't' }); }
    catch (e) { threw = 'defend({}, 有挑战) → ' + e.message; }
    assertTrue(threw !== null, 'defend(坏形状, 有挑战) 不再抛错 —— 若干候修好了, 请更新本披露');
  });
};

function firstDiff(a, b, prefix) {
  prefix = prefix || '';
  if (JSON.stringify(a) === JSON.stringify(b)) return '(无差异)';
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return prefix + ': ' + JSON.stringify(a) + ' → ' + JSON.stringify(b);
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      return firstDiff(a[k], b[k], prefix ? prefix + '.' + k : k);
    }
  }
  return prefix + '(未定位)';
}
