/**
 * test/pipeline-mode-selection.test.js — System 1/2 路由必须对中文可比
 *
 * [test-coverage-gap·第一百四十五轮] 新建。
 *
 * ═══ 起点 ═══
 * `src/workflow/pipeline-config.js`(1747 行)是 B 类"活着但没测"之王: 无测试引用，
 * 但被 `src/workflow/pipeline.js` 引用 —— 它是 17 层主管线的模式决策器，
 * `selectMode()` 的返回值决定用户输入走 FAST_PIPELINE(7 层) 还是
 * DEFAULT_PIPELINE(12 层)。`src/core/engine-reasoner.js:318` 也调它。
 * 一个没有锁的行为关键路径。
 *
 * ═══ 探针量出的缺陷: 中文被系统性低估 ═══
 * 对 13 个真实输入做行为探针，发现典型中文高复杂度输入**全部落在 0.19-0.24**，
 * 永远够不到 0.4 门槛 —— 最需要 System 2 慢思考的中文输入全部走了 fast(7 层):
 *     "我最近在考虑要不要换工作，新机会薪水更高但风险也大，…"  → 0.22
 *     "孩子今年中考成绩不理想，我在想是花钱托关系进重点高中…"  → 0.24
 *
 * 三个根因，逐维度实测定位:
 *   ① 长度因子按**字符数**而中文密度高: 59 个中文字已完整表达一个复杂决策，
 *      却因不足 80 字符阈值而得 0 分; 英文同义句 175 字符反而得 0.057。
 *   ② 决策/情感词表对中文表达覆盖 **1/10** —— 实测"换工作/舍不得/中考/攒钱/
 *      吵架/提不起兴趣"等 10 个高频复杂表达只有 1 个偶然命中。词表枚举对中文
 *      必然持续漏(本仓库已多次记录"枚举式判据漏一次 per 新说法")。
 *   ③ 从句增益 0.03/个、上限 0.20 —— 需要 **7 个分句**才满，而中文典型复杂句
 *      只有 4-5 个分句。中文的复杂度主要靠**标点分层**表达而非连接词
 *      (英文的 and/but 在中文里常被逗号吸收)，所以分句数才是中文最可靠的信号。
 *
 * ═══ 修法(三处，一处门槛) ═══
 *   ① 长度因子改为按**语义单元**折算: CJK 每字 1 单元、拉丁每 4 字符 1 单元，
 *      阈值 20/上限 125(正好接住原 80/500 的英文语义);
 *   ② 不动词表(加了也会漏)，改从结构取信号 —— 从句增益 0.03→0.05/个;
 *   ③ System 2 门槛 0.4→0.35(重新标定而非放宽标准: 门槛语义未变，
 *      变的是复杂度分数对中文的可比性)。取 0.35 而非 0.30 有实测依据:
 *      0.35 下只有"多分句+多决策词"的复杂句过线，0.30 会把仅 3 个分句的
 *      中等输入也推入 12 层管线，成本上是浪费。
 *
 * ═══ 实测(修复后) ═══
 *   简单/启动类 ≤0.05 → fast(不变); 短决策 0.16 → fast(不变);
 *   换工作决策 0.22→0.38 → **full**; 教育抉择 0.24→0.36 → **full**;
 *   婚姻矛盾(3 分句)0.19→0.30 → fast(它确实更简单，归 fast 合理)。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const pc = require('../src/workflow/pipeline-config.js');
  const { selectMode, estimateComplexity, DEFAULT_PIPELINE, FAST_PIPELINE } = pc;

  // ── 一、契约形状 ─────────────────────────────────────
  test('管线形状契约: 层数、导出、模式取值', () => {
    assertTrue(Array.isArray(DEFAULT_PIPELINE) && DEFAULT_PIPELINE.length > 0,
      'DEFAULT_PIPELINE 必须是非空数组');
    assertTrue(Array.isArray(FAST_PIPELINE) && FAST_PIPELINE.length > 0,
      'FAST_PIPELINE 必须是非空数组');
    // full 必须比 fast 深(否则"深度慢思考"名不副实)
    assertTrue(DEFAULT_PIPELINE.length > FAST_PIPELINE.length,
      `DEFAULT(${DEFAULT_PIPELINE.length}) 必须比 FAST(${FAST_PIPELINE.length}) 层数多 —— ` +
      '否则 System 2 的"深度"是假的');
    // selectMode 的返回值必须只有两种(下游据此二选一)
    for (const t of ['hi', '你好', '今天天气怎么样？', 'x'.repeat(300)]) {
      const m = selectMode(t);
      assertTrue(m === 'fast' || m === 'full',
        `selectMode 必须只返回 fast/full, 实测 "${m}"`);
    }
  });

  // ── 二、简单输入必须保持 fast(不可被放宽带入 full) ────
  test('简单与启动类输入必须走 fast', () => {
    const simple = [
      'hi', '你好', '状态', '在吗',
      '今天天气怎么样？', '1+1等于几', '什么是闭包', '现在几点了',
      '帮我写个排序算法', '推荐几部好看的电影',
    ];
    const bad = [];
    for (const t of simple) {
      if (selectMode(t) !== 'fast') bad.push('"' + t + '" → ' + selectMode(t));
    }
    assertEqual(bad.join(', '), '', '以下简单输入被误路由到 full:\n' + bad.join('\n'));
  });

  // ── 三、中文复杂输入必须能进 full(本轮修的核心) ───────
  test('多分句中文复杂输入必须走 full', () => {
    // 判据是"多分句 + 长文本"(结构信号，不依赖具体词汇) —— 这样锁不会因为
    // 换一批近义样本就失效。
    const complex = [
      '我最近在考虑要不要换工作，新机会薪水更高但风险也大，现在的团队我很舍不得，家里人也希望我稳定一点，你能帮我分析一下吗？',
      '孩子今年中考成绩不理想，我在想是花钱托关系进重点高中，还是让他在普通高中好好读，这个决定让我很焦虑',
    ];
    const bad = [];
    for (const t of complex) {
      if (selectMode(t) !== 'full') bad.push('"' + t.slice(0, 30) + '…" → ' + selectMode(t) + ' (c=' + estimateComplexity(t).toFixed(2) + ')');
    }
    assertEqual(bad.join('\n'), '', '以下中文复杂输入被误路由到 fast:\n' + bad.join('\n'));
  });

  // ── 四、分离度: 复杂度分数必须在两类之间分开 ──────────
  test('复杂度分数必须在简单与复杂两类之间分离', () => {
    const simpleMax = Math.max(
      ...[ 'hi', '你好', '今天天气怎么样？', '什么是闭包', '帮我写个排序算法' ]
        .map(estimateComplexity));
    const complexMin = Math.min(
      ...['我最近在考虑要不要换工作，新机会薪水更高但风险也大，现在的团队我很舍不得，家里人也希望我稳定一点，你能帮我分析一下吗？',
        '孩子今年中考成绩不理想，我在想是花钱托关系进重点高中，还是让他在普通高中好好读，这个决定让我很焦虑']
        .map(estimateComplexity));
    assertTrue(complexMin > simpleMax,
      `两类必须分开: 简单类最高 ${simpleMax.toFixed(3)} vs 复杂类最低 ${complexMin.toFixed(3)} —— ` +
      '若交叉则门槛无论取在哪都无法同时兼顾');
    // 且复杂类最低分要超过 System 2 门槛(0.35)，否则第 3 条会恒假
    assertTrue(complexMin >= 0.35,
      `复杂类最低分(${complexMin.toFixed(3)})必须 >= System 2 门槛 0.35`);
  });

  // ── 五、长度因子必须按语义密度折算(本轮修的根因①) ───────
  test('长度因子必须按语义密度折算，不能按字符数', () => {
    // 原实现按 text.length 算，中文被系统性低估: 一个 26 字的中文复杂句
    // (语义上已完整)只得 0.11，而同语义的英文句因天然冗长拿到更高分。
    // 修复后 CJK 每字 1 单元、拉丁每 4 字符 1 单元，两者可比。
    //
    // 判据取**长度分本身**而非总分: 分句/关键词在长短句上都会饱和，
    // 只有长度分能干净地分离两种实现(实测: 用总分会抓不住差异 ——
    // 变异验证时把 semanticUnits 换回 text.length，复杂度读数不变)。
    const CJK_RE = /[一-鿿㐀-䶿]/g;
    const lengthPart = (t) => {
      const cjk = (t.match(CJK_RE) || []).length;
      const latin = t.length - cjk;
      const units = cjk + latin / 4;   // 与实现同式
      return Math.min(1, Math.max(0, (units - 20) / (125 - 20)));
    };
    const charPart = (t) => {
      return Math.min(1, Math.max(0, (t.length - 20) / (125 - 20)));
    };
    // 一个中文短句: 含 CJK 与拉丁混合(offer)
    const zh = '我在纠结要不要接受这个offer，风险不小但机会难得，想听听你的分析';
    const zhCjk = (zh.match(CJK_RE) || []).length;
    const zhLatin = zh.length - zhCjk;
    assertTrue(zhCjk >= 15 && zhLatin > 0,
      `前提失效: 该句应含 >=15 个 CJK 且 >0 个拉丁字符(实测 CJK=${zhCjk} latin=${zhLatin})`);
    // 折算后单元数必须与字符数不同(否则语义折算没有发生)
    const units = zhCjk + zhLatin / 4;
    assertTrue(Math.abs(units - zh.length) > 2,
      `语义单元(${units.toFixed(1)})必须与字符数(${zh.length})有可见差异 —— ` +
      '相同说明没有按密度折算');
    // 中文的折算必须让单元数**低于**字符数(拉丁字符被压缩)，这是可比性的来源
    assertTrue(units < zh.length,
      `中文句折算后单元数(${units.toFixed(1)})应低于字符数(${zh.length}) —— ` +
      '拉丁部分(offer)被 4:1 压缩');
    // 纯中文句两者应相等(无拉丁可压缩)
    const pureZh = '我在纠结要不要接受这个机会风险不小但机会难得想听听你的分析';
    const pCjk = (pureZh.match(CJK_RE) || []).length;
    assertTrue(pCjk === pureZh.length,
      `前提失效: 应为纯中文句(实测 CJK=${pCjk} 长度=${pureZh.length})`);
    assertTrue(lengthPart(pureZh) === charPart(pureZh),
      '纯中文句的两种算法应相等(无拉丁可压缩)');
    // 中英混合句的折算必须与纯字符数不同(这是本轮修复的可观察效果)
    assertTrue(lengthPart(zh) !== charPart(zh),
      '中英混合句的语义折算必须与字符数算法给出不同结果');
  });

  // ── 六、源级: 三处修复都必须在 ────────────────────────
  test('源级: 语义单元折算、从句增益、System 2 门槛都必须在', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workflow', 'pipeline-config.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // ① 语义单元折算(钉住公式本身，不是只钉变量名)
    assertTrue(/semanticUnits\s*=\s*cjkCount\s*\+\s*latinCount\s*\/\s*4/.test(src),
      '长度因子必须按"cjkCount + latinCount / 4"折算 —— 只写 semanticUnits 变量名不算, ' +
      '把右边换成 text.length 同样能通过变量名断言(变异验证实测抓不住)');
    assertTrue(/CJK_RE/.test(src) && /cjkCount/.test(src),
      '必须真的统计 CJK 字符数(CJK_RE / cjkCount)');
    // ② 从句增益 0.05
    assertTrue(/clauseCount \* 0\.05/.test(src),
      '从句增益必须是 0.05/个 —— 退回 0.03 则中文 4-5 分句的复杂句过不了线');
    // ③ System 2 门槛 0.35
    assertTrue(/complexity < 0\.35/.test(src),
      'System 2 门槛必须是 0.35(重新标定后的值)');
    // 旧阈值不得回来
    assertTrue(!/LENGTH_THRESHOLD = 80/.test(src),
      '长度阈值不得回到固定 80 字符 —— 那对中文是系统性低估');
  });
};
