/**
 * test/sync-doc-numbers-parsing.test.js — sync-doc-numbers.js 取数逻辑的双向锁定
 *
 * 背景：第八十二轮为"测试条数四处称呼点总忘改"新增 scripts/sync-doc-numbers.js。
 * 那次干跑看着完全正常，紧接着做突变验证才暴露真 bug：**实测取了 10 而不是 1435**。
 * 根因两个，都出在"从 run-all.js 输出里取数"这一步，不在改文件那一步：
 *   ① 把 stderr 也拼进输出 —— 于是"最后一个匹配"落到 stderr 里某个测试文件
 *      自己的行上;
 *   ② 用 match() 取第二条 —— 那取到的是第二个**完整匹配**，不是第二个分组。
 * 而且 audit-doc-numbers.js 的注释里**已经一字不差地写过这个坑**（"首版用 exec
 * 取第一条，拿到的是某个测试文件的 10 通过"），我又踩了一遍。
 *
 * 第二次突变验证又暴露第二个问题：一次 flaky 的 1431/4 被原样写进四个文档，
 * **同步器成了漂移的传播者**。已加"非全绿拒绝同步"闸。
 *
 * 本文件把取数逻辑单拎成纯函数 parseRunAllOutput() 后钉住：
 *   - 多行输出必须取**最后**一条（这正是汇总行）；
 *   - 必须能区分"测试文件自己的行"与"汇总行"——它们形状相同；
 *   - 非 0 失败必须如实报出来（闸的判据来自这里）。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=mount 函数导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const { parseRunAllOutput } = require('../scripts/sync-doc-numbers.js');

  // run-all.js 真实输出形状：每个测试文件一行，最后一行是汇总。
  // 这里刻意把**测试文件的行放在前面**，汇总行放最后。
  const MULTI = [
    '+ audit-scan-set-hygiene.test.js',
    '测试结果: 6 通过, 0 失败, 共 6 个',
    '+ letter-space-evasion.test.js',
    '测试结果: 10 通过, 0 失败, 共 10 个',
    '+ dangerous-instruction-weapons.test.js',
    '测试结果: 5 通过, 0 失败, 共 5 个',
    '',
    '══════════════════════════',
    '测试结果: 1435 通过, 0 失败, 共 1435 个',
  ].join('\n');

  test('多行输出必须取最后一条（汇总行），不是第一个测试文件的行', () => {
    const r = parseRunAllOutput(MULTI);
    assertEqual(r.passed, 1435, '应取汇总行 1435, 实得 ' + JSON.stringify(r));
    assertEqual(r.failed, 0);
  });

  test('首版 bug 复现: 只读第一条会拿到某个测试文件的 10 通过', () => {
    // 这一条锁的是"为什么必须取最后一条"——把首版的错法显式钉在案。
    const first = MULTI.match(/测试结果:\s*(\d+)\s+通过,\s*(\d+)\s+失败/);
    assertEqual(Number(first[1]), 6, '首行确实是 6 通过的 audit-scan-set-hygiene, 不是汇总');
    assertTrue(first[1] !== '1435', '首行 != 汇总行, 所以"取第一条"必错');
  });

  test('首版 bug 复现: match()[1] 是完整匹配而非分组', () => {
    // 首版用 text.match(reWithG) 取 [1]——那拿到的是第二个**完整匹配**。
    const whole = MULTI.match(/测试结果:\s*(\d+)\s+通过,\s*(\d+)\s+失败/g);
    assertTrue(Array.isArray(whole) && whole.length >= 3, 'g 标志下 match 返回完整匹配数组');
    assertTrue(whole[1].indexOf('测试结果') >= 0,
      'whole[1] 是第二整行(含"测试结果"字样), 不是第二分组');
  });

  test('失败数必须如实报出（"非全绿拒绝同步"闸的判据来源）', () => {
    const flaky = MULTI.replace('1435 通过, 0 失败', '1434 通过, 1 失败');
    const r = parseRunAllOutput(flaky);
    assertEqual(r.passed, 1434);
    assertEqual(r.failed, 1);
  });

  test('空输入与无匹配输入必须返回 null 而不是抛异常', () => {
    assertEqual(parseRunAllOutput('').passed, null);
    assertEqual(parseRunAllOutput('no results here at all').passed, null);
    assertEqual(parseRunAllOutput(null).passed, null);
    assertEqual(parseRunAllOutput(undefined).failed, null);
  });

  test('CRLF 与令牌间额外空白不得影响取数', () => {
    // 只加 **令牌之间** 的空白，不动逗号结构——run-all.js 真实输出形如
    // "N 通过, F 失败"，逗号紧贴"通过"。往逗号前塞空格等于改掉输入形状，
    // 那是测一个不存在的输入，不是测空白容错。
    const crlf = MULTI
      .replace(/\n/g, '\r\n')
      .replace('测试结果: 1435 通过', '测试结果:   1435   通过');
    const r = parseRunAllOutput(crlf);
    assertEqual(r.passed, 1435, 'CRLF/多余空白下仍应取到 1435, 实得 ' + JSON.stringify(r));
    assertEqual(r.failed, 0);
  });
};
