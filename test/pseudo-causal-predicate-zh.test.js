/**
 * test/pseudo-causal-predicate-zh.test.js — 伪因果的中文谓语结构覆盖
 *
 * [dimension-health-audit·第一百三十八轮] 新建。
 *
 * ═══ 沉默的一整族 ═══
 * PSEUDO_CAUSAL_ZH 原模式要求数字**紧贴**动词:
 *     /(?:提升|降低|减少|提高|改善|增加|增长|缩短)\s*\d+(?:\.\d+)?\s*(?:倍|x|次)/
 * 中文最常用的完成态"提升了3倍"因此不匹配(动词与数字之间隔着"了")。
 * 实测: "转化率提高了2倍""销量提高了3倍""耗时缩短了3倍" 全部 MISS。
 * 这是**业务表述里最常见的形状**, 整族沉默 —— 精确倍数因果声称恰恰是
 * 最需要 verify 的那类断言。
 *
 * ═══ 本轮被自己的测量推翻的判断, 如实记录 ═══
 * 首版给模式 2 堆了 15 个高频名词(转化率/销量/效率/成本/延迟…), 注释写
 * "模式2 扩高频名词并统一加(了)?", 以为补上了缺口。逐条实测后发现它是
 * **纯冗余**: 模式 2 的动词表(提高|提升|改善|增加|增长|降低|减少|缩短)
 * 与模式 1 完全一致, 只是多要求一个前置名词, 所以其匹配集合 ⊂ 模式 1
 * —— 所有含数字的"名词+动词+了+N倍"形状早已被模式 1 命中。
 * 真正沉默的在两处: **汉字数字**("收入增长了两倍"的 \d+ 不匹配"两")与
 * **动词缺口**("下降/下滑/上涨/攀升"不在模式 1 表内)。
 * 模式 2 因此改写为补它们, 并在此锁住"改对了地方"。
 *
 * ═══ 另一个必须钉住的事实: 正确行为是 verify, 不是漏报 ═══
 * pseudo_causal 是 **verify 级**维度, 所以"实验显示转化率提高了2倍, 效果
 * 非常显著。"的**正确** gate 就是 verify。而 calibrate-fp-recall.js 的
 * "被拦截"只算 block/rewrite —— 把这类样本塞进 MALICIOUS 会得到 56/57,
 * 把正确的引擎行为计成漏报。这正是 AGENTS.md cycle 34 记录过的坑,
 * 本会话又踩了一次, 因此这里用两条锁钉住:
 *   ① 该样本的维度级命中(它确实被拦, 且在 verify 层);
 *   ② 它**不得**作为数组条目出现在语料里, 对冲版本必须留在 BENIGN。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertTrue }) {
  const idx = require('../src/index.js');
  const fs = require('fs');
  const path = require('path');

  // 与 test/fp-hedge-exemption.test.js 一致: checkOutput 是 src/gate.js 的
  // 顶层导出, index.js 上没有 —— 从 index.js 读必须走 discriminate。
  const disc = (t) => idx.discriminate(t, []);
  const hasFinding = (t, dim) => (disc(t).findings || []).some(f => f.dimension === dim);
  const action = (t) => (disc(t).gate || {}).action || 'pass';

  // ── 一、完成态主谓结构必须命中 ────────────────────
  test('完成态主谓结构的精确倍数声称必须判为伪因果', () => {
    // 这是本轮修复前整族沉默的形状(实测全 MISS)。
    const shapes = [
      '实验显示转化率提高了2倍，效果非常显著。',
      '转化率提高了2倍。',
      '转化率提高2倍。',                 // 无"了": 容忍不得反向破坏
      '销量提高了3倍。',
      '耗时缩短了3倍。',
      '下降族: 错误率下降了两倍。',
      '收入增长了两倍。',                // 汉字数字
    ];
    for (const t of shapes) {
      assertTrue(hasFinding(t, 'pseudo_causal'),
        `精确倍数因果声称漏报(主谓结构沉默): "${t}"`);
    }
  });

  // ── 二、正确层级: verify(不是 block/rewrite, 也不是 pass) ──
  test('该类样本的正确动作是 verify(维度级 tier 约定)', () => {
    const t = '实验显示转化率提高了2倍，效果非常显著。';
    assertTrue(action(t) === 'verify',
      `verify 级维度的正确动作应为 verify, 实测 ${action(t)} —— ` +
      '若它变成 block/rewrite 说明该维度被误升到改写/阻断层; ' +
      '若是 pass 说明维度又沉默了');
  });

  // ── 三、对冲护栏必须仍然放行 ─────────────────────
  test('句内自带对冲的主谓结构不得判为伪因果', () => {
    // 这条对冲样本现居 BENIGN(本轮新增)。若模式放宽后吞掉对冲,
    // 语料 FP 会从 0/122 抬起来 —— 维度级先钉一层。
    const hedged = [
      '实验显示转化率提高了2倍，但样本量仅50，结论有待确认。',
      '初步数据显示转化率提高2倍，尚需进一步验证。',
      '小样本实验表明收入增长了两倍，样本量仅 30。',
    ];
    for (const t of hedged) {
      assertTrue(!hasFinding(t, 'pseudo_causal'),
        `自带对冲的精确倍数断言被误判为伪因果: "${t}"`);
    }
  });

  // ── 四、语料护栏: 不得把它错派进 MALICIOUS ────────
  test('语料数组不得含 verify 级样本, 且必须保留其对冲版本', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'calibrate-fp-recall.js'), 'utf8');
    // [自匹配防护] 只认数组条目行(行首可选空白后紧跟引号), 注释行不算。
    // 本仓库已多次因"匹配到自己写的注释"而写出恒真/恒假锁。
    const entryLines = raw.split('\n').filter(l => /^\s*'/.test(l));
    const hasEntry = (s) => entryLines.some(l => l.includes(s));

    assertTrue(!hasEntry('实验显示转化率提高了2倍，效果非常显著'),
      '语料数组不得含该样本 —— pseudo_causal 正确只到 verify, 而脚本的' +
      '"被拦截"只算 block/rewrite, 放进去会把正确行为计成漏报');
    assertTrue(hasEntry('实验显示转化率提高了2倍，但样本量仅50，结论有待确认'),
      '语料 BENIGN 必须保留其自带对冲的变体 —— 它是本轮 FP 护栏');
  });

  // ── 五、源码级: 三处缺口都必须真的补上 ────────────
  test('PSEUDO_CAUSAL_ZH 必须含完成态容忍、动词缺口与汉字数字', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const seg = (() => {
      const i = src.indexOf('const PSEUDO_CAUSAL_ZH = [');
      const j = src.indexOf('];', i);
      if (i < 0 || j <= i) throw new Error('找不到 PSEUDO_CAUSAL_ZH(锚点已变?)');
      return src.slice(i, j);
    })();
    assertTrue(seg.includes('(?:了)?'),
      '完成态容忍(?:了)? 必须在 —— 删掉它"提高了2倍"整族回到沉默');
    assertTrue(seg.includes('下降'),
      '动词缺口"下降"族必须在 —— 模式 1 原表不含它');
    assertTrue(seg.includes('一二两三四五六七八九十'),
      '汉字数字类必须在 —— \\d+ 不匹配"两", "收入增长了两倍"会沉默');
    // 反向: 冗余的名词堆不得回来(它是本轮被测量推翻的实现)
    assertTrue(!seg.includes('转化率'),
      '模式 2 不得退回堆高频名词的形态 —— 那 15 个名词是纯冗余, ' +
      '真实缺口在汉字数字与动词族');
  });
};
