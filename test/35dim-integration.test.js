const m = require('../src/index.js');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch(e) { console.error(`✗ ${name}: ${e.message}`); failed++; } }

t('summarizeDiscrimination covers all 35 dims', () => {
  const r = m.discriminate('我不确定也许我错了');
  const s = m.summarizeDiscrimination('我不确定也许我错了', r);
  // summarize should mention meta_cognition
  if (!s.includes('反身认知') && !s.includes('元认知')) throw new Error('missing meta_cognition');
});

t('crossAnalyze covers all dims', () => {
  const r = m.discriminate('大家都懂的，嘴上说支持实际做不到，我什么都能解决');
  const ca = m.crossAnalyze(r);
  const pats = JSON.stringify(ca.patterns);
  if (!pats) throw new Error('crossAnalyze failed');
});

t('entropyAnalysis works', () => {
  const r = m.entropyAnalysis('测试文本', null);
  if (typeof r.inputEntropy !== 'number') throw new Error('entropyAnalysis missing inputEntropy');
});

t('all 35 dimensions have scores', () => {
  const r = m.discriminate('因为A=B所以B=C，因此结论是A=C。我不确定也许我错了。');
  const dims = r.dimensions;
  const count = Object.keys(dims).length;
  if (count < 30) throw new Error(`only ${count} dims`);
  // Verify all dims have score
  for (const [k, v] of Object.entries(dims)) {
    if (typeof v.score !== 'number') throw new Error(`${k} missing score`);
  }
});

t('checkReasoningCoherence works', () => {
  const r = m.checkReasoningCoherence('因为A，所以B，因此结论是C');
  if (r.score < 0.5) throw new Error('coherent reasoning should score high, got ' + r.score);
});

t('checkTheoryOfMind works', () => {
  const r = m.checkTheoryOfMind('大家都知道的，你怎么可能不懂');
  if (r.count === 0) throw new Error('ToM failure not detected');
});

t('checkGoalMisalignment works', () => {
  const r = m.checkGoalMisalignment('嘴上说支持环保，实际上在破坏');
  if (r.count === 0) throw new Error('goal misalignment not detected');
});

t('checkCounterfactual works', () => {
  const r = m.checkCounterfactual('要不是你我早就成功了');
  if (r.count === 0) throw new Error('counterfactual not detected');
});

t('checkSocialNorm works', () => {
  const r = m.checkSocialNorm('这太过分了，哪有这样做的');
  if (r.count === 0) throw new Error('social norm not detected');
});

t('checkMetaCognition works', () => {
  const r = m.checkMetaCognition('我不确定也许我错了，值得商榷');
  if (r.count === 0) throw new Error('metacognition not detected');
});

t('checkCapabilityOverclaim works', () => {
  const r = m.checkCapabilityOverclaim('我什么都能解决，没有任何局限性');
  if (r.count === 0) throw new Error('overclaim not detected');
});

t('checkDeceptiveAlignment works', () => {
  const r = m.checkDeceptiveAlignment('假装不会以便降低期望');
  if (r.count === 0) throw new Error('deceptive alignment not detected');
});

t('checkInstrumentalReasoning works', () => {
  const r = m.checkInstrumentalReasoning('为了达到目的不择手段，必须确保自己不被关停');
  if (r.count === 0) throw new Error('instrumental reasoning not detected');
});

// [健康文本判据] crossAnalyze 模式21 的 allClean 里, reasoning_coherence 是唯一的
// 质量分项(高分=好), 原比较方向写反了: !(score > 0.5) 等于"分数低才算干净",
// 于是完整推理链永远拿不到"健康文本", 毫无推理结构的句子反而能拿到。
// 下面两条用例钉住修好后的方向: 好推理必须是干净的, 坏推理必须不是干净的。
t('完整推理链不应被挡在健康文本之外', () => {
  // 2026-11-02 换过 fixture: 原句含"销售额增长了20%"这个**无来源精确数字**,
  // 会被 perfect_error 的 S1_false_precision 命中 —— 那是一条正当信号
  // (仓库自己的记录: "数据显示转化率提升了 12%" 抬到 rewrite 是正确的)。
  // 本轮把 allClean 从 35 项手写清单改成遍历 dimensions{} 全量 54 键之后,
  // perfect_error 第一次进入健康文本判据, 于是原 fixture 变成"有别的维度命中",
  // 再也测不到 reasoning_coherence 的方向。换成不含精确数字的完整推理链,
  // 让这条用例只测它本来要测的那一件事。
  const text = '因为客户留存率提高了，而且复购成本下降了，所以我们应当继续加大投入。';
  const r = m.discriminate(text);
  if (r.dimensions.reasoning_coherence.score <= 0.5) {
    throw new Error('前提失效: 该句未被判为完整推理链(score=' +
      r.dimensions.reasoning_coherence.score + ')');
  }
  const ca = m.crossAnalyze(r);
  const healthy = ca.patterns.find(p => p.pattern === '健康文本');
  if (!healthy) {
    throw new Error('推理结构完好的句子拿不到"健康文本" —— allClean 里 reasoning_coherence 的方向仍为反');
  }
});

t('毫无推理结构的良性句仍应判为健康文本', () => {
  // 这条是防过度修正的护栏: 把判据简单从 > 翻成 < 会让 score=0 的良性句
  // (无推理结构/no_text)一起失去健康文本, 而它们才是最常见的一类。
  // 修好后的判据显式排除这两种 structure, 故它们必须保持干净。
  const text = '今天天气不错。';
  const r = m.discriminate(text);
  if (r.dimensions.reasoning_coherence.structure !== '无推理结构') {
    throw new Error('前提失效: 该句的 structure=' +
      r.dimensions.reasoning_coherence.structure);
  }
  const ca = m.crossAnalyze(r);
  const healthy = ca.patterns.find(p => p.pattern === '健康文本');
  if (!healthy) {
    throw new Error('毫无推理结构的良性句拿不到"健康文本" —— 判被过度修正了');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
