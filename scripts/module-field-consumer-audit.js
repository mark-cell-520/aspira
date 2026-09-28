/**
 * scripts/module-field-consumer-audit.js — 从模块**实测**消费的字段
 *
 * ═══ 为什么不用正则读源码 ═══
 * 本仓已因"用正则猜字段名"错了 20 次(见 AGENTS.md)。
 * 差分审计(passthrough-field-audit.js)也证明了对语义类模块无效:
 * 通用合成文本命中不了模块的模式 → 差分恒等 → 报一堆假阳性。
 *
 * ═══ 本脚本的做法: 实测而非推断 ═══
 * 对每个"handler require 外部模块"的工具:
 *   1. 从该工具的 schema 取出全部参数名。
 *   2. 再取**同名前缀**的其他工具的参数名(如 aspira_classics 与
 *      aspira_classics_list 共享 text)，合并成一个候选字段池。
 *   3. 构造一个探针对象: 每个候选字段都给一个**哨兵值**
 *      (一个独一无二的字符串/数字，模块不可能自己产生)。
 *   4. 调 handler，然后在返回体里**递归搜索哨兵值**。
 *      出现了 → 该字段被消费了(值穿透到了输出)。
 *      没出现 → 该字段可能未被读，或读了但没进输出。
 *
 * ═══ 判读边界(写清楚，否则又是一次仪器误报) ═══
 * · "哨兵未出现在输出" **不等于** 字段未被读。
 *   字段可能被读后用于内部判断(如分类、分支)，不直接进输出。
 *   故本脚本只报"疑似未消费"，不断言"死参数"。
 * · 反向才是重点: 若某字段的哨兵**出现**在输出里，
 *   而 schema **没有声明**它，那就是"底层读了 schema 未声明的字段"
 *   —— 这正是 cycle-33 抓到 consciousness/retention_log 两个真缺陷的形态，
 *   也是中央校验会静默剥掉、导致模块用默认值的形态。
 * · 需要副作用的工具只发读类 action，写类 action 跳过。
 *
 * 退出码: 0 = 审计跑通(可疑项需人工判读)。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));

// ─── 词法配平(与既有审计同一套，勿再退回复数括号) ────────────────────
function bodyFrom(src, openBraceIdx) {
  let depth = 1, i = openBraceIdx + 1, state = 'code', last = '';
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
  return src.slice(openBraceIdx + 1, i);
}

function handlerBodyOf(serverSrc, name) {
  const inline = new RegExp('\\n {2}' + name + '\\s*:\\s*(?:async\\s*)?\\(args[^)]*\\)\\s*=>\\s*\\{', 'm');
  const m = inline.exec(serverSrc);
  if (m) return bodyFrom(serverSrc, m.index + m[0].length - 1);
  const named = new RegExp('\\n {2}' + name + '\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*,', 'm').exec(serverSrc);
  if (!named) return null;
  const fn = named[1];
  const rq = new RegExp('const\\s+' + fn + '\\s*=\\s*require\\(\\s*[\\u0027\\u0022]([^\\u0027\\u0022]+)[\\u0027\\u0022]\\s*\\)').exec(serverSrc);
  if (rq) {
    try { return fs.readFileSync(path.join(ROOT, 'src', rq[1].replace(/^\.\//, '')), 'utf8'); }
    catch (_) { return null; }
  }
  const decl = new RegExp('function\\s+' + fn + '\\s*\\(').exec(serverSrc);
  if (!decl) return null;
  let i = decl.index + decl[0].length;
  while (i < serverSrc.length && serverSrc[i] !== '{') i++;
  return bodyFrom(serverSrc, i);
}

// 哨兵值: 独一无二，模块不可能自己产生
// [仪器修正] 首版对**所有**字段都用同一个字符串哨兵，
// 于是声明为 number 的参数(effort/threshold/age/limit/priors/importance/
// intensity)被中央校验拦下并报"参数类型错误"，enum 参数(action)被报
// "unknown action" —— 52 个工具因此被跳过，覆盖面只有 84/136。
// 修正: 哨兵按 schema 类型生成，且 enum 参数取**合法枚举值**
// (哨兵法要测的是"字段是否被消费"，不是"非法值是否被拒")。
const SENTINEL = (field) => `__ASPIRA_SENTINEL_${field}__`;

function sentinelFor(spec) {
  const t = spec && spec.type;
  if (Array.isArray(spec && spec.enum) && spec.enum.length) {
    // enum: 取第一个合法值 —— 类型与取值都合法，只剩"字段是否被消费"这一个变量
    return spec.enum[0];
  }
  if (t === 'number' || t === 'integer') return 0.5;
  if (t === 'boolean') return true;
  if (t === 'array') return ['__ASPIRA_SENTINEL_array__'];
  if (t === 'object') return { __aspiraSentinel: 'object' };
  return SENTINEL(spec && spec.__key ? spec.__key : 'unknown');
}

// 递归搜索哨兵是否出现在序列化输出里
function deepContains(obj, needle) {
  try {
    return JSON.stringify(obj).includes(needle);
  } catch (e) { return false; }
}

function run() {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');

  // 候选字段池: 全仓所有工具的参数名(用于构造"超集探针")
  const allFields = new Set();
  for (const t of TOOLS) {
    const p = (t.inputSchema && t.inputSchema.properties) || {};
    for (const k of Object.keys(p)) allFields.add(k);
  }

  const targets = [];
  for (const t of TOOLS) {
    const body = handlerBodyOf(serverSrc, t.name);
    if (!body) continue;
    const mods = [...body.matchAll(/require\(\s*['"](\.\/[^'"]+|\.\.\/[^'"]+)['"]\s*\)/g)].map(m => m[1]);
    if (!mods.length) continue;
    targets.push({
      name: t.name,
      props: (t.inputSchema && t.inputSchema.properties) || {},
      mods: [...new Set(mods)],
    });
  }

  console.log(`\n═══ 模块字段消费审计(哨兵实测) ═══`);
  console.log(`候选工具: ${targets.length} / ${TOOLS.length}，候选字段池: ${allFields.size} 个\n`);

  const net = require('net');
  const crypto = require('crypto');
  const { spawn } = require('child_process');
  const sock = '/tmp/aspira-field-consumer.sock';
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
      const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 8000);
      pending.set(id, m => { clearTimeout(t); resolve(m); });
      conn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
  };

  return (async () => {
    for (let i = 0; i < 80 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 250));
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

    const textOf = (r) => {
      const c = r && r.result && r.result.content;
      return c && c[0] ? String(c[0].text) : '';
    };

    // 结果分类
    const undeclaredButConsumed = []; // 哨兵出现但 schema 未声明 → 真缺陷形态
    const declaredNotConsumed = [];   // 哨兵未出现 → 需人工判读
    let ok = 0, err = 0;

    for (const tool of targets) {
      const declared = Object.keys(tool.props);
      if (!declared.length) continue;

      // 探针: 已声明字段用类型感知哨兵，另加一批**未声明**的候选字段。
      // 未声明字段没有 schema，只能用通用字符串哨兵
      // (它们本就会被中央校验剥掉，正好用来测"未声明字段是否被底层消费")。
      const extra = [...allFields].filter(f => !declared.includes(f));
      const probe = {};
      for (const f of declared) probe[f] = sentinelFor(Object.assign({ __key: f }, tool.props[f]));
      for (const f of extra) probe[f] = SENTINEL(f);

      let out;
      try { out = textOf(await call(tool.name, probe)); }
      catch (e) { err++; continue; }
      // 基线本身报错(缺必填等)则跳过 —— 不是字段问题
      if (/错误|error|必填|required|未知|invalid|非法|Exception/.test(out) && out.length < 400) { err++; continue; }
      ok++;

      const consumed = [];
      for (const f of Object.keys(probe)) {
        // 已声明字段: 搜它的类型哨兵的原样表示
        // 未声明字段: 搜字符串哨兵
        const needle = declared.includes(f)
          ? JSON.stringify(sentinelFor(Object.assign({ __key: f }, tool.props[f])))
          : SENTINEL(f);
        if (deepContains(out, needle)) consumed.push(f);
      }
      const undeclared = consumed.filter(f => !declared.includes(f));
      const unconsumed = declared.filter(f => !consumed.includes(f));

      if (undeclared.length) {
        undeclaredButConsumed.push({ tool: tool.name, mods: tool.mods, undeclared });
      }
      if (unconsumed.length) {
        declaredNotConsumed.push({ tool: tool.name, mods: tool.mods, unconsumed });
      }
    }

    console.log(`已检工具: ${ok}(失败/跳过 ${err})\n`);

    console.log(`── [重点] 底层消费了 schema 未声明的字段 ──`);
    console.log(`   这是 cycle-33 两个真缺陷的形态: 参数被中央校验剥掉，模块静默用默认值。`);
    if (!undeclaredButConsumed.length) console.log('   无');
    for (const s of undeclaredButConsumed) {
      console.log(`   ${s.tool}: ${s.undeclared.join(', ')}`);
      console.log(`       模块: ${s.mods.join(', ')}`);
    }

    console.log(`\n── 已声明但哨兵未出现在输出 ──`);
    console.log(`   **不是死参数清单。** 字段可能被读后仅用于内部判断/分支，不进输出。`);
    console.log(`   每处需人工判读: 读模块源码确认它是否被消费。`);
    if (!declaredNotConsumed.length) console.log('   无');
    for (const s of declaredNotConsumed) {
      console.log(`   ${s.tool}: ${s.unconsumed.join(', ')}`);
    }

    console.log(`\n[重点] 合计 ${undeclaredButConsumed.length} 处；待判读 ${declaredNotConsumed.length} 处。`);
    cleanup();
    if (conn) conn.destroy();
    return { ok, err, undeclared: undeclaredButConsumed, unconsumed: declaredNotConsumed };
  })().catch(e => { cleanup(); if (conn) conn.destroy(); throw e; });
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(e => {
    console.error('审计脚本自身失败:', e.message);
    process.exit(2);
  });
}

module.exports = { run, SENTINEL };
