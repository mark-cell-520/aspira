/**
 * test/meta-learning-select-strategy.test.js — selectStrategy 曾对 null 抛错
 *
 * [test-coverage-gap·第一百六十七轮] 新建。
 *
 * B 类"活着但没测"第一件是 src/cortex/self-evolution/meta-learning.js
 * (1325 行, 19 个方法, 零测试)。按 cycle 28/148/156/159 的纪律
 * "probing by calling" 全景调用它。
 *
 * ═══ 缺陷 ═══
 * `selectStrategy` 的第一行原是:
 *
 *     const input = this._safeInput(context.input || '');
 *
 * `context.input` 在读 `_safeInput` **之前**求值，所以：
 *
 *     selectStrategy(null)      → TypeError: Cannot read properties of null (reading 'input')
 *     selectStrategy(undefined) → 同上
 *
 * 同文件的其它公开方法都走 `_safeInput`(它对 null / 非字符串都有防御)，
 * 只有这一处把防御写在了取字段之后 —— **防御的次序错了，等于没有防御**。
 *
 * ═══ 修法 ═══
 * 改成 `this._safeInput((context && context.input) || '')`，先判空再取字段。
 *
 * ═══ 本轮的一个误判，值得单独记 ═══
 * 探针首轮直接用字符串调 `selectStrategy('什么是递归？')`，得到
 * `{strategy:'conceptual', confidence:0.3, reason:'空输入，默认概念分析'}`，
 * 我据此判断"策略选择完全失效"。**那是我的调用方式错** —— 该方法读的是
 * `context.input`(对象)，唯一内部调用方 learn() 也确实包了一层
 * `{ input: contextInput }`。按对象形状重测，5 种策略分派全部正确。
 * 这是本仓库反复记录的形状: **探针用错契约时，健康代码看起来是坏的**。
 * 本锁第二条因此专门钉住 5 种策略的分派，防这个误判复发。
 *
 * ═══ 顺带测出但**未修**的一处(需产品判断) ═══
 * 策略分派的 if/else if 顺序把 `是什么`(概念询问)排在 `为什么`(原因探索)
 * 之前，于是含"是什么"的为什么句被判成 conceptual:
 *     「原因是什么？」              → conceptual(期望 socratic)
 *     「请解释一下为什么需要锁，原因是什么。」→ conceptual(期望 socratic)
 *     「实现方法是什么」            → conceptual(期望 step_by_step)
 * 调整分支顺序是优先级设计，属产品判断，按铁律 2 本轮只披露不修。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const { MetaLearning } = require(path.join(ROOT, 'src', 'cortex', 'self-evolution', 'meta-learning.js'));

  // 用临时目录做 projectRoot，避免碰仓库 data/
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-lock-'));
  const mk = () => new MetaLearning(tmp);

  // ── 一、null/undefined 不得抛错 ─────────────────────────
  test('selectStrategy 对 null / undefined / 空对象不得抛错', () => {
    const ml = mk();
    const bad = [];
    for (const v of [null, undefined, {}, { input: '' }, { input: null }, { input: undefined }]) {
      let r;
      try { r = ml.selectStrategy(v); } catch (e) { bad.push(`${JSON.stringify(v)} 抛错: ${e.message}`); continue; }
      if (!r || r.strategy !== 'conceptual') { bad.push(`${JSON.stringify(v)} → ${JSON.stringify(r)}(期望空输入兜底)`); continue; }
      // reason 也要是兜底那句 —— 否则删掉兜底分支后空输入会走到分派逻辑，
      // 虽然 strategy 仍恰好是 conceptual，但 confidence 与 reason 都变了
      // (实测: 兜底 reason='空输入，默认概念分析'，分派 reason='匹配输入意图')。
      if (r.reason !== '空输入，默认概念分析') bad.push(`${JSON.stringify(v)} → reason=${r.reason}(期望空输入兜底那句)`);
    }
    assertEqual(bad.join('\n'), '', '以下输入抛错或未走空输入兜底:\n' + bad.join('\n'));
  });

  // ── 二、五种策略分派必须真的工作(防"策略失效"误判复发) ──
  test('五种策略必须按输入意图正确分派', () => {
    const ml = mk();
    const CASES = [
      ['conceptual', '什么是递归？请解释一下这个概念的含义。'],
      ['example', '请给我一个例子，比如举个示例说明。'],
      ['analogy', '这像什么？有没有类似的比喻可以帮我理解。'],
      ['step_by_step', '我该怎么做？请说明步骤和实现方法。'],
      ['socratic', '为什么会这样？'],
    ];
    const bad = [];
    for (const [want, s] of CASES) {
      const r = ml.selectStrategy({ input: s });
      if (r.strategy !== want) bad.push(`${JSON.stringify(s).slice(0, 26)} → ${r.strategy}(期望 ${want})`);
    }
    assertEqual(bad.join('\n'), '', '策略分派不符:\n' + bad.join('\n'));
  });

  // ── 三、learn() 的内部路径必须仍然正确 ──────────────────
  test('learn() 内部包对象调 selectStrategy 的路径必须仍然工作', async () => {
    const ml = mk();
    const r = await ml.learn('什么是递归？请解释一下这个概念的含义。');
    assertTrue(r && typeof r === 'object', 'learn() 应返回对象');
    assertEqual(r.strategy, 'conceptual', `learn() 应分派到 conceptual, 实测 ${r.strategy}`);
    assertTrue(r.result && r.result.success === true, 'learn() 应成功执行');
    // 空输入仍走 empty 分支
    const e = await ml.learn('');
    assertEqual(e.strategy, 'empty', '空输入应走 empty 分支');
  });

  // ── 四、源级: 不得回到 context.input(裸取字段) ──────────
  test('源级: selectStrategy 必须先判空再取 input 字段', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'cortex', 'self-evolution', 'meta-learning.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const seg = src.slice(src.indexOf('selectStrategy(context)'), src.indexOf('selectStrategy(context)') + 400);
    assertTrue(/context\s*&&\s*context\.input/.test(seg),
      'selectStrategy 必须先判 context 再取 .input —— 裸写 context.input 时 null 会抛');
    assertTrue(!/this\._safeInput\(context\.input/.test(seg),
      '不得回到 this._safeInput(context.input || ...) —— 那个写法对 null 抛错(本轮修复的形状)');
  });

  // ── 五、披露: 策略优先级的三处偏差(未修，需产品判断) ────
  test('披露: 策略分派优先级把"为什么"句判成 conceptual(未修)', () => {
    const ml = mk();
    // 这三条是本轮实测的偏差: 含"是什么"的为什么句/步骤句被判 conceptual，
    // 因为 conceptual 的 if 分支排在 socratic / step_by_step 之前。
    // 调整分支顺序是优先级设计，属产品判断，按铁律 2 本轮不修。
    const BIASED = [
      ['原因是什么？', 'socratic'],
      ['请解释一下为什么需要锁，原因是什么。', 'socratic'],
      ['实现方法是什么', 'step_by_step'],
    ];
    const bad = [];
    for (const [s, want] of BIASED) {
      const got = ml.selectStrategy({ input: s }).strategy;
      if (got !== want) bad.push(`${JSON.stringify(s)} → ${got}(直觉上应 ${want})`);
    }
    // 这条是**披露性**断言: 它记录当前偏差。若将来有人调整了分支顺序，
    // 三条会全部变成符合直觉，本条红 —— 那时请更新披露并补对应的锁。
    assertEqual(bad.length, BIASED.length,
      `优先级偏差已改变(当前 ${BIASED.length - bad.length}/${BIASED.length} 条符合直觉) —— ` +
      '若有人调整了分支顺序，请同步更新本条披露与 test/ 下的策略分派锁');
  });
};
