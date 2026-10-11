/**
 * test/evasion-class-full-count.test.js
 *
 * [adversarial-robustness·第二百一十轮] 新建。
 *
 * ═══ 缺口 ═══
 * cycle 205 的汇总是 "of **twenty** evasion classes, nineteen read **60/60
 * content-bearing**, and only **English vowel-stripping** read **39/60**"，
 * cycle 206 继承为 "the other nineteen classes **untouched**"。
 *
 * 本轮实测(二十个类逐个跑, 不重新实现变换 —— 从校准脚本源码切出 EVASIONS
 * 表整段再 eval): 内容型样本 60 条, **满格的类是 18 个, 不是 19 个**。
 * 不满格的两个:
 *   · 字母间插空格  58/60  (漏 2)
 *   · 英文去元音    51/60  (漏 9)
 *
 * 而 letter-space 漏的那 2 条不是新退化, 正是 cycle 141 披露并锁在
 * test/letter-space-collapse.test.js 里的"未回收 2 条":
 *   'eval(res.data);' 变换后只有 6 个 token, 够不到 ≥8 门槛
 *   'const f = new Function(userInput);' 折叠成 newFunction 后模式不匹配
 * 那个测试有一条**反向守卫**: 这两条一旦被拦, 就必须更新披露。所以它们从
 * cycle 141 起一直是漏拦的 —— cycle 205 不可能读到 60/60。
 *
 * 也就是说: 这个汇总是从写下那一刻起就不准的, 并被继承了三轮。
 * 它是本切片的核心覆盖率读数("十九个类已满格"), 而它多数了一个。
 *
 * ═══ 修法 ═══
 * 不在原文上涂改(那会抹掉当时确实这样写过的事实), 而是补一条修正声明,
 * 并把"声明里的数字必须等于实测"钉成不变量 —— cycle 203 的做法: 锁
 * documented === measured, 不锁字面。语料会长, 类会变, 数字会动,
 * 但两者不许分开。
 *
 * ═══ 本锁 ═══
 * ① 行为: 跑全部变换类的内容型读数, 得出满格类数(当前 18)与 letter-space
 *    读数(当前 58/60)。这是实测侧, 不信任任何文档。
 * ② 文档: AGENTS.md 必须含本轮修正声明, 且声明里的满格类数与 letter-space
 *    读数必须与 ① 的实测**相等**。
 * ③ 反向证明: 把声明里的数字改错, ② 必须按名红。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');

  const ROOT = path.join(__dirname, '..');
  const CALIB = path.join(ROOT, 'scripts', 'calibrate-fp-recall.js');
  const AGENTS = path.join(ROOT, 'AGENTS.md');

  // ── 从校准脚本取出语料与 EVASIONS 表(不执行它: 它顶层跑完整校准并写 data/feedback/) ──
  function parseArray(name) {
    const src = fs.readFileSync(CALIB, 'utf8');
    const m = src.match(new RegExp('const ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\n\\];'));
    if (!m) throw new Error('找不到语料数组 ' + name);
    const out = [];
    for (const line of m[1].split('\n')) {
      const s = line.match(/^\s*'((?:[^'\\]|\\.)*)'/);
      if (s) out.push(s[1].replace(/\\'/g, "'"));
    }
    return out;
  }

  function loadEvasionTable() {
    const src = fs.readFileSync(CALIB, 'utf8');
    const start = src.indexOf('const EVASIONS = {');
    if (start < 0) throw new Error('找不到 EVASIONS 表');
    let i = src.indexOf('{', start), depth = 0, end = -1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) throw new Error('EVASIONS 表花括号不配对');
    const tableSrc = src.slice(start, end);
    if (!/const EVASIONS = \{/.test(tableSrc)) throw new Error('切出的不是 EVASIONS 表');
    const table = (new Function(tableSrc + '; return EVASIONS;'))();
    // 自证: 变换真的能跑(cycle 206: 探针改了副本而自证)
    if (table['字母间插空格']('ab') !== 'a b') throw new Error('字母间插空格变换未生效');
    return table;
  }

  // ── 一、实测: 满格类数与 letter-space 读数 ────────────────
  let measured = { full: -1, total: -1, letterRead: '', letterMiss: -1 };
  test('实测二十个逃逸类的内容型读数, 得出满格类数与 letter-space 读数', () => {
    const MAL = parseArray('MALICIOUS');
    const EVASIONS = loadEvasionTable();
    const gate = require(path.join(ROOT, 'src', 'gate.js'));
    const idx = require(path.join(ROOT, 'src', 'index.js'));

    const contentBearing = (t) => {
      try {
        const r = idx.discriminate(t, []);
        return (r.findings || []).some(f => f.dimension && f.dimension !== 'none');
      } catch (_) { return false; }
    };
    const CB = MAL.map(contentBearing);
    const cbTotal = CB.filter(Boolean).length;
    assertTrue(cbTotal > 0, '内容型样本数为 0 —— 语料形态变了?');

    const entries = Object.entries(EVASIONS);
    let full = 0, letterMiss = -1;
    for (const [, tf] of entries) {
      let miss = 0;
      for (let k = 0; k < MAL.length; k++) {
        if (!CB[k]) continue;
        let out;
        try { out = gate.checkOutput(tf(MAL[k])); } catch (_) { continue; }
        const a = out && out.gate && out.gate.action;
        if (a !== 'block' && a !== 'rewrite') miss++;
      }
      if (miss === 0) full++;
      // letter-space 单独记(下面文档侧要对齐的就是它)
      if (tf('ab') === 'a b') letterMiss = miss;
    }
    measured = {
      full, total: entries.length,
      letterRead: (cbTotal - letterMiss) + '/' + cbTotal,
      letterMiss,
    };
    // 打印实测(诚实数字, 让失败信息自带读数)
    console.log(`     实测: ${entries.length} 类 | 内容型样本 ${cbTotal} | 满格 ${full} 类 | letter-space ${measured.letterRead} (漏 ${letterMiss})`);
    assertTrue(full >= 0 && full <= entries.length, '满格类数越界');
    assertTrue(letterMiss >= 0, '没找到 letter-space 类 —— EVASIONS 表里没有它了?');
  });

  // ── 二、文档: 修正声明的数字必须等于实测 ──────────────────
  test('AGENTS.md 的逃逸类覆盖修正声明必须与实测相等(不锁字面, 锁不变量)', () => {
    assertTrue(measured.full >= 0, '前提失效: 用例一没跑或没测出读数');
    const md = fs.readFileSync(AGENTS, 'utf8');

    // 修正声明的形态(本轮写入, 见 AGENTS.md 末尾):
    //   「内容型满格的类是 18 个，不是 19 个」
    //   「字母间插空格实为 58/60」
    // 谓词刻意容忍 markdown 粗体星号: 声明是给人读的, 措辞该保持自然,
    // 不该为了迁就正则把"**"塞进去或拆掉。
    const seg = md.slice(md.indexOf('第二百一十轮实测'));
    assertTrue(seg.length > 40, 'AGENTS.md 应含本轮逃逸类覆盖修正声明(锚点 "第二百一十轮实测")');

    const fullDoc = (/满格的类是 \*{0,2}(\d+) 个/.exec(seg) || [])[1];
    assertTrue(!!fullDoc, '修正声明必须写明"满格的类是 N 个"');
    assertEqual(Number(fullDoc), measured.full,
      `AGENTS.md 修正声明说满格 ${fullDoc} 个, 而实测 ${measured.full} 个 —— ` +
      '文档与仪器对同一个量给出两个数');

    const lsDoc = (/字母间插空格实为 \*{0,2}(\d+\/\d+)/.exec(seg) || [])[1];
    assertTrue(!!lsDoc, '修正声明必须写明"字母间插空格实为 N/M"');
    assertEqual(lsDoc, measured.letterRead,
      `AGENTS.md 修正声明说字母间插空格 ${lsDoc}, 而实测 ${measured.letterRead}`);

    // 原来的错读数不许被静默涂掉 —— 必须仍在原文里可辨(涂了就是抹证)
    assertTrue(/nineteen read \*\*60\/60 content-bearing\*\*/.test(md),
      'cycle 205 原句应仍在原文中(本轮的修法是补修正声明, 不是涂掉当时确实这样写过的读数)');
  });

  // ── 三、反向证明: 把声明里的数字改错, 第二例必须按名红 ────
  test('反向证明: 改错修正声明里的满格类数, 文档用例必须红(锁能失败)', () => {
    assertTrue(measured.full >= 0, '前提失效: 用例一没跑');
    const md = fs.readFileSync(AGENTS, 'utf8');
    const anchor = '第二百一十轮实测';
    assertTrue(md.includes(anchor), 'AGENTS.md 应含修正声明锚点');

    // 在内存里改错(不落盘), 复用例二的谓词
    const seg = md.slice(md.indexOf(anchor));
    const orig = (/满格的类是 \*{0,2}(\d+) 个/.exec(seg) || [])[1];
    assertTrue(!!orig, '修正声明必须含"满格的类是 N 个"');
    const wrong = String(Number(orig) + 1);
    const mutated = seg.replace(new RegExp('满格的类是 \\*{0,2}' + orig + ' 个'), '满格的类是 ' + wrong + ' 个');
    assertTrue(mutated !== seg, '变异未生效 —— 锚点没匹配上, 本次反向证明无效');
    const mutatedFull = (/满格的类是 \*{0,2}(\d+) 个/.exec(mutated) || [])[1];
    assertEqual(Number(mutatedFull) === measured.full, false,
      `把声明从 ${orig} 改成 ${wrong} 后, 它与实测 ${measured.full} 仍然相等 —— ` +
      '说明用例二的等式抓不到"数字被改错", 那把锁是装饰');
  });
};
