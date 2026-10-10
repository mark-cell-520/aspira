/**
 * test/child-summary-parse.test.js — run-all 必须读出子进程自己的汇总行
 *
 * ═══ 第二百零二轮 ═══
 * 切片 doc-honest-numbers。审计的 `tests` / `testsFailed` 两个 key 是 spawn
 * `test/run-all.js` 再从输出里读总数得来的 —— **这个解析函数的正确性就是
 * 审计那条声称的正确性**。它原来是 `emitResult` 里的一行内联正则:
 *
 *     const m = out.match(/(\d+) 通过, (\d+) 失败/);
 *
 * 只认中文、取第一个匹配。两个缺陷都是逐個跑完全部 393 个测试文件后实测出来的:
 *
 * ① **只认中文 → 195 个通过用例被计成 0。** 32 个文件的输出里没有任何中文
 *    汇总行, 全部 exit 0、零失败, 但通过数计 0:
 *       `audit-regression: 86 passed, 0 failed`   ×10 个文件 = 161 例
 *       `═══ 27 passed / 0 failed ═══`             ×1 个文件 = 27 例
 *       `blindspot-upgrade: 7/7 passed`            ×1 个文件 = 7 例
 *    文档声称的测试数因此比真实规模少 195, 而审计读起来是全绿的。
 *
 * ② **取第一个匹配 → 套件总数虚增 13。** 第二百零一轮定位:
 *    `git-binary-path-independence.test.js` 在收窄 PATH 的子进程里跑
 *    `security-audit.test.js`, 子进程失败时它把子进程的汇总行嵌进断言消息打印,
 *    而该行排在父文件自己的汇总**之前**。于是 15 个通过被记到只做了 2 个用例的
 *    父文件头上。实测 1967 → 1980, 差 13。而 security-audit 每逢"版本已 bump、
 *    tag 未打"必然失败 —— 也就是**每轮升级流程都必然触发**, 且正好发生在同步
 *    文档测试数那一刻。
 *
 * 修法在 test/_child-summary.js: 分层取**最后**一条匹配, 中文规范形态 >
 * 中文泛形 > 英文 `passed/failed` 对 > 英文 `N/N passed`。
 *
 * ═══ 本锁的两侧 ═══
 * 正向: 五种真实汇总形态都要被正确读出, 且别行汇总不能顶掉本文件自己的。
 * 反向: 把旧判据(内联中文首个匹配)原样内联进来, 要求它在英文形态与诱饵形态上
 *        必须失效 —— 否则"修好了"可以被一个永远返回 null 的实现蒙混过关。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const { parseChildSummary } = require('./_child-summary.js');

  // ─── 正向: 五种真实形态 ─────────────────────────────────────────

  test('harness 规范行: 测试结果: N 通过, M 失败', () => {
    const r = parseChildSummary('一些输出\n\n测试结果: 12 通过, 1 失败, 共 13 个\n');
    assertEqual(r && r.passed, 12, '应读出 12 个通过');
    assertEqual(r && r.failed, 1, '应读出 1 个失败');
    assertEqual(r && r.form, 'canonical-zh', '应走到规范中文形态');
  });

  test('中文泛形: 前缀是文件名/中文标题(安全审计回归: 16 通过, 0 失败)', () => {
    const r = parseChildSummary('检查中...\n安全审计回归: 16 通过, 0 失败, 共 16 个\n');
    assertEqual(r && r.passed, 16, '应读出 16 个通过');
    assertEqual(r && r.failed, 0, '应读出 0 个失败');
    assertEqual(r && r.form, 'any-zh', '应走到中文泛形形态');
  });

  test('英文逗号形: audit-regression: 86 passed, 0 failed(实测 10 个文件 161 例)', () => {
    const r = parseChildSummary('规则命中...\n\n📊 audit-regression: 86 passed, 0 failed\n');
    assertEqual(r && r.passed, 86, '应读出 86 个通过 —— 这是此前被计成 0 的那一批');
    assertEqual(r && r.failed, 0, '应读出 0 个失败');
    assertEqual(r && r.form, 'en-pair', '应走到英文配对形态');
  });

  test('英文斜杠形: ═══ 27 passed / 0 failed ═══', () => {
    const r = parseChildSummary('G6-5 ok\n\n═══ 27 passed / 0 failed ═══\n');
    assertEqual(r && r.passed, 27, '应读出 27 个通过');
    assertEqual(r && r.failed, 0, '应读出 0 个失败');
  });

  test('英文分数形: blindspot-upgrade: 7/7 passed', () => {
    const r = parseChildSummary('✅ normal-tech\n\nblindspot-upgrade: 7/7 passed\n');
    assertEqual(r && r.passed, 7, '应读出 7 个通过');
    assertEqual(r && r.failed, 0, 'N/N passed 意味着零失败');
    assertEqual(r && r.form, 'en-fraction', '应走到英文分数形态');
  });

  test('带尾巴的英文汇总也要认: MCP Smoke Test: 8 passed, 0 failed, total 8', () => {
    const r = parseChildSummary('tools ok\n\n📊 MCP Smoke Test: 8 passed, 0 failed, total 8\n');
    assertEqual(r && r.passed, 8, '应读出 8 个通过');
    assertEqual(r && r.failed, 0, '应读出 0 个失败');
  });

  // ─── 主缺陷: 别行汇总不得顶掉本文件自己的汇总 ───────────────────

  test('诱饵汇总排在前面时, 必须仍取本文件自己的汇总(第二百零一轮的 +13)', () => {
    // 逐字复刻 git-binary-path-independence 失败时的真实输出形状
    const out = [
      '  ✗ PATH 只含 /usr/local/bin 时 security-audit 必须全绿',
      '    期望 truthy，实际 false。收窄 PATH 后 security-audit 仍有失败 —— git 又在依赖 PATH:',
      '安全审计回归: 15 通过, 1 失败, 共 16 个',
      '  ✓ 本锁必须能红: 把 S2 退回裸 git 后行为用例必须失败',
      '测试结果: 2 通过, 1 失败, 共 3 个',
      '',
    ].join('\n');
    const r = parseChildSummary(out);
    assertEqual(r && r.passed, 2, '必须取本文件的 2 个通过, 实测 ' + (r && r.passed));
    assertEqual(r && r.failed, 1, '必须取本文件的 1 个失败, 实测 ' + (r && r.failed));
  });

  test('多条规范汇总时取最后一条(子进程自己的汇总是退出前最后打印的)', () => {
    const out = '子套件: 测试结果: 5 通过, 0 失败, 共 5 个\n更多输出\n测试结果: 9 通过, 2 失败, 共 11 个\n';
    const r = parseChildSummary(out);
    assertEqual(r && r.passed, 9, '应取最后一条的 9, 实测 ' + (r && r.passed));
    assertEqual(r && r.failed, 2, '应取最后一条的 2, 实测 ' + (r && r.failed));
  });

  test('英文汇总排在中文汇总之后时, 中文规范形态仍然优先', () => {
    const out = 'sub: 8 passed, 0 failed\n\n测试结果: 4 通过, 0 失败, 共 4 个\n';
    const r = parseChildSummary(out);
    assertEqual(r && r.form, 'canonical-zh', '规范中文形态信息强度最高, 应优先');
    assertEqual(r && r.passed, 4, '应取 4, 实测 ' + (r && r.passed));
  });

  // ─── 无汇总行 ──────────────────────────────────────────────────

  test('完全没有汇总行时返回 null(让 emitResult 走"无汇总"分支)', () => {
    assertEqual(parseChildSummary(''), null, '空串应返回 null');
    assertEqual(parseChildSummary('只有一些 ✓ 行\n没有任何计数\n'), null, '无计数应返回 null');
    assertEqual(parseChildSummary('PASS: all tests skipped (module removed)\n'), null, 'SKIP 行不是汇总');
    assertEqual(parseChildSummary(null), null, 'null 应返回 null');
    assertEqual(parseChildSummary(undefined), null, 'undefined 应返回 null');
    assertEqual(parseChildSummary(42), null, '非字符串应返回 null');
  });

  // ─── 反向证明: 旧判据必须在这些形状上失效 ─────────────────────

  test('反向证明: 旧判据(内联中文首个匹配)在英文与诱饵形状上必须失效', () => {
    // 旧判据原样内联, 不改一个字
    const oldPick = (out) => {
      const m = out.match(/(\d+) 通过, (\d+) 失败/);
      return m ? { passed: parseInt(m[1], 10), failed: parseInt(m[2], 10) } : null;
    };
    const enOut = '📊 audit-regression: 86 passed, 0 failed\n';
    const decoyOut = '安全审计回归: 15 通过, 1 失败, 共 16 个\n测试结果: 2 通过, 1 失败, 共 3 个\n';

    assertEqual(oldPick(enOut), null,
      '旧判据在英文汇总上必须读不到 —— 否则本条反向证明失效');
    assertEqual(oldPick(decoyOut).passed, 15,
      '旧判据在诱饵形状上必须读到子进程的 15 —— 否则本条反向证明失效');
    // 而新判据在这两个形状上都必须是对的
    assertEqual(parseChildSummary(enOut).passed, 86, '新判据应读出 86');
    assertEqual(parseChildSummary(decoyOut).passed, 2, '新判据应读出 2');
  });

  // ─── 已披露: 本模块治不了的那一类 ─────────────────────────────

  test('已披露: 约 20 个文件什么都不打印, 本模块无法从中读出用例数', () => {
    // 这些文件 exit 0、零失败, 但输出里既无中文也无英文汇总行
    // (assertions / atomic-write / audit-wiring / behavior-tracker / data-eraser /
    //  emotion-optimizer / empathy-responder-optimized / evolution-audit /
    //  evolution-state / meta-audit / pattern-detector / self-evolution-v2 /
    //  sycophancy-i18n / ttl-preferences / knowledge/classics-feedback …)
    // 让它们打印汇总是逐个文件的最小变更, 不属本轮一个改动的范围。
    for (const out of ['', '✓ 某方法存在\n✓ 另一方法存在\n', 'BehaviorTracker smoke test passed\n']) {
      assertEqual(parseChildSummary(out), null,
        '这些文件仍将贡献 0 个用例 —— 这是披露中的残余, 不是本轮的修复目标');
    }
  });
};
