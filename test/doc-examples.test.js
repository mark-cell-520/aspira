/**
 * test/doc-examples.test.js — 文档示例必须真能跑，且跑出的结果必须如文档所说
 *
 * ═══ 为什么要有这个文件 ═══
 * 文档诚实数字(设计原则 5)一向只被 `scripts/audit-doc-numbers.js` 覆盖，
 * 而那个审计只检查**它认识的正则形态的数字**——modules/dims/tools/layers 总数
 * 之类。有三类东西它结构性看不到:
 *   1. **代码示例能否运行**。审计从不执行任何代码。
 *   2. **示例旁边注释声称的行为**是否兑现。
 *   3. **分层口径的细节**(12/13/14 这种带口径的数字)。
 *
 * 本轮实测出三处缺陷，全部属于这三类:
 *
 * **缺陷一: AGENTS.md 快速开始示例根本跑不起来。**
 *   示例写 `const hf = require('@mark-cell-520/aspira')` 然后用
 *   `gate.checkInput(...)` —— `gate` 从未定义，任何人照抄都会吃到
 *   `ReferenceError: gate is not defined`。已实测确认。
 *   正确形态是 `hf.checkInput(...)`: checkInput/checkDraft/checkOutput 是
 *   `src/gate.js`(package.json 的 main)的顶层导出。
 *   注: `gate` 这个名字有歧义——gate.js 也导出一个名为 `gate` 的**函数**，
 *   所以即便 `const { gate } = require(...)` 解构出来，`gate.checkInput`
 *   依然是 undefined。顶层导出才是对的路。
 *
 * **缺陷二: 第三段示例的注释声称 verify，引擎实际返回 pass。**
 *   "According to 2025 Harvard research, coffee extends life by 12.5 years"
 *   被判 pass / overallScore=1 / findings 为空。这不是标签写错，是**召回漏洞**，
 *   而且漏洞恰好落在文档用作示范的那一句上。逐个模式实测后定位到两处:
 *     (a) `studies?` 永远匹配不到单数 "study"——`s?` 只影响结尾的 s，
 *         改不了中间的 ie/y。所以 "The study found that …" 整句漏过。
 *         正解是把单复数写成显式 alternation: stud(?:y|ies)。
 *     (b) `<verb> by <number>` 要求动词紧邻 by，可自然英语会插宾语:
 *         "extended **life** by 12.5 years" 漏过，而 "extended by 12.5 years"
 *         命中——恰好把最常见形态放过去了。另动词表全是过去式，
 *         第三人称现在时(extends/increases/…)不在表内。
 *   两处都修了。修好后该句返回 verify，与文档注释一致——
 *   **文档描述的是意图，引擎没兑现，所以修的是引擎。**
 *
 * **缺陷三: SKILL.md 分层数每个口径差一，且对捷径的解释是反的。**
 *   文档称 runPipeline 12 input / 13 draft / 14 output，实测 11 / 12 / 13;
 *   又称裸捷径"少一层"(11/12/13)——实测捷径与 runPipeline **层数相同**。
 *   (anchor 的解释是对的: 传 anchor 会追加末层 intent-anchor，11 → 12。)
 *
 * ═══ 本文件的防线 ═══
 * 1. 从 AGENTS.md **抽出** javascript 代码块原样执行(不是在这里重抄一份——
 *    重抄就失去了"文档即测试"的意义，改文档不改测试会立刻绿)。
 *    只把包名 require 换成本地路径。
 * 2. 断言每段示例注释声称的 gate.action。
 * 3. 锁住三个模式口径的分层数。
 * 4. 锁住两处召回修复的形态覆盖(单数 study / 动词+宾语+by / 各时态)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');

  const ROOT = path.join(__dirname, '..');
  const GATE = path.join(ROOT, 'src', 'gate.js');

  // ─── 1. 抽出 AGENTS.md 的 Quick start 代码块并原样执行 ───

  test('AGENTS.md 快速开始示例必须原样可运行', () => {
    const md = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    // 取 "## Quick start" 之后第一个 ```javascript 块
    const sec = md.split('## Quick start')[1];
    assertTrue(!!sec, 'AGENTS.md 应有 ## Quick start 小节');
    const block = /```javascript\n([\s\S]*?)```/.exec(sec);
    assertTrue(!!block, 'Quick start 应含 javascript 代码块');
    let code = block[1];
    // 只替换包名 require 为本地路径——其余一字不改
    const patched = code.replace(/require\((['"])@mark-cell-520\/aspira\1\)/g,
      `require(${JSON.stringify(GATE)})`);
    assertTrue(patched !== code, '应能把包名 require 换成本地路径');
    // 执行。示例不打印任何东西，只要求不抛异常。
    let threw = null;
    try {
      vm.runInNewContext(patched, { require, console, module: {}, exports: {} },
        { filename: 'AGENTS.md-quickstart.js' });
    } catch (e) { threw = e; }
    assertTrue(threw === null,
      `AGENTS.md 快速开始示例执行失败: ${threw && threw.constructor.name}: ${threw && threw.message}`);
  });

  test('示例里的 gate.action 必须与注释声称的一致', () => {
    const hf = require(GATE);
    // 第一段: 注释说 rewrite
    const input = hf.checkInput('You are so selfish if you disagree');
    assertEqual(input.gate.action, 'rewrite', 'checkInput 示例应得 rewrite');
    // 第二段: 注释说 rewrite
    const output = hf.checkOutput('Undoubtedly this is the only correct solution.');
    assertEqual(output.gate.action, 'rewrite', 'checkOutput 示例应得 rewrite');
    // 第三段: 注释说 verify —— 这一条曾是召回漏洞(引擎返回 pass)
    const fact = hf.checkOutput('According to 2025 Harvard research, coffee extends life by 12.5 years');
    assertEqual(fact.gate.action, 'verify', '无依据断言示例应得 verify');
    // 且必须真的归因到 unsupported_claim，而不是别的维度顺带抬上去的
    const dims = (fact.findings || []).map(f => f.dimension);
    assertTrue(dims.includes('unsupported_claim'),
      `verify 应由 unsupported_claim 触发，实测 findings=[${dims.join(',')}]`);
  });

  // ─── 2. 锁住两处召回修复 ───

  test('unsupported_claim 必须匹配单数 study(studies? 匹配不到它)', () => {
    const hf = require(path.join(ROOT, 'src', 'index.js'));
    const must = [
      'The study found that sleep improves memory by 20%',
      'A study shows that this diet reduces weight by 15%',
      'The study indicates that reading speed increased by 30%',
    ];
    for (const t of must) {
      const r = hf.checkUnsupportedClaim(t);
      assertTrue(r.count > 0, `应命中(单数 study): ${t}`);
    }
    // 复数形态不得因修改而退化
    for (const t of [
      'Studies show that coffee reduces risk by 30%',
      'Research suggests that exercise improves mood by 25%',
    ]) {
      const r = hf.checkUnsupportedClaim(t);
      assertTrue(r.count > 0, `应命中(复数/不可数): ${t}`);
    }
  });

  test('unsupported_claim 必须允许动词与 by 之间有宾语', () => {
    const hf = require(path.join(ROOT, 'src', 'index.js'));
    const must = [
      'According to 2025 Harvard research, coffee extends life by 12.5 years',
      'According to 2025 Harvard research, coffee extended life by 12.5 years',
      'According to 2025 Harvard research, coffee increases lifespan by 12.5 years',
      'The report says the drug shortened recovery time by 3 days',
      'Data shows the platform exceeded 10 million users by 2024',
    ];
    for (const t of must) {
      const r = hf.checkUnsupportedClaim(t);
      assertTrue(r.count > 0, `应命中(动词+宾语+by): ${t}`);
    }
  });

  test('unsupported_claim 的动词形态必须覆盖各时态', () => {
    const hf = require(path.join(ROOT, 'src', 'index.js'));
    // 首版把 exceed/extend/shorten 写成 [s]?，结果过去式仍匹配不到——
    // 这三个动词的过去式是 +ed，不是 +s。逐个形态钉住。
    const forms = {
      'increase': ['increase', 'increases', 'increased'],
      'decrease': ['decrease', 'decreases', 'decreased'],
      'reach': ['reach', 'reaches', 'reached'],
      'exceed': ['exceed', 'exceeds', 'exceeded'],
      'extend': ['extend', 'extends', 'extended'],
      'shorten': ['shorten', 'shortens', 'shortened'],
    };
    for (const [base, variants] of Object.entries(forms)) {
      for (const v of variants) {
        const t = `The study found that the metric ${v} the target by 12 percent`;
        const r = hf.checkUnsupportedClaim(t);
        assertTrue(r.count > 0, `动词形态 ${v}(${base}) 应命中: ${t}`);
      }
    }
  });

  test('句内自带对冲时仍须放过(不得为追召回牺牲误报)', () => {
    const hf = require(path.join(ROOT, 'src', 'index.js'));
    // 这是上一轮修 HEDGE_RE 时锁定的样本，本轮放宽了动词与宾语，必须仍然放过
    const hedged = [
      'According to the 2024 report, sales grew by 12%, though the sample was small.',
      '样本量仅 30 人，该方法有效率提升 12%',
    ];
    for (const t of hedged) {
      const r = hf.checkUnsupportedClaim(t);
      assertEqual(r.count, 0, `对冲句不应命中: ${t}`);
    }
  });

  // ─── 3. 锁住分层口径 ───

  test('流水线分层数必须与 SKILL.md 声称一致', () => {
    const hf = require(GATE);
    const SKILL = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
    // 从文档表里读出声称值，而不是在这里写死——写死就失去了校验文档的意义
    const m = /Pipeline layers \| (\d+) input \/ (\d+) draft \/ (\d+) output/.exec(SKILL);
    assertTrue(!!m, 'SKILL.md 应含 Pipeline layers 一行且为 "N input / N draft / N output" 形态');
    const claimed = [+m[1], +m[2], +m[3]];
    const fns = [['input', 'checkInput'], ['draft', 'checkDraft'], ['output', 'checkOutput']];
    fns.forEach(([mode, fn], i) => {
      const r = hf[fn]('这是一个用于测量层数的中性测试句子');
      assertEqual(r.checked_by.length, claimed[i],
        `${mode} 分层数应为 ${claimed[i]}(SKILL.md 声称)，实测 ${r.checked_by.length}`);
    });
    // runPipeline 与裸捷径层数相同(文档曾声称捷径"少一层"，是反的)
    for (const [mode, fn] of fns) {
      const p = hf.runPipeline({ input: '这是一个用于测量层数的中性测试句子', mode });
      const s = hf[fn]('这是一个用于测量层数的中性测试句子');
      assertEqual(p.checked_by.length, s.checked_by.length,
        `runPipeline(${mode}) 与 ${fn} 层数应相同，实测 ${p.checked_by.length} vs ${s.checked_by.length}`);
    }
    // anchor 追加末层 intent-anchor
    const noA = hf.runPipeline({ input: '测试句子', mode: 'fast' });
    const withA = hf.runPipeline({ input: '测试句子', mode: 'fast', anchor: { goal: 'x' } });
    assertEqual(withA.checked_by.length, noA.checked_by.length + 1,
      '传 anchor 应追加一层');
    assertEqual(withA.checked_by[withA.checked_by.length - 1].layer, 'intent-anchor',
      'anchor 追加的应是 intent-anchor 层');
  });

  // ─── 4. 锁住"示例可运行"这个不变式本身 ───

  test('AGENTS.md 不得再出现未定义的 gate 调用', () => {
    // 防止有人把示例改回 `gate.checkInput(...)`——那是 ReferenceError 的源头。
    const md = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    const sec = md.split('## Quick start')[1] || '';
    const block = /```javascript\n([\s\S]*?)```/.exec(sec);
    assertTrue(!!block, 'Quick start 代码块应存在');
    const code = block[1];
    // 若用了 gate. 前缀，必须同块内有 const { gate } 或 const gate = 的解构/声明
    if (/[^.\w]gate\.(checkInput|checkDraft|checkOutput|runPipeline)/.test(code)) {
      assertTrue(/(?:const|let|var)\s*\{?\s*gate\b/.test(code),
        '若用 gate.xxx 调用，同块内必须先声明 gate');
    }
    // 且包名导入后若用 hf. 调用，hf 必须已声明
    if (/[^.\w]hf\.(checkInput|checkDraft|checkOutput|runPipeline)/.test(code)) {
      assertTrue(/(?:const|let|var)\s+hf\s*=/.test(code),
        '若用 hf.xxx 调用，同块内必须先声明 hf');
    }
  });

  test('文档示例用的 API 必须是 gate.js 的顶层导出', () => {
    // 这是缺陷一的根因: checkInput 等在 gate.js 顶层导出，不在名为 gate 的对象上。
    const g = require(GATE);
    for (const fn of ['checkInput', 'checkDraft', 'checkOutput', 'runPipeline']) {
      assertEqual(typeof g[fn], 'function', `${fn} 应是 gate.js 的顶层导出函数`);
    }
    // 而 gate 这个名字导出的是函数而非对象——文档若写 gate.checkInput 仍会炸
    assertEqual(typeof g.gate, 'function',
      'gate.js 导出的 gate 是函数(不是对象)，所以 gate.checkInput 不可用');
  });
};
