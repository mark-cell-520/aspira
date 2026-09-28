/**
 * test/think-cache-counting.test.js — think 缓存的真实生效与计数
 *
 * ═══ 背景(连续两轮, 同一功能的三个缺陷) ═══
 * 上轮: `_thinkCache` **从未赋值** →
 *   `_cacheGet` 恒返回 null(永远 miss)、`_cachePut` 恒直接 return(永远写不进)。
 *   **缓存功能自上线起从未生效，且不抛任何错。**
 *   (让代码能安全调用的 guard, 正是让故障不可见的 guard)
 *   已在构造函数初始化。
 *
 * 本轮(验证上轮修复时发现): 缓存**生效了**，
 *   但 `misses` 计数不准 —— `_cacheGet` 只在 **TTL 过期**时才 misses++，
 *   `if (!entry) return null`(未命中)这条最常见的路径**不计数**。
 *   于是 `hitRate = hits/(hits+misses)` 恒接近 1，
 *   `aspira_cache_stats` 报的命中率是**假的**。
 *   这次是"修了行为、指标仍是假的"。
 *
 * ═══ 本轮自造的坑(如实记录) ═══
 * 我第一版在 `_cacheGet` **和** `_cachePut` **两处**都加了 misses++，
 * 注释里明明写了"只在一处计"，代码却两处都计 ——
 * 实测两次相同输入得 misses=2(应为 1)，当场发现并撤掉 `_cachePut` 那处。
 * **想清楚的和写下来的不一致时, 实测是唯一的裁判。**
 *
 * ═══ 本测试锁什么 ═══
 * ① 构造后 _thinkCache 必须存在(上轮修复)
 * ② 相同输入 think 两次 → 第二次必须命中(hits 增加)
 * ③ 未命中必须计数(misses 与 think 次数匹配)
 * ④ 命中率必须真实(不是恒接近 1 的假数)
 * ⑤ 不同输入必须 miss 且 size 增长
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Aspira } = require(path.join(ROOT, 'src', 'core', 'heartflow.js'));

module.exports = function ({ test, assertEqual, assertTrue }) {

  const mk = () => {
    const inst = new Aspira({
      rootPath: path.join(ROOT, 'data', '_tc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
      silent: true,
    });
    inst.start();
    return inst;
  };

  // ─── ① 构造后即存在 ────────────────────────────────────────
  test('_thinkCache 构造后必须即存在(上轮修复)', () => {
    const hf = mk();
    assertTrue(!!hf._thinkCache, '构造后 _thinkCache 不得为 undefined');
    assertTrue(hf._thinkCache.map instanceof Map, 'map 必须是 Map');
    assertEqual(hf._thinkCache.stats.hits, 0, '初始 hits 应为 0');
    assertEqual(hf._thinkCache.stats.misses, 0, '初始 misses 应为 0');
  });

  // ─── ②③ 相同输入必须命中, 未命中必须计数 ──────────────────
  test('相同输入 think 两次必须命中, 且未命中必须计数', () => {
    const hf = mk();
    return (async () => {
      const q = '用于验证缓存命中与计数的固定输入';
      await hf.think(q);
      const afterFirst = { ...hf._thinkCache.stats };
      await hf.think(q);
      const afterSecond = { ...hf._thinkCache.stats };

      assertTrue(afterSecond.hits === afterFirst.hits + 1,
        `第二次相同输入应命中, hits 应 +1(实测 ${afterFirst.hits} → ${afterSecond.hits})`);
      assertEqual(afterSecond.mapSize || afterSecond.size, 1, '应只缓存 1 条');

      // 未命中计数: 第一次必须计 1 次 miss
      assertEqual(afterFirst.misses, 1,
        `首次 think 应计 1 次 miss(实测 ${afterFirst.misses}) —— 未命中不计数是上轮缺陷`);

      // 命中率必须真实: 此时 hits=1, misses=1 → hitRate 应约 0.5
      const total = afterSecond.hits + afterSecond.misses;
      assertEqual(total, 2, 'hits+misses 应等于 think 次数 2');
      const rate = afterSecond.hits / total;
      assertTrue(Math.abs(rate - 0.5) < 0.01,
        `命中率应约 0.5(实测 ${rate}) —— 若 misses 恒为 0 则命中率恒接近 1, 是假数`);
    })();
  });

  // ─── ⑤ 不同输入必须 miss 且 size 增长 ──────────────────────
  test('不同输入必须 miss 且缓存 size 增长', () => {
    const hf = mk();
    return (async () => {
      await hf.think('第一个输入 ' + Date.now());
      const s1 = { ...hf._thinkCache.stats };
      await hf.think('第二个完全不同的输入 ' + Date.now());
      const s2 = { ...hf._thinkCache.stats };

      assertEqual(s2.misses, s1.misses + 1, '不同输入应再计一次 miss');
      assertEqual(s2.hits, s1.hits, '不同输入不应产生 hit');
      assertEqual(s2.size, s1.size + 1, '缓存 size 应增长');
    })();
  });
};
