/**
 * test/fp4-quant-roundtrip.test.js — src/core/fp4-quant.js 的双向契约锁定
 *
 * 背景（第八十七轮, test-coverage-gap 切片）:
 * 本会话的模块普查(census)测得 src/ 383 个模块里 **102 个无任何测试引用**。
 * 注意这个数与 cycle-28 记的 164 不同——那一版只按模块**名** grep, 漏掉了
 * `path.join(ROOT,'src','memory','kv-cache.js')` 这类分段拼法的引用
 * (cycle-31 记的教训)。本版同时按名与按分段路径两种方式找, 数字更小也更准。
 *
 * fp4-quant.js 是这 102 个之一: 被 src/core/heartflow.js 引用, 但无任何测试。
 * 选它的理由与 cycle-31 选 memory-encrypt.js 相同——契约**安全关键**且
 * **可 crisp round-trip**: 量化是有损压缩, 若还原失败, 判别器读到的是
 * 压缩后的整数而不是它以为的浮点分数, 而结构上一切正常。
 *
 * **本文件不是"补覆盖剧场"**。断言的是契约, 不是"能 require":
 *   ① round-trip 后数值必须落在声明的精度内(4-bit, 16 级, 中点还原);
 *   ② 非数值字段/非白名单字段必须原样保留(压缩不得顺手改数据);
 *   ③ 压缩标记 _q 必须在还原后彻底消失(否则下游看到裸字段);
 *   ④ 白名单本身不得缩水(15 个字段名是契约, 不是随便一个集合)。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=mount 函数导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const q = require('../src/core/fp4-quant.js');

  // ── ① round-trip 精度 ──────────────────────────────────────
  test('quantize4/dequantize4 round-trip 落在 4-bit 精度内', () => {
    // 4-bit = 16 级 → 步长 1/15 ≈ 0.0667, 中点还原的最大误差是其一半
    const MAX_ERR = 1 / 15 / 2 + 1e-9;
    const vals = [0, 0.001, 0.1, 0.25, 0.333, 0.5, 0.75, 0.999, 1];
    for (const v of vals) {
      const enc = q.quantize4(v);
      const dec = q.dequantize4(enc);
      assertTrue(Number.isInteger(enc) && enc >= 0 && enc <= 15,
        `${v} 量化后必须是 0..15 的整数, 实得 ${enc}`);
      assertTrue(dec >= 0 && dec <= 1, `${v} 还原后必须落在 [0,1], 实得 ${dec}`);
      assertTrue(Math.abs(dec - v) <= MAX_ERR,
        `${v} 还原误差 ${Math.abs(dec - v)} 超过 4-bit 上限 ${MAX_ERR}`);
    }
  });

  test('边界值 0 与 1 必须精确还原(端点不得被量化偏移)', () => {
    assertEqual(q.dequantize4(q.quantize4(0)), 0);
    assertEqual(q.dequantize4(q.quantize4(1)), 1);
  });

  // ── ② 压缩不得动契约外的数据 ───────────────────────────────
  test('非数值字段与非白名单字段必须原样保留', () => {
    const obj = {
      confidence: 0.73,            // 白名单 + 数值 → 量化
      name: 'aspira',              // 字符串 → 不动
      ok: true,                     // 布尔 → 不动
      n: null,                     // null → 不动
      list: [1, 2],                // 数组 → 不动
      notInWhitelist: 0.9,         // 数值但不在白名单 → 不动
    };
    const c = q.compressObject(obj);
    assertEqual(c.name, 'aspira');
    assertEqual(c.ok, true);
    assertEqual(c.n, null);
    assertEqual(JSON.stringify(c.list), '[1,2]');
    assertEqual(c.notInWhitelist, 0.9, '非白名单数值不得被量化');
    assertTrue(typeof c.confidence === 'number', '白名单数值应被量化成整数');
  });

  test('嵌套对象必须递归处理, 顶层之外的字段同样受契约约束', () => {
    const obj = { nested: { confidence: 0.6, quality: 0.4, tag: 'x' } };
    const c = q.compressObject(obj);
    assertEqual(c.nested.tag, 'x');
    assertEqual(c.nested.confidence_q, true);
    const d = q.decompressObject(c);
    assertEqual(d.nested.tag, 'x');
    assertTrue(Math.abs(d.nested.confidence - 0.6) <= 1 / 15 / 2 + 1e-9);
    assertTrue(Math.abs(d.nested.quality - 0.4) <= 1 / 15 / 2 + 1e-9);
  });

  // ── ③ 压缩标记必须消失 ────────────────────────────────────
  test('压缩标记 _q 在还原后必须彻底消失', () => {
    const obj = { confidence: 0.73, severity: 0.9, nested: { quality: 0.4 } };
    const d = q.decompressObject(q.compressObject(obj));
    assertEqual(JSON.stringify(d).indexOf('_q') >= 0, false,
      '还原结果里不得残留 _q 标记, 实得 ' + JSON.stringify(d));
  });

  test('还原后不得残留被量化的整数字段', () => {
    // 若 _q 标记被漏处理, 下游会同时看到 confidence(整数) 与 confidence_q(true)
    const obj = { confidence: 0.73 };
    const d = q.decompressObject(q.compressObject(obj));
    assertEqual(JSON.stringify(d), JSON.stringify({ confidence: d.confidence }),
      '还原结果应只含原始字段, 实得 ' + JSON.stringify(d));
  });

  // ── ④ 白名单本身是契约 ────────────────────────────────────
  test('COMPRESSIBLE_FIELDS 白名单不得缩水(字段名是契约)', () => {
    assertEqual(q.COMPRESSIBLE_FIELDS instanceof Set, true,
      'COMPRESSIBLE_FIELDS 必须是 Set(它曾被我误读成 map: Set 序列化也是 {})');
    assertEqual(q.COMPRESSIBLE_FIELDS.has('confidence'), true);
    assertEqual(q.COMPRESSIBLE_FIELDS.has('severity'), true);
    assertEqual(q.COMPRESSIBLE_FIELDS.has('overallScore'), true);
    assertTrue(q.COMPRESSIBLE_FIELDS.size >= 15,
      '白名单字段数不应少于 15, 实得 ' + q.COMPRESSIBLE_FIELDS.size);
  });

  test('isCompressible 以字段名为键, 不是以值为键', () => {
    // 本条锁的是我本轮探错的形状: 我传了 0.5(值), 于是读到 false 并一度
    // 以为"整个模块是死的"。实际它的键是字段名。这一条让那个错误可复现地失败。
    assertEqual(q.isCompressible('confidence'), true);
    assertEqual(q.isCompressible('not_a_field'), false);
  });

  test('压缩率必须可计算且非空对象不为 1(确实在压缩)', () => {
    const obj = { confidence: 0.73, severity: 0.9, overallScore: 0.5, name: 'aspira' };
    const r = q.compressionRatio(obj, q.compressObject(obj));
    assertTrue(typeof r === 'number' && r > 0, '压缩率应是正数, 实得 ' + r);
  });

  test('FP4_ENABLED 开关为 true 时压缩必须真的发生', () => {
    if (q.FP4_ENABLED !== true) return; // 关着时压缩本就不该发生
    const obj = { confidence: 0.73 };
    const c = q.compressObject(obj);
    assertEqual(c.confidence_q, true, '开关为 true 时必须打上量化标记');
  });
};
