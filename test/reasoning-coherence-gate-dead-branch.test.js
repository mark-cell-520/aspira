/**
 * test/reasoning-coherence-gate-dead-branch.test.js — 闸门比较了它永远取不到的值
 *
 * [dimension-health-audit·第一百五十轮] 新建。
 *
 * ═══ 缺陷 ═══
 * 维度健康审计的逐维度读数里, `reasoning_coherence` 是 **信号 88 / finding 2** ——
 * 88 个输入让 score 非零, 只有 2 个能变成 finding, 86 个信号到此为止。
 * (同族的 gaslighting 47/6、bullshit_recognition 28/13 也有落差, 但都不及它。)
 *
 * 定位到 finding 闸门 `rcBroken` 的第三个条件:
 *
 *     rc.structure === '结构碎片' || rc.structure === 'unknown' || leap.count > 0
 *
 * 实测**前两个是死值** —— `checkReasoningCoherence` 从不把它们赋给 structure。
 * 它会赋的是: 完整推理链 / 有前提有推理无结论 / 有前提有结论缺推理 /
 * 无前提直接推理结论 / 跳跃推理（无依据）/ 直接结论无推理 / 无推理结构 /
 * 部分结构碎片; 另有 no_text(提前 return)。`unknown` 只是初始值, 而每条分支
 * (含 else 兜底)都会给 structure 赋值, 所以它也取不到。
 *
 * 于是闸门实际只剩 `leap.count > 0`。而它上面的注释写的是
 * "有 premise/inference 标记却缺 conclusion 或跳跃 = 推理链断裂" ——
 * **注释说的"缺 conclusion"那一半从未执行过**。
 *
 * 这是本仓库反复记录的形状: 一个看起来在工作的条件其实是死的,
 * 而它保护的功能(推理链断裂提示)因此静默缺失。
 *
 * ═══ 为什么本轮只删死条件、不按注释意图补全 ═══
 * 实测: 若补上 '有前提有推理无结论' 等真实结构值, 会在 **16 条良性样本**上开火:
 *   代码片段   const data = await fetch(url).then(r => r.json());
 *             axios.get("https://api.example.com/data");
 *   hedge 护栏 实验显示转化率提升 3 倍，但样本量仅 200，结论有待确认。
 *             实验显示转化率提高了2倍，但样本量仅50，结论有待确认。
 *   正常陈述   这个 bug 是因为 race condition 导致的，需要加锁处理。
 *             本研究存在局限：样本集中于一线城市，外推需谨慎。
 * FP 会从 0.0% 升到 **13%**。
 *
 * 根因不在闸门而在 REASONING_MARKERS 过宽: '因为'/'因此'/'then' 就把一句陈述
 * 算成"有推理意图"(16 条里 8 条的 intent 来自代码与技术陈述)。修它需要产品
 * 判断(哪些词真的表示推理意图), 不是一行正则 —— 按铁律 2 本轮不做, 只删死条件
 * 并把测量钉在这里。
 *
 * ═══ 实测 ═══
 *   删死条件前后语料逐项相同: 127 benign / FP 0.0%, 58 malicious / recall 100.0%
 *   (删的是永不成立的条件, 行为等价)
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const idx = require(path.join(ROOT, 'src', 'index.js'));
  const gate = require(path.join(ROOT, 'src', 'gate.js'));

  const SRC = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  const strip = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  // checkReasoningCoherence 的**分支**会赋给 structure 的值集合。
  // 注意要剔除 `let structure = 'unknown';` 这一初始化行: unknown 是初始值,
  // 之后每条分支(含 else 兜底)都会覆盖它, 所以它对闸门是不可达的。
  // 不剔除就会把它算成可达值, 而下面的自证正是要抓它 —— 那是仪器自己的局限,
  // 不是引擎的缺陷(本仓库为这个形状付过好几次学费)。
  function assignedStructures() {
    const src = strip(SRC);
    const i = src.indexOf('function checkReasoningCoherence');
    assertTrue(i > 0, '前提失效: 找不到 checkReasoningCoherence 函数');
    const end = src.indexOf('function checkTheoryOfMind', i);
    const body = src.slice(i, end > 0 ? end : i + 8000)
      .split('\n').filter(l => !/let structure\s*=\s*'unknown'/.test(l)).join('\n');
    const vals = [...body.matchAll(/structure\s*=\s*'([^']+)'/g)].map(m => m[1]);
    return new Set(vals);
  }

  // rcBroken 闸门那一行里比较的 rc.structure 值
  function comparedStructures() {
    const src = strip(SRC);
    const line = src.split('\n').find(l => l.includes('const rcBroken ='));
    assertTrue(!!line, '前提失效: 找不到 rcBroken 闸门行');
    return [...line.matchAll(/rc\.structure\s*===\s*'([^']+)'/g)].map(m => m[1]);
  }

  // ── 一、源级: 闸门比较的每个 structure 值都必须可达 ──────
  test('源级: rcBroken 闸门比较的 structure 值必须是 checkReasoningCoherence 会赋的值', () => {
    const assigned = assignedStructures();
    assertTrue(assigned.size >= 8,
      `前提失效: 只解析到 ${assigned.size} 个 structure 赋值, 解析失效会让本条恒绿`);
    const compared = comparedStructures();
    const dead = compared.filter(v => !assigned.has(v));
    assertEqual(dead.join(', '), '',
      `闸门比较了永远不会被赋值的 structure 值: ${dead.join(', ')} —— ` +
      `这些条件是死的(本轮第一百五十轮实测: 原闸门的 '结构碎片' 与 'unknown' 都是死值, ` +
      `导致 reasoning_coherence 读数 88 信号 / 2 finding)。可赋值为: ${[...assigned].join(' / ')}`);
    // 自证: 同一个谓词必须判已知死值为缺陷, 否则本条是恒真锁
    const ok = (vals) => vals.every(v => assigned.has(v));
    assertTrue(!ok(['结构碎片']),
      '自证失效: 谓词抓不到已知死值 结构碎片, 本条是恒真锁');
    assertTrue(!ok(['unknown']),
      '自证失效: 谓词抓不到已知死值 unknown(它是初始值, 但每条分支都会给 structure 赋值), 本条是恒真锁');
  });

  // ── 二、披露: "缺 conclusion"这一半注释意图至今未执行 ────
  test('披露: 有前提有推理但缺结论的句子当前不推 finding(注释意图未执行, 未修)', () => {
    // 注释写的是"有 premise/inference 标记却缺 conclusion = 推理链断裂"。
    // 实测: 这类句子的 structure 是 '有前提有推理无结论' 而闸门只认 leap>0,
    // 所以它不推 finding。本轮按铁律 2 不补(实测会误报 16 条良性, FP 0.0%→13%)。
    const samples = [
      '实验显示转化率提升 3 倍，但样本量仅 200，结论有待确认。',
      '实验显示转化率提高了2倍，但样本量仅50，结论有待确认。',
    ];
    for (const s of samples) {
      const rc = idx.checkReasoningCoherence(s);
      assertEqual(rc.structure, '有前提有推理无结论',
        `前提失效: 该句的 structure 应是有前提有推理无结论, 实测 ${rc.structure}`);
      const f = (idx.discriminate(s, []).findings || []).filter(x => x.dimension === 'reasoning_coherence');
      assertEqual(f.length, 0,
        `该句现在推 reasoning_coherence finding 了 —— 闸门被按注释意图放开了。` +
        `请先读 src/index.js 里 rcBroken 上方第一百五十轮那段注释: 放开会在 16 条良性样本上开火,` +
        `FP 0.0%→13%, 根因是 REASONING_MARKERS 过宽。样本: ${s.slice(0, 30)}`);
    }
  });

  // ── 三、防放宽锁: 那 16 条良性样本必须全部 pass ──────────
  test('防放宽: 闸门一放宽就会误报的 16 条良性样本必须全部 pass', () => {
    // 这 16 条是本轮实测"按注释意图补全结构条件后会被误报"的集合, 逐条来自
    // 校准语料(123 benign 的子集)。把它们钉在这里: 将来有人放宽闸门, 本条红,
    // 而不用等下一轮校准才发现 FP 从 0.0% 跳到 13%。
    const WOULD_MISFIRE = [
      'const data = await fetch(url).then(r => r.json());',
      'axios.get("https://api.example.com/data");',
      'According to the 2024 report, sales grew by 12%, though the sample was small.',
      '实验显示转化率提升 3 倍，但样本量仅 200，结论有待确认。',
      '本研究存在局限：样本集中于一线城市，外推需谨慎。',
      '这个 bug 是因为 race condition 导致的，需要加锁处理。',
      '数据库需要加 index 来优化这个 slow query。',
      '需要做 data migration，注意备份。',
      '请按人头统计参加年会的人数。',
      '这个公式的分母是参与实验的总人数。',
      'api.example.com/data returns JSON',
      'const data = await fetch(url).then(r => r.json())',
      '这一点我缺乏足够证据，建议查阅官方文档确认。',
      'According to a 2024 industry report, the median deployment time is 12 minutes.',
      '多数专家倾向于这个方案，但仍有争议，需要更多数据。',
      '实验显示转化率提高了2倍，但样本量仅50，结论有待确认。',
    ];
    const bad = [];
    for (const s of WOULD_MISFIRE) {
      const r = gate.checkOutput(s);
      if (r.gate.action !== 'pass') bad.push(`${r.gate.action} | ${s.slice(0, 45)}`);
    }
    assertEqual(bad.join('\n'), '',
      '以下良性样本被升级了 —— rcBroken 闸门被放开, 而本轮实测这会误报:\n' + bad.join('\n'));
  });

  // ── 四、反向控制: 真跳跃推理必须仍推 finding ─────────────
  test('真正的跳跃推理必须仍推 reasoning_coherence finding(闸门没被完全关掉)', () => {
    // 删死条件不能把闸门整个关掉: intent>0 + leap>0 + score<0.4 仍要报。
    const LEAPY = [
      '因为数据支持这个结论，显然这就是唯一正确的选择。',
      '由于成本上升，显而易见我们必须立刻全面转向。',
      '基于以上分析，显然用户完全不可能是对的。',
    ];
    const bad = [];
    for (const s of LEAPY) {
      const rc = idx.checkReasoningCoherence(s);
      const intent = (rc.markers?.premise?.count || 0) + (rc.markers?.inference?.count || 0);
      if (intent <= 0 || (rc.markers?.leap?.count || 0) <= 0) { bad.push(`前提失效(不再是跳跃+推理意图): ${s}`); continue; }
      const f = (idx.discriminate(s, []).findings || []).filter(x => x.dimension === 'reasoning_coherence');
      if (f.length === 0) bad.push(`未推 finding | ${s}`);
    }
    assertEqual(bad.join('\n'), '', '以下跳跃推理句漏报(闸门被关过头了):\n' + bad.join('\n'));
  });

  // ── 五、披露: 86 个信号到不了 finding ───────────────────
  test('披露: 语料里有推理意图却不推 finding 的条数仍大于 0(未修)', () => {
    // 本轮实测: 校准语料 185 条里 19 条有推理意图, **19 条全部**未推 finding
    // (它们的 structure 是 部分结构碎片 / 有前提有推理无结论, 而闸门只认 leap>0)。
    // 这是"闸门只剩一个活判据"的直接后果。若将来 REASONING_MARKERS 收窄或闸门
    // 重新设计, 这个数会变 —— 那时请同步更新本条披露与 rcBroken 上方注释。
    const corpus = JSON.parse(fs.readFileSync('/tmp/corpus149.json', 'utf8'));
    let intentTotal = 0, intentNoFinding = 0;
    for (const s of [...corpus.BENIGN, ...corpus.MALICIOUS]) {
      const rc = idx.checkReasoningCoherence(s);
      const intent = (rc.markers?.premise?.count || 0) + (rc.markers?.inference?.count || 0);
      if (intent <= 0) continue;
      intentTotal++;
      const f = (idx.discriminate(s, []).findings || []).filter(x => x.dimension === 'reasoning_coherence');
      if (f.length === 0) intentNoFinding++;
    }
    assertTrue(intentTotal > 0, `前提失效: 语料里没有带推理意图的样本了(实测 ${intentTotal})`);
    assertTrue(intentNoFinding > 0,
      `语料里有推理意图的 ${intentTotal} 条现在全部推 finding 了 —— ` +
      `reasoning_coherence 的闸门已被修好, 请同步更新 src/index.js 里 rcBroken ` +
      `上方第一百五十轮那段披露注释`);
  });
};
