/**
 * test/knowledge-graph-contract.test.js — knowledge-graph 的对外契约必须兑现
 *
 * ═══ 第一百九十六轮发现的缺陷 ═══
 * 切片角度: 前几轮依次用过「契约清晰」「被文档完整路径承诺」「导出纯函数与
 * 常量表」三种选模块标准, 本轮用第四种 —— **src 扇入最高**。`coverage-sweep`
 * 实测 B 类(活着但没测)97 个, 按被 src/ 其他模块 require 的次数排序,
 * `src/memory/knowledge-graph.js` 以 6 个消费者居首, 且**零测试**。
 *
 * 按 cycle 191 立下的规矩**调用它**(不是 require 它), 一次探针找到三个缺陷:
 *
 * ① `findPath()` **永远返回 []**。命中目标时它写的是
 *      path.push({ entity: nextEntity, ... });
 *      return;                    // ← 只从 forEach 回调返回
 *    那个 return 退出的是箭头函数, 不是 findPath。BFS 遍历完整张图, 走到
 *    函数末尾的 `return []`。而 `aspira_knowledge_graph` 的 `path` action
 *    正是调它(mcp-server.js:3502) —— 对外承诺"找路径", 实际永远说找不到:
 *    调用成功、不抛错、结构合法、内容已死。附带第二处: 命中时 `triples: [t]`
 *    只装那一条边, 不是沿途全部三元组。
 *
 * ② `getStats()` 不报**当前存量**。只有 triplesAdded(累计, 含被 LRU 淘汰的)
 *    与三个索引大小。于是同一个对象上三个数互相矛盾而无一解释:
 *      save() → count 250 · getStats() → triplesAdded 250 · query({}) → 100
 *    (query 默认 limit=100)。调用方无法判断"我看到的 100 条是不是全部"。
 *
 * ③ `constructor(dataDir)` 不校验类型。唯一 src 调用方写的是
 *    `new KnowledgeGraph({ silent: true })`, 于是 dataDir 变成对象, 一路带到
 *    save()/load() 的 `path.join(this.dataDir, ...)` →
 *    `TypeError: The "path" argument must be of type string`。
 *    "不传 filePath 就存到默认目录"这条路对唯一调用方是死的, 且死法是一句
 *    读不懂的底层错误。
 *
 * ═══ 已测量但本轮不修(需要产品判断, 按铁律 2 只披露) ═══
 * ④ `aspira_knowledge_graph` 的 handler **每次调用都新建实例**
 *    (mcp-server.js:3477)。于是 `add` 写进的边随调用结束消失, `query`/
 *    `search`/`related`/`path` 永远在一张空图上跑。修它要先决定实例该活多久
 *    (进程单例 / 按 session / 落盘), 这是产品判断, 不在本轮的一个人函数体里。
 *    本测试把实测钉住: 两个连续 handler 调用之间数据不共享。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SRC = path.join(ROOT, 'src', 'memory', 'knowledge-graph.js');
  const { KnowledgeGraph } = require(SRC);

  // ─── ① findPath ────────────────────────────────────────────────────

  test('findPath 必须真的找到路径(修复前永远返回 [])', () => {
    const kg = new KnowledgeGraph();
    kg.addEdge('A', '到', 'B');
    kg.addEdge('B', '到', 'C');
    const p = kg.findPath('A', 'C');
    assertTrue(p.length > 0, 'A→B→C 明明有路径, findPath 却返回 []');
    assertEqual(p[0].entity, 'A', '路径应从 from 开始');
    assertEqual(p[p.length - 1].entity, 'C', '路径应到 to 结束');
    assertEqual(p.map(n => n.entity).join('->'), 'A->B->C', '路径节点序列');
  });

  test('findPath 必须累积沿途的所有三元组(修复前只装命中那一条)', () => {
    const kg = new KnowledgeGraph();
    kg.addEdge('A', '到', 'B');
    kg.addEdge('B', '到', 'C');
    const p = kg.findPath('A', 'C');
    const last = p[p.length - 1];
    assertEqual(last.triples.length, 2,
      'A→C 经过 2 条边, 末节点应累积 2 个三元组, 实测 ' + last.triples.length);
    assertEqual(last.triples[0].predicate, '到', '第 1 条边');
    assertEqual(last.triples[1].object, 'C', '第 2 条边');
  });

  test('findPath 的三类"查不到"仍须返回 [](不许为修漏报而什么都放行)', () => {
    const kg = new KnowledgeGraph();
    kg.addEdge('A', '到', 'B');
    assertEqual(kg.findPath('A', '不存在的实体').length, 0, '目标不存在应返回 []');
    assertEqual(kg.findPath('不存在的实体', 'A').length, 0, '起点不存在应返回 []');
    assertEqual(kg.findPath('A', 'A').length, 0, 'from===to 应返回 []');
    assertEqual(kg.findPath('', '').length, 0, '空参数应返回 []');
    assertEqual(kg.findPath(null, null).length, 0, 'null 应返回 []');
  });

  test('findPath 尊重 maxDepth(不许为找到路径而无限深)', () => {
    const kg = new KnowledgeGraph();
    kg.addEdge('A', '到', 'B');
    kg.addEdge('B', '到', 'C');
    kg.addEdge('C', '到', 'D');
    assertEqual(kg.findPath('A', 'D', 4).length, 4, 'maxDepth=4 应找到 4 节点路径');
    assertEqual(kg.findPath('A', 'D', 2).length, 0, 'maxDepth=2 不够走 3 步, 应返回 []');
  });

  // ─── ② getStats 的当前存量 ─────────────────────────────────────────

  test('getStats 必须报当前存量 triples, 让 query 的 limit 截断可被发现', () => {
    const kg = new KnowledgeGraph();
    for (let i = 0; i < 250; i++) kg.addEdge('S' + i, 'P', 'O' + i);
    const s = kg.getStats();
    assertEqual(s.triples, 250, 'getStats().triples 应报当前存量');
    assertEqual(s.triplesAdded, 250, '累计添加数应仍在(两者是有意分工, 不合并)');
    // query 默认 limit=100 → 结果长度 < triples 即说明被截断
    const q = kg.query({});
    assertEqual(q.length, 100, 'query 默认 limit 应仍为 100(不改既有分页语义)');
    assertTrue(q.length < s.triples,
      '调用方必须能靠 triples 发现截断: query 返回 ' + q.length + ' 而存量 ' + s.triples);
    // 显式放大 limit 应能取回全部, 且数量与 triples 一致
    assertEqual(kg.query({ limit: 1000 }).length, s.triples,
      'limit 放大后应取回全部, 且等于 getStats().triples');
  });

  test('LRU 淘汰后 triples 与 triplesAdded 必须分离(存量≠吞吐)', () => {
    const kg = new KnowledgeGraph();
    for (let i = 0; i < 5200; i++) kg.addEdge('S' + i, 'P', 'O' + i);   // 容量 5000
    const s = kg.getStats();
    assertEqual(s.triples, 5000, '超过 LRU 容量 5000 后存量应为 5000');
    assertEqual(s.triplesAdded, 5200, '累计吞吐应为 5200');
    assertTrue(s.triples < s.triplesAdded, '淘汰发生后两者必须分离, 否则调用方无法察觉');
  });

  // ─── ③ dataDir 类型归一化 ──────────────────────────────────────────

  test('dataDir 非 string 必须归一化为 null, 而不是把对象带给 path.join', () => {
    // 复现唯一 src 调用方的写法: new KnowledgeGraph({ silent: true })
    const kg = new KnowledgeGraph({ silent: true });
    assertEqual(kg.dataDir, null, '对象参数应被归一化为 null');
    let threw = null;
    try { kg.save(); } catch (e) { threw = e.message; }
    assertTrue(threw !== null, 'dataDir 为 null 时 save() 应给出领域错误');
    assertTrue(String(threw).indexOf('path') < 0,
      '错误不该再是 path.join 的底层 TypeError, 实测: ' + threw);
    assertTrue(String(threw).indexOf('filePath') >= 0,
      '错误应点名 filePath/dataDir, 实测: ' + threw);
  });

  test('合法 string dataDir 与无参/显式 null 都不被破坏', () => {
    assertEqual(new KnowledgeGraph('/tmp/kgdir').dataDir, '/tmp/kgdir', '合法 string 应生效');
    assertEqual(new KnowledgeGraph().dataDir, null, '无参应为 null');
    assertEqual(new KnowledgeGraph(null).dataDir, null, '显式 null 应为 null');
    assertEqual(new KnowledgeGraph('').dataDir, null, '空串应归一化为 null');
  });

  // ─── ④ 已披露、本轮不修: handler 每次新建实例 ──────────────────────

  test('已披露缺陷(钉住不改善): MCP handler 每次调用新建实例, 数据不跨调用', () => {
    const mcp = require(path.join(ROOT, 'src', 'mcp-server.js'));
    const H = mcp.HANDLERS;
    return (async () => {
      const add = await H.aspira_knowledge_graph({ action: 'add', query: '新愿,拥有,三层记忆' });
      assertTrue(!add.error, 'add 本身应成功: ' + JSON.stringify(add.error || ''));
      // 同一个 handler 再查一次 —— 实例是新建的, 上面那条边已经不在了
      const q = await H.aspira_knowledge_graph({ action: 'query', query: '新愿' });
      assertTrue(Array.isArray(q.result), 'query 应返回数组');
      assertEqual(q.result.length, 0,
        '实测: 上一次 add 的三元组在新调用里查不到 —— handler 每次 new 实例。' +
        '这是已披露缺陷(修它需先决定实例生命周期, 属产品判断), 本断言钉住现状;' +
        '若将来修好了, 请把本断言反转为"应能查到", 并同步更新文件头注释④');
    })();
  });

  test('adapter 层必须兑现: 一个永远返回空的函数会掩盖调用方的形状错配', () => {
    // 本轮最值得记的一条。knowledge-graph-adapter.js:87 原来写
    //   paths.map(p => p.map(t => ...))     // 期望 Array<Array<triple>>
    // 而底层 findPath 当时永远返回 [] —— 这行从第一次执行起就在空数组上跑,
    // 形状错配**从未被触发**。修好 findPath 后它立刻炸出
    //   p.map is not a function
    // 所以这里锁的不只是 adapter 能用, 而是"修好底层不会暴露新的形状错配"。
    const { KnowledgeGraphAdapter } = require(path.join(ROOT, 'src', 'knowledge', 'knowledge-graph-adapter.js'));
    const a = new KnowledgeGraphAdapter({ dataDir: path.join(os.tmpdir(), 'kg-adapter-196') });
    a.addDomainEdge('math', 'physics', 'relates', 0.8);
    a.addDomainEdge('physics', 'biology', 'relates', 0.7);

    const p1 = a.findDomainPath('math', 'physics');
    assertTrue(Array.isArray(p1), 'findDomainPath 应返回数组');
    assertEqual(p1.length, 1, 'math→physics 有 1 条路径');
    assertEqual(p1[0].length, 1, '该路径经过 1 条边');
    assertEqual(p1[0][0].linkType, 'relates', '边的 linkType');
    assertEqual(p1[0][0].subject, 'domain:math', '边的 subject');

    const p2 = a.findDomainPath('math', 'biology');
    assertEqual(p2.length, 1, 'math→biology 有 1 条路径(经 physics)');
    assertEqual(p2[0].length, 2, '该路径经过 2 条边');

    assertEqual(a.findDomainPath('math', '不存在').length, 0, '查不到应返回空数组');
    // getStats 仍含 adapter 消费的字段
    assertTrue(typeof a.getStats().triplesAdded === 'number', 'adapter.getStats 应含 triplesAdded');
  });
};
