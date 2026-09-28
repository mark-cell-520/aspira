/**
 * test/module-field-consumer-audit.test.js — 哨兵法及其局限
 *
 * ═══ 哨兵法是什么 ═══
 * 差分法(passthrough-field-audit.js)对语义类模块失效:
 * 通用合成文本命中不了模块的模式 → 差分恒等 → 假阳性。
 * 本轮改用**哨兵**: 给每个候选字段一个独一无二的值
 * (`__ASPIRA_SENTINEL_<field>__`)，调用后在输出里递归搜它。
 * 出现了 → 该字段的值穿透到了输出 → 被消费。
 *
 * ═══ 本轮实测结论 ═══
 * 覆盖 84 个工具，**「底层消费了 schema 未声明的字段」= 0 处**。
 * 这是个有价值的负面结论: cycle-33 抓到 consciousness(少 priors/
 * sensoryInput/self) 与 retention_log(少 actor) 两个真缺陷的那个形态，
 * 在剩余工具里没有同类。也就是说那类"补声明"的缺口已补齐。
 *
 * ═══ 哨兵法自身的两个局限(必须钉住，否则又成仪器误报) ═══
 *  ① **只发现"值穿透到输出"的消费。** 字段被读后若仅用于内部判断
 *     (分类/分支/阈值)，哨兵不会出现在输出里，于是被误报为"未消费"。
 *     实测 aspira_classics.text: 哨兵串不含古典关键词 →
 *     classicalRelevant=false、hits=[]、哨兵未现 → 看似死参数。
 *     改用真实古典文本"道可道非常道…" → classicalRelevant=True、
 *     domain=daoist-naturalness，**text 参数完全生效**。
 *     (第 21 次仪器误报，同一个家族的第 21 次。)
 *  ② **多层转发看不见。** aspira_classics 的 handler 把 text 交给
 *     classics-value-mapper，后者原样转发给 classics-rules 的 evaluateRules。
 *     哨兵法只看到最外层返回值，中间的转发链对它不透明。
 *
 * ═══ 本测试的作用 ═══
 * 锁住"0 处未声明字段"这个结论的**判据**，并钉住局限①的实测样例，
 * 使将来若有人把哨兵法的"未消费"清单当缺陷目录，测试会失败。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));

module.exports = function ({ test, assertEqual, assertTrue }) {

  // ─── 哨兵法脚本必须自带局限声明 ─────────────────────────────────
  test('哨兵审计脚本必须声明局限且不把未消费当失败', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'module-field-consumer-audit.js'), 'utf8');
    assertTrue(/不是死参数清单/.test(src),
      '脚本必须显式声明"哨兵未出现"不是死参数清单');
    assertTrue(/仅用于内部判断|内部判断/.test(src),
      '脚本必须写明局限: 字段可能被读后仅用于内部判断，不进输出');
    assertTrue(/process\.exit\(0\)/.test(src),
      '脚本不得因存在可疑项而失败退出');
  });

  // ─── 局限①实测: classics.text 需要符合其检索目标的探针 ──────────
  test('局限①实测: classics.text 的哨兵不现，但真实古典文本可命中', () => {
    const { evaluateRules } = require(path.join(ROOT, 'src', 'knowledge', 'classics-value-mapper.js'));
    // 哨兵串(不含任何古典关键词) → 不命中
    const sentinel = evaluateRules('__ASPIRA_SENTINEL_text__');
    assertEqual(sentinel.classicalRelevant, false,
      '哨兵串不含古典关键词，故 classicalRelevant=false —— 这是判据失效的形态，不是参数失效');
    // 真实古典文本 → 命中
    const real = evaluateRules('道可道非常道，上善若水，水善利万物而不争');
    assertEqual(real.classicalRelevant, true,
      '同一函数在真实古典文本上必须命中 —— 证明 text 参数确实被消费');
    assertTrue(real.domain !== null && real.domain !== undefined,
      `命中时 domain 应有值(实测 ${JSON.stringify(real.domain)})`);
  });

  // ─── 局限②实测: 多层转发确实把参数送到了底层 ───────────────────
  test('局限②实测: classics 经两层转发仍把 text 送到 evaluateRules', () => {
    // handler → classics-value-mapper.evaluateRules → classics-rules.evaluateRules
    // 哨兵法看不见这条链，故直接验证底层收到了同一个值。
    const mapper = require(path.join(ROOT, 'src', 'knowledge', 'classics-value-mapper.js'));
    const rules = require(path.join(ROOT, 'src', 'knowledge', 'classics-rules.js'));
    assertEqual(typeof mapper.evaluateRules, 'function', 'mapper 应导出 evaluateRules');
    assertEqual(typeof rules.evaluateRules, 'function', 'rules 应导出 evaluateRules');
    const probe = '道可道非常道';
    // 两个入口应给出一致结果(证明 mapper 是原样转发，没有第二套实现)
    assertEqual(JSON.stringify(mapper.evaluateRules(probe)), JSON.stringify(rules.evaluateRules(probe)),
      'mapper 与 rules 的 evaluateRules 应给出一致结果 —— 证明转发未改写参数');
  });

  // ─── 「未声明字段」判据: 全仓 schema 参数名必须都在合法集合内 ─────
  test('schema 参数名集合可被哨兵法枚举(判据可复现)', () => {
    // 哨兵法依赖"全仓参数名"作为候选池。若 registry 结构变化
    // (如 inputSchema.properties 不再是对象)，哨兵法会静默失效。
    let total = 0;
    for (const t of TOOLS) {
      const p = (t.inputSchema && t.inputSchema.properties) || {};
      assertTrue(typeof p === 'object' && p !== null, `${t.name} 的 inputSchema.properties 应为对象`);
      total += Object.keys(p).length;
    }
    assertTrue(total > 100,
      `全仓参数名总数应 >100(实测 ${total})，否则候选池过小、哨兵法失去覆盖力`);
  });
};
