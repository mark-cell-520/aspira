/**
 * test/knowledge/classics-value-mapper.test.js
 *
 * [第十四周修复] 这个文件此前是**双重静默**的:
 *   1. 它声明了 mount 签名 `module.exports = function({ test })`, 却在 CORE_TESTS 里
 *      被裸 `node` 运行——export 永不被调用, 11 个用例一次都没跑;
 *   2. 即使被调用, 它也从不使用注入的 `test`, 而是自建 cases 数组自己循环,
 *      打印 `classics-value-mapper: 11 cases passed`——这行既不含"通过"也不含"失败",
 *      run-all 的 `emitResult` 匹配不到汇总行, 于是计 0 个用例、也不计失败。
 *   一个用例存在、被遍历、然后从总数里消失, 而且没有任何东西会响。
 *
 * 现在直接调用注入的 `test(name, fn)`: 用例数进入 run-all 总数,
 * 失败也会以 `✗` 出现在输出里, 而不是只写在一行自定义文本中。
 */
const {
  evaluate,
  evaluateRules,
  searchClassicsBatch,
  parseHit,
  matchDomain,
  searchClassics,
  mapToDimensions,
  evaluateWithClassics,
  CLASSICAL_RULES,
  DOMAIN_RULES
} = require('../../src/knowledge/classics-value-mapper');

module.exports = function ({ test }) {
  test('matchDomain detects confucian governance', () => {
    const r = matchDomain('为政以德');
    if (!r || r.id !== 'confucian-governance') throw new Error('expected confucian-governance');
  });

  test('matchDomain detects buddhist suffering', () => {
    const r = matchDomain('苦集灭道');
    if (!r || r.id !== 'buddhist-suffering') throw new Error('expected buddhist-suffering');
  });

  test('matchDomain returns null for non-classics', () => {
    const r = matchDomain('deploy kubernetes cluster');
    if (r) throw new Error('expected null for non-classics');
  });

  test('evaluateRules returns structured result with confucian claim', () => {
    const out = evaluateRules('省刑罚，薄税敛，深耕易耨，壮者以暇日修其孝悌忠信。');
    if (!out.classicalRelevant) throw new Error('expected classicalRelevant=true');
    if (!Array.isArray(out.findings)) throw new Error('findings should be array');
  });

  test('searchClassicsBatch returns hits', () => {
    const out = searchClassicsBatch(['仁政', '孝悌'], '儒藏/四书');
    if (!Array.isArray(out.hits)) throw new Error('hits should be array');
    if (out.keywords.length < 2) throw new Error('keywords length');
  });

  test('parseHit parses file:line:raw', () => {
    const p = parseHit('/data/daizhigev20/儒藏/四书/论语集解义疏.txt:60:子曰');
    if (p.file !== '/data/daizhigev20/儒藏/四书/论语集解义疏.txt') throw new Error('file');
    if (p.line !== 60) throw new Error('line');
    if (!p.raw.startsWith('子曰')) throw new Error('raw');
  });

  // [第十四周修复] 这一条原来的期望是错的: 它断言 `parseHit('no-colon-here').file`
  // 必须为真，而 parseHit 对不可解析输入的契约是**降级返回**
  // `{ file: null, line: null, raw }`(见 src/knowledge/classics-rules.js:1033)。
  // 原断言在文件从未被执行的前提下一直是"绿"的——它一次都没跑过。
  // 现在断言真实的契约: 不抛错，且降级形状可预测。
  test('parseHit tolerates null/number/unparsable', () => {
    if (parseHit(null) !== null) throw new Error('null');
    if (parseHit(123) !== null) throw new Error('number');
    const p = parseHit('no-colon-here');
    if (p === null) throw new Error('unparsable 应降级返回对象，不是 null');
    if (p.file !== null) throw new Error('unparsable 时 file 应为 null');
    if (p.line !== null) throw new Error('unparsable 时 line 应为 null');
    if (p.raw !== 'no-colon-here') throw new Error('unparsable 时 raw 应原样保留');
  });

  test('evaluateWithClassics alias works', () => {
    const out = evaluateWithClassics('老吾老以及人之老，幼吾幼以及人之幼。');
    if (!out.classicalRelevant) throw new Error('expected classicalRelevant');
  });

  test('DOMAIN_RULES covers major subdirs', () => {
    const ids = DOMAIN_RULES.map(r => r.id);
    const required = [
      'confucian-governance','buddhist-suffering','justice-and-fate',
      'confucian-xiaojing','confucian-mengxue','confucian-xiushen',
      'confucian-jingxue','confucian-yuejing','confucian-xiaoxue',
      'buddhist-qianlong','buddhist-jiaxing','buddhist-xuzang','buddhist-cangwai'
    ];
    for (const id of required) { if (!ids.includes(id)) throw new Error(`missing ${id}`); }
  });

  test('CLASSICAL_RULES count >= 20', () => {
    if (CLASSICAL_RULES.length < 20) throw new Error(`got ${CLASSICAL_RULES.length}`);
  });
};
