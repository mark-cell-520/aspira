/**
 * test/letter-space-collapse.test.js — 整段间距化折叠(letter-space 变换类的召回缺口)
 *
 * [fp-recall-calibration·第一百四十一轮] 新建。
 *
 * ═══ 缺口 ═══
 * `strip_letter_space` 要求"≥4 个连续单字母"，而字母间插空格的逃逸产物是
 * **字母成对分组**('c on st x = e va l(u se rI np ut)')，永远不满足该要求 ——
 * 于是 letter-space 变换类的内容型召回卡在 **47/55**，8 条代码类样本全漏。
 * 第十八轮试过"放宽到 1-2 字母 token"，实测净负(53 benign 换 1 malicious)，
 * 缺口在于那个放宽**没有形状判据**。
 *
 * ═══ 修法 ═══
 * 判据改为**整段形态**: 空格分隔的 token 里 ≤2 字母的纯字母 token 占比 ≥0.6
 * 且 token 数 ≥8，才把字母间的单空格全部删掉。关键性质: 形状判据对变换后的
 * 良性英文句**同样成立**(变换把每个词都拆开，攻击与良性在该层同构 —— 与
 * 第一百四十轮的结论一致)，所以本条**不做任何判断**，只负责还原；还原后是
 * 良性还是攻击，交给下游维度裁决。
 *
 * 两个必须同时成立的门槛，各修掉一条实测误报:
 *   ① 中文字符占比 < 30% —— 中英混排句折叠后 'racecondition' 是不存在的词，
 *      absolute_claim 因它误报；中文没有"字母间插空格"这种逃逸形状。
 *   ② HEDGE_RE 容忍无空格形态(\s+ → \s*、去尾部 \b、并测折叠副本) ——
 *      折叠把 'though the sample was small' 粘成 'thoughthesamplewassmall'，
 *      对冲豁免原本要求空格，在折叠产物上失效。
 *
 * 实测(122 benign / 57 malicious): 明文 FP 0/122、recall 57/57 不变;
 * letter-space 变换类内容型召回 **47/55 → 53/55**，变换版误报 **1/122 不变**
 * (那 1 条是禁用折叠时也存在的既有误报，见下"未回收")。
 *
 * ═══ 未回收 2 条，如实记录 ═══
 *   'eval(res.data)' 变换后只有 6 个 token，够不到 ≥8 的门槛;
 *   'new Function(userInput)' 折叠成 'newFunction(userInput)' 后
 *   code_security 的模式仍不匹配(它要求 new 与 Function 之间有空格) ——
 *   折叠的固有代价: 插入的空格与原有空格同形，词边界不可恢复。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  // checkOutput 是 src/gate.js 的顶层导出, index.js 上没有 —— 从 index.js 读
  // 必须走 discriminate(与 test/fp-hedge-exemption.test.js 一致)。
  const idx = require('../src/gate.js');
  const fs = require('fs');
  const path = require('path');

  // 与校准脚本一致的变换: 每对相邻字母之间插一个空格(非重叠配对 → 成对分组)
  const letterSpace = (s) => s.replace(/([a-z])([a-z])/gi, (m, a, b) => a + ' ' + b);
  const gateOf = (t) => ((idx.checkOutput(t).gate || {}).action) || 'pass';
  const caught = (t) => { const a = gateOf(t); return a === 'block' || a === 'rewrite'; };

  // ── 一、整段间距化折叠必须还原出可被判别的形态 ────────
  test('letter-space 变换下的代码类样本必须被拦(折叠还原)', () => {
    const recovered = [
      'const x = eval(userInput);',
      'exec("ls " + userInput);',
      'execSync(`ls ${dir}`);',
      'el.innerHTML = userInput;',
      'document.write(userInput);',
      'db.query("SELECT * FROM t WHERE id=" + id);',
    ];
    const bad = [];
    for (const t of recovered) {
      if (!caught(letterSpace(t))) bad.push('"' + t.slice(0, 42) + '" → ' + gateOf(letterSpace(t)));
    }
    assertEqual(bad.join('\n'), '', '以下样本折叠后仍未被拦:\n' + bad.join('\n'));
    // block 级维度: 命中必须真的阻断
    assertTrue(gateOf(letterSpace('const x = eval(userInput);')) === 'block',
      'code_security 命中应产生 block');
  });

  // ── 二、未回收的 2 条不得被当成已解决 ────────────────
  test('两条未回收样本必须如实记录为仍未拦(不得假装修复)', () => {
    // 这条锁的是**披露本身**: 若有人日后修好了它们，本测试会红，提醒同步
    // AGENTS.md 与源码注释里的"未回收 2 条"记录。
    const stillMissed = [
      'eval(res.data);',                        // 变换后 6 token < 8 门槛
      'const f = new Function(userInput);',     // 折叠成 newFunction 后模式不匹配
    ];
    for (const t of stillMissed) {
      assertTrue(!caught(letterSpace(t)),
        `"${t.slice(0, 40)}" 现在被拦了 —— 请把"未回收 2 条"的披露同步更新(它已不再是漏报)`);
    }
  });

  // ── 三、折叠不得新增误报(两条门槛各锁一条) ────────────
  test('折叠不得把对冲豁免句与中英混排句变成误报', () => {
    // 门槛 ②: 对冲豁免必须容忍折叠产物(折叠把 though the sample was small
    // 粘成一个词，\s+ 与尾部 \b 都会让豁免失效)
    const hedged = 'According to the 2024 report, sales grew by 12%, though the sample was small.';
    assertTrue(gateOf(hedged) === 'pass', '明文下该对冲句应放行');
    assertTrue(gateOf(letterSpace(hedged)) === 'pass',
      'letter-space 变换后仍应放行 —— 对冲豁免必须容忍折叠产物');

    // 门槛 ①: 中英混排句不进入折叠(中文没有"字母间插空格"这种逃逸形状)。
    // 该句在 letter-space 与零宽变换下**本来就**被 absolute_claim 误报
    // (禁用折叠的对照实测同样 rewrite)，所以不断言 pass，只断言折叠没有
    // 让它变更糟: 不得从 rewrite 升到 block。
    const mixed = '这个 bug 是因为 race condition 导致的，需要加锁处理。';
    assertTrue(gateOf(letterSpace(mixed)) !== 'block',
      '中英混排句不得被折叠升级成 block(既有误报是 rewrite, 不得恶化)');
  });

  // ── 四、源级: 折叠判据与两个门槛都必须在 ──────────────
  test('text-normalizer 必须含整段形状判据与中文门槛', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'text-normalizer.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assertTrue(src.includes('collapse_letter_space_full'),
      '整段折叠层必须在(applied 标记 collapse_letter_space_full)');
    assertTrue(src.includes('_looksFullySpaced'),
      '形状判据 _looksFullySpaced 必须在 —— 没有它的"放宽到 1-2 字母 token"是第十八轮实测净负的');
    // 中文门槛: 中英混排句折叠后制造假词(racecondition), 必须排除
    assertTrue(/han\s*<\s*latin\s*\*\s*0\.3/.test(src),
      '中文占比门槛必须在 —— 缺它中英混排句会被折叠成不存在的词并误报');
    // token 数门槛: 短文本不折叠
    assertTrue(src.includes('toks.length < 8'),
      'token 数 ≥8 的门槛必须在 —— 短文本折叠风险大于收益');
  });

  // ── 五、源级: 对冲豁免必须容忍折叠产物 ────────────────
  test('HEDGE_RE 必须容忍无空格与字母间空格形态', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // \s+ → \s*: 折叠后 'though the sample was small' 无空格
    assertTrue(src.includes('though\\s*the\\s*sample'),
      'HEDGE_RE 应容忍 "thoughthesample" 无空格形态');
    // 尾部 \b 已去: sample 后面粘着 was, \b 不成立
    assertTrue(!src.includes('though\\s*the\\s*sample\\b'),
      '该模式不得再带尾部 \\b —— 折叠产物上它必然失败');
    // 两处都必须测折叠副本(变换文本字母间还有空格, \s* 也不够)
    const foldCopies = (src.match(/HEDGE_RE\.test\(_hedgeText2?\)/g) || []).length;
    assertTrue(foldCopies >= 2,
      `两处 HEDGE_RE 都应测"去掉字母间空格"的副本, 实测 ${foldCopies} 处`);
  });
};
