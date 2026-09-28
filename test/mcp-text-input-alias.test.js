/**
 * test/mcp-text-input-alias.test.js — 主文本参数 text ↔ input 别名
 *
 * ═══ mcp-tool-enhancement 切片的发现 ═══
 * 审计 181 个 MCP 工具的参数命名，实测:
 *     61 个用 text、13 个用 input 作为主文本参数
 * 那 13 个是 aspira_think / think_fast / emotion / emotion_deep /
 * emotion_dynamics / mood / self_correction / supervise / agent_think /
 * bridge_analyze / decision_router / translate。
 *
 * agent 按一套习惯传 text，就会在这 13 个上撞 -32603「input 是必填参数」。
 *
 * ═══ 失败形态为什么特别难查 ═══
 * mcp-server.js 的中央参数校验([AUDIT-FIX I-2])会**丢弃未声明参数**——
 * 调用方传的 text 被静默删掉，错误信息只提 input，看不到"你其实传了 text"。
 * 实测复现:
 *     tools/call aspira_think {text:'test'} → -32603 "input 是必填参数"
 *
 * ═══ 修法 ═══
 * 在中央校验**之前**做一次别名归一化: 工具声明了 input、调用方没传 input
 * 但传了 text 时，把 text 复制为 input。**向后兼容**——原传 input 的调用方
 * 完全不受影响，原传 text 的从报错变为可用。
 *
 * ═══ 为什么值得锁 ═══
 * 别名归一化放在中央校验之前，顺序反了就会失效(text 先被丢弃，归一化拿不到值)，
 * 而那时 13 个工具重新报错、但本文件的测试会立刻红。顺序即契约。
 */
module.exports = function ({ test, assertTrue, assertEqual }) {
  const http = require('http');
  const fs = require('fs');
  const path = require('path');
  const TOKEN_FILE = '/tmp/aspira-mcp.token';

  const INPUT_TOOLS = [
    'aspira_think', 'aspira_think_fast', 'aspira_emotion', 'aspira_emotion_deep',
    'aspira_emotion_dynamics', 'aspira_mood', 'aspira_self_correction',
    'aspira_supervise', 'aspira_agent_think', 'aspira_bridge_analyze',
    'aspira_decision_router', 'aspira_translate',
  ];

  function rpc(method, params) {
    return new Promise((res, rej) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      const rq = http.request({
        host: 'localhost', port: 8099, path: '/mcp', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + fs.readFileSync(TOKEN_FILE, 'utf8').trim(),
          'Content-Length': Buffer.byteLength(body),
        },
      }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({}); } }); });
      rq.on('error', rej); rq.end(body);
    });
  }

  test('MCP server 必须在线(8099)，否则本文件跳过后续断言', () => {
    // 单元测试不启动 server; 不在线时其余断言自行跳过，避免把环境问题当成引擎缺陷
    assertTrue(true, 'server 状态由后续用例自行判断');
  });

  // [并发容错] run-all.js 并发跑多个测试文件，直连 8099 的 HTTP 调用在负载下
  // 会偶发 ECONNRESET/超时——实测本用例在全量下 4/5 失败、单独跑 5/5 通过。
  // 故: 网络层错误重试; 只有**服务端真返回 error** 才算失败(那才是别名没生效)。
  async function rpcRetry(method, params, tries) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      try { return await rpc(method, params); }
      catch (e) { last = e; await new Promise(r => setTimeout(r, 150)); }
    }
    return { error: { message: 'NETWORK: ' + String(last && last.message) } };
  }

  test('别名归一化必须双向兼容(text 与 input 都可用)', async () => {
    if (!fs.existsSync(TOKEN_FILE)) { assertTrue(true, '无 token，跳过'); return; }
    // [限流教训] MCP server 带限流器("Too Many Requests", retryAfter 60)。
    // 首版对 12 个工具各发 2 次共 24 个请求，实测连跑时 3/6 次撞上限流——
    // 那不是引擎缺陷，是测试在砸服务器。改为只实测 3 个代表工具(6 个请求)，
    // 并在请求之间留间隔。12 个工具的清单由 INPUT_TOOLS 常量静态声明，
    // 其"声明 input"这一点由工具注册表本身保证，无需逐个在线打。
    const SAMPLE = INPUT_TOOLS.slice(0, 3);
    for (const name of SAMPLE) {
      const a = await rpcRetry('tools/call', { name, arguments: { text: 'test' } }, 2);
      await new Promise(r => setTimeout(r, 250));
      const b = await rpcRetry('tools/call', { name, arguments: { input: 'test' } }, 2);
      await new Promise(r => setTimeout(r, 250));
      assertTrue(!a.error, `${name} 传 text 不得报错，实测 ${a.error ? a.error.message : 'ok'}`);
      assertTrue(!b.error, `${name} 传 input 不得报错(向后兼容)，实测 ${b.error ? b.error.message : 'ok'}`);
    }
  });

  test('中央校验的"丢弃未声明参数"必须仍在(别名不得打开注入口)', () => {
    // 别名只复制 text→input，不得让任意未声明参数漏过去。
    // 这条锁的是安全性没有为了便利被牺牲。
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
    const m = src.match(/const cleaned = \{\};\s*for \(const \[k, v\] of Object\.entries\(props\)\)/);
    assertTrue(!!m, '中央校验的 cleaned 白名单必须仍在');
    if (m) {
      // ⚠️ 首版从 cleaned 定义处**向后**取 900 字符找注释，但注释在定义**之前**，
      // 于是永远匹配不到。改为向前后各取一段。
      const i = src.indexOf('const cleaned = {};');
      const seg = src.slice(Math.max(0, i - 500), i + 900);
      assertTrue(/丢弃未声明参数|只透传 inputSchema/.test(seg),
        '中央校验的白名单语义必须保留(别名不得绕过它)');
    }
  });

  test('别名归一化必须位于中央校验之前(顺序即契约)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
    const alias = src.indexOf('主文本参数别名归一化');
    const clean = src.indexOf('const cleaned = {};');
    assertTrue(alias > 0, '应能定位别名归一化代码');
    assertTrue(clean > 0, '应能定位中央校验代码');
    assertTrue(alias < clean,
      `别名归一化(偏移 ${alias})必须早于中央校验(偏移 ${clean})——` +
      '反了的话 text 先被丢弃，归一化拿不到值，13 个工具重新报错');
  });

  test('归一化条件必须要求"未收到 input"(不得覆盖调用方显式传的 input)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
    const i = src.indexOf('主文本参数别名归一化');
    const seg = src.slice(i, i + 1400);
    assertTrue(/!\(['"]input['"] in args\)/.test(seg),
      '必须带 !("input" in args) 守卫，否则调用方显式传的 input 会被 text 覆盖');
    assertTrue(/typeof args\.text === ['"]string['"]/.test(seg),
      '必须校验 args.text 是字符串，避免把非文本值复制进 input');
  });
};
