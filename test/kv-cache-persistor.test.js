/**
 * test/kv-cache-persistor.test.js — KV Cache 持久化引擎
 *
 * ═══ 为什么补这个测试 ═══
 * `src/memory/kv-cache.js`(558 行)在 `scripts/coverage-sweep.js` 的清点里属 B 类:
 * **没有测试引用，但有 src 引用** —— 管线在跑它，却没有任何断言说它该怎样工作。
 * AGENTS.md 已经记着这个教训: "referenced by no test file" 比 "never executed"
 * 弱得多，管线会跑很多模块而不对它们的行为作任何断言。
 *
 * ═══ 本测试当场抓出的一个真缺陷 ═══
 * `getStats()` 的 `hitRate = hits / Math.max(1, loads)`，而 **`loads` 从未被自增** —
 * 全文件只有第 452 行读它，没有任何一处 `this._stats.loads++`。
 * 于是分母恒为 1: 实测 1 命中 + 2 未命中，真实命中率 **0.33**，报告值却是 **1.00**。
 * 一个永远显示 100% 的命中率指标，比没有指标更糟 —— 它让人以为缓存很有效。
 * 已在 `load()` 唯一入口自增一次，覆盖命中/未命中/异常三条路径。
 *
 * ═══ 断言的边界(都是实测出来的，不是想当然) ═══
 * · 量化是**有损且钳位到 [0,1]** 的: `quantize4bit` 先 `Math.max(0, Math.min(1, v))`
 *   再 `Math.round(v*15)`，`dequantize4bit` 是 `q/15`。所以:
 *     - `-0.3` 存进去取出来是 `0`(不是近似，是被钳掉)
 *     - 精度是 1/15 ≈ 0.067，不是无损
 *   不断言"往返相等"，那会对一个自称 4-bit 量化的模块提出错误要求。
 * · `maxEntrySize` 默认 1024，数组会被 slice 到该长度 —— 超长输入静默截断。
 * · 首版我曾以为 `totalEntries: 0` 是 bug，实测是因为**那次我已经 delete 掉了**。
 *   差点把正确行为当缺陷修。教训: 看到可疑数字先复现最小场景，再下结论。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const ROOT = path.join(__dirname, '..');
  const { KVCachePersistor } = require(path.join(ROOT, 'src', 'memory', 'kv-cache.js'));

  // 每个用例独立临时目录，避免共享 data/ 状态(本仓库的既有教训)
  const mkCache = (opts = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-kv-'));
    return { dir, cache: new KVCachePersistor({ cacheDir: dir, ...opts }) };
  };
  const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } };

  test('save → load 往返: 对象无损，数组按 4-bit 量化', () => {
    const { dir, cache } = mkCache();
    try {
      // 对象不走量化分支，应无损
      const obj = { a: 1, b: 'x', nested: { c: [1, 2, 3] } };
      assertTrue(cache.save('s1', 'obj', obj), 'save 应返回 true');
      assertEqual(JSON.stringify(cache.load('s1', 'obj')), JSON.stringify(obj),
        '对象应无损往返(对象分支不量化)');

      // 数组走量化分支，钳位到 [0,1] 且精度 1/15
      const arr = [0, 0.5, 1];
      assertTrue(cache.save('s1', 'arr', arr), 'save 数组应返回 true');
      const back = cache.load('s1', 'arr');
      assertTrue(Array.isArray(back), '数组应原样返回数组');
      assertEqual(back.length, 3, '长度应保持');
      // 0 / 0.5 / 1 都在量化格点上，应精确还原
      assertEqual(back[0], 0, '0 应精确还原');
      assertEqual(back[2], 1, '1 应精确还原');
      assertTrue(Math.abs(back[1] - 0.5) <= 1 / 15,
        `0.5 应在 1/15 精度内还原，实测 ${back[1]}`);
    } finally { cleanup(dir); }
  });

  test('负值被钳位到 0(4-bit 量化的设计行为，不是缺陷)', () => {
    const { dir, cache } = mkCache();
    try {
      cache.save('s1', 'neg', [-0.3, -1, -0.001]);
      const back = cache.load('s1', 'neg');
      assertEqual(back[0], 0, '-0.3 应被钳位成 0');
      assertEqual(back[1], 0, '-1 应被钳位成 0');
      assertEqual(back[2], 0, '-0.001 应被钳位成 0');
    } finally { cleanup(dir); }
  });

  test('不存在的键: load 返回 null、has 返回 false、misses 增加', () => {
    const { dir, cache } = mkCache();
    try {
      assertEqual(cache.load('nope', 'nope'), null, '不存在的键应返回 null');
      assertTrue(!cache.has('nope', 'nope'), 'has 应为 false');
      assertEqual(cache.getStats().misses, 1, 'misses 应记 1 次');
    } finally { cleanup(dir); }
  });

  test('loads 必须被计数，hitRate 必须是真实命中率(本轮修复)', () => {
    const { dir, cache } = mkCache();
    try {
      cache.save('s1', 'k', [0.5]);
      cache.load('s1', 'k');        // 命中
      cache.load('s1', 'miss1');    // 未命中
      cache.load('s1', 'miss2');    // 未命中
      const s = cache.getStats();
      assertEqual(s.loads, 3, `loads 应计数全部 3 次调用，实测 ${s.loads}`);
      assertEqual(s.hits, 1, 'hits 应为 1');
      assertEqual(s.misses, 2, 'misses 应为 2');
      // 修复前: loads 恒为 0 → hitRate = 1/max(1,0) = 1.00，与真实 0.33 严重不符
      assertEqual(s.hitRate, '0.33',
        `hitRate 应等于 hits/(hits+misses)=0.33，实测 ${s.hitRate}(修复前是 1.00)`);
    } finally { cleanup(dir); }
  });

  test('delete 后键消失，且索引同步更新', () => {
    const { dir, cache } = mkCache();
    try {
      cache.save('s1', 'k1', [0.5]);
      cache.save('s1', 'k2', [0.5]);
      assertTrue(cache.has('s1', 'k1'), '删除前应存在');
      assertEqual(cache.delete('s1', 'k1'), true, 'delete 应返回 true');
      assertTrue(!cache.has('s1', 'k1'), '删除后 has 应为 false');
      assertEqual(cache.load('s1', 'k1'), null, '删除后 load 应为 null');
      // 索引必须同步，否则 getStats 与实际不符
      assertEqual(cache.getStats().totalEntries, 1,
        `删除后索引应只剩 1 条，实测 ${cache.getStats().totalEntries}`);
      assertTrue(cache.has('s1', 'k2'), '同 session 其他键不应受影响');
    } finally { cleanup(dir); }
  });

  test('索引跨实例持久化: 新实例能看到旧实例存的键', () => {
    const { dir, cache } = mkCache();
    try {
      cache.save('s1', 'k1', [0.5]);
      cache.save('s1', 'k2', [0.7]);
      cache.save('s2', 'k3', { x: 1 });
      // 同一目录新建实例，模拟进程重启
      const cache2 = new KVCachePersistor({ cacheDir: dir });
      assertTrue(cache2.has('s1', 'k1'), '新实例应看到 s1/k1');
      assertTrue(cache2.has('s2', 'k3'), '新实例应看到 s2/k3');
      const st = cache2.getStats();
      assertEqual(st.sessions, 2, `应有 2 个 session，实测 ${st.sessions}`);
      assertEqual(st.totalEntries, 3, `应有 3 条，实测 ${st.totalEntries}`);
    } finally { cleanup(dir); }
  });

  test('save 失败不得抛异常(返回 false)', () => {
    const { dir, cache } = mkCache();
    try {
      // 传入无法 JSON 序列化的值(循环引用)应走 catch 返回 false，而不是抛出
      const circular = {}; circular.self = circular;
      const ok = cache.save('s1', 'bad', circular);
      assertEqual(ok, false, '循环引用应使 save 返回 false 而非抛异常');
    } finally { cleanup(dir); }
  });

  test('淘汰: 超过 maxCacheSize 时最旧的键被逐出', () => {
    const { dir, cache } = mkCache({ maxCacheSize: 3 });
    try {
      for (let i = 0; i < 5; i++) cache.save('s1', `k${i}`, [0.5]);
      const st = cache.getStats();
      assertTrue(st.evictions > 0, `应发生淘汰，实测 evictions=${st.evictions}`);
      assertTrue(st.totalEntries <= 3,
        `条目数不得超过 maxCacheSize(3)，实测 ${st.totalEntries}`);
      // 最新的键应仍在
      assertTrue(cache.has('s1', 'k4'), '最新写入的键应保留');
    } finally { cleanup(dir); }
  });

  test('maxEntrySize 截断: 超长数组被静默切短', () => {
    const { dir, cache } = mkCache({ maxEntrySize: 4 });
    try {
      cache.save('s1', 'long', [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
      const back = cache.load('s1', 'long');
      assertEqual(back.length, 4, `数组应被截断到 maxEntrySize(4)，实测 ${back.length}`);
    } finally { cleanup(dir); }
  });

  test('不同 session 之间互相隔离', () => {
    const { dir, cache } = mkCache();
    try {
      cache.save('sA', 'k', [0.1]);
      cache.save('sB', 'k', [0.9]);
      assertEqual(cache.load('sA', 'k')[0], cache.load('sA', 'k')[0], 'sA 自身一致');
      // 两个 session 同名键不得互相覆盖
      const a = cache.load('sA', 'k');
      const b = cache.load('sB', 'k');
      assertTrue(a !== b && a[0] !== b[0],
        `同名键在不同 session 应有不同值，实测 sA=${a[0]} sB=${b[0]}`);
    } finally { cleanup(dir); }
  });
};
