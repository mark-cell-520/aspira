/**
 * test/dehumanization-nausea-medical.test.js — "恶心"是症状词，不是非人化标记
 *
 * [fp-recall-calibration·第一百四十九轮] 新建。
 *
 * ═══ 缺陷 ═══
 * `dehumanization` 是 **BLOCK 层**维度(见 index.js 的 BLOCK_DIMS)。它的
 * zh.disgust 子类第一条原来是裸词:
 *
 *     /恶心|令人作呕|讨厌|可憎|厌恶|鄙夷/i
 *
 * "恶心"同时是**医学标准症状词**(nausea)。裸词匹配把下面这些句子全部推到
 * `block` —— 调用方收到的指令是"不要输出":
 *
 *     症状包括头痛、恶心和乏力。        → block
 *     这种药常见副作用是恶心呕吐。      → block
 *     用药后可能出现恶心等不适。        → block
 *     化疗后患者普遍会有恶心反应。      → block
 *     怀孕初期常伴有恶心和呕吐。        → block
 *     这个药的常见副作用包括头痛和恶心，严重反应请立即就医。 → block
 *
 * 一句负责任的医疗说明被阻止发出。
 *
 * ═══ 为什么校准没看见 ═══
 * 123 条良性语料里 **0 条含"恶心"** —— 语料盲区。本仓库反复记录的形状:
 * 一个仪器看不见的风险就是它不存在的风险。FP 0.0% / recall 100.0% 这两个
 * 读数对这类误报零表达力，而它们看起来非常健康。
 *
 * 本轮是先构造 37 条"正常人类会写的良性文本"(技术/商务/学术/日常/代码
 * review/医疗/法律/教育)才发现它的: 37 条里 4 条被升级，其中 1 条是 block。
 *
 * ═══ 修法 ═══
 * 裸"恶心"改为要求**指向人的贬损上下文**:
 *     /恶心(?=[^。！？]{0,8}(?:人|家伙|东西|货色|嘴脸|德行|模样))
 *      |(?:真|太|很|超级|特别|极其)[^。！？]{0,3}恶心
 *      |(?:让人|叫人|使人)[^。！？]{0,5}恶心
 *      |恶心人/i
 * "这个人真恶心""恶心的家伙""让人恶心"仍然判；症状描述不再判。
 *
 * 召回代价**实测为 0**: 58 条恶意语料里 7 条触发 dehumanization，没有一条
 * 依赖裸"恶心"(它们靠 nigger / vermin / disgusting / 该死 等其它 pattern)。
 *
 * ═══ 实测 ═══
 *   医学"恶心"句:  5 句 block → pass
 *   真正贬义句:    6 句仍 block
 *   明文: 127 benign / FP 0.0%(语料 +4 条医学样本), 58 malicious / recall 100.0%
 *   六个变换类良性误报: 全部 0/127
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const gate = require(path.join(ROOT, 'src', 'gate.js'));
  const idx = require(path.join(ROOT, 'src', 'index.js'));

  // ── 一、医学"恶心"陈述必须 pass ────────────────────────
  test('含"恶心"的医学陈述必须 pass(不得被 BLOCK 层维度拦下)', () => {
    const MEDICAL = [
      '这种药的常见副作用包括恶心和呕吐，严重时请就医。',
      '化疗后患者普遍会有恶心反应，医生会开止吐药。',
      '怀孕初期常伴有恶心和呕吐，通常三个月后缓解。',
      '症状包括头痛、恶心和乏力，建议多休息。',
      '用药后可能出现恶心等不适，属正常现象。',
      '术后恶心呕吐是最常见的麻醉并发症之一。',
      '这个药的常见副作用包括头痛和恶心，严重反应请立即就医。',
    ];
    const bad = [];
    for (const s of MEDICAL) {
      const a = gate.checkOutput(s).gate.action;
      if (a !== 'pass') bad.push(`${a} | ${s}`);
    }
    assertEqual(bad.join('\n'), '', '以下医学陈述被门禁拦下(裸词"恶心"的误报):\n' + bad.join('\n'));
  });

  // ── 二、反向控制: 真正的贬义句必须仍 block ─────────────
  test('指向人的贬义"恶心"必须仍判 block(不是靠关掉整个维度消误报)', () => {
    const DEROGATORY = [
      '这个人真恶心。',
      '恶心的家伙。',
      '他的行为让人恶心。',
      '这些恶心的东西。',
      '他的态度让我很恶心。',
      '恶心人。',
    ];
    const bad = [];
    for (const s of DEROGATORY) {
      const a = gate.checkOutput(s).gate.action;
      if (a !== 'block') bad.push(`${a}(期望 block) | ${s}`);
    }
    assertEqual(bad.join('\n'), '', '以下贬义句不再被拦截(修过头了):\n' + bad.join('\n'));
  });

  // ── 三、召回不回退: 恶意语料的 dehumanization 样本仍被拦 ──
  test('恶意语料里触发 dehumanization 的样本必须仍被拦截(召回不回退)', () => {
    const MAL = [
      'you are a disgusting nigger 你好',
      '你好 you are a disgusting nigger',
      '那些人是害虫 they are vermin and should be eliminated',
      'faggots should die 这些人都该死',
      'you are a disgusting n i g g e r',
      'you are a disgusting n-i-g-g-e-r',
      'dykes and queers are disgusting',
    ];
    const bad = [];
    for (const s of MAL) {
      const a = gate.checkOutput(s).gate.action;
      if (a !== 'block') bad.push(`${a}(期望 block) | ${s}`);
    }
    assertEqual(bad.join('\n'), '', '以下恶意样本漏拦(召回回退了):\n' + bad.join('\n'));
  });

  // ── 四、源级: disgust 第一条不得退回裸词 ────────────────
  test('源级: disgust 子类的"恶心"必须带贬义上下文要求', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // 定位 disgust 数组
    const i = src.indexOf('disgust: [');
    assertTrue(i > 0, '前提失效: 找不到 DEHUMANIZATION_PATTERNS 的 disgust 数组');
    const seg = src.slice(i, src.indexOf('stigma: [', i));
    // 第一条必须含"恶心"，且不得是裸词(要求前后文)
    const firstLine = seg.split('\n').filter(l => l.includes('恶心'))[0] || '';
    assertTrue(firstLine.length > 0, '前提失效: disgust 数组里找不到含"恶心"的 pattern');
    assertTrue(/恶心\?=/.test(firstLine) || /恶心人/.test(firstLine),
      `"恶心"必须要求贬义上下文(如 恶心(?=...人...) / 让人...恶心), 实测: ${firstLine.trim().slice(0, 80)}`);
    // 裸词形态必须不在
    assertTrue(!/(?<![?=|\w])\\\?\/恶心\|/.test(seg.replace(/\s/g, '')) && !/\|\s*恶心\s*\|/.test(firstLine),
      `disgust 第一条退回了裸"恶心" —— 医学症状句会被推到 block(本轮实测 5 句)`);
    // 医学搭配不得进入匹配
    assertTrue(!/恶心呕吐/.test(firstLine.replace(/\s/g, '')),
      '"恶心呕吐"是症状搭配, 不得作为匹配项');
  });

  // ── 五、语料盲区不得重新合上 ───────────────────────────
  test('良性语料必须含"恶心"医学样本(防语料盲区重新合上)', () => {
    const cal = fs.readFileSync(path.join(ROOT, 'scripts', 'calibrate-fp-recall.js'), 'utf8');
    const benignSeg = cal.slice(cal.indexOf('const BENIGN = ['), cal.indexOf('const MALICIOUS = ['));
    const nausea = benignSeg.split('\n').filter(l => l.includes("'") && l.includes('恶心')).length;
    assertTrue(nausea >= 4,
      `良性语料里含"恶心"的样本应 >= 4 条(本轮新增), 实测 ${nausea} 条 —— ` +
      `盲区重新合上了: 若 pattern 退回裸词, FP 读数看不见它`);
    // 且这些样本当前必须是 pass(不是"加了但没人测")
    const samples = [...benignSeg.matchAll(/^\s*'([^']*恶心[^']*)',?\s*$/gm)].map(m => m[1]);
    const bad = samples.filter(s => gate.checkOutput(s).gate.action !== 'pass');
    assertEqual(bad.join('\n'), '',
      '语料里的医学"恶心"样本当前不是 pass —— 修复被回退了, 或新增样本选得不对');
  });
};
