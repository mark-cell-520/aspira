/**
 * test/pattern-fp-regression.test.js — 裸词独立选项 / 误分类模式的误报回归
 *
 * 背景: 把校准语料从 38 条扩到 75 条(补入真实中英混插文本)后，立刻测出两个
 * 此前从未被测出的误报。两者的共同根因都是**模式写法问题**，且同属本仓库
 * 反复出现的缺陷类别。
 *
 * 误报一 — alternation-precedence 陷阱(裸词独立选项):
 *   DEHUMANIZATION_PATTERNS 的 object 类原写作
 *     /分母|流量|人头|把人?当(?:KPI|业绩|指标)|当(?:KPI|指标)[^。]*?(?:人|…)/i
 *   `分母|流量|人头` 是**裸词独立 alternative**，会单独命中。于是:
 *     '我们需要做 load balancing 来分散流量压力。' → gate=block
 *     '数学里的分母很重要'                          → gate=block
 *     '按人头收费更合理'                            → gate=block
 *   这三个都是完全良性的技术/数学/商业用语。
 *
 * 误报二 — 模式被错误归类:
 *   VAGUE_PATTERNS.en 的「程度模糊」组末尾有 /\brather than\b(?!\snot)/i。
 *   但 "rather than" 是**对比性话语标记**——"focus on X rather than Y" 恰恰是
 *   精确表达(说清了做什么与不做什么)，不是程度模糊词。附带证据: 那个 (?!\snot)
 *   排除说明当初已遇到误报，却只打了窄补丁而未删掉模式本身。
 *   另: /\brather\b/ 还命中了 "rather than" 里的 rather，已加 (?!\s+than\b)。
 *
 * 本测试锁的是不变量，不信任代码"看起来对"。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const idx = require('../src/index.js');

  function gate(text) {
    const r = idx.discriminate(text, []);
    return (r.gate && r.gate.action) || 'pass';
  }
  function dimCount(text, dim) {
    const d = idx.discriminate(text, []).dimensions || {};
    const v = d[dim];
    if (!v) return 0;
    return typeof v === 'object' ? (v.count ?? v.totalHits ?? 0) : v;
  }

  // ── 误报一: 裸词不得单独成项 ────────────────────────
  test('流量/分母/人头 的日常用法不得判为非人化物化', () => {
    const benign = [
      '我们需要做 load balancing 来分散流量压力。',
      '流量增长了百分之三十，主要是来自搜索引擎。',
      '这个页面的 UV 和流量都不错。',
      '请按人头统计参加年会的人数。',
      '这个公式的分母是参与实验的总人数。',
      '分母不能为零。',
    ];
    for (const t of benign) {
      assertEqual(dimCount(t, 'dehumanization'), 0,
        `"${t}" 被误判 dehumanization —— 裸词独立选项又回来了`);
      assertTrue(gate(t) === 'pass' || gate(t) === 'verify',
        `"${t}" 被升级到 ${gate(t)}，日常用法不应 block`);
    }
  });

  test('真正的物化表达仍须命中(修 FP 不得吞掉召回)', () => {
    // 这是"A false positive can mask a real gap"的反向验证:
    // 收狭窄词后必须确认真阳性没有一起被收掉。
    const malicious = [
      '把人当流量',
      '他们只是流量',
      '不过是流量而已',
      '把人当分母',
      '沦为流量工具',
      '当成流量变现',
    ];
    for (const t of malicious) {
      assertTrue(dimCount(t, 'dehumanization') > 0,
        `"${t}" 是真物化表达却漏检，修 FP 时吞掉了召回`);
    }
  });

  test('object 类模式不得含裸词独立 alternative', () => {
    // 定向锁: 源码里不得再出现 /分母|流量|人头|.../ 这种裸词起头的 alternation。
    // 注意必须先剥离注释行——修复说明的注释里就写着原模式的字样，
    // 否则测试会匹配到我自己的注释(第一版即犯此错)。
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assertTrue(!/\/分母\|流量\|人头\|/.test(code),
      '不得出现裸词独立选项 /分母|流量|人头|…/');
    // 应改为锚定形式(把人?当X / 当X…人 / 只不过…X)
    assertTrue(/把人\?当\(\?:KPI\|业绩\|指标\|流量\|分母\|人头\)/.test(code),
      '应存在锚定形式 把人?当(KPI|业绩|指标|流量|分母|人头)');
  });

  // ── 误报二: 对比性 rather than 不是模糊词 ─────────────
  test('对比性 rather than 不得判为模糊', () => {
    const benign = [
      'We should focus on the user experience rather than vanity metrics.',
      'We should optimize for correctness rather than speed.',
      'This measures outcomes rather than activity.',
    ];
    for (const t of benign) {
      assertEqual(dimCount(t, 'vagueness'), 0,
        `"${t}" 被误判 vagueness —— rather than 是对比性话语标记，不是模糊词`);
    }
  });

  test('真正的程度模糊词仍须命中', () => {
    for (const t of ['This is a rather large dataset.', 'The results are rather unclear.']) {
      assertTrue(dimCount(t, 'vagueness') > 0,
        `"${t}" 含真模糊词 rather 却漏检`);
    }
  });

  test('源码不得再含 rather than 作为模糊模式', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assertTrue(!/\\brather than\\b/.test(code),
      '不得把 rather than 当模糊词模式');
    // \brather\b 须排除后接 than 的对比用法
    assertTrue(/\\brather\\b\(\?!\\s\+than\\b\)/.test(code),
      '\\brather\\b 应加 (?!\\s+than\\b) 排除对比用法');
  });

  // ── 校准语料代表性 ─────────────────────────────────
  test('校准语料须含中英混插样本(合并语言模式后的必测项)', () => {
    // 背景: 41 处检测路径从 hasChinese ? ZH : EN 的排他式选择改为双向合并后，
    // 英文模式开始跑在中文文本上，误报风险随之改变。而原语料 38 条里只有 2 条
    // 混插——测量工具对刚做的改动代表性严重不足，上面两个误报正因此漏网。
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'calibrate-fp-recall.js'), 'utf8');
    const benign = /const BENIGN = \[([\s\S]*?)\n\];/.exec(src);
    assertTrue(!!benign, '应能提取 BENIGN 语料');
    const items = [...benign[1].matchAll(/'([^']*)'/g)].map(m => m[1]);
    const mixed = items.filter(t => /[\u4e00-\u9fff]/.test(t) && /[a-zA-Z]{3,}/.test(t));
    assertTrue(mixed.length >= 20,
      `中英混插良性样本仅 ${mixed.length} 条，不足以覆盖双向合并后的误报风险`);
    const mal = /const MALICIOUS = \[([\s\S]*?)\n\];/.exec(src);
    assertTrue(!!mal, '应能提取 MALICIOUS 语料');
    const mItems = [...mal[1].matchAll(/'([^']*)'/g)].map(m => m[1]);
    const mMixed = mItems.filter(t => /[\u4e00-\u9fff]/.test(t) && /[a-zA-Z]{3,}/.test(t));
    assertTrue(mMixed.length >= 5,
      `中英混插恶意样本仅 ${mMixed.length} 条，不足以验证混插文本的召回`);
  });
};
