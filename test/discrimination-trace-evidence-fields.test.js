'use strict';
/**
 * discrimination-trace 证据字段名与维度别名的契约测试
 *
 * 钉住的缺陷(本轮修复):
 *   1. EVIDENCE_FIELDS 列了 4 个**没有任何维度产出**的字段名
 *      (misses / misalignments / norms / behaviors)外加一个重复的 categories，
 *      同时漏了 5 个维度真实写出的键(failures / flags / markers /
 *      violations / bs)。extractDimensionEvidence 唯一的取数动作是
 *      `dimResult[field]`，读产出侧不写的键恒为 undefined，于是这四个维度
 *      在 findings 里带 count>0、trace 里却写
 *      `note: '该维度未返回命中详情（证据字段为空）'` —— 证据字段并不空，
 *      是消费侧读错了名字，这句 note 反过来成了误导信息。
 *   2. buildTrace 用 `dims[f.dimension]` 连接 findings 与 dimensions{}，
 *      但产出侧两处名字不一致(allDims 的 'bullshit' vs dimensions{} 的
 *      'bullshit_recognition')。全仓只有本文件漏了这层别名 —— dimMap 与
 *      GUIDANCE_MAP 早就补过。后果是 bullshit finding 被
 *      `if (ev.count === 0 && !ev.hasEvidence) continue` 整个丢掉，
 *      trace 与 traceSummary 里连条目都没有。
 *
 * 修前实测(205 条校准语料，仪器同口径):
 *   · bullshit×1 从 trace 消失；sarcasm/privacy_boundary/theory_of_mind/
 *     factual_consistency 的 evidence=[] 且带误导 note。
 * 修后: 上述全部给出真实证据片段。
 */
const path = require('path');
const { loadCorpus } = require('./_corpus-arrays.js');
const idx = require(path.join(__dirname, '..', 'src', 'index.js'));
const trace = require(path.join(__dirname, '..', 'src', 'discrimination-trace.js'));

// 每个维度一条能触发 finding 的样本(本轮实测, findings 里确有该维度)
const SAMPLES = {
  theory_of_mind: '你应该知道这件事，大家又不是不明白，这还用问吗',
  factual_consistency: '众所周知，大量研究表明多项研究显示长期以来被视为真理',
  sarcasm: '这个方案「真好」，真是太棒了，聪明，了不起，厉害',
  privacy_boundary: '你结婚了吗？你收入多少？你体重多少？',
  bullshit: '赋能 闭环 底层逻辑 颗粒度 打透 降维打击 认知升级',
};

module.exports = function ({ test, assertEqual, assertTrue }) {
  test('EVIDENCE_FIELDS 不含死键：每一项至少被一个维度真实产出', () => {
    // 反向守护: 若再把注释里的"看起来该叫什么"塞回表里，这条立刻红。
    const dead = ['misses', 'misalignments', 'norms', 'behaviors'];
    for (const k of dead) {
      assertTrue(!trace.EVIDENCE_FIELDS.includes(k),
        `EVIDENCE_FIELDS 不得包含死键 ${k} —— 没有任何维度返回它`);
    }
    // 重复项同样是死代码(第二个 categories 永远走不到)
    const uniq = new Set(trace.EVIDENCE_FIELDS);
    assertEqual(uniq.size, trace.EVIDENCE_FIELDS.length,
      'EVIDENCE_FIELDS 存在重复条目');
  });

  test('EVIDENCE_FIELDS 覆盖四个维度实测写出的证据键', () => {
    for (const k of ['failures', 'flags', 'markers', 'violations', 'bs']) {
      assertTrue(trace.EVIDENCE_FIELDS.includes(k),
        `EVIDENCE_FIELDS 缺少维度实测写出的键 ${k}`);
    }
  });

  test('五个维度的 trace 条目给出真实证据片段，而不是"证据字段为空"', () => {
    for (const [dim, text] of Object.entries(SAMPLES)) {
      const r = idx.discriminate(text, [], undefined);
      const findings = r.findings || [];
      assertTrue(findings.some(f => f.dimension === dim),
        `${dim} 应出现在 findings 里(样本没触发，这条断言不是恒真的)`);
      const entry = trace.buildTrace(r, {}).find(e => e.dimension === dim);
      assertTrue(!!entry, `${dim} 应出现在 trace 里，实际被整个丢弃`);
      assertTrue(Array.isArray(entry.evidence) && entry.evidence.length > 0,
        `${dim} 的 trace evidence 为空: ${JSON.stringify(entry)}`);
      assertTrue(entry.note === undefined,
        `${dim} 不应带"证据字段为空"的误导 note: ${entry.note}`);
      // count 必须来自维度返回值，不是兜底的 1
      assertTrue(entry.count > 0, `${dim} 的 count 应为正，实际 ${entry.count}`);
    }
  });

  test('bullshit finding 经别名解析进 trace，且 count 是真实命中数', () => {
    const r = idx.discriminate(SAMPLES.bullshit, [], undefined);
    const f = (r.findings || []).find(x => x.dimension === 'bullshit');
    assertTrue(!!f, 'bullshit finding 应存在');
    // dimensions{} 的键是 bullshit_recognition —— 别名解析正是为这一处
    assertTrue(!('bullshit' in (r.dimensions || {})),
      'dimensions{} 不该有 bullshit 键(否则别名解析会被绕过而失效)');
    const entry = trace.buildTrace(r, {}).find(e => e.dimension === 'bullshit');
    assertTrue(!!entry, 'bullshit 应从 trace 里消失(别名解析失效)');
    assertEqual(entry.count, r.dimensions.bullshit_recognition.count,
      `trace 的 count 应等于维度真实命中数，实际 ${entry.count} vs ${r.dimensions.bullshit_recognition.count}`);
    assertTrue(entry.count > 1, `bullshit 命中数应大于 1，实际 ${entry.count}`);
  });

  test('全语料不变量：每条 finding 只要维度有证据数组，trace 就必须带上证据', () => {
    const { ALL } = loadCorpus();
    const evFields = new Set(trace.EVIDENCE_FIELDS);
    // [披露] 已知且**本轮刻意未修**的解析缺口: ai_writing_tell 的 finding 在
    // dimensions{} 里根本没有对应键(该维度由 shield/ai-writing-tell.js 的
    // detect() 产出，index.js 从未把它放进 dimensions{})，所以
    // _resolveDimension 对它必然返回 undefined。补这个键要动 src/index.js，
    // 而 dimensions{} 的键集合被 test/dimension-health.test.js 钉死为 54 个，
    // 并下游牵动 SKILL.md 的维度计数与一批文档数字审计 —— 超出本轮范围。
    // 这里把它显式列出而不是让它静默跳过: 将来若多出新的解析缺口，
    // unresolvable 会多出名字，下面那条断言立刻红。
    const KNOWN_UNRESOLVABLE = new Set(['ai_writing_tell']);
    const unresolvable = new Set();
    let checked = 0;
    for (const text of ALL) {
      const r = idx.discriminate(text, [], undefined);
      const dims = r.dimensions || {};
      const built = trace.buildTrace(r, {});
      const traced = new Set(built.map(e => e.dimension));
      for (const f of r.findings || []) {
        if (f.dimension === 'none') continue;
        const d = trace._resolveDimension(dims, f.dimension);
        const arrs = d ? Object.keys(d).filter(k => Array.isArray(d[k])) : [];
        if (!arrs.length) {
          if (!d) unresolvable.add(f.dimension);
          continue;               // 该维度不返回证据数组，无从断言
        }
        if (!arrs.some(a => evFields.has(a))) continue;  // 名字仍对不上(见 ai_writing_tell)
        checked++;
        assertTrue(traced.has(f.dimension),
          `${f.dimension} 有证据数组却从 trace 消失: ${JSON.stringify(f)}`);
        const entry = built.find(e => e.dimension === f.dimension);
        assertTrue(entry.evidence.length > 0,
          `${f.dimension} 的 trace evidence 为空，而维度返回了 ${arrs.join('/')}`);
        assertTrue(entry.note === undefined,
          `${f.dimension} 带了误导 note: ${entry.note}`);
      }
    }
    assertTrue(checked > 0,
      `全语料没有一条可断言的 finding —— 这条断言变恒真了(语料 ${ALL.length} 条)`);
    const extra = [...unresolvable].filter(k => !KNOWN_UNRESOLVABLE.has(k));
    assertEqual(extra.length, 0,
      `出现新的 findings→dimensions 解析缺口: ${extra.join(', ')}` +
      `(已知: ${[...KNOWN_UNRESOLVABLE].join(', ')})`);
    assertTrue(unresolvable.size > 0,
      '已知缺口 ai_writing_tell 在本语料上没出现 —— 上面的披露断言变成了空转');
  });
};
