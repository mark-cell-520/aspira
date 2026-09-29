/**
 * test/doc-honest-numbers-chinese.test.js — 诚实数字审计必须能读懂中文声称
 *
 * ═══ doc-honest-numbers 切片的发现 ═══
 * 引擎以 confidence 0.75 选定本切片(此前数周期都是弃权后平局打破)。
 * 起手跑审计是绿的: 38/38 全一致。但绿只说明"它知道的那 38 条没错"。
 *
 * 量化审计自身的覆盖面: 全仓 21 份 md 共约 **295 处**数字型声称，
 * 审计只校验 **38 条**——12.9%。粗计含大量非声称(版本号/日期)，不能直接当漏洞，
 * 但方向明确: **审计的 20 条模式全是英文形状**。
 *
 * 本仓库文档以中文为主，于是所有中文数字声称对审计完全不可见:
 *     "132 个模块" / "54 个维度" / "181 个 MCP 工具" …
 * 一条都测不到。这不是"数字都对"，是**测不到**——与仓库已记载的盲点同根:
 * 仪器看不见的风险等于不存在。
 *
 * ═══ 补了中文模式后立刻抓到一个真错 ═══
 * IDENTITY.md「辨别能力从哪里来（代码里真实有的）」一节写:
 *     "不是概念，是代码。129 个模块真实加载、真实调用，分 7 大域"
 * 实测模块数 **132**。该句是现在时、且自称"代码里真实有的"，
 * 属于最不该错的那类声称。已修为 132(同段"分 7 大域"经核对与文档实际
 * 7 个编号小节一致，未改)。
 *
 * ═══ 中文模式必须排两类假阳性 ═══
 * 首版模式过宽，一次报 3 条不符，逐条核对后只有 1 条是真错:
 *   (a) REFLECTION.md「第 133 个模块」——序数，且在"过去(2026-06~07-25)"
 *       历史叙事章节内，是当时的第几个模块，不是当前模块总数;
 *   (b) ROADMAP.md「cognitiveEnrichment阶段 (10个模块)」——某个阶段的模块数;
 *   (c) IDENTITY.md「129 个模块」——真错。
 * 若不做区分就会为"修文档"而篡改历史叙事，那比数字错更糟。
 * 故加 reject 过滤器: 序数(前有"第")与括号内(有未闭合的左括号)不计。
 *
 * ═══ 本文件锁什么 ═══
 * 1. 审计必须含中文模式(否则中文声称重新变不可见);
 * 2. reject 过滤器必须滤掉序数与括号两类形态;
 * 3. 仪器必须**真的能抓住**一个中文错数(注入验证，而非只断言模式存在)——
 *    这条最重要: 只断言"有中文模式"会奖励一个永远匹配不到东西的死模式。
 */
module.exports = function ({ test, assertTrue, assertEqual }) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const { withDocLock } = require('./_doc-probe-lock.js'); // [第七轮] 共享文档探针互斥
  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');

  // ⚠️ 必须带 ASPIRA_AUDIT_SKIP_TESTS=1。
  // 审计脚本要跑 run-all.js 取测试数，而 run-all.js 会执行**本测试文件**，
  // 本文件又调用审计脚本——**无限递归**。首版没设该变量，实测后果:
  // 嵌套调用把测试数测成 1013(而非 1014)，且测试临时改写的文档在嵌套层之间
  // 互相可见，产出假警报。审计脚本现已支持该开关跳过测试数实测。
  function runAudit() {
    try {
      return execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024,
        env: Object.assign({}, process.env, { ASPIRA_AUDIT_SKIP_TESTS: '1' }),
      });
    } catch (e) { return (e.stdout || '').toString(); }
  }

  test('审计必须包含中文形态的声称模式', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    for (const frag of ['个维度', '个模块', '个\\s*MCP\\s*工具', '条\\s*dispatch']) {
      assertTrue(src.includes(frag), `审计缺少中文模式片段: ${frag}`);
    }
  });

  test('中文模式必须带 reject 过滤器(序数与括号不得计入)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/reject:/.test(src), '必须有模式带 reject 过滤器');
    // 过滤器必须处理两种形态。
    // ⚠️ 上一版锚定"第一个 reject:" 之后的 600 字。本轮把 selfRef(引擎自我指称)
    // 挪到了 pats 之前，Node.js 那条模式的 reject 成了第一个，于是本条失败——
    // **守卫该锁原则(序数与括号必须被排除)，锁"第一个"就会在正确重构时误报。**
    // 改为: 用正则定位「个模块」那条**模式定义**(re: /…个模块/g)，
    // 再检查它及其 reject 是否覆盖两种形态。
    // ⚠️ 不能用 indexOf('个模块')——注释里就有 "132 个模块" 字样，
    // 会先匹配到注释，其后 700 字内没有 reject。锚点必须精确到定义本身。
    const mDef = src.match(/re:\s*\/\(\\d\[\\d,\]\*\)\\s\*个模块\//);
    assertTrue(!!mDef, '应存在「个模块」的中文模式定义');
    const i = mDef.index;
    const seg = src.slice(i, i + 700);
    assertTrue(/reject:/.test(seg), '中文「个模块」模式必须带 reject');
    assertTrue(/第/.test(seg), 'reject 必须排除序数(第 N 个模块)');
    assertTrue(/[(（]/.test(seg), 'reject 必须排除括号内((N个模块))');
  });

  test('claims() 循环必须真正调用 reject(声明了不用等于没有)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/typeof p\.reject === 'function' && p\.reject\(/.test(src),
      'claims() 必须调用 p.reject——只声明不调用会让过滤器变成死代码');
  });

  test('仪器必须真的抓住一个中文错数(注入验证，非仅断言模式存在)', () => withDocLock(() => {
    // 这条是整个文件的意义: 前面几条只证明"模式写在那"，
    // 可能是个永远匹配不到东西的死模式。用临时注入证明它真能报警。
    const F = path.join(ROOT, 'IDENTITY.md');
    const orig = fs.readFileSync(F, 'utf8');
    const MARK = '132 个模块真实加载';
    // ⚠️ 锚点不在时**不得静默跳过**。本会话实测过这个坑: 一次注入后文件被留在
    // 错值(99)，此后每次运行都因 orig.includes(MARK) 为假而提前 return，
    // 于是**再也不会被还原**——错值自我维持，测试还全是绿的。
    // 现在锚点不在就报失败，把人叫来。
    assertTrue(orig.includes(MARK),
      `IDENTITY.md 找不到锚点「${MARK}」——文件可能已被上次注入留在错值状态，必须人工检查`);
    if (!orig.includes(MARK)) return;
    try {
      fs.writeFileSync(F, orig.replace(MARK, '99 个模块真实加载'), 'utf8');
      const out = runAudit();
      assertTrue(/IDENTITY\.md 声称「modules \(中文\) = 99」/.test(out),
        '注入"99 个模块"后审计必须精确报出——否则中文模式是死模式');
    } finally {
      fs.writeFileSync(F, orig, 'utf8');
    }
    // 还原后必须恢复全绿
    const after = runAudit();
    assertTrue(/不一致: 0/.test(after), `还原后应恢复全绿，实测: ${after.match(/文档声称总数[^\n]*/)}`);
  }));

  // ⚠️ 这个 test 跑审计并断言"无不一致"，所以它也必须持锁:
  // 它读的是**磁盘上的文档**，而别的探针此刻可能正在改写那份文档。
  // 不持锁时它读到的是别人的探针，失败表现是"还原后仍不一致"——
  // **看起来像自己没还原干净，实际是别人的临时状态。**
  test('还原后审计必须无不一致(跳过模式下允许测试数无法实测)', () => withDocLock(() => {
    // ⚠️ 不能断言"无法实测: 0": 跳过模式本就跳掉测试数实测，
    // 那 3 条测试数声称必然报"无法实测"。首版在这里断言 0，是自己没想清
    // 跳过模式的语义——又是"断言与设计不符"。
    const out = runAudit();
    const line = (out.match(/文档声称总数[^\n]*/) || [''])[0];
    assertTrue(/不一致: 0/.test(line), `还原后应无不一致: ${line}`);
  }));
};
