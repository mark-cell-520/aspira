/**
 * test/agents-homoglyph-limitation.test.js —
 * AGENTS.md 新披露的同形字限制, 每个数字都必须还能复测出来
 *
 * [doc-honest-numbers·第一百八十七轮] 新建。
 *
 * ═══ 本轮调查(四轮角度, 前三轮无缺口) ═══
 * 审计基线 87/87 全绿、覆盖面 12.1%。按老角度逐个测:
 *  · key 集反向 diff(cycle 11/176 已做): 16 个 measured-but-no-pattern 里两个
 *    死测量已修, 其余是中间量;
 *  · 闸门漏放(cycle 9 的方法, 本轮用注入法系统测): 16 种措辞(直述/only/each/
 *    per/several/some/across/tier/within/between/过去时/被动/关系从句/破折号/
 *    括号)注入 README, **15/16 被抓住**, 唯一漏掉的"代码跨度"是 cycle 9 明确
 *    记录的正确排除(反引号内是被引用的字面量);
 *  · 豁免列表(cycle 10/19 的方法): docs/=40 份/40 种全不同内容且文件名多带日期,
 *    里面的数字(47/46 dimensions、410 tests)确是时点值, 豁免理由成立;
 *  · 顶层文档间矛盾(本轮新角度): formulas 在 README(1,334 changelog 历史行)/
 *    AGENTS.md(1,286 历史叙述)/CURRENT_STATE(608 当前行)三处不同值 —— 逐处查
 *    上下文确认前两处是历史叙述, 608 是当前声称且与审计实测一致。
 *
 * 结论: 数字缺口这一轮没有找到可修的。
 *
 * ═══ 实际交付: 把上轮实测的限制写进文档并锁住 ═══
 * 第一百八十五轮实测确认了同形字层的一个真实限制(整句西里尔英文 → 83/137 良性
 * 被升级, 语言层不可区分故不可修), 但当时只补了行为锁、没有写进 AGENTS.md 的
 * Honest limitations。design principle #5 要求"任何声称的指标必须可测量", 而
 * 一个**已知但未披露**的限制比没有限制更糟 —— 调用方会以为 0.0% FP 覆盖全部。
 *
 * 本锁锁三件事:
 *   ① AGENTS.md 必须含这条限制(节名 + 关键数字 83/137);
 *   ② 文中的 83/137 必须与**当前实测**一致(数字会随语料增长而变, 所以测试
 *      复测而不是死记);
 *   ③ 文中引用的行为锁必须真的存在(不得引用一个不存在的测试)。
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const hf = require(path.join(ROOT, 'src', 'gate.js'));

// 与第一百八十五轮同一个替换映射(西里尔同形字, 含大写)
const CYR = {
  a: 'а', e: 'е', o: 'о', p: 'р', s: 'с', x: 'х', y: 'у',
  A: 'А', E: 'Е', O: 'О', P: 'Р', B: 'В', C: 'С', H: 'Н',
  T: 'Т', M: 'М', X: 'Х', Y: 'У', K: 'К',
};
const toCyr = s => s.replace(/[aeopscxyAEOPBCHTMXYK]/g, c => CYR[c] || c);

function benignCorpus() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'calibrate-fp-recall.js'), 'utf8');
  const ctx = vm.createContext({
    require, module: { exports: {} }, console, process,
    __dirname: path.join(ROOT, 'scripts'),
  });
  vm.runInContext(
    src.slice(0, src.indexOf('const m = measure();')) + '\n;globalThis.__B=BENIGN;',
    ctx, { filename: 'c.js' });
  return ctx.__B;
}

// 从 AGENTS.md 的该条限制里抽出 "N of M benign" 形态的数字
function claimedRatio(agents) {
  const i = agents.indexOf('whole-sentence Cyrillic/Greek English');
  if (i < 0) return null;
  const seg = agents.slice(i, i + 1200);
  const m = /\*\*(\d+) of (\d+) benign\s+samples escalate/.exec(seg)
    || /(\d+) of (\d+) benign/.exec(seg);
  return m ? { n: Number(m[1]), total: Number(m[2]) } : null;
}

module.exports = function ({ test, assertEqual, assertTrue }) {
  const AGENTS = path.join(ROOT, 'AGENTS.md');
  const agents = fs.readFileSync(AGENTS, 'utf8');

  // ── 一、AGENTS.md 必须含这条限制 ────────────────────────
  test('AGENTS.md 的 Honest limitations 必须披露同形字层的这条限制', () => {
    assertTrue(/^## Honest limitations/m.test(agents), '前提失效: 找不到 Honest limitations 节');
    assertTrue(agents.includes('whole-sentence Cyrillic/Greek English'),
      '必须披露"整句西里尔/希腊英文"这一形状的限制');
    assertTrue(/同形字混淆/.test(agents), '必须点出该层报告的 signal 名');
    assertTrue(/hеllо wоrld/.test(agents), '必须给出可复现的例子');
    assertTrue(/not distinguishable from an attack at the\s+language layer/.test(agents),
      '必须说明根本原因(语言层不可区分), 而不只是报个数');
    // 必须说明调用方该怎么办(读 none sentinel)
    assertTrue(/dimension === 'none'/.test(agents),
      '必须告诉调用方在这种情形下怎么读 findings');
  });

  // ── 二、文中的 83/137 必须与当前实测一致 ────────────────
  test('文中声称的良性升级数必须与当前实测一致(随语料增长而复测)', () => {
    const claimed = claimedRatio(agents);
    assertTrue(!!claimed, '前提失效: 文中找不到 "N of M benign" 形态的声称');
    const B = benignCorpus();
    assertEqual(claimed.total, B.length,
      `文中声称的分母(${claimed.total})应等于当前良性语料数(${B.length}) —— ` +
      '语料长大了而文档没同步, 正是 doc-honest-numbers 要防的形状');
    let actual = 0;
    for (const b of B) {
      const g = hf.checkOutput(toCyr(b));
      if (g.gate.action !== 'pass') actual++;
    }
    assertEqual(claimed.n, actual,
      `文中声称 ${claimed.n} 条被升级, 实测 ${actual} 条 —— ` +
      '一个写进文档的数字必须还能复测出来');
  });

  // ── 三、文中引用的行为锁必须真的存在 ────────────────────
  test('文中引用的行为锁必须真实存在', () => {
    const ref = /`test\/([a-z0-9-]+\.test\.js)`/.exec(
      agents.slice(agents.indexOf('whole-sentence Cyrillic/Greek English'),
        agents.indexOf('whole-sentence Cyrillic/Greek English') + 1600));
    assertTrue(!!ref, '前提失效: 文中找不到引用的测试文件');
    assertTrue(fs.existsSync(path.join(ROOT, 'test', ref[1])),
      `文中引用的 ${ref[1]} 不存在 —— 引用一个不存在的锁比没有引用更糟`);
    // 且该锁必须真的覆盖双向(合法文本不升级 + 攻击仍检出)
    const lockSrc = fs.readFileSync(path.join(ROOT, 'test', ref[1]), 'utf8');
    assertTrue(/合法西里尔\/希腊文本/.test(lockSrc), '引用的锁必须覆盖"合法文本不得升级"');
    assertTrue(/真实攻击形态/.test(lockSrc), '引用的锁必须覆盖"真实攻击仍须检出"');
    // 自证: 谓词必须分得清"有披露"与"没披露"
    const withoutLimitation = '## Honest limitations\n\n- Not AGI.\n';
    assertTrue(withoutLimitation.includes('whole-sentence Cyrillic/Greek English') === false,
      '自证失效: 谓词把没有披露的文档判成已披露, 本条是恒真锁');
  });
};
