/**
 * test/dimension-signal-magnitude.test.js
 *
 * [dimension-health-audit·第二百二十轮] 新建。
 *
 * ═══ 怎么找到这个盲区的 ═══
 * 本切片前四轮各问了一个问题: cycle 27 "哪个维度能改门禁却推不出 finding"
 * (perfect_error)、cycle 203 "校准读数能覆盖多少维度"(语料触达 22/54)、
 * cycle 209 "谁在维持它的活性"(池归因, 7 个仅测试字面量)、cycle 214
 * "仪器能否看见它声称要量的东西"(7 个 checker 住在隔壁模块)。
 *
 * 本轮问的是: **"活着"这两个字带量纲吗?** 仪器的汇报名单是四行布尔:
 *   曾触发且推 finding / 按设计不推 / 从不推 / 从未触发
 * 于是 tally 里从第一版起就在数的 `signal`(触发该维度的**输入条数**)
 * 从来没被汇总段读过。一个只被 2 条输入触发的维度与一个被 11300 条
 * 触发的维度, 在"从未触发: 0"这条绿线上读起来完全一样。
 *
 * 这是 cycle 188 的形状(不可能非零的分支与测量为零的分支无法区分)的变体:
 * 那次是布尔的两端, 这次是**同一个布尔值内部的量级差**。
 *
 * ═══ 实测(本轮, 去重后池 11300 条) ═══
 *   最多 11300 条(evidence, score-only, 每条输入都有分 —— 真读数不是 bug)
 *   最少   2 条(counterfactual / coverup_induction)
 *   中位  32 条
 * 相差四个数量级。最薄的两个里, counterfactual 的支撑模块
 * CounterfactualEngine(493 行/16 个公有方法)被 heartflow 构造后从未调用,
 * 而 checkCounterfactual(index.js:3780)用自己的 COUNTERFACTUAL_PATTERNS
 * 正则表、不消费该模块 —— 两者并行存在且互不接触。把引擎接进 checker
 * 需要决定输出如何映射到维度分数, 是产品判断(铁律 2), 故只记录不修。
 *
 * ═══ 修法 ═══
 * 仪器汇总段加一个"触发条数分布"段: 报池条数/最多/最少/中位, 并把
 * ≤ 池的 0.2% 的维度逐个拎出来(带 A/B/C 来源与是否仅打分)。
 * 明写"薄不等于失效"——上面已有输入池盲区的说明, 不把薄当缺陷;
 * 报它是为了让"从未触发: 0"这条绿线带上量纲。
 * 引擎(src/index.js)一行未动, MCP 不重启。
 *
 * ═══ 本锁钉什么 ═══
 * ① 源级: 分布段必须存在(否则又回到只有布尔);
 * ② 行为: 分布段的"最少"必须等于逐维度表里 signal 的真实最小值
 *    (自洽性 —— 防止分布段印出一个与 tally 不符的数);
 * ③ 行为: 分布段必须点名至少一个维度, 且被点名者的条数必须确是全表最小;
 * ④ 反向证明: 把分布段从副本里删掉, ②③ 必须失败;
 * ⑤ 披露: 最薄维度的名单会随语料/测试增长而变, 所以锁不变式不锁名单。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'dimension-health-audit.js');
  const { withDocLock } = require(path.join(__dirname, '_doc-probe-lock.js'));
  const { execFileSync } = require('child_process');

  function runAudit(scriptPath) {
    try {
      return execFileSync('node', [scriptPath || SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000,
      });
    } catch (e) {
      return (e.stdout || '').toString();
    }
  }
  function srcNoComments() {
    return fs.readFileSync(SCRIPT, 'utf8')
      .split('\n').map(l => l.replace(/\/\/[^\n]*$/, m => ' '.repeat(m.length))).join('\n');
  }

  // ── ① 源级: 分布段必须存在 ─────────────────────────────────
  test('源级: 汇总段必须报触发条数分布(不能只有布尔)', () => {
    const src = srcNoComments();
    assertTrue(/触发条数分布/.test(src), '汇总段没有"触发条数分布" —— 又回到只有布尔');
    assertTrue(/tally\[[^\]]*\]\s*\?\s*tally\[[^\]]*\]\.signal/.test(src) || /\.signal\s*:\s*0/.test(src),
      '分布段没有从 tally 读 signal —— 它印的不是那个已经在数的量');
    // 前提自证: 剥注释没把真代码剥掉
    assertTrue(/const tally = /.test(src) && /signal: 0/.test(src),
      '剥注释把真代码也剥掉了 —— 本源级断言已空转');
  });

  // ── ② 行为: 分布段的最少值必须等于逐维度表的真实最小值 ───────
  test('行为: 分布段的最少条数必须等于逐维度表的最小 signal', () => withDocLock(() => {
    const out = runAudit();
    // 逐维度表: "  <dim>  信号  <n>  finding ..."
    const perDim = [];
    for (const m of out.matchAll(/^\s{2}(\w+)\s+信号\s+(\d+)\s+finding/gm)) {
      perDim.push({ dim: m[1], n: Number(m[2]) });
    }
    assertTrue(perDim.length >= 40,
      `逐维度表只解析出 ${perDim.length} 行(应 ≥40) —— 解析正则与输出形态脱节, 本条已空转`);
    const realMin = Math.min(...perDim.map(r => r.n));
    // 分布段: "     池 11300 条 · 最多 ... · 最少 2 条 · 中位 ..."
    const seg = out.split('触发条数分布')[1] || '';
    const minM = seg.match(/最少\s*(\d+)\s*条/);
    assertTrue(!!minM, '分布段没印"最少 N 条" —— 段不存在或形态已变');
    assertEqual(Number(minM[1]), realMin,
      `分布段报最少 ${minM[1]} 条, 而逐维度表的真实最小值是 ${realMin} —— 分布段印的数与 tally 不符`);
    // 中位数也必须落在表内(防呆: 分布段不能印一个不存在的数)
    const medM = seg.match(/中位\s*(\d+)\s*条/);
    if (medM) {
      const ns = perDim.map(r => r.n).sort((a, b) => a - b);
      assertTrue(ns.includes(Number(medM[1])),
        `分布段报中位 ${medM[1]} 条, 但逐维度表里没有这个 signal 值`);
    }
  }));

  // ── ③ 行为: 必须点名最薄的维度, 且条数确是全表最小 ───────────
  test('行为: 分布段必须点名最薄的维度, 且其条数确为全表最小', () => withDocLock(() => {
    const out = runAudit();
    const perDim = [];
    for (const m of out.matchAll(/^\s{2}(\w+)\s+信号\s+(\d+)\s+finding/gm)) perDim.push({ dim: m[1], n: Number(m[2]) });
    assertTrue(perDim.length >= 40, `逐维度表只解析出 ${perDim.length} 行`);
    const realMin = Math.min(...perDim.map(r => r.n));
    const seg = out.split('触发条数分布')[1] || '';
    const named = [...seg.matchAll(/^\s+(\d+)\s+条\s+(\w+)\s+\(A=/gm)].map(m => ({ n: Number(m[1]), dim: m[2] }));
    assertTrue(named.length >= 1, '分布段没有点名任何薄维度 —— 报了一个分布却没指名, 读者仍不知道是谁');
    for (const x of named) {
      const row = perDim.find(r => r.dim === x.dim);
      assertTrue(!!row, `分布段点名了 ${x.dim}, 但逐维度表里没有这一行`);
      assertEqual(row.n, x.n, `分布段说 ${x.dim} 有 ${x.n} 条, 表里是 ${row.n} 条`);
      // 被点名者是**一批**(≤ 池的 0.2%), 不是只有最小值那几个 ——
      // 所以门槛判据是"不超过段内自己报的那个门槛", 不是"等于最小值"。
      const cutM = seg.match(/≤\s*(\d+)\s+条/);
      assertTrue(!!cutM, '分布段没印出门槛"≤ N 条"');
      assertTrue(x.n <= Number(cutM[1]),
        `分布段点名 ${x.dim}(${x.n} 条), 超过它自己报的门槛 ${cutM[1]} 条 —— 点名的不是最薄的那批`);
      assertTrue(x.n >= realMin,
        `分布段点名 ${x.dim}(${x.n} 条), 但全表最小是 ${realMin} 条 —— 点名数小于真实最小值, 数是假的`);
    }
    // 前提自证: 表里确有条数 ≤ 池 0.2% 的维度(否则"点名最薄"恒真)
    const nPool = Number((out.match(/去重后\s*(\d+)/) || [])[1]);
    assertTrue(nPool > 0 && realMin <= Math.ceil(nPool * 0.002) + 1,
      `全表最小 ${realMin} 条已超过池 ${nPool} 的 0.2% —— 门槛的前提已变, 请更新本锁`);
  }));

  // ── ④ 反向证明: 删掉分布段, ②③ 必须失败 ────────────────────
  test('反向证明: 删掉分布段后, 最小值核对与点名都必须落空', () => {
    const orig = fs.readFileSync(SCRIPT, 'utf8');
    const startMark = '// ── [dimension-health-audit·第二百二十轮] 触发条数分布 ──';
    const start = orig.indexOf(startMark);
    assertTrue(start > 0, '源码里找不到分布段的注释头 —— 锚点已变, 本反向证明无效');
    // 段尾: 下一个顶层语句(汇总段之后的 const realNever)
    const endMark = 'const realNever = never.filter';
    const end = orig.indexOf(endMark, start);
    assertTrue(end > start, '找不到分布段的收束 —— 锚点已变');
    const broken = orig.slice(0, start) + orig.slice(end);
    assertTrue(broken !== orig && !broken.includes('第二百二十轮] 触发条数分布'),
      '变异未生效 —— 锚点没匹配上, 本次反向证明无效');
    const tmp = path.join(ROOT, 'scripts', '_dimhealth-broken-220.tmp.js');
    fs.writeFileSync(tmp, broken);
    try {
      const out = runAudit(tmp);
      assertTrue(!/触发条数分布/.test(out),
        '删掉分布段后副本仍印出该段 —— 说明印它的不是这一段代码, 反向证明无效');
      // 反向对照: 同一次运行里四条汇总线必须仍在(证明副本没整个坏掉)
      assertTrue(/从未触发:/.test(out) && /曾触发且推 finding:/.test(out),
        '副本跑失败了或汇报名单也消失了 —— 反向证明的对照不成立');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  });

  // ── ⑤ 披露: 名单会变, 锁的是不变式 ─────────────────────────
  test('披露: 最薄维度的名单会随语料/测试增长而变, 本锁不锁名单', () => withDocLock(() => {
    const out = runAudit();
    const seg = out.split('触发条数分布')[1] || '';
    // 段内必须自带"薄不等于失效"的说明, 否则读者会把薄维度当缺陷清单
    assertTrue(/薄不等于失效/.test(seg),
      '分布段没有写"薄不等于失效" —— 它会被当成一份缺陷清单读, 而那正是 cycle 11 '
      + '"仪器把自己的局限报成引擎缺陷"的形状');
    // 且必须说明报它的理由
    assertTrue(/带上量纲/.test(seg), '分布段没有说明为什么报它');
  }));
};
