/**
 * test/dimension-checker-resolution.test.js
 *
 * [dimension-health-audit·第二百一十四轮] 新建。
 *
 * ═══ 缺口 ═══
 * `scripts/dimension-health-audit.js` 的 DIM_CHECKERS 登记了 54 项
 * `[维度, check 函数名]`, 而 `regexLiteralInputs()` 逐个取函数体:
 *
 *     const body = functionBody(fn);
 *     if (!body) continue;          // ← 找不到就**静默跳过**
 *
 * `functionBody` 原来只在 `src/index.js` 的文本里找 `function <fn>(`。
 * 本轮实测(54 项逐条对 index.js 找 function 声明): **7 项在 index.js 里根本不存在**,
 * 它们住在各自的模块里, 由 index.js 经 `_mt.checkXxx()` / `_di.checkXxx()` 调用:
 *
 *     phishing_coercion       → src/manipulation-tactics.js:128
 *     induced_trust           → src/manipulation-tactics.js:134
 *     coverup_induction       → src/manipulation-tactics.js:140
 *     dangerous_instruction   → src/dangerous-instruction.js:395
 *     reward_hacking          → src/reward-hacking.js:1337
 *     perfect_error           → src/perfect-error.js:98
 *     premature_termination   → src/premature-termination.js:76
 *
 * 后果不是"少几个输入": 来源 C(引擎正则片段)对这 7 个维度**恒为 0**, 而它们的
 * finding 各有几十条 —— 也就是说这 7 个维度的"引擎自己的正则"这一路覆盖从未
 * 存在过, 而仪器的四个汇总数(53 触发推 finding / 1 仅打分 / 0 从不推 /
 * 0 未触发)一直是绿的。**一个只读眼前那一份文件的诊断, 看不到实现就在隔壁目录。**
 * 这是 cycle 192 的形状(四个 MCP 工具的实现就在 src/ 根下而诊断只看 src/core/)。
 *
 * ═══ 修法 ═══
 * 建一张全局索引(函数名 → 函数体, 常量名 → 声明文本), index.js 找不到时查它。
 * 不改 DIM_CHECKERS(那要给 54 项各加模块名, 且每加一个模块化 check 都要再改)。
 *
 * 修的过程里撞出第二个缺陷: 索引自己的花括号配对从 `function <name>(` 之后找
 * 第一个 `{`, 而 `checkPrematureTermination(text, ctx = {})` 的**默认参数里就有
 * 花括号** —— 配对配到默认参数的那个 `}`, 函数体取成空串, 于是这个函数又被静默
 * 丢掉。修法是先括号配对跨过整个参数列表, 再找函数体的 `{`。
 *
 * ═══ 实测(修前 → 修后) ═══
 *   正则片段池      2778 → 3173   (+395; 7 个里 6 个开始有片段产出)
 *   premature_termination 的来源 C  11 → 12
 *   induced_trust 的来源 C            0 →  1
 *   四个汇总数      不变(53 / 1 / 0 / 0)
 *
 * +395 条片段只推出 +2 条 finding, 原因披露在下方第六例: 这些维度的模式是
 * **共现模式**(要求两个词簇同时出现), 而池 C 的合成器只能从一条正则里剥出
 * **最长的一段字面量** —— 结构上表达不了共现。这是 cycle 11 早已记录的
 * "不可合成"一类。所以本轮是**关掉一个仪器盲区**, 不是把某个读数从错变对。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');

  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'dimension-health-audit.js');

  // 被 require 时不跑主流程(require.main !== module), 只拿两个解析器。
  const lib = require(SCRIPT);
  const { DIM_CHECKERS, functionBody, declarationText, FN_BODY_INDEX } = lib;

  // 本轮实测: 这 7 个 check 函数不在 src/index.js 里
  const MODULE_RESIDENT = [
    ['phishing_coercion', 'checkPhishingCoercion'],
    ['induced_trust', 'checkInducedTrust'],
    ['coverup_induction', 'checkCoverupInduction'],
    ['dangerous_instruction', 'checkDangerousInstruction'],
    ['reward_hacking', 'checkRewardHacking'],
    ['perfect_error', 'checkPerfectError'],
    ['premature_termination', 'checkPrematureTermination'],
  ];

  // ── ① 54 个 check 函数名必须全部解析出非空函数体 ──────────────
  // 这一例就是原缺陷的锁: 任何一个维度回到"解析不到 → if (!body) continue"
  // 的静默跳过, 它必须按名红。
  test('DIM_CHECKERS 的 54 个函数名必须全部解析出非空函数体', () => {
    const unresolved = [];
    for (const [dim, fn] of DIM_CHECKERS) {
      const body = functionBody(fn);
      if (!body || !body.trim()) unresolved.push(`${dim} → ${fn}`);
    }
    assertEqual(unresolved.length, 0,
      '这些维度的 check 函数解析不到函数体, 来源 C 对它们恒为 0: ' + unresolved.join(', '));
    // 前提自证: 表真的是 54 项, 否则"全部解析"可能因为表是空的而恒真
    assertEqual(DIM_CHECKERS.length, 54, 'DIM_CHECKERS 应为 54 项');
  });

  // ── ② 模块化 check 函数引用的**常量表**必须解析得到 ────────────
  // 只修 functionBody 不够: 函数体找回来了, 但函数体里抓出的常量名若仍在
  // index.js 里找不到声明, 来源 C 依旧取不到那个维度(实测第一遍修复就是这样:
  // 池只从 2778 涨到 2779)。
  //
  // 范围要收窄: 这 7 个函数体引用的常量不全是表。实测 reward_hacking 引用了
  // DEV_DEBUG / DISCOURSE_FRAME / UPSTREAM_PATCH … 它们是**正则字面量**
  // (`const X = /…/`), 本来就写在函数体里, decls 索引不收录它们也不该收录。
  // 第一版把"引用的所有常量"都要求解析, 于是一次报出 18 个"解析不到",
  // 而这 18 个全是正则字面量 —— **一把锁因为认不出自己该管什么而全红**。
  // 判据改为: 该名字是否在 src/ 里以 `const NAME = [` / `= {` 的形式声明。
  // 这个扫描是**独立实现**(自己的正则、自己的遍历), 与索引的 walk 不是同一份
  // 代码, 所以两者不一致时会红 —— 不是拿索引证明索引自己。
  test('模块化 check 函数引用的常量表必须解析得到', () => {
    const SRC = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
    const UPPER_RE = /\b([A-Z][A-Z0-9_]{3,})\b/g;
    const SKIP = ['VERIFY', 'BLOCK', 'REWRITE', 'GUIDANCE', 'VERDICT', 'PENALTY', 'ACTION', 'MCP', 'JSON', 'HTTP', 'SSE', 'UTF'];

    // 独立扫描: src/ 下所有 `const/let/var NAME = [` 或 `= {`
    const tableNames = new Set();
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name === 'archive' || e.name === 'node_modules') continue;
          walk(p); continue;
        }
        if (!/\.js$/.test(e.name)) continue;
        let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
        const re = /(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=\s*([[{])/g;
        let m;
        while ((m = re.exec(txt))) tableNames.add(m[1]);
      }
    })(path.join(ROOT, 'src'));

    const unresolved = [];
    const checked = [];
    for (const [dim, fn] of MODULE_RESIDENT) {
      const body = functionBody(fn) || '';
      const names = new Set();
      let m; UPPER_RE.lastIndex = 0;
      while ((m = UPPER_RE.exec(body))) {
        const n = m[1];
        if (SKIP.some(p => n.startsWith(p))) continue;
        names.add(n);
      }
      for (const n of names) {
        // index.js 里就有的, 不关本轮事
        if (new RegExp('(?:const|let|var)\\s+' + n + '\\s*=\\s*').test(SRC)) continue;
        if (!tableNames.has(n)) continue;   // 正则字面量 / 数字, 不是表
        checked.push(`${dim} → ${n}`);
        if (!declarationText(n)) unresolved.push(`${dim} → ${n}`);
      }
    }
    // 前提自证: 这一例必须真的检查到了东西。 dangerous_instruction 的函数体
    // 一个常量名都没有(它的模式表住在私有 helper _matchAll 里), 所以 7 个里
    // 有 1 个贡献 0 张表; 修后实测其余 6 个共引用 17 张表, 全部解析得到。
    // 这个数不是锁死的字面(引擎会长), 只要求不少于 3 —— 掉到 0 就说明被查的
    // 函数体变了, 本例外壳还在、内容已空。
    assertTrue(checked.length >= 3,
      `本例外只检查到 ${checked.length} 张常量表(修后实测 17) —— ` +
      '若为 0 说明被查的函数体变了, 本例外已空转');
    assertEqual(unresolved.length, 0,
      '这些常量表解析不到, 来源 C 仍取不到对应维度: ' + unresolved.join(', '));
  });

  // ── ③ 默认参数里的花括号不能吃掉函数体 ────────────────────────
  // checkPrematureTermination(text, ctx = {}) —— 括号配对若从声明后找第一个 `{`,
  // 会配到默认参数的 `}`, 函数体取成空串, 该维度又被静默丢掉。
  test('带默认对象参数的函数体必须完整取出', () => {
    const body = functionBody('checkPrematureTermination');
    assertTrue(!!body && body.length > 200,
      `checkPrematureTermination 函数体只有 ${body ? body.length : 0} 字符 —— ` +
      '括号配对很可能配到了默认参数 ctx = {} 的那个 }');
    assertTrue(/trimmed/.test(body),
      '函数体里找不到 trimmed —— 取到的不是完整函数体');
    assertTrue(/isPremature/.test(body), '函数体里找不到 isPremature —— 取到的不是完整函数体');
  });

  // ── ④ 池 C 必须确实变大(修复生效的回归护栏) ───────────────────
  // 修前实测 2778 条。这不是精确值而是**地板**: 语料与引擎正则都在长,
  // 锁"比修前大"而不是"等于某个数"。取值 3000 是修后实测 3173 与修前 2778
  // 之间的宽松中点。
  test('正则片段池必须大于修复前的规模', () => {
    const before = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/FN_BODY_INDEX/.test(before), '脚本里应存在全局索引 FN_BODY_INDEX');
    const n = lib.regexLiteralInputs().length;
    assertTrue(n > 3000,
      `正则片段池只有 ${n} 条, 不高于修复前实测的 2778 —— 全局索引没起作用?`);
  });

  // ── ⑤ 反向证明: 把解析改回"只读 index.js", ① 必须按名红 ───────
  // 在 /tmp 副本上做, 不动仓库源文件(本测试并不持 doc-probe 锁, 而并发跑者
  // 里有别的测试在读这个脚本的源)。ROOT 钉死为绝对路径 —— cycle 209 实测:
  // 副本落 /tmp 后 ROOT 变 /, 启动就 ENOENT, 反向证明会因环境错而绿。
  test('反向证明: 解析改回只读 index.js 时①必须红', () => {
    const tmp = path.join(require('os').tmpdir(), 'dimhealth-srconly-214.cjs');
    const orig = fs.readFileSync(SCRIPT, 'utf8');
    let broken = orig.replace(
      'return FN_BODY_INDEX.get(name) || null;',
      'return null; // [第二百一十四轮反向证明] 只读 index.js'
    );
    broken = broken.replace(
      "const ROOT = path.join(__dirname, '..');",
      'const ROOT = ' + JSON.stringify(ROOT) + ';'
    );
    try {
      assertTrue(broken !== orig, '变异未生效 —— 锚点没打中, 本次反向证明无效');
      assertTrue(broken.includes('return null; // [第二百一十四轮反向证明]'),
        '变异没落在 functionBody 上');
      fs.writeFileSync(tmp, broken);
      // 清掉 require 缓存, 确保加载的是副本
      delete require.cache[require.resolve(tmp)];
      const b = require(tmp);
      const unresolved = [];
      for (const [dim, fn] of b.DIM_CHECKERS) {
        const body = b.functionBody(fn);
        if (!body || !body.trim()) unresolved.push(dim);
      }
      assertTrue(unresolved.length >= 7,
        `只读 index.js 时应至少 7 个维度解析不到(实测 7), 实际 ${unresolved.length} —— ` +
        '说明① 的断言抓不到这个缺陷形态, 它是装饰');
      // 精确对准: 必须正是本轮点名的那 7 个
      const expect = MODULE_RESIDENT.map(([d]) => d).sort();
      assertEqual(unresolved.slice().sort().join(','), expect.join(','),
        '解析不到的维度集合与本轮实测的 7 个不一致');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
      try { delete require.cache[require.resolve(tmp)]; } catch (_) {}
    }
  });

  // ── ⑥ 披露: dangerous_instruction 的片段仍是 0, 且原因是结构性的 ──
  // 修后实测: dangerous_instruction 自己贡献 0 条池 C 片段。它的 check 函数体是
  //     const r = _matchAll(text); return { count: r.count, hits: r.hits, score: r.score };
  // 一个常量名都没有 —— 三张模式表(DANGEROUS_PATTERNS / CRIME_TEACHING_PATTERNS /
  // SELF_HARM_PATTERNS)住在私有 helper `_matchAll` 里, 而它不被函数体点名。
  // 本轮量过"再跟一层被调函数": 池只从 3173 涨到 3186(+13), dangerous_instruction
  // 从 0 涨到 3 —— 净收益不值那套机制, 故不加, 记为披露。
  // 若将来修好(它开始贡献片段), 把本例外反转。
  test('披露: dangerous_instruction 仍贡献 0 条片段(私有 helper 后的模式表)', () => {
    const body = functionBody('checkDangerousInstruction') || '';
    const upper = (body.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) || []).filter(
      n => !['VERIFY', 'BLOCK', 'REWRITE', 'GUIDANCE', 'VERDICT', 'PENALTY', 'ACTION', 'MCP', 'JSON', 'HTTP', 'SSE', 'UTF'].some(p => n.startsWith(p))
    );
    assertEqual(upper.length, 0,
      'checkDangerousInstruction 的函数体现在点名了常量(' + upper.join(',') + ') —— ' +
      '说明模式表已回到它自己体内, 请把本例外反转(它不再是披露而是缺陷)');
    // 前提自证: 函数体本身必须解析得到(否则上一条断言因空体而恒真)
    assertTrue(body.length > 20, 'checkDangerousInstruction 函数体应解析得到');
  });
};
