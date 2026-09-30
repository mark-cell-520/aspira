/**
 * test/blind-spot-breaker.test.js — 盲区破除器的实测契约
 *
 * 这个模块(876 行, 四层: 解构→置信度→重构→养育反思)在此前**没有任何测试**
 * ——实测 src 下 383 个模块里有 103 个从未被任何测试引用模块名, 它是最大的
 * 那几个之一, 且已被 src/core/heartflow.js 与 plugins/blind-spot-breaker 接线。
 * 本文件补齐它。
 *
 * ⚠️ 写断言前全部先实测。首版曾想把"养育反思应当触发"写进去, 实测
 * isParentingProblem 恒为 false——那是 _isParentingProblem 里"至少 3 个关键词
 * 才触发"的安全护栏在起作用(避免无 consent 的心理学推断), 不是 bug。
 * 故本文件钉住**当前事实**, 不钉住期待。
 */
'use strict';

module.exports = function ({ test, assertEqual, assertTrue, assertFalse, assertDefined, assertThrows }) {
  const BlindSpotBreaker = require('../src/cortex/blind-spot-breaker.js');

  const CONTRACT_KEYS = [
    'version', 'originalProblem', 'deconstruction', 'confidence',
    'reframing', 'parentingReflection', 'suggestion', 'transparencyReport',
  ];

  const b = new BlindSpotBreaker();

  // ── 1. 结构契约 ──────────────────────────────────────────────
  test('process() 返回结构必须是稳定的八个键', () => {
    const r = b.process('我看到他在周三下午三点把文件带走了');
    const keys = Object.keys(r);
    for (const k of CONTRACT_KEYS) {
      assertTrue(keys.includes(k), `缺少键 ${k}`);
    }
    assertEqual(keys.length, 8, `应恰有 8 个键, 实测 ${keys.length} 个: ${keys.join(',')}`);
    assertDefined(r.version, 'version 应有值');
    assertEqual(typeof r.transparencyReport, 'object', 'transparencyReport 应为对象');
  });

  test('空串/纯空白/超长输入都不得抛异常, 且结构不变', () => {
    for (const p of ['', '   ', '\n\t', 'a'.repeat(20000), '😀'.repeat(500)]) {
      let r = null;
      try { r = b.process(p); } catch (e) {
        throw new Error(`输入 ${JSON.stringify(p.slice(0, 12))} 抛出异常: ${e.message}`);
      }
      const keys = Object.keys(r);
      assertEqual(keys.length, 8,
        `输入 ${JSON.stringify(p.slice(0, 12))} 的键数应仍为 8, 实测 ${keys.length}`);
    }
  });

  // ── 2. 证据分级 → 置信度(本模块的核心业务) ───────────────────
  // 四级证据的定义在构造器里: L1 直接观察 1.0 / L2 他人告知 0.7 /
  // L3 推断 0.5 / L4 假设 0.3。下面用四个**未自造**的输入各测一次实值。
  test('证据分级必须单调: L1 > L2 > L3 > L4', () => {
    const w = b.evidenceLevels;
    const order = ['L1_OBSERVATION', 'L2_REPORTED', 'L3_INFERENCE', 'L4_ASSUMPTION'];
    let prev = Infinity;
    for (const k of order) {
      assertDefined(w[k], `${k} 应被定义`);
      assertTrue(w[k].weight < prev,
        `权重应递减: ${k}=${w[k].weight} 但上一级是 ${prev}`);
      prev = w[k].weight;
    }
  });

  test('同一句文本按措辞被判到不同证据级, 并给出对应置信度', () => {
    const seen = {};
    const probe = (label, text) => {
      const d = b.process(text).deconstruction;
      const first = d.facts[0] || d.interpretations[0] || d.assumptions[0];
      seen[label] = first.evidenceLevel;
      assertDefined(first.evidenceLevel, `${label} 应给出 evidenceLevel`);
    };
    probe('L1', '我看到他在周三下午三点把文件带走了');
    probe('L2', '他说数据显示可能大概应该没问题');
    probe('L3', '雨是蓝色的');
    assertEqual(seen.L1, 'L1_OBSERVATION', `第一人称直接观察应为 L1, 实测 ${seen.L1}`);
    assertEqual(seen.L2, 'L2_REPORTED', `转述+模糊词应为 L2, 实测 ${seen.L2}`);
    assertEqual(seen.L3, 'L3_INFERENCE', `裸陈述应为 L3, 实测 ${seen.L3}`);
  });

  test('置信度数值必须与证据级一致(实测快照)', () => {
    // 这三条是实测值, 不是推算值: L1 → 1.0 / L2 → 0.7 / L3 → 0.5
    const pairs = [
      ['我看到他在周三下午三点把文件带走了', 1.0, 'ALTA'],
      ['他说数据显示可能大概应该没问题', 0.7, 'MEDIA'],
      ['雨是蓝色的', 0.5, 'BAIXA'],
    ];
    for (const [text, conf, band] of pairs) {
      const c = b.process(text).confidence;
      assertEqual(c.overallConfidence, conf,
        `"${text.slice(0, 14)}…" 的 overallConfidence 应为 ${conf}, 实测 ${c.overallConfidence}`);
      assertEqual(c.confidenceBand.key, band,
        `"${text.slice(0, 14)}…" 的置信带应为 ${band}, 实测 ${c.confidenceBand.key}`);
    }
  });

  test('置信度查找在全区间必须与阈值判定一致(真正的不变量)', () => {
    // 首版这里断言"confidenceBands 的 min/max 无间隙划分 [0,1]"——实测**假**:
    // BAIXA 是 0..0.59 而 MEDIA 是 0.6..0.89, 之间留了 0.01 的空隙。
    // 但空隙不改变任何判定: _getConfidenceBand 落不回任何带时兜底返回 BAIXA,
    // 而 _confidenceToLevel 的阈值判定同样把它判成 BAIXA, 二者同向。
    // 故可断言的不变量是**两条路径结论一致**, 而不是"表无缝"。
    for (let i = 0; i <= 200; i++) {
      const c = i / 200;
      const band = b._getConfidenceBand(c);
      const level = b._confidenceToLevel(c);
      assertEqual(band.key, level,
        `置信度 ${c} 时带(${band.key})与级(${level})不一致`);
      assertDefined(band.label, `置信度 ${c} 应给出 label`);
      assertDefined(band.action, `置信度 ${c} 应给出 action`);
    }
    // 端点
    assertEqual(b._getConfidenceBand(0).key, 'BAIXA', '0 应落在最低带');
    assertEqual(b._getConfidenceBand(1).key, 'ALTA', '1 应落在最高带');
  });

  test('置信带必须无空隙覆盖 [0,1](本轮修完后)', () => {
    // [事实变更] 本条原写成"[已知限制] BAIXA 与 MEDIA 之间有 0.01 空隙":
    // 首版 BAIXA=0..0.59 / MEDIA=0.6..0.89, 0.595 落进缝里。
    // 上面那条一致性测试把缝的**后果**量了出来(0.895 时带与级结论相反),
    // 于是把边界对齐阈值(0.6 / 0.9), 缝已合上。本条随之改为断言已合。
    const bands = Object.values(b.confidenceBands);
    const sorted = bands.slice().sort((x, y) => x.min - y.min);
    assertTrue(Math.abs(sorted[0].min - 0) < 1e-9, '最低带应从 0 起');
    assertTrue(Math.abs(sorted[sorted.length - 1].max - 1) < 1e-9, '最高带应到 1 止');
    for (let i = 1; i < sorted.length; i++) {
      assertTrue(sorted[i].min <= sorted[i - 1].max + 1e-9,
        `第 ${i} 号带(min=${sorted[i].min}) 与上一带(max=${sorted[i - 1].max}) 之间有空隙`);
    }
    // 端点重叠处(0.6 / 0.9)必须归**较高**的带, 与 _confidenceToLevel 同向
    assertEqual(b._getConfidenceBand(0.6).key, 'MEDIA', '0.6 应归 MEDIA 而非 BAIXA');
    assertEqual(b._getConfidenceBand(0.9).key, 'ALTA', '0.9 应归 ALTA 而非 MEDIA');
  });

  // ── 3. 解构层的子结构 ────────────────────────────────────────
  test('解构层必须产出四类内容与事前验尸', () => {
    const d = b.process('他说数据显示可能大概应该没问题').deconstruction;
    for (const k of ['facts', 'interpretations', 'assumptions', 'hiddenAssumptions', 'anomalies']) {
      assertTrue(Array.isArray(d[k]), `deconstruction.${k} 应为数组`);
    }
    assertDefined(d.premortem, '应有 premortem(事前验尸)');
    assertTrue(Array.isArray(d.premortem.analysis) && d.premortem.analysis.length > 0,
      'premortem.analysis 应非空');
  });

  test('hiddenAssumptions 只在该出现时出现', () => {
    // 实测: 带"应该"的句子会产出"隐含假设", 带"总是"的会产出"隐含泛化";
    // 干净的 L1 观察句一条都不产出。
    const withAssume = b.process('他说数据显示可能大概应该没问题').deconstruction.hiddenAssumptions;
    assertTrue(withAssume.length > 0, '含"应该"的句子应至少产出一条隐含假设');
    const clean = b.process('我看到他在周三下午三点把文件带走了').deconstruction.hiddenAssumptions;
    assertEqual(clean.length, 0, `干净的 L1 观察句不应有隐含假设, 实测 ${clean.length} 条`);
  });

  // ── 4. 养育反思层的安全护栏 ──────────────────────────────────
  test('养育反思默认不触发(3 关键词护栏), 关闭开关仍返回完整结构', () => {
    const text = '我孩子总是不听话，打不得骂不得，我该怎么办';
    const on = b.process(text).parentingReflection;
    assertFalse(on.isParentingProblem, '该句未达 3 关键词阈值, 不应判定为养育问题');
    assertFalse(on.triggered, '未触发时 triggered 应为 false');
    const prKeys = Object.keys(on);
    for (const k of ['isParentingProblem', 'triggered', 'coreInsight', 'emotionalTriggers',
      'childhoodConnection', 'intergenerationalPattern', 'reflectionQuestions',
      'finalInsight', 'safetyDisclaimer']) {
      assertTrue(prKeys.includes(k), `parentingReflection 应含键 ${k}, 实测键: ${prKeys.join(',')}`);
    }
    // 未触发时这些字段是 null/[], 是有意的占位而非缺失——用 in 判存在,
    // 不判值(首版用 assertDefined(on[k]) 把 null 当成缺失, 是测试自己的错)。
    assertEqual(on.coreInsight, null, '未触发时 coreInsight 应为 null');
    assertTrue(Array.isArray(on.reflectionQuestions) && on.reflectionQuestions.length === 0,
      '未触发时 reflectionQuestions 应为空数组');
    const off = new BlindSpotBreaker({ enableParentingReflection: false });
    const rOff = off.process(text);
    assertEqual(Object.keys(rOff).length, 8, '关闭开关不应改变返回结构');
    assertFalse(rOff.parentingReflection.triggered, '关闭开关时同样不应触发');
  });

  test('协议类只读方法必须返回可序列化对象', () => {
    for (const m of ['getSocraticProtocol', 'getReflectionQuestions', 'getParentingReflectionProtocol']) {
      const v = b[m]();
      assertDefined(v, `${m}() 应有返回值`);
      let s = null;
      try { s = JSON.stringify(v); } catch (e) {
        throw new Error(`${m}() 的返回值不可 JSON 序列化: ${e.message}`);
      }
      assertTrue(typeof s === 'string' && s.length > 2, `${m}() 应产出非空 JSON`);
    }
  });

  // ── 5. 实例隔离 ──────────────────────────────────────────────
  test('两个实例互不污染(layers 不得跨实例泄漏)', () => {
    const a = new BlindSpotBreaker();
    const c = new BlindSpotBreaker();
    a.process('我看到他在周三下午三点把文件带走了');
    const b4 = c.process('雨是蓝色的');
    assertEqual(b4.confidence.overallConfidence, 0.5,
      '第二个实例的置信度应是它自己文本的结果, 实测 ' + b4.confidence.overallConfidence);
    assertEqual(a.process('雨是蓝色的').confidence.overallConfidence, 0.5,
      '第一个实例复用同一个问题也应得到同样结果');
  });
};
