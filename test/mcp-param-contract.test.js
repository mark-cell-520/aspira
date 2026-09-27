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
function detectReads(body) {
  const reads = new Set();
  const aliases = ['args'];
  for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*args\s*(?:\|\||\?\?)?/g)) {
    if (!aliases.includes(m[1])) aliases.push(m[1]);
  }
  for (const a of aliases) {
    for (const m of body.matchAll(new RegExp(`\\b${a}\\s*(?:\\?\\.|\\s*\\.\\s*)\\s*([A-Za-z_$][\\w$]*)`, 'g'))) reads.add(m[1]);
  }
  for (const m of body.matchAll(new RegExp(`\\{([^{}]{0,300})\\}\\s*=\\s*(?:${aliases.join('|')})\\b`, 'g'))) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) reads.add(name);
    }
  }
  return reads;
}

function handlerBodyOf(name) {
  const inline = new RegExp(`\\n {2}${name}\\s*:\\s*(?:async\\s*)?\\(args[^)]*\\)\\s*=>\\s*\\{`, 'm');
  const m = inline.exec(serverSrc);
  if (m) {
    let i = m.index + m[0].length, depth = 1;
    const start = i;
    while (i < serverSrc.length && depth > 0) {
      if (serverSrc[i] === '{') depth++;
      else if (serverSrc[i] === '}') depth--;
      i++;
    }
    return serverSrc.slice(start, i - 1);
  }
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
  i++;
  let depth = 1;
  const start = i;
  while (i < serverSrc.length && depth > 0) {
    if (serverSrc[i] === '{') depth++;
    else if (serverSrc[i] === '}') depth--;
    i++;
  }
  return serverSrc.slice(start, i - 1);
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
    const reads = detectReads(handlerBodyOf('aspira_lesson_search'));
    for (const p of props) {
      assertTrue(reads.has(p), `schema 声明了 ${p} 但 handler 不读`);
    }
    assertTrue(props.includes('query'), 'lesson_search 应声明 query');
  });

  test('memory_bank 的 schema 与实现一致', () => {
    const t = TOOLS.find(x => x.name === 'aspira_memory_bank');
    const props = Object.keys(t.inputSchema.properties);
    const reads = detectReads(handlerBodyOf('aspira_memory_bank'));
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
    const reads = detectReads(fakeBody);
    for (const p of ['text', 'data', 'query', 'limit']) {
      assertTrue(reads.has(p), `审计应识别 ${p} 被读取(惯用法覆盖)`);
    }
  });

  test('审计脚本能发现故意制造的契约违背', () => {
    // 没有牙齿的审计等于没有审计。造一个"声明了不读"的 handler，必须被检出。
    const badBody = `const { onlyThis } = args || {}; return { r: onlyThis };`;
    const declared = ['declaredButUnused', 'onlyThis'];
    const reads = detectReads(badBody);
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
};
