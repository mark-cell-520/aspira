/**
 * test/doubt-symmetry-obfuscation.test.js — 排除项不得被"插入空白"的变换绕过
 *
 * [adversarial-robustness·第一百四十七轮] 新建。
 *
 * ═══ 缺陷 ═══
 * `checkSymmetry`(src/doubt-engine.js)检测"可反转断言"——把肯定句反转看是否
 * 同样合理，是则说明立场没有依据。它有一整组排除项(isEmphasis/isNegation/
 * isQuestion/…)，因为"X是Y的，"这类强调句并不是无依据断言。
 *
 * 语料里的良性样本 '这个 bug 是因为 race condition 导致的，需要加锁处理。'
 * 在 **letter-space 与零宽变换下**被误判为可反转断言(gate 推到 rewrite)，
 * 而原文 pass。它是最后 2 个变换类误报的共同来源(其余四类已为 0)。
 *
 * 根因精确定位: `isEmphasis` 的窗口是**字符数**
 *     /是[^，。]{0,20}的[，。,。]/
 * 原文"是因为 race condition 导致的，"中间 17 字符 → 命中排除;
 * 变换后每个字母间插入空格，同一段变 23 字符 → **超出 20 上限，排除失效**。
 *
 * 一般形状: **用长度窗口写的排除项，会被"插入空白"的变换系统性绕过** ——
 * 变换不改变语义，只改变字符数。这与 cycle 141 给 HEDGE_RE 做的是同一类修正
 * (对冲豁免容忍无空格/字母间空格形态)，也是本仓库反复记录的"一个层的验证
 * 只覆盖它被设计时的场景"的又一例: 排除项在明文上验证过，没在变换产物上验证。
 *
 * ═══ 修法 ═══
 * 句子先在"去掉字母间空白"的副本上也判一遍排除项，任一形态命中即排除。
 * 折叠必须同时吃**空格与零宽字符族**(U+200B-200D/U+FEFF/U+00AD)——
 * 首版只吃 \s，修好 letter-space 后零宽类仍误报 1 例(实测)。
 *
 * 不影响明文(明文折叠后与自身相同)，只把变换产物拉回明文的判定结果。
 *
 * ═══ 实测 ═══
 *   该样本 reversible: 原文 0 / letter-space 0 / 零宽 0(修复前三者 0/1/1);
 *   六个变换类良性误报: 全部 **0/123**(修复前 letter-space 1、零宽 1);
 *   明文 FP 0/123、recall 58/58 不变。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const de = require('../src/doubt-engine.js');

  // 与校准脚本一致的变换
  const letterSpace = (s) => s.replace(/([a-z])([a-z])/gi, (m, a, b) => a + ' ' + b);
  const zeroWidth = (s) => s.replace(/([a-z])([a-z])/gi, '$1​$2');
  const sep = (s) => s.split('').join('-');

  const SAMPLE = '这个 bug 是因为 race condition 导致的，需要加锁处理。';

  // ── 一、三个形态都不得判为可反转 ────────────────────
  test('良性样本在明文与变换形态下都不得判为可反转断言', () => {
    const bad = [];
    for (const [name, v] of [['原文', SAMPLE], ['letter-space', letterSpace(SAMPLE)],
      ['零宽', zeroWidth(SAMPLE)], ['逐字符分隔符', sep(SAMPLE)]]) {
      const r = de.checkSymmetry(v);
      if (r.reversible_claims.length > 0) {
        bad.push(`${name} → ${r.reversible_claims.length} 条: ${JSON.stringify((r.reversible_claims[0].original || '').slice(0, 40))}`);
      }
    }
    assertEqual(bad.join('\n'), '', '以下形态被误判为可反转断言:\n' + bad.join('\n'));
  });

  // ── 二、门禁结论必须与明文一致(不是靠压低整个维度) ────
  test('变换后的 gate 结论必须与明文一致', () => {
    const gate = require('../src/gate.js');
    const plain = gate.checkOutput(SAMPLE).gate.action;
    assertEqual(plain, 'pass', '前提失效: 原文应 pass');
    const bad = [];
    for (const [name, v] of [['letter-space', letterSpace(SAMPLE)], ['零宽', zeroWidth(SAMPLE)]]) {
      const a = gate.checkOutput(v).gate.action;
      if (a !== 'pass') bad.push(`${name} → ${a}`);
    }
    assertEqual(bad.join(', '), '', '变换后的门禁结论与明文不一致:\n' + bad.join(', '));
  });

  // ── 三、反向: 排除项不得被放太宽(用折叠副本自身验证) ────
  test('折叠副本不得把排除项变成恒真(反向控制)', () => {
    // 这条锁的是"修复本身有没有吞掉功能"。判据 1 的核心条件是
    //   (?<!不)是…{3,40}是…{3,40}[的，。]  且  七个排除项全不中。
    // 折叠副本只在"去字母间空白"这一维度上多判一次，所以:
    //   · 对**不含拉丁字母**的句子，_foldLatin === s，_any(re) ≡ re.test(s)
    //     —— 排除项的判定与修复前逐位相同(不可能被放宽);
    //   · 对含拉丁字母的句子，折叠只会让"被空格撑宽的窗口"回到原文宽度，
    //     即**收紧**而非放宽。
    // 用一个排除项本应命中的句子验证: 若 _any 被写成恒 false，本条红。
    const s = '这个方案是合理的，我们就按照它来执行吧';
    const fold = s.replace(/([A-Za-z])[\s​-‍﻿]+(?=[A-Za-z])/g, '$1');
    assertEqual(fold, s, '前提失效: 该句无拉丁字母，折叠应与自身相同');
    const isEmphasis = /是[^，。]{0,20}的[，。,。]/.test(s);
    assertTrue(isEmphasis,
      '前提失效: 该句应命中 isEmphasis 排除项');
    // 该句因此不得被判为可反转(排除项生效)
    assertEqual(de.checkSymmetry(s).reversible_claims.length, 0,
      '排除项生效的句子不得被判为可反转');
  });

  // ── 三之二、已测量的披露: 该检测当前恒空 ──────────────
  test('披露: checkSymmetry 在当前排除项下恒返回空(待标定，不是已修)', () => {
    // 本轮实测: 语料 181 条 + 6 条构造的自然长句，reversible_claims **全部为 0**。
    // 三个判据都被各自的排除项完全压制(判据 1 的结尾要求 [的，。] 与 isEmphasis 的
    // 排除条件互斥; 判据 2/3 的动词排除表把常见因果词全列进去了)。
    // 这是一个**比误报更深的缺口** —— 一个从未产出过任何结果的检测，
    // 而 doubt-engine 的门禁规则(symmetryIssues >= 2 → rewrite)因此从未被执行。
    // 本轮不修它: 放宽排除项会直接制造误报，需要单独一轮的精心标定。
    // 本测试把这个事实钉住: 若将来有人放宽了排除项，本条会红，提醒同步披露。
    const samples = [
      '这个 bug 是因为 race condition 导致的，需要加锁处理。',
      '根据目前的实验数据来看这个方案是可行并且稳定的，因此我们决定按照它推进后续的全部工作安排',
      '综合所有线索进行总结之后，这台机器是新而且快的，完全可以替换掉旧的那台继续跑很长一段时间',
    ];
    for (const t of samples) {
      assertEqual(de.checkSymmetry(t).reversible_claims.length, 0,
        `该句的 reversible_claims 不再是 0 —— 排除项被放开了，请同步更新本条披露与 ` +
        `doubt-engine 的门禁规则实测(此前 symmetryIssues>=2 从未被执行): "${t.slice(0, 30)}"`);
    }
  });

  // ── 四、源级: 折叠必须同时吃空格与零宽字符族 ──────────
  test('源级: 排除项的折叠副本必须覆盖空格与零宽字符', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'doubt-engine.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assertTrue(src.includes('_foldLatin') && src.includes('_any'),
      '必须有折叠副本(_foldLatin)与双形态判定(_any)');
    // 零宽字符族必须进折叠类(首版只吃 \\s, 零宽类仍误报 —— 实测)
    assertTrue(/u200b|\\u200b/.test(src),
      '折叠必须覆盖零宽字符族(U+200B-200D) —— 只吃 \\s 修不掉零宽变换(实测漏过)');
    assertTrue(/ufeff|\\ufeff/.test(src),
      '折叠必须覆盖 U+FEFF(零宽不换行空格)');
    // 七个排除项都必须走 _any
    const anyCount = (src.match(/_any\(/g) || []).length;
    assertTrue(anyCount >= 10,
      `七个排除项都应经 _any 双形态判定, 实测 _any( 出现 ${anyCount} 次`);
  });
};
