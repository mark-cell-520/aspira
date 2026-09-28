/**
 * test/dimension-finding-integrity.test.js — finding 的次数与条数必须是真的
 *
 * ═══ 本轮(dimension-health-audit 切片)发现的三个缺陷 ═══
 * 造了 scripts/dimension-health-audit.js: 把一个大输入池(校准语料 + 全部测试文件
 * 里的字符串字面量 + 引擎正则剥出的片段)喂给 discriminate()，逐维度统计
 * "信号是否非零" 与 "是否推过 finding"。它当场抓出三个问题。
 *
 * **缺陷一: dimMap 键名与 allDims 的 name 对不上，次数永远是假的。**
 *   allDims 用 `name:'bullshit'`，dimMap 只有 `bullshit_recognition: bs`。
 *   finding 构造处是 `const detail = dimObj?.count || ... || 1`——
 *   dimObj 取到 undefined，于是**静默回退成 1**。
 *   实测 `bullshit` 真实 count=4，finding 却报 `bullshit(1次)`。
 *   `appeal_to_authority` ↔ `appeal_to_authority_boost` 同病。
 *   这正是 AGENTS.md 记录过的 "dimMap 键名不一致" bug，之前只修了一部分。
 *
 * **缺陷二: pseudo_causal / soft_deflection 被推送两次。**
 *   它们既有专属块(`if (uc.count>0...)` / `if (pc.count>0...)` /
 *   `if (sd.count>0...)`)，又在 allDims 里。于是同一个问题在 findings 里
 *   出现**两条**——实测伪因果样本 `pseudo_causal sev=60` 出现 2 次。
 *   这与上一轮修的"跨度双算"是同一类: 虚增 findings.length，
 *   而它正好是 gate 的 verify 触发条件之一(`findings.length > 1`)。
 *
 * **缺陷三: clickbait 从不推送 finding。**
 *   dimMap 有 `clickbait: cb`、dimensions{} 有该键，但 allDims 从未包含它——
 *   一个完整实现却对门禁零贡献的维度。
 *
 * ═══ 修法为什么是"补别名"而不是"改名" ═══
 * 命名有**三处**且互不一致: dimMap 键 / allDims name / 门禁集(BLOCK、
 * REWRITE、VERIFY_DIMS)。改名任何一处都会错环——例如把 allDims 的
 * 'bullshit' 改成 'bullshit_recognition'，REWRITE_DIMS 里仍是 'bullshit'，
 * rewrite 触发立刻失效。故只在 dimMap 补别名，让 dimObj 能解析，
 * 其余一律不动。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const gate = require(path.join(ROOT, 'src', 'gate.js'));

  const findingsOf = (t, dim) =>
    (gate.checkOutput(t).findings || []).filter(f => f.dimension === dim);

  test('bullshit 的次数必须是真实计数，不得静默回退成 1', () => {
    const t = 'We need to synergize our core competencies and think outside the box to leverage our paradigm.';
    const f = findingsOf(t, 'bullshit');
    assertTrue(f.length === 1, 'bullshit 应推一条 finding');
    // 修复前: bullshit(1次) —— dimMap['bullshit'] 为 undefined，detail 回退成 1
    // 真实 count 是 4
    assertTrue(/\(4次\)/.test(f[0].details),
      `bullshit 的次数应是真实 count(4)，实测: ${f[0].details}`);
  });

  test('appeal_to_authority 的次数同样不得回退成 1', () => {
    const t = '李教授说过这样做是对的，你就听他的。';
    const f = findingsOf(t, 'appeal_to_authority');
    assertTrue(f.length === 1, 'appeal_to_authority 应推一条 finding');
    const idx = require(path.join(ROOT, 'src', 'index.js'));
    const real = idx.checkAppealToAuthority(t);
    assertTrue(real.count > 0, '该句应命中 appeal_to_authority');
    assertTrue(new RegExp(`\\(${real.count}次\\)`).test(f[0].details),
      `次数应与真实 count(${real.count})一致，实测: ${f[0].details}`);
  });

  test('pseudo_causal 不得被推送两条(专属块 + allDims 双算)', () => {
    // 修复前: findings 里 pseudo_causal 出现 2 次、同为 sev=60
    const t = '根据研究，这种药物可能将效果提升 3.2 倍，而且故意弄虚作假。';
    const f = findingsOf(t, 'pseudo_causal');
    assertEqual(f.length, 1, `pseudo_causal 只应推送一条，实测 ${f.length} 条`);
    // 且详情应来自专属块(带"处"与命中文本)，不是 allDims 的"N次"格式
    assertTrue(/处/.test(f[0].details),
      `pseudo_causal 的详情应来自专属块，实测: ${f[0].details}`);
  });

  test('soft_deflection 同样不得双算', () => {
    const t = '也许你是对的，但我也不确定，可能大概也许是这样吧。';
    const f = findingsOf(t, 'soft_deflection');
    assertTrue(f.length <= 1, `soft_deflection 不得推送多条，实测 ${f.length} 条`);
  });

  test('clickbait 必须能推送 finding(此前对门禁零贡献)', () => {
    const t = '你害怕吗？这个秘密让所有人都震惊了！快看！';
    const f = findingsOf(t, 'clickbait');
    assertTrue(f.length >= 1,
      `clickbait 应能推送 finding(修复前 allDims 不含它，永远推不出)，实测 ${f.length} 条`);
  });

  test('dimMap 不得再有为解析不到的键(dimObj 回退成假计数)', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
    // allDims 里每个 name 都必须能在 dimMap 里解析(含别名)
    const allTxt = src.slice(src.indexOf('const allDims'), src.indexOf('const dimMap'));
    const names = [...allTxt.matchAll(/name: *'([a-z_]+)'/g)].map(m => m[1]);
    const dmTxt = src.slice(src.indexOf('const dimMap'), src.indexOf('const findings = []'));
    const keys = new Set([...dmTxt.matchAll(/([a-z_]+):/g)].map(m => m[1]));
    const unresolved = names.filter(n => !keys.has(n));
    assertEqual(unresolved.join(', '), '',
      `这些 allDims name 在 dimMap 里解析不到，次数会静默变成 1: ${unresolved.join(', ')}`);
  });

  test('维度健康仪器本身必须能跑通(不得静默失效)', () => {
    const { execSync } = require('child_process');
    let out = '';
    try {
      out = execSync(`node ${JSON.stringify(path.join(ROOT, 'scripts', 'dimension-health-audit.js'))}`, {
        cwd: ROOT, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) { out = (e.stdout || '').toString(); }
    // 仪器必须报出它测了多少条输入，且输入池不能为空
    assertTrue(/输入池: 语料 \d+ \| 测试字面量 \d+ \| 正则片段 \d+ \| 去重后 \d+/.test(out),
      '仪器应报出输入池规模');
    assertTrue(/去重后 [1-9]\d*/.test(out), '去重后的输入池不得为空');
    // 54 个维度都必须出现在逐维度表里
    for (const d of ['evidence', 'unsupported_claim', 'prompt_injection', 'bullshit_recognition',
                     'appeal_to_authority_boost', 'clickbait', 'perfect_error', 'premature_termination']) {
      assertTrue(new RegExp(`\\b${d}\\b`).test(out), `仪器应覆盖维度 ${d}`);
    }
  });

  test('维度健康仪器不得报出"触发过但从不推 finding"的非设计维度', () => {
    const { execSync } = require('child_process');
    let out = '';
    try {
      out = execSync(`node ${JSON.stringify(path.join(ROOT, 'scripts', 'dimension-health-audit.js'))}`, {
        cwd: ROOT, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) { out = (e.stdout || '').toString(); }
    // 非设计内(排除 evidence 仅打分 / perfect_error 聚合直设 action)的维度
    // 一旦"有信号却从不推 finding"，说明它够不到阈值，等于对门禁零贡献
    const bad = (out.match(/⚠ 触发但从不推 finding/g) || []).length;
    const onlyByDesign = /曾触发但不推 finding: 2 → evidence, perfect_error/.test(out);
    assertTrue(bad === 0 || onlyByDesign,
      `不应有非设计内的"只触发不推送"维度，实测 ${bad} 处告警`);
  });
};
