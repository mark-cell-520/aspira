/**
 * test/outbound-pii-no-phantom.test.js
 *
 * ═══ 由来(第十七轮, mcp-tool-enhancement 切片) ═══
 * 本周期的测法是**真的调用全部 181 个 MCP handler**，而不是只做静态清点。
 * 静态清点(约定 #3 的三处一致 + 工具/处理器互覆盖)早已被
 * `test/mcp-tool-integrity.test.js` 锁住，全绿; 但全量调用立刻分出三类:
 *   132 ok / 18 个抛"X 是必填参数"(正确校验) / 31 个 error-obj
 * 其中 29 个 error-obj 也是正确的参数缺失提示，**真正的缺陷只有两个**。
 *
 * 缺陷一(本文件的主角)在 `src/gate-outbound.js` 的 scanPII:
 *     const findings = [
 *       { pattern: /邮箱正则/g, type: 'email', level: '内部' },
 *       { pattern: /\b[4-6]\d{15}\b/g, type: 'credit_card', level: '机密' },
 *       { pattern: /\b[PEG]\d{8}\b/g, type: 'passport', level: '机密' },
 *     ];
 * 这三条是 **pattern 描述对象**，从来没有任何代码用它们去匹配文本，
 * 却被原样塞进 findings 返回。三个后果:
 *   1. 每条都没有 id/name/severity/match/position，JSON.stringify 后是 `{}`
 *      —— 调用方拿到一批**无法据以行动的空对象**;
 *   2. piiFindings.length 恒 >= 3 → checkOutbound 的动作分支里
 *      `piiFindings.length > 0` 恒真 → **action 永远不可能是 'pass'**;
 *   3. 真实命中数被 +3 污染(实测 2 处真实 PII 报成 5 处)。
 *   实测(修复前): '今天天气不错' / 'hello world' / '12345' / '   '
 *   全部判 rewrite，reason 写着"命中 PII 规则 (3 处)"，那 3 处一条也不存在。
 *
 * 一个对任何文本都喊"含 PII"的出域闸门等于没有闸门，而它看起来完全正常——
 * 因为真实 PII 也确实被抓到。**调用成功、不抛异常、返回体结构合法、内容是幽灵。**
 *
 * ═══ 为什么一个测试曾把缺陷锁死 ═══
 * `test/compliance/compliance.test.js` 的 G3-4 断言 `今天天气真好` → rewrite，
 * 注释还写着"实际: 公开内容触发 PII 规则 rewrite（非 bug，是 PII 规则触发）"。
 * 那句话是在**替缺陷辩护**: 作者把幽灵 finding 当成了真实 PII 命中。
 * 与同一文件里 G3-3 的修复是同一个教训——上一次是 forcedLevel 契约不匹配
 * 让密级 block 分支失效，这一次是幽灵 finding 让 pass 分支不可达，
 * 两次都有注释说"这是实际行为，不是 bug"。**测试的期望要跟着设计走。**
 *
 * ═══ 护照为什么被提为正式规则 ═══
 * 三条幽灵规则里，email 与 PII_RULES.EMAIL 正则等价、`\b[4-6]\d{15}\b`
 * 是 PII_RULES.BANK_CARD `\b[1-9]\d{14,18}\b` 的子集——两者都已覆盖，
 * 直接照搬会造成同一跨度被计两次(AGENTS.md 记过这个形状)。
 * 只有护照 `\b[PEG]\d{8}\b` 是真正未被覆盖的一类，故提为 PII_RULES.PASSPORT，
 * 获得与其他规则一致的 id/name/severity 并进入 maskPII 脱敏表。
 */
const path = require('path');
const { checkOutbound } = require(path.join(__dirname, '..', 'src', 'gate-outbound.js'));
const SD = path.join(__dirname, '..', 'src', 'gate-outbound.js');

module.exports = function ({ test, assertEqual, assertTrue, log }) {

  test('scanPII 不得返回缺字段的幽灵 finding', () => {
    // 直接读源码锁形状: findings 必须从空数组开始，不得用 pattern 描述对象初始化。
    // 剥注释——修复说明里引用了被删掉的旧代码，不剥就会把锁自己的说明当罪证。
    const fs = require('fs');
    const code = fs.readFileSync(SD, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const m = code.match(/function scanPII\(text\)\s*\{([\s\S]*?)\n\}/);
    assertTrue(!!m, '应能定位 scanPII 函数体');
    const body = m ? m[1] : '';
    const init = body.match(/const findings\s*=\s*([^;]*);/);
    assertTrue(!!init, '应能定位 findings 的初始化');
    assertEqual(String(init && init[1]).replace(/\s+/g, ' ').trim(), '[]',
      'findings 必须初始化为空数组。若这里又是 pattern 描述对象，'
      + '它们不参与匹配却会被当成发现返回，piiFindings.length 恒 >= 3。');
  });

  test('pass 分支必须可达: 无 PII 的文本不得被判 rewrite/block', () => {
    // 这条比上一条更接近用户可见的后果。
    const clean = ['今天天气不错', 'hello world', '12345', '    ', '一段完全没有个人信息的普通文本'];
    const bad = [];
    for (const t of clean) {
      const r = checkOutbound({ text: t });
      if (r.error) { bad.push(JSON.stringify(t) + ' → error: ' + r.error); continue; }
      if (r.action !== 'pass') bad.push(JSON.stringify(t) + ' → ' + r.action + ' (piiCount=' + r.piiCount + ', reason=' + r.reason + ')');
      else if (r.piiCount !== 0) bad.push(JSON.stringify(t) + ' → pass 但 piiCount=' + r.piiCount);
    }
    assertEqual(bad.join('\n'), '',
      '这些文本不含任何 PII，却被出域闸门拦截:\n' + bad.join('\n'));
  });

  test('piiCount 必须等于真实命中数，不得被虚增', () => {
    // 修复前真实 2 处命中会被报成 5 处(3 个幽灵 + 2 个真实)。
    const cases = [
      { text: '我的手机号是13800138000', expect: 1, ids: ['PHONE'], label: '单个手机号' },
      { text: '邮箱 a@b.com', expect: 1, ids: ['EMAIL'], label: '单个邮箱(曾被幽灵 email 与 PII_RULES.EMAIL 双计)' },
      { text: '护照号 E12345678', expect: 1, ids: ['PASSPORT'], label: '单个护照号' },
      { text: '卡号 6222021234567890123', expect: 1, ids: ['BANK_CARD'], label: '单个银行卡(含曾被幽灵 credit_card 覆盖的 16 位)' },
    ];
    const bad = [];
    for (const c of cases) {
      const r = checkOutbound({ text: c.text });
      const ids = (r.piiFindings || []).map(f => f.id);
      if (r.piiCount !== c.expect) bad.push(c.label + ': piiCount=' + r.piiCount + ' 期望 ' + c.expect + ' ids=' + ids.join(','));
      for (const want of c.ids) if (!ids.includes(want)) bad.push(c.label + ': 缺少 ' + want + ' ids=' + ids.join(','));
    }
    assertEqual(bad.join('\n'), '', 'PII 计数/命中有误:\n' + bad.join('\n'));
  });

  test('每条 finding 都必须有可行动的 id/name/severity', () => {
    // 幽灵 finding 序列化后是 `{}`——没有 id/name/severity，调用方无法据以行动。
    const r = checkOutbound({ text: '手机 13800138000，邮箱 a@b.com，护照 E12345678，卡号 6222021234567890123' });
    const findings = r.piiFindings || [];
    assertTrue(findings.length >= 4, '应至少命中 4 类，实测 ' + findings.length);
    const bad = findings.filter(f => !f.id || !f.name || !f.severity);
    assertEqual(bad.length, 0,
      '这些 finding 缺 id/name/severity(即无法据以行动的空对象):\n' + JSON.stringify(bad));
    assertEqual(r.piiCount, findings.length, 'piiCount 必须与 findings 长度一致');
  });

  test('这把锁本身必须能变红: 幽灵 finding 必须被检出', () => {
    // 与 test/src-syntax-check.test.js 同样的理由: **一个永远通过的检查
    // 与没有检查不可区分。** 这里用同一套判据跑一个已知含幽灵的数组，
    // 证明判据真的会失败，而不是碰巧对当前数据成立。
    const phantom = [
      { pattern: /x/g, type: 'email', level: '内部' },
      { id: 'PHONE', name: '手机号', severity: 'high' },
    ];
    const bad = phantom.filter(f => !f.id || !f.name || !f.severity);
    assertEqual(bad.length, 1,
      '含 1 条幽灵 finding 的数组必须被检出 1 条——若为 0，本测试的判据已失效');
  });
};
