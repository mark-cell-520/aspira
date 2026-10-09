/**
 * test/output-gate-findings-merged.test.js —
 * 一层判了 rewrite, 它的 findings 却写进一个全文无人读取的字段
 *
 * [dimension-health-audit·第一百七十三轮] 新建。
 *
 * ═══ 缺陷: output-gate 的 findings 被丢弃 ═══
 * `src/pipeline.js` 的 Layer 7 调 `screen(input)`(output-gate), 拿到
 * `{gate, findings}`。它把 gate 用于推 currentGate, 把 findings 写进
 * `data.outputIssues` —— 而**全文再无任何代码读这个字段**(实测 grep 整个
 * src/ 与 test/: 只有那一处赋值, 零处读取)。
 *
 * 最终 `buildResult` 的 findings 只取 `data.discriminate.findings`, 于是
 * output-gate 层判出的问题在最终返回里既无 finding 也无 guidance。
 *
 * 实测(修复前) `checkOutput('所有专家都一致认为这是唯一正确的答案。')`:
 *   gate.action = 'rewrite'
 *   gate.reason = '输出含严重问题: overconfidence'
 *   findings    = [{dimension:'none', severity:0, details:'未发现明显问题'}]
 *   verdict     = '可信'
 *   overallScore = 1
 * 四个字段里三个说"没问题"。
 *
 * ═══ 后果不是少一行日志 ═══
 * AGENTS.md 的 gate 表明确写着: rewrite → "Follow findings[].guidance"。
 * 这里 action 是 rewrite 而 findings 里没有任何 guidance 可读, 调用方
 * (按文档指引只读 findings[].guidance 的 agent)拿到的是"未发现明显问题"。
 *
 * 这是 cycle 27 perfect_error 的同族 —— **一个能改变 gate.action 却说不出
 * 原因的维度**; 区别是那次的原因根本没被推成 finding, 这次的原因被推成了
 * finding 却写进了一个从未被读取的字段。两者对调用方完全等价: 都拿不到
 * 可执行的修复指引。
 *
 * ═══ 修法 ═══
 * `buildResult` 把 output-gate 的 findings **并入**而非替换:
 * discriminate 的保持在前(54 维主报告), output-gate 的追加在后, 按 severity
 * 降序。降序与 output-gate 自己 `findings.sort((a,b)=>b.severity-a.severity)`
 * 同口径, 所以 `gate.reason` 提到的维度仍是 findings[0]。
 *
 * ═══ 锁什么 ═══
 * ① 行为: rewrite 的 reason 提到的维度必须在 findings 里且带 guidance;
 * ② 行为: pass 的输入不得被塞进 output-gate findings(不虚构);
 * ③ 行为: discriminate 自己的 findings 不得被挤掉(并入而非替换);
 * ④ 源级: buildResult 必须真的合并 outputIssues(含自证)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const hf = require(path.join(ROOT, 'src', 'gate.js'));

  // ── 一、rewrite 的原因必须在 findings 里且带 guidance ────
  test('output-gate 判 rewrite 时, reason 提到的维度必须出现在 findings 且带 guidance', () => {
    const t = '所有专家都一致认为这是唯一正确的答案。';
    const r = hf.checkOutput(t);
    assertEqual(r.gate.action, 'rewrite', `该句应判 rewrite, 实测 ${r.gate.action}`);
    // reason 形如 "输出含严重问题: overconfidence"
    const m = /输出含严重问题:\s*([a-z_]+)/.exec(r.gate.reason || '');
    assertTrue(!!m, `前提失效: gate.reason 不是"输出含严重问题: X"形态, 实测 ${r.gate.reason}`);
    const dim = m[1];
    const f = (r.findings || []).find(x => x.dimension === dim);
    assertTrue(!!f,
      `gate.reason 说"${dim}"但 findings 里找不到该维度 —— ` +
      '调用方按文档读 findings[].guidance 时拿不到任何可执行指引');
    assertEqual(typeof f.guidance, 'string', `${dim} 的 guidance 应是字符串`);
    assertTrue(f.guidance.trim().length >= 4,
      `${dim} 的 guidance 应有实际内容, 实测 "${f.guidance}"`);
    // severity 应与 reason 的严重性相符(rewrite 级 >= 70)
    assertTrue((f.severity || 0) >= 70,
      `${dim} 的 severity 应 >= 70(rewrite 门限), 实测 ${f.severity}`);
  });

  // ── 二、不虚构: pass 的输入不得有 output-gate findings ───
  test('门禁放行的输入不得被塞进 output-gate findings(不虚构问题)', () => {
    const benign = [
      '今天天气很好，我们去公园散步吧。',
      '请帮我把这份报告翻译成英文。',
      '这个方案需要进一步评估风险和收益。',
    ];
    for (const t of benign) {
      const r = hf.checkOutput(t);
      assertEqual(r.gate.action, 'pass', `良性句 "${t.slice(0, 18)}" 应 pass, 实测 ${r.gate.action}`);
      const ogDims = ['overconfidence', 'knowledge_masquerade', 'self_contradiction', 'uncertainty_gap'];
      const hit = (r.findings || []).filter(f => ogDims.includes(f.dimension));
      assertEqual(hit.length, 0,
        `良性句 "${t.slice(0, 18)}" 不应有 output-gate 维度 finding, 实测 ${JSON.stringify(hit.map(h => h.dimension))}`);
    }
  });

  // ── 三、并入而非替换: discriminate 的 findings 不得被挤掉 ─
  test('并入而非替换: discriminate 自己的 findings 必须保留', () => {
    // 这句同时触发 discriminate 维度和 output-gate(overconfidence)
    const t = '根据2024年哈佛研究，所有专家都一致认为这是唯一正确的答案。';
    const r = hf.checkOutput(t);
    const dims = (r.findings || []).map(f => f.dimension);
    // discriminate 侧的 unsupported_claim 必须在
    assertTrue(dims.includes('unsupported_claim'),
      `discriminate 的 unsupported_claim 必须仍在 findings 里(并入而非替换), 实测 ${JSON.stringify(dims)}`);
    // output-gate 侧的 overconfidence 也必须在
    assertTrue(dims.includes('overconfidence'),
      `output-gate 的 overconfidence 必须被并入, 实测 ${JSON.stringify(dims)}`);
    // findings 必须按 severity 降序(并入后重排的口径)
    const sevs = (r.findings || []).map(f => f.severity || 0);
    const sorted = [...sevs].sort((a, b) => b - a);
    assertEqual(JSON.stringify(sevs), JSON.stringify(sorted),
      `findings 必须按 severity 降序, 实测 ${JSON.stringify(sevs)}`);
  });

  // ── 四、源级: buildResult 必须真的合并 outputIssues ─────
  test('源级: buildResult 必须合并 outputIssues 而非只取 discriminate', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'pipeline.js'), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, m => ' '.repeat(m.length))).join('\n');
    const i = src.indexOf('function buildResult(');
    assertTrue(i > 0, '前提失效: 找不到 buildResult 函数');
    const body = src.slice(i, src.indexOf('\n}', i));
    assertTrue(/outputIssues/.test(body),
      'buildResult 必须读 data.outputIssues —— 不读它, Layer 7 的 findings 就写进了一个无人读取的字段');
    assertTrue(/\[\.\.\.discFindings,\s*\.\.\.outputFindings\]/.test(body),
      '必须是并入形态 [...disc, ...output] 而非替换');
    assertTrue(/sort\(\(a,\s*b\)\s*=>/.test(body),
      '并入后必须按 severity 排序');
    // 自证: 谓词必须分得清"合并"与"只取一个"
    const replaceOnly = "findings: data?.discriminate?.findings || [],";
    assertTrue(/outputIssues/.test(replaceOnly) === false,
      '自证失效: 谓词分不清合并与只取 discriminate, 本条是恒真锁');
  });
};
