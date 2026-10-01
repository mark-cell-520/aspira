/**
 * test/normalizer-deleet-version.test.js — de_leet 改写版本串的实测记录
 *
 * 背景（第一百轮, test-coverage-gap 切片）:
 * 第九十九轮(adversarial-robustness)复核已知缺口①数字插空时, 顺带量到:
 *   'v1.0.0 is fine' → normalize().normalized === 'vi.0.0 is fine'
 *   applied === ['de_leet']
 * 即**归一化层把版本号里的 '1' 改写成了 'i'**。gate 仍是 pass(不是门禁误判),
 * 但它违背这个 repo 自己最看重的契约——诚实数字: VERSION 与 package.json /
 * SKILL.md 的字面一致性, 前提是版本串被原样读出。
 *
 * **为什么把它写成"记下现状"而不是直接修**:
 * de_leet 是共享层, 改它必须同时量两侧(版本形态 + utf-8 / A-1-B / 3.14 / 2024
 * 四个良性形态), 本轮预算内做不完那一整套; 而"改一半"本会话已付三次学费。
 * 但**一个只存在于 journal 里的缺陷没有信号**——修好了没人知道, 改坏了也没人知道。
 * 所以本文件钉住**当前读数**, 并让失败信息直接说明下一步。
 *
 * 形态与 test/evasion-known-gaps.test.js 同族: 现状被钉住, 修好会红(提醒更新记录)。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=mount 函数导出。
 */
module.exports = function ({ test, assertEqual }) {
  const tn = require('../src/text-normalizer.js');
  const n = t => tn.normalize(t);

  // ── ① 第一百零一轮: 已修复。从"钉现状"改为"双向锁定" ──────────
  test('版本号 token 必须原样保留(de_leet 不得把 v1.0.0 改成 vi.0.0)', () => {
    const VERSIONS = [
      ['v1.0.0 is fine', 'v1.0.0 is fine'],
      ['v1.0.0', 'v1.0.0'],
      ['v10.20.30 ok', 'v10.20.30 ok'],
      ['aspira v1.0.0 here', 'aspira v1.0.0 here'],
      ['V1.0.0', 'v1.0.0'],   // 只有 lowercase 生效, 数字不得被解码
    ];
    for (const [input, want] of VERSIONS) {
      const r = n(input);
      assertEqual(r.normalized, want,
        '版本号必须原样保留: ' + JSON.stringify(input) + ' → ' + JSON.stringify(r.normalized) +
        '(de_leet 或 strip_separator 又改了它)');
      assertEqual(r.applied.indexOf('de_leet') < 0, true,
        JSON.stringify(input) + ' 不应触发 de_leet, 实得 ' + JSON.stringify(r.applied));
    }
  });

  // ── ② 副作用范围: 只钉**已经量过没问题的**良性形态 ─────────
  // 这四条是 de_leet 万一被修时必须守住的东西。它们现在就是对的。
  test('良性锚点: 这些数字形态当前不被 de_leet 改写', () => {
    const anchors = [
      ['encoding utf-8 is standard', 'encoding utf-8 is standard'],
      ['order A-1-B and 3.14 items', 'order a-1-b and 3.14 items'],
      ['the year 2024 was fine', 'the year 2024 was fine'],
      ['v2.10.3 released', 'v2.10.3 released'],
    ];
    for (const [input, want] of anchors) {
      const r = n(input);
      assertEqual(r.normalized, want,
        '良性锚点被改动了: ' + JSON.stringify(input) + ' → ' + JSON.stringify(r.normalized) +
        '。de_leet 的修复必须守住这四个形态。');
      assertEqual(JSON.stringify(r.applied).indexOf('de_leet') < 0, true,
        JSON.stringify(input) + ' 不应触发 de_leet, 实得 ' + JSON.stringify(r.applied));
    }
  });

  test('残留缺口已留档: 四段版本号 v1.0.0.1 仍会被改写', () => {
    // 第一百零一轮的护栏只挡 /^v\d+(\.\d+)+$/ 的 token, 而 strip_separator 跑在
    // de_leet **之前**, 先把 v1.0.0.1 的点吃掉, 等 de_leet 看见时它已不是
    // '点分数字' 形态, 护栏认不出来。实测仍得 'viool'。
    // 这一条把残留缺口钉住: 修好它会红, 届时把本条从"钉缺口"改成双向锁定。
    const r = n('v1.0.0.1');
    assertEqual(r.normalized, 'viool',
      'v1.0.0.1 的读数变了。若已修复 → 请把本条改成双向锁定; 若这是回归 → 查 strip_separator。' +
      '实得 ' + JSON.stringify(r.normalized));
  });
};
