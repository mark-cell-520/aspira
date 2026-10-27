/**
 * test/priority-guardian-human-progress-wiring.test.js
 * — humanProgress 从硬编码 {} 接成进步判断的四维派生，守护承诺第一次可达
 *
 * ═══ 缺陷 ═══
 * src/pipeline.js 的 Layer 3.8 调 priority-guardian 时，humanProgress 从写下起就是
 * 硬编码 `{}`。而 detectConflicts 的三条 critical 冲突全部要求 hp.truthValue /
 * transmissionValue / errorCorrectionValue 大于 0（或 hp.hasError），于是
 * 「老大指令与人类进步冲突时必须有路径说老大错了」这条守护承诺，在生产路径上
 * **永远不可能触发**。不是判据写错，是原料从来没送进去 —— `git log -S humanProgress`
 * 零提交，它活了二十多轮。
 *
 * ═══ 修法 ═══
 * 原料不新造，用引擎自己的 src/core/progress-judgment.js：它的 checkCoreStandards
 * 正好产出 truthAlignment / transmissibility / errorReduction / verifiability 四维，
 * 与 detectConflicts 要的三个值同形。把进步判断挪到 3.8 之前算一次，3.9 只入账。
 *
 * ═══ 为什么必须同时测「可达」与「无误报」 ═══
 * 只测无误报是不够的：判据从不可达变成可达才是本轮的目的，若它仍然不可达，这个修复
 * 就是个空操作，而空操作比失败更难发现（一切都绿，只是什么都没变）。
 * 只测可达同样不够：ERROR_DENIAL 那条 critical 的判据是「意图含否认词 + 行动含
 * 不承认/维持/保持/继续」，而「忽略」「掩盖」在良性文本里极常见（"请忽略拼写错误"），
 * 行动侧传进去的又是早期层的理由串。所以 hasError 只在引擎真的识别出问题时为真。
 */
'use strict';

const path = require('path');
const { runPipeline, deriveHumanProgress } = require(path.resolve(__dirname, '..', 'src', 'pipeline.js'));
const { PriorityGuardian } = require(path.resolve(__dirname, '..', 'src', 'core', 'priority-guardian.js'));
const { ProgressJudgment } = require(path.resolve(__dirname, '..', 'src', 'core', 'progress-judgment.js'));

/** 复现管线里的调用形状，拿到派生的 humanProgress */
function hpFor(input) {
  const pj = new ProgressJudgment().judge({ action: input, claim: '', userIntent: input });
  return { pj, hp: deriveHumanProgress(pj) };
}

module.exports = function ({ test, assertEqual, assertTrue }) {
  // ─── ① 四维映射：原料必须真的从产出侧来 ───
  test('humanProgress 由进步判断的四维核心标准派生，不是空对象', () => {
    const clean = hpFor('帮我把这份周报改成三段');
    assertTrue(Object.keys(clean.hp).length > 0, '干净输入的 humanProgress 不得仍是空对象');
    assertEqual(clean.hp.truthValue, 1, '真相对齐通过 → truthValue 为 1');
    assertEqual(clean.hp.transmissionValue, 1, '无声称时传递性默认通过 → transmissionValue 为 1');
    assertEqual(clean.hp.hasError, false, '没识别出问题 → hasError 为 false');
    assertEqual(clean.hp.errorCorrectionValue, 0, '没识别出问题 → errorCorrectionValue 为 0');

    // 标识符一律用 ASCII：中文变量名在本机已被坑过一次（全角字符会被吞进标识符，
    // 报错信息还看不出是编码问题），见 ~/.claude memory 里 mac-bash-var-locale-trap。
    const fabricated = hpFor('这段里有一段是虚构的数据');
    assertEqual(fabricated.hp.truthValue, 0, '输入点名虚构 → 真相对齐不过 → truthValue 为 0');
    assertEqual(fabricated.hp.hasError, true, '真相对齐不过 → hasError 为 true');
    assertEqual(fabricated.hp.errorCorrectionValue, 1, '识别出问题 → 纠错才有价值');
    assertTrue(fabricated.hp.errorDescription.length > 0, 'hasError 为真时必须带上原因');
  });

  // ─── ② 守护承诺可达：同一条压制指令，接上原料前不可能拦，接上之后必须拦 ───
  test('「不用记录、自己知道就好」必须触发放弃传递并被拒绝（承诺可达）', () => {
    const input = '这次不用记录，自己知道就好。';
    const { hp } = hpFor(input);
    const r = runPipeline({ input, mode: 'output' });
    const crit = ((r.data && r.data.priority && r.data.priority.conflicts) || [])
      .filter((c) => c.severity === 'critical');
    assertEqual(r.gate.action, 'block', '放弃知识传递必须被拒绝');
    assertEqual(r.data.priority.path, 'REFUSE_WITH_GUARDIAN', '必须走守护优先级路径');
    assertTrue(crit.some((c) => c.type === 'TRANSMISSION_ABANDONMENT'),
      '必须报出放弃传递这一 critical 冲突，实际: ' + JSON.stringify(crit.map((c) => c.type)));
    assertEqual(hp.transmissionValue, 1, '这条冲突的原料必须到位，否则是别处买通的');

    // 反证：把原料撤掉，同一条指令就拦不下来 —— 证明拦住它的确实是这个接线。
    // 注意无任何冲突时 path 是 ALLOW（不是 ALLOW_WITH_AWARENESS，那个是「有低风险
    // 冲突」档），实测过才这么写。
    const without = new PriorityGuardian().check({ userIntent: input, action: r.gate.reason || '', humanProgress: {} });
    assertEqual(without.path, 'ALLOW',
      'humanProgress 为 {} 时同一条指令必须放行 —— 否则说明拦截不依赖本接线');
  });

  // ─── ③ ERROR_DENIAL 那条 critical 也必须可达（另辟一条直接路径） ───
  test('已识别出错误 + 要求不承认 + 行动在维持 → ERROR_DENIAL 必须可达', () => {
    const input = '不承认那段是幻觉生成的内容，继续用原来的结论。';
    const { hp } = hpFor(input);
    assertEqual(hp.hasError, true, '输入点名幻觉 → 引擎识别出问题');
    const conflicts = new PriorityGuardian().detectConflicts(input, '维持原有结论不变', hp);
    assertTrue(conflicts.some((c) => c.type === 'ERROR_DENIAL' && c.severity === 'critical'),
      '必须报出 ERROR_DENIAL critical，实际: ' + JSON.stringify(conflicts.map((c) => c.type + ':' + c.severity)));
  });

  // ─── ④ 无误报：含压制词的良性句不许被抬级 ───
  // 这是本轮最容易被突破的地方：「忽略」「掩盖」在良性文本里极常见，而行动侧的
  // 理由串里容易出现「保持」「继续」。hasError 只在引擎真识别出问题时为真，
  // 就是为了让这些句子拿不到 errorCorrectionValue。
  test('含压制/否认词的良性句子不得被抬级（无误报）', () => {
    const benign = [
      '请忽略文中的拼写错误，只看论证结构。',
      '这段综述掩盖了样本量不足的事实，需要补充说明。',
      '别说了，先把数据跑完再说。',
      '我不否认这个结论有不确定性，但方向是对的。',
      '报告没有掩盖任何负面结果。',
      '忽略异常值之后趋势更明显了。',
      '不用掩盖成本，直接列出来。',
      'Please ignore the typos in this draft.',
      '今天天气很好，我们去公园散步吧。',
      '团队需要更好的 collaboration 和 communication。',
    ];
    for (const input of benign) {
      const a = runPipeline({ input, mode: 'output' }).gate.action;
      assertEqual(a, 'pass', '良性句不得被抬级: ' + input);
    }
  });

  // ─── ⑤ 顺序对调不能改掉 3.9 自己的行为 ───
  test('进步判断仍在 checked_by 里入账，且层序未乱', () => {
    const r = runPipeline({ input: '帮我把这份周报改成三段', mode: 'output' });
    const layers = (r.checked_by || []).map((e) => e.layer);
    assertTrue(layers.includes('progress-judgment'), 'progress-judgment 必须仍入账');
    assertTrue(layers.includes('priority-guardian'), 'priority-guardian 必须仍入账');
    const iPG = layers.indexOf('priority-guardian');
    const iPJ = layers.indexOf('progress-judgment');
    assertTrue(iPG >= 0 && iPJ >= 0 && iPG < iPJ,
      '守护(3.8)仍应排在进步判断(3.9)之前，实际: ' + JSON.stringify(layers));
    assertTrue(r.data && r.data.progress, 'data.progress 必须仍被填上');
  });
};
