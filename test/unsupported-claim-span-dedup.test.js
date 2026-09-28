/**
 * test/unsupported-claim-span-dedup.test.js — 同一段文字不得被算成多处
 *
 * ═══ 本轮(fp-recall-calibration 切片)的发现 ═══
 * 造一批"语料表达不了的真实良性文本"去找误报时，撞见一个**仪器缺陷**:
 *
 *   "根据 2024 年的一份行业报告，部署时间中位数约为 12 分钟。"
 *     → 无依据断言(2处: 根据 2024 年的一份行业报告; 2024 年的一份行业报告)
 *
 * 第二条是第一条的**子串**。UNSUPPORTED_CLAIM_ZH 的两个模式——
 * "根据…报告" 与 "2024年…报告"——匹配了同一段文字，而原实现
 * 每个模式 match 到就 push 一条，从不检查跨度是否重叠。
 *
 * 后果不是"多打一行日志": `count` 直接翻倍，而
 * `severity = Math.round(score * 100)`、`score = Math.min(1, count * 0.45)`，
 * 于是严重度从 **45 翻到 90**——恰好跨过 gate 的多条阈值。
 * 语料 143 条里 0 条能表达这个形状，所以校准脚本读不出来。
 *
 * ═══ 修法 ═══
 * `_dedupeOverlappingSpans()`: 收集匹配的 (start, end)，按长度降序，
 * 一个跨度若被已保留的更长跨度**包含**则丢弃，最后按原文顺序返回。
 * checkPseudoCausal 与 checkUnsupportedClaim 两处同构，都接上。
 *
 * ═══ 为什么这不只是"日志美化" ═══
 * 计数是 severity 的原料，severity 是门禁动作的原料。
 * 同一处被算两次，等于让"模式写重了"这件事悄悄改变对用户的判决。
 * 这是仪器的诚实性问题，不是误报率问题。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const gate = require(path.join(ROOT, 'src', 'gate.js'));

  const findingsOf = (t, dim) =>
    (gate.checkOutput(t).findings || []).filter(f => f.dimension === dim);

  test('同一段文字被多个模式命中时只算一处', () => {
    // 修复前: 无依据断言(2处: 根据 2024 年的一份行业报告; 2024 年的一份行业报告)
    const t = '根据 2024 年的一份行业报告，部署时间中位数约为 12 分钟。';
    const f = findingsOf(t, 'unsupported_claim');
    assertTrue(f.length > 0, '该句应命中 unsupported_claim');
    const detail = f.map(x => x.details).join(' | ');
    assertTrue(!/\(2处/.test(detail),
      `不得把同一段文字算成 2 处(第二条应是第一条的子串)，实测: ${detail}`);
    // 严重度因此必须是 1 处的值(45)，不是 2 处的 90
    assertEqual(f[0].severity, 45,
      `1 处命中的严重度应为 45，实测 ${f[0].severity}(修复前是 90)`);
  });

  test('去重后计数下降，但维度仍然命中(不是把问题抹掉)', () => {
    // 去重的目的是"别重复计"，不是"别计"。
    const t = '根据 2024 年的一份行业报告，部署时间中位数约为 12 分钟。';
    const r = gate.checkOutput(t);
    assertEqual(r.gate.action, 'verify', '该句仍应到 verify');
    assertTrue(findingsOf(t, 'unsupported_claim').length > 0, '维度仍须命中');
  });

  test('真正不重叠的多处仍要分别计数(去重不得过头)', () => {
    // 两处**不重叠**的命中，必须算 2 处——否则去重就成了掩盖问题。
    // 注: 不能用 "研究表明…调查显示…"——它们属于**同一个模式**的交替项，
    // 而 text.match(非全局正则) 每个模式只返回第一个命中，故本来只算 1 处。
    // 首版我就是这样写的，结果把"既有限制"当成"去重过头"来测，断言报错。
    // 改用两个**不同模式**在不重叠位置命中，才能验证去重不过头。
    const t = '根据 2024 年的一份行业报告，成本下降了 30%，而研究表明留存提升了 2 倍。';
    const f = findingsOf(t, 'unsupported_claim');
    assertTrue(f.length > 0, '该句应命中 unsupported_claim');
    const detail = f.map(x => x.details).join(' | ');
    assertTrue(/根据 2024 年的一份行业报告/.test(detail) && /研究表明/.test(detail),
      `两处不重叠的命中都应保留，实测: ${detail}`);
    // 2 处不重叠 → 严重度应是 2 处的值(90)，证明去重没有把它们误并
    assertEqual(f[0].severity, 90,
      `2 处不重叠命中的严重度应为 90，实测 ${f[0].severity}`);
  });

  test('checkPseudoCausal 同样带去重(两处同构，防只修一半)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
    // 1 处定义 + 2 处调用 = 至少 3 次出现
    const calls = (src.match(/_dedupeOverlappingSpans\(/g) || []).length;
    assertTrue(calls >= 3,
      `应有 1 处定义 + 2 处调用(共 ≥3 次出现)，实测 ${calls} 次`);
  });

  test('源码里不得回到"每个模式 match 到就 push"的无去重写法', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
    assertTrue(!/for \(const \[idx, pat\] of patterns\.entries\(\)\) \{\s*const m = text\.match\(pat\);\s*if \(m\) \{\s*claims\.push/.test(src),
      'checkUnsupportedClaim 不得回到"无跨度去重"的写法');
  });
};
