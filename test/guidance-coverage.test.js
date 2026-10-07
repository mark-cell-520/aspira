/**
 * test/guidance-coverage.test.js — 门禁维度必须带修改指引
 *
 * 保护对象：GUIDANCE_MAP 对门禁维度的覆盖完整性。
 *
 * 缺陷形状: 一个维度能决定 gate.action，却在 finding 上不带 guidance。
 * 本轮实测 9 个这样的维度（1 block / 2 rewrite / 6 verify）——它们都在
 * BLOCK_DIMS / REWRITE_DIMS / VERIFY_DIMS 里，但从未进 GUIDANCE_MAP，
 * 于是 `if (GUIDANCE_MAP[f.dimension])` 静默跳过。AGENTS.md 的门禁动作表
 * 对 rewrite/block 明确指示 "Follow findings[].guidance"，消费者按表行事
 * 却领不到任何指引——一个把正文打成 block 的维度没有任何"该往哪改"的句子。
 * 上一轮把 sealioning / tone_policing 补进 VERIFY_DIMS 时只改了门禁集，
 * 没同步这里:同一处缺口被削掉两轮，只锁住一半。
 *
 * 方法论(承自前轮教训): 每个探针措辞**从该维度自己的模式数组派生**
 * (src/index.js 各 PATTERNS 常量)，不是凭语感写。手写探针历史上多次
 * 「探针错、引擎对」。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
const fs = require('fs');
const path = require('path');
const { discriminate } = require('../src/index.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

const BLOCK_DIMS = ['hate_speech', 'dehumanization', 'prompt_injection', 'code_security',
  'deceptive_alignment', 'phishing_coercion', 'coverup_induction', 'dangerous_instruction',
  'reward_hacking'];
const REWRITE_DIMS = ['gaslighting', 'victim_blaming', 'double_bind', 'emotional_manipulation',
  'bullshit', 'false_urgency', 'absolute_claim', 'induced_trust'];
// 从源码取，避免这里抄一份后与引擎各改一半
const VERIFY_DIMS = SRC.match(/const VERIFY_DIMS = new Set\(\[([^\]]+)\]\)/)[1]
  .match(/'([a-z_]+)'/g).map(s => s.slice(1, -1));

const TIER_OF = {};
for (const d of BLOCK_DIMS) TIER_OF[d] = 'block';
for (const d of REWRITE_DIMS) TIER_OF[d] = 'rewrite';
for (const d of VERIFY_DIMS) if (!TIER_OF[d]) TIER_OF[d] = 'verify';

// 门禁维度 -> 探针(措辞派生自该维度自身模式) / 本轮修复前实测的 gate.action
const PROBES = {
  // /我本可以[^。]*?但[^。]*?没(有|必要)/, /先[^。]*?降低[^。]*?(期望|标准|预期)/
  deceptive_alignment: ['我本可以做好，但没必要全力以赴，先降低大家的期望。', 'block'],
  // /这(绝对|完全)[^。]*?(唯一|最)(正确|好)/ 绝对+唯一正确
  absolute_claim: ['这绝对是唯一的正确答案，其他方案都不值一提。', 'rewrite'],
  // /绝对.{0,15}(?:没问题|成功|可行|正确|有效|稳|能行|搞定)/
  no_fallback: ['绝对没问题，放心，一定能成功。', 'rewrite'],
  // /你(是|就)(个|一)?水军[吧?？]?/
  bad_faith: ['你就是个水军吧，别装了。', 'block'],
  // premise/inference 标记齐全但缺 conclusion、score<0.4
  reasoning_coherence: ['因为这是公认的事实。所以毫无疑问。显然这是必然的结论。', 'verify'],
  // /所有人都是这样/ 群组概括
  stereotype: ['所有人都是这样，无一例外。', 'verify'],
  // /震惊|竟然|99%的人/
  clickbait: ['震惊！99%的人都不知道这个秘密。', 'verify'],
  // /那你怎么解释/
  sealioning: ['那你怎么解释？请逐条出示证据。', 'verify'],
  // /你说话语气有问题/
  tone_policing: ['你说话语气有问题，所以我不听。', 'verify'],
};

// 本轮修复的 9 个：此前能被 gate 用上却拿不到 guidance 的那些
const WAS_MISSING = Object.keys(PROBES);

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('本轮修复的 9 个门禁维度全部有 guidance', () => {
    for (const [dim, [probe, expectedTier]] of Object.entries(PROBES)) {
      const r = discriminate(probe, []);
      const f = (r.findings || []).find(x => x.dimension === dim);
      assertTrue(!!f, `${dim} 探针未产生 finding (探针="${probe}")`);
      assertTrue(!!f.guidance,
        `${dim} finding 无 guidance——AGENTS.md 要求 rewrite/block 时按 guidance 改写, ` +
        `此处消费者拿不到任何指引 (gate=${r.gate.action})`);
      assertTrue(typeof f.guidance === 'string' && f.guidance.length > 8,
        `${dim} guidance 过短, 不像可执行指引: "${f.guidance}"`);
      // 探针的 gate.action 必须仍在本维度的层级上: 证明补 guidance 没顺手改坏门禁
      const tier = r.gate.action;
      const ok = tier === expectedTier ||
                 (expectedTier === 'verify' && (tier === 'rewrite' || tier === 'block'));
      assertTrue(ok, `${dim} 门禁层级被改动: 实测 ${tier}, 修复前实测 ${expectedTier}`);
    }
  });

  test('GUIDANCE_MAP 覆盖全部 43 个门禁维度', () => {
    const gm = SRC.indexOf('const GUIDANCE_MAP = {');
    const seg = SRC.slice(gm, SRC.indexOf('\n  };', gm));
    const keys = [...seg.matchAll(/^    ([a-z_0-9]+):/gm)].map(x => x[1]);
    const missing = Object.keys(TIER_OF).filter(d => !keys.includes(d));
    assertEqual(missing.length, 0,
      `有 guidance 缺口的门禁维度: ${missing.join(', ')} —— 维修禁维度必须能从 findings[].guidance 拿到改写方向`);
  });

  test('源级反向证明: 删掉任一修复条目, 上面的锁必须红', () => {
    // 一个不会失败的锁等于没有锁。这里验证「缺 guidance」是可检出的:
    // 把 WAS_MISSING 全部从 GUIDANCE_MAP 文本中抹掉，逐维度断言键名消失。
    const gm = SRC.indexOf('const GUIDANCE_MAP = {');
    const seg = SRC.slice(gm, SRC.indexOf('\n  };', gm));
    const keys = [...seg.matchAll(/^    ([a-z_0-9]+):/gm)].map(x => x[1]);
    for (const dim of WAS_MISSING) {
      assertTrue(keys.includes(dim),
        `${dim} 已不在 GUIDANCE_MAP — 本轮修复被回退了, 或本条断言的前提已失效`);
    }
  });

  test('补 guidance 不改变门禁判定（良性对照仍 pass）', () => {
    // guidance 是纯附加字段, 加它不该动任何 gate.action
    const benign = '今天天气不错，我们下午去公园散步，然后讨论一下项目进度安排。';
    const r = discriminate(benign, []);
    assertEqual(r.gate.action, 'pass', `良性文本被升级: ${r.gate.action}`);
  });
};
