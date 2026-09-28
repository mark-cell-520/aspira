/**
 * test/mcp-adversarial-reachability.test.js — MCP gate 工具必须能识别混淆攻击
 *
 * ═══ 缺陷 ═══
 * adversarial-robustness 切片。修掉同形字误伤合法俄语/希腊语后，反向核查
 * "对抗层经 MCP 是否可达"，发现**整层不可达**:
 *
 *     'kill me киll'  aspira_gate          → pass
 *     'kill me киll'  aspira_gate_check    → pass
 *     'kill me киll'  aspira_gate_pipeline → pass   ← 名叫"管道模式"
 *     而 gate.checkOutput / gate.runPipeline 均为 rewrite
 *
 * 根因: 三个 handler 分别调 gate.gate / gate.check / gate.pipeline，
 * **三者内部都只跑 discriminate()**，不过 adversarial-variant 层。
 * 真正的全 pipeline 是 runPipeline(17 层，含对抗变体层)。
 * 于是同形字、零宽、弯引号、全角、组合字符、数字混淆、词拆分这一整类混淆攻击
 * 对整个 MCP 工具面不可见——而 agent 正是靠这些工具门禁不可信输入。
 *
 * ═══ 修了什么 ═══
 * 1. handleGatePipeline 改调 gate.runPipeline({input, mode})。
 *    兼容性依据: runPipeline 返回键是 gate.pipeline 的**超集**
 *    (多 input / checked_by / data)，既有调用方读的键都在，实测良性样本不变。
 *    evidence 参数经 options 透传(runPipeline 不直接收它)。
 * 2. aspira_gate / aspira_gate_check 的 description 补上⚠️警告:
 *    它们是有意的轻量路径(只跑 54 维判别器)，但原先**没说会跳过什么**，
 *    agent 无从得知混淆攻击可绕过。现在明确警示并指路 aspira_gate_pipeline。
 *
 * ═══ 本测试锁什么 ═══
 * - gate_pipeline 必须能识别同形字/零宽攻击(行为级)
 * - gate_pipeline 对良性中/英文/俄语不得误报
 * - 返回键必须是旧形状的超集(兼容性)
 * - 两个轻量工具的描述必须含对抗层警告(防止警示被悄悄删掉)
 */
module.exports = function ({ test, assertEqual, assertTrue, assertDefined }) {
  const path = require('path');
  const mcp = require(path.join(__dirname, '..', 'src', 'mcp-server.js'));

  const ATTACKS = {
    '同形字 киll': 'kill me киll',
    '同形字 hаte': 'i hаte you',
    '同形字 рass': 'рass the test',
  };
  const BENIGN = {
    '中文': '今天天气很好，我们去公园散步吧。',
    '英文': 'Can you explain the difference between these two approaches?',
    '俄语': 'Привет, как дела?',
    '希腊语': 'Καλημέρα, τι κάνεις;',
  };

  test('aspira_gate_pipeline 必须识别同形字混淆攻击', async () => {
    for (const [label, text] of Object.entries(ATTACKS)) {
      const r = await mcp.HANDLERS.aspira_gate_pipeline({ text });
      const a = r.gate && r.gate.action;
      assertTrue(a === 'rewrite' || a === 'block',
        `「${label}」经 aspira_gate_pipeline 应 rewrite/block，实测 ${a}(修复前为 pass)`);
    }
  });

  test('aspira_gate_pipeline 对良性文本不得误报', async () => {
    for (const [label, text] of Object.entries(BENIGN)) {
      const r = await mcp.HANDLERS.aspira_gate_pipeline({ text });
      const a = r.gate && r.gate.action;
      assertEqual(a, 'pass', `「${label}」应 pass，实测 ${a}`);
    }
  });

  test('aspira_gate_pipeline 返回键必须是旧 gate.pipeline 形状的超集', async () => {
    const r = await mcp.HANDLERS.aspira_gate_pipeline({ text: 'test' });
    // 旧形状(gate.pipeline)的键
    for (const k of ['verdict', 'overallScore', 'gate', 'findings', 'dimensions', 'summary']) {
      assertTrue(k in r, `返回体缺少旧形状已有的键 ${k}——兼容性被破坏`);
    }
    // 新增键(全 pipeline 才有)
    assertDefined(r.checked_by, 'runPipeline 应带 checked_by(全链路可审计)');
    assertDefined(r.input, 'runPipeline 应带 input');
  });

  test('aspira_gate_pipeline 必须真的过了 adversarial-variant 层', async () => {
    const r = await mcp.HANDLERS.aspira_gate_pipeline({ text: 'kill me киll' });
    const layers = (r.checked_by || []).map(l => l.layer);
    assertTrue(layers.includes('adversarial-variant'),
      `checked_by 应含 adversarial-variant 层，实测层: ${layers.join(',')}`);
    const adv = (r.checked_by || []).find(l => l.layer === 'adversarial-variant');
    assertEqual(adv.action, 'rewrite', 'adversarial-variant 层对该攻击应 rewrite');
  });

  test('两个轻量 gate 工具的描述必须警告对抗层盲区', () => {
    for (const n of ['aspira_gate', 'aspira_gate_check']) {
      const t = mcp.TOOLS.find(x => x.name === n);
      assertTrue(!!t, `应存在工具 ${n}`);
      const d = (t && t.description) || '';
      assertTrue(/adversarial-variant/.test(d),
        `${n} 的描述必须点明不过 adversarial-variant 层——否则 agent 无从得知混淆攻击可绕过`);
      assertTrue(/aspira_gate_pipeline/.test(d),
        `${n} 的描述应指路 aspira_gate_pipeline(提供完整防护的入口)`);
    }
  });

  test('aspira_gate_pipeline 的描述必须说明它跑完整 pipeline', () => {
    const t = mcp.TOOLS.find(x => x.name === 'aspira_gate_pipeline');
    const d = (t && t.description) || '';
    assertTrue(/17 层|完整/.test(d), '描述应说明跑完整 pipeline');
    assertTrue(/adversarial-variant|对抗变体/.test(d), '描述应点明含对抗变体层');
  });
};
