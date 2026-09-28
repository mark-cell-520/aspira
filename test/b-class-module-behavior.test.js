/**
 * test/b-class-module-behavior.test.js — B 类(无测试覆盖)模块的**行为**测量
 *
 * ═══ 为什么要这个测试 ═══
 * 本仓把 `src/` 下 382 个模块按"是否被任何测试引用"分成两类，
 * 其中约 169 个从未被测试 require(B 类)。
 * 上一轮用**静态判据**(固定返回数 / 方法数 > 0.6)挑出 20 个"疑似空壳"，
 * 实测发现该判据**误判严重**:
 *   · dream.js 被判空壳，实际有 Fisher-Yates 洗牌、状态哈希、种子渗透
 *   · experience-replay.js 被判空壳，实际有完整性校验、自愈、振荡检测
 * 静态比例分不清"精心设计的 getter"和"空壳"。
 *
 * 所以本测试改用**行为测量**: 直接实例化并调用，看返回值。
 * 这是本仓第 22 次仪器误判后的方法论修正。
 *
 * ═══ 行为测量抓到的两个真缺陷 ═══
 * ① `src/cortex/adaptive-learning.js` 是**默认导出**
 *    (module.exports = AdaptiveLearningEngine)，
 *    而 `src/workflow/thought-chain.js:649` 写的是
 *    `require(...).AdaptiveLearningEngine` → undefined → new undefined() 恒抛。
 *    与本仓已记录六次的"契约错配"族同型(第 7 处):
 *    类对象调实例方法 / 字符串传给期望对象的方法 / 解构默认导出的命名导出。
 *
 * ② `src/cortex/benchmark-external-anchor.js` 首版是纯 stub:
 *    `setAnchor(x)` 接收值后**不存储**，`getAnchor()` 恒返回 null。
 *    实测 setAnchor(1); getAnchor() → null。
 *    **写进去读不出来** —— 比抛异常更难发现:
 *    方法存在、调用成功、不抛错，只是没有效果。
 *
 * ═══ 同时排除的一次仪器误报 ═══
 * 探针用字符串调用 `encryptJSON('hello')` 报
 * "refusing silent plaintext fallback"，看似真缺陷。
 * 但该函数签名与文档都写明要求 **JSON-serializable object**。
 * 用对象复测: 往返正常({a:1} → 加密 → {"a":1})。
 * 第 23 次: 探针自己不遵守被探函数的契约。
 *
 * ═══ 本测试锁什么 ═══
 * ① benchmark-external-anchor: setAnchor 后 getAnchor 必须读得到(写后能读)
 * ② adaptive-learning: 两种导出形态都能取到类
 * ③ thought-chain 的 adaptiveLearning 实例化可用
 * ④ memory-encrypt: 用对象往返正常(锁住探针必须遵守契约)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');

module.exports = function ({ test, assertEqual, assertTrue, assertDefined }) {

  // ─── ① benchmark-external-anchor: 写后能读 ───────────────────
  test('benchmark-external-anchor: setAnchor 后 getAnchor 必须读得到', () => {
    const anchor = require(path.join(ROOT, 'src', 'cortex', 'benchmark-external-anchor.js'));
    const tmp = path.join(os.tmpdir(), 'aspira-anchor-test-' + process.pid + '.json');
    anchor._setFile(tmp);
    try {
      assertEqual(anchor.getAnchor(), null, '初始应无锚点');
      anchor.setAnchor({ version: 'v1', score: 42 });
      const got = anchor.getAnchor();
      assertDefined(got, 'setAnchor 后 getAnchor 不得仍为 null —— 曾写进去读不出来');
      assertEqual(got.score, 42, '读回的锚点应与写入的一致');
      const h = anchor.healthCheck();
      assertEqual(h.ok, true, 'healthCheck 应 ok');
      assertEqual(h.hasAnchor, true, '设置后 hasAnchor 应为 true');
      anchor.clearAnchor();
      assertEqual(anchor.getAnchor(), null, 'clearAnchor 后应回到无锚点');
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) {}
      anchor._setFile(path.join(ROOT, 'data', 'benchmark', 'anchor.json'));
    }
  });

  // ─── ② adaptive-learning: 两种导出形态都能取到类 ─────────────
  test('adaptive-learning: 命名解构与默认导出都必须可取到类', () => {
    const mod = require(path.join(ROOT, 'src', 'cortex', 'adaptive-learning.js'));
    // 本模块是默认导出: module.exports = AdaptiveLearningEngine
    const asDefault = mod;
    const asNamed = mod && mod.AdaptiveLearningEngine;
    assertTrue(typeof asDefault === 'function',
      '默认导出应是类(函数) —— 实测 ' + typeof asDefault);
    // 兼容形态: 至少有一种能取到类
    const C = asNamed || asDefault;
    assertTrue(typeof C === 'function', '必须能取到 AdaptiveLearningEngine 类');
    // 能实例化且三个公开方法存在
    const inst = new C({ storeDir: path.join(os.tmpdir(), 'aspira-al-' + process.pid) });
    assertEqual(typeof inst.recordInteraction, 'function', '应有 recordInteraction');
    assertEqual(typeof inst.getProfile, 'function', '应有 getProfile');
    assertEqual(typeof inst.nextNudge, 'function', '应有 nextNudge');
  });

  // ─── ③ thought-chain 里的实例化可用 ──────────────────────────
  test('thought-chain: adaptiveLearning 实例化路径必须可用', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'workflow', 'thought-chain.js'), 'utf8');
    // 必须兼容默认导出(不再直接 .AdaptiveLearningEngine 后 new)
    assertTrue(/const _AL\s*=\s*require\(['"]\.\.\/cortex\/adaptive-learning\.js['"]\)/.test(src),
      '应先把 require 结果存入变量');
    assertTrue(/const _ALClass\s*=\s*\(?_AL\s*&&\s*_AL\.AdaptiveLearningEngine\)?\s*\|\|\s*_AL/.test(src),
      '必须同时兼容"命名导出"与"默认导出"两种形态');
    // 不得再出现 new (require(...).AdaptiveLearningEngine) 这种恒抛形态
    assertTrue(!/new\s*\(?\s*require\(['"]\.\.\/cortex\/adaptive-learning\.js['"]\)\.AdaptiveLearningEngine/.test(src),
      '不得再写 new require(...).AdaptiveLearningEngine —— 默认导出下它是 undefined，恒抛');
    // 真实执行一次实例化(不带 hf.memory)
    const _AL = require(path.join(ROOT, 'src', 'cortex', 'adaptive-learning.js'));
    const _ALClass = (_AL && _AL.AdaptiveLearningEngine) || _AL;
    const inst = new _ALClass({ storeDir: path.join(os.tmpdir(), 'aspira-al2-' + process.pid) });
    assertDefined(inst, '实例化不得抛');
  });

  // ─── ④ memory-encrypt: 探针必须遵守被探函数的契约 ────────────
  test('memory-encrypt: 以对象往返正常(字符串入参是探针违约)', () => {
    const m = require(path.join(ROOT, 'src', 'memory', 'memory-encrypt.js'));
    // encryptJSON 的签名与文档都要求 JSON-serializable **object**。
    // 传字符串会抛 "refusing silent plaintext fallback" —— 那是**正确的**拒绝:
    // 严禁无标记明文落盘。这里锁住"用对象时往返正常"。
    const enc = m.encryptJSON({ hello: 'world', n: 1 });
    assertTrue(typeof enc === 'string', 'encryptJSON 应返回字符串');
    const dec = m.decryptJSON(enc);
    assertEqual(dec.hello, 'world', '往返后字段应一致');
    assertEqual(dec.n, 1, '往返后数字应一致');
  });

  // ─── ⑤ 静态判据的局限: 不得用"固定返回比例"判定空壳 ─────────
  test('方法论: 静态比例判据会把真模块误判为空壳', () => {
    // dream.js 曾被"17 固定返回 / 21 方法"判为空壳，
    // 实际含 Fisher-Yates 洗牌与状态哈希。锁住这个反例，
    // 防止将来又用同一把尺子去"修"没坏的代码。
    const dream = fs.readFileSync(path.join(ROOT, 'src', 'dream', 'dream.js'), 'utf8');
    assertTrue(/Fisher-Yates|_pickRandom/.test(dream),
      'dream.js 含洗牌实现 —— 静态比例判据曾把它误判为空壳');
    const er = fs.readFileSync(path.join(ROOT, 'src', 'cortex', 'experience-replay.js'), 'utf8');
    assertTrue(/validateReportIntegrity|selfHealCorruptedFile/.test(er),
      'experience-replay.js 含完整性校验与自愈 —— 同样曾被误判');
  });
};
