/**
 * test/progress-judgment-vacuous-pass.test.js
 *
 * [test-coverage-gap·第二百一十八轮] 新建。
 *
 * ═══ 怎么找到这个模块的 ═══
 * 本切片前九轮用了九个提问挑 B 类模块(crisp contract / 文档按全路径承诺 /
 * 导出纯函数与常量表 / src 直接 fan-in 最高 / MCP 工具直呼 / 错误处理最会伪装
 * 失败 / 从不校验入参 / 公有方法全返回同一常量 / 从最多受测模块可达), 九个都用
 * 过了。本轮第十个提问: **哪些 B 类模块在真实运行中真的被加载?** 前九轮问的都
 * 是静态图, 没有一个问过"它到底跑不跑"。
 *
 * 量法: 同一进程内装 Module._load 钩子, 跑一遍有代表性的引擎调用(判别 + 门禁
 * + 全管线 + think), 取加载集与 B 类交集。结果: **91 个 B 类里 63 个被加载,
 * 28 个从不被加载**(接近死代码)。被加载的那 63 个才是活缺口。
 *
 * 其中 `src/core/progress-judgment.js`(289 行)是 `src/pipeline.js:217` 的**真实
 * 管线层**, 每次调用 new 一个实例, 零测试。
 *
 * ═══ 缺陷 ═══
 * `checkCoreStandards` 的第一条核心标准(可验证性)原来这样判:
 *
 *     if (!verifiability && claim) { passed = false; failures.push('可验证性'); }
 *
 * "没有证据"只在**同时有主张**时才判失败。于是 action / claim / evidence 三者
 * 全空时, 可验证性这一条**静默通过**; 配上另外两个同样空判通过的检查,
 * `judge({})` 返回 isProgress=true / confidence=0.925 —— 一个空问题被答成
 * "是进步, 92.5% 确信"。而模块自己的第一条核心标准写的就是
 * "进步的主张必须能被检验": 无从检验的东西不能算通过检验。
 *
 * 生产路径上这一档更尖锐。pipeline.js:218 的调用形状是
 *   judge({ action: input, claim: '', userIntent: input })
 * claim 恒为空、evidence 恒为 undefined, 所以原判据在唯一的调用方那里
 * **一次都不会响** —— 五条核心标准里的第一条, 结构上不可达。
 *
 * ═══ 修法 ═══
 * 判据改为 `if (!verifiability && (claim || !action))`: 只补"三者全空"这一档,
 * 不动"有行动无证据"那一档 —— 后者一改就会把 201 条语料全部翻成非进步、把门禁
 * 整体推到 verify, 那是另一个量级的改动, 不属于一个最小变更。
 *
 * ═══ 实测 ═══
 *   修前  judge({}) → isProgress=true  confidence=0.925
 *   修后  judge({}) → isProgress=false confidence=0.725 standGround 出现
 *   语料  isProgress 200/201、层升级 1/201 —— 逐条不变
 *         良性 137/137 pass、恶意 64/64 拦截 —— 逐条不变
 *
 * ═══ 本锁钉什么 ═══
 * ① 空输入不得判成进步(核心修复, 多种空形状);
 * ② 语料读数不许动(双向: 良性不升级、恶意不全漏);
 * ③ 反向对照: 有实质内容的输入仍须判成进步(修复不许把一切都压成 false);
 * ④ 源级: 可验证性判据必须含 `!action` 一档;
 * ⑤ 反向证明: 判据改回 `&& claim` 后, 空输入必须回到 isProgress=true;
 * ⑥ 披露: pipeline 调用形状下"有行动无证据"仍不失败(第一条标准结构性不可达),
 *    以及该形状下全语料只有 1 条触发升级 —— 这条层在生产里几乎是哑的。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const { ProgressJudgment } = require(path.join(__dirname, '..', 'src', 'core', 'progress-judgment.js'));
  const { loadCorpus } = require(path.join(__dirname, '_corpus-arrays.js'));
  const gate = require(path.join(__dirname, '..', 'src', 'gate.js'));
  const c = loadCorpus();

  // pipeline.js:218 的真实调用形状
  const pipelineShape = s => ({ action: s, claim: '', userIntent: s });
  const judge = (ctx) => new ProgressJudgment().judge(ctx);

  // ── ① 空输入不得判成进步 ────────────────────────────────────
  test('空输入不得被判成进步(可验证性不许静默通过)', () => {
    const EMPTY = [
      {},
      { action: '', claim: '', userIntent: '' },
      { action: '', claim: '' },
      { claim: '' },
    ];
    for (const ctx of EMPTY) {
      const r = judge(ctx);
      assertEqual(r.isProgress, false,
        JSON.stringify(ctx) + ' 被判成进步(isProgress=true) —— 空问题不能答成"是进步"');
      // 修后置信度应从 0.925 落到 0.725(可验证性失败拿走 +0.2)
      assertTrue(r.confidence < 0.8,
        JSON.stringify(ctx) + ' 的 confidence=' + r.confidence + ' 仍居高不下 —— 空判却高确信');
      // 且必须给出 standGround(说明为什么不是进步), 而不是默默地 false
      assertTrue(!!r.standGround,
        JSON.stringify(ctx) + ' 判了非进步却没给 standGround —— 审计链断了');
    }
  });

  // ── ② 语料读数不许动 ────────────────────────────────────────
  test('语料读数不许动: 良性 137 全 pass、恶意 64 全拦截', () => {
    let bPass = 0;
    for (const s of c.BENIGN) if (gate.checkOutput(s).gate.action === 'pass') bPass++;
    assertEqual(bPass, c.benignCount,
      `良性语料被升级 ${c.benignCount - bPass} 条(应为 0) —— 修复把误报带进来了`);
    let mHit = 0;
    for (const s of c.MALICIOUS) {
      const a = gate.checkOutput(s).gate.action;
      if (a === 'block' || a === 'rewrite') mHit++;
    }
    assertEqual(mHit, c.maliciousCount,
      `恶意语料漏拦 ${c.maliciousCount - mHit} 条(应全拦) —— 修复把召回丢了`);
  });

  // ── ③ 反向对照: 有实质内容的输入仍须判成进步 ────────────────
  test('反向对照: 有实质内容的输入仍须判成进步', () => {
    // 修后全语料仍有 200/201 判成进步(实测), 取足量样本证明没被压平
    const pos = c.ALL.filter(s => judge(pipelineShape(s)).isProgress);
    assertTrue(pos.length >= Math.floor(c.ALL.length * 0.9),
      `只有 ${pos.length}/${c.ALL.length} 条判成进步(修后实测 200/201) —— ` +
      '修复把一切都压成了非进步, 那是另一种失真');
    // 带证据的进步主张必须明确通过, 且可验证性这一条要为 true
    const r = judge({ action: '减少错误率', claim: '错误率从 10% 降到 1%', evidence: ['测试报告'], userIntent: '更正确' });
    assertEqual(r.isProgress, true, '带证据的进步主张应判成进步');
    assertEqual(r.coreCheck.results.verifiability.passed, true,
      '有证据时 verifiability.passed 应为 true');
  });

  // ── ④ 源级: 判据必须含 !action 一档 ─────────────────────────
  test('源级: 可验证性判据必须覆盖"三者全空"', () => {
    // 先剥行注释再匹配 —— 本轮修复写的注释里**引用了旧判据原文**来说明改了什么,
    // 不剥的话"旧判据不许残留"这一条会把注释当成罪行(cycle-19/25/194/195/197/214
    // 形状的第九次)。长度保留式剥法, 且不剥字符串(剥了字符串就看不见 require 什么)。
    const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'progress-judgment.js'), 'utf8');
    const src = raw.split('\n').map(l => l.replace(/\/\/[^\n]*$/, m => ' '.repeat(m.length))).join('\n');
    assertTrue(/if\s*\(!verifiability\s*&&\s*\(claim\s*\|\|\s*!action\)\)/.test(src),
      '可验证性判据不再是 `!verifiability && (claim || !action)` —— ' +
      '空输入会重新静默通过(见本文件头部)');
    // 旧判据不许残留(否则两种写法并存, 读代码的人无法判断哪个生效)
    assertTrue(!/if\s*\(!verifiability\s*&&\s*claim\)/.test(src),
      '旧的 `!verifiability && claim` 判据仍在 —— 两种写法并存');
    // 前提自证: 剥注释没把真代码剥掉(否则上面两条都是恒真的)
    assertTrue(/class ProgressJudgment/.test(src) && /checkCoreStandards/.test(src),
      '剥注释把真代码也剥掉了 —— 本外边的源级断言已空转');
  });

  // ── ⑤ 反向证明: 改回旧判据, 空输入必须回到 isProgress=true ───
  test('反向证明: 判据改回 && claim 后, 空输入必须重新被判成进步', () => {
    const SRC = path.join(__dirname, '..', 'src', 'core', 'progress-judgment.js');
    const orig = fs.readFileSync(SRC, 'utf8');
    const NEW = 'if (!verifiability && (claim || !action)) {';
    const OLD = 'if (!verifiability && claim) {';
    assertTrue(orig.includes(NEW), '源码里找不到新判据 —— 锚点已变, 本反向证明无效');
    const broken = orig.replace(NEW, OLD);
    assertTrue(broken !== orig && !broken.includes(NEW),
      '变异未生效 —— 锚点没匹配上, 本次反向证明无效');
    // 副本落在 src/ 旁(模块只 require 相对路径, 落 tmpdir 会解析不到)
    const tmp = path.join(__dirname, '..', 'src', 'core', '_pj-broken-218.tmp.js');
    fs.writeFileSync(tmp, broken);
    try {
      let bMod;
      try { bMod = require(tmp); } finally { try { delete require.cache[require.resolve(tmp)]; } catch (_) {} }
      const r = new bMod.ProgressJudgment().judge({});
      assertEqual(r.isProgress, true,
        '改回旧判据后空输入竟仍判非进步 —— 说明拦下空输入的不是这一档判据, 反向证明无效');
      assertTrue(r.confidence > 0.9,
        '改回旧判据后 confidence=' + r.confidence + ' 未回到 0.925 —— 反向证明的对照不成立');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
      try { delete require.cache[require.resolve(tmp)]; } catch (_) {}
    }
  });

  // ── ⑥ 披露: 第一条标准在生产形状下结构性不可达 ──────────────
  test('披露: pipeline 调用形状下"有行动无证据"仍不失败(第一条标准不可达)', () => {
    // pipeline 恒传 claim:"" 且不传 evidence。此形状下, 只要 action 非空,
    // 可验证性就不判失败 —— 本轮刻意没改这一档(改动会把 201 条语料全翻成非进步)。
    const r = judge({ action: '把模型做得更大', claim: '', userIntent: '变强' });
    assertEqual(r.coreCheck.results.verifiability.passed, undefined,
      'pipeline 形状下 verifiability.passed 不再是 undefined —— 本披露已过期, 请反转本例外');
    // 同形状下全语料只有 1 条触发升级(修后实测 1/201): 这条层在生产里几乎是哑的,
    // 它的五条核心标准里第一条结构上不可达、其余四条要靠 action 里的关键词碰。
    let escal = 0;
    for (const s of c.ALL) if (judge(pipelineShape(s)).standGround) escal++;
    assertEqual(escal, 1,
      `pipeline 形状下触发升级的语料数是 ${escal}(修后实测 1) —— 变了请更新本披露, ` +
      '并重新评估"这条层在生产里几乎是哑的"这一判断是否仍成立');
    // 反向自证: 上一条断言若因语料增长而失效, 必须能说出是增长还是退化
    assertTrue(escal <= Math.ceil(c.ALL.length * 0.05),
      `升级数 {escal} 已超过语料的 5% —— 这条层可能已经不再是哑的, 请重新读数`);
  });
};
