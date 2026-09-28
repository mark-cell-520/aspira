/**
 * test/gate-pipeline-mode.test.js — aspira_gate_pipeline 的 mode 参数
 *
 * ═══ 为什么补这个测试 ═══
 * `scripts/mcp-echo-audit.js` 全量扫描 181 个工具时，报出
 * `aspira_gate_pipeline` 的 handler 读了 `mode` 但 inputSchema 未声明
 * —— 会被 MCP 中央参数校验静默丢弃。补 schema 时顺手一测，发现**更严重的问题**。
 *
 * ═══ 当场抓出的真缺陷: mode 参数此前完全是死的 ═══
 * 原 handler: `const { text, evidence = [], mode = 'fast' } = args || {}`
 * 然后 `gate.runPipeline({ input: text, mode, ... })`。
 *
 * 但 `src/pipeline.js` 的 runPipeline 只认三种模式:
 *     if (mode === 'input')  ...
 *     if (mode === 'output') ...
 *     if (mode === 'draft' || mode === 'output') ...
 * **`'fast'` 与 `'deep'` 匹配不上任何一个分支**，于是行为与完全不传 mode 相同。
 * 实测(同一输入 'kill me киll'):
 *     input  → 11 层      output → 13 层      draft → 12 层
 *     fast   → 11 层      deep   → 11 层      不传  → 11 层
 * 即 fast 与 deep **都是空操作**，且彼此也无区别。
 *
 * 而工具描述写着 "mode 可选 fast/deep"，AGENTS.md 的权威数字清单里还写着
 * "pipeline layers 17(11 for mode:'fast')"。**11 是碰巧对上**
 * (fall-through 到默认路径)，**17 则完全不符** —— 实测最大只有 13 层。
 * 这是 AGENTS.md "Honest numbers" 原则的一处违反: 文档声明的模式名与层数
 * 都与代码实际行为不符。
 *
 * ═══ 修法(非破坏性) ═══
 * · handler 默认值 'fast' → 'input'(真实模式，不再依赖 fall-through)
 * · 保留 fast/deep 作为**兼容别名**(fast→input, deep→output)，
 *   既有调用方不破
 * · schema enum 改为真实模式 + 两个别名，description 写明实测层数
 *
 * ═══ 断言的边界 ═══
 * · 锁"三个真实模式产生不同层数"与"两个别名产生对应层数"。
 * · 不锁具体层名清单(会随管线演进而变)，只锁层数与互异。
 * · 不锁 gate.action(取决于输入文本)。
 */
const path = require('path');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const ROOT = path.join(__dirname, '..');
  const gate = require(path.join(ROOT, 'src', 'gate.js'));

  const SAMPLE = 'kill me киll';   // 含西里尔同形字，adversarial-variant 会拦

  // ─── 缺陷本体: 三个真实模式必须产生不同层数 ─────────────────────────
  test('runPipeline 的三个真实模式(input/output/draft)产生不同层数', () => {
    const counts = {};
    for (const m of ['input', 'output', 'draft']) {
      const r = gate.runPipeline({ input: SAMPLE, mode: m });
      const cb = r.checked_by || [];
      counts[m] = cb.length;
      assertTrue(cb.length > 0, `mode=${m} 应有 checked_by`);
    }
    assertTrue(counts.input !== counts.output || counts.input !== counts.draft,
      `三个模式的层数不应全部相同，实测 ${JSON.stringify(counts)}`);
    // 记录性断言(层数会变，但三者互异这一性质不应变)
    assertTrue(counts.input < counts.output,
      `output 应比 input 多跑 output-gate/doubt-engine 等层，实测 ${JSON.stringify(counts)}`);
  });

  // ─── 缺陷本体: fast/deep 曾是空操作，现必须真的映射 ────────────────
  test('fast/deep 不得是空操作(此前与不传 mode 完全相同)', () => {
    const none = (gate.runPipeline({ input: SAMPLE }).checked_by || []).length;
    const fast = (gate.runPipeline({ input: SAMPLE, mode: 'fast' }).checked_by || []).length;
    const deep = (gate.runPipeline({ input: SAMPLE, mode: 'deep' }).checked_by || []).length;
    // 修复前: fast === none 且 deep === none(两者都不匹配任何分支)
    // 修复后: runPipeline 层不认识 fast/deep，映射发生在 MCP handler。
    // 所以这里断言的是**底层**行为: 未知模式退化为默认，
    // 而"默认"必须与 input 一致(handler 现在也把默认设成 input)。
    const input = (gate.runPipeline({ input: SAMPLE, mode: 'input' }).checked_by || []).length;
    assertEqual(none, input, '不传 mode 的默认行为必须等于 input');
    // fast/deep 在底层仍会退化 —— 这正是 handler 必须做映射的原因
    assertEqual(fast, none, '底层 runPipeline 不认识 fast(由 handler 映射，此处记录该事实)');
    assertEqual(deep, none, '底层 runPipeline 不认识 deep(由 handler 映射，此处记录该事实)');
  });

  // ─── MCP handler 必须把别名映射成真实模式 ───────────────────────────
  test('MCP handler 必须把 fast/deep 映射为真实模式(静态锁)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    const i = src.indexOf('function handleGatePipeline');
    assertTrue(i >= 0, '应找到 handleGatePipeline');
    const body = src.slice(i, i + 2000);
    assertTrue(/MODE_ALIAS/.test(body), 'handler 应含 MODE_ALIAS 映射表');
    assertTrue(/fast\s*:\s*'input'/.test(body), 'fast 应映射为 input');
    assertTrue(/deep\s*:\s*'output'/.test(body), 'deep 应映射为 output');
    // 默认值不得再是 'fast'(那会依赖底层 fall-through)
    assertTrue(!/mode\s*=\s*'fast'/.test(body),
      'handler 默认值不得是 fast(底层不认识它，必须显式用真实模式)');
    assertTrue(/mode\s*=\s*'input'/.test(body), 'handler 默认值应为 input');
    // 未知模式必须显式报错，不得静默退化
    assertTrue(/未知 mode/.test(body), '未知 mode 应显式报错');
  });

  // ─── schema 必须声明 mode 且 enum 含真实模式 ────────────────────────
  test('aspira_gate_pipeline 的 schema 必须声明 mode(此前被中央校验丢弃)', () => {
    const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));
    const tool = TOOLS.find(t => t.name === 'aspira_gate_pipeline');
    assertTrue(!!tool, '应找到 aspira_gate_pipeline 定义');
    const props = (tool.inputSchema && tool.inputSchema.properties) || {};
    assertTrue(!!props.mode, 'schema 必须声明 mode(否则中央校验会静默丢弃它)');
    const en = props.mode.enum || [];
    for (const m of ['input', 'output', 'draft']) {
      assertTrue(en.includes(m), `enum 应含真实模式 ${m}，实测 ${JSON.stringify(en)}`);
    }
    // 兼容别名也要在 enum 里，否则老调用方会被 schema 层拒掉
    for (const m of ['fast', 'deep']) {
      assertTrue(en.includes(m), `enum 应含兼容别名 ${m}(老调用方在用)，实测 ${JSON.stringify(en)}`);
    }
    // description 必须写实测层数，不得沿用错误的 "17 层"
    assertTrue(!/17 层/.test(props.mode.description || ''),
      `description 不得写 "17 层"(实测最大 13 层)，实测: ${props.mode.description}`);
  });

  // ─── AGENTS.md 的规范性章节不得再声称 17 层 / fast-deep ────────────
  test('AGENTS.md 规范性章节不得声称 17 层 / fast-deep 模式(实测最大 13 层)', () => {
    const fs = require('fs');
    const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    // ═══ Scope 修正(本测试首版自己是错的) ═══
    // 首版扫描**整个文件**，于是把我自己新写的历史纠错条目也报成缺陷
    // —— 因为那条目为了说明"曾经错在哪"，必须原文引用旧声明
    // "17 layers (11 for mode:'fast')"。
    // 这正是本仓反复记录的故障模式: **仪器把自己的局限说成被检对象的缺陷**
    // (dimension-health ×2、dead-counter ×2、mcp-contract ×4、mcp-echo ×3)。
    //
    // 收窄范围靠**结构**而不是内容白名单: 本仓的 blockquote(`> ` 开头)
    // 一律是纠错说明(Quick start 的 doc-examples 注、runPipeline 的这条注、
    // "What 54 counts" 都是)，它们**按定义就是**为了引用旧错误而存在。
    // 若按"含 used to / previously 就放过"来豁免，那就是本仓同样记录过的
    // 另一个故障模式——"测试匹配自己的解释性注释"。
    const cut = agents.indexOf('## Honest limitations');
    assertTrue(cut > 0, '应找到 ## Honest limitations 分节');
    const normative = agents.slice(0, cut)
      .split('\n')
      .filter(l => !/^\s*>/.test(l))     // 剥掉 blockquote 纠错说明
      .join('\n');
    const bad = [];
    for (const m of normative.matchAll(/[^\n]*17[^\n]*层[^\n]*/g)) {
      if (/mode|fast|deep/.test(m[0])) bad.push(m[0].trim());
    }
    for (const m of normative.matchAll(/[^\n]*pipeline[^\n]*layers[^\n]*17[^\n]*/gi)) {
      bad.push(m[0].trim());
    }
    // fast/deep 不得再被写成可用模式
    for (const m of normative.matchAll(/[^\n]*mode selection[^\n]*/g)) {
      if (/fast|deep/.test(m[0])) bad.push(m[0].trim());
    }
    assertEqual(bad.length, 0,
      `AGENTS.md 规范性章节(剥掉 blockquote 后)不得把 17 层与 mode 绑定或把 fast/deep 当可用模式(实测 input=11/draft=12/output=13): ${bad.join(' | ')}`);
  });

  // ─── 反向: 历史纠错记录必须存在(防止靠删条目规避) ──────────────────
  test('AGENTS.md 必须保留本条目的历史纠错记录(不得靠删条目规避断言)', () => {
    const fs = require('fs');
    const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    assertTrue(agents.includes('## Honest limitations'), '应有 Honest limitations 分节');
    assertTrue(/neither value worked|matched \*\*no\*\* branch/.test(agents),
      '应保留"fast/deep 曾是完全无效的参数"这一历史纠错记录');
    // 且纠错记录里必须写清三个模式的实测层数。
    // 不断言具体文案(写成 "12 layers" 还是 "→ 12" 会变)，只断言这三个数
    // 都以层数的形态出现过 —— 否则"记录了错误却不给正确数字"等于没记。
    for (const n of [11, 12, 13]) {
      const re = new RegExp(`(→\\s*${n}\\b|${n}\\s*layers|${n}\\s*层)`);
      assertTrue(re.test(agents), `纠错记录应写明实测层数 ${n}`);
    }
  });
};
