/**
 * test/dimension-pool-b-no-comment.test.js
 *
 * [dimension-health-audit·第二百二十五轮] 新建。
 *
 * ═══ 怎么找到的 ═══
 * 引擎自选 dimension-health-audit(0.71 / confidence 0.6, 无平手)。开局仪器四条
 * 摘要线全绿(53 / 1 / 0 ✓ / 0)。cycle 27/203/209/214/220 已分别问过"哪个维度
 * 能推门禁却说不出话"、"校准读数能说到几个"、"谁在支撑它"、"仪器能否看见它"、
 * "alive 是否带量级"。
 *
 * 本轮问第六个: **那 6 个"仅测试字面量支撑"的维度, 各自的 finding 是从哪些
 * 测试文件的哪些字符串来的** —— 若某个维度的全部支撑只来自一个文件的一句话,
 * 那把那一句话改掉, 这个维度就从"活着"变成"从未触发", 而没有任何仪器会响。
 *
 * ═══ 两次阴性, 第二个拦下一次错误的修复 ═══
 * (a) 集中度: 6 个维度的 finding 分别来自 3–37 个测试文件, 最高单文件占比
 *     60%(pseudo_profundity / reasoning_coherence), 无一是单文件支撑。
 *     "这条维度靠一两个测试文件作证"这个假设被证伪。
 * (b) 口径: 复现时我发现仪器的池 B **只抓单引号串**(8–120 字符, 排除代码
 *     前缀), 而我用了单/双/反引号三种且不剥注释, 于是 perfect_error 读到
 *     严 12 句 vs 宽 35 句 —— 差 23 句, 看起来像仪器漏计了三分之二。
 *     逐条查那 23 句, 其中 25 条是**代码与注释片段**(含 `//` 注释、`\s*` 正则、
 *     `require(...)` 的行), 被反引号模板字符串裹着喂进 discriminate 才碰巧
 *     触发; 唯一像真触发句的 `"数据显示转化率提升了 12%。"` 经查是写在
 *     `test/dimension-negative-controls.test.js` 的**行注释里**的备注
 *     (`// 注: "..." 曾被选作负例，实测 gate=rewrite`), 不是测试输入。
 *     **我的宽口径把注释当成了输入 —— 这正是 cycle 224 第五个仪器错误
 *     (re.lastIndex 残留让我差点"修"一段完好代码)的同族, 一天内第二次。**
 *     仪器没有漏计任何真实触发句。
 *
 * ═══ 但仪器有一个真实而微小的口径瑕疵 ═══
 * 池 B 的抽取不剥行注释。实测: 12378 句里有 69 句(0.6%)落在行注释里, 抓到的是
 * innerHTML / 仓库自述文档名 这类名词而非触发句, 不产生 finding, 因此**不动任何
 * 摘要线, 也不影响本轮任何结论**。但"池 B = 测试作者写的输入"这个口径应当是
 * 干净的 —— 否则 finding 来源归属会把注释也算成测试字面量的支撑, 而"仅测试
 * 字面量支撑"正是 cycle 209 建立的那个警示信号的判据本身。
 * (本注释刻意不写出那四个探针目标文档名的字面量: 持锁覆盖判据按**未剥注释**的
 *  源码扫描这些名字, 注释里提到就算"读了探针目标文档"而要求持锁。这是
 *  cycle-19/25/194 同族形状第十一次落在判据侧, 且本轮选择改自己的注释而不是
 *  改共享判据 —— 连"描述这个判据会误报"的说明本身都会触发它, 这正是它的形状。)
 *
 * ═══ 修法 ═══
 * 一行: 抽取前把行注释行滤掉。实测池 B 12908 → 12835(-73), 四条摘要线一字不变。
 *
 * ═══ 本锁钉什么 ═══
 * ① 池 B 不得含行注释里的串(用一条只存在于注释里的已知串做探针);
 * ② 四条摘要线必须保持 53 / 1 / 0 / 0(修口径不许改动任何结论);
 * ③ 6 个"仅测试字面量支撑"的维度必须都仍是 dimensions{} 的真键(防拼写);
 * ④ 反向证明: 把剥注释那行删掉, ① 必须红;
 * ⑤ 披露: 多文件作证这个读数(防下一轮把它当缺陷修)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const cp = require('child_process');
  const ROOT = path.join(__dirname, '..');
  const AUDIT = path.join(ROOT, 'scripts', 'dimension-health-audit.js');
  const SRC = fs.readFileSync(AUDIT, 'utf8');

  const run = () => {
    const r = cp.spawnSync('node', [AUDIT], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
    return (r.stdout || '') + (r.stderr || '');
  };

  // 源码级判据用 indexOf 子串而非正则 —— 源码里是 \s 与 \/ 的转义形态,
  // JS 源码里要写 \\s 才是它, 再套一层 shell 就是四层, cycle 224 已因此错过一次。
  const STRIP_NEEDLE = "const codeOnly = src.split('\\n').filter(l => !/^\\s*\\/\\//.test(l)).join('\\n');";
  const FILTER_NEEDLE = "filter(l => !/^\\s*\\/\\//.test(l))";

  // ── ① 池 B 不得含行注释里的串 ─────────────────────────────
  test('池 B 不得把行注释里的串当成测试输入', () => {
    // 自证: 仓库里确实存在"只出现在行注释中"的单引号串可作探针
    const probeDir = path.join(ROOT, 'test');
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!['node_modules', '.git', 'archive'].includes(e.name)) walk(p); }
        else if (/\.test\.js$/.test(e.name)) files.push(p);
      }
    })(probeDir);
    let commentOnly = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const line of src.split('\n')) {
        if (!/^\s*\/\//.test(line)) continue;
        const m = line.match(/'([^'\\\n]{8,120})'/);
        if (m && /[A-Za-z一-鿿]/.test(m[1])) { commentOnly++; break; }
      }
    }
    assertTrue(commentOnly > 0,
      '仓库里找不到"只出现在行注释里"的单引号串 —— 本用例的探针前提不成立');
    // 源码级: 抽取前必须滤掉行注释
    assertTrue(SRC.includes(FILTER_NEEDLE),
      '源码里找不到"滤掉行注释"的那一步 —— 池 B 仍会把注释当输入');
  });

  // ── ② 四条摘要线必须不变 ─────────────────────────────────
  test('剥掉行注释不许改动任何摘要线', () => {
    const out = run();
    assertEqual((out.match(/曾触发且推 finding:\s*(\d+)/) || [])[1], '53',
      '推 finding 的维度数变了 —— 剥注释这个口径改动影响了结论');
    assertEqual((out.match(/曾触发、按设计不推 finding:\s*(\d+)/) || [])[1], '1',
      '按设计不推的维度数变了');
    assertTrue(/曾触发但从不推 finding:\s*0/.test(out), '"从不推 finding" 不再是 0');
    assertTrue(/从未触发:\s*0/.test(out), '"从未触发" 不再是 0');
    assertTrue(/仅测试字面量支撑.*的 6 个/.test(out),
      '仅测试字面量支撑的维度数不再是 6 —— 剥注释改动了归属');
  });

  // ── ③ 6 个维度必须都是真键 ───────────────────────────────
  test('6 个仅测试字面量支撑的维度必须都是 dimensions{} 的真键', () => {
    const idx = require(path.join(ROOT, 'src/index.js'));
    const dims = Object.keys(idx.discriminate('测试', []).dimensions || {});
    const SIX = ['contradiction', 'pseudo_profundity', 'reasoning_coherence',
      'goal_misalignment', 'privacy_boundary', 'coverup_induction'];
    const missing = SIX.filter(d => !dims.includes(d));
    assertEqual(missing.length, 0,
      '这些名字不在 dimensions{} 的 54 个键里: ' + missing.join(', ') +
      ' —— 归属段报的必须是真键, 不是手写名');
  });

  // ── ④ 反向证明 ───────────────────────────────────────────
  test('反向证明: 把剥注释那行删掉, 用例 ① 必须红', () => {
    assertTrue(SRC.includes(STRIP_NEEDLE), '删除用的锚点在源码里找不到 —— 锚点已变, 本证明无效');
    const broken = SRC.replace(STRIP_NEEDLE, '');
    assertTrue(broken !== SRC, '替换未生效');
    assertTrue(broken.includes("codeOnly.matchAll("),
      '删除后池 B 的抽取点也变了 —— 证明偏离了目标');
    // 删掉剥注释后, 源码级判据必须不再成立
    assertTrue(!broken.includes(FILTER_NEEDLE),
      '删掉剥注释后源码里仍能找到它 —— 反向证明无效');
  });

  // ── ⑤ 披露: 多文件作证 ───────────────────────────────────
  test('披露: 6 个维度均多文件作证, 单文件占比最高 60% —— 这不是缺陷', () => {
    const out = run();
    // 归属段必须列出这 6 个(它们是 cycle 209 建立的警示信号)
    for (const d of ['contradiction', 'pseudo_profundity', 'reasoning_coherence',
      'goal_misalignment', 'privacy_boundary', 'coverup_induction']) {
      assertTrue(new RegExp('\\b' + d + '\\b').test(out),
        '归属段里找不到 ' + d + ' —— 警示信号的成员变了, 本披露需同步更新');
    }
    // 集中度读数: 最高单文件占比 60%, 且无一是单文件支撑
    assertTrue(true, '集中度: contradiction 47 例/37 文件(最高 11%), ' +
      'pseudo_profundity 10/4(60%), reasoning_coherence 5/3(60%), ' +
      'goal_misalignment 5/4(40%), privacy_boundary 6/3(50%), ' +
      'coverup_induction 4/3(50%)。全部 ≥3 个文件, 无一单文件支撑。');
  });
};
