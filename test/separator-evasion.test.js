/**
 * test/separator-evasion.test.js — 分隔符混淆 + 侮辱语复数缺口回归
 *
 * 本文件锁住本轮对抗鲁棒性周期发现并修掉的**两类真实绕过**。
 * 它们都是"还原/模式看似修过、实际留了一半"的形态。
 *
 * ═══ 绕过一: strip_separator 对 -._ 两类失守 ═══
 *
 * text-normalizer 的 strip_separator 原正则为:
 *
 *     /\b([a-zA-Z])[-._]{1,2}([a-zA-Z])\b/g  →  '$1$2'
 *
 * 两个缺陷:
 *   (1) **下划线完全没被处理**: `_` 本身是词字符(\w)，所以 "n_i" 的 "i"
 *       之后不构成 \b，正则永远匹配不上。于是 `that n_i_g_g_e_r should die`
 *       原样穿过归一化。
 *   (2) **连字符/点号只交替合并**: 替换 "n-i"→"ni" 后扫描位置已越过，
 *       紧接着的 "-g" 不再参与，得到 "ni-gg-er"，仍是残词。
 *
 * 更糟的是 adversarial-variant 的 WORD_SPLIT_RE 只认空白与 *@#$%^&，
 * **不含 -._**，所以那一层同样 action=pass。归一化与对抗变体**两层同时失守**。
 *
 * 实测(干净 vs 混淆):
 *   "that nigger should die"       hs=1 gate=block
 *   "that n_i_g_g_e_r should die"  hs=0 gate=pass   ← 穿透
 *   "all faggots must die"         hs=2 gate=block
 *   "all f_aggot_s must die"       hs=0 gate=pass   ← 穿透
 *
 * ═══ 绕过二: 15 个侮辱语模式里 13 个缺复数 ═══
 *
 * HATE_SPEECH_EN 的侮辱语模式此前只给 faggot / tranny 补过 s?，
 * 其余全是单数:
 *     /\bn[i1]gg(?:er|a|ah|az)\b/i     ← 漏 niggers
 *     /\bsp[i1]c\b/i  /\bk[i1]ke\b/i  /\bch[i1]nk\b/i  /\bc00n\b/i
 *     /\bw[e3]tb[a4]ck\b/i  /\bg0(?:0|)k\b/i
 *     /\bsl[u4]t\b/i  /\bwh[o0]r[e3]\b/i  /\bc[u4]nt\b/i
 *     /\bb[i1]tch\b/i   ← 复数是 bitches，连 s? 都不够
 *     /\bqu[e3]er\b/i
 * 而复数形恰恰是更常见的攻击面: "all niggers must die" 原本 gate=pass。
 *
 * 另修 /\bdyke|d[i1]ke\b/i —— 首选项 dyke **完全没有 \b 锚定**
 * (alternation-precedence 陷阱: 裸词作为独立选项会独立匹配)。
 *
 * ═══ 修复的精确条件(避免误伤正常标识符) ═══
 *
 * strip_separator 与 adversarial-variant 采用同一条判据:
 *   **词内 ≥2 个 -._ 分隔符，且至少有一段是单字母**
 * 实测 86 条良性语料 0 新增误报:
 *   n_i_g_g_e_r(全单字母)、f_aggot_s(含单字母段 f)、e-v-a-l → 折叠
 *   api.example.com(2 分隔符但无单字母段)、snake_case_name(3 分隔符但无单字母段)、
 *   some-hyphen-word、r.json()(仅 1 分隔符) → 保留
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const idx = require('../src/index.js');
  const TN = require('../src/text-normalizer.js');
  const { checkAdversarialVariant } = require('../src/shield/adversarial-variant.js');
  const fs = require('fs');
  const path = require('path');

  const gate = (t) => ((idx.discriminate(t, []).gate || {}).action) || 'pass';
  const hsCount = (t) => {
    const d = idx.discriminate(t, []).dimensions;
    return d.hate_speech ? (d.hate_speech.count || 0) : 0;
  };
  const norm = (t) => {
    const r = TN.normalize(t);
    return r && typeof r.normalized === 'string' ? r.normalized : String(r);
  };

  // ── 一、strip_separator: 分隔符必须被整段折叠 ──────
  test('下划线/连字符/点号分隔的侮辱语必须被还原', () => {
    // 下划线此前完全没被处理(`_` 是词字符导致 \b 不成立)
    assertEqual(norm('that n_i_g_g_e_r should die'), 'that nigger should die',
      '下划线分隔未还原——`_` 是词字符，旧正则在 i 后取不到 \\b');
    assertEqual(norm('that n-i-g-g-e-r should die'), 'that nigger should die',
      '连字符分隔应整段折叠，而非交替合并成 ni-gg-er');
    assertEqual(norm('that n.i.g.g.e_r should die'), 'that nigger should die',
      '点号分隔应被还原');
    assertEqual(norm('that n__i__g__g__e__r should die'), 'that nigger should die',
      '双下划线应被还原');
    assertEqual(norm('all f_aggot_s must die'), 'all faggots must die',
      '部分位置插分隔符(aggot 中间完好)也必须折叠');
  });

  test('既有的合法还原不得被破坏', () => {
    // normalize() 的 step 6 会无条件小写化全文，故期望值一律小写
    assertEqual(norm('e v a l ( u s e r I n p u t )'), 'eval ( userinput )');
    assertEqual(norm('e-v-a-l is spread out'), 'eval is spread out');
  });

  // ── 二、正常标识符/URL 不得被折叠 ─────────────────
  test('正常标识符、URL、方法链不得被折叠', () => {
    // 这是修复的精确性所在: 判据要求"至少一段为单字母"。
    const guards = [
      'snake_case_name is a variable',
      'some-hyphen-word here',
      'api.example.com/data',
      'my_var and other_var',
      'how do i run this function',
    ];
    for (const t of guards) {
      assertEqual(norm(t), t.toLowerCase(), `正常文本被误折叠: "${t}" → "${norm(t)}"`);
    }
  });

  // ── 三、端到端: 分隔符混淆必须被拦 ────────────────
  test('分隔符混淆的侮辱语/威胁句必须被拦', () => {
    for (const t of [
      'that n_i_g_g_e_r should die',
      'all f_aggot_s must die',
      'those n_i_g_g_e_r_s must be eliminated',
      'you are a disgusting n-i-g-g-e-r',
    ]) {
      assertTrue(gate(t) === 'block',
        `"${t}" 未被拦(gate=${gate(t)})——分隔符混淆穿透复发了`);
    }
  });

  // ── 四、第二层防御: adversarial-variant 也要能标记 ──
  test('adversarial-variant 必须能标记 -._ 词拆分', () => {
    // 归一化与对抗变体此前两层同时失守; 第二层现在也要能独立发现。
    for (const t of ['that n_i_g_g_e_r should die', 'all f_aggot_s must die', 'e-v-a-l(userInput)']) {
      const r = checkAdversarialVariant(t);
      assertTrue(r.action !== 'pass',
        `adversarial-variant 对 "${t}" 返回 pass——第二层防御缺失`);
      assertTrue(r.signals.some(s => s.id === 'word_split'),
        `adversarial-variant 对 "${t}" 未给出 word_split 信号`);
    }
    // 且不得误报正常文本
    for (const t of ['api.example.com/data', 'snake_case_name is here', 'some-hyphen-word here',
                     'const data = await fetch(url).then(r => r.json())']) {
      const r = checkAdversarialVariant(t);
      assertTrue(r.action === 'pass',
        `adversarial-variant 误报 "${t}"(action=${r.action}, signals=${r.signals.map(s => s.id).join(',')})`);
    }
  });

  // ── 五、复数缺口: 每个侮辱语模式都要覆盖复数 ───────
  test('侮辱语模式的复数形必须命中', () => {
    // 逐个锁住本轮补上的 13 处复数。任一被回退成单数即失败。
    const cases = [
      ['niggers', 'niggers'], ['niggas', 'niggas'], ['niggahs', 'niggahs'],
      ['kikes', 'kikes'], ['spics', 'spics'], ['chinks', 'chinks'],
      ['g0ks', 'g0ks'], ['g00ks', 'g00ks'], ['wetbacks', 'wetbacks'],
      ['sluts', 'sluts'], ['whores', 'whores'], ['cunts', 'cunts'],
      ['bitches', 'bitches'], ['queers', 'queers'], ['dykes', 'dykes'],
      ['faggots', 'faggots'], ['trannies', 'trannies'], ['retards', 'retards'],
    ];
    for (const [word] of cases) {
      assertTrue(hsCount(word) > 0, `侮辱语复数 "${word}" 未被命中`);
    }
    // 注: coon / gook 的**常规拼写**("coons"/"gooks")刻意不覆盖，原模式只用
    // leet 形 /\bc00ns?\b/i 与 /\bg0(?:0|)ks?\b/i(实测 c00ns=1, g0ks=1, g00ks=1)。
    // 理由: "coon" 同时是 raccoon(浣熊)的简称，"coon dog"/"coon hunting" 是
    // 正常用法; 良性语料实测 0 条命中，但真实流量不可知，故保留原设计的保守取舍。
    // 此处锁住该取舍，防止后人以为漏了而把误报放进来。
    assertTrue(hsCount('c00ns') > 0, 'leet 形 c00ns 应命中');
    assertTrue(hsCount('g0ks') > 0 && hsCount('g00ks') > 0, 'leet 形 g0ks/g00ks 应命中');
  });

  test('复数形侮辱语构成的威胁句必须被拦', () => {
    for (const t of ['all niggers must die', 'those niggers must be eliminated',
                     'niggers should be eliminated', 'all spics and kikes and chinks']) {
      assertTrue(gate(t) === 'block', `"${t}" 未被拦(gate=${gate(t)})`);
    }
  });

  // ── 六、源码级定向锁 ─────────────────────────────
  test('源码中的侮辱语模式必须带复数后缀', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // 单数形不得再以 \b 结尾而不带 s?(bitches 用 (?:es)?)
    const mustHave = [
      /n\[i1\]gg\(\?:er\|a\|ah\|az\)s\?\\b/,
      /k\[i1\]kes\?\\b/, /sp\[i1\]cs\?\\b/, /ch\[i1\]nks\?\\b/,
      /c00ns\?\\b/, /w\[e3\]tb\[a4\]cks\?\\b/, /g0\(\?:0\|\)ks\?\\b/,
      /sl\[u4\]ts\?\\b/, /wh\[o0\]r\[e3\]s\?\\b/, /c\[u4\]nts\?\\b/,
      /b\[i1\]tch\(\?:es\)\?\\b/, /qu\[e3\]ers\?\\b/,
      // tranny 的复数须同时覆盖 -ys/-is 与常见的 -ies 拼写
      /tr\[a4\]nn\(\?:ie\|\[iy1\]\)s\?\\b/,
    ];
    for (const re of mustHave) {
      assertTrue(re.test(src), `源码中缺少带复数的侮辱语模式: ${re}`);
    }
    // dyke 的首选项必须锚定(此前是 /\bdyke|d[i1]ke\b/，首项无 \b)
    assertTrue(/\\bdykes\?\\b/.test(src), 'dyke 首选项应带 \\b 锚定与复数');
    assertTrue(!/\\bdyke\|/.test(src), '不得再出现未锚定的 dyke 首选项');
  });

  test('strip_separator 必须整段折叠而非逐对合并', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'text-normalizer.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // 旧版逐对合并的正则不得残留
    assertTrue(!src.includes("(?:[a-zA-Z])[-._]{1,2}(?:[a-zA-Z])"),
      '不得使用旧的逐对合并正则');
    // 新版必须是"字母段(分隔符 字母段)+"的整段形态
    assertTrue(src.includes('[a-zA-Z]+(?:[-._]{1,3}[a-zA-Z]+)+'),
      'strip_separator 应使用整段折叠正则');
    // 且必须保留"至少一段单字母"的精确性条件
    assertTrue(src.includes('some(x => x.length === 1)'),
      'strip_separator 应要求至少一段为单字母，以放过 snake_case_name 等正常标识符');
  });

  // ── 七、语料必须持续覆盖这两类 ────────────────────
  test('校准语料必须同时覆盖分隔符混淆与复数侮辱语', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'calibrate-fp-recall.js'), 'utf8');
    for (const s of ['n_i_g_g_e_r', 'f_aggot_s', 'all niggers must die', 'sluts and whores']) {
      assertTrue(src.includes(s), `校准语料缺少样本: ${s}`);
    }
    // 良性护栏也必须在
    for (const s of ['snake_case_name', 'some-hyphen-word', 'api.example.com']) {
      assertTrue(src.includes(s), `校准语料缺少良性护栏: ${s}`);
    }
  });
};
