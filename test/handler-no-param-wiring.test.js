/**
 * test/handler-no-param-wiring.test.js — 无参数工具的"实例化后丢弃"缺陷
 *
 * ═══ 缺陷形态(本轮一次抓到 6 处) ═══
 * 六个 handler 是同一形状:
 *
 *     aspira_self_benchmark: (args) => {
 *       try {
 *         const { SelfBenchmark } = require('./cortex/self-benchmark.js');
 *         const inst = new SelfBenchmark({ silent: true, rootPath: HF_DIR });
 *         const r = {};                                   // ← 从未调用 inst
 *         return { result: r, timestamp: Date.now() };
 *       } catch (e) { return { error: e.message }; }
 *     },
 *
 * 模块明明有真实的公开入口(self-benchmark.js 的 assess()、
 * agent-card.js 的 loadOrCreate()、self-diagnosis.js 的 run()、
 * what-learned.js 的 report()、metaMemory.js 的 getMemoryStats()、
 * memory-consolidator.js 的 getStats())，handler 一个都没调。
 *
 * 后果与 aspira_mood 的 Promise 泄漏、aspira_bridge_analyze 的
 * 模块缺失**同一族**:
 *   **方法存在、调用成功、不抛错、返回结构合法 —— 但内容是空的。**
 * 调用方看到 {"result": {},"timestamp": ...}，
 * 无法区分"这个工具返回空"和"这个工具从未接线"。
 *
 * ═══ 同轮抓到的第 7 处: 缓存从未生效 ═══
 * `aspira_cache_stats` 恒报 cache_not_initialized。
 * 根因: `src/core/heartflow.js` 只在 think() 里**读** `this._thinkCache`
 * (_cacheGet / _cachePut)，却**从未赋值**。两处 helper 都有
 * `if (!cache || !cache.map ...) return` 保护，于是:
 *   _cacheGet 恒返回 null(永远 miss)
 *   _cachePut 恒直接 return(永远写不进)
 * **缓存功能自上线起从未生效，且不抛任何错。**
 *
 * ═══ 为什么哨兵法看不到这些 ═══
 * 这 7 个工具的 inputSchema **没有任何参数**，
 * 哨兵法无可注入字段，直接跳过。
 * "无参数"不等于"不可测" —— 直接调用就能测。
 *
 * ═══ 本测试锁什么 ═══
 * ① 源码级: 六个 handler 必须调用入口方法(不得再 `const r = {}`)
 * ② 端到端: 六个工具的 result 不得是空对象
 * ③ _thinkCache 必须在构造后即存在
 * ④ 端到端: aspira_cache_stats 不得报 cache_not_initialized
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

// 工具 → 应调用的入口方法
const WIRING = {
  aspira_self_benchmark: 'assess',
  aspira_agent_card: 'loadOrCreate',
  aspira_memory_consolidate: 'getStats',
  aspira_meta_memory: 'getMemoryStats',
  aspira_self_diagnose: 'run',
  aspira_what_learned: 'report',
};

module.exports = function ({ test, assertEqual, assertTrue }) {

  // ─── ① 源码级: 必须调用入口方法 ──────────────────────────────
  test('六个 handler 必须调用入口方法(不得再 const r = {})', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    for (const [tool, method] of Object.entries(WIRING)) {
      const i = src.indexOf(tool + ':');
      assertTrue(i >= 0, `应能定位 ${tool}`);
      let j = src.indexOf('\n  aspira_', i + 10);
      if (j < 0) j = i + 3000;
      const body = src.slice(i, j);
      assertTrue(!/const r = \{\s*\};/.test(body),
        `${tool} 不得再写 const r = {} —— 那是"实例化后丢弃"，返回空对象给调用方`);
      assertTrue(new RegExp('inst\\.' + method + '\\s*\\(').test(body),
        `${tool} 必须调用 inst.${method}()`);
    }
  });

  // ─── ② _thinkCache 必须初始化 ────────────────────────────────
  test('_thinkCache 必须在构造后即存在(此前从未赋值)', () => {
    const { Aspira } = require(path.join(ROOT, 'src', 'core', 'heartflow.js'));
    const inst = new Aspira({ rootPath: path.join(ROOT, 'data', '_probe_' + process.pid), silent: true });
    assertTrue(!!inst._thinkCache,
      '构造后 _thinkCache 不得为 undefined —— 曾从未赋值，导致缓存永不生效');
    assertTrue(inst._thinkCache.map instanceof Map,
      '_thinkCache.map 必须是 Map');
    assertEqual(typeof inst._thinkCache.stats.hits, 'number', 'stats.hits 应为数字');
    assertEqual(typeof inst._thinkCache.stats.misses, 'number', 'stats.misses 应为数字');
  });

  // ─── ③ 端到端: result 不得是空对象, cache_stats 不得报错 ────
  test('端到端: 七个工具的 result 不得为空', () => {
    const sock = '/tmp/aspira-noparam.sock';
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
    const call = (name) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 15000);
        pending.set(id, m => { clearTimeout(t); resolve(m); });
        conn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }) + '\n');
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

      // 六个接线修复的工具: result 不得是空对象
      for (const tool of Object.keys(WIRING)) {
        const r = await call(tool);
        const c = r.result && r.result.content;
        const j = JSON.parse(c && c[0] ? c[0].text : '{}');
        assertTrue(!j.error, `${tool} 不得返回 error(实测 ${JSON.stringify(j.error)})`);
        const res = j.result;
        const size = res === undefined ? 0 : JSON.stringify(res).length;
        assertTrue(!!res && typeof res === 'object' && Object.keys(res).length > 0,
          `${tool} 的 result 不得是空对象 —— 曾实例化后丢弃，返回 {}`);
      }

      // aspira_cache_stats: 不得再报 cache_not_initialized
      const cs = await call('aspira_cache_stats');
      const c2 = cs.result && cs.result.content;
      const j2 = JSON.parse(c2 && c2[0] ? c2[0].text : '{}');
      assertTrue(!j2.error,
        `aspira_cache_stats 不得返回 error(实测 ${JSON.stringify(j2.error)}) —— _thinkCache 已初始化`);
      assertTrue(!!j2.cache, '应返回 cache 统计');
      assertEqual(typeof j2.cache.hitRate === 'number' || j2.cache.hitRate === null, true,
        'hitRate 应为数字或 null');
    })().catch(e => { cleanup(); if (conn) conn.destroy(); throw e; })
      .then(() => { cleanup(); if (conn) conn.destroy(); });
  });
};
