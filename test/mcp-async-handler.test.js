/**
 * test/mcp-async-handler.test.js — 同步 handler 吞 async 结果的形态
 *
 * ═══ 缺陷形态 ═══
 * `aspira_mood` 的 handler 原是**同步**箭头函数:
 *     aspira_mood: (args) => {
 *       const me = new MoodEvolution({ silent: true });
 *       const r = me.process ? me.process(input) : {};   // process 是 async!
 *       return { mood: r, timestamp: Date.now() };
 *     }
 * `MoodEvolution.process` 是 async，于是 `r` 是个 **Promise**。
 * handler 没 await(它也 await 不了，因为它不是 async)，
 * 直接把 Promise 塞进返回对象。MCP 层 JSON.stringify 一个 Promise 得到 `{}`，
 * 所以调用方看到的是 `{ "mood": {} }` —— 一个**看起来合法的空结果**。
 *
 * 实测(修复前): 任何输入，包括"我非常开心今天太棒了"，都返回 `{ mood: {} }`。
 *
 * ═══ 为什么这比"方法不存在"更危险 ═══
 * 方法存在、被调用了、没抛异常、返回结构合法。三层保护都在:
 *   · handler 有 try/catch
 *   · `me.process ? ... : {}` 检查了方法存在性
 *   · 返回值是个对象
 * 没有任何一处会报错，于是这个工具可以安静地什么都不做，直到有人
 * 真的去读 mood 的内容。
 *
 * ═══ 本测试的做法 ═══
 * 测量式，不猜:
 *   1. 直接 require 底层模块，检查 MCP handler 会调用的方法是否 async。
 *   2. 检查 handler 声明是否为 async(源码级，但只查这一处的形状)。
 *   3. 端到端: 调用工具，断言返回体里**没有 Promise 泄漏的痕迹**
 *      (即 mood 不是空对象，且不含 stub 占位以外的空结构)。
 *      注意: 底层是 stub，所以"修好"的标志是能透出 stub 的真实返回，
 *      而不是 `{}`。测试断言的是"不再是空对象"，不断言业务正确性。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));

module.exports = function ({ test, assertEqual, assertTrue }) {

  // ─── 静态: MoodEvolution.process 是 async，handler 必须也是 ────────
  test('aspira_mood 的 handler 必须 async(底层 process 是 async)', () => {
    const { MoodEvolution } = require(path.join(ROOT, 'src', 'emotion', 'mood-evolution.js'));
    const me = new MoodEvolution();
    const r = me.process('probe');
    assertTrue(r instanceof Promise,
      'MoodEvolution.process 应返回 Promise(async 方法) —— 这是缺陷的前提');
    // 清理: 避免 unhandled rejection
    r.catch(() => {});

    // handler 必须声明为 async
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    const m = src.match(/\n {2}aspira_mood\s*:\s*(async\s*)?\(args/);
    assertTrue(!!m, '应能定位 aspira_mood 的 handler');
    assertTrue(!!m[1],
      'aspira_mood 的 handler 必须是 async(底层 process 返回 Promise，同步 handler 会把它静默塞进返回体)');
    assertTrue(/await\s+me\.process/.test(src.slice(src.indexOf('aspira_mood:'), src.indexOf('aspira_mood:') + 700)),
      'handler 必须 await me.process(否则拿到的还是 Promise)');
  });

  // ─── 端到端: mood 不得再是空对象 ─────────────────────────────────
  test('端到端: aspira_mood 返回的 mood 不得是 Promise 泄漏出的空对象', () => {
    const net = require('net');
    const crypto = require('crypto');
    const { spawn } = require('child_process');
    const sock = '/tmp/aspira-async.sock';
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
        pending.set(id, mm => { clearTimeout(t); resolve(mm); });
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
      const r = await call('aspira_mood', { input: '我非常开心今天太棒了' });
      const c = r.result && r.result.content;
      const j = JSON.parse(c && c[0] ? c[0].text : '{}');
      // 关键判据: mood 不得是空对象。
      // 修复前 JSON.stringify(Promise) → {}，故 mood 恒为 {}。
      // 修复后至少能透出底层的真实返回(当前是 stub，会有 reason 字段)。
      assertTrue(j.mood && typeof j.mood === 'object', 'mood 应是对象');
      assertTrue(Object.keys(j.mood).length > 0,
        `mood 不得是空对象(那是 Promise 被 JSON.stringify 吞掉的特征)，实测 ${JSON.stringify(j.mood)}`);
    })().catch(e => { cleanup(); if (conn) conn.destroy(); throw e; })
      .then(() => { cleanup(); if (conn) conn.destroy(); });
  });

  // ─── 静态: 其余同步 handler 不得调用已知 async 的模块方法 ──────────
  test('其余同步 handler 不得吞 async 结果', () => {
    // 上轮实测出的 6 个候选里，只有 aspira_mood 真的泄漏了。
    // 这里锁定那 6 个的现状，将来若哪个改成调用 async 方法而忘了 async，
    // 会被这个测试抓到。
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    // [仪器修正] 首版用"handler 起始后 900 字符内有无 await"判断，
    // 结果把 aspira_memory_bank 的**注释**当成了 await ——
    // 那段注释写的是"recall() 依赖 await load()，同步 handler 里调用只会拿到空结果"，
    // 正是在说明这个陷阱，却被判据当成违例。
    // 修正: 用词法配平取出真实函数体，再在**剥掉注释后**的代码里找 await。
    const bodyFrom = (ob) => {
      let depth = 1, i = ob + 1, state = 'code', last = '';
      const reOk = /[=(,:[!&|?{;+\-*%<>~^]/;
      while (i < src.length && depth > 0) {
        const c = src[i], nx = src[i + 1] || '';
        if (state === 'code') {
          if (c === '/' && nx === '/') { state = 'lineComment'; i += 2; continue; }
          if (c === '/' && nx === '*') { state = 'blockComment'; i += 2; continue; }
          if (c === "'") { state = 'sq'; i++; continue; }
          if (c === '"') { state = 'dq'; i++; continue; }
          if (c === '`') { state = 'tpl'; i++; continue; }
          if (c === '/' && (last === '' || reOk.test(last))) {
            let j = i + 1, inCls = false, ok = false;
            for (; j < src.length; j++) {
              const cj = src[j];
              if (cj === '\\') { j++; continue; }
              if (cj === '[') inCls = true;
              else if (cj === ']') inCls = false;
              else if (cj === '/' && !inCls) { ok = true; break; }
              else if (cj === '\n') break;
            }
            if (ok) { i = j + 1; while (i < src.length && /[gimsuyd]/.test(src[i])) i++; last = '/'; continue; }
          }
          if (c === '{') depth++;
          else if (c === '}') { depth--; if (depth === 0) break; }
          if (!/\s/.test(c)) last = c;
          i++; continue;
        }
        if (state === 'sq' || state === 'dq') {
          if (c === '\\') { i += 2; continue; }
          if (c === "'" || c === '"' || c === '\n') state = 'code';
          i++; continue;
        }
        if (state === 'tpl') {
          if (c === '\\') { i += 2; continue; }
          if (c === '`') { state = 'code'; i++; continue; }
          if (c === '$' && nx === '{') {
            let d2 = 1, k = i + 2;
            while (k < src.length && d2 > 0) { if (src[k] === '{') d2++; else if (src[k] === '}') d2--; k++; }
            i = k; continue;
          }
          i++; continue;
        }
        if (state === 'lineComment') { if (c === '\n') state = 'code'; i++; continue; }
        if (state === 'blockComment') { if (c === '*' && nx === '/') { state = 'code'; i += 2; continue; } i++; continue; }
      }
      return src.slice(ob + 1, i);
    };
    const names = TOOLS.map(t => t.name);
    const bad = [];
    for (const n of names) {
      const re = new RegExp('\\n {2}' + n + '\\s*:\\s*(async\\s*)?\\(args', 'm');
      const m = re.exec(src);
      if (!m) continue;
      const isAsync = !!m[1];
      // 定位函数体的开括号，取配平后的真实 body
      const braceIdx = src.indexOf('{', m.index + m[0].length - 1);
      if (braceIdx < 0) continue;
      const body = bodyFrom(braceIdx);
      // bodyFrom 只做括号配平，**不剥注释**。await 可能出现在注释里
      // (aspira_memory_bank 就有一句"recall() 依赖 await load()…
      //  同步 handler 里调用只会拿到空结果"—— 正是在说明这个陷阱)。
      // 故先把行注释与块注释剔掉，再在纯代码里找 await。
      const codeOnly = body
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');
      if (/\bawait\b/.test(codeOnly) && !isAsync) bad.push(n);
    }
    assertEqual(bad.length, 0,
      `以下 handler 用了 await 却不是 async(必然 SyntaxError 或吞结果): ${bad.join(', ')}`);
  });
};
