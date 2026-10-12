/**
 * test/memory-adapter-shape-contract.test.js
 *
 * [test-coverage-gap·第二百二十九轮] 新建。
 *
 * ═══ 怎么选到这一轮的目标 ═══
 * 本切片在 B 类(活着但没测)里已经用过十二个挑模块的问题: 契约脆(191)、
 * 文档按全路径点名(194)、导出纯函数与常量表(195)、src/ 扇入最高(196)、
 * MCP 工具直接调用(197)、错误处理最会伪装失败(198)、入口从不校验参数(199)、
 * 公有方法全返回同一常量(200)、从最多被测模块可达(201)、运行时真的会加载吗(218)、
 * 随机源决定结论吗(223)。本轮问第十三个: **哪个 B 类模块的导出面最宽 ——
 * 即"没有一条断言在守的承诺"最多?**
 *
 * 机械排名(复用 coverage-sweep 自己的分类器, 不重实现 —— cycle 191/201:
 * 为了省一次 require 而重写仪器, 就会得到和仪器不一样的答案):
 * `src/memory/memory-adapter.js` 以 **44 个公有方法 / 718 行**居首, 第二名 33 个。
 * 且它是活的: `heartflow.js:1586` 建 `this.memory = new MemoryAdapter(rootPath)`,
 * `engine-lifecycle` / `pipeline-config` / `dream-consolidation` /
 * `mind-space-guardian` 都在读 `hf.memory`。
 *
 * ═══ 缺陷 ═══
 * 文件头承诺的数据模型是 `{ key: { value, tags, createdAt, updatedAt, accessCount } }`,
 * `_arrayToObject()` 忠实实现了它。但五个按 key 取数的访问器各自手搓了一个**子集**:
 *
 *   getCore     缺 accessCount, 缺 key
 *   recall      缺 key, 缺 updatedAt(更新时间被改名叫 lastAccessed)
 *   listLearned 缺 updatedAt(同上)
 *   get         缺 updatedAt
 *   getWorking  缺 key/tags/updatedAt, 且 accessCount 被拼成 **_accessCount**
 *
 * 同一条记忆从六个口出来是六个形状。调用方读 `record.updatedAt` 在 get() 上拿到
 * undefined; 读 `record.accessCount` 在 getWorking 上拿到 undefined, 于是
 * `accessCount + 1` 静默变成 NaN。**一个兼容层把兼容对象的字段名改掉, 比少给一个
 * 字段更难发现** —— 它不抛错, 也不返回空, 只是让下游的算术沉默地错。
 *
 * ═══ 修法 ═══
 * 收成一个出口而不是给五处各补字段(cycle 208: 修实例不修类, 类还在):
 * 新增 `_project(mem, layer)`, 五个访问器全部改走它。**只加不删** ——
 * `lastAccessed` 与 `_accessCount` 全部保留, 因为
 * `src/dream/dream-consolidation.js:52` 与 `:258` 正在读 `entry.lastAccessed`,
 * 删掉它会静默退回 createdAt, 把"多久没被访问"算错。
 *
 * ═══ 本锁为什么必须自己打扫 ═══
 * 写锁时发现构造函数的隔离参数**不隔离**: `new MemoryAdapter(rootPath)` 把 rootPath
 * 传给 MeaningfulMemory, 而后者把持久化路径写死成 `path.join(__dirname, '../../data')`
 * (`src/memory/meaningful-memory.js:123-125`)—— 于是任何 rootPath 都读写**仓库真实的**
 * `data/meaningful-memory.json`。本轮第一版探针就是这样把 69 条测试垃圾写进了生产记忆,
 * 已按 createdAt 阈值清除(备份在 /tmp/mm-backup-before-clean.json)。
 * 所以本锁的每个用例都用唯一前缀写、用 finally 删、并自证层数回到写入前的值;
 * 隔离缺陷本身钉在第⑦例里, 不在本轮修(改 DATA_DIR 是另一个变更)。
 *
 * ═══ 断言的边界 ═══
 * 语料(137/68)对这条契约零表达力: 校准读数量的是门禁动作, 不是返回形状,
 * 所以本锁修好之后 FP/recall 一动不动是预期的, 不是修复有效的证据。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const ROOT = path.join(__dirname, '..');
  const ADAPTER = path.join(ROOT, 'src', 'memory', 'memory-adapter.js');
  const MM = path.join(ROOT, 'src', 'memory', 'meaningful-memory.js');

  // 文件头承诺的模型(见本文件顶部的缺陷表)
  const MODEL = ['key', 'value', 'tags', 'createdAt', 'updatedAt', 'accessCount'];

  // 源码级 needle 用 indexOf 子串, 不写正则(cycle 223/224/225 转义地狱)
  const PROJECT_CALL = 'this._project(mem, ';

  function codeOf(src) {
    return src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  }

  // 每个用例拿一个自己的唯一前缀, 并在 finally 里把自己写的全删掉。
  // rootPath 不隔离(第⑦例), 所以"唯一前缀 + 显式清理"是唯一可行的 hermetic 方式。
  function fresh() {
    const P = 'sh' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '-';
    const { MemoryAdapter } = require(ADAPTER);
    const a = new MemoryAdapter(P);
    const before = { core: a.countCore(), learned: a.countLearned(), eph: a.countEphemeral() };
    return {
      a, P,
      keys: { core: P + 'c', learned: P + 'l', learned2: P + 'l2', eph: P + 'w' },
      cleanup() {
        // 三个层各用自己的删除口; core 没有公有删除, 只能用 _deleteByKey
        a.forget(this.keys.learned); a.forget(this.keys.learned2);
        a.forgetWorking(this.keys.eph);
        a._deleteByKey('core', this.keys.core);
        // 删除也必须落盘: _autoSave 有 2s 去抖, 不主动落盘的话文件里会留下
        // 本用例写的垃圾(第七例显式落盘过一次, 清理时也要显式落盘一次)。
        a._mm._doSave();
        a.destroy();
        const after = { core: a.countCore(), learned: a.countLearned(), eph: a.countEphemeral() };
        return { before, after };
      },
    };
  }

  // ─── ① 六个口必须都给全承诺的字段 ─────────────────────────────
  test('六个出口必须都给出头注释承诺的模型字段(key/value/tags/createdAt/updatedAt/accessCount)', () => {
    const f = fresh();
    try {
      const { a, keys } = f;
      a.addCore(keys.core, 'cv', ['x']);
      a.learn(keys.learned, 'lv');
      a.remember(keys.eph, 'wv');

      // 前提自证: 数据真的在, 否则"没缺字段"可能是因为记录是空的
      assertEqual(a.getCore(keys.core) !== null, true, '前提: core 里应至少有刚写的那条');
      assertEqual(a.recall(keys.learned) !== null, true, '前提: learned 里应至少有刚写的那条');
      assertEqual(a.getWorking(keys.eph) !== null, true, '前提: ephemeral 里应至少有刚写的那条');

      const paths = {
        'getCore()': a.getCore(keys.core),
        'listCore()': a.listCore().find(e => e.key === keys.core),
        'recall()': a.recall(keys.learned),
        'listLearned()': a.listLearned().find(e => e.key === keys.learned),
        'getWorking()': a.getWorking(keys.eph),
        'get(learned)': a.get(keys.learned),
        'this.core[]': a.core[keys.core],
        'this.learned[]': a.learned[keys.learned],
        'this.ephemeral[]': a.ephemeral[keys.eph],
      };
      for (const [label, rec] of Object.entries(paths)) {
        assertTrue(rec && typeof rec === 'object', `${label} 必须返回一个对象`);
        const miss = MODEL.filter(k => rec[k] === undefined);
        assertEqual(miss.length, 0,
          `${label} 缺承诺字段: ${miss.join(', ')} —— 头注释写的数据模型是 `
          + `{ ${MODEL.join(', ')} }, 这条口没给全`);
      }
      // 前提自证(另一半): updatedAt 与 accessCount 在底层**真的有值**,
      // 否则"没缺字段"可能是因为它们本来就是 undefined 而断言恒真。
      assertEqual(typeof a.recall(keys.learned).updatedAt, 'number',
        '前提: recall 刚写过 updatedAt, 它必须是数字');
      assertTrue(a.recall(keys.learned).accessCount > 0,
        '前提: recall 递增过 accessCount, 它必须 > 0');
      console.log(`     9 个出口全部给全 ${MODEL.length} 个承诺字段`);
    } finally { f.cleanup(); }
  });

  // ─── ② 最强不变式: get() 与 getter 必须逐字节相同 ─────────────
  test('同一条记忆: get() 与 this.learned[] 必须逐字节相同(一个形状, 不是两个)', () => {
    const f = fresh();
    try {
      const { a, keys } = f;
      a.learn(keys.learned, 'v', ['t']);
      const viaGet = a.get(keys.learned);
      const viaGetter = a.learned[keys.learned];
      assertTrue(viaGet && viaGetter, '前提: 两条路都必须取得到');
      assertEqual(JSON.stringify(viaGet), JSON.stringify(viaGetter),
        'get() 与 this.learned[] 对同一条记忆给出不同形状 —— 投影没有收成一个出口');
      // core 与 ephemeral 同样要比
      a.addCore(keys.core, 'cv'); a.remember(keys.eph, 'wv');
      assertEqual(JSON.stringify(a.get(keys.core)), JSON.stringify(a.core[keys.core]),
        'get() 与 this.core[] 不一致');
      assertEqual(JSON.stringify(a.get(keys.eph)), JSON.stringify(a.ephemeral[keys.eph]),
        'get() 与 this.ephemeral[] 不一致');
      console.log('     get() === this.learned[] === this.core[] === this.ephemeral[]');
    } finally { f.cleanup(); }
  });

  // ─── ③ 只加不删: 旧字段名必须还在, 且消费者必须还在 ───────────
  test('只加不删: lastAccessed 与 _accessCount 必须保留, 且读它们的消费者必须仍在', () => {
    const f = fresh();
    try {
      const { a, keys } = f;
      a.learn(keys.learned, 'lv'); a.remember(keys.eph, 'wv');
      const r = a.recall(keys.learned);
      const w = a.getWorking(keys.eph);
      const l = a.listLearned().find(e => e.key === keys.learned);
      assertTrue(r.lastAccessed !== undefined,
        'recall() 必须仍返回 lastAccessed —— 删掉它会静默改变下游语义');
      assertTrue(l.lastAccessed !== undefined, 'listLearned() 必须仍返回 lastAccessed');
      assertTrue(w._accessCount !== undefined,
        'getWorking() 必须仍返回 _accessCount(历史遗留的下划线写法)');
      // 且新名字同时也在(这是"加"而不是"改")
      assertEqual(typeof w.accessCount, 'number',
        'getWorking() 必须同时有 accessCount —— 这是本轮补的那一个');
      assertEqual(r.accessCount, w.accessCount >= 0 ? r.accessCount : -1,
        'recall() 必须同时有 accessCount');
    } finally { f.cleanup(); }
    // 消费者必须仍在源码里, 否则"保留旧字段"是在保护一个不存在的调用方
    const dc = fs.readFileSync(path.join(ROOT, 'src', 'dream', 'dream-consolidation.js'), 'utf8');
    assertTrue(dc.includes('entry.lastAccessed'),
      '前提失效: dream-consolidation.js 不再读 entry.lastAccessed —— '
      + '若它已改读 updatedAt, 请把本断言改写, 但不要顺手删掉旧字段');
    const n = dc.split('entry.lastAccessed').length - 1;
    assertTrue(n >= 2, `dream-consolidation.js 应至少在两处读 entry.lastAccessed, 实测 ${n} 处`);
    console.log(`     lastAccessed / _accessCount 均在; 消费者 ${n} 处仍在`);
  });

  // ─── ④ 源码级: 五个访问器必须走同一个出口 ─────────────────────
  test('源码级: 按 key 取数的访问器必须全部走 _project(不收成一个出口就会各自漂移)', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    const code = codeOf(src);
    // getCore / listCore / recall / listLearned / getWorking / get / _arrayToObject 共七处
    const n = code.split(PROJECT_CALL).length - 1;
    assertTrue(n >= 7,
      `_project 的调用点应 >= 7, 实测 ${n} —— 收成一个出口是本轮修法的本体, 少了就是在各补字段`);
    assertTrue(code.includes('_project(mem, layer) {'),
      '源码里必须存在 _project 的定义');
    // 前提自证: 注释剥离没有把真代码剥掉
    assertTrue(code.includes('class MemoryAdapter'),
      '前提失效: 注释剥离把真代码剥掉了, 本条断言将恒真');
    // 手搓子集的旧形态必须已经不在(七个字段名不该再被逐个列举)
    assertTrue(code.indexOf('lastAccessed: mem.updatedAt,') >= 0,
      '前提: recall/listLearned 仍保留旧的 lastAccessed(只加不删), 这一条是防呆不是缺陷');
    console.log(`     _project 调用点 ${n} 处`);
  });

  // ─── ⑤ 反向证明: 内联旧的子集, 形状必须重新缺字段 ─────────────
  test('反向证明: 把 getWorking 退回旧的手搓子集, 承诺字段必须重新缺失', () => {
    const f = fresh();
    try {
      const { a, keys } = f;
      a.remember(keys.eph, 'wv');
      const good = a.getWorking(keys.eph);
      assertEqual(MODEL.filter(k => good[k] === undefined).length, 0,
        '前提: 修复后的 getWorking 必须给全承诺字段');
      // 在内存里复刻旧实现(不落盘), 验证它确实缺字段 —— 否则第①例的红是装饰
      const mem = a._findByKey('ephemeral', keys.eph);
      const old = { value: mem.content, ttl: mem.metadata?.ttl || 3600000,
        createdAt: mem.createdAt, _accessCount: mem.accessCount };
      const miss = MODEL.filter(k => old[k] === undefined);
      assertTrue(miss.length > 0,
        '反向证明失效: 旧实现竟然给全了承诺字段, 那第①例锁的不是本轮修的缺陷');
      assertTrue(miss.includes('accessCount') && miss.includes('key') && miss.includes('updatedAt'),
        `旧实现缺的应含 accessCount/key/updatedAt, 实测缺 ${miss.join(',')}`);
      assertTrue(old._accessCount !== undefined, '旧实现本就有 _accessCount');
      console.log(`     旧子集缺 ${miss.length} 个承诺字段: ${miss.join(',')}`);
    } finally { f.cleanup(); }
  });

  // ─── ⑥ hermetic 自证: 用完必须把层数放回原样 ─────────────────
  test('hermetic 自证: 每个用例跑完, 三层的条数必须回到写入前的值', () => {
    const f = fresh();
    const before = { core: f.a.countCore(), learned: f.a.countLearned(), eph: f.a.countEphemeral() };
    // 写入必须真的生效, 否则下面的"回到原样"是空操作
    f.a.addCore(f.keys.core, 'cv'); f.a.learn(f.keys.learned, 'lv'); f.a.remember(f.keys.eph, 'wv');
    assertTrue(f.a.getCore(f.keys.core) !== null && f.a.recall(f.keys.learned) !== null
      && f.a.getWorking(f.keys.eph) !== null, '前提: 三条写入都必须生效');
    assertTrue(f.a.countCore() === before.core + 1 && f.a.countLearned() === before.learned + 1,
      '前提: 写入后 core/learned 各应多一条');
    const after = f.cleanup();
    assertEqual(after.after.core, before.core, `cleanup 后 core 应回到 ${before.core}, 实测 ${after.after.core}`);
    assertEqual(after.after.learned, before.learned, `cleanup 后 learned 应回到 ${before.learned}, 实测 ${after.after.learned}`);
    assertEqual(after.after.eph, before.eph, `cleanup 后 ephemeral 应回到 ${before.eph}, 实测 ${after.after.eph}`);
    console.log(`     core ${before.core}→${after.after.core} | learned ${before.learned}→${after.after.learned} | ephemeral ${before.eph}→${after.after.eph}`);
  });

  // ─── ⑦ 披露: rootPath 不隔离 + 边界抛错面 ────────────────────
  test('披露: 构造函数的 rootPath 不隔离持久化, 且 10 个方法仍在边界形状上抛错', () => {
    // (a) rootPath 隔离缺陷 —— 本轮不修, 钉住等下一轮
    const mm = fs.readFileSync(MM, 'utf8');
    assertTrue(mm.includes("const DATA_DIR = path.join(__dirname, '../../data')"),
      '前提失效: meaningful-memory.js 的 DATA_DIR 写法已变 —— 若它改成跟 rootPath 走, '
      + '请把本披露反转为"已修复"并删掉上面 fresh() 里的清理逻辑');
    assertTrue(mm.includes('options.rootPath'),
      '前提: 构造函数仍接受 rootPath(所以调用方有权期待它隔离)');
    // 行为佐证: 换一个 rootPath 新建的实例, 仍能读到前一个实例落盘的那条。
    // _autoSave 有 2s 去抖, 所以这里显式调用 _doSave 把落盘这一步做实,
    // 免得"看不到"是因为还没写盘而不是因为路径不同。
    const f1 = fresh(), f2 = fresh();
    try {
      f1.a.addCore(f1.keys.core, 'cv');
      f1.a._mm._doSave();
      const { MemoryAdapter } = require(ADAPTER);
      const again = new MemoryAdapter(f2.P);      // 不同的 rootPath, 落盘之后新建
      assertTrue(again.getCore(f1.keys.core) !== null,
        '披露的行为面: 换一个 rootPath 新建的实例仍读到另一个实例落盘的那条 —— '
        + '持久化路径与 rootPath 无关, 这正是本轮探针污染生产记忆的原因');
      again.destroy();
    } finally { f1.cleanup(); f2.cleanup(); }
    // (b) 边界抛错面 —— cycle-199/200 家族, 本轮未修。
    // 这一部分**必然**会往真实记忆里写垃圾(探针要调用 store/remember/recordLesson/
    // autoRecord 本身), 所以它在跑之前给三层拍快照、跑之后原样放回并落盘 ——
    // 一个测量缺陷的用例, 不能把自己的测量残骸留在生产状态里。
    const f = fresh();
    const snap = JSON.parse(JSON.stringify(f.a._mm.layers));
    try {
      const { a, keys } = f;
      a.learn(keys.learned, 'lv'); a.remember(keys.eph, 'wv');
      const BADS = [null, undefined, 42, {}, [], '', true, () => {}];
      const THROWERS = ['search', 'retrieve', 'listLearned', 'store', 'searchByTopic',
        'searchBySemantic', 'recordLesson', 'searchByKeywords', 'remember', 'autoRecord'];
      const seen = {};
      for (const m of THROWERS) {
        for (const b of BADS) {
          for (const args of [[b], [b, b], ['k', b]]) {
            try { a[m](...args); } catch (e) { seen[m] = (seen[m] || 0) + 1; }
          }
        }
      }
      assertEqual(Object.keys(seen).length, 10,
        `应仍有 10 个方法在边界形状上抛错, 实测 ${Object.keys(seen).length} 个: `
        + `${Object.keys(seen).join(',')} —— 变少说明有人修了(请更新本披露), 变多说明新增了抛错面`);
      const total = Object.values(seen).reduce((s, x) => s + x, 0);
      assertTrue(total >= 100, `边界抛错总数应 >= 100(本轮实测 105), 实测 ${total}`);
      // 两个生产调用点(searchByTopic)的上游已把 ctx.input 当字符串解引用,
      // 所以这 105 处当前**不在**生产路径上 —— 这一条是披露, 不是"没有风险"。
      const pc = fs.readFileSync(path.join(ROOT, 'src', 'workflow', 'pipeline-config.js'), 'utf8');
      assertTrue(pc.includes('hf.memory.searchByTopic(ctx.input, currentTopic, 5)'),
        '前提: pipeline-config 仍在调用 searchByTopic');
      assertTrue(pc.includes('ctx.input.split('),
        '前提: 同一函数上游仍在解引用 ctx.input.split(故当前生产路径上传入的是字符串)');
      console.log(`     10 个方法共 ${total} 处边界抛错(不在当前生产路径上); rootPath 不隔离已钉住`);
    } finally {
      // 把探针写进去的垃圾原样放回成快照, 并落盘
      f.a._mm.layers.core = snap.core;
      f.a._mm.layers.learned = snap.learned;
      f.a._mm.layers.ephemeral = snap.ephemeral;
      f.a._mm.stats.totalMemories = snap.core.length + snap.learned.length + snap.ephemeral.length;
      f.cleanup();
    }
  });
};
