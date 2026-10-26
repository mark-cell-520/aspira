/**
 * test/false-positive-feedback.test.js — 误报反馈闭环回归
 *
 * 保护对象：src/false-positive-feedback.js 与它到 engine / MCP 的接线。
 *
 * 为什么需要：该模块写好后一直**从未被 require**——engine 的
 * introspection.fpFeedbackWired 每个周期都报 false。后果是被 gate 拦
 * (block/rewrite/verify) 的调用方没有任何渠道回报"这是误报"，阈值只能靠
 * 内部样本调；引擎越是孤立，越把内部样本的分布当成全部真相。
 *
 * 本测试锁四件事：
 *   1. engine 真的导出了反馈入口(index.js require 了该模块)
 *   2. report 的参数校验有效(自由文本的 reason 无法聚合，必须拒)
 *   3. suggest 的克制：样本 < 20 时**拒绝给建议**，而不是拍脑袋
 *   4. MCP 侧工具定义、handler、以及参数名对齐(schema 叫 gateAction，
 *      底层 report() 收 action——这个名字差正是最容易静默出错的地方)
 *
 * 数据目录用临时路径：feedback 落盘在 data/ 下(已被 .gitignore 排除)，
 * 测试不得污染真实数据，也不得依赖上一次运行的残留。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require index.js 之前设置：DATA_DIR 在模块加载时求值
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-fp-'));
process.env.HEARTFLOW_FEEDBACK_DIR = TMP_DIR;

const idx = require('../src/index.js');

module.exports = function ({ test, assertEqual, assertTrue, assertDefined }) {

  test('engine 导出误报反馈入口', () => {
    // 接线前这些全是 undefined，调用方拿到的是 TypeError 而非功能
    assertEqual(typeof idx.reportFalsePositive, 'function', 'reportFalsePositive 未导出');
    assertEqual(typeof idx.falsePositiveStats, 'function', 'falsePositiveStats 未导出');
    assertEqual(typeof idx.falsePositiveSuggestions, 'function', 'falsePositiveSuggestions 未导出');
    assertEqual(typeof idx.confirmFalsePositive, 'function', 'confirmFalsePositive 未导出');
    assertDefined(idx.FALSE_POSITIVE_REASONS(), 'FALSE_POSITIVE_REASONS 应返回原因清单');
  });

  test('reason 只能用认可的枚举值(自由文本无法聚合)', () => {
    const reasons = idx.FALSE_POSITIVE_REASONS();
    assertEqual(reasons.length, 5, `应有 5 个认可原因，实测 ${reasons.length}`);
    const bad = idx.reportFalsePositive({
      text: 'some text', action: 'block', dimension: 'code_security', reason: 'whatever_i_feel',
    });
    assertEqual(bad.success, false, '自由文本 reason 必须被拒');
    assertTrue(/reason/.test(bad.error || ''), `错误信息应指明 reason: ${bad.error}`);
  });

  test('action 必须是 block/rewrite/verify', () => {
    const r = idx.reportFalsePositive({
      text: 'some text', action: 'allow', dimension: 'code_security', reason: 'other',
    });
    assertEqual(r.success, false, '非法 action 必须被拒');
    assertTrue(/action/.test(r.error || ''), `错误信息应指明 action: ${r.error}`);
  });

  test('text 与 dimension 不可为空', () => {
    assertEqual(idx.reportFalsePositive({ action: 'block', dimension: 'd', reason: 'other' }).success, false,
      '空 text 必须被拒');
    assertEqual(idx.reportFalsePositive({ text: 't', action: 'block', reason: 'other' }).success, false,
      '空 dimension 必须被拒');
  });

  test('report 落盘后 stats 能按维度聚合', () => {
    idx.clearFalsePositives();
    idx.reportFalsePositive({ text: 'SELECT * FROM users WHERE id = 1', action: 'block', dimension: 'reward_hacking', reason: 'over_broad_rule' });
    idx.reportFalsePositive({ text: 'Please select the best option', action: 'block', dimension: 'reward_hacking', reason: 'benign_usage' });
    const s = idx.falsePositiveStats();
    assertEqual(s.total, 2, `total 应为 2，实测 ${s.total}`);
    assertEqual(s.byDimension.reward_hacking, 2, `reward_hacking 应计 2，实测 ${s.byDimension.reward_hacking}`);
    assertTrue(Array.isArray(s.topDimensions) && s.topDimensions.length > 0, 'topDimensions 应为非空数组');
  });

  test('suggest 在样本不足 20 条时拒绝给建议', () => {
    // 这是该模块最重要的克制：宁可没建议，不可给拍脑袋建议。
    idx.clearFalsePositives();
    for (let i = 0; i < 5; i++) {
      idx.reportFalsePositive({ text: 't' + i, action: 'verify', dimension: 'code_security', reason: 'no_intent' });
    }
    const sug = idx.falsePositiveSuggestions();
    assertEqual(sug.sufficient, false, '样本不足时应标记 insufficient');
    assertEqual(sug.suggestions.length, 0, '样本不足时不应给任何建议');
    assertTrue(/20/.test(sug.message || ''), `提示应说明阈值: ${sug.message}`);
  });

  test('样本足够时 suggest 给出可执行建议', () => {
    idx.clearFalsePositives();
    // 阈值是 total < 20 才拒。19 条仍在拒绝区间——首版这里只加 19 条，
    // 于是测试断言「应 sufficient」失败，而代码行为是对的：是测试数错了。
    for (let i = 0; i < 20; i++) {
      idx.reportFalsePositive({ text: 't' + i, action: 'verify', dimension: 'code_security', reason: 'no_intent' });
    }
    const sug = idx.falsePositiveSuggestions();
    assertEqual(sug.sufficient, true, '20 条起应标记 sufficient');
    assertTrue(sug.suggestions.length > 0, '样本足够时应给出建议');
    const first = sug.suggestions[0];
    assertDefined(first.dimension, '建议应指明维度');
    assertDefined(first.recommendation, '建议应包含可执行内容');
  });

  test('隐私铁律：默认不落调用方身份、不落全文', () => {
    idx.clearFalsePositives();
    idx.reportFalsePositive({ text: 'a'.repeat(500), action: 'block', dimension: 'code_security', reason: 'other' });
    const dir = process.env.HEARTFLOW_FEEDBACK_DIR;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    assertTrue(files.length > 0, '应有 jsonl 落盘');
    const raw = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    for (const forbidden of ['ip', 'session', 'token', 'userId', 'userAgent']) {
      assertTrue(!new RegExp(forbidden, 'i').test(raw), `落盘内容不应含 ${forbidden}`);
    }
    const entry = JSON.parse(raw.trim().split('\n')[0]);
    assertEqual(entry.textLen, 500, '应记录长度');
    assertTrue(entry.textSample.length < 200, '默认只存摘要，不应存全文');
    assertTrue(entry.fullText === undefined, '默认不应存 fullText');
  });

  test('MCP 工具定义与 handler 齐备且参数名对齐', () => {
    const { TOOLS } = require('../src/mcp/tools-registry.js');
    const tool = TOOLS.find(t => t.name === 'aspira_false_positive');
    assertTrue(!!tool, 'aspira_false_positive 未在 tools-registry 注册');
    const props = tool.inputSchema.properties;
    assertTrue('action' in props, 'schema 应有 action');
    assertTrue('gateAction' in props, 'schema 应用 gateAction(schema 侧命名)');
    assertTrue('dimension' in props, 'schema 应有 dimension');
    assertTrue('reason' in props, 'schema 应有 reason');
    assertTrue(props.reason.enum.length === 5, 'reason 应限定为 5 个枚举值');
    // handler 侧：schema 的 gateAction 必须映射到 report() 的 action
    const srv = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
    const m = srv.match(/aspira_false_positive:\s*\(args\)\s*=>\s*\{([\s\S]*?)\n {2}\},/);
    assertTrue(!!m, '未找到 aspira_false_positive handler');
    assertTrue(/action:\s*args\?\.gateAction/.test(m[1]),
      'handler 必须把 schema 的 gateAction 映射为 report() 的 action(这个名字差最容易静默出错)');
    assertTrue(/idx\.reportFalsePositive/.test(m[1]), 'handler 应调用 reportFalsePositive');
    assertTrue(/idx\.falsePositiveStats/.test(m[1]), 'handler 应支持 stats');
    assertTrue(/idx\.falsePositiveSuggestions/.test(m[1]), 'handler 应支持 suggest');
  });

  test('confirm 分支端到端可达：report 返回 id，按 id 确认进 confirmed 池', async () => {
    // [缺陷回归] MCP 侧 aspira_false_positive 的 confirm 分支曾 100% 死掉：
    // handler 只透传 schema 广告的 id（`{ id: args?.id }`），而 confirm() 读的是
    // text+dimension，记录里又没有 id 字段 —— 两侧读写的字段没有一个是对方写的，
    // 调用必然得到 { success:false, error:'text 不能为空' }。整条"误报→确认→
    // 回归样本"闭环的最后一步从写下起没通过一次，且不抛异常。
    // 现在 report() 生成并返回 id，confirm() 优先按 id 定位。
    const { HANDLERS } = require('../src/mcp-server.js');

    await HANDLERS.aspira_false_positive({ action: 'clear' });
    const rep = await HANDLERS.aspira_false_positive({
      action: 'report',
      text: 'confirm branch reachability regression sample text',
      gateAction: 'block',
      dimension: 'code_security',
      reason: 'benign_usage',
    });
    assertTrue(rep && rep.success === true, `report 必须成功, 实测 ${JSON.stringify(rep)}`);
    assertTrue(typeof rep.id === 'string' && rep.id.length > 0,
      `report() 必须返回可供 confirm 定位的 id, 实测 ${JSON.stringify(rep)}`);

    // 按 id 确认必须真的成功（修复前这里恒为 error:'text 不能为空'）
    const ok = await HANDLERS.aspira_false_positive({ action: 'confirm', id: rep.id });
    assertTrue(ok && ok.success === true, `confirm(id) 必须成功, 实测 ${JSON.stringify(ok)}`);
    assertEqual(ok.dimension, 'code_security', '确认结果必须带回维度');

    // 幂等：同一条再确认一次必须被拒，不是静默重复入池
    const again = await HANDLERS.aspira_false_positive({ action: 'confirm', id: rep.id });
    assertTrue(again && again.success === false && again.alreadyConfirmed === true,
      `重复确认必须被幂等保护拒绝, 实测 ${JSON.stringify(again)}`);

    // 不存在的 id 必须点名该 id，而不是笼统的"text 不能为空"
    const bad = await HANDLERS.aspira_false_positive({ action: 'confirm', id: 'fp-not-a-real-id' });
    assertTrue(bad && bad.success === false && /fp-not-a-real-id/.test(bad.error || ''),
      `不存在的 id 必须点名该 id, 实测 ${JSON.stringify(bad)}`);

    // stats 必须反映确认结果：从未确认池移除、进 confirmed 池
    const stats = await HANDLERS.aspira_false_positive({ action: 'stats' });
    assertEqual(stats.confirmed, 1, '确认后 confirmed 必须为 1');
    assertEqual(stats.total, 0, '确认后未确认池必须为 0');

    // 隐私铁律不被修复破坏：调用方没回传原文，confirmed 记录不得凭空落全文
    const confirmedRaw = fs.readFileSync(path.join(TMP_DIR, 'false-positives-confirmed.jsonl'), 'utf8');
    assertTrue(!/"fullText"/.test(confirmedRaw),
      `按 id 确认不得凭空补全文(隐私铁律), 实测 ${confirmedRaw.trim().slice(0, 120)}`);

    await HANDLERS.aspira_false_positive({ action: 'clear' });
  });

  test('清理临时目录', () => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
    assertTrue(true, 'cleanup done');
  });
};
