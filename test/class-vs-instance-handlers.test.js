/**
 * test/class-vs-instance-handlers.test.js — 在类对象上调用实例方法
 *
 * ═══ 缺陷形态(本轮一次抓到 4 处) ═══
 * MCP handler 从 `./index.js` 解构出一个名字，然后直接在上面调方法:
 *
 *     const { metacognition } = require('./index.js');
 *     return metacognition.evaluate(args.output || '');   // ← 抛
 *
 * 但 `index.js` 的 `metacognition` 是 `{ MetacognitiveReward }` ——
 * 一个**类**，而 `evaluate()` 是该类的**实例方法**(第 39 行)。
 * 在类对象上调实例方法，恒定抛
 * `metacognition.evaluate is not a function`。
 *
 * 同型缺陷共 4 处，全部由哨兵法
 * (scripts/module-field-consumer-audit.js)的"基线即报错"列表暴露:
 *   ① aspira_metacognition_evaluate → metacognition.evaluate
 *   ② aspira_debate                → debateEngine.createSession
 *   ③ aspira_tom_model             → tomEngine.modelAgent
 *   ④ aspira_executable_reasoning  → executableReasoning.parseThoughtChain
 *
 * ═══ 为什么危险 ═══
 * 与 cycle-36 的 Promise 泄漏同族: **没有任何一处会报错给调用方之外**。
 * handler 有 try/catch，抛出的 TypeError 被吞成 `{ error: '...' }`，
 * 一个结构完全合法的响应。工具从上线起就从未工作过，
 * 而 schema 照旧声明着它的能力。
 *
 * ═══ 修法 ═══
 * 先实例化再调用。对有状态的引擎(debate/tom)用惰性缓存挂在
 * globalThis 上，否则每次调用重建实例会让会话立刻丢失。
 *
 * ═══ 本测试锁什么 ═══
 * ① 四个 handler 都做了实例化(源码级)
 * ② 端到端四个工具都不再返回 error
 * ③ 全仓扫: 任何 `X.method(` 而 X 是类导出(其键含首字母大写的类名)的形态
 *    —— 这条是回归防线，将来新增同类缺陷会被抓到
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));

// 本轮修好的四个工具与其引擎键
const FIXED = [
  { tool: 'aspira_metacognition_evaluate', engineKey: 'metacognition', className: 'MetacognitiveReward', sample: { output: '这是一个测试输出' } },
  { tool: 'aspira_debate', engineKey: 'debateEngine', className: 'DebateEngine', sample: { action: 'create', topic: '是否应该引入自动化测试' } },
  { tool: 'aspira_tom_model', engineKey: 'tomEngine', className: 'ToMEngine', sample: { action: 'model', agentId: 'probe-agent', observations: ['他说会按时完成'] } },
  { tool: 'aspira_executable_reasoning', engineKey: 'executableReasoning', className: 'ExecutableReasoning', sample: { action: 'parse', raw: '1. 先分析问题\n2. 再验证结论' } },
];

module.exports = function ({ test, assertEqual, assertTrue }) {

  // ─── ① 四个 handler 都实例化了 ─────────────────────────────────
  test('四个 handler 必须先实例化引擎再调用', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    for (const f of FIXED) {
      const i = src.indexOf(f.tool + ':');
      assertTrue(i >= 0, `应能定位 ${f.tool}`);
      // 取到下一个工具定义前
      let j = src.indexOf('\n  aspira_', i + 10);
      if (j < 0) j = i + 3000;
      const body = src.slice(i, j);
      assertTrue(new RegExp('const\\s+\\w+\\s*=\\s*' + f.engineKey + '\\s*&&\\s*' + f.engineKey + '\\.' + f.className).test(body),
        `${f.tool} 必须解构出类 ${f.engineKey}.${f.className}`);
      assertTrue(/new\s+(?:DE|TE|ER|MR)\s*\(/.test(body),
        `${f.tool} 必须实例化(new DE/TE/ER/MR())，不得在类对象上直接调实例方法`);
      // 不得再残留 `engineKey.method(` 形态(注释与 typeof 检查除外)
      const calls = body.split('\n').filter(l =>
        new RegExp('\\b' + f.engineKey + '\\.[a-zA-Z_]\\w*\\s*\\(').test(l) &&
        !/^\s*\/\//.test(l) &&
        !/typeof/.test(l) &&
        !/const\s+\w+\s*=/.test(l));
      assertEqual(calls.length, 0,
        `${f.tool} 不得残留类对象调用(实测 ${calls.map(c => c.trim()).join(' | ')})`);
    }
  });

  // ─── ② 端到端四个工具都可用 ───────────────────────────────────
  test('端到端: 四个工具不再返回 error', () => {
    const net = require('net');
    const crypto = require('crypto');
    const { spawn } = require('child_process');
    const sock = '/tmp/aspira-class-inst.sock';
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
      for (const f of FIXED) {
        const r = await call(f.tool, f.sample);
        const c = r.result && r.result.content;
        const j = JSON.parse(c && c[0] ? c[0].text : '{}');
        assertTrue(!j.error,
          `${f.tool} 不得返回 error(实测 ${JSON.stringify(j.error)}) —— 类对象调实例方法的缺陷已修`);
      }
    })().catch(e => { cleanup(); if (conn) conn.destroy(); throw e; })
      .then(() => { cleanup(); if (conn) conn.destroy(); });
  });

  // ─── ③ 回归防线: 全仓扫同类形态 ───────────────────────────────
  test('回归防线: 不得有 handler 在类导出对象上直接调实例方法', () => {
    // 判据: index.js 的解构对象，其导出是 { ClassName } 形态(唯一键首字母大写)，
    // 而 handler 里出现 `obj.lowerCaseMethod(` —— 即把类当命名空间用。
    const idx = require(path.join(ROOT, 'src', 'index.js'));
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    const offenders = [];
    for (const key of Object.keys(idx)) {
      const val = idx[key];
      if (!val || typeof val !== 'object') continue;
      const keys = Object.keys(val);
      if (keys.length !== 1) continue;
      const only = keys[0];
      // 唯一键首字母大写 → 这是个类导出
      if (!/^[A-Z]/.test(only)) continue;
      if (typeof val[only] !== 'function') continue;
      // 该类的实例方法
      const proto = val[only].prototype;
      if (!proto) continue;
      const methods = Object.getOwnPropertyNames(proto).filter(m => m !== 'constructor');
      if (!methods.length) continue;
      // 在 mcp-server.js 里找 `key.method(` 形态
      for (const m of methods) {
        const re = new RegExp('\\b' + key + '\\.' + m + '\\s*\\(', 'g');
        let mm;
        while ((mm = re.exec(src)) !== null) {
          // 排除: 注释行、typeof 检查、解构行
          const lineStart = src.lastIndexOf('\n', mm.index) + 1;
          const line = src.slice(lineStart, src.indexOf('\n', mm.index));
          if (/^\s*\/\//.test(line)) continue;
          if (/typeof/.test(line)) continue;
          if (/const\s+\w+\s*=/.test(line)) continue;
          offenders.push(`${key}.${m}()`);
        }
      }
    }
    assertEqual(offenders.length, 0,
      `以下调用把类导出当命名空间用(应改为先实例化): ${[...new Set(offenders)].join(', ')}`);
  });

  // ─── ④ 模块数量与 schema 一致性(新增两个 bridge 模块) ──────────
  test('新增的两个 bridge 模块可独立加载', () => {
    const { StanceDetector } = require(path.join(ROOT, 'src', 'bridge', 'stance-detector.js'));
    const { ConflictResolver } = require(path.join(ROOT, 'src', 'bridge', 'conflict-resolver.js'));
    const sd = new StanceDetector();
    const cr = new ConflictResolver();
    assertEqual(sd.detect('我完全同意').stance, 'support', '支持应判 support');
    assertEqual(sd.detect('我完全同意').counts.oppose, 0, '支持文本不得出现反对信号');
    // 探针须满足 SELF_CONTRADICT 的 2-40 字要求(实测「虽然快，但是…」过短不命中)
    assertEqual(cr.resolve('虽然这样做看起来快，但是实际上无法解决根本问题').conflict, true, '应检出自我矛盾');
    assertEqual(cr.resolve('今天天气很好，我去公园散步').conflict, false, '普通陈述不应报冲突');
  });

  // ─── ⑤ 第 5 处同型缺陷(回归防线当场抓到的) ────────────────────
  test('第 5 处: aspira_agentic_memory 也已实例化', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    const i = src.indexOf('aspira_agentic_memory:');
    let j = src.indexOf('\n  aspira_', i + 10);
    if (j < 0) j = i + 3000;
    const body = src.slice(i, j);
    assertTrue(/const\s+AM\s*=\s*agenticMemory\s*&&\s*agenticMemory\.AgenticMemoryEngine/.test(body),
      '必须解构出 agenticMemory.AgenticMemoryEngine');
    assertTrue(/new\s+AM\s*\(/.test(body), '必须实例化(new AM())');
    const calls = body.split('\n').filter(l =>
      /\bagenticMemory\.[a-zA-Z_]\w*\s*\(/.test(l) &&
      !/^\s*\/\//.test(l) && !/typeof/.test(l) && !/const\s+\w+\s*=/.test(l));
    assertEqual(calls.length, 0,
      `不得残留类对象调用(实测 ${calls.map(c => c.trim()).join(' | ')})`);
  });
};
