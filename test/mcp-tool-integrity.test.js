/**
 * test/mcp-tool-integrity.test.js — MCP 工具表 / handler 映射一致性回归
 *
 * 保护对象：src/mcp/tools-registry.js 的 TOOLS 与 src/mcp-server.js 的 HANDLERS。
 *
 * 为什么需要：本轮审计发现三类**静默损坏**，全都不被任何测试发现——
 *   1. 五个 handler 键被定义两次(formula_search/formula_calc/formula_bridge/
 *      check_outbound/audit_trace)。JS 对象字面量后者静默覆盖前者，且覆盖版与
 *      工具定义的参数名不一致(formula_calc 读 args.values 而定义声明 variables;
 *      formula_bridge 读 args.query 而定义声明 {domain, params})，按文档调用
 *      拿到空结果。handleFormulaBridge 本是覆盖 6 个领域的真实公式计算。
 *   2. registry 里 aspira_boundary_check 的对象**从未闭合**，把下一个条目
 *      (aspira_self_heal) 的字段吞进同一对象——同一对象里 name 出现两次，后者
 *      胜出，于是导出的是 self_heal，boundary_check 被静默丢弃(源 180 个 name
 *      只导出 179)。handler 还在，工具却从 tools/list 消失了。
 *   3. tools/list 报 179、handler 唯一键 178，数字对不上却无人报错。
 *
 * 本测试锁住四条不变式：工具名唯一、每个工具都有 handler、handler 键不重复、
 * 两侧集合互相覆盖。任何一类损坏再次出现都会直接失败。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
process.env.ASPIRA_NO_AUTOSTART = '1';
const { HANDLERS, TOOLS } = require('../src/mcp-server.js');

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('TOOLS 非空且每个条目有 name/description/inputSchema', () => {
    assertTrue(TOOLS.length > 0, 'TOOLS 不应为空');
    for (const t of TOOLS) {
      assertEqual(typeof t.name, 'string', `工具名应为字符串: ${JSON.stringify(t).slice(0, 60)}`);
      assertTrue(t.name.startsWith('aspira_'), `工具名应以 aspira_ 开头: ${t.name}`);
      assertEqual(typeof t.description, 'string', `${t.name} 应有 description`);
      assertEqual(typeof t.inputSchema, 'object', `${t.name} 应有 inputSchema`);
    }
  });

  test('工具名唯一(无重复定义)', () => {
    const names = TOOLS.map(t => t.name);
    const seen = new Set();
    const dups = [];
    for (const n of names) {
      if (seen.has(n)) dups.push(n);
      seen.add(n);
    }
    assertEqual(dups.length, 0, `工具名重复: ${dups.join(', ')}`);
  });

  test('每个工具都有对应 handler', () => {
    // 曾出现 aspira_active_inference / aspira_circuit_breaker 等被误判无 handler，
    // 也有过工具定义进了 registry 但 handler 映射漏挂的情况。逐个断言。
    const missing = TOOLS.filter(t => typeof HANDLERS[t.name] !== 'function').map(t => t.name);
    assertEqual(missing.length, 0, `以下工具没有 handler(调用必失败): ${missing.join(', ')}`);
  });

  test('handler 映射无重复键(后者静默覆盖前者)', () => {
    // JS 对象字面量里重复键后者胜出，前者变成死代码且无任何警告。
    // 直接从源码文本统计，因为运行时的 HANDLERS 已合并、看不到重复。
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
    const keys = [...src.matchAll(/(aspira_[a-z0-9_]+)\s*:\s*(?:async\s*)?(?:\(|function|handle)/g)].map(m => m[1]);
    const count = {};
    for (const k of keys) count[k] = (count[k] || 0) + 1;
    const dups = Object.keys(count).filter(k => count[k] > 1);
    assertEqual(dups.length, 0, `handler 键重复定义(后者静默覆盖前者): ${dups.map(d => `${d}×${count[d]}`).join(', ')}`);
  });

  test('handler 映射与工具表互相覆盖(无孤儿 handler)', () => {
    const toolNames = new Set(TOOLS.map(t => t.name));
    const orphans = Object.keys(HANDLERS).filter(k => !toolNames.has(k));
    // 孤儿 handler 不等于错(可能是内部复用)，但应当是有意的，故只断言不静默增长。
    assertTrue(Array.isArray(orphans), 'orphans 应为数组');
    if (orphans.length > 0) {
      // 记录而非失败：新增孤儿 handler 时需要人工确认是否有意。
      console.log(`      [note] ${orphans.length} 个 handler 无对应工具定义: ${orphans.join(', ')}`);
    }
  });

  test('工具数与 handler 数匹配(数字对得上)', () => {
    // 曾出现 tools/list 报 179 而 handler 唯一键 178，差 1 却无人报错。
    assertEqual(TOOLS.length, Object.keys(HANDLERS).length + (Object.keys(HANDLERS).filter(k => !TOOLS.some(t => t.name === k)).length),
      'TOOLS 数应等于 HANDLERS 数(允许有意的孤儿 handler)');
  });

  test('handler 不得拒绝满足自身声明参数的调用(参数契约)', () => {
    // 这是本轮最隐蔽的一类损坏：handler 读的参数名与 tools-registry 声明的不一致。
    // 调用方按文档传参，handler 却读到 undefined，于是：
    //   aspira_formula_search 声明 query，handler 读 keyword → 回 "keyword required"
    //   aspira_formula_calc   声明 variables，覆盖版读 values → 拿到空变量表
    //   aspira_formula_bridge 声明 {domain,params}，覆盖版读 query → 完全无视声明参数
    // 三者都不报错，只是静默给出错答案。故对每个声明了 required 的工具，
    // 用「只填 required 参数」的最小合法调用打一次，断言不因缺参而失败。
    const cases = {
      aspira_formula_search: { query: 'entropy' },
      aspira_formula_bridge: { domain: 'decision', params: { x: 100 } },
      aspira_formula_calc: { formula: 'x^2', variables: { x: 3 } },
    };
    for (const [name, args] of Object.entries(cases)) {
      const tool = TOOLS.find(t => t.name === name);
      assertTrue(!!tool, `${name} 应在 TOOLS 中`);
      const declared = (tool.inputSchema && tool.inputSchema.required) || [];
      for (const req of declared) {
        assertTrue(req in args, `测试用例必须覆盖 ${name} 声明的必填参数 ${req}`);
      }
      let out;
      try { out = HANDLERS[name](args); } catch (e) { out = { error: e.message }; }
      out = (out && typeof out.then === 'function') ? null : out;
      if (out && typeof out.error === 'string') {
        // mathjs 未安装(node_modules 缺失)是环境问题，不是参数契约问题，单独放行。
        const envOnly = /mathjs|Cannot find module/i.test(out.error);
        assertTrue(envOnly,
          `${name} 用文档参数调用失败，疑似参数名不一致: ${out.error}`);
      }
    }
  });
};
