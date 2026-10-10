/**
 * test/vowel-strip-short-term-rejection.test.js —
 * 骨架长度门槛 6 挡住的那 21 条良性碰撞, 只有源级锁没有行为锁
 *
 * [fp-recall-calibration·第一百八十六轮] 新建。
 *
 * ═══ 一轮三次实测排除的调查 ═══
 * 本轮基线: 明文 100% / FP 0.0%, 缺口类仍是去元音 41/62(21 条内容型漏报:
 * 8 代码 + 12 slur + 1 社工框架)。前三轮已实测判死代码型(结构判据 6/158 误报)
 * 与社工框架型(纯正则路线三条全否), 本轮攻剩下的 12 条 slur。
 *
 * ═══ 方向一: 短语级硬编码骨架 —— 0 误报但是背语料 ═══
 * 从 8 条 slur 样本提取"术语 + 伴生词"的短语骨架(niggrsmstd /
 * spcsndkksndchnks / …), 实测 137 良性 **0 误报**、8 条样本 **8/8 命中**,
 * 看起来完美。但这是**把语料背下来**: 每条短语都是从这 8 条样本里长出来的,
 * 换一个没见过的 slur 短语就不命中。真正的判据必须通用。
 *
 * ═══ 方向二: 通用化的上下文骨架 —— 21/137 误报, 判死 ═══
 * 改成通用规则: 短术语骨架命中时, 取其前后各 5 字符做"上下文骨架",
 * 总长 >= 9 才算。实测 **21/137 误报**, 命中的正是 AGENTS.md 记录过的同一批:
 *   coon ← concise / content(骨架 cncs / cntnts 含 cn)
 *   slut ← results(rslts 含 slt)
 *   whore ← WHERE(whr)
 *   paki  ← write("<p>"(wrtpk 含 pk)
 * 这证明方向一的 0 误报是**过拟合到语料**的结果, 不是判据的性质。
 *
 * ═══ 关键对照: 那 21 条在现有引擎下并没有被升级 ═══
 * 实测(去元音后 gate 真的升级的良性): **0/137**。因为
 * checkVowelStripEvasion 的 `skel.length < 6` 门槛仍然挡住它们 ——
 * 我的候选判据会命中, 现有引擎不会。
 * **所以方向二不是"修好了漏报", 是"引入了 21 条新误报"。**
 *
 * ═══ 结论: 短 slur 在去元音类下判据性不可修 ═══
 * 短术语骨架(nigger→nggr 4 字符)信息量不足, 与常见英文词的骨架碰撞;
 * 加长到上下文则碰撞更多。这与 AGENTS.md 已记录的判断一致, 本轮是第三次确认
 * (cycle 172 首测、175 测密度、186 测上下文)。
 *
 * ═══ 本轮的实际交付: 补上门槛的行为锁 ═══
 * `skel.length < 6` 门槛已有**源级**锁(test/vowel-strip-evasion.test.js 断言
 * 源码里有 `/skel\.length\s*<\s*6/`), 但没有**行为**锁 —— 而 cycle 141/158
 * 记录过"放宽它净负", 那是历史测量不是锁。本锁把两件事钉住:
 *   ① 门槛降到 3(放宽松 slur 骨架)必须让 137 良性里的碰撞样本被升级
 *      —— 即"放宽真会误报"这件事是可测的, 未来有人想放宽时先看见代价;
 *   ② 现有门槛下这 21 条碰撞样本必须**全部保持 pass**。
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const hf = require(path.join(ROOT, 'src', 'gate.js'));
const { checkVowelStripEvasion } = require(path.join(ROOT, 'src', 'shield', 'letter-space-evasion.js'));

const stripVowels = s => s.replace(/[aeiouAEIOU]/g, '');

// 从语料取全部良性样本
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

module.exports = function ({ test, assertEqual, assertTrue }) {
  // ── 一、现有门槛下碰撞样本必须全部保持 pass ─────────────
  test('现有门槛下, 短术语骨架会碰撞的良性样本必须全部保持 pass', () => {
    const B = benignCorpus();
    assertTrue(B.length >= 100, `前提失效: 良性语料应 >= 100 条, 实测 ${B.length}`);
    const bad = [];
    for (const b of B) {
      const g = hf.checkOutput(stripVowels(b));
      if (g.gate.action !== 'pass') bad.push(`${g.gate.action} | ${b.slice(0, 40)}`);
    }
    assertEqual(bad.join('\n'), '', '以下良性样本在去元音后被升级:\n' + bad.join('\n'));
  });

  // ── 二、checkVowelStripEvasion 对碰撞样本必须不命中 ──────
  test('checkVowelStripEvasion 对短术语碰撞样本必须不命中(门槛在起作用)', () => {
    // 这些样本的骨架含短术语骨架(coon→cn / slut→slt / whore→whr / paki→pk),
    // 但整段骨架长度不够或短术语本身被 < 6 门槛挡掉。
    const collisions = [
      'The executive summary was clear and concise.',   // cncs 含 coon 的 cn
      'I need to evaluate the results carefully before submitting.',
      'SELECT * FROM users WHERE id = 1',               // whr 含 whore 的 whr
      'Can you explain the difference between let and const?',
    ];
    const bad = [];
    for (const t of collisions) {
      const r = checkVowelStripEvasion(stripVowels(t));
      if (r.detected) bad.push(`命中: ${t.slice(0, 40)} → ${JSON.stringify(r.hits.map(h => h.term))}`);
    }
    assertEqual(bad.join('\n'), '', '以下碰撞样本被同层误报:\n' + bad.join('\n'));
  });

  // ── 三、放宽门槛的代价必须是可测的(行为证明) ─────────────
  test('放宽骨架门槛到 3 必须让碰撞样本被命中(证明门槛不是装饰)', () => {
    // 在副本上把门槛从 6 降到 3, 验证碰撞样本开始被命中 —— 这就是"放宽的代价"。
    // 共享源只读(cycle 22): 副本放 src/shield/ 内同相对深度。
    const src = fs.readFileSync(path.join(ROOT, 'src', 'shield', 'letter-space-evasion.js'), 'utf8');
    const OLD = 'if (skel.length < 6) continue;';
    assertTrue(src.includes(OLD), '前提失效: 未匹配骨架门槛(锚点已变, 反向证明无效)');
    const relaxed = src.replace(OLD, 'if (skel.length < 3) continue;');
    assertTrue(relaxed !== src, '前提失效: 替换后无变化');
    const COPY = path.join(ROOT, 'src', 'shield', '_lse-threshold-probe.js');
    try {
      fs.writeFileSync(COPY, relaxed);
      delete require.cache[require.resolve(COPY)];
      const mod = require(COPY);
      const collisions = [
        'The executive summary was clear and concise.',
        'SELECT * FROM users WHERE id = 1',
        'Can you explain the difference between let and const?',
      ];
      let newlyHit = 0;
      for (const t of collisions) {
        const before = checkVowelStripEvasion(stripVowels(t)).detected;
        const after = mod.checkVowelStripEvasion(stripVowels(t)).detected;
        if (!before && after) newlyHit++;
      }
      assertTrue(newlyHit >= 1,
        `放宽门槛到 3 后应有碰撞样本开始被命中(实测 ${newlyHit}/3) —— ` +
        '若一个都没有, 说明这个门槛挡着的东西测不出来, 本条是恒真锁');
      // 同时确认原版对同样样本仍不命中(证明差别来自门槛而非别处)
      const stillClean = collisions.every(t => !checkVowelStripEvasion(stripVowels(t)).detected);
      assertTrue(stillClean, '原版(门槛 6)必须仍对这些样本不命中');
      delete require.cache[require.resolve(COPY)];
    } finally {
      if (fs.existsSync(COPY)) fs.unlinkSync(COPY);
    }
    // 共享源必须未被改动
    assertEqual(fs.readFileSync(path.join(ROOT, 'src', 'shield', 'letter-space-evasion.js'), 'utf8'), src,
      '共享的 letter-space-evasion.js 必须未被本测试改动');
  });

  // ── 四、源级: 门槛必须是 6 且不得被改成上下文方案 ───────
  test('源级: 骨架门槛必须保持 6, 且不得引入上下文骨架方案', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'shield', 'letter-space-evasion.js'), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, m => ' '.repeat(m.length))).join('\n');
    const i = src.indexOf('function checkVowelStripEvasion(');
    assertTrue(i > 0, '前提失效: 找不到 checkVowelStripEvasion');
    const seg = src.slice(i, src.indexOf('\n}', i));
    assertTrue(/skel\.length\s*<\s*6/.test(seg), '骨架长度门槛必须保持 6');
    assertTrue(/textSkel\.length\s*<\s*6/.test(seg), '整段骨架长度门槛必须保持 6');
    // 不得引入上下文骨架(本轮实测它在通用化后 21/137 误报)
    assertTrue(!/slice\([^)]*-\s*\d+[^)]*\)/.test(seg),
      '不得引入"取前后 N 字符"的上下文骨架 —— 本轮实测它在通用化后 21/137 误报');
    // 自证: 谓词必须分得清"有门槛"与"没门槛"
    const noThreshold = 'for (const term of TERMS) { if (textSkel.includes(stripAll(term))) hits.push(term); }';
    assertTrue(/skel\.length\s*<\s*6/.test(noThreshold) === false,
      '自证失效: 谓词分不清有门槛与没门槛, 本条是恒真锁');
  });
};
