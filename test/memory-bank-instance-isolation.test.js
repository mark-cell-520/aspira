/**
 * test/memory-bank-instance-isolation.test.js — memory-bank 的实例路径隔离
 *
 * [test-coverage-gap·第一百三十六轮] 新建。
 *
 * ═══ 背景: 构造选项被无视, 所有实例共写一个生产文件 ═══
 * coverage-sweep 的 B 类(活着但没测)挑中 src/memory/memory-bank.js
 * (1193 行)。冒烟探测(在 os.tmpdir() 里构造第一个实例)立刻抓到:
 * **实例读到了不属于它的数据** —— 5 条记忆 + 数天前的 session, 而
 * tmpdir 是空的。根因: `_getBankPath()` 直接返回模块级常量
 * `BANK_PATH = <repo>/data/memory-bank.json`, **构造函数的
 * options.dataDir / options.bankPath 从未被读取**。
 *
 * 三个实测后果:
 * ① 隔离失效: 任何 new MemoryBank({dataDir: tmp}) 都读写同一个生产
 *    文件 —— 测试与生产数据互相污染(cycle 28/31 的同族: 那次是
 *    kv-cache 的路径逃逸, 这次是路径不隔离);
 * ② 测试若 save 会写坏生产 memory-bank.json;
 * ③ 多实例并发 save 互相覆写。
 *
 * ═══ 修法 ═══
 * 构造时定实例路径: options.bankPath > options.dataDir 拼接 > 全局
 * BANK_PATH(默认)。生产调用方(mcp-server.js:4167 传 silent/rootPath、
 * heartflow.js:1593 传 memory)**都不传 dataDir** → 行为逐字节不变。
 *
 * ═══ 锁什么 ═══
 * ① 隔离读: 两个不同 dataDir 的实例互不见对方数据;
 * ② 隔离写: save 落在自己的 dataDir, 不碰仓库 data/;
 * ③ 默认不破坏生产: 不传 dataDir 时路径仍是全局 BANK_PATH;
 * ④ 反向锚点: 源码含实例路径与 dataDir 分支(删了它①②必回退)。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'memory', 'memory-bank.js');

module.exports = function ({ test, assertEqual, assertTrue }) {

  function mkBank(dir) {
    delete require.cache[require.resolve(SRC)];
    const { MemoryBank } = require(SRC);
    return new MemoryBank({ dataDir: dir, persist: false, silent: true });
  }

  test('隔离读: 两个 dataDir 的实例互不见对方数据', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-b-'));
    try {
      const a = mkBank(dirA);
      const b = mkBank(dirB);
      const s = a.startSession('session-a');
      a.deposit('unique-alpha-content-xyz', { sessionId: s });
      // A 里有 1 条; B 必须空(修复前 B 会读到仓库生产文件的数据)
      assertEqual(a.getStats().totalMemories, 1, `A 应有 1 条, 实测 ${a.getStats().totalMemories}`);
      assertEqual(b.getStats().totalMemories, 0, `B 必须为空, 实测 ${b.getStats().totalMemories} —— 又读到了别的实例/生产数据`);
      assertEqual(b.recall('unique-alpha-content-xyz', 10, { sessionId: s }).length, 0,
        'B recall A 的数据必须为空(sessionId 过滤 + 数据隔离双重保证)');
      a.destroy(); b.destroy();
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('隔离写: save 落在自己的 dataDir, 不碰仓库 data/', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-w-'));
    try {
      const mb = mkBank(dir);
      const s = mb.startSession('s-write');
      mb.deposit('write-isolation-probe', { sessionId: s });
      await mb.save();
      const own = path.join(dir, 'memory-bank.json');
      assertTrue(fs.existsSync(own), `save 必须落在 dataDir 下: ${own}`);
      const prod = path.join(ROOT, 'data', 'memory-bank.json');
      // 不断言 prod 不存在(生产文件本来就在), 断言它的 mtime 未被本次写推动
      const before = fs.existsSync(prod) ? fs.statSync(prod).mtimeMs : 0;
      const mb2 = mkBank(dir);
      mb2.startSession('s2');
      mb2.deposit('second', { sessionId: 's2' });
      await mb2.save();
      const after = fs.existsSync(prod) ? fs.statSync(prod).mtimeMs : 0;
      assertEqual(after, before, '第二个实例的 save 不得推动生产文件的 mtime(写隔离)');
      mb.destroy(); mb2.destroy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('默认不破坏生产: 不传 dataDir 时路径仍是全局 BANK_PATH', () => {
    delete require.cache[require.resolve(SRC)];
    const { MemoryBank } = require(SRC);
    const mb = new MemoryBank({ silent: true }); // 生产形态(mcp-server 传 silent/rootPath)
    const globalPath = path.join(ROOT, 'data', 'memory-bank.json');
    assertEqual(mb._getBankPath(), globalPath,
      `不传 dataDir 的实例必须仍指向全局 BANK_PATH(${globalPath}), 实测 ${mb._getBankPath()}`);
    // bankPath 显式优先于 dataDir
    const mb2 = new MemoryBank({ bankPath: '/tmp/explicit-bank.json', dataDir: '/tmp/ignored' });
    assertEqual(mb2._getBankPath(), '/tmp/explicit-bank.json', 'bankPath 显式优先');
  });

  test('源级: 实例路径与 dataDir 分支必须存在(删了它①②回退)', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    assertTrue(/this\._bankPath/.test(src), '构造必须定实例级 _bankPath');
    assertTrue(/options\.dataDir/.test(src), '必须认 options.dataDir');
    assertTrue(/options\.bankPath/.test(src), '必须认 options.bankPath');
    assertTrue(/return this\._bankPath/.test(src), '_getBankPath 必须返回实例路径(而不是模块常量)');
  });
};
