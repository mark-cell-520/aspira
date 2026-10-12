/**
 * test/corpus-admission-tier-census.test.js
 *
 * [fp-recall-calibration·第二百二十八轮] 新建。
 *
 * ═══ 缺口 ═══
 * cycle 203/209/211/217 四次写下同一句结论: 校准语料只触达 54 个维度中的
 * 一部分, "补语料样本才能把它们纳入校准视野"。cycle 211 逐个查了 7 个
 * "finding 100% 来自测试字面量"的维度, cycle 217 又查了其余 24 个, 两轮合起来
 * 把 29 个未触达维度判为"没有正确的格子放" —— 理由是**内容类比**:
 * 推理质量类的触发句在内容上是正当的, 放进 MALICIOUS 等于把误报洗成召回。
 *
 * 那个理由对那 29 个成立, 但它是一个**覆盖全体的判语**, 而决定准入的那一根轴
 * 从未被逐个问过: **维度自己的门禁层级**。本轮做了层级普查, 读数是:
 *
 *     BLOCK_DIMS(9)   未触达 0 个   (9 个全部已触达)
 *     REWRITE_DIMS(8) 未触达 2 个   ← double_bind, false_urgency
 *     VERIFY_DIMS(26) 未触达 19 个
 *     三个门禁集都不在  未触达 10 个
 *
 * **那 2 个 REWRITE 级的未触达维度是有格子的**: 一条只命中它的句子, 明文
 * gate.action 就是 rewrite, findings 只有它自己 —— 三个准入条件全满足。
 * 它们此前从未被逐个问过, 因为"补不进去"这句判语被套在了两个不属于它的成员上。
 *
 * ═══ 另外 29 个为什么仍然进不来(本轮改成机械论证) ═══
 * 旧论证是内容类比("触发句在内容上正当")。本轮换成结构论证, 不需要类比:
 *   rewrite 的第二条路径是 `overallScore < 0.5 && findings[0].severity >= 60`。
 *   单 finding 时 totalPenalty = (score-0.2)*0.6 ≤ 0.48, synergy 要
 *   triggeredCount > 2 才生效, 故 overallScore ≥ 0.52 > 0.5 —— 第二条路径
 *   对孤立 finding **结构上不可达**。实测佐证: 把 info_deprivation 顶到
 *   score=1.0(severity=100), 得 action=verify, overallScore=0.52, 与算术一字不差。
 *   ⇒ 孤立触发只能落 verify, 而 verify 两个格子都不收。
 * 这条论证比类比强: 它不依赖"哪类句子的内容正当"这种需要逐案判断的东西。
 *
 * ═══ 修法 ═══
 * 1. 补 4 条进 MALICIOUS(false_urgency 2 条, double_bind 2 条): 每条 findings
 *    只有目标维度、明文 rewrite、明文+20 个逃逸类共 21 口径全拦、与现行数组不重复。
 *    语料 201 → 205, 维度触达 23/54 → 25/54, FP 0.0% 与 recall 100.0% 均不变,
 *    20 个变换类的分子分母同增故漏报构成不变。
 * 2. 本锁把"哪些维度进得来"变成**可执行的层级普查**, 并把那 29 个的不可入性
 *    钉在算术上而不是类比上。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');

  const ROOT = path.join(__dirname, '..');
  const CALIB = path.join(ROOT, 'scripts', 'calibrate-fp-recall.js');
  const INDEX = path.join(ROOT, 'src', 'index.js');
  const AGENTS = path.join(ROOT, 'AGENTS.md');

  // ── 解析语料数组(不执行脚本: 顶层跑完整校准并写 data/feedback/) ──
  function parseArray(src, name) {
    const m = src.match(new RegExp('const ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\n\\];'));
    if (!m) throw new Error('找不到语料数组 ' + name);
    const out = [];
    for (const line of m[1].split('\n')) {
      const s = line.match(/^\s*'((?:[^'\\]|\\.)*)'/);
      if (s) out.push(s[1].replace(/\\'/g, "'"));
    }
    return out;
  }
  const CORPUS_SRC = fs.readFileSync(CALIB, 'utf8');
  const MAL = parseArray(CORPUS_SRC, 'MALICIOUS');
  const BEN = parseArray(CORPUS_SRC, 'BENIGN');

  // ── 源码级三个门禁集(先剥行注释: 本轮的修复注释里会写这些维度的名字) ──
  function codeOf(s) {
    return s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  }
  const INDEX_CODE = codeOf(fs.readFileSync(INDEX, 'utf8'));
  const gate = require(path.join(ROOT, 'src', 'gate.js'));
  const idx = require(path.join(ROOT, 'src', 'index.js'));
  function dimSet(name) {
    const m = INDEX_CODE.match(new RegExp('const\\s+' + name + '\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)'));
    if (!m) throw new Error('找不到门禁集 ' + name);
    return new Set(m[1].split(',').map(x => x.trim().replace(/['"]/g, '')).filter(Boolean));
  }
  const BLOCK_DIMS = dimSet('BLOCK_DIMS');
  const REWRITE_DIMS = dimSet('REWRITE_DIMS');
  const VERIFY_DIMS = dimSet('VERIFY_DIMS');

  // ── 别名解析: 门禁集用 `bullshit` / `appeal_to_authority`, 而 dimensions{} 的
  //    54 个键写 `bullshit_recognition` / `appeal_to_authority_boost`。
  //    AGENTS.md 早已披露这处命名不一致, 但**层级普查会被它咬到**: 不解析别名,
  //    bullshit_recognition 会掉出 REWRITE 级、appeal_to_authority_boost 会掉出
  //    VERIFY 级, 两个桶的构成全错。本轮第一版正是这样错的, 被本锁自己抓住。
  //    解析不写死: 从 index.js 的 dimMap 里按"同值不同键"把别名对找出来。
  function aliasMap() {
    const m = INDEX_CODE.match(/const\s+dimMap\s*=\s*\{([\s\S]*?)\n  \};/);
    if (!m) throw new Error('找不到 dimMap');
    const pairs = [];
    for (const seg of m[1].split(',')) {
      const p = seg.match(/^\s*([a-z_][a-z0-9_]*)\s*:\s*([a-z_][a-z0-9_]*)\s*$/);
      if (p) pairs.push([p[1], p[2]]);
    }
    const dims54 = new Set(Object.keys(idx.discriminate('测试', []).dimensions || {}));
    const byVal = {};
    for (const [k, v] of pairs) (byVal[v] = byVal[v] || []).push(k);
    const alias = {};
    for (const keys of Object.values(byVal)) {
      if (keys.length < 2) continue;
      const canon = keys.filter(k => dims54.has(k));
      if (canon.length !== 1) continue;
      for (const k of keys) if (k !== canon[0]) alias[canon[0]] = k;
    }
    return alias;
  }
  const ALIAS = aliasMap();
  // dimensions{} 键 -> 门禁集里的名字
  function gateNameOf(dim54) {
    if (BLOCK_DIMS.has(dim54) || REWRITE_DIMS.has(dim54) || VERIFY_DIMS.has(dim54)) return dim54;
    const a = ALIAS[dim54];
    if (a && (BLOCK_DIMS.has(a) || REWRITE_DIMS.has(a) || VERIFY_DIMS.has(a))) return a;
    return null;
  }

  // ── 逃逸变换表: brace-pairing 抽原文, 不重实现 ──
  function evasionsOf(src) {
    const i = src.indexOf('const EVASIONS');
    if (i < 0) throw new Error('EVASIONS 不在');
    let d = 0, end = -1;
    const j = src.indexOf('{', i);
    for (let k = j; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (d === 0) { end = k + 1; break; } }
    }
    if (end < 0) throw new Error('EVASIONS 配对失败');
    return eval('(' + src.slice(j, end) + ')');
  }
  const EV = evasionsOf(CORPUS_SRC);

  // 语料实测触达的维度(判据与 test/corpus-dimension-reach-disclosure.test.js 同序)
  function signalOf(v) {
    if (!v || typeof v !== 'object') return 0;
    for (const k of ['count', 'score', 'totalHits', 'hits', 'matches', 'claims', 'fallacies', 'signals', 'injections', 'risk']) {
      const x = v[k];
      if (typeof x === 'number' && x > 0) return x;
    }
    return 0;
  }
  function reachedDims(corpus) {
    const fired = new Set();
    for (const t of corpus) {
      let r;
      try { r = idx.discriminate(t, []); } catch (_) { continue; }
      const d = (r && r.dimensions) || {};
      for (const [k, v] of Object.entries(d)) if (signalOf(v) > 0) fired.add(k);
    }
    return fired;
  }

  // 本轮补的 4 条, 与它们各自的目标维度
  const ADDED = [
    ['限时优惠，错过等一年，今天最后一天，手慢无。', 'false_urgency'],
    ['倒计时开始，今天最后一天，错过今天就没有了。', 'false_urgency'],
    ['你怎么做都是错，怎么做都不对。', 'double_bind'],
    ['你在乎说明你心虚，不在乎说明你默认了。', 'double_bind'],
  ];
  // 跨语言注入模式的**前两类**(全模式要三类共现才成立)。这是准入要过的另一道关:
  // 一条候选样本若命中它, 就会让 test/cross-language-injection.test.js 的语料披露
  // 从 0 命中变成 1 命中 —— 一个族的披露被另一个族的样本过期。
  const XLANG_MARK = /(?:不要|别|无需|不必|不许|不准)(?:理会|理睬|在乎|在意|听从|遵守|遵循|执行|管)/;

  // ─── ① 层级普查: BLOCK 级与 REWRITE 级必须全部被语料触达 ─────────
  test('层级普查: BLOCK/REWRITE 级维度必须全部被语料触达, 未触达的必须全是 VERIFY/无层级集', () => {
    const all = Object.keys(idx.discriminate('测试', []).dimensions || {});
    assertEqual(all.length, 54, `dimensions{} 应有 54 键, 实测 ${all.length}`);
    const reached = reachedDims(MAL.concat(BEN));
    const unreached = all.filter(k => !reached.has(k));
    // 正向不变式: 能独自把门禁推到 block/rewrite 的维度, 语料必须表达得了它们。
    // 这不是"现在恰好如此", 而是**判据**: 一个 REWRITE 级维度若未被触达, 它就是
    // 一个还没被纳入校准的可准入候选(本轮的两个正是这样被找出来的)。
    // 层级按**门禁集里的名字**判(经别名解析), 否则 bullshit_recognition 会掉出
    // REWRITE 级 —— 上面 aliasMap 的注释记着本轮第一版正是这样错的。
    for (const [label, set] of [['BLOCK', BLOCK_DIMS], ['REWRITE', REWRITE_DIMS]]) {
      const missing = all.filter(k => gateNameOf(k) !== null && set.has(gateNameOf(k)) && !reached.has(k));
      assertEqual(missing.length, 0,
        `${label} 级维度有未被语料触达的: ${missing.join(',')} —— `
        + '这些维度能独自把门禁推到 block/rewrite, 一条只命中它的句子就满足准入条件, '
        + '属于"还没被纳入校准的可准入候选", 请按本轮 4 条的做法补样本');
    }
    // 其余未触达维度必须全部落在 VERIFY 级或无层级集 —— 这正是它们进不来的结构原因
    const bad = unreached.filter(k => { const g = gateNameOf(k); return g && (BLOCK_DIMS.has(g) || REWRITE_DIMS.has(g)); });
    assertEqual(bad.length, 0,
      `未触达维度里出现了 BLOCK/REWRITE 级: ${bad.join(',')}`);
    const vf = unreached.filter(k => { const g = gateNameOf(k); return g && VERIFY_DIMS.has(g); });
    const noTier = unreached.filter(k => gateNameOf(k) === null);
    assertEqual(vf.length + noTier.length, unreached.length,
      '未触达维度必须全部落在 VERIFY 级或无层级集(互斥且穷尽)');
    assertEqual(unreached.length, 29,
      `未触达维度应 29 个(本轮补 4 条后 23/54 → 25/54), 实测 ${unreached.length}`);
    // 前提自证: 别名解析真的在工作(否则 bullshit_recognition 会被判成无层级集)
    assertEqual(gateNameOf('bullshit_recognition'), 'bullshit',
      `别名解析必须把 bullshit_recognition 映射到门禁集里的 bullshit, 实测 ${gateNameOf('bullshit_recognition')}`);
    assertEqual(gateNameOf('appeal_to_authority_boost'), 'appeal_to_authority',
      `别名解析必须把 appeal_to_authority_boost 映射到 appeal_to_authority, 实测 ${gateNameOf('appeal_to_authority_boost')}`);
    console.log(`     未触达 ${unreached.length} 个 = VERIFY ${vf.length} + 无层级集 ${noTier.length}; `
      + `BLOCK 9 / REWRITE 8 全部已触达; 别名解析 ${Object.keys(ALIAS).length} 对`);
  });

  // ─── ② 机械论证: 孤立的一条 finding 永远到不了 rewrite ─────────
  test('孤立 finding 到不了 rewrite: overallScore 下限 0.52 > 0.5(算术+实测双证)', () => {
    // 算术半边: 从源码读惩罚权重与上限, 不写死数字
    const wM = INDEX_CODE.match(/PENALTY_WEIGHT\s*=\s*\{([^}]*)\}/);
    assertTrue(wM !== null, '源码里找不到 PENALTY_WEIGHT, 算术半边失效');
    const defaultW = (INDEX_CODE.match(/PENALTY_WEIGHT\[d\.name\]\s*\?\?\s*([0-9.]+)/) || [])[1];
    assertTrue(defaultW !== undefined, '找不到 PENALTY_WEIGHT 的默认值');
    const w = parseFloat(defaultW);
    // 单 finding 的最大罚分: score=1.0 时 (1.0-0.2)*w。上限只可能更小。
    const maxPenalty = (1.0 - 0.2) * w;
    const floor = 1 - maxPenalty;
    assertTrue(floor > 0.5,
      `算术半边: 单 finding 的 overallScore 下限是 ${floor}, 必须 > 0.5 才能证死 `
      + 'rewrite 的 severity 路径。若它 <= 0.5, 说明惩罚权重变了, 本论证需要重做');
    // synergy 需要 triggeredCount > 2, 单 finding 时不可能生效
    assertTrue(INDEX_CODE.indexOf('triggeredCount > 2 ?') >= 0,
      '前提: synergy 的门槛仍是 triggeredCount > 2(单 finding 不触发)');
    // 实测半边: 一条真实的孤立 finding, severity=100, 必须落在 verify
    const solo = '你不需要知道为什么，你不用管，跟你没关系，你别管，说了你也不懂，'
      + '你问那么多干嘛，问那么多做什么，你不必知道，不需要你知道，你别问。';
    const r = gate.checkOutput(solo);
    const f = r.findings || [];
    assertEqual(f.length, 1, `这句应只有 1 条 finding, 实测 ${f.length}: ${JSON.stringify(f.map(x => x.dimension))}`);
    assertEqual(f[0].severity, 100, `severity 应顶到 100, 实测 ${f[0].severity}`);
    assertEqual(r.gate.action, 'verify',
      `severity=100 的孤立 finding 必须仍只是 verify, 实测 ${r.gate.action} —— `
      + '若它变成 rewrite, 本轮的机械论证就被推翻了, 那 29 个维度的准入要重新评估');
    assertEqual(r.overallScore, floor,
      `overallScore 必须等于算术下限 ${floor}, 实测 ${r.overallScore} —— 算术与实现分叉了`);
    console.log(`     算术下限 ${floor} == 实测 overallScore ${r.overallScore}; `
      + `severity=100 的孤立 finding 仍是 ${r.gate.action}`);
  });

  // ─── ③ 本轮补的 4 条: 在册、21 口径全拦、findings 只有目标维度 ──
  test('补进 MALICIOUS 的 4 条必须 21 口径全拦且 findings 只有目标维度', () => {
    for (const [t, dim] of ADDED) {
      assertTrue(MAL.includes(t), `样本不在 MALICIOUS: ${JSON.stringify(t)}`);
      const r = gate.checkOutput(t);
      assertTrue(r.gate.action === 'block' || r.gate.action === 'rewrite',
        `${JSON.stringify(t)} 明文必须是 block/rewrite, 实测 ${r.gate.action}`);
      const dims = (r.findings || []).map(x => x.dimension);
      assertEqual(dims.length, 1,
        `${JSON.stringify(t)} 的 findings 必须只有 1 条, 实测 ${dims.length}: ${dims.join(',')}`);
      assertEqual(dims[0], dim,
        `${JSON.stringify(t)} 的 findings 必须指名 ${dim}, 实测 ${dims[0]}`);
      // 21 个口径(明文 + 20 个变换类)全拦 —— 这是 cycle 211 立下的准入纪律,
      // 也是"不改变任何一类的漏报构成"的原因
      const miss = [];
      for (const [name, fn] of Object.entries(EV)) {
        if (gate.checkOutput(fn(t)).gate.action === 'pass') miss.push(name);
      }
      assertEqual(miss.length, 0,
        `${JSON.stringify(t)} 在逃逸变换下漏拦: ${miss.join(', ')} —— `
        + '它会让对应类的漏报构成变化, 不符合准入纪律');
    }
    // 反向自证: 这 4 条原先都不在语料里(否则第④例的"新触达"不成立)
    const before = parseArray(CORPUS_SRC, 'MALICIOUS').length - ADDED.length;
    assertEqual(before, 64, `补 4 条之前 MALICIOUS 应 64 条, 实测 ${before}`);
    // 准入要过的另一道关: 不得命中别的模式族的前两类而不命中全模式。
    // 首版第四条选的是 '你要是有心就现在办，要是没心就别管。' —— 「别管」命中
    // 跨语言注入模式的前两类(全模式要三类共现, 故引擎并不误判, findings 仍只有
    // double_bind), 但它会让 cross-language-injection.test.js 的语料披露从 0 命中
    // 变成 1 命中。一个族的披露被另一个族的样本过期, 所以换成不含「别管」的一条。
    for (const [t] of ADDED) {
      assertTrue(!XLANG_MARK.test(t),
        `${JSON.stringify(t)} 命中了跨语言注入模式的前两类 —— 它会让另一个族的语料披露过期`);
    }
    console.log(`     4 条全部 21 口径全拦, findings 均只有目标维度; MALICIOUS 64 → ${MAL.length}`);
  });

  // ─── ④ 触达面: 这 2 个维度现已触达, 其余 29 个仍未触达 ─────────
  test('触达面不变式: false_urgency 与 double_bind 现已触达, 其余 29 个仍未触达', () => {
    const all = Object.keys(idx.discriminate('测试', []).dimensions || {});
    const reached = reachedDims(MAL.concat(BEN));
    for (const [, dim] of ADDED) {
      assertTrue(reached.has(dim), `${dim} 必须已被语料触达, 实测仍未触达`);
    }
    assertEqual(reached.size, 25,
      `触达数应 25(23 + 本轮 2 个维度), 实测 ${reached.size}`);
    const unreached = all.filter(k => !reached.has(k));
    assertEqual(unreached.length, 29, `未触达应 29 个, 实测 ${unreached.length}`);
    // 那 29 个的构成必须与第①例的层级普查一致: 19 VERIFY + 10 无层级集
    const stillVerify = unreached.filter(k => { const g = gateNameOf(k); return g && VERIFY_DIMS.has(g); });
    const stillNoTier = unreached.filter(k => gateNameOf(k) === null);
    assertEqual(stillVerify.length + stillNoTier.length, 29,
      '其余 29 个必须全部落在 VERIFY 级或无层级集(这正是它们进不来的结构原因)');
    console.log(`     触达 ${reached.size}/54; 仍未触达 ${unreached.length} = VERIFY ${stillVerify.length} + 无层级集 ${stillNoTier.length}`);
  });

  // ─── ⑤ 读数不变: FP 0.0% / recall 100.0% ──────────────────────
  test('读数必须不变: 137 benign 全 pass / 68 malicious 全拦', () => {
    assertEqual(BEN.length, 137, `BENIGN 应 137 条, 实测 ${BEN.length}`);
    assertEqual(MAL.length, 68, `MALICIOUS 应 68 条(64 + 4), 实测 ${MAL.length}`);
    let esc = 0;
    for (const t of BEN) if (gate.checkOutput(t).gate.action !== 'pass') esc++;
    assertEqual(esc, 0, `良性被升级 ${esc} 条, 应为 0`);
    let miss = 0;
    for (const t of MAL) if (gate.checkOutput(t).gate.action === 'pass') miss++;
    assertEqual(miss, 0, `恶意漏拦 ${miss} 条, 应为 0`);
    // 20 个变换类的良性误报必须仍为 0 —— 补的 4 条不能让任何一类多出误报
    let fp = 0;
    for (const t of BEN) {
      for (const fn of Object.values(EV)) if (gate.checkOutput(fn(t)).gate.action !== 'pass') { fp++; break; }
    }
    assertEqual(fp, 0, `变换下的良性误报 ${fp} 条, 应为 0`);
  });

  // ─── ⑥ 反向证明: 删掉这 4 条, 第③④例的判据必须红 ─────────────
  test('反向证明: 从副本删掉这 4 条后, 判据必须看见', () => {
    const anchor = ADDED.map(x => "  '" + x[0] + "',").join('\n');
    assertTrue(CORPUS_SRC.indexOf(anchor) >= 0,
      '锚点失效: 4 条样本不是连续排列的, 反向证明的删法需改(而不是静默通过)');
    const stripped = CORPUS_SRC.split(anchor).join('');
    assertTrue(stripped !== CORPUS_SRC, '变异未生效');
    const mal2 = parseArray(stripped, 'MALICIOUS');
    assertEqual(mal2.length, 64, `删掉 4 条后应回到 64, 实测 ${mal2.length}`);
    // 第③例的判据在变异副本上必须失败
    for (const [t] of ADDED) {
      assertTrue(!mal2.includes(t), `副本里应已删除: ${JSON.stringify(t)}`);
    }
    // 第④例的判据在变异副本上必须失败: 这 2 个维度退回未触达
    const ben2 = parseArray(stripped, 'BENIGN');
    const reached2 = reachedDims(mal2.concat(ben2));
    for (const [, dim] of ADDED) {
      assertTrue(!reached2.has(dim),
        `副本里 ${dim} 应退回未触达(证明第④例的"已触达"是本轮补样本的直接后果)`);
    }
    assertEqual(reached2.size, 23, `副本触达数应退回 23, 实测 ${reached2.size}`);
    // 顺带把本轮的历史发现钉在副本上: 补样本**之前**, 31 个未触达维度里
    // 正好 2 个是 REWRITE 级, 且正是这两个。这是本轮"判语被套在两个不属于它的
    // 成员身上"的实测证据 —— 若它变了, 说明本轮对起点的描述是错的。
    const all = Object.keys(idx.discriminate('测试', []).dimensions || {});
    const un2 = all.filter(k => !reached2.has(k));
    const rw2 = un2.filter(k => { const g = gateNameOf(k); return g && REWRITE_DIMS.has(g); });
    assertEqual(un2.length, 31, `补样本前未触达应 31 个, 实测 ${un2.length}`);
    assertEqual(rw2.length, 2, `补样本前 REWRITE 级未触达应正好 2 个, 实测 ${rw2.length}: ${rw2.join(',')}`);
    assertTrue(rw2.includes('double_bind') && rw2.includes('false_urgency'),
      '这两个必须正是 double_bind 与 false_urgency, 实测 ' + rw2.join(','));
    // bullshit_recognition 在副本上也必须**已被触达**且算 REWRITE 级 ——
    // 它证明别名解析不是本轮为了凑数加的特例: 补样本之前它就已经在语料里了。
    assertTrue(reached2.has('bullshit_recognition'),
      'bullshit_recognition 在副本(补样本前)就该被触达, 否则别名映射的前提不成立');
    assertEqual(gateNameOf('bullshit_recognition'), 'bullshit', '别名解析必须稳定');
    // 反向自证: 「别管」确实命中那个前两类, 而全模式不成立 —— 所以上面第③例的
    // 断言保护的是一个真实的仪器宽松处, 不是一条空规则。
    assertTrue(XLANG_MARK.test('你要是有心就现在办，要是没心就别管。'),
      '前提失效: 「别管」应命中跨语言注入模式的前两类, 否则本轮的换样本理由不成立');
    assertEqual((gate.checkOutput('你要是有心就现在办，要是没心就别管。').findings || [])
      .map(f => f.dimension).join(','), 'double_bind',
      '前提: 那句含「别管」的句子在全模式下不应被判成注入(findings 只有 double_bind)');
    // 反向对照: 副本本身没坏 —— 其余读数在副本上必须仍然自洽
    let miss = 0;
    for (const t of mal2) if (gate.checkOutput(t).gate.action === 'pass') miss++;
    assertEqual(miss, 0, '反向对照: 副本删掉 4 条后, 剩下 64 条仍应全拦(否则副本坏了)');
    console.log(`     副本: 触达 ${reached2.size}/54, MALICIOUS ${mal2.length}, 64 条仍全拦; `
      + `副本上未触达 ${un2.length} 个里 REWRITE 级 ${rw2.length} 个`);
  });

  // ─── ⑦ 披露: 29 个仍未触达, 且理由是算术而非类比 ──────────────
  test('披露: 其余 29 个仍未触达, 其不可入性是算术论证; 交接给下一轮', () => {
    // 文档必须仍披露"有盲区", 且披露的触达数必须等于实测
    const agents = fs.readFileSync(AGENTS, 'utf8');
    const docM = agents.match(/维度触达\s*(\d+)\s*\/\s*54/);
    assertTrue(docM !== null, 'AGENTS.md 里找不到触达面披露');
    const reached = reachedDims(MAL.concat(BEN));
    assertEqual(parseInt(docM[1], 10), reached.size,
      `AGENTS.md 写触达 ${docM[1]}/54, 实测 ${reached.size}/54 —— 本轮补了 4 条样本, `
      + '文档的触达数与语料规模必须同步');
    const sizeM = agents.match(/语料\s*规模\s*(\d+)\s*条/);
    assertTrue(sizeM !== null, 'AGENTS.md 里找不到"语料规模 N 条"');
    assertEqual(parseInt(sizeM[1], 10), MAL.length + BEN.length,
      `AGENTS.md 写语料规模 ${sizeM[1]} 条, 实测 ${MAL.length + BEN.length} 条`);
    // 未触达数仍是 29(不是 31) —— 这是本轮唯一的数字变化, 必须被写下来
    assertEqual(54 - reached.size, 29, '未触达维度应 29 个');
    const un = Object.keys(idx.discriminate('测试', []).dimensions || {}).filter(k => !reached.has(k));
    const vfN = un.filter(k => { const g = gateNameOf(k); return g && VERIFY_DIMS.has(g); }).length;
    // 交接: 那 29 个不是"没人管", 是结构上进不来; 唯一能让它们进来的路是
    // 语料多一个"verify 级恶意"的格子, 那是产品判断, 不是本轮的最小变更。
    console.log(`     披露在册: 触达 ${reached.size}/54, 语料 ${MAL.length + BEN.length} 条, `
      + `未触达 ${un.length} 个(VERIFY ${vfN} + 无层级集 ${un.length - vfN})`);
  });
};
