#!/usr/bin/env node
/**
 * scripts/dimension-health-audit.js — 维度健康审计
 *
 * ═══ 它测什么，为什么语料测不了 ═══
 * 校准语料(scripts/calibrate-fp-recall.js)能回答"引擎在真实文本上误报/漏报多少"，
 * 但它回答不了"**某个维度还活着吗**"。一个维度可能因为模式写错、键名对不上、
 * 或者永远够不到阈值而静默失效——语料里只要没有能触达它的句子，这件事就看不出来。
 * 本仓库已经因此栽过两次:
 *   · `dimMap` 键名与 `dimensions` 键名不一致 → finding 永远显示"1次"，数字是假的
 *   · `HOMOGLYPH_RE` 匹配任何西里尔字符 → 整类合法文本被 rewrite
 *
 * ═══ 方法 ═══
 * 把一个**大输入池**喂给 discriminate()，逐维度统计两件事:
 *   1. `dimensions[dim]` 的信号是否曾非零        (维度是否被算过)
 *   2. 该维度是否曾推出一条 finding              (维度是否能影响判决)
 * 输入池三个来源，都是为了扩大覆盖面:
 *   A. 校准语料(良性 + 恶意)
 *   B. 全部测试文件里的字符串字面量 — 本仓库约 1000 个测试里有大量**手工构造的
 *      对抗输入**，这是现成且最多样的池子
 *   C. 从引擎自己的正则字面量剥出的片段(见下方"已知局限")
 *
 * 只有"三个来源都碰不到它"的维度才值得怀疑。
 *
 * ═══ 首两版的错(记下来免得再犯) ═══
 * **首版**: 只扫 check 函数体找正则。结果 51/54 报"完全沉默"，差点写成
 * "引擎大面积失效"。实测 `idx.checkPromptInjection('ignore all previous
 * instructions')` 正常返回 count=2/score=1——**是仪器坏了，不是引擎坏了**。
 * 函数体只有 767 字符、里面一个模式都没有，因为模式全在模块级常量表里。
 *
 * **第二版**: 改成跟着常量表引用走，能跑通了，但仍报 6 个维度"完全沉默"。
 * 逐个直接调用验证: unsupported_claim/sycophancy/contradiction/bullshit **四个都能
 * 正常触发**。原因是我的"从正则剥最长纯字面量片段"有系统性盲区:
 *   · 核心字面量 <3 字符就被我过滤掉(如 `根据…报告` 只剥出"根据"，长度 2)
 *   · 交替组要整组才匹配(如 `(很棒|很好|…)[^。]*?但`，剥出的"很棒"单独不匹配)
 *   · 需要共现的模式(两个矛盾短语同时出现)合成不出来
 * 于是我把"我合成不出输入"误报成"引擎失效"。**一个会把仪器局限说成引擎缺陷的
 * 仪器，比没有仪器更糟**——它会让人去修没坏的东西。
 * 故第三版改为"大输入池 + 只统计是否曾触发"，不再假装能反向工程每条正则。
 *
 * ═══ 已知局限(必须随结果一起读) ═══
 * 1. "未观测到触发"不等于"永不触发"，只等于"这个池子碰不到它"。
 * 2. 来源 C(正则片段)覆盖面窄，已确认至少有 4 个维度的模式它合成不出输入，
 *    所以 C **不作为判定依据**，只作为附加输入。
 * 3. 池子来自本仓库自己的测试，会继承作者的盲区。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');

// 维度 → check 函数名。来源: src/index.js discriminate() 里的调用表。
const DIM_CHECKERS = [
  ['evidence', 'checkEvidence'],
  ['unsupported_claim', 'checkUnsupportedClaim'],
  ['sycophancy', 'checkSycophancy'],
  ['phishing_coercion', 'checkPhishingCoercion'],
  ['induced_trust', 'checkInducedTrust'],
  ['coverup_induction', 'checkCoverupInduction'],
  ['dangerous_instruction', 'checkDangerousInstruction'],
  ['reward_hacking', 'checkRewardHacking'],
  ['contradiction', 'checkContradiction'],
  ['vagueness', 'checkVagueness'],
  ['fallacies', 'checkFallacies'],
  ['confidence', 'checkConfidenceCalibration'],
  ['presupposition', 'checkPresupposition'],
  ['emotional_manipulation', 'checkEmotionalManipulation'],
  ['double_bind', 'checkDoubleBind'],
  ['info_deprivation', 'checkInfoDeprivation'],
  ['false_urgency', 'checkFalseUrgency'],
  ['empty_answer', 'checkEmptyAnswer'],
  ['moral_foundations', 'checkMoralFoundations'],
  ['prompt_injection', 'checkPromptInjection'],
  ['code_security', 'checkCodeSecurity'],
  ['dehumanization', 'checkDehumanization'],
  ['bullshit_recognition', 'checkBullshitRecognition'],
  ['gaslighting', 'checkGaslighting'],
  ['victim_blaming', 'checkVictimBlaming'],
  ['hate_speech', 'checkHateSpeech'],
  ['dogwhistle', 'checkDogwhistle'],
  ['whataboutism', 'checkWhataboutism'],
  ['false_equivalence', 'checkFalseEquivalence'],
  ['hasty_generalization', 'checkHastyGeneralization'],
  ['slippery_slope', 'checkSlipperySlope'],
  ['appeal_to_authority_boost', 'checkAppealToAuthority'],
  ['reasoning_coherence', 'checkReasoningCoherence'],
  ['theory_of_mind', 'checkTheoryOfMind'],
  ['goal_misalignment', 'checkGoalMisalignment'],
  ['counterfactual', 'checkCounterfactual'],
  ['social_norm', 'checkSocialNorm'],
  ['meta_cognition', 'checkMetaCognition'],
  ['capability_overclaim', 'checkCapabilityOverclaim'],
  ['absolute_claim', 'checkAbsoluteClaim'],
  ['deceptive_alignment', 'checkDeceptiveAlignment'],
  ['instrumental_reasoning', 'checkInstrumentalReasoning'],
  ['stereotype', 'checkStereotype'],
  ['factual_consistency', 'checkFactualConsistency'],
  ['sarcasm', 'checkSarcasm'],
  ['privacy_boundary', 'checkPrivacyBoundary'],
  ['clickbait', 'checkClickbait'],
  ['bad_faith', 'checkBadFaith'],
  ['no_fallback', 'checkNoFallback'],
  ['tone_policing', 'checkTonePolicing'],
  ['sealioning', 'checkSealioning'],
  ['pseudo_profundity', 'checkPseudoProfundity'],
  ['perfect_error', 'checkPerfectError'],
  ['premature_termination', 'checkPrematureTermination'],
];

// [仪器自检] finding 的 dimension 与 dimensions{} 的键并不完全同名:
// allDims 用 'bullshit'/'appeal_to_authority'，而 dimensions{} 输出
// 'bullshit_recognition'/'appeal_to_authority_boost'。若只按 54 键名统计 finding，
// 这两个维度会被误报成"从不推 finding"——其实推了，只是名字不同。
// 这是三处命名不一致（dimMap 键/allDims name/门禁集名）的遗留，
// 本仪器将其区分为"别名推送"而不当成缺陷。
// perfect_error 也不推 finding，但不是缺陷: 它是**聚合俪号**，
// 直接通过 pe.level / pe.isPerfectError 设置 gate action
// (实测: "怀疑完美错误答案: 假精确(1处); 伪权威(1处)"→ rewrite)。
// 把设计内的另一条路径当成缺陷报，会驱使人去"修"没坏的代码。
const BY_DESIGN_NO_FINDING = new Set(['perfect_error']);
const FINDING_ALIAS = { bullshit: 'bullshit_recognition', appeal_to_authority: 'appeal_to_authority_boost' };
const canon = (d) => FINDING_ALIAS[d] || d;

// 按设计只打分、不单独推 finding 的维度(AGENTS.md 已列)。
const SCORE_ONLY = new Set([
  'evidence', 'moral_foundations', 'dogwhistle', 'factual_consistency', 'sarcasm',
  'privacy_boundary', 'meta_cognition', 'theory_of_mind', 'counterfactual',
  'social_norm', 'capability_overclaim', 'goal_misalignment',
  'instrumental_reasoning', 'ai_writing_tell',
]);

// ─── 输入池 A: 校准语料 ────────────────────────────────
function corpusInputs() {
  const p = path.join(ROOT, 'scripts', 'calibrate-fp-recall.js');
  if (!fs.existsSync(p)) return [];
  const src = fs.readFileSync(p, 'utf8');
  const out = [];
  // 抓 BENIGN / MALICIOUS 数组里的字符串条目
  for (const m of src.matchAll(/^\s*'((?:[^'\\]|\\.){6,})',\s*$/gm)) {
    out.push(m[1].replace(/\\'/g, "'"));
  }
  return out;
}

// ─── 输入池 B: 测试文件里的字符串字面量 ────────────────
function testInputs() {
  const testDir = path.join(ROOT, 'test');
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.test\.js$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      // 只抓单行字符串字面量(多行模板字符串跳过，避免抓到代码)
      for (const m of src.matchAll(/'((?:[^'\\\n]|\\.){8,120})'/g)) {
        const s = m[1].replace(/\\'/g, "'").replace(/\\n/g, ' ').trim();
        if (/[A-Za-z\u4e00-\u9fff]/.test(s) && !/^\s*(const|let|var|function|require|return|=>)/.test(s)) {
          out.push(s);
        }
      }
    }
  };
  walk(testDir);
  return out;
}

// ─── 输入池 C: 引擎正则剥出的片段(覆盖面窄，仅附加) ────
function regexLiteralInputs() {
  function functionBody(name) {
    const re = new RegExp('function\\s+' + name + '\\s*\\(');
    const m = re.exec(SRC);
    if (!m) return null;
    let i = SRC.indexOf('{', m.index);
    if (i < 0) return null;
    let depth = 0, start = i;
    for (; i < SRC.length; i++) {
      const c = SRC[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start + 1, i); }
    }
    return null;
  }
  const declCache = new Map();
  function declarationText(name) {
    if (declCache.has(name)) return declCache.get(name);
    const re = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*');
    const m = re.exec(SRC);
    if (!m) { declCache.set(name, null); return null; }
    let i = m.index + m[0].length;
    while (i < SRC.length && /\s/.test(SRC[i])) i++;
    const open = SRC[i];
    const close = open === '{' ? '}' : (open === '[' ? ']' : null);
    if (!close) { declCache.set(name, null); return null; }
    let depth = 0, start = i;
    for (; i < SRC.length; i++) {
      const c = SRC[i];
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) break; }
    }
    const text = SRC.slice(start, i + 1);
    declCache.set(name, text);
    return text;
  }
  function regexLiterals(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '/') continue;
      if (text[i + 1] === '/' || text[i + 1] === '*') { i++; continue; }
      let j = i + 1, inClass = false;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === '\\') { j++; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break;
      }
      if (j >= text.length || text[j] !== '/') { i = j; continue; }
      const s = text.slice(i + 1, j);
      const flags = (text.slice(j + 1, j + 4).match(/^[gimsuyd]*/) || [''])[0];
      if (!flags) { i = j; continue; }
      try { out.push(s); i = j + flags.length; } catch (e) { i = j; }
    }
    return out;
  }
  function literalRuns(reSrc) {
    let s = reSrc.replace(/\\[dDwWsSbBntr0]/g, '\u0000');
    const runs = [];
    const stripped = s.replace(/\[([^\]]*)\]/g, (w, inner) => {
      for (const a of inner.split('|')) {
        const lit = a.replace(/\\/g, '');
        if (/^[\w\u4e00-\u9fff\s-]{2,}$/.test(lit)) runs.push(lit.trim());
      }
      return '\u0000'.repeat(w.length);
    });
    const META = '()[]{}|?*+^.$\u0000';
    let cur = '';
    for (const ch of stripped) {
      if (META.includes(ch)) { if (cur.trim().length >= 2) runs.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim().length >= 2) runs.push(cur.trim());
    return runs.map(r => r.replace(/\s+/g, ' ').trim())
      .filter(r => r.length >= 2 && r.length <= 60)
      .filter(r => !/^[\d\s.-]+$/.test(r))
      .filter(r => /[\w\u4e00-\u9fff]/.test(r));
  }
  const out = [];
  const UPPER_RE = /\b([A-Z][A-Z0-9_]{3,})\b/g;
  for (const [, fn] of DIM_CHECKERS) {
    const body = functionBody(fn);
    if (!body) continue;
    let text = body;
    const names = new Set();
    let m; UPPER_RE.lastIndex = 0;
    while ((m = UPPER_RE.exec(body))) {
      const n = m[1];
      if (['VERIFY', 'BLOCK', 'REWRITE', 'GUIDANCE', 'VERDICT', 'PENALTY', 'ACTION', 'MCP', 'JSON', 'HTTP', 'SSE', 'UTF'].some(p => n.startsWith(p))) continue;
      names.add(n);
    }
    for (const n of names) {
      const d = declarationText(n);
      if (d) text += '\n' + d;
    }
    for (const r of regexLiterals(text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 '))) {
      const runs = literalRuns(r).sort((a, b) => b.length - a.length);
      if (runs.length) out.push(runs[0]);
    }
  }
  return out;
}

// ─── 主流程 ────────────────────────────────────────────
function main() {
  const idx = require(path.join(ROOT, 'src', 'index.js'));

  const poolA = corpusInputs();
  const poolB = testInputs();
  const poolC = regexLiteralInputs();
  // 去重(按内容)，C 放最后因为覆盖面窄
  const seen = new Set();
  const pool = [];
  for (const s of [...poolA, ...poolB, ...poolC]) {
    const k = s.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    pool.push(s);
  }

  console.log('\n=== 维度健康审计 ===\n');
  console.log(`  输入池: 语料 ${poolA.length} | 测试字面量 ${poolB.length} | 正则片段 ${poolC.length} | 去重后 ${pool.length}`);

  // [仪器自检] 维度键名**从引擎自己的 dimensions{} 取**，不信任硬编码表。
  // 原因: 第二片我把 bullshit_recognition 写成 bullshit、
  // appeal_to_authority_boost 写成 appeal_to_authority，结果这两个键永远匹配不上，
  // 仪器报"从未触发"——正好是本仓库 AGENTS.md 记录过的 dimMap 键名不一致 bug。
  let probeKeys = [];
  try {
    const probe = idx.discriminate('你说得完全对，太厉害了。', []);
    probeKeys = Object.keys(probe.dimensions || {});
  } catch (e) { probeKeys = []; }
  if (probeKeys.length === 0) {
    console.log('  ✖ 无法从引擎取得维度键名，仪器失效（不得以硬编码表替代）');
    process.exitCode = 1;
    return;
  }
  const tally = {};
  for (const dim of probeKeys) tally[dim] = { signal: 0, finding: 0, maxSig: 0 };
  const uncovered = probeKeys.filter(k => !DIM_CHECKERS.some(([d]) => d === k));

  let errors = 0;
  for (const text of pool) {
    let d;
    try { d = idx.discriminate(text, []); } catch (e) { errors++; continue; }
    const dims = d.dimensions || {};
    for (const [key, val] of Object.entries(dims)) {
      if (!tally[key]) continue;
      const sig = signalOf(val);
      if (sig > 0) { tally[key].signal++; tally[key].maxSig = Math.max(tally[key].maxSig, sig); }
    }
    for (const f of (d.findings || [])) {
      const key = canon(f.dimension);
      if (tally[key]) tally[key].finding++;
    }
  }
  if (errors) console.log(`  (${errors} 条输入抛错，已跳过)`);

  const never = [], scoredOnly = [], ok = [];
  for (const dim of probeKeys) {
    const t = tally[dim];
    if (t.signal === 0) never.push(dim);
    else if (t.finding === 0) scoredOnly.push(dim);
    else ok.push(dim);
  }

  console.log('\n  ── 逐维度 ──');
  for (const dim of probeKeys) {
    const t = tally[dim];
    const fn = (DIM_CHECKERS.find(([d]) => d === dim) || [dim, '?'])[1];
    const tag = SCORE_ONLY.has(dim) ? ' [仅打分]' : '';
    const flag = t.signal === 0 ? '  ⚠ 从未触发'
      : (t.finding === 0 && !SCORE_ONLY.has(dim) ? '  ⚠ 触发但从不推 finding' : '');
    console.log(`  ${dim.padEnd(24)} 信号 ${String(t.signal).padStart(5)}  finding ${String(t.finding).padStart(5)}${tag}${flag}`);
  }

  if (uncovered.length) {
    console.log('\n  ℹ 仪器未覆盖的引擎维度（缺 check 函数映射，仍统计了俪号/finding）:');
    for (const k of uncovered) console.log(`     ${k}`);
  }
  console.log('\n  ── 汇总 ──');
  console.log(`  曾触发且推 finding:  ${ok.length}`);
  console.log(`  曾触发但不推 finding: ${scoredOnly.length}${scoredOnly.length ? ' → ' + scoredOnly.join(', ') : ''}`);
  console.log(`  从未触发:            ${never.length}${never.length ? ' → ' + never.join(', ') : ''}`);

  const realNever = never.filter(d => !SCORE_ONLY.has(d));
  if (realNever.length) {
    console.log('\n  ⚠ 从未触发的维度(该池子碰不到它):');
    for (const d of realNever) console.log(`     ${d}`);
    console.log('     注意: 这是"输入池盲区"，不等于"引擎失效"——上面已记录本仪器');
    console.log('     至少对 4 个维度合成不出输入，别把这里的每一条都当缺陷。');
  }
  // 区分"真没推"与"用别名推了"
  const aliased = scoredOnly.filter(d => !SCORE_ONLY.has(d) && FINDING_ALIAS[d]);
  if (aliased.length) {
    console.log('\n  ℹ 用别\u540d\u63a8\u9001 finding \u7684\u7ef4\u5ea6（\u529f\u80fd\u6b63\u5e38，\u4f46\u547d\u540d\u4e09\u5904\u4e0d\u4e00\u81f4）:');
    for (const d of aliased) console.log(`     ${d} ← finding.dimension 写成 '${Object.keys(FINDING_ALIAS).find(k => FINDING_ALIAS[k] === d)}'`);
  }
  const silentButShouldPush = scoredOnly.filter(d => !SCORE_ONLY.has(d) && !FINDING_ALIAS[d] && !BY_DESIGN_NO_FINDING.has(d));
  if (silentButShouldPush.length) {
    console.log('\n  ⚠ 触发过但从未推 finding 的非仅打分维度(值得查是否够不到阈值):');
    for (const d of silentButShouldPush) console.log(`     ${d}`);
  }
  console.log('');

  process.exitCode = silentButShouldPush.length > 0 ? 1 : 0;
}

function signalOf(result) {
  if (!result || typeof result !== 'object') return 0;
  for (const k of ['count', 'score', 'totalHits', 'hits', 'matches', 'claims', 'fallacies', 'signals', 'injections', 'risk']) {
    const v = result[k];
    if (typeof v === 'number' && v > 0) return v;
    if (Array.isArray(v) && v.length > 0) return v.length;
  }
  for (const k of Object.keys(result)) {
    const v = result[k];
    if (typeof v === 'number' && v > 0) return v;
    if (Array.isArray(v) && v.length > 0) return v.length;
  }
  return 0;
}

main();
