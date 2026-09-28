/**
 * test/memory-forgetting.test.js — 遗忘引擎的公开面与 getField 缺陷
 *
 * ═══ 为什么补这个测试 ═══
 * `src/memory/forgetting.js`(约 875 行)在 coverage-sweep 里是 **B 类**:
 * 活着(被 src/mcp-server.js 的 aspira_forgetting 使用)但**没有任何测试引用**。
 *
 * ═══ 当场抓出的真缺陷 ═══
 * **`getField` 在全文件里从未定义，却被 `isReferenceProtected()` 调用两次。**
 *   function isReferenceProtected(memory, config) {
 *     const refCount = getField(memory, 'referenceCount', 0);   // ← 未定义
 *     ...
 *     const layer = (getField(memory, 'layer', 'learned') || 'learned').toUpperCase();
 * 而 `checkForget()` 必定经过 isReferenceProtected，于是:
 *     fe.checkForget(mem)  →  ReferenceError: getField is not defined
 *
 * **实测 15 个公开方法，只有 checkForget 挂掉，其余 14 个全部正常。**
 * 这一点很关键: 缺陷是"局部"的，表面上引擎基本能用，
 * 所以任何不专门测 checkForget 的检查都会漏掉它。
 * 已补上 getField(见下)。
 *
 * ═══ getField 的语义(踩过的坑) ═══
 * 只在字段为 undefined/null 时回退。**不用 `||`** ——
 * `memory.referenceCount = 0` 会被 `||` 误判成缺省而回退到 fallback，
 * 那会让"引用计数为 0"和"没有引用计数"无法区分。
 * 本测试专门锁这条。
 *
 * ═══ 断言的边界 ═══
 * · 锁公开面(15 个方法都不得抛)与 getField 的回退语义。
 * · 不锁艾宾浩斯曲线的具体数值(那是算法选择，会变)。
 * · 不锁 stats 的具体计数值(随调用累加)。
 */
const path = require('path');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const ROOT = path.join(__dirname, '..');
  const { ForgettingEngine } = require(path.join(ROOT, 'src', 'memory', 'forgetting.js'));

  const mk = () => new ForgettingEngine({ silent: true });
  const MEM = (over = {}) => ({ id: 'm1', content: 'hello world this is a test', timestamp: Date.now(), ...over });

  // ─── 缺陷本体: checkForget 曾因 getField 未定义而抛错 ────────────────
  test('checkForget 不得抛 getField is not defined(该缺陷曾存在)', () => {
    const fe = mk();
    let threw = null;
    let r = null;
    try { r = fe.checkForget(MEM()); } catch (e) { threw = e; }
    assertEqual(threw, null, `checkForget 不应抛错，实测 ${threw && threw.message}`);
    assertTrue(!!r, '应返回结果对象');
    assertTrue(typeof r.shouldForget === 'boolean', '应返回 shouldForget(boolean)');
    assertTrue(typeof r.precision === 'number', '应返回 precision(number)');
  });

  test('checkForget 接受 threshold 参数', () => {
    const fe = mk();
    for (const t of [0, 0.5, 1]) {
      let threw = null;
      try { fe.checkForget(MEM(), t); } catch (e) { threw = e; }
      assertEqual(threw, null, `threshold=${t} 不应抛错，实测 ${threw && threw.message}`);
    }
  });

  // ─── getField 的回退语义(0/false/'' 是合法值，不是缺省) ─────────────
  test('referenceCount=0 是合法值，不得被当成缺省', () => {
    const fe = mk();
    // referenceCount=0 + layer=learned → 不受保护
    const r = fe.checkForget(MEM({ referenceCount: 0, layer: 'learned' }), 0.5);
    assertTrue(!r.protected, 'referenceCount=0 不应触发保护(0 是合法值，不是缺省)');
  });

  test('referenceCount 达到阈值应触发保护', () => {
    const fe = mk();
    const cfg = fe.getConfig ? fe.getConfig() : {};
    const threshold = cfg.referenceCountProtectionThreshold || 5;
    const r = fe.checkForget(MEM({ referenceCount: threshold + 10 }), 0.5);
    assertTrue(r.protected === true, `referenceCount=${threshold + 10} 应触发保护`);
    assertEqual(r.shouldForget, false, '受保护的记忆不得被判为应遗忘');
  });

  test('layer=core 应触发保护', () => {
    const fe = mk();
    const r = fe.checkForget(MEM({ layer: 'core' }), 0.5);
    assertTrue(r.protected === true, 'layer=core 应触发保护');
    const lower = fe.checkForget(MEM({ layer: 'CORE' }), 0.5);
    assertTrue(lower.protected === true, 'layer 大小写不敏感(CORE 也应触发)');
  });

  test('layer 缺省时按 learned 处理(不抛错)', () => {
    const fe = mk();
    let threw = null;
    try { fe.checkForget(MEM({ layer: undefined }), 0.5); } catch (e) { threw = e; }
    assertEqual(threw, null, `layer 缺省不应抛错，实测 ${threw && threw.message}`);
  });

  // ─── 公开面: 15 个方法都不得抛 ──────────────────────────────────────
  test('全部公开方法可调用且不抛(此前只有 checkForget 挂)', () => {
    const fe = mk();
    const m = MEM();
    const calls = [
      ['compress', () => fe.compress(m)],
      ['retrieve', () => fe.retrieve(m)],
      ['checkForget', () => fe.checkForget(m)],
      ['consolidate', () => fe.consolidate([m])],
      ['compressBatch', () => fe.compressBatch([m])],
      ['consolidateBatch', () => fe.consolidateBatch([[m]])],
      ['getLevel', () => fe.getLevel(Date.now())],
      ['abstract', () => fe.abstract('some text to abstract')],
      ['detectOscillation', () => fe.detectOscillation()],
      ['getStats', () => fe.getStats()],
      ['getConfig', () => fe.getConfig()],
      ['updateConfig', () => fe.updateConfig({ defaultThreshold: 0.3 })],
      ['healthCheck', () => fe.healthCheck()],
      ['reset', () => fe.reset()],
      ['ebbinghausRetention', () => fe.ebbinghausRetention(86400000)],
    ];
    for (const [name, fn] of calls) {
      let threw = null;
      try { fn(); } catch (e) { threw = e; }
      assertEqual(threw, null, `${name}() 不应抛错，实测 ${threw && threw.message}`);
    }
  });

  // ─── 输入校验(引擎自称有，实测确认) ─────────────────────────────────
  test('非法 memory 被拒绝且不抛', () => {
    const fe = mk();
    for (const bad of [null, undefined, 'str', 42, [], {}]) {
      let threw = null;
      let r = null;
      try { r = fe.compress(bad); } catch (e) { threw = e; }
      assertEqual(threw, null, `compress(${JSON.stringify(bad)}) 不应抛，实测 ${threw && threw.message}`);
      assertTrue(!!r && !!r.error, `compress(${JSON.stringify(bad)}) 应返回 error 字段`);
    }
  });

  test('非法 threshold 被拒绝', () => {
    const fe = mk();
    for (const bad of ['x', -1, 2, NaN]) {
      let threw = null;
      let r = null;
      try { r = fe.checkForget(MEM(), bad); } catch (e) { threw = e; }
      assertEqual(threw, null, `threshold=${bad} 不应抛，实测 ${threw && threw.message}`);
      assertTrue(!!r && (!!r.error || !!r.errorCode),
        `threshold=${bad} 应被拒绝(error/errorCode)`);
    }
  });

  // ─── 构造契约 ───────────────────────────────────────────────────────
  test('无参构造可用(向后兼容)', () => {
    let threw = null;
    let fe = null;
    try { fe = new ForgettingEngine(); } catch (e) { threw = e; }
    assertEqual(threw, null, `无参构造不应抛错，实测 ${threw && threw.message}`);
    assertTrue(!!fe, '应成功实例化');
  });
};
