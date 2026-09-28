/**
 * test/mcp-passthrough-fields.test.js — 透传工具的**字段级**契约
 *
 * ═══ 为什么 param-contract 覆盖不到这一类 ═══
 * `test/mcp-param-contract.test.js` 已扩到全部 181 个工具，判据是
 * "schema 声明的参数 handler 必须读 / handler 读的参数 schema 必须声明"。
 * 但它扫描的是 **handler 函数体**。对整对象透传的工具:
 *     return { consciousness: CT.compute(args || {}), ... };
 *     logger.log(args);   logger.query(args);
 * handler 体里根本不出现那些字段名 —— 字段在**底层模块**里被读取。
 * 所以 param-contract 对这类工具只能跳过(它也确实跳过了，并披露为盲区)。
 *
 * 本轮在这个盲区里抓到两个缺陷，都是同一形态:
 *     **底层模块读写的字段，schema 没声明。**
 * 参数能到 handler(透传嘛)，却在 schema 层就被中央校验拦掉，
 * 调用方**无法传入**，底层永远用默认值。
 *
 * ═══ 缺陷一: aspira_consciousness 少了三个参数 ═══
 * `ConsciousnessTheory.compute(input)` 读 5 个顶层字段:
 *   input.neuralStates / input.content / input.priors /
 *   input.sensoryInput / input.self
 * 而 schema 只声明了 neuralStates 和 content。
 * 端到端实测: 传 priors:0.1 与 priors:0.9 返回**完全相同**的
 * PredictiveProcessing(predictionError 恒为 0) ——
 * 因为两个值都没能穿过 schema，底层用的是默认 0.5。
 * (predictionError = sensoryInput - priors = 0.5 - 0.5 = 0，永远为 0。)
 *
 * ═══ 缺陷二: aspira_retention_log 少了 actor ═══
 * `RetentionLogger.log(entry)` 写 7 个字段，其中 actor 来自 entry.actor，
 * 缺省 'system'。schema 没声明它，于是调用方无法指定操作者 ——
 * 审计追溯永远落在 'system' 头上。这比 priors 那类更隐蔽:
 * 不是"算得不对"，而是"归属丢了"。
 *
 * ═══ 本测试的做法 ═══
 * 不用正则猜字段名(本仓已因这类猜测错了 18 次)，而是:
 *   1. 直接 require 底层模块，用**真实调用**读出它消费哪些字段
 *      —— 给一个全字段探针对象，看哪些值出现在结果里。
 *   2. 断言 schema 覆盖这些字段。
 * 对 write 路径(log/record)则用"写入后读回"验证。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));

module.exports = function ({ test, assertEqual, assertTrue, assertDefined }) {

  // ─── consciousness: compute() 读的字段必须都在 schema 上 ────────────
  test('aspira_consciousness 的 schema 必须覆盖 compute() 实际读取的字段', () => {
    // 注意: 导出的是**对象字面量**而非类(`const ConsciousnessTheory = {`),
    // handler 也是直接 `CT.compute(...)` 不 new。这里跟着实际形状走。
    const CT = require(path.join(ROOT, 'src', 'consciousness', 'consciousness-theory.js'));
    assertEqual(typeof CT.compute, 'function', 'CT.compute 必须是函数');
    // 探针: 每个字段给一个可区分的值
    const probe = {
      neuralStates: [0.9, 0.1, 0.5],
      content: 5,
      priors: 0.9,
      sensoryInput: 0.1,
      self: { preReflective: 0.9, reflective: 0.1, forMeNess: 0.9, selfEvident: 0.1 },
    };
    const r = CT.compute(probe);
    assertDefined(r, 'compute 应返回结果');

    // 用"改变字段 → 结果改变"反推 compute 真的消费了它。
    // 这比读源码猜字段名可靠(本仓因静态猜测错了 18 次)。
    const baseline = CT.compute(Object.assign({}, probe, { priors: 0.5, sensoryInput: 0.5 }));
    const ppMoved = JSON.stringify(r.PredictiveProcessing) !== JSON.stringify(baseline.PredictiveProcessing);
    assertTrue(ppMoved,
      'priors / sensoryInput 必须真的影响 PredictiveProcessing(否则探针无效)');

    const scMoved = JSON.stringify(r.SelfConsciousness) !== JSON.stringify(
      CT.compute(Object.assign({}, probe, { self: { preReflective: 0.5, reflective: 0.5, forMeNess: 0.5, selfEvident: 0.5 } })).SelfConsciousness);
    assertTrue(scMoved, 'self 必须真的影响 SelfConsciousness(否则探针无效)');

    // 真正的断言: schema 必须声明这些字段
    const t = TOOLS.find(x => x.name === 'aspira_consciousness');
    const props = Object.keys(t.inputSchema.properties || {});
    for (const f of ['neuralStates', 'content', 'priors', 'sensoryInput', 'self']) {
      assertTrue(props.includes(f),
        `aspira_consciousness 必须声明 ${f}(compute() 读它，未声明则调用方传不进来)`);
    }
  });

  // ─── retention_log: log() 写的字段必须可被调用方指定 ────────────────
  test('aspira_retention_log 的 schema 必须覆盖 log() 写入的调用方可控字段', () => {
    const { RetentionLogger } = require(path.join(ROOT, 'src', 'retention-logger.js'));
    // 用隔离目录，避免污染真实日志
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-fields-'));
    const logger = new RetentionLogger('audit', { logDir: dir });
    logger.log({ event: 'probe', severity: 'critical', actor: 'agent-x', details: { k: 1 }, traceId: 't-1' });
    const rows = logger.query({});
    assertEqual(rows.length, 1, '应写入 1 条');
    const row = rows[0];
    assertEqual(row.actor, 'agent-x', 'log() 必须原样写下 actor');
    assertEqual(row.severity, 'critical', 'log() 必须原样写下 severity');
    assertTrue(row.details && row.details.k === 1, 'log() 必须原样写下 details');

    // 真正的断言: schema 必须声明 actor(此前缺失，审计归属恒为 system)
    const t = TOOLS.find(x => x.name === 'aspira_retention_log');
    const props = Object.keys(t.inputSchema.properties || {});
    assertTrue(props.includes('actor'),
      'aspira_retention_log 必须声明 actor(log() 写它，未声明则调用方无法指定，审计归属恒为 system)');
    assertTrue(props.includes('severity'), 'aspira_retention_log 必须声明 severity');
    assertTrue(props.includes('details'), 'aspira_retention_log 必须声明 details');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ─── 端到端: 补上之后参数必须真的生效 ─────────────────────────────
  test('端到端: consciousness 的 priors 现在能改变结果(修复前两种取值结果相同)', () => {
    const net = require('net');
    const crypto = require('crypto');
    const { spawn } = require('child_process');
    const sock = '/tmp/aspira-ptc-fields.sock';
    const token = crypto.randomBytes(16).toString('hex');
    const proc = spawn('node', ['src/mcp-server.js', '--socket', sock], {
      cwd: ROOT, env: { ...process.env, ASPIRA_MCP_TOKEN: token }, stdio: 'ignore',
    });
    const cleanup = () => {
      try { proc.kill(); } catch (e) {}
      try { fs.unlinkSync(sock); } catch (e) {}
    };
    let conn = null;
    let nextId = 1;
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
      const probe = async (priors, sensoryInput) => {
        const r = await call('aspira_consciousness', {
          neuralStates: [0.5, 0.5, 0.5], content: 5, priors, sensoryInput,
        });
        const c = r.result && r.result.content;
        return JSON.parse(c && c[0] ? c[0].text : '{}').consciousness;
      };
      const a = await probe(0.1, 0.9);
      const b = await probe(0.9, 0.1);
      // 修复的关键判据: 两种取值必须不同(修复前完全相同，因为都被 schema 拦掉)
      assertTrue(JSON.stringify(a.PredictiveProcessing) !== JSON.stringify(b.PredictiveProcessing),
        `priors/sensoryInput 必须改变 PredictiveProcessing，实测两者相同: ${JSON.stringify(a.PredictiveProcessing)}`);
      // predictionError = sensoryInput - priors，应能取到非 0
      const pe = a.PredictiveProcessing.predictionError;
      assertTrue(pe !== 0, `predictionError 应能非 0(修复前恒为 0)，实测 ${pe}`);
    })().catch(e => { cleanup(); if (conn) conn.destroy(); throw e; })
      .then(() => { cleanup(); if (conn) conn.destroy(); });
  });
};
