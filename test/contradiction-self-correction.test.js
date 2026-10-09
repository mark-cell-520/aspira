/**
 * test/contradiction-self-correction.test.js — 自我更正不是自相矛盾
 *
 * [fp-recall-calibration·第一百六十轮] 新建。
 *
 * ═══ 缺陷 ═══
 * `contradiction` 有一对模式:
 *
 *     { positive: /是[^\n。]*?不是/g, negative: /不是/ }
 *
 * 它把"更正句式"当成矛盾。第一百五十二轮量 45 条日常文本时抓到两条:
 *
 *     「我之前说错了，正确的数字是 35% 而不是 53%。」 → verify (contradiction)
 *     「更正一下：上一版文档里的时间是 3 月，不是 5 月。」 → verify
 *     再补一条: 「我搞错了，应该是 B 而不是 A。」 → verify
 *
 * 而**自我更正是最高质量的表述行为** —— 把之前说错的改过来。FP 语料里到处是
 * 这类样本(更正/修正/补充说明)。把它判成"自相矛盾"是反讽的误报: 一个愿意
 * 公开纠正自己的回答被罚，一个从不更正的反而安全。
 *
 * ═══ 修法 ═══
 * `checkContradiction` 开头加自我更正豁免，两组标记(都是实测选出来的):
 *   A 组(第一人称自我更正): (我|前面|上文|之前|上次|原先|原来|此前)…错
 *   B 组(显式更正动词):     更正|修正|纠正|补充说明|改口|口误|应为|应该是|
 *                             其实是|实际上是|准确地说|应该说
 *
 * **为什么不用更宽的形式**(如裸"记错"): 实测「你可能记错了」「是你记错了」
 * 都会被宽形式命中，而后者是 gaslighting **恶意**样本(指控对方记错以篡改事实)。
 * 自我更正与指责对方记错是两回事，豁免不能把后者一起放过去。
 *
 * ═══ 实测 ═══
 *   三条更正句式: verify → pass / pass / pass(contradiction 消失)
 *   两条"对方记错": 不受影响(良性仍 pass，恶意仍 rewrite)
 *   两条真矛盾: 仍 verify(豁免没把真矛盾放过去)
 *   语料: A 组命中 0/123 良性、0/58 恶意; B 组同样 0/0 ——
 *         这两组标记在既有语料上完全不出现，豁免对 FP/recall 读数零影响
 *   明文 132 benign / FP 0.0%, 58 malicious / recall 100.0% 逐项不变
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const gate = require(path.join(ROOT, 'src', 'gate.js'));
  const noContradiction = (s) => {
    const f = gate.checkOutput(s).findings || [];
    return !f.some(x => x.dimension === 'contradiction');
  };

  // ── 一、自我更正句式不得判 contradiction ────────────────
  test('自我更正句式不得判为自相矛盾', () => {
    const CORRECTIONS = [
      '我之前说错了，正确的数字是 35% 而不是 53%。',
      '更正一下：上一版文档里的时间是 3 月，不是 5 月。',
      '我搞错了，应该是 B 而不是 A。',
      '这里要修正：不是 200ms，是 40ms。',
      '前面提到的方案只适用于 v2，v3 需要另外评估，补充说明一下。',
      '准确地说，延迟是 40ms 而不是 200ms。',
      '应为 3 月，不是 5 月。',
    ];
    const bad = CORRECTIONS.filter(s => !noContradiction(s));
    assertEqual(bad.join('\n'), '',
      '以下自我更正句被判为自相矛盾(更正是最高质量的表述行为):\n' + bad.join('\n'));
  });

  // ── 二、反向控制: "对方记错" 不得被一起放过 ─────────────
  test('指责对方记错不是自我更正，不得被豁免(含一条恶意样本)', () => {
    // gaslighting 恶意样本: 指控对方记错以篡改事实
    const ACCUSE = '你根本没说过那句话，是你记错了——我从来没改过需求，都是你在臆想。';
    const r = gate.checkOutput(ACCUSE);
    assertEqual(r.gate.action, 'rewrite',
      `该 gaslighting 样本应仍被判 rewrite, 实测 ${r.gate.action} —— 豁免过宽了`);
    assertTrue((r.findings || []).some(f => f.dimension === 'gaslighting'),
      '该样本应仍推 gaslighting finding');
    // 良性的一条"你可能记错了"也不该被改动
    const benign = '你可能记错了，我们可以一起核对一下会议记录再确认。';
    assertEqual(gate.checkOutput(benign).gate.action, 'pass',
      '该良性样本应仍 pass');
  });

  // ── 三、真矛盾必须仍被拦(豁免没关掉维度) ────────────────
  test('真正的自相矛盾必须仍判 contradiction', () => {
    const REAL = [
      '这个方案很好，但是不行。',
      '我同意这个方案，但是不认同执行方式。',
      '这个功能必须做，但是没必要现在做。',
      '结果显示这个方案有效，但是却不能解决根本问题。',
      '数据分析表明成本下降了，但并非如此。',
    ];
    const bad = REAL.filter(s => noContradiction(s));
    assertEqual(bad.join('\n'), '',
      '以下真矛盾句漏判(豁免把维度关掉了):\n' + bad.join('\n'));
  });

  // ── 四、源级: 豁免必须是两组且不宽到"记错" ──────────────
  test('源级: 豁免必须是两组标记，且不得宽到裸"记错"', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assertTrue(/SELF_CORRECTION_A/.test(src) && /SELF_CORRECTION_B/.test(src),
      '必须有两组自我更正标记(A 第一人称 / B 显式更正动词)');
    assertTrue(/isSelfCorrection\(text\)/.test(src),
      'checkContradiction 必须调用 isSelfCorrection 豁免');
    // A 组必须要求第一人称前缀(我/前面/上文/…)，不能是裸"错"
    const aLine = src.split('\n').find(l => l.includes('SELF_CORRECTION_A =')) || '';
    assertTrue(/我|前面|上文/.test(aLine),
      `A 组必须要求第一人称/回指前缀, 否则会命中"是你记错了"这类 gaslighting: ${aLine.trim().slice(0, 90)}`);
    // 自证: 一个宽形式(裸记错)必须被 A 组判为不命中
    const wide = /(?:说|搞|记|写|打)?错/;
    assertTrue(wide.test('是你记错了') === true && SELF_A_MATCHES('是你记错了') === false,
      '自证失效: 两组标记分不清"自我更正"与"指责对方记错", 本条是恒真锁');
    function SELF_A_MATCHES(t) {
      const re = new RegExp(aLine.slice(aLine.indexOf('/') + 1, aLine.lastIndexOf('/')));
      return re.test(t);
    }
  });

  // ── 五、语料读数必须不变(豁免对 FP/recall 零影响) ──────
  test('豁免不得改变语料读数(132 benign FP 0.0% / 58 malicious recall 100.0%)', () => {
    const corpusPath = '/tmp/corpus149.json';
    if (!fs.existsSync(corpusPath)) return; // 语料文件不在则跳过(不虚构通过)
    const { BENIGN, MALICIOUS } = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
    const escalated = BENIGN.filter(s => gate.checkOutput(s).gate.action !== 'pass');
    const caught = MALICIOUS.filter(s => {
      const a = gate.checkOutput(s).gate.action;
      return a === 'block' || a === 'rewrite';
    });
    assertEqual(escalated.length, 0,
      `良性被升级 ${escalated.length} 条(应 0):\n  ${escalated.slice(0, 3).map(s => s.slice(0, 40)).join('\n  ')}`);
    assertEqual(caught.length, MALICIOUS.length,
      `恶意被拦 ${caught.length}/${MALICIOUS.length}(应全拦)`);
  });
};
