/**
 * test/memory-encrypt-contract.test.js — 加密信封的版本协商与两条读取路径必须一致
 *
 * [第二十八轮] 新建。test-coverage-gap 切片: 实测 383 个 src 模块中 164 个无任何
 * 测试引用(全部可 require), 其中 memory 族 22 个。本文件挑 memory-encrypt ——
 * 它安全关键, 且契约形状清晰(encryptJSON/decryptJSON 往返), 正是"调用成功、
 * 不抛错、结构合法、内容是死的"那类缺陷的典型场所。
 *
 * 实测抓到的两个缺陷(都已修):
 *   ① 未知 _enc 版本被当明文返回。把 _enc 从 'HEARTFLOW_v1' 改成 'HEARTFLOW_v2'
 *      再 decryptJSON, 原样返回 {"_enc":"HEARTFLOW_v2","iv":...,"authTag":...,
 *      "data":"<密文>"} —— 不抛错、不告警, 调用方把**密文信封**当记忆内容收下。
 *      触发条件不极端: 密钥轮换/算法升级把 _enc 提到 v2 后, 未升级的旧进程读到
 *      新文件时没有任何信号, 而且信封结构合法, 下游的 JSON 校验与类型检查全都通不过去。
 *   ② decryptJSONAsync **整个漏了** decryptJSON 有的 PLAINTEXT_FALLBACK 拆包。
 *      同一条降级明文喂两条路径结果不同: 同步返回内层 data, 异步返回整个信封。
 *
 * 本文件的锁: ①双向(未知版本两条路径都必须抛错); ②双向(明文/降级/往返都必须照旧);
 * ③一致性(sync 与 async 对同一条输入必须给出同一结果)。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = function ({ test, assertEqual, assertTrue }) {

  const E = require(path.join(ROOT, 'src', 'memory', 'memory-encrypt.js'));

  const PAYLOAD = { a: 1, b: 'x', c: [1, 2, 3], u: '中文✓' };
  const enc = E.encryptJSON(PAYLOAD);

  // 造一个"未知版本"的信封: 结构合法, 只有 _enc 不是已知值
  const withVer = (v) => {
    const o = JSON.parse(enc);
    o._enc = v;
    return JSON.stringify(o, null, 2);
  };

  // ─── ① 未知版本: 两条路径都必须抛错, 而不是返回信封 ──────
  test('未知的 HEARTFLOW_* 版本必须抛错, 不得把密文信封当明文返回', async () => {
    for (const v of ['HEARTFLOW_v2', 'HEARTFLOW_v99', 'HEARTFLOW_v1_old']) {
      const raw = withVer(v);
      let threw = false;
      try { E.decryptJSON(raw); } catch (e) { threw = true; }
      assertTrue(threw,
        'decryptJSON 遇到未知版本 ' + v + ' 必须抛错。实测它原样返回了信封本身 —— '
        + '调用方会把密文(iv/authTag/data)当成记忆内容收下, 且不抛错、不告警');

      let threwA = false;
      try { await E.decryptJSONAsync(raw); } catch (e) { threwA = true; }
      assertTrue(threwA, 'decryptJSONAsync 对未知版本 ' + v + ' 同样必须抛错');
    }
  });

  // ─── ② 已知形态必须照旧工作(防"一刀切抛错"的过度修复) ────
  test('已知形态必须照旧: 往返/明文透传/非 JSON 返回 null', () => {
    assertEqual(JSON.stringify(E.decryptJSON(enc)), JSON.stringify(PAYLOAD),
      'HEARTFLOW_v1 信封必须能解密回原值');
    assertEqual(JSON.stringify(E.decryptJSON('{"x":1}')), '{"x":1}',
      '天然明文 JSON 必须透传(不能为了防未知版本把明文也拒了)');
    assertEqual(E.decryptJSON('not-json-at-all'), null, '非 JSON 输入必须返回 null');
    assertEqual(E.decryptJSON(''), null, '空字符串必须返回 null');
    assertEqual(E.decryptJSON(null), null, 'null 必须返回 null');
    assertEqual(E.decryptJSON(123), null, '非字符串必须返回 null');
  });

  // ─── ③ 篡改必须被 authTag 抓住, 而不是静默返回可信数据 ────
  test('篡改密文/authTag/伪造结构都必须抛错', () => {
    const flip = (field) => {
      const o = JSON.parse(enc);
      const b = Buffer.from(o[field], 'base64');
      b[0] = b[0] ^ 0xff;
      o[field] = b.toString('base64');
      return JSON.stringify(o, null, 2);
    };
    for (const f of ['data', 'authTag']) {
      let threw = false;
      try { E.decryptJSON(flip(f)); } catch (e) { threw = true; }
      assertTrue(threw, '翻转 ' + f + ' 的一个比特后必须抛错(authTag 的意义就在这里)');
    }
    const forged = JSON.stringify({
      _enc: 'HEARTFLOW_v1',
      iv: Buffer.alloc(16, 7).toString('base64'),
      authTag: Buffer.alloc(16, 7).toString('base64'),
      data: Buffer.from('{"secret":"forged"}').toString('base64'),
    }, null, 2);
    let threwF = false;
    try { E.decryptJSON(forged); } catch (e) { threwF = true; }
    assertTrue(threwF, '完全伪造的 HEARTFLOW_v1 信封必须抛错, 不得返回任何内容');
  });

  // ─── ④ sync 与 async 对同一条输入必须给出同一结果 ────────
  test('sync 与 async 对同一条输入必须给出一致结果(降级明文拆包曾被异步版漏掉)', async () => {
    const fb = JSON.stringify({ _enc: 'PLAINTEXT_FALLBACK', data: PAYLOAD }, null, 2);
    const s = E.decryptJSON(fb);
    const a = await E.decryptJSONAsync(fb);
    assertEqual(JSON.stringify(s), JSON.stringify(PAYLOAD),
      'sync 必须拆开 PLAINTEXT_FALLBACK 返回内层 data');
    assertEqual(JSON.stringify(a), JSON.stringify(PAYLOAD),
      'async 必须同样拆开 PLAINTEXT_FALLBACK —— 实测它原先返回整个信封, 与 sync 不一致');
    assertEqual(JSON.stringify(s), JSON.stringify(a),
      '同一条输入, sync 与 async 的结果必须逐一相同');
    assertEqual(JSON.stringify(await E.decryptJSONAsync(enc)), JSON.stringify(PAYLOAD),
      'async 的 HEARTFLOW_v1 往返也必须成立');
  });

  // ─── ⑤ 源码级: 两条路径都必须有版本守卫 ──────────────────
  test('源码级: decryptJSON 与 decryptJSONAsync 都必须有未知版本守卫', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'src', 'memory', 'memory-encrypt.js'), 'utf8');
    // 剥掉行注释再数, 否则注释里讨论 _enc 的句子会被当成代码(周期25/27 同款陷阱)
    const code = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    const guards = code.match(/indexOf\('HEARTFLOW_'\)\s*===\s*0/g) || [];
    assertEqual(guards.length, 2,
      'decryptJSON 与 decryptJSONAsync 必须各有一个未知版本守卫, 实测 ' + guards.length + ' 个');
    const fbUnwraps = code.match(/_enc === 'PLAINTEXT_FALLBACK'/g) || [];
    assertEqual(fbUnwraps.length, 2,
      '两条路径都必须拆 PLAINTEXT_FALLBACK(异步版原先整个漏了), 实测 ' + fbUnwraps.length + ' 处');
  });
};
