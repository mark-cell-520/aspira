/**
 * scripts/audit-mcp-param-contract.js — MCP 工具参数契约审计
 *
 * 查什么：handler 实际读取的参数，与 tools-registry 声明的参数是否一致。
 *
 * 为什么：aspira_formula_search 曾声明 query、handler 却读 keyword——调用方按
 * 文档传 query，拿到的是空结果而不是报错。这是最危险的失败模式：**给出错误答案
 * 而不是报错**。上一轮只修了那一个，没有系统排查过其余 180 个。
 *
 * 两类不一致：
 *   A. 声明了但 handler 从不读 —— 文档误导调用方，参数静默无效
 *   B. handler 读但未声明 —— 调用方无从知道可以传，能力被隐藏
 *
 * C 类需人工判断，不算缺陷：args?.x || args?.y 这种别名兜底是**有意的**
 * (formula_search 现在就靠它兼容 keyword)，工具整体收 args 再转发也是常见形态。
 *
 * 用法: node scripts/audit-mcp-param-contract.js [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');

// 从 handler 源码里抽出它读取过的参数名
function readsOf(body) {
  const reads = new Set();

  // 第一步：找出 args 的所有本地别名。
  //   const input = args || {};   ← supervise_* 家族全是这个惯用法
  //   const a = args;
  // 首版不认这个惯用法，于是把 23 个健康的工具报成"声明未读"。
  // 审计工具自己产出假阳性，比没有审计更危险——它会让人去修没坏的东西。
  const aliases = ['args'];
  for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*args\s*(?:\|\||\?\?)?/g)) {
    if (!aliases.includes(m[1])) aliases.push(m[1]);
  }
  const aliasAlt = aliases.join('|');

  // 第二步：对每个别名，收集 X.prop / X?.prop / X["prop"]
  for (const a of aliases) {
    for (const m of body.matchAll(new RegExp(`\\b${a}\\s*(?:\\?\\.|\\s*\\.\\s*)\\s*([A-Za-z_$][\\w$]*)`, 'g'))) reads.add(m[1]);
    for (const m of body.matchAll(new RegExp(`\\b${a}\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]`, 'g'))) reads.add(m[1]);
  }

  // 第三步：解构，两个方向都要覆盖：
  //   const { a, b } = args;      ← 花括号在 = 之前(handleThink 就是这种)
  //   const { a, b } = input;     ← 花括号在 = 之前 + 别名
  for (const m of body.matchAll(new RegExp(`\\{([^{}]{0,300})\\}\\s*=\\s*(?:${aliasAlt})\\b`, 'g'))) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) reads.add(name);
    }
  }

  // 整体转发: someFn(args) —— 无法静态判断，标记为透传
  const passthrough = new RegExp(`\\b(?:require\\([^)]*\\)|[A-Za-z_$.]+)\\s*\\(\\s*(?:${aliasAlt})\\s*(?:\\|\\||\\?\\?|\\?\\.[A-Za-z_$]+)?\\s*[,)]`).test(body);
  return { reads, passthrough };
}

// 取某个 handler 的函数体：从 "name: (args) => {" 到配平的花括号
function bodyOf(name) {
  const re = new RegExp(`\\n {2}${name}\\s*:\\s*(?:async\\s*)?\\(args[^)]*\\)\\s*=>\\s*\\{`, 'm');
  const m = re.exec(serverSrc);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < serverSrc.length && depth > 0) {
    const c = serverSrc[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return serverSrc.slice(start, i - 1);
}

// 命名函数式注册: "aspira_think: handleThink," → 找 function handleThink( 的函数体。
// 首版只匹配内联箭头，于是 53 个命名函数式 handler 全被报成"无法定位"，
// 审计实际只覆盖 125/181——覆盖缺口本身就是个诚实的失败。
function bodyOfNamed(name) {
  const regRe = new RegExp(`\\n {2}${name}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*,`, 'm');
  const rm = regRe.exec(serverSrc);
  if (!rm) return null;
  const fnName = rm[1];
  // 外部文件式 handler: const handleX = require('./mcp/handlers/x.js');
  // 不跟随 require 就永远定位不到它——aspira_crowdtest_evaluate 就是这样
  // 从审计里漏掉的。
  const reqRe = new RegExp(`const\\s+${fnName}\\s*=\\s*require\\(\\s*['"]([^'"]+)['"]\\s*\\)`);
  const rq = reqRe.exec(serverSrc);
  if (rq) {
    const abs = path.join(ROOT, 'src', rq[1].replace(/^\.\//, ''));
    try { return fs.readFileSync(abs, 'utf8'); } catch (_) { return { missing: `${fnName}(${rq[1]})` }; }
  }
  const fnRe = new RegExp(`(?:function\\s+${fnName}\\s*\\(|\\b${fnName}\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\()`, 'm');
  const fm = fnRe.exec(serverSrc);
  if (!fm) return { missing: fnName };
  // 从函数声明处找第一个 { 并配平
  let i = fm.index + fm[0].length;
  while (i < serverSrc.length && serverSrc[i] !== '{') {
    // 箭头函数可能直接返回表达式: handleX = (args) => args.y
    if (serverSrc[i] === '>' && serverSrc[i + 1] !== '=') break;
    i++;
  }
  if (serverSrc[i] !== '{') return { arrowExpr: serverSrc.slice(i, Math.min(i + 200, serverSrc.length)) };
  i++;
  let depth = 1;
  const start = i;
  while (i < serverSrc.length && depth > 0) {
    const c = serverSrc[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return serverSrc.slice(start, i - 1);
}

const rows = [];
for (const t of TOOLS) {
  const declared = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
  let body = bodyOf(t.name);
  let via = 'inline';
  if (!body) {
    const nb = bodyOfNamed(t.name);
    if (typeof nb === 'string') { body = nb; via = 'named'; }
    else if (nb && nb.arrowExpr) { body = nb.arrowExpr; via = 'named-arrow-expr'; }
    else if (nb && nb.missing) { rows.push({ tool: t.name, declared, reads: [], status: 'no_handler_body', note: `未找到函数 ${nb.missing}` }); continue; }
  }
  if (!body) { rows.push({ tool: t.name, declared, reads: [], status: 'no_handler_body' }); continue; }
  const { reads, passthrough } = readsOf(body);
  const readArr = [...reads];
  const unused = declared.filter(d => !reads.has(d));
  const undeclared = readArr.filter(r => !declared.includes(r));
  rows.push({
    tool: t.name, declared, reads: readArr, via,
    unused, undeclared,
    passthrough,
    status: (!unused.length && !undeclared.length) ? 'ok' : 'mismatch',
  });
}

const mismatch = rows.filter(r => r.status === 'mismatch');
const noBody = rows.filter(r => r.status === 'no_handler_body');
// 别名兜底/透传不算缺陷：读多个参数但只声明一个，或整体转发
const SUSPECT = mismatch.filter(r => !r.passthrough && !(r.reads.length > r.declared.length));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: TOOLS.length, mismatch: mismatch.length, rows }, null, 2));
} else {
  console.log('=== MCP 参数契约审计 ===');
  console.log(`工具总数: ${TOOLS.length} | 参数不一致: ${mismatch.length} | 无法定位 handler: ${noBody.length}`);
  if (noBody.length) {
    console.log('\n--- 无法定位 handler 函数体(需人工确认) ---');
    for (const r of noBody) console.log(`  ${r.tool}`);
  }
  if (mismatch.length) {
    console.log('\n--- 声明与读取不一致 ---');
    for (const r of mismatch) {
      const tags = [];
      if (r.unused.length) tags.push(`声明未读: ${r.unused.join(',')}`);
      if (r.undeclared.length) tags.push(`读取未声明: ${r.undeclared.join(',')}`);
      if (r.passthrough) tags.push('(整体转发，别名兜底属正常)');
      console.log(`  ${r.tool}`);
      console.log(`      ${tags.join(' | ')}`);
    }
  }
  const ok = rows.filter(r => r.status === 'ok').length;
  console.log(`\n完全一致: ${ok} | 不一致: ${mismatch.length} | 其中疑似真问题: ${SUSPECT.length}`);
}
