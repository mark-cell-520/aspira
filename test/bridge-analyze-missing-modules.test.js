/**
 * test/bridge-analyze-missing-modules.test.js — 两个从未存在的模块
 *
 * ═══ 缺陷 ═══
 * `aspira_bridge_analyze` 的 schema 承诺「综合语气/立场/置信度/冲突/需求分析」，
 * 但 handler 里 `new StanceDetector()` 与 `new ConflictResolver()` 引用的
 * 两个类**既没有被 require，模块文件也不存在**。
 * 实测任何调用都抛 `StanceDetector is not defined`，
 * 被 catch 吞成 `{ input, error: ... }` —— 工具**完全不可用**。
 *
 * 这是哨兵法(scripts/module-field-consumer-audit.js)那 52 个"基线即报错"
 * 里最有价值的发现: 其余多数是仪器问题(哨兵类型不匹配、enum 被污染)，
 * 这两个是**真的没实现**。
 *
 * ═══ 修法 ═══
 * 遵循本仓既定原则「补声明而非删参数」:
 * 补齐 src/bridge/stance-detector.js 与 src/bridge/conflict-resolver.js，
 * 并在 handler 里 require，而不是从 schema 删掉 stance/conflict。
 *
 * ═══ 顺带修掉的新模块自身缺陷 ═══
 * 首版 StanceDetector 的 SUPPORT 用 `我(完全)?(同意|赞成|支持)`、
 * OPPOSE 用 `我(不|完全)(同意|赞成|支持)`，于是「我完全同意」同时命中两者
 * (OPPOSE 把"完全"当成了否定词) —— 实测 stance 报成 mixed、置信度 0。
 * 否定限定词已收紧为只收 不/并非/并不。
 *
 * ═══ 本测试锁什么 ═══
 * ① 两个模块可加载、类可实例化、方法存在
 * ② 端到端 aspira_bridge_analyze 不再抛 StanceDetector is not defined
 * ③ 立场分类在五种典型输入上正确(且互斥: 支持不得同时算反对)
 * ④ 冲突识别能检出"虽然…但是…不"型自我矛盾
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

module.exports = function ({ test, assertEqual, assertTrue }) {

  // ─── ① 模块可加载 ─────────────────────────────────────────────
  test('StanceDetector 与 ConflictResolver 可加载且方法存在', () => {
    const { StanceDetector } = require(path.join(ROOT, 'src', 'bridge', 'stance-detector.js'));
    const { ConflictResolver } = require(path.join(ROOT, 'src', 'bridge', 'conflict-resolver.js'));
    assertEqual(typeof StanceDetector, 'function', 'StanceDetector 应是类');
    assertEqual(typeof ConflictResolver, 'function', 'ConflictResolver 应是类');
    const sd = new StanceDetector();
    const cr = new ConflictResolver();
    assertEqual(typeof sd.detect, 'function', 'sd.detect 应存在');
    assertEqual(typeof cr.resolve, 'function', 'cr.resolve 应存在');
  });

  // ─── ② handler 真的 require 了它们 ────────────────────────────
  test('handleBridgeAnalyze 必须 require 这两个类', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    const i = src.indexOf('function handleBridgeAnalyze');
    assertTrue(i >= 0, '应能定位 handleBridgeAnalyze');
    const body = src.slice(i, src.indexOf('function ', i + 10) > 0 ? src.indexOf('function ', i + 10) : i + 2000);
    assertTrue(/require\(['"]\.\/bridge\/stance-detector\.js['"]\)/.test(body),
      'handler 必须 require stance-detector.js(此前未 require 导致 ReferenceError)');
    assertTrue(/require\(['"]\.\/bridge\/conflict-resolver\.js['"]\)/.test(body),
      'handler 必须 require conflict-resolver.js');
  });

  // ─── ③ 立场分类正确且互斥 ─────────────────────────────────────
  test('立场分类: 五种典型输入各得其所，且支持/反对互斥', () => {
    const { StanceDetector } = require(path.join(ROOT, 'src', 'bridge', 'stance-detector.js'));
    const sd = new StanceDetector();
    const cases = [
      ['我完全同意这个观点，确实如此', 'support'],
      ['我强烈反对，这个说法完全错误', 'oppose'],
      ['我不同意这个观点', 'oppose'],
      ['两边都有道理，很难判断', 'neutral'],
    ];
    for (const [text, expected] of cases) {
      const r = sd.detect(text);
      assertEqual(r.stance, expected,
        `「${text}」应判为 ${expected}(实测 ${r.stance}, signals=${JSON.stringify(r.signals)})`);
      // 互斥: 明确支持的文本不得同时出现反对信号
      if (expected === 'support') {
        assertEqual(r.counts.oppose, 0,
          `「${text}」不应出现反对信号(实测 oppose=${r.counts.oppose}) —— 这是首版"完全"被当否定词的缺陷`);
      }
    }
    // 无立场信号的文本: neutral 且 confidence 0
    const none = sd.detect('今天天气不错');
    assertEqual(none.stance, 'neutral', '无立场信号应为 neutral');
    assertEqual(none.confidence, 0, '无立场信号时置信度应为 0');
  });

  // ─── ④ 冲突识别 ───────────────────────────────────────────────
  test('冲突识别: 能检出"虽然…但是…不"型自我矛盾', () => {
    const { ConflictResolver } = require(path.join(ROOT, 'src', 'bridge', 'conflict-resolver.js'));
    const cr = new ConflictResolver();
    const r = cr.resolve('虽然这样做看起来快，但是实际上无法解决根本问题');
    assertEqual(r.conflict, true, '应检出冲突');
    assertEqual(r.type, 'internal', '应为自我矛盾(实测 ' + r.type + ')');
    assertTrue(r.evidence.length > 0, '应给出证据');
    // 无冲突文本
    const clean = cr.resolve('今天天气很好，我去公园散步');
    assertEqual(clean.conflict, false, '普通陈述不应报冲突');
  });

  // ─── ⑤ 端到端: 工具不再抛 ReferenceError ─────────────────────
  test('端到端: aspira_bridge_analyze 返回五类分析而非 error', () => {
    const net = require('net');
    const crypto = require('crypto');
    const { spawn } = require('child_process');
    const sock = '/tmp/aspira-bridge.sock';
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
        const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 10000);
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
      const r = await call('aspira_bridge_analyze', { input: '我完全同意这个方案，虽然它还有改进空间' });
      const c = r.result && r.result.content;
      const j = JSON.parse(c && c[0] ? c[0].text : '{}');
      assertTrue(!j.error,
        `不得返回 error(实测 ${JSON.stringify(j.error)}) —— StanceDetector is not defined 已修`);
      // schema 承诺五类分析
      for (const key of ['tone', 'stance', 'confidence', 'needs']) {
        assertTrue(key in j, `应返回 ${key}`);
      }
      assertTrue('conflict' in j, '应返回 conflict 键(值可为 null)');
      assertEqual(j.stance.stance, 'support', `立场应为 support(实测 ${j.stance && j.stance.stance})`);
    })().catch(e => { cleanup(); if (conn) conn.destroy(); throw e; })
      .then(() => { cleanup(); if (conn) conn.destroy(); });
  });
};
