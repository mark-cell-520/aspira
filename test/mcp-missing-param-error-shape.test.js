/**
 * test/mcp-missing-param-error-shape.test.js — 缺参错误的两种形态必须归一
 *
 * [mcp-tool-enhancement·第一百五十七轮] 新建。
 *
 * cycle 17/29 的做法是"把 181 个 handler 都调一遍"。本轮沿用，但问的是另一个
 * 问题: **参数校验失败时，工具返回什么形态？**
 *
 * ═══ 实测(181 个工具, 空参数调用) ═══
 *   163 个 → `return { error: 'X 是必填参数' }`
 *    18 个 → `throw new Error('X 是必填参数')`
 *
 * 两类形态对调用方是两回事:
 *   · 163 个 → `{content:[{type:'text',text:'{"error":"input 是必填参数"}'}], isError:false}`
 *   ·  18 个 → 冒到 HTTP 层的 catch，变成 JSON-RPC 错误 `{code:-32603, message:…}`
 *
 * MCP 客户端按 `result.error` / `isError` 判断工具成败，-32603 走的是协议层
 * 另一条路 —— 同一个"缺参数"错误，18 个工具与 163 个工具的调用方体验不同。
 *
 * ═══ 为什么 throw 会冒出去 ═══
 * dispatch 里有一段"兼容两种签名"的 fallback:
 *
 *     try { result = handler(args, sessionId); }
 *     catch (_) { result = handler(args); }      ← 第二次没有自己的 try
 *
 * 第二次一 throw 就逃出 `case 'tools/call'`，而 switch 外层没有 try，于是一路
 * 冒到 HTTP 层的 catch。附带代价: 每个缺参请求**白跑两遍 handler**。
 *
 * ═══ 修法 ═══
 * 1. 第二次调用也包 try，转成与其它工具同形的 `{ error: … }`
 * 2. aspira_bridge_analyze 的消息从英文 "input is required" 改成中文
 *    (实测 18 个 throw 型里 16 个是中文标准形，它是唯一一个英文的)
 *
 * ═══ 18 个 throw 型工具 ═══
 * aspira_think / aspira_think_fast / aspira_memory_search / aspira_emotion /
 * aspira_self_heal / aspira_provider_health / aspira_cost_tracking /
 * aspira_decision_router / aspira_supervise / aspira_check_single /
 * aspira_macro_strategy / aspira_pedagogy_detect / aspira_gate /
 * aspira_gate_check / aspira_gate_pipeline / aspira_agent_think /
 * aspira_bridge_analyze / aspira_translate
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const { HANDLERS, TOOLS } = require(path.join(ROOT, 'src', 'mcp-server.js'));

  // 本轮实测的 18 个 throw 型工具。写死是为了"新增工具漏改"能被发现 ——
  // 若将来有人加一个 throw 型工具而没进这份名单，下面的计数断言会红。
  const THROWERS = [
    'aspira_think', 'aspira_think_fast', 'aspira_memory_search', 'aspira_emotion',
    'aspira_self_heal', 'aspira_provider_health', 'aspira_cost_tracking',
    'aspira_decision_router', 'aspira_supervise', 'aspira_check_single',
    'aspira_macro_strategy', 'aspira_pedagogy_detect', 'aspira_gate',
    'aspira_gate_check', 'aspira_gate_pipeline', 'aspira_agent_think',
    'aspira_bridge_analyze', 'aspira_translate',
  ];

  // ── 一、dispatch 的第二次调用必须被接住 ─────────────────
  test('源级: dispatch 的第二次 handler 调用必须包在自己的 try 里', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const i = src.indexOf('result = handler(args, sessionId);');
    assertTrue(i > 0, '前提失效: 找不到 handler(args, sessionId) 调用');
    const seg = src.slice(i, i + 400);
    // 第二次调用之前必须已经出现过一个 catch(即它在 catch 块里)
    assertTrue(/catch\s*\([^)]*\)\s*\{[\s\S]*?result = handler\(args\)/.test(seg),
      '第二次调用 result = handler(args) 必须位于 catch 块内');
    // 且第二次调用之后、该 catch 结束之前，必须有内层 try/catch
    const after = seg.slice(seg.indexOf('result = handler(args)'));
    assertTrue(/try\s*\{[\s\S]*?result = handler\(args\)[\s\S]*?\}\s*catch/.test(seg),
      `第二次调用没有内层 try/catch —— 它一 throw 就逃出 case 'tools/call'，` +
      `变成 JSON-RPC 的 -32603 而不是工具层的 {error}。该段:\n${seg.slice(0, 260)}`);
    assertTrue(/catch\s*\(\s*e2\s*\)/.test(seg),
      '内层 catch 必须绑定异常对象(否则无法取出 message 填进 {error})');
    assertTrue(/e2\.message/.test(seg),
      '内层 catch 必须把 e2.message 填进 {error} —— 否则 18 个工具的缺参消息全变成同一句' +
      '通用兜底，调用方看不到缺的是哪个参数');
    // 自证: 谓词必须能判"第二次调用裸奔"为缺陷, 否则本条是恒真锁
    const naked = "try { result = handler(args, sessionId); } catch (_) { result = handler(args); }";
    assertTrue(/try\s*\{[\s\S]*?result = handler\(args\)[\s\S]*?\}\s*catch/.test(naked) === false,
      '自证失效: 谓词抓不到"第二次调用没有内层 try"这一形态, 本条是恒真锁');
  });

  // ── 二、18 个 throw 型工具的消息必须是中文标准形 ────────
  test('throw 型工具的缺参消息必须是中文"X 是必填参数"形态', async () => {
    const bad = [];
    for (const name of THROWERS) {
      const h = HANDLERS[name];
      if (!h) { bad.push(`${name}: 无 handler`); continue; }
      let msg = null;
      try { await h({}, 'probe-session'); } catch (e) { msg = e.message || String(e); }
      if (msg === null) { bad.push(`${name}: 不再 throw(改成了 return?) —— 请更新本名单`); continue; }
      if (!/是必填参数$/.test(msg)) bad.push(`${name}: 消息不是中文标准形 → ${msg}`);
      if (/\bis required\b|\bmissing\b|\brequired\b/i.test(msg)) bad.push(`${name}: 消息含英文 → ${msg}`);
    }
    assertEqual(bad.join('\n'), '', '以下 throw 型工具的消息形态不符:\n' + bad.join('\n'));
  });

  // ── 三、名单必须与实测一致(新增工具漏改会被发现) ────────
  test('throw 型工具名单必须与实测一致', async () => {
    const actual = [];
    for (const t of TOOLS) {
      const h = HANDLERS[t.name];
      if (!h) continue;
      try { await h({}, 'probe-session'); } catch (_) { actual.push(t.name); }
    }
    const missing = actual.filter(n => !THROWERS.includes(n));
    const extra = THROWERS.filter(n => !actual.includes(n));
    assertEqual(missing.join(', '), '',
      `以下工具缺参时 throw 但不在本测试名单里 —— 新增/改动的工具漏改了:\n  ${missing.join('\n  ')}`);
    assertEqual(extra.join(', '), '',
      `名单里的这些工具现在不 throw 了(改成了 return {error}) —— 请更新名单:\n  ${extra.join('\n  ')}`);
    // 名单本身不能退化成"反正查不到"
    assertTrue(actual.length >= 15,
      `前提失效: 实测 throw 型只有 ${actual.length} 个, 与 18 个的既有事实不符 —— ` +
      '可能所有工具都被改成 return 了，那是好事，请把名单清空并更新本测试');
  });
};
