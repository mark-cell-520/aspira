/**
 * test/dimension-tier-consistency.test.js — 文档层级表必须与代码层级集合一致
 *
 * ═══ 这个缺陷是怎么被维度健康审计抓到的 ═══
 * AGENTS.md 用四张表列出 54 个维度(9 block / 8 rewrite / 26 verify / 其余仅打分)。
 * 把文档表与 src/index.js 里的 BLOCK_DIMS/REWRITE_DIMS/VERIFY_DIMS 逐个比对，
 * 发现 **sealioning 与 tone_policing 被文档列为 verify 层，却从未进过 VERIFY_DIMS**。
 *
 * 后果不是"少一个层级"这么轻: **这两个维度孤立触发时门禁完全不动作**。
 * 探针从 SEALIONING_PATTERNS/TONE_POLICING_PATTERNS 反推(不是凭空写——本会话
 * 教训: 探针必须派生自它瞄准的模式)，逐模式实测:
 *     sealioning   30 条模式中 18 条可孤立触发，修复前全部 gate=pass
 *     tone_policing 26 条模式中 14 条可孤立触发，修复前全部 gate=pass
 * finding 确实进了 findings[]，但 gate.action=pass，而 AGENTS.md 明确建议
 * "只读一个字段就读 gate.action"——消费者按 pass 交付，那条 finding 等于不存在。
 * 此前偶发的 verify 来自 `findings.length > 1`: 中文句常同时触发 ai_writing_tell，
 * 属巧合共发，不是这两个维度的设计行为。
 *
 * ═══ 改动前先量了 FP 风险面，没有假设 ═══
 * 86 条良性语料中命中这两个维度模式的 **0 条**。且先验证了模式提取有效
 * (30 条正则全部能匹配自身字面量)，排除"提取坏了所以 0 命中"的假阴性。
 * 良性中文样本是「今天天气很好，我们去公园散步吧」这类陈述，不是
 * 「你为什么不回答」这类质问，形态上本就不该命中。恶意语料同样 0 条命中。
 *
 * ═══ 关于别名(审计不能对已知惯用法报假阳性) ═══
 * 代码用短名、文档用规范名，两处差异是**已知别名**而非漂移:
 *   bullshit            ↔ bullshit_recognition
 *   appeal_to_authority ↔ appeal_to_authority_boost
 * 本会话有"审计因不知道惯用法而报假阳性"的前科，故在此显式登记别名表，
 * 未登记的差异一律算漂移。这样将来若有人真的删掉一个维度，测试会失败。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const idx = require(path.join(ROOT, 'src', 'index.js'));
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  const doc = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');

  // 代码层级集合是函数内 const、未导出 → 直接解析源码定义
  function parseSet(name) {
    const m = src.match(new RegExp('const ' + name + '\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)'));
    if (!m) return null;
    return m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean).sort();
  }
  // 文档表: 写法是 **Block-level (9):** —— 冒号在粗体内
  function docList(label) {
    const m = doc.match(new RegExp('\\*\\*' + label + ':\\*\\*\\s*([^\\n]+)'));
    return m ? m[1].replace(/`/g, '').split(',').map(s => s.trim()).filter(Boolean).sort() : null;
  }

  const TIERS = [
    ['BLOCK_DIMS', 'Block-level \\(9\\)'],
    ['REWRITE_DIMS', 'Rewrite-level \\(8\\)'],
    ['VERIFY_DIMS', 'Verify-level \\(26\\)'],
  ];
  // 已知别名: 代码短名 → 文档规范名
  const ALIAS = { bullshit: 'bullshit_recognition', appeal_to_authority: 'appeal_to_authority_boost' };
  const canon = (d) => ALIAS[d] || d;

  test('三张层级表必须与代码集合逐一一致(扣除已登记别名)', () => {
    for (const [setName, docLabel] of TIERS) {
      const code = parseSet(setName);
      const documented = docList(docLabel);
      assertTrue(!!code, `${setName} 应能在 src/index.js 中解析到`);
      assertTrue(!!documented, `AGENTS.md 应能解析到 ${docLabel}`);
      if (!code || !documented) continue;
      const codeC = code.map(canon);
      const onlyCode = codeC.filter(x => !documented.includes(x));
      const onlyDoc = documented.filter(x => !codeC.includes(x));
      assertEqual(onlyCode.length + onlyDoc.length, 0,
        `${setName} 与文档「${docLabel}」不一致: 仅代码有 [${onlyCode}] 仅文档有 [${onlyDoc}]`);
    }
  });

  test('文档声明的维度数必须与代码集合规模相符', () => {
    // 括号里的数字是文档的自我声明，必须与实测条目数一致(防"加了维度忘了改标题")
    const claims = { 'Block-level (9)': 9, 'Rewrite-level (8)': 8, 'Verify-level (26)': 26 };
    for (const [label, n] of Object.entries(claims)) {
      const list = docList(label.replace('(', '\\(').replace(')', '\\)'));
      assertEqual(list.length, n, `文档声称 ${label} 应有 ${n} 项，实测 ${list.length} 项`);
    }
  });

  test('VERIFY_DIMS 必须包含 sealioning 与 tone_policing(本轮修复的回归护栏)', () => {
    const verify = parseSet('VERIFY_DIMS');
    assertTrue(verify.includes('sealioning'),
      'sealioning 必须在 VERIFY_DIMS 中——否则它孤立触发时 gate=pass，finding 形同不存在');
    assertTrue(verify.includes('tone_policing'),
      'tone_policing 必须在 VERIFY_DIMS 中——同上');
  });

  test('sealioning / tone_policing 孤立触发必须升级为 verify(行为级)', () => {
    // 探针从模式反推: SEALIONING_PATTERNS.zh 与 TONE_POLICING_PATTERNS.zh 的首条
    const probes = [
      ['sealioning', '那你怎么解释'],
      ['sealioning', '请你正面回答'],
      ['sealioning', '你回避了我的问题'],
      ['tone_policing', '你态度不对'],
      ['tone_policing', '你能不能好好说话'],
      ['tone_policing', '你激动什么'],
    ];
    for (const [dim, text] of probes) {
      const r = idx.discriminate(text, []);
      const dims = (r.findings || []).map(f => f.dimension);
      assertTrue(dims.includes(dim),
        `探针「${text}」应触发 ${dim}(若不再触发，说明模式被改，需同步更新本测试)`);
      // 关键断言: 孤立触发也必须升级，不能只靠 findings.length > 1 的巧合
      assertEqual(dims.length, 1,
        `探针「${text}」应仅触发 ${dim} 一个维度(孤立场景)，实测 [${dims}]`);
      assertEqual(r.gate.action, 'verify',
        `探针「${text}」的 gate 应为 verify，实测 ${r.gate.action}`);
    }
  });

  test('dimensions 键必须被文档四表完整覆盖', () => {
    const d = idx.discriminate('test', []);
    const dimKeys = Object.keys(d.dimensions || {}).sort();
    assertEqual(dimKeys.length, 54, `dimensions 应有 54 个键，实测 ${dimKeys.length}`);
    const sm = doc.match(/Dimensions that are scored but do not force a gate action:([\s\S]*?)\n\n/);
    const scored = sm ? sm[1].replace(/`/g, '').split(',').map(s => s.trim()).filter(Boolean).sort() : [];
    const all = [].concat(
      docList('Block-level \\(9\\)'), docList('Rewrite-level \\(8\\)'),
      docList('Verify-level \\(26\\)'), scored);
    const undoc = dimKeys.filter(k => !all.includes(k));
    assertEqual(undoc.length, 0, `有 dimensions 键但文档未列: [${undoc}]`);
  });
};
