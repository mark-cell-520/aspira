/**
 * test/mcp-forgetting-dispatch.test.js — aspira_forgetting 的 action 分派(端到端)
 *
 * ═══ 为什么补这个测试 ═══
 * `src/memory/forgetting.js`(845 行)在 coverage-sweep 里是 **B 类**:
 * 活着(被 src 引用)但没有任何测试引用。它同时挂在 MCP 工具
 * `aspira_forgetting` 上，于是挑它来测。
 *
 * ═══ 当场抓出的真缺陷(两个，同一处) ═══
 *
 * **(a) `aspira_forgetting` 的 action 参数是死的。** 处理器写的是:
 *         const action = args?.action || 'status';
 *         const stats = fe.getStats ? fe.getStats() : {};
 *         return { action, stats, timestamp: Date.now() };
 *     即: **读了 action，只把它回声回去，从不分支。**
 *     端到端实测(action:"compress")返回一份 totalCompressions:0 的 stats ——
 *     什么都没做，而回声让 action 看起来"生效了"。
 *     这正是 AGENTS.md 里 `aspira_knowledge_graph` 已修的形状，那里甚至留着
 *     注释说明"此前读了 action 却只把它回声回去"。而
 *     `test/mcp-param-contract.test.js` 声称钉住了这个模式 —— 它的工具清单里
 *     **既没有 knowledge_graph 也没有 forgetting**，所以两处都漏了过去。
 *     该测试只做静态源码分析(检查参数是否被读)，不检查 action 是否被分派。
 *
 * **(b) 补全 action 后参数仍然到不了处理器。** MCP 中央参数校验
 *     (`[AUDIT-FIX I-2]`)按 `inputSchema.properties` 建白名单，
 *     **静默丢弃未声明的参数**。而 aspira_forgetting 的 schema 只声明了
 *     `action`(enum 还只有 ['status','consolidate'])，所以 memory/memories/
 *     text/threshold/timestamp/updates 全部被丢在处理器之外。
 *     实测: 传了 memory 仍报 "compress 需要 memory"。
 *     这是"声明未读"的镜像缺陷 —— **"读了但没声明"同样致命**，
 *     而它是静默的: 调用方以为传了，处理器永远收不到。
 *
 * ═══ 断言方式 ═══
 * 本测试**真起 server** 走 tools/call，因为这两处都只有端到端能看见。
 * 单条持久连接 + 请求队列: 测试是并发跑的，若每次新开连接，
 * socket server 会只服务其中一个，其余全部 timeout(我第一版正是如此)。
 *
 * ═══ 断言的边界 ═══
 * · 只锁 aspira_forgetting，不重复 knowledge_graph 已有的覆盖。
 * · 不锁 stats 数值: 处理器每次调用都 `new ForgettingEngine()`，
 *   是**无状态新实例**，所以 stats 恒为 0，不能靠它证明执行过。
 *   (我第一版断言 totalCompressions>=1，实测恒 0 —— 断言写错了，不是引擎错。)
 * · 引擎的压缩算法本身不在这里测，只测 MCP 层有没有把参数送到引擎。
 */
const path = require('path');
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SOCK = path.join(os.tmpdir(), `aspira-forget-${process.pid}.sock`);

module.exports = function ({ test, assertEqual, assertTrue }) {
  let proc = null;
  let conn = null;          // 单条持久连接
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}
  let started = false;
  let setupError = null;
  let queue = Promise.resolve();  // 串行化请求

  function waitForSocket(p, timeoutMs) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      (function poll() {
        if (fs.existsSync(SOCK)) return resolve(true);
        if (Date.now() - t0 > timeoutMs) return resolve(false);
        setTimeout(poll, 120);
      })();
    });
  }

  function sendRaw(obj) {
    return new Promise((resolve, reject) => {
      if (!conn) return reject(new Error('连接未建立'));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('timeout'));
      }, 25000);
      pending.set(id, { resolve, reject, timer });
      conn.write(JSON.stringify({ jsonrpc: '2.0', id, ...obj }) + '\n');
    });
  }

  // 所有 tools/call 都排队串行，避免并发写坏帧
  function callTool(name, args) {
    const run = queue.then(() => sendRaw({
      method: 'tools/call', params: { name, arguments: args }
    }));
    // 无论成败都让队列继续
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  const payload = (r) => {
    const res = (r && r.result) || {};
    const text = res.content && res.content[0] ? res.content[0].text : '';
    try { return { json: JSON.parse(text), isError: res.isError === true, text }; }
    catch (e) { return { json: null, isError: res.isError === true, text }; }
  };

  const setup = (async () => {
    try { fs.unlinkSync(SOCK); } catch (_) {}
    proc = spawn('node', [path.join(ROOT, 'src/mcp-server.js'), '--socket', SOCK], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore']
    });
    proc.on('error', e => { setupError = e.message; });
    const ok = await waitForSocket(proc, 25000);
    if (!ok) { setupError = setupError || 'socket 未就绪'; return; }
    // 建一条持久连接，按 id 分派响应
    conn = net.createConnection(SOCK, () => { started = true; });
    let buf = '';
    conn.on('data', d => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    });
    conn.on('error', e => {
      setupError = e.message;
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(e); }
      pending.clear();
    });
    // 等连接真正建立
    for (let i = 0; i < 100 && !started; i++) await new Promise(r => setTimeout(r, 100));
    if (!started) setupError = setupError || '连接未建立';
  })();

  // 收集每个测试返回的 promise，供 teardown 等待。
  // 首版 teardown 只 await setup 就 conn.destroy() + kill server，
  // 于是测试还在跑连接就被拆了，5 条全部 timeout。
  // harness 的 test() 对 async fn 会返回那个 promise，正好可以用来排队。
  const testPromises = [];
  const T = (name, fn) => { testPromises.push(test(name, fn)); };

  const MEM = { id: 'm1', content: 'the quick brown fox jumps over the lazy dog', timestamp: Date.now() };

  T('aspira_forgetting: action 必须真正分派(此前只回声不分支)', async () => {
    await setup;
    assertTrue(started, `server 应启动${setupError ? ': ' + setupError : ''}`);
    if (!started) return;

    const r = payload(await callTool('aspira_forgetting', { action: 'compress', memory: MEM }));
    assertTrue(!r.isError, `compress 不应报错: ${r.text.slice(0, 160)}`);
    assertTrue(!!r.json, '应返回可解析 JSON');
    assertEqual(r.json.action, 'compress', 'action 应被回声');
    assertTrue(!!r.json.result, '必须有 result 字段 —— 缺陷形态是只有 action+stats 没有 result');
    const c = r.json.result.compressed || r.json.result;
    assertTrue(!!c && (c.forgettingLevel || c.compression !== undefined || c.id),
      `compress 应返回引擎产物，实测 ${JSON.stringify(r.json.result).slice(0, 160)}`);
  });

  T('aspira_forgetting: memory 参数必须真的到达处理器(中央校验白名单曾丢弃它)', async () => {
    await setup;
    if (!started) return;
    // 若 inputSchema 未声明 memory，中央校验会静默丢弃，
    // 处理器看到的 args.memory 是 undefined，于是报"需要 memory"。
    const r = payload(await callTool('aspira_forgetting', { action: 'compress', memory: MEM }));
    assertTrue(!/需要 memory/.test(r.text),
      `memory 必须到达处理器(中央校验白名单缺陷)，实测 ${r.text.slice(0, 160)}`);
    // 同样检查 memories 与 threshold
    const r2 = payload(await callTool('aspira_forgetting', {
      action: 'consolidate', memories: [MEM]
    }));
    assertTrue(!/需要 memories/.test(r2.text),
      `memories 必须到达处理器，实测 ${r2.text.slice(0, 160)}`);
    const r3 = payload(await callTool('aspira_forgetting', {
      action: 'check', memory: MEM, threshold: 0.5
    }));
    assertTrue(!/需要 memory/.test(r3.text),
      `threshold 不得导致 memory 丢失，实测 ${r3.text.slice(0, 160)}`);
  });

  T('aspira_forgetting: 各 action 均真正分派并返回专属结果键', async () => {
    await setup;
    if (!started) return;
    for (const [action, args] of [
      ['retrieve', { memory: MEM }],
      ['check', { memory: MEM, threshold: 0.5 }],
      ['consolidate', { memories: [MEM] }],
      ['compressBatch', { memories: [MEM] }],
      ['consolidateBatch', { memories: [MEM] }],
      ['level', { timestamp: Date.now() }],
      ['abstract', { text: 'some long text to abstract here' }],
      ['health', {}],
      ['oscillation', {}],
      ['config', {}],
      ['stats', {}],
    ]) {
      const r = payload(await callTool('aspira_forgetting', { action, ...args }));
      assertTrue(!r.isError, `${action} 不应报错: ${r.text.slice(0, 140)}`);
      assertTrue(!!r.json, `${action} 应返回 JSON`);
      assertTrue(!r.json.error, `${action} 不应返回 error: ${r.text.slice(0, 140)}`);
      const own = Object.keys(r.json).filter(k => !['action', 'timestamp'].includes(k));
      assertTrue(own.length > 0,
        `${action} 必须有专属结果键(实测键: ${Object.keys(r.json).join(',')}) —— 只有 action 说明没分派`);
    }
  });

  T('aspira_forgetting: 未知 action 显式报错，不静默回退成 stats', async () => {
    await setup;
    if (!started) return;
    const r = payload(await callTool('aspira_forgetting', { action: 'no-such-action' }));
    assertTrue(!!r.json && !!r.json.error, `未知 action 应显式报错，实测 ${r.text.slice(0, 140)}`);
    assertTrue(/未知 action/.test(r.json.error), '错误信息应说明是未知 action');
    assertTrue(!r.json.stats, '未知 action 不得回退成 stats');
  });

  T('aspira_forgetting: 缺必填参数时显式报错', async () => {
    await setup;
    if (!started) return;
    const r1 = payload(await callTool('aspira_forgetting', { action: 'compress' }));
    assertTrue(!!r1.json && !!r1.json.error, `compress 缺 memory 应报错，实测 ${r1.text.slice(0, 140)}`);
    const r2 = payload(await callTool('aspira_forgetting', { action: 'consolidate' }));
    assertTrue(!!r2.json && !!r2.json.error, `consolidate 缺 memories 应报错，实测 ${r2.text.slice(0, 140)}`);
    const r3 = payload(await callTool('aspira_forgetting', { action: 'abstract' }));
    assertTrue(!!r3.json && !!r3.json.error, `abstract 缺 text 应报错，实测 ${r3.text.slice(0, 140)}`);
  });

  // teardown 必须等**所有测试**结算后再拆连接。
  // await setup 只保证 server 起来了，不保证测试跑完。
  const teardown = (async () => {
    await setup;
    await Promise.all(testPromises.map(p => Promise.resolve(p).catch(() => undefined)));
    if (conn) { try { conn.destroy(); } catch (_) {} }
    if (proc) { try { proc.kill('SIGTERM'); } catch (_) {} }
    try { fs.unlinkSync(SOCK); } catch (_) {}
  })();
  const _keep = teardown.then(() => true).catch(() => false);
};
