/**
 * test/_child-summary.js — 从一个子进程的 stdout 里取出它自己的用例汇总
 *
 * ═══ 第二百零二轮为什么需要这个文件 ═══
 * 切片 doc-honest-numbers。审计的 `tests` / `testsFailed` 两个 key 是 spawn
 * `test/run-all.js` 再从输出里读总数得来的, 所以**这个函数的正确性就是审计
 * 那条声称的正确性**。而它原来是 `emitResult` 里的一行内联正则:
 *
 *     const m = out.match(/(\d+) 通过, (\d+) 失败/);
 *
 * 两个缺陷, 都是实测出来的, 都不是推测:
 *
 * ① **只认中文。** 逐個跑过全部 393 个测试文件后发现: **32 个文件的输出里
 *    没有任何中文汇总行**, 它们全都 exit 0、一个都没失败, 但它们的通过数被
 *    计成 0。形态有三种, 都是英文:
 *       `audit-regression: 86 passed, 0 failed`        (10 个文件, 161 例)
 *       `═══ 27 passed / 0 failed ═══`                  (1 个文件, 27 例)
 *       `blindspot-upgrade: 7/7 passed`                 (1 个文件, 7 例)
 *    合计 **195 个真实通过的用例从未进入过 run-all 的总数**, 也就从未进入过
 *    文档里那个 "1967 passing tests"。这不是低报几个的事: 文档声称的测试数
 *    比真实规模少了 195, 而审计读起来是全绿的。
 *
 * ② **取第一个匹配而不是最后一个。** 第二百零一轮定位到的根因:
 *    `test/git-binary-path-independence.test.js` 会在收窄 PATH 的子进程里跑
 *    `security-audit.test.js`, 当那个子进程失败时, 它把自己的汇总行
 *    (`安全审计回归: 15 通过, 1 失败, 共 16 个`)嵌进断言消息里打印出来,
 *    而该行出现在父文件自己的汇总**之前**。于是 run-all 把子进程的 15 个通过
 *    记到了父文件头上 —— 实测套件总数因此虚增 13(1967 → 1980), 而
 *    security-audit 每逢"版本已 bump、tag 还没打"就必然失败, 也就是说
 *    **每一轮升级流程都必然触发这个偏差**, 且正好发生在同步文档测试数那一刻。
 *
 * 修法: 分层取**最后**一条匹配, 中文规范形态优先, 其次中文泛形, 最后英文形态。
 * 分层而不是"任意形态取最后一条", 是因为 355/372 个文件打的是 harness 自己的
 * `测试结果:` 行, 它的信息强度最高; 只有它不存在时才退英文。
 *
 * 取最后一条而不是第一条: 子进程自己的汇总是它退出前最后打印的东西, 任何嵌在
 * 断言消息里的别行汇总都排在它前面。
 *
 * ═══ 仍然看不见的(披露, 不假装修好) ═══
 * 另有约 20 个文件的输出里**什么汇总行都没有**(只有 ✓ 行、或完全无输出),
 * 它们照样贡献 0 个用例。本模块无法从"没有汇总行"里读出用例数 —— 那需要它们
 * 自己打印, 是逐个文件的最小变更, 不属本轮一个改动的范围。实测这 32 个
 * (含上述 12 个有英文汇总的)文件 exit 全为 0, 所以没有隐藏的失败,
 * 失明的只是通过数。
 */

'use strict';

// 形态一(最强): harness 自己打印的规范行 `测试结果: N 通过, M 失败`
const CANON_ZH = /测试结果:\s*(\d+)\s*通过\s*,\s*(\d+)\s*失败/g;
// 形态二: 中文泛形(前缀是文件名或中文标题, 如 `安全审计回归: 16 通过, 0 失败`)
const ANY_ZH = /(\d+)\s*通过\s*,\s*(\d+)\s*失败/g;
// 形态三: 英文 `N passed, M failed` / `N passed / M failed`
const EN_PAIR = /(\d+)\s*passed\s*[,/]\s*(\d+)\s*failed/gi;
// 形态四: `N/N passed`(N 个里通过 N 个 → 失败数为 0)
const EN_FRAC = /(\d+)\s*\/\s*(\d+)\s*passed/gi;

function lastMatch(text, re) {
  if (re.global) re.lastIndex = 0;
  const all = [...text.matchAll(re)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  return { passed: parseInt(m[1], 10), failed: parseInt(m[2], 10) };
}

/**
 * @param {string} out 子进程的 stdout
 * @returns {{passed:number, failed:number, form:string}|null}
 */
function parseChildSummary(out) {
  if (typeof out !== 'string' || !out) return null;

  const canon = lastMatch(out, CANON_ZH);
  if (canon) return { ...canon, form: 'canonical-zh' };

  const anyZh = lastMatch(out, ANY_ZH);
  if (anyZh) return { ...anyZh, form: 'any-zh' };

  const enPair = lastMatch(out, EN_PAIR);
  if (enPair) return { ...enPair, form: 'en-pair' };

  // `N/N passed` 的第二个捕获组是**分母**, 不是失败数 —— "7 个里通过 7 个"
  // 意味着失败数为 0。第一版直接把 group(2) 当 failed 读, 被本轮的锁当场抓住。
  const frac = lastMatch(out, EN_FRAC);
  if (frac) return { passed: frac.passed, failed: 0, form: 'en-fraction' };

  return null;
}

module.exports = { parseChildSummary, CANON_ZH, ANY_ZH, EN_PAIR, EN_FRAC };
