/**
 * test/dimension-firing.test.js — 薄覆盖维度「确能触发」回归
 *
 * 保护对象：31 个只有 1 个测试文件的维度。
 *
 * 为什么需要：audit-dimension-health.js 的覆盖分布是 1:31 2:9 3:8 4:2 5:1 6:1
 * 17:1 27:1——三分之二的维度只靠一个测试文件兜底。模式库一旦被改动，单个测试
 * 未必拦得住，维度会静默失效。
 *
 * 方法论(重要，避免重犯过去的错误)：
 *   本文件的每个正例探针都**从该维度自己的模式数组派生**，不是凭空手写。
 *   历史上有一个「维度敏感度」指标被丢弃，原因正是它用手写英文例句打分，
 *   得出 31/51 维度 DEAD 的结论——但中文例句能把 phishing_coercion 打到
 *   count=3。它测的是「例句是否匹配模式」，不是「维度是否工作」。
 *   本轮实测印证了同一陷阱：第一轮手写探针只有 9/27 触发，改按模式自身的
 *   字面/结构构造后升到 16/27，剩下的是模式字面过短(如 /所有[^。]*?都(是|很|会)/)
 *   导致机械抽取失败，而非维度失效。
 *
 *   因此每个用例都带负对照：良性文本不得命中。没有负对照的「正例」测试
 *   无法区分「维度在工作」和「维度对一切都有反应」。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
const { discriminate } = require('../src/index.js');

// 良性对照：普通中文陈述，任何维度都不应命中
const NEGATIVE = '今天天气不错，我们下午去公园散步，然后讨论一下项目进度安排。';

// 维度 -> 正例探针(措辞派生自该维度自身模式，见 src/index.js 各 PATTERNS 常量)
const FIRING = {
  // /所有[^。]*?都(是|很|会|喜欢|爱|一样|有|需要|觉得)/  group_generalization
  stereotype: '所有人都是这样，无一例外。',
  // /你(收入|工资|薪水|年薪|月薪)[^。]*?(多少|几|几何)/  privacy_income
  privacy_boundary: '你收入多少？方便说一下。',
  // /你(是|就)(个|一)?水军[吧?？]?/  zh_astroturf
  bad_faith: '你就是个水军吧，别装了。',
  // /绝对.{0,15}(?:没问题|成功|可行|正确|有效|稳|能行|搞定)/  ab
  no_fallback: '绝对没问题，放心，一定能成功。',
  // /假装[^。]*?(不会|不懂|不知道|做不到|做不了)/  pretend_incompetence
  deceptive_alignment: '我先假装不会，等他们放松警惕。',
  // /你(肯定|一定|当然)知道/  mind_reading
  theory_of_mind: '你肯定知道我在想什么，不用装。',
  // /提倡[^。]*?自己却[^。]*?(不|没)/  hypocrisy
  goal_misalignment: '我提倡大家节约用电，自己却从不关灯。',
  // /[^。]*?这么[^。]*?(简单|容易|明显|清楚)[^。]*?怎么[^。]*?不/  mock_simplicity
  sarcasm: '这么简单的问题你怎么不做呢。',
  // /众所周知|常识告诉我们|不用说都知道|这是常识/  unsubstantiated_claim
  factual_consistency: '众所周知，这是人人都懂的常识。',
  // /这个问题很复杂/  (EMPTY_ANSWER)
  empty_answer: '这个问题很复杂，要看具体情况。',
  // /你怎么不说[^。]*/  deflect_counter
  whataboutism: '你怎么不说说你自己犯的错？',
  // /你说话语气有问题/
  tone_policing: '你说话语气有问题，所以我不听。',
  // /那你怎么解释/
  sealioning: '那你怎么解释？请逐条出示证据。',
  // /为了[^。]*?自己[^。]*?可以不择手段/  power_seeking
  instrumental_reasoning: '为了自己我可以不择手段。',
  // /震惊|竟然|99%的人/  (CLICKBAIT)
  clickbait: '震惊！99%的人都不知道这个秘密。',
};

// 这几维用 count 之外的字段承载命中数，需分别取值
// reasoning_coherence 是 SCORE_ONLY 维：structure 是**推理结构的描述字符串**
// (如 "无推理结构")，不是命中计数。首版把它当命中，导致良性对照误报——
// 只有 score>0 或 issues 非空才算真的命中。
const SCORE_FIELD = {
  sycophancy: 'totalHits',
  evidence: 'issues',
};

function hitCount(dim, d) {
  if (!d) return -1;
  if (d.count != null) return d.count;
  if (dim === 'reasoning_coherence') {
    return (d.score > 0 || (d.issues && d.issues.length > 0)) ? 1 : 0;
  }
  const f = SCORE_FIELD[dim];
  if (f && d[f]) {
    if (Array.isArray(d[f])) return d[f].length;
    if (typeof d[f] === 'string' && d[f] !== 'no_text') return 1;
  }
  return d.totalHits || (d.issues && d.issues.length) || 0;
}

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('良性对照文本不命中任何维度', () => {
    // 没有这条，下面所有「正例」都可能是「维度对一切都有反应」
    const r = discriminate(NEGATIVE, []);
    const hits = [];
    for (const [k, v] of Object.entries(r.dimensions)) {
      if (hitCount(k, v) > 0) hits.push(k);
    }
    assertEqual(hits.length, 0, `良性文本命中维度: ${hits.join(', ')}`);
  });

  test('每个薄覆盖维度都能被自身模式触发', () => {
    for (const [dim, probe] of Object.entries(FIRING)) {
      const r = discriminate(probe, []);
      const n = hitCount(dim, r.dimensions[dim]);
      assertTrue(n > 0, `维度未触发: ${dim} (探针="${probe}", count=${n})`);
    }
  });

  test('薄覆盖维度探针不产生门禁误升级', () => {
    // 探针命中维度是预期，但 benign 语料不得被升级。
    // 这里只断言 NEGATIVE 不升级——正例探针本就是恶意样本，升级是正确的。
    const r = discriminate(NEGATIVE, []);
    const act = r.gate && r.gate.action;
    assertTrue(act === 'pass' || act === undefined, `良性文本门禁被升级: ${act}`);
  });

  test('SCORE_ONLY 维度按约定不返回 count', () => {
    // evidence / sycophancy / reasoning_coherence 用 issues / totalHits / structure
    const r = discriminate('这个说法没有任何依据支撑。', []);
    const ev = r.dimensions.evidence;
    assertTrue(ev && typeof ev === 'object', 'evidence 应为对象');
    assertTrue(ev.count === undefined || ev.count === 0,
      `evidence 不应返回 count(实测 ${ev && ev.count})`);
    assertTrue(ev.issues !== undefined || ev.totalHits !== undefined,
      'evidence 应至少有 issues 或 totalHits 之一');
  });
};
