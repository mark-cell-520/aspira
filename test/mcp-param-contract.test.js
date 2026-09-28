/**
 * test/mcp-param-contract.test.js — MCP 参数契约与 stub 防护
 *
 * 背景：`aspira_formula_search` 曾声明 `query` 而 handler 只读 `keyword`，
 * 调用方按文档传 query，拿到的是 "keyword required" 报错。更早之前还有
 * handler 定义了两次、后者静默覆盖前者，以及对象字面量少一个花括号吞掉
 * 下一个工具字段——三类都是**静默**损坏，没有任何测试叫住。
 *
 * 本测试锁两件事：
 *   A. 审计脚本本身是对的。它在开发过程中产出过两轮假阳性(不认
 *      `const input = args || {}` 别名、不认 `const { a, b } = args` 解构)，
 *      一度把 23 个健康工具报成"声明未读"。若这些惯用法再次回归成假阳性，
 *      这里会失败——否则下一个人会照着错误报告去"修"没坏的工具。
 *   B. 两个已修复的 stub 不得退化成空壳。aspira_lesson_search 曾永远
 *      return { lessons: [] }，aspira_memory_bank 曾 return { result: {} }：
 *      工具声明了参数、描述声称有能力，实际什么都不做。调用方无法区分
 *      "没有匹配"和"这工具没实现"——比报错更糟。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');

// 与 scripts/audit-mcp-param-contract.js 同一套读取识别逻辑(独立实现，
// 故意不共用代码：共用就失去了交叉校验的意义)
//
// ═══ 本文件的五次修正(每一次都是它自己的缺陷，不是被测对象的) ═══
// 首版只覆盖 2 个工具，detectReads 也只认 `args?.X`。扩到全部 181 个工具后，
// 同一函数接连暴露五类缺陷，累计报出 25 + 7 + 4 + 4 处，**逐个人工复现后
// 全部是假阳性或定位错误**，没有一个是引擎缺陷:
//   ① 不认 `const { a, b } = args` 解构 → 23 个健康工具被报"声明未读"
//   ② 不认 `const input = args || {}` 别名 → 同上
//   ③ 把 `decision.type`(对象字段)与 `String(x).trim()`(原型方法)当成参数
//   ④ 解构正则用 `[^{}]{0,300}`，匹配不到 `const { domain, params = {} } = args`
//      —— 默认值本身是对象字面量(formula_bridge/formula_calc 四处)
//   ⑤ 别名收集把 `const decision = args?.decision || {}` 也算成别名，
//      于是 decision 的四个字段全被当成 args 参数(decision_feedback)
// 另有一处独立缺陷: handlerBodyOf/bodyFrom 用朴素 `{`/`}` 配平，
// 被字符串/模板/正则/注释里的花括号带偏，会把函数体测到文件末尾
// (mcp-echo-audit 首版同款，实测把 handleDecisionRouter 测成 125,732 字符)。
// 现已统一改为词法状态扫描。
// 这是 dimension-health(2)/dead-counter(2)/mcp-contract(4)/mcp-echo(3)/
// gate-pipeline-mode(1) 之后，同一故障模式的第 12-17 次。
// **教训不是"别写静态分析"，而是"静态扫描报出的每一处都必须先复现再下结论"。**
//
// 本测试锁两类事:
//   A. 审计判据本身是对的(上述惯用法不得回归成假阳性，
//      且必须能抓到故意制造的违背 —— 没有牙齿的审计等于没有审计)。
//   B. 契约在全量 181 个工具上成立:
//      · schema 声明的参数，handler 必须读(整对象透传除外)
//      · handler 读的参数，schema 必须声明(否则被中央校验静默丢弃)
//      · 有 action enum 的，handler 必须真的分支(不得只回声)
//
// ═══ 第四类缺陷: 整对象透传被误报成"声明未读" ═══
// 扩到全部 181 个工具后，一次报出 25 个"声明未读"参数:
//   aspira_consciousness.neuralStates/content、aspira_audit_trace.traceId/
//   agentId/stage/limit、aspira_retention_log.event/severity/...、
//   aspira_outbound_ledger.tool/traceId/...、aspira_formula_bridge.domain/
//   params、aspira_check_outbound.text/classification ...
// 逐个复现后发现**全部是假阳性**。这些 handler 的写法是**整对象透传**:
//     return { consciousness: CT.compute(args || {}), ... };
//     return queryChain(args || {});
//     logger.log(args);  logger.query(args);
//     return checkOutbound(args || {});
// 参数确实生效，只是不经过 `args.X` 显式读取，而是把整个 args 交给底层。
// 这与"读了但没声明"是**相反**的方向: 这里声明的都读了，只是读法不同。
// 对策: 识别 `f(args)` / `f(args || {})` 形态，出现即视为"全部已声明参数均已读取"。
// 这是 dimension-health(2)/dead-counter(2)/mcp-contract(4)/mcp-echo(3)/
// gate-pipeline-mode(1) 之后，同一故障模式的第 12 次。
function detectReads(body) {
  const reads = new Set();
  // [仪器修正·第五类] 别名收集正则原本是
  //   /(?:const|let|var)\s+(\w+)\s*=\s*args\s*(?:\|\||\?\?)?/
  // 它把 `const decision = args?.decision || {}` 也登记成别名 ——
  // 因为 `args\s*(?:\|\||\?\?)?` 之后没要求结束，`?.decision` 被无视。
  // 后果: `decision.type` / `decision.ruleId` / `decision.confidence` /
  // `decision.context` 全被当成 args 上的参数报出来(aspira_decision_feedback)。
  // 修正: 别名必须是**整体**拿到 args(右侧只有 args、args || {} 、args ?? {})，
  // 取某个字段的(`args?.X`)不是别名。
  const aliases = ['args'];
  for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*args\s*(?:\|\||\?\?)\s*\{?\s*\}?\s*(?:;|$|\n)/gm)) {
    if (!aliases.includes(m[1])) aliases.push(m[1]);
  }
  // 单独的 `const x = args;`(无 ||)
  for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*args\s*;/g)) {
    if (!aliases.includes(m[1])) aliases.push(m[1]);
  }
  const alt = aliases.join('|');
  for (const a of aliases) {
    // 属性读: `a?.X` 或 `a.X`。X 后面**不能**紧跟 `(`(那是方法调用，
    // 如 x.trim() / s.slice()，不是从 args 取参数)。
    for (const m of body.matchAll(new RegExp(`\\b${a}\\s*(?:\\?\\.|\\s*\\.\\s*)\\s*([A-Za-z_$][\\w$]*)\\s*(?!\\()`, 'g'))) reads.add(m[1]);
    // 下标读: a['X'] / a["X"]
    for (const m of body.matchAll(new RegExp(`\\b${a}\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]`, 'g'))) reads.add(m[1]);
  }
  // 解构读: `const { a, b = {} } = args`。
  // [仪器修正] 首版正则用 `[^{}]{0,300}` 限定花括号内内容，于是
  // `const { domain, params = {} } = args` 这种**默认值本身是对象字面量**的
  // 解构完全匹配不到 —— aspira_formula_bridge.domain/params 与
  // aspira_formula_calc.formula/variables 四处"声明未读"全是这个原因。
  // 改为允许嵌套一层花括号。
  for (const m of body.matchAll(new RegExp(`\\{((?:[^{}]|\\{[^{}]*\\}){0,300})\\}\\s*=\\s*(?:${alt})\\b`, 'g'))) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) reads.add(name);
    }
  }
  // 整对象透传: `f(args)` / `f(args || {})` / `f(args, x)`。
  // 此时底层自行取字段，静态扫描不可能知道它读了哪些 —— 标记之。
  const passthrough = new RegExp(`\\(\\s*(?:${alt})\\s*(?:\\|\\||\\?\\?)?\\s*(?:\\{\\s*\\})?\\s*[,)]`).test(body);
  return { reads, passthrough };
}

// ═══ handlerBodyOf 的配平缺陷(本测试自己的，已修) ═══
// 首版(以及 scripts/mcp-echo-audit.js 首版)用朴素 `{`/`}` 计数。
// 一旦函数体里出现字符串、模板字面量、正则或注释中的花括号，配平就被带偏，
// 一路吞到文件末尾。实测后果: `handleDecisionRouter` 的函数体被测成
// **125,732 字符**，并据此列出一百多个"未声明参数"——那些其实是
// 后面几十个 handler 的参数。下面改用词法状态扫描。
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
    if (state === 'lineComment') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'blockComment') { if (c === '*' && nx === '/') { state = 'code'; i += 2; continue; } i++; continue; }
  }
  return src.slice(openBraceIdx + 1, i);
}

function handlerBodyOf(name) {
  const inline = new RegExp(`\\n {2}${name}\\s*:\\s*(?:async\\s*)?\\(args[^)]*\\)\\s*=>\\s*\\{`, 'm');
  const m = inline.exec(serverSrc);
  if (m) return bodyFrom(serverSrc, m.index + m[0].length - 1);
  const named = new RegExp(`\\n {2}${name}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*,`, 'm').exec(serverSrc);
  if (!named) return null;
  const fn = named[1];
  // 外部文件式 handler: const handleX = require('./mcp/handlers/x.js');
  // 不跟随 require 就永远定位不到——aspira_crowdtest_evaluate 就是这样漏掉的。
  const rq = new RegExp(`const\\s+${fn}\\s*=\\s*require\\(\\s*['"]([^'"]+)['"]\\s*\\)`).exec(serverSrc);
  if (rq) {
    try { return fs.readFileSync(path.join(ROOT, 'src', rq[1].replace(/^\.\//, '')), 'utf8'); }
    catch (_) { return null; }
  }
  const decl = new RegExp(`function\\s+${fn}\\s*\\(`).exec(serverSrc);
  if (!decl) return null;
  let i = decl.index + decl[0].length;
  while (i < serverSrc.length && serverSrc[i] !== '{') i++;
  return bodyFrom(serverSrc, i);
}

// detectReads 返回 { reads, passthrough }(见上文第四类缺陷说明)。
// 这个适配器让旧调用点无需改动 —— 它们只关心 reads。
function readsOf(body) {
  const r = detectReads(body);
  return r && r.reads ? r.reads : r;
}

module.exports = function ({ test, assertEqual, assertTrue, assertDefined }) {

  test('每个工具都有可定位的 handler', () => {
    // 定位不到就无法审计——覆盖缺口本身就是风险
    const missing = [];
    for (const t of TOOLS) if (!handlerBodyOf(t.name)) missing.push(t.name);
    assertEqual(missing.length, 0, `无法定位 handler: ${missing.join(', ')}`);
  });

  test('lesson_search / memory_bank 不再是空壳 stub', () => {
    // 曾经的形态: aspira_lesson_search return { lessons: [], note: '教训库检索' }
    //            aspira_memory_bank  return { result: {} }
    // 两者都声明了参数却什么都不做。断言它们调用了底层真实方法。
    const ls = handlerBodyOf('aspira_lesson_search');
    assertTrue(/\.retrieve\s*\(|\.getTopN\s*\(/.test(ls),
      'aspira_lesson_search 应调用 retrieve/getTopN，而非返回空数组');
    assertTrue(!/lessons:\s*\[\]\s*,\s*note/.test(ls),
      'aspira_lesson_search 不得退化成 return { lessons: [], note } 形态');

    const mb = handlerBodyOf('aspira_memory_bank');
    assertTrue(/\.deposit\s*\(/.test(mb), 'aspira_memory_bank 应调用 deposit');
    assertTrue(!/const r = \{\};\s*\n\s*return \{ result: r/.test(mb),
      'aspira_memory_bank 不得退化成 return { result: {} } 形态');
  });

  test('lesson_search 的 schema 与实现一致', () => {
    const t = TOOLS.find(x => x.name === 'aspira_lesson_search');
    const props = Object.keys(t.inputSchema.properties);
    const reads = readsOf(handlerBodyOf('aspira_lesson_search'));
    for (const p of props) {
      assertTrue(reads.has(p), `schema 声明了 ${p} 但 handler 不读`);
    }
    assertTrue(props.includes('query'), 'lesson_search 应声明 query');
  });

  test('memory_bank 的 schema 与实现一致', () => {
    const t = TOOLS.find(x => x.name === 'aspira_memory_bank');
    const props = Object.keys(t.inputSchema.properties);
    const reads = readsOf(handlerBodyOf('aspira_memory_bank'));
    for (const p of props) {
      assertTrue(reads.has(p), `schema 声明了 ${p} 但 handler 不读`);
    }
    assertTrue(props.includes('memory'), 'memory_bank 应声明 memory');
    assertTrue(props.includes('action'), 'memory_bank 应声明 action');
  });

  test('supervise 家族与 formula_search 的隐藏参数已声明', () => {
    // 此前 handler 读 input.history / input.multiSource / input.userIntent、
    // handleFormulaSearch 读 keyword/limit，schema 都没声明——调用方无从知道能传。
    const expect = {
      aspira_supervise_dao: ['history'],
      aspira_supervise_uncertainty: ['multiSource'],
      aspira_supervise_progress: ['userIntent'],
      aspira_formula_search: ['keyword', 'limit'],
      aspira_false_positive: ['trace'],
      aspira_decision_feedback: ['outcome', 'notes'],
    };
    for (const [name, params] of Object.entries(expect)) {
      const t = TOOLS.find(x => x.name === name);
      assertTrue(!!t, `${name} 未注册`);
      for (const p of params) {
        assertTrue(p in t.inputSchema.properties, `${name} 应声明参数 ${p}(handler 实际读取它)`);
      }
    }
  });

  test('审计脚本对惯用法不产假阳性', () => {
    // 这是本测试的核心防护。开发中该审计两轮把健康工具报成"声明未读"：
    // 第一轮不认 const { a, b } = args 解构，第二轮不认 const input = args || {} 别名。
    const fakeBody = `
      const input = args || {};
      const { query, limit } = args;
      const other = args;
      return { a: input.text, b: other.data, c: query, d: limit || 5 };
    `;
    const reads = readsOf(fakeBody);
    for (const p of ['text', 'data', 'query', 'limit']) {
      assertTrue(reads.has(p), `审计应识别 ${p} 被读取(惯用法覆盖)`);
    }
  });

  test('审计脚本能发现故意制造的契约违背', () => {
    // 没有牙齿的审计等于没有审计。造一个"声明了不读"的 handler，必须被检出。
    const badBody = `const { onlyThis } = args || {}; return { r: onlyThis };`;
    const declared = ['declaredButUnused', 'onlyThis'];
    const reads = readsOf(badBody);
    const unused = declared.filter(d => !reads.has(d));
    assertEqual(unused.length, 1, '应检出 1 个声明未读参数');
    assertEqual(unused[0], 'declaredButUnused', '检出的应是那个未使用的参数');
  });

  test('工具定义无重复、全部有 handler', () => {
    const names = TOOLS.map(t => t.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    assertEqual(dup.length, 0, `重复工具名: ${dup.join(', ')}`);
    assertEqual(names.length, 181, `工具数应为 181，实测 ${names.length}`);
  });

  // ═══════════════════════════════════════════════════════════════════
  // 全量契约检查: 从 2 个工具推到全部 181 个
  // ═══════════════════════════════════════════════════════════════════
  // 本测试文件名曰 "param-contract"，但**曾经只覆盖 2 个工具**
  // (lesson_search / memory_bank)，8 个断言里只有 2 个真检查 schema 一致性。
  // 后果是两轮真实缺陷从它眼前走过:
  //   · aspira_knowledge_graph 的 action 只回声(已修)
  //   · aspira_forgetting 的 action 只回声 + 8 个参数未声明(已修)
  // 而文件头注释声称它"钉住空壳 stub 模式"——名不副实。
  // 下面把两类检查推到全量。判据只用**已由人工复核过**的形状，
  // 且每个断言都带"如何复现"信息，避免把仪器局限说成引擎缺陷。

  // ── 检查一(全量): schema 声明的参数，handler 必须真的读 ────────────
  test('全量: schema 声明的每个参数都必须被 handler 读取', () => {
    // 曾经的形态: aspira_formula_search 声明 query 而 handler 只读 keyword，
    // 调用方按文档传 query 拿到 "keyword required"。
    // [仪器修正] 首版把**整对象透传**误报成"声明未读"——25 处，全部假阳性:
    //   aspira_consciousness → CT.compute(args || {})
    //   aspira_audit_trace   → queryChain(args || {})
    //   aspira_retention_log → logger.log(args) / logger.query(args)
    //   aspira_check_outbound→ checkOutbound(args || {})
    // 参数确实生效，只是交给底层自行取字段，静态扫描不可能知道读了哪些。
    // 故透传形态视为"已读取"，跳过逐参数核对。
    const bad = [];
    for (const t of TOOLS) {
      const props = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
      if (!props.length) continue;
      const body = handlerBodyOf(t.name);
      if (!body) { bad.push(`${t.name}(handler 定位不到)`); continue; }
      const d = detectReads(body);
      if (d.passthrough) continue;   // 整对象透传，无法静态核对，交端到端冒烟负责
      const reads = d.reads;
      for (const p of props) {
        if (p === 'action') continue;   // action 由 dispatch 检查负责
        if (!reads.has(p)) bad.push(`${t.name}.${p}`);
      }
    }
    assertEqual(bad.length, 0,
      `以下 schema 声明的参数没有被 handler 读取(调用方按文档传了也没用): ${bad.join(', ')}`);
  });

  // ── 检查二(全量): handler 读的参数，schema 必须声明 ────────────────
  test('全量: handler 读取的参数都必须在 schema 声明(否则被中央校验静默丢弃)', () => {
    // 曾经的形态: MCP 中央参数校验按 inputSchema.properties 建白名单，
    // **静默丢弃**未声明参数。handler 读了 args.memory 而 schema 只有 action，
    // 于是调用方传的 memory 永远到不了处理器。
    // 上一周期据此修了 5 处: emotion_dynamics.intensity、
    // skill_evolution.execution、confidence_calibrate.correct、
    // gate_pipeline.mode、crowdtest_evaluate.requiredCounts/runGate。
    // [仪器修正] 首版把对象字段与原型方法误报成参数(decision.type / x.trim())，
    // 已通过"属性后不能跟 (" 与"要求别名独占一段"两条规则排除。
    const IGNORE = new Set(['action', 'length', 'constructor', 'prototype']);
    const bad = [];
    for (const t of TOOLS) {
      const props = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
      const body = handlerBodyOf(t.name);
      if (!body) continue;
      const d = detectReads(body);
      if (d.passthrough) continue;   // 透传时静态读集无意义
      for (const k of d.reads) {
        if (IGNORE.has(k)) continue;
        if (!props.includes(k)) bad.push(`${t.name}.${k}`);
      }
    }
    assertEqual(bad.length, 0,
      `以下 handler 读取的参数未在 schema 声明(会被中央校验静默丢弃): ${bad.join(', ')}`);
  });

  // ── 检查三(全量): 有 action enum 的工具，handler 必须分支 ──────────
  test('全量: 有 action enum 的工具，handler 必须真的分支(不得只回声)', () => {
    // 曾经的形态: `const action = args?.action || 'status';
    //              const stats = fe.getStats();
    //              return { action, stats, timestamp }` —— 读了 action 却只回声，
    // 请求 action:"compress" 返回一份 totalCompressions:0 的 stats，
    // 什么都没做，而回声让 action *看起来*生效了。
    // 判据: 同一处理器内必须出现 switch、`if (action`、`action ===` 比较，
    // 或查表 `ACTIONS[` / `[action]` 分派之一。
    const bad = [];
    for (const t of TOOLS) {
      const props = (t.inputSchema && t.inputSchema.properties) || {};
      if (!(props.action && props.action.enum && props.action.enum.length)) continue;
      const body = handlerBodyOf(t.name);
      if (!body) { bad.push(`${t.name}(handler 定位不到)`); continue; }
      // [仪器修正·第六类] 判据原先只认字面 `action`:
      //   /\bif\s*\(\s*action\b/ 与 /action\s*[=!]==?/
      // 于是 handler 把操作键改名成别的变量(如 `const op = args.action`)
      // 就报"只回声" —— 而它明明分支了，只是变量不叫 action。
      // aspira_outbound_ledger 就这么写(为避开与底层 action 过滤字段
      // 撞名，见 src/mcp-server.js 的 [契约修复] 注释)。
      // 修正: 先收集"从 args.action 取值的变量名"，再允许其中任意一个
      // 出现在分支里。字面 action 本身也在集合中(兼容绝大多数 handler)。
      const opVars = new Set(['action']);
      for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*args\s*(?:\?\.|\.)\s*action\b/g)) {
        opVars.add(m[1]);
      }
      // 也认 `const { action: op = 'query' } = args` 的解构改名
      for (const m of body.matchAll(/\{([^{}]{0,200})\}\s*=\s*args\b/g)) {
        for (const part of m[1].split(',')) {
          const mm = part.match(/^\s*action\s*:\s*([A-Za-z_$][\w$]*)/);
          if (mm) opVars.add(mm[1]);
        }
      }
      const opAlt = [...opVars].map(v => v.replace(/\$/g, '\\$')).join('|');
      const dispatched = /\bswitch\s*\(/.test(body)
        || new RegExp(`\\bif\\s*\\(\\s*(?:${opAlt})\\b`).test(body)
        || new RegExp(`\\b(?:${opAlt})\\s*[=!]==?`).test(body)
        || /ACTIONS?\s*\[/.test(body)
        || new RegExp(`\\[\\s*(?:${opAlt})\\s*\\]`).test(body);
      if (!dispatched) bad.push(t.name);
    }
    assertEqual(bad.length, 0,
      `以下工具声明了 action enum 但 handler 未分支(只回声): ${bad.join(', ')}`);
  });

  // ── 检查四: 上面三个检查的仪器必须能抓到故意制造的违背 ────────────
  test('全量检查的判据能抓到故意制造的三种契约违背', () => {
    // 没有牙齿的审计等于没有审计。三个判据各造一个反例。
    const echoBody = `const action = args?.action || 'status'; const s = x.getStats(); return { action, stats: s, timestamp: Date.now() };`;
    const dispatched = /\bswitch\s*\(/.test(echoBody) || /\bif\s*\(\s*action\b/.test(echoBody)
      || /action\s*[=!]==?/.test(echoBody) || /ACTIONS?\s*\[/.test(echoBody) || /\[action\]/.test(echoBody);
    assertTrue(!dispatched, '回声型 handler 必须被判为"未分派"');

    const unreadBody = `const { onlyThis } = args || {}; return { r: onlyThis };`;
    const r1 = readsOf(unreadBody);
    assertTrue(!r1.has('declaredButUnused'), '应能检出"声明未读"');

    const undeclaredBody = `const a = args || {}; return { r: a.hiddenParam };`;
    const r2 = readsOf(undeclaredBody);
    assertTrue(r2.has('hiddenParam'), '应能检出"读了但未声明"');
  });

  // ── 检查五: 仪器不得把对象字段/原型方法当成参数(第三类假阳性) ─────
  test('detectReads 不得把对象字段与原型方法当成 args 参数', () => {
    // 这是 detectReads 的第三类缺陷，扩到全量时交叉校验才发现:
    // aspira_decision_feedback 被报出 [type,ruleId,confidence,context]
    // —— 那全是 decision **对象**的字段; aspira_memory_bank 被报出 [trim]
    // —— 那是 String.prototype.trim() 方法调用。
    const body = `
      const decision = args?.decision || {};
      const r = fb.recordOutcome({ type: decision.type, ruleId: decision.ruleId, confidence: decision.confidence });
      const s = String(x).trim();
      const q = args?.query;
      return { r, q };
    `;
    const reads = readsOf(body);
    assertTrue(reads.has('query'), '应识别真正的参数 query');
    assertTrue(!reads.has('type'), '不得把 decision.type(对象字段)当成 args 参数');
    assertTrue(!reads.has('ruleId'), '不得把 decision.ruleId(对象字段)当成 args 参数');
    assertTrue(!reads.has('confidence'), '不得把 decision.confidence(对象字段)当成 args 参数');
    assertTrue(!reads.has('trim'), '不得把 String(x).trim()(原型方法)当成 args 参数');
  });
};
