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

  test('loads 必须被计数，hitRate 必须是真实命中率且是数字(本轮修复)', () => {
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
      assertEqual(s.hitRate, 0.33,
        `hitRate 应等于 hits/(hits+misses)=0.33，实测 ${s.hitRate}(修复前是 1.00)`);
      // [第三十一轮] 本行原先断言的是字符串 '0.33'，于是把 hitRate 的类型不一致
      // 一起锁死了: getStats() 里 sessions/saves/loads/hits/misses/evictions 全是数字，
      // 唯独 hitRate 是 toFixed(2) 出来的字符串。后果实测:
      //   typeof stats.hitRate === 'number'      → false
      //   stats.hitRate.toFixed(2)                → TypeError
      //   stats.hitRate > 0.5 (恰好 0.50 时)      → false(靠隐式转型碰巧对)
      // 而 src/reasoning/decision-engine.js 的 sdtAnalyze 文档约定正是 @param {number}。
      // 已确认 src/ test/ scripts/ 无任何下游消费者，故改为数字。
      assertEqual(typeof s.hitRate, 'number',
        `hitRate 必须是数字，实测 ${typeof s.hitRate}(第三十一轮前是 string)`);
    } finally { cleanup(dir); }
  });

  // ══════════════════════════════════════════════════════════════════
  // [第三十一轮] 路径穿越: 四个公开方法把 sessionId/key 直接 path.join
  // 进路径，无任何净化。实测(修前):
  //   save('../escape','k',v) → <cacheDir 父目录>/escape/k.kv  ← 逃到外面
  //   save('..','k',v)        → <cacheDir 父目录>/k.kv         ← 逃到外面
  //   save('a/b','k',v)       → cacheDir/a/b/k.kv(仍在内部但层级不可控)
  //   save('.','k',v)         → cacheDir/k.kv
  //   save('/tmp/x','k',v)    → path.join 归一化掉前导斜杠，反被 containment
  // 真正的危险来自 `..` 前缀: 持久层因此成为一个**任意目录写入原语**。
  // 而 sessionId/key 不一定可信 —— 可来自 MCP 工具参数或调用方输入。
  // 修法: _safeSegment() 只允许 [A-Za-z0-9._-]，显式拒绝 '.'/'..' 与分隔符。
  // ══════════════════════════════════════════════════════════════════

  /** 统计某个目录树下(含 cacheDir 之外)有多少 .kv 文件 */
  const countKvOutside = (base, cacheDir) => {
    let inside = 0, outside = 0;
    const walk = (d, depth) => {
      if (depth > 4) return;
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith('.kv')) {
          if (path.relative(cacheDir, p).startsWith('..')) outside++;
          else inside++;
        }
      }
    };
    walk(base, 0);
    return { inside, outside };
  };

  test('路径穿越: "../" 前缀的 sessionId 不得写出 cacheDir(本轮修复)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-kv-trav-'));
    const cacheDir = path.join(base, 'cache');
    try {
      const cache = new KVCachePersistor({ cacheDir });
      for (const sid of ['../escape', '../../escape2', '..']) {
        const ok = cache.save(sid, 'k', { v: 1 });
        assertEqual(ok, false,
          `save('${sid}','k',v) 应被拒绝返回 false，实测 ${ok}(修前为 true 并写出 cacheDir)`);
        assertTrue(!cache.has(sid, 'k'), `has('${sid}','k') 应为 false`);
        assertEqual(cache.load(sid, 'k'), null, `load('${sid}','k') 应返回 null`);
        assertEqual(cache.delete(sid, 'k'), false, `delete('${sid}','k') 应返回 false`);
      }
      const { outside } = countKvOutside(base, cacheDir);
      assertEqual(outside, 0, `cacheDir 之外不得出现任何 .kv 文件，实测 ${outside} 个(修前为 2 个)`);
    } finally { cleanup(base); }
  });

  test('路径穿越: 含路径分隔符的 key 同样被拒绝', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-kv-trav2-'));
    const cacheDir = path.join(base, 'cache');
    try {
      const cache = new KVCachePersistor({ cacheDir });
      // 只列**实测确有危害**的: 含路径分隔符 -> 可写出 cacheDir 之外/改变层级
      for (const k of ['a/b', 'a\\b', '.', '..', '../../etc/passwd']) {
        const ok = cache.save('good', k, { v: 1 });
        assertEqual(ok, false, `save('good',${JSON.stringify(k)},v) 应被拒绝，实测 ${ok}`);
        assertEqual(cache.load('good', k), null, `load('good',${JSON.stringify(k)}) 应返回 null`);
        assertEqual(cache.delete('good', k), false, `delete('good',${JSON.stringify(k)}) 应返回 false`);
      }
      assertTrue(!cache.has('good', 'a/b'), 'has 对含分隔符的 key 应为 false');
      const { outside } = countKvOutside(base, cacheDir);
      assertEqual(outside, 0, `cacheDir 之外不得有文件，实测 ${outside}`);
    } finally { cleanup(base); }
  });

  test('合法 sessionId/key 不受净化影响(反向控制)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-kv-ok-'));
    const cacheDir = path.join(base, 'cache');
    try {
      const cache = new KVCachePersistor({ cacheDir });
      // 这些形状在现实里都合法，净化后必须照旧工作
      for (const sid of ['s1', 'feishu-1790474303619', 'a.b-c_d', 'session_2']) {
        assertTrue(cache.save(sid, 'k', { v: 1 }), `save('${sid}','k') 应成功`);
        assertTrue(cache.has(sid, 'k'), `has('${sid}','k') 应为 true`);
        assertEqual(JSON.stringify(cache.load(sid, 'k')), JSON.stringify({ v: 1 }),
          `load('${sid}','k') 应无损返回`);
      }
      for (const k of ['k1', 'k.v', 'a-b_c', '0']) {
        assertTrue(cache.save('s1', k, { v: 2 }), `save('s1',${JSON.stringify(k)}) 应成功`);
      }
    } finally { cleanup(base); }
  });

  test('getStats() 里除 version 外所有字段都是数字(本轮修复)', () => {
    const { dir, cache } = mkCache();
    try {
      cache.save('s1', 'k', [0.5]);
      cache.load('s1', 'k'); cache.load('s1', 'miss');
      const s = cache.getStats();
      // version 本来就是字符串(VERSION 单一大源)，其余必须是数字
      const numeric = ['sessions', 'totalEntries', 'totalBytes', 'hitRate',
        'saves', 'loads', 'hits', 'misses', 'evictions'];
      for (const k of numeric) {
        assertEqual(typeof s[k], 'number',
          `getStats().${k} 必须是数字，实测 ${typeof s[k]}(第三十一轮前 hitRate 是 string)`);
      }
      assertEqual(typeof s.version, 'string', 'version 保持字符串');
      // hitRate 数值语义必须仍然正确(不被类型修复破坏)
      assertEqual(s.hitRate, 0.5, `1 命中 1 未命中时 hitRate 应为 0.5，实测 ${s.hitRate}`);
      assertTrue(s.hitRate > 0.4, `hitRate 必须能参与数值比较，实测 ${s.hitRate} > 0.4 => ${s.hitRate > 0.4}`);
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
