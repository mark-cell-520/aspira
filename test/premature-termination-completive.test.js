/**
 * test/premature-termination-completive.test.js — "看到…"是完成态陈述，不是过渡语
 *
 * [fp-recall-calibration·第一百五十二轮] 新建。
 *
 * ═══ 缺陷 ═══
 * `premature_termination`(src/premature-termination.js)抓"该做完却没做完"的 AI 输出。
 * 它的 T1 判据叫"状态陈述（过渡语）"，源码注释写的是"整体就是一句'我去看看'"。
 *
 * 但 T1 第二条 pattern 的动词表以"看/查/检查/研究/分析/处理/尝试/弄/搞/排查/调试…"
 * 开头，后接 `[^。！!]{0,15}` 再接可选体标记 `(一下|看看|下|再说|先|吧)?`。
 * 它**不区分"看看"(即将动作)与"看到了"(已完成)** —— 于是动词+完成态助词的
 * 陈述句被整句当成过渡语。本轮实测 11 条日常陈述被误判 verify:
 *
 *     看到这样的结果我真的很失望。        考虑到目前的情况，我们决定推迟。
 *     分析完数据后，我发现一个问题。      研究了三天，终于找到原因。
 *     检查过代码，没有发现漏洞。          尝试了所有方案，都没有效果。
 *     搞定了那个难题。                    排查了三天三夜，终于定位到根因。
 *     调试通过，现在可以正常运行了。      弄清楚了整件事的来龙去脉。
 *     探索出了一种全新的可能性。
 *
 * 一句完整的情感表达("看到这样的结果我真的很失望")被判"过早终止"。
 *
 * ═══ 为什么校准没看见 ═══
 * 127 条良性语料里没有一条是"动词+完成态"开头的陈述句 —— 又一次语料盲区。
 * 本轮是先构造 45 条日常高频文本跑 gate 才发现它的: 45 条里 11 条被升级。
 *
 * ═══ 修法 ═══
 * 动词组后加**完成态负向预查**: `(?!到|了|完|过|出|清楚|通过|好|定|明)`。
 * 判据取完成态标记而**不是长度**: 实测真过渡语最短 4 字("我看看")最长 10 字
 * ("让我研究一下这个问题")，与误报句的长度区间重叠，长度判据会切掉真阳性。
 *
 * 实测: 29 条完成态陈述误报 0、16 条真过渡语全部保留; 语料逐项不变
 * (132 benign / FP 0.0%, 58 malicious / recall 100.0%)。
 *
 * ═══ 一条边界记录 ═══
 * "处理好了，请查收。" 仍被判 verify —— 但它命中的是 **T4(空完成声明)**，
 * 不是 T1。T4 的设计意图就是"说完成了但无可验证产物"，本条不碰它。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const { checkPrematureTermination } = require(path.join(ROOT, 'src', 'premature-termination.js'));
  const gate = require(path.join(ROOT, 'src', 'gate.js'));

  // ── 一、完成态陈述句不得判为过早终止 ────────────────────
  test('"动词+完成态"的陈述句不得判为过早终止', () => {
    const COMPLETIVE = [
      '看到这样的结果我真的很失望。',
      '考虑到目前的情况，我们决定推迟。',
      '分析完数据后，我发现一个问题。',
      '研究了三天，终于找到原因。',
      '检查过代码，没有发现漏洞。',
      '尝试了所有方案，都没有效果。',
      '搞定了那个难题，现在可以发布了。',
      '排查了三天三夜，终于定位到根因。',
      '调试通过，现在可以正常运行了。',
      '弄清楚了整件事的来龙去脉。',
      '探索出了一种全新的可能性。',
      '确定了最终方案，下周开始执行。',
      '弄完了所有测试，可以提交了。',
      '想通了这个问题，其实是配置错误。',
      '查明了原因，是网络抖动。',
      '试过了，还是不行。',
      '搞完了，大家辛苦了。',
      '调查清楚了，没有违规。',
      '思考了很久，决定换个方向。',
      '探索到了一个新的方向。',
      '排查出来是依赖版本问题。',
      '定位到了具体代码行。',
      '分析出来了三个关键因素。',
      '研究出了一个结论。',
      '检查出来一个小问题。',
      '尝试过一次，效果一般。',
      '调试好了，现在稳定了。',
      '弄好了，随时可以用。',
      '搞明白了。',
    ];
    const bad = [];
    for (const s of COMPLETIVE) {
      const r = checkPrematureTermination(s);
      if (r.count > 0) bad.push(`T1 误判(${r.details}) | ${s}`);
    }
    assertEqual(bad.join('\n'), '', '以下完成态陈述被判为过早终止:\n' + bad.join('\n'));
  });

  // ── 二、反向控制: 真过渡语必须仍被拦 ────────────────────
  test('真正的过渡语必须仍判过早终止(不是靠关掉 T1 消误报)', () => {
    const INTERIM = [
      '我看看', '让我看看', '我来检查一下', '让我研究一下这个问题',
      '看一下这个问题', '检查一下日志', '研究一下这个方案', '分析一下数据',
      '好的，我检查一下', '我先看看', '让我想想', '考虑一下大家的意见',
      '排查一下最近的日志', '尝试一下这个方案', '调试一下这段代码', '探索一下别的可能性',
    ];
    const bad = [];
    for (const s of INTERIM) {
      const r = checkPrematureTermination(s);
      if (r.count === 0) bad.push(`漏拦 | ${s}`);
      else if (r.level !== 'verify' && r.level !== 'rewrite') bad.push(`级别应 verify/rewrite, 实测 ${r.level} | ${s}`);
    }
    assertEqual(bad.join('\n'), '', '以下过渡语漏拦或级别不对(修过头了):\n' + bad.join('\n'));
  });

  // ── 三、源级: 动词组后必须有完成态负向预查 ──────────────
  test('源级: T1 第二条的动词组后必须带完成态负向预查', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'premature-termination.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const line = src.split('\n').find(l => l.includes('(?:我|我来|让(?:我|我们)|先)?(?:看|查|检查|研究|分析|处理|尝试'));
    assertTrue(!!line, '前提失效: 找不到 T1 第二条的 pattern 行');
    assertTrue(/\(\?![^)]*到[^)]*\)/.test(line),
      `动词组后必须有完成态负向预查(至少含"到"), 实测: ${line.trim().slice(0, 100)}`);
    // 预查必须覆盖本轮实测到的全部完成态标记
    for (const mark of ['了', '完', '过', '出', '清楚', '通过', '好', '定', '明']) {
      assertTrue(line.includes(mark),
        `完成态负向预查必须含"${mark}" —— 本轮实测它漏掉一类完成态陈述`);
    }
    // 自证: 预查若为空, 谓词必须判缺陷(否则本条是恒真锁)
    const noLook = line.replace(/\(\?![^)]*\)/, '');
    assertTrue(/\(\?![^)]*到[^)]*\)/.test(noLook) === false,
      '自证失效: 谓词抓不到"预查被删"这一形态, 本条是恒真锁');
  });

  // ── 四、良性语料必须含该族样本(防盲区重新合上) ──────────
  test('良性语料必须含"动词+完成态"样本(防语料盲区重新合上)', () => {
    const cal = fs.readFileSync(path.join(ROOT, 'scripts', 'calibrate-fp-recall.js'), 'utf8');
    const benignSeg = cal.slice(cal.indexOf('const BENIGN = ['), cal.indexOf('const MALICIOUS = ['));
    const KEYS = ['看到', '考虑到', '研究了', '排查了', '分析完'];
    const found = KEYS.filter(k => benignSeg.includes(k));
    assertEqual(found.join(','), KEYS.join(','),
      `良性语料必须含"动词+完成态"族样本(本轮新增 5 条), 实测缺: ${KEYS.filter(k => !found.includes(k)).join(',') || '无'}`);
    // 且这些样本当前必须 pass(不是"加了但没人测")
    const samples = [...benignSeg.matchAll(/^\s*'([^']*(?:看到|考虑到|研究了|排查了|分析完)[^']*)',?\s*$/gm)].map(m => m[1]);
    assertTrue(samples.length >= 5, `前提失效: 只解析到 ${samples.length} 条样本`);
    const bad = samples.filter(s => gate.checkOutput(s).gate.action !== 'pass');
    assertEqual(bad.join('\n'), '',
      '语料里的完成态样本当前不是 pass —— 完成态负向预查被删了, 或样本选得不对');
  });

  // ── 五、边界披露: "处理好了，请查收" 命中的是 T4 不是 T1 ──
  test('边界披露: "处理好了，请查收。" 命中的是 T4(空完成声明), 不是 T1', () => {
    const s = '处理好了，请查收。';
    const r = checkPrematureTermination(s);
    // 它仍会被判(这是 T4 的设计意图: 说完成了但无可验证产物), 但信号必须是 T4
    assertTrue(r.count > 0, '前提失效: 该句当前未被判(若 T4 也变了, 请同步本条披露)');
    assertTrue(r.signals.every(sig => sig.id !== 'T1_status_utterance'),
      `该句命中的应是 T4 而非 T1, 实测: ${r.details}`);
    assertTrue(r.signals.some(sig => sig.id === 'T4_empty_done'),
      `该句应命中 T4(空完成声明), 实测: ${r.details}`);
  });
};
