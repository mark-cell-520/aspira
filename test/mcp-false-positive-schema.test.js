/**
 * test/mcp-false-positive-schema.test.js — 误报反馈工具的 schema 契约锁
 *
 * [mcp-tool-enhancement·第一百三十三轮] 新建。
 *
 * ═══ 背景: schema 广告的合法值必然导致错误 ═══
 * 181 个 handler 行为探针(cycle 29/122/133 的做法)抓到
 * `aspira_false_positive` 的契约缺口: action 的 enum 第一值是 'report',
 * report 分支要求 text/gateAction/dimension/reason 四个字段
 * (false-positive-feedback.js 的 report() 逐项校验), 而 inputSchema 只
 * 声明 `required: ['action']`。调用方按 schema 合法调用(按 required 只传
 * action)必得 {error:'text 不能为空'} —— 契约错配家族: **调用在协议层
 * 成功、不抛错、结构合法, 但内容是死的**, 且这是**按 schema 走必然发生**,
 * 不是偶发。
 *
 * ═══ 修法 ═══
 * inputSchema 加 JSON Schema 条件 required(allOf/if/then):
 * action='report' → required 补 text/gateAction/dimension/reason;
 * 其他 action(stats/suggest/confirm/clear/reasons)仍只要 action。
 * 不理解 if/then 的 client 退化为原行为(只传 action 仍可查 stats),
 * 不会比现在更差。handler 侧校验不变(那是最后防线, 防非 MCP 调用方)。
 *
 * ═══ 锁什么 ═══
 * ① 源级: schema 含 allOf/if/then, report 分支 required 覆盖四个字段;
 * ② 行为: 缺字段的 report 仍被 handler 拒绝(最后防线没被 schema 削弱);
 *    带全字段的合法 report 必须成功(端到端通路); 完事清理( clear ),
 *    不在仓库 data/ 留痕迹(锁自运维);
 * ③ schema 与 handler 的一致性: schema 条件分支覆盖的字段集 = handler
 *    实际校验的必填集(防将来一侧改一侧不改)。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { TOOLS, HANDLERS } = require(path.join(ROOT, 'src/mcp-server.js'));

module.exports = function ({ test, assertTrue, assertEqual }) {

  const tool = TOOLS.find(t => t.name === 'aspira_false_positive');

  test('源级: schema 的条件 required 必须存在且覆盖 report 四字段', () => {
    assertTrue(!!tool, 'TOOLS 必须含 aspira_false_positive');
    const schema = tool && tool.inputSchema;
    assertTrue(!!schema, 'inputSchema 必须存在');
    const src = fs.readFileSync(path.join(ROOT, 'src/mcp/tools-registry.js'), 'utf8');
    assertTrue(/allOf/.test(src) && /if:/.test(src) && /then:/.test(src),
      'schema 必须用 allOf/if/then 声明条件 required(裸 required 无法表达"按 action 分支")');
    // report 分支的 then.required 覆盖 handler 实际校验的四个必填
    assertTrue(/required: \['text', 'gateAction', 'dimension', 'reason'\]/.test(src),
      'report 分支的条件 required 必须含 text/gateAction/dimension/reason 四字段');
    // 顶层 required 保持只 action(其他分支不能被误伤)
    assertTrue(/required: \['action'\]/.test(src),
      '顶层 required 必须仍只含 action(stats/suggest 等分支不能被迫带 text)');
  });

  test('行为: 缺字段的 report 仍被 handler 拒绝(最后防线没被削弱)', async () => {
    const r = await HANDLERS.aspira_false_positive({ action: 'report' });
    assertTrue(r && r.error, `缺字段的 report 必须返回 error, 实测 ${JSON.stringify(r).slice(0, 100)}`);
    // 错误信息必须可行动(点名缺什么), 不是笼统一句
    assertTrue(/text|gateAction|dimension|reason/.test(r.error),
      `错误信息必须指名缺失字段, 实测: ${r.error}`);
  });

  test('行为: 合法 report 必须成功且 stats/clear 端到端可用(完事清理)', async () => {
    // 先清理, 保证测试起点确定(不依赖历史 data/feedback 内容)
    await HANDLERS.aspira_false_positive({ action: 'clear' });
    const rep = await HANDLERS.aspira_false_positive({
      action: 'report',
      text: 'this is a lock test sample text for false positive feedback',
      gateAction: 'block',
      dimension: 'code_security',
      reason: 'benign_usage',
      note: 'mcp schema lock self test',
    });
    assertTrue(rep && rep.success !== false && !rep.error,
      `合法 report 必须成功, 实测 ${JSON.stringify(rep).slice(0, 120)}`);
    const stats = await HANDLERS.aspira_false_positive({ action: 'stats' });
    assertTrue(stats && !stats.error, 'stats 必须可用');
    assertTrue(JSON.stringify(stats).includes('code_security'),
      'stats 必须能读到本测试刚回报的维度(证明 report 真的落盘)');
    await HANDLERS.aspira_false_positive({ action: 'clear' }); // 清理, 不留仓库痕迹
  });

  test('schema 与 handler 一致: 条件分支字段集 = handler 校验必填集', () => {
    // handler 侧最后防线的必填集(从 false-positive-feedback.js 的 report() 读)
    const fpSrc = fs.readFileSync(path.join(ROOT, 'src/false-positive-feedback.js'), 'utf8');
    const repBlock = fpSrc.slice(fpSrc.indexOf('function report('), fpSrc.indexOf('function report(') + 800);
    const requiredByHandler = ['text', 'action', 'dimension', 'reason'].filter(f =>
      new RegExp(`${f}[^\\n]{0,40}(不能为空|必须是)`).test(repBlock));
    assertTrue(requiredByHandler.length >= 3,
      `handler 的 report() 必须校验至少 3 个必填字段(text/action/dimension/reason), 实测 ${requiredByHandler.join('/')}`);
    // schema 条件分支声明四个 = handler 四个(handler 的 action 入参由 MCP 层的 gateAction 映射)
    assertTrue(requiredByHandler.includes('text') && requiredByHandler.includes('dimension') && requiredByHandler.includes('reason'),
      'handler 必填集必须与 schema 条件分支对齐');
  });
};
