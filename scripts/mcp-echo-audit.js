#!/usr/bin/env node
/**
 * scripts/mcp-echo-audit.js — 全量扫描"action 只回声不分派"与"schema 未声明参数"
 *
 * ═══ 为什么需要这个脚本 ═══
 * 上轮在 `aspira_forgetting` 上抓到两个缺陷，都是**同一个形状**:
 *   (a) 处理器读了 action 却只把它回声回去，从不分支
 *       → `return { action, stats, timestamp }`
 *   (b) MCP 中央参数校验按 inputSchema.properties 建白名单，
 *       **静默丢弃未声明的参数** → 处理器永远收不到调用方传的参数
 *
 * 这两个都是**静默**的: 工具返回 200、有 action 字段、看起来在工作。
 * `test/mcp-param-contract.test.js` 只做静态源码分析(参数是否被读)，
 * 从不检查 action 是否被分派，且其工具清单只有 9 个工具 ——
 * 连已修的 aspira_knowledge_graph 都不在里面。
 *
 * 本脚本把检查推到**全部 181 个工具**:
 *   · 形态一: `return { action, ... }` 且同一处理器内没有 switch/if 分派
 *   · 形态二: 处理器读了 args.X，但 inputSchema.properties 没有 X
 *
 * ═══ 方法与盲区 ═══
 * **盲区一: 只认 `return { action` 这一种回声写法。** 若处理器写成
 * `return { action: action, ... }` 或先赋值给变量再返回，本脚本看不见。
 * **盲区二: 分派检测靠 switch/if 计数。** 用查找表
 * `const H = { stats: ..., query: ... }; H[action]()` 分派的会被误报。
 * **盲区三: 静态分析，不执行。** 真正的确认要靠端到端调用。
 * **盲区四: 处理器可能是外部文件**(require('./mcp/handlers/x.js'))，
 * 那时只能检查定义处的 schema，无法检查 handler 体。
 *
 * ═══ 已记录的教训 ═══
 * 这是 dimension-health-audit(2次)、dead-counter-audit(2次)、
 * mcp-contract-audit(4次)之后，"仪器把自己的局限说成引擎缺陷"
 * 这一故障模式的第 8 次。因此本脚本:
 *   · 输出一律标注"待查"，每个命中都必须先复现再下结论
 *   · 头部写清四个盲区
 *   · 不断言总数，只报告
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(ROOT, 'src', 'mcp', 'tools-registry.js');
const SERVER = path.join(ROOT, 'src', 'mcp-server.js');

const { TOOLS } = require(REGISTRY);
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const serverLines = serverSrc.split('\n');

// ─── 1. 收集每个工具的处理器体 ────────────────────────────────────────
// 处理器有三种形态:
//   (a) 内联箭头函数: `aspira_xxx: (args) => { ... }`
//   (b) 函数引用:     `aspira_xxx: handleXxx`  → 找 `function handleXxx(` 或
//                    `const handleXxx = (...) => {`
//   (c) 外部文件:     `const handleX = require('./mcp/handlers/x.js')`
// 首版只认 (a)，于是 55 个用 (b) 形态的工具完全没被检查 ——
// 而 aspira_gate* 那类历史缺陷正是出在 (b) 上(调错函数)。仪器缺陷。
//
// ═══ bodyFrom 必须跳过字符串/模板/注释/正则 ═══
// 第二版加上 (b) 后，`handleDecisionRouter` 的函数体被测出 **125,732 字符**，
// 并列出一百多个"未声明参数"——那些其实是**后面无数个 handler 的参数**。
// 原因是朴素的 `{`/`}` 计数被字符串、模板字面量、正则和注释里的花括号带偏，
// 一路吞到了文件末尾。所以下面这个扫描器维护词法状态。
function bodyFrom(src, openBraceIdx) {
  let depth = 1;
  let i = openBraceIdx + 1;
  let state = 'code';   // code | sq | dq | tpl | lineComment | blockComment
  let prev = '';
  // 正则判定用: 前一个有效字符若是这些，则 / 是除法而非正则起始
  const regexOkAfter = /[=(,:[!&|?{;+\-*%<>~^]/;
  let lastSignificant = '';
  while (i < src.length && depth > 0) {
    const c = src[i];
    const next = src[i + 1] || '';
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'lineComment'; i += 2; prev = c; continue; }
      if (c === '/' && next === '*') { state = 'blockComment'; i += 2; prev = c; continue; }
      if (c === "'") { state = 'sq'; i++; prev = c; continue; }
      if (c === '"') { state = 'dq'; i++; prev = c; continue; }
      if (c === '`') { state = 'tpl'; i++; prev = c; continue; }
      // 正则字面量: 只在前一个有效字符允许表达式起始时才算
      if (c === '/' && (lastSignificant === '' || regexOkAfter.test(lastSignificant))) {
        // 尝试吃掉整个正则(不处理字符类里的转义复杂性到极致，但覆盖常见情形)
        let j = i + 1, inClass = false, ok = false;
        for (; j < src.length; j++) {
          const cj = src[j];
          if (cj === '\\') { j++; continue; }
          if (cj === '[') inClass = true;
          else if (cj === ']') inClass = false;
          else if (cj === '/' && !inClass) { ok = true; break; }
          else if (cj === '\n') break;
        }
        if (ok) {
          i = j + 1;
          // 跳过 flags
          while (i < src.length && /[gimsuyd]/.test(src[i])) i++;
          prev = '/'; lastSignificant = '/';
          continue;
        }
      }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
      if (!/\s/.test(c)) lastSignificant = c;
      i++; prev = c; continue;
    }
    if (state === 'sq') {
      if (c === '\\') { i += 2; continue; }
      if (c === "'") state = 'code';
      if (c === '\n') state = 'code';   // 防御: 未闭合
      i++; continue;
    }
    if (state === 'dq') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') state = 'code';
      if (c === '\n') state = 'code';
      i++; continue;
    }
    if (state === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { state = 'code'; i++; continue; }
      // 模板里的 ${ ... } 可能嵌套花括号，按 code 规则处理
      if (c === '$' && next === '{') {
        // 递归处理嵌套表达式
        let d2 = 1, k2 = i + 2;
        while (k2 < src.length && d2 > 0) {
          if (src[k2] === '{') d2++;
          else if (src[k2] === '}') d2--;
          k2++;
        }
        i = k2; continue;
      }
      i++; continue;
    }
    if (state === 'lineComment') {
      if (c === '\n') state = 'code';
      i++; continue;
    }
    if (state === 'blockComment') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
      i++; continue;
    }
  }
  return src.slice(openBraceIdx + 1, i);
}

function extractHandler(toolName) {
  const startRe = new RegExp(`(?:^|\\n)\\s*${toolName}\\s*:\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*\\{`);
  let m = serverSrc.match(startRe);
  if (m) {
    return {
      body: bodyFrom(serverSrc, m.index + m[0].length - 1),
      line: serverSrc.slice(0, m.index).split('\n').length,
    };
  }
  // 形态 (b): 函数引用
  const refRe = new RegExp(`(?:^|\\n)\\s*${toolName}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*[,}]`);
  m = serverSrc.match(refRe);
  if (!m) return null;
  const fnName = m[1];
  const baseLine = serverSrc.slice(0, m.index).split('\n').length;
  // function handleXxx(args) {
  const fnRe = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`);
  let fm = serverSrc.match(fnRe);
  if (fm) {
    return {
      body: bodyFrom(serverSrc, fm.index + fm[0].length - 1),
      line: serverSrc.slice(0, fm.index).split('\n').length,
    };
  }
  // const handleXxx = (args) => {  或  const handleXxx = async (args) => {
  const arrowRe = new RegExp(`(?:const|let|var)\\s+${fnName}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`);
  fm = serverSrc.match(arrowRe);
  if (fm) {
    return {
      body: bodyFrom(serverSrc, fm.index + fm[0].length - 1),
      line: serverSrc.slice(0, fm.index).split('\n').length,
    };
  }
  // 形态 (c): 外部文件
  const extRe = new RegExp(`${fnName}\\s*=\\s*require\\(\\s*['"]([^'"]+)['"]\\s*\\)`);
  const em = serverSrc.match(extRe);
  if (em) {
    const p = path.join(ROOT, 'src', em[1].replace(/^\.\//, ''));
    try {
      const src = fs.readFileSync(p, 'utf8');
      return { body: src, line: baseLine, external: p };
    } catch (e) { return { body: '', line: baseLine, external: p }; }
  }
  return null;
}

// ─── 2. 形态一: action 只回声不分派 ───────────────────────────────────
// 判据: 处理器里出现 `return { action` 或 `return {action`，
//       且**没有** switch 语句、没有 `if (action`/`if(action`、
//       没有 `action ===`/`action ==`/`action !==` 比较、没有查表分派。
function looksLikeEchoOnly(body) {
  if (!/return\s*\{\s*action\b/.test(body)) return false;
  const hasDispatch = /\bswitch\s*\(/.test(body)
    || /\bif\s*\(\s*action\b/.test(body)
    || /action\s*[=!]==?/.test(body)
    || /ACTIONS?\s*\[/.test(body)
    || /\[action\]/.test(body);
  return !hasDispatch;
}

// ─── 3. 形态二: 读了 args.X 但 schema 未声明 ─────────────────────────
function undeclaredParams(tool, body) {
  const declared = new Set(Object.keys((tool.inputSchema && tool.inputSchema.properties) || {}));
  // 处理器里读取的参数形态: args?.X / args.X / args["X"] / const { X } = args
  const read = new Set();
  for (const m of body.matchAll(/args\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) read.add(m[1]);
  for (const m of body.matchAll(/args\s*\[\s*['"]([^'"]+)['"]\s*\]/g)) read.add(m[1]);
  for (const m of body.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*args/g)) {
    for (const part of m[1].split(',')) {
      // `const { action = 'decide' } = args` 的解构**默认值**不是键名。
      // 首版只 split(':')，于是把 `action = 'decide'` 整个当成键名，
      // 报出 5 个假阳性(agentic_memory/executable_reasoning/tom_model/
      // debate/evolutionary_search)——全是正常用法。仪器缺陷。
      const k = part.split('=')[0].split(':')[0].trim();
      if (k) read.add(k);
    }
  }
  // 排除通用非参数键
  const IGNORE = new Set(['action', 'length', 'constructor', 'prototype']);
  return [...read].filter(k => !declared.has(k) && !IGNORE.has(k));
}

// ─── 4. 汇总 ─────────────────────────────────────────────────────────
const echoOnly = [];
const undeclared = [];
const noHandler = [];

for (const tool of TOOLS) {
  const h = extractHandler(tool.name);
  if (!h) { noHandler.push(tool.name); continue; }
  if (looksLikeEchoOnly(h.body)) {
    echoOnly.push({ name: tool.name, line: h.line });
  }
  const un = undeclaredParams(tool, h.body);
  if (un.length) {
    undeclared.push({ name: tool.name, line: h.line, params: un });
  }
}

console.log('\n=== MCP action 回声 / 参数未声明 全量扫描 ===\n');
console.log(`  工具总数: ${TOOLS.length}`);
console.log(`  未在内联处理器中找到定义(可能是外部文件 handler): ${noHandler.length}`);

console.log(`\n  ── 形态一: action 只回声、不分派 (${echoOnly.length}) ──`);
for (const e of echoOnly) {
  console.log(`    src/mcp-server.js:${e.line}  ${e.name}`);
}

console.log(`\n  ── 形态二: 处理器读了参数但 inputSchema 未声明 (${undeclared.length}) ──`);
for (const u of undeclared) {
  console.log(`    src/mcp-server.js:${u.line}  ${u.name}  未声明: ${u.params.join(', ')}`);
}

console.log('\n  盲区(命中≠缺陷，必须先复现):');
console.log('    ① 只认 `return { action` 一种回声写法');
console.log('    ② 查找表分派 H[action]() 会被误报为"未分派"');
console.log('    ③ 静态分析，真正确认要靠端到端 tools/call');
console.log('    ④ 外部文件 handler 只能查 schema，查不到 handler 体\n');

module.exports = { echoOnly, undeclared, noHandler, TOOLS };
