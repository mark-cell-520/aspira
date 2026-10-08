/**
 * test/dream-seed-reproducibility.test.js — dream({seed}) 曾不可复现
 *
 * [test-coverage-gap·第一百五十六轮] 新建。
 *
 * B 类"活着但没测"清单第一件是 src/dream/dream.js(1528 行, 13 个方法, 零测试)。
 * 按 cycle 28/148 的纪律"probing by calling"，全景调用它，抓到一处真实缺陷。
 *
 * ═══ 缺陷 ═══
 * `dream(options)` 接受 `options.seed`，`_applySeed()` 的注释写的是
 * "种子是一个意象或概念，渗透进梦的每个层面"。而缓存键是:
 *
 *     const cacheKey = `${stateHash}:${seed}:${functionType}:${intensity}`;
 *
 * —— **seed 是缓存键的一节**，设计意图明显是"同 seed 同结果"。
 *
 * 但缓存写入的条件是:
 *
 *     if (!seed) { this._dreamCache = result; this._cachedStateHash = cacheKey; }
 *
 * "无种子的纯状态查询才缓存"。于是:
 *   · 带 seed 时永远不写缓存 → `_cachedStateHash === cacheKey` 永远不成立
 *   · cacheKey 里的 seed 一节是**死参数**
 *   · `dream({seed:'ocean'})` 在同一实例上连调两次，**结果不同**
 *
 * 根因: `_pickRandom` 的 Fisher-Yates、`pickThemeFrom`、以及 `_weaveDream` 里
 * 那几处 `Math.random()` 全都不受 seed 影响 —— seed 只经 `_applySeed` 决定
 * 注入哪些意象/主题/结尾，不决定随机序列。
 *
 * 一个名为 seed 的参数不可复现是反直觉的，而 cacheKey 的设计意图
 * 从未被执行过。
 *
 * ═══ 修法 ═══
 * 把 `if (!seed)` 改成**总是写缓存**。cacheKey 已含 seed/functionType/intensity，
 * 换任一再调都会得到新键，不会串味。
 *
 * 不选"把 seed 接进 PRNG"那条路: 那要改 10+ 处 Math.random() 调用点并引入
 * 一个确定性随机源，是大工程；而 cacheKey 已经表达了"同 seed 同结果"这个意图，
 * 让它生效是本题的最小解。
 *
 * ═══ 实测 ═══
 *   同 seed 两次: 修复前不同 → 修复后**同一对象**
 *   不同 seed / 不同 intensity / 不同 functionType: 各不相同(cacheKey 各段都在工作)
 *   无 seed: 仍缓存; updateState 后: 缓存失效(同 seed 也失效)
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const { DreamV11 } = require(path.join(ROOT, 'src', 'dream', 'dream.js'));

  const mk = () => new DreamV11({ modules: 5, memoryLayers: { core: 2, learned: 1 }, qtable: { enabled: true } });

  // ── 一、同 seed 必须可复现(核心缺陷) ────────────────────
  test('同一实例上 dream({seed}) 必须可复现', async () => {
    const d = mk();
    const a = await d.dream({ seed: 'ocean' });
    const b = await d.dream({ seed: 'ocean' });
    assertTrue(a === b || JSON.stringify(a) === JSON.stringify(b),
      '同 seed 连调两次结果不同 —— seed 没参与缓存键(原实现 if (!seed) 使它成为死参数)，' +
      '而 _pickRandom / pickThemeFrom / _weaveDream 的 Math.random() 都不受 seed 影响');
    // 中文 seed 同样要可复现
    const c = await d.dream({ seed: '桥' });
    const e = await d.dream({ seed: '桥' });
    assertTrue(JSON.stringify(c) === JSON.stringify(e), '中文 seed 也必须可复现');
  });

  // ── 二、seed 必须有区分度(不是恒返回同一结果) ───────────
  test('不同 seed 必须产生不同结果', async () => {
    const d = mk();
    const a = await d.dream({ seed: 'ocean' });
    const b = await d.dream({ seed: 'bridge' });
    assertTrue(JSON.stringify(a) !== JSON.stringify(b),
      '两个不同 seed 产生了相同结果 —— seed 没有区分度，_applySeed 可能失效了');
  });

  // ── 三、反向控制: cacheKey 的每一节都必须真的分键 ───────
  test('同 seed 下改 intensity / functionType 必须得到不同结果', async () => {
    const d = mk();
    const base = await d.dream({ seed: 'ocean', intensity: 0.7, function: 'synthesis' });
    const other = await d.dream({ seed: 'ocean', intensity: 0.5, function: 'synthesis' });
    assertTrue(JSON.stringify(other) !== JSON.stringify(base),
      '同 seed 不同 intensity 返回了同一结果 —— cacheKey 的 intensity 一节没生效');
    const fn = await d.dream({ seed: 'ocean', intensity: 0.7, function: 'memory' });
    assertTrue(JSON.stringify(fn) !== JSON.stringify(base),
      '同 seed 不同 functionType 返回了同一结果 —— cacheKey 的 functionType 一节没生效');
  });

  // ── 四、无 seed 仍缓存, updateState 后失效 ──────────────
  test('无 seed 仍走缓存, updateState 后缓存必须失效', async () => {
    const d = mk();
    const a = await d.dream();
    const b = await d.dream();
    assertTrue(a === b, '无 seed 的两次调用应命中缓存(返回同一对象)');
    d.updateState({ modules: 99, memoryLayers: { core: 9 } });
    const c = await d.dream();
    assertTrue(c !== a, 'updateState 后应重新生成(缓存失效)');
    // updateState 之后同 seed 也必须失效
    const s1 = await d.dream({ seed: 'ocean' });
    d.updateState({ modules: 7 });
    const s2 = await d.dream({ seed: 'ocean' });
    assertTrue(s2 !== s1, 'updateState 后同 seed 也必须重新生成');
  });

  // ── 五、源级: cacheKey 必须含 seed ──────────────────────
  test('源级: 缓存键必须包含 seed(否则 seed 与缓存彻底无关)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'dream', 'dream.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const line = src.split('\n').find(l => l.includes('const cacheKey'));
    assertTrue(!!line, '前提失效: 找不到 cacheKey 定义');
    assertTrue(/\$\{[^}]*seed[^}]*\}/.test(line),
      `cacheKey 必须含 seed —— 它是"同 seed 同结果"这个设计意图的唯一载体: ${line.trim()}`);
    // 自证: 谓词必须能判"seed 不在键里"为缺陷, 否则本条是恒真锁
    const noSeed = line.replace('${seed}', '${sd}');
    assertTrue(/\$\{[^}]*seed[^}]*\}/.test(noSeed) === false,
      '自证失效: 谓词抓不到"seed 不在缓存键里"这一形态, 本条是恒真锁');
  });
};
