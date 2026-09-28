/**
 * test/handler-arg-shape-audit.test.js — handler 把字符串传给期望对象的方法
 *
 * ═══ 缺陷形态(本轮一次抓到 2 处) ═══
 * 与上一轮的"类对象上调实例方法"同属**契约错配**族，但方向相反:
 *
 *     aspira_multi_agent_dialogue: (args) => {
 *       inst.registerAgent(args?.message || '');        // ← 字符串
 *     }
 *     // registerAgent(name, agent) 的第二个参数是**对象**:
 *     //   role: agent.role || 'participant'
 *
 *     aspira_flow_predict: (args) => {
 *       inst.recordError(args?.event || '');            // ← 字符串
 *     }
 *     // recordError(errorEvent) 要求**对象**:
 *     //   error: errorEvent.message?.substring(0, 100)
 *
 * 两者实测都恒抛:
 *   multi_agent_dialogue → Cannot read properties of undefined (reading 'role')
 *   flow_predict          → Cannot read properties of undefined (reading 'includes')
 *
 * ═══ 为什么 try/catch 拦不住它 ═══
 * 错误确实被捕获并转成 { error }，调用方收到的是结构合法的响应 ——
 * 与 Promise 泄漏、类对象调实例方法**同一个后果**:
 * **没有任何一处失败是调用方能看见的，而工具从未工作过。**
 *
 * ═══ 三个族共用一条教训 ═══
 * MCP handler 的"已接线"只到"方法名存在"为止。
 * 方法名的存在**不能证明参数形状对**。
 * 唯一能证明的方式是**用合法参数端到端调用一次**。
 *
 * ═══ 修法 ═══
 * 按"补声明而非删参数": 把字符串包装成模块要求的对象，
 * 并把新读的参数补进 schema(否则中央校验会静默剥掉它们 ——
 * 这一步本周期被零回归门禁当场抓到过，见 mcp-echo-audit 的形态二)。
 *
 * ═══ 本测试锁什么 ═══
 * ① 两个 handler 都做形状适配(源码级)
 * ② 新读的参数已在 schema 声明(否则被静默丢弃)
 * ③ 端到端两工具用合法参数不得返回 error
 * ④ 回归防线: 扫描所有内联 handler，
 *    若把 `args?.X || ''`(字符串)直接传给方法，
 *    而该方法的第二形参在模块里被点号取值，则报警
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));

module.exports = function ({ test, assertEqual, assertTrue }) {

  // ─── ① handler 做形状适配 ──────────────────────────────────────
  test('两个 handler 必须把字符串包装成模块要求的对象', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    // multi_agent_dialogue: 不得再把 args?.message 直接传给 registerAgent
    const i = src.indexOf('aspira_multi_agent_dialogue:');
    assertTrue(i >= 0, '应能定位 aspira_multi_agent_dialogue');
    let j = src.indexOf('\n  aspira_', i + 10);
    if (j < 0) j = i + 3000;
    const d = src.slice(i, j);
    assertTrue(!/registerAgent\s*\(\s*args\?\.message/.test(d),
      '不得把字符串 args.message 直接传给 registerAgent(第二形参须为对象)');
    assertTrue(/inst\.registerAgent\s*\(\s*msg\s*,\s*agent\s*\)/.test(d),
      'registerAgent 应以 (名字, 对象) 两参调用');

    // flow_predict: 不得再把 args?.event 直接传给 recordError
    const k = src.indexOf('aspira_flow_predict:');
    assertTrue(k >= 0, '应能定位 aspira_flow_predict');
    let l = src.indexOf('\n  aspira_', k + 10);
    if (l < 0) l = k + 3000;
    const p = src.slice(k, l);
    assertTrue(!/recordError\s*\(\s*args\?\.event/.test(p),
      '不得把字符串 args.event 直接传给 recordError(须为对象)');
    assertTrue(/inst\.recordError\s*\(\s*ev\s*\)/.test(p),
      'recordError 应以包装后的对象调用');
  });

  // ─── ② 新读的参数必须在 schema 声明 ───────────────────────────
  test('新读的参数必须已在 schema 声明(否则被中央校验静默剥掉)', () => {
    const want = {
      aspira_multi_agent_dialogue: ['message', 'role', 'persona', 'agent'],
      aspira_flow_predict: ['event', 'location'],
    };
    for (const [name, params] of Object.entries(want)) {
      const t = TOOLS.find(x => x.name === name);
      assertTrue(!!t, `应存在 ${name}`);
      const declared = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
      for (const p of params) {
        assertTrue(declared.includes(p),
          `${name} 必须声明参数 ${p}(handler 读了它，未声明则被中央校验静默丢弃)`);
      }
    }
  });

  // ─── ③ 端到端: 合法参数不得返回 error ────────────────────────
  test('端到端: 两工具用合法参数不得返回 error', () => {
    const sock = '/tmp/aspira-argshape.sock';
    const token = crypto.randomBytes(16).toString('hex');
    const proc = spawn('node', ['src/mcp-server.js', '--socket', sock], {
      cwd: ROOT, env: { ...process.env, ASPIRA_MCP_TOKEN: token }, stdio: 'ignore',
    });
    const cleanup = () => {
      try { proc.kill(); } catch (e) {}
      try { fs.unlinkSync(sock); } catch (e) {}
    };
    let conn = null, nextId = 1;
    const pending = new Map();
    const call = (name, args) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 12000);
        pending.set(id, m => { clearTimeout(t); resolve(m); });
        conn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      });
    };
    return (async () => {
      for (let i = 0; i < 60 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 250));
      await new Promise((resolve, reject) => {
        const c = net.connect(sock);
        let buf = '';
        c.on('connect', () => { conn = c; resolve(); });
        c.on('data', d => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
            const p = pending.get(msg.id);
            if (p) { pending.delete(msg.id); p(msg); }
          }
        });
        c.on('error', reject);
      });
      const cases = [
        ['aspira_multi_agent_dialogue', { message: 'analyst', role: 'critic' }],
        ['aspira_multi_agent_dialogue', { message: 'analyst' }],
        ['aspira_flow_predict', { event: 'TypeError: x is not a function', location: 'src/a.js:12' }],
        ['aspira_flow_predict', { event: 'SyntaxError: unexpected token' }],
      ];
      for (const [name, args] of cases) {
        const r = await call(name, args);
        const c = r.result && r.result.content;
        const j = JSON.parse(c && c[0] ? c[0].text : '{}');
        assertTrue(!j.error,
          `${name}(${JSON.stringify(args).slice(0, 50)}) 不得返回 error(实测 ${JSON.stringify(j.error)}) —— 字符串传给期望对象的方法已修`);
      }
    })().catch(e => { cleanup(); if (conn) conn.destroy(); throw e; })
      .then(() => { cleanup(); if (conn) conn.destroy(); });
  });

  // ─── ④ 模块侧契约确实要求对象(锁住缺陷的成因) ─────────────────
  test('两个底层方法确实要求对象形参', () => {
    const mad = fs.readFileSync(path.join(ROOT, 'src', 'consciousness', 'multi-agent-dialogue.js'), 'utf8');
    assertTrue(/registerAgent\s*\(\s*name\s*,\s*agent\s*\)/.test(mad),
      'registerAgent 的签名应为 (name, agent)');
    assertTrue(/agent\.role/.test(mad),
      'registerAgent 内部读 agent.role —— 所以第二形参必须是对象');
    const fp = fs.readFileSync(path.join(ROOT, 'src', 'core', 'flow-predictor.js'), 'utf8');
    assertTrue(/recordError\s*\(\s*errorEvent\s*\)/.test(fp),
      'recordError 的签名应为 (errorEvent)');
    assertTrue(/errorEvent\.message/.test(fp),
      'recordError 内部读 errorEvent.message —— 所以形参必须是对象');
  });
};
