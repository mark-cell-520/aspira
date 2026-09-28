/**
 * test/mcp-param-contract-wired.test.js — 本轮接线的 11 个工具 + 审计两处盲区
 *
 * 与 test/mcp-param-contract.test.js 分工:
 *   那个文件锁"审计脚本本身正确"和"两个已修 stub 不退化成空壳"，
 *   用的是**独立实现**的 detectReads(故意不共用代码以交叉校验)。
 *   本文件锁本轮(2026-09-28)新接线的 11 个工具，以及审计脚本
 *   本身的两处失明——那两处正是它产出 5 个假阳性的原因。
 *
 * ═══ 为什么单独放一个文件 ═══
 * 本文件首版直接写进了 test/mcp-param-contract.test.js，**覆盖了原有 8 个测试**。
 * 表现是 run-all 从 881 掉到 879——不是失败，是**测试凭空消失**。
 * 教训: 往已有测试文件写内容前必须先读它。测试数不升反降时，
 * 第一反应应该是"我是不是覆盖了东西"，而不是"是不是有测试被跳过"。
 * (本会话已多次遇到"覆盖/静默丢失"类问题: 对象展开同名键互相覆盖、
 *  handler 重复定义后者静默覆盖前者、影子覆盖版工具静默覆盖映射。)
 *
 * ═══ 审计的两处失明(5 个假阳性的根因) ═══
 * 一个产出假阳性的审计比没有审计更危险——它会让人去"修"没坏的工具。
 *
 * 盲区一: 透传正则漏掉 `args || {}`
 *   首版: (?:\|\||\?\?|\?\.[A-Za-z_$]+)?\s*[,)]
 *   `checkOutbound(args || {})` 中 `||` 后面跟着 ` {}` 才到 `)`，
 *   匹配失败。参数其实**在转发的模块里被读取**，却被报成
 *   "声明未读 text,classification"。aspira_consciousness 的
 *   `CT.compute(args || {})` 同样中报。
 *   `|| {}` 是整体转发最常见的兜底写法(防 args 为 undefined)，
 *   漏掉它等于把最标准的一种透传判成缺陷。
 *
 * 盲区二: 解构正则的 `[^{}]` 无法跨越嵌套花括号
 *   首版: \{([^{}]{0,300})\}\s*=\s*args
 *   `const { domain, params = {} } = args || {}`(handleFormulaBridge)
 *   里 `params = {}` 自带花括号，`[^{}]` 跨不过去，整条解构匹配失败，
 *   reads 为空。带默认值的解构在 JS 里极其常见。
 *   修法: 允许一层嵌套 `[^{}]*(?:\{[^{}]*\}[^{}]*)*`。
 *
 * ═══ 本轮修掉的 11 个真问题 ═══
 * 三个是**桩**——声明了参数、从不读、恒返回空对象:
 *   aspira_psychology_engine  {"result":{}}   ← PsychologyEngine.analyzePsychology 本就存在
 *   aspira_long_term_memory    {"result":{}}   ← LongTermMemory.add 本就存在
 *   aspira_semantic_anchor     {"anchor":{"initialized":true}}  ← 只检查方法存在、从不调用
 * 一个更微妙: aspira_knowledge_graph 读了 action 却**只把它回声回去**
 *   (return { action, ... })从不分支，query 更是完全没读。
 *   回声让 action 看起来"生效了"，比完全不读更误导。
 * 剩下七个是 action 声明未读(引擎其实支持多操作，按 action 接上):
 *   constitutional / experience_replay / skill_evolution / desire_system /
 *   emotional_growth / confidence_calibrate / emotion_dynamics
 *
 * ═══ 本轮新增的设计约束 ═══
 * 三个桩修好后，空参数改为**显式报错**而不是返回空对象。
 * 这正是审计要防的失败模式的反面: 让"参数没传"变成可观测的失败。
 * 修 knowledge_graph 时还踩了自己一个坑: 曾写成 `action==='stats' || !q`
 * 就返回 stats，于是未知 action 在没传 query 时**静默回退**成 stats——
 * 那正是本轮要消灭的形态。已改为先校验 action 再判 query。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const ROOT = path.join(__dirname, '..');

  // 跑真实审计(不是重写一份逻辑——那会测到一个副本而不是交付物)。
  // 另一个文件里有独立的 detectReads 实现做交叉校验，这里不需要重复。
  function audit() {
    const out = execFileSync('node', [path.join(ROOT, 'scripts/audit-mcp-param-contract.js'), '--json'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  }

  // 错误可能在顶层(r.error，提前 return 时)，也可能嵌在任意载荷里
  // (r.result / r.principles / r.pad … 的 .error，switch 的 default 分支)。
  // 这些工具的载荷键名各不相同，逐个枚举必然漏——首版就是这么漏的。
  // 改为扫描所有顶层对象值里的 error 字段。
  const hasError = (r) => {
    if (typeof r.error === 'string' && r.error.length > 0) return true;
    return Object.keys(r).some(k => {
      const v = r[k];
      return v && typeof v === 'object' && typeof v.error === 'string' && v.error.length > 0;
    });
  };

  test('参数契约审计不得再报疑似真问题', () => {
    // 本轮起点是 16 个(其中 5 个是审计自己的假阳性，已修)。
    // 这一条把结论钉住: 任何人引入新的"声明未读"，本测试立刻失败。
    const j = audit();
    const suspect = j.rows.filter(r => r.status === 'mismatch'
      && !r.passthrough && !(r.reads.length > r.declared.length));
    assertEqual(suspect.length, 0,
      `仍有 ${suspect.length} 个疑似真问题: ${suspect.map(r => r.tool).join(', ')}`);
  });

  test('审计必须认出两种惯用法(否则它自己会产假阳性)', () => {
    const j = audit();
    // 盲区一的代表: 整体转发 `fn(args || {})`
    for (const t of ['aspira_check_outbound', 'aspira_consciousness']) {
      const r = j.rows.find(x => x.tool === t);
      assertTrue(!!r, `审计应覆盖 ${t}`);
      assertTrue(r.passthrough === true,
        `${t} 是整体转发(fn(args || {}))，审计应标记 passthrough 而非报"声明未读"`);
    }
    // 盲区二的代表: 带默认值的解构 `const { domain, params = {} } = args || {}`
    const fb = j.rows.find(x => x.tool === 'aspira_formula_bridge');
    assertTrue(!!fb, '审计应覆盖 aspira_formula_bridge');
    assertEqual(fb.unused.length, 0,
      `formula_bridge 解构了 domain/params，不应报"声明未读"(unused=${fb.unused.join(',')})`);
    assertTrue(fb.reads.includes('domain') && fb.reads.includes('params'),
      `formula_bridge 的 reads 应含 domain/params，实测 [${fb.reads.join(',')}]`);
  });

  test('三个原桩必须真正读参数并返回非空结果', () => {
    // 直接调 handler(不是重抄逻辑)。HANDLERS 是 mcp-server.js 的既有导出，
    // 不变式可以直接断言——这正是它当初被加上的原因。
    const { HANDLERS } = require('../src/mcp-server.js');
    const cases = [
      ['aspira_psychology_engine', { text: '我感到很焦虑，需要帮助' }],
      ['aspira_long_term_memory', { memory: '用户偏好深色模式' }],
      ['aspira_semantic_anchor', { text: '这个东西挺好的' }],
    ];
    for (const [name, args] of cases) {
      const fn = HANDLERS[name];
      assertTrue(typeof fn === 'function', `${name} 应有 handler`);
      const r = fn(args);
      // 取最可能承载业务结果的字段
      const payload = r.result || r.anchor || r.desire || r.growth || r.confidence || r.skill || r.replay;
      assertTrue(payload != null && Object.keys(payload).length > 0,
        `${name} 传入 ${JSON.stringify(args)} 仍返回空结果——桩没修好`);
      assertTrue(!r.error, `${name} 不应返回 error: ${r.error}`);
    }
  });

  test('三个原桩在缺少必填参数时必须报错，而不是返回空对象', () => {
    // 这是"给出空结果而不是报错"的反面: 让参数缺失变成可观测失败。
    const { HANDLERS } = require('../src/mcp-server.js');
    const cases = [
      ['aspira_psychology_engine', {}],
      ['aspira_psychology_engine', { text: '' }],
      ['aspira_psychology_engine', { text: '   ' }],
      ['aspira_long_term_memory', { memory: '' }],
      ['aspira_semantic_anchor', {}],
    ];
    for (const [name, args] of cases) {
      const r = HANDLERS[name](args);
      assertTrue(hasError(r),
        `${name} 缺少必填参数 ${JSON.stringify(args)} 应报错，实测 ${JSON.stringify(r).slice(0, 70)}`);
    }
  });

  test('action 参数必须真正分支，而不是被回声', () => {
    const { HANDLERS } = require('../src/mcp-server.js');
    // aspira_knowledge_graph 曾把 action 回声回去(return { action, ... })
    // 却从不分支——回声让它看起来生效了。
    const kg = HANDLERS.aspira_knowledge_graph;
    const stats = kg({ action: 'stats' });
    assertEqual(stats.action, 'stats', 'stats action 应被回显');
    assertTrue(stats.stats != null, 'stats 应返回统计数据');
    // 未知 action 与"缺 query 的非 stats action"都必须明确报错，
    // 不得静默回退成 stats——那正是本轮要消灭的形态。
    assertTrue(hasError(kg({ action: '不存在的动作' })),
      '未知 action 应给出明确错误而不是静默回退');
    assertTrue(hasError(kg({ action: 'query' })),
      'action=query 缺少 query 参数应明确报错，而不是回退成 stats');
    // 其余工具: 未知 action 一律明确报错
    for (const name of ['aspira_constitutional', 'aspira_experience_replay',
      'aspira_skill_evolution', 'aspira_desire_system', 'aspira_emotional_growth',
      'aspira_confidence_calibrate', 'aspira_emotion_dynamics']) {
      const r = HANDLERS[name]({ action: '__nope__' });
      assertTrue(hasError(r),
        `${name} 的未知 action 应给出明确错误，实测 ${JSON.stringify(r).slice(0, 70)}`);
    }
  });

  test('修复必须落在源码里而不是只改审计', () => {
    // 防止有人用"调宽审计判定"的方式让上面第一条变绿——
    // 那会让审计失去意义。验证 handler 源码里真的有接线。
    const src = fs.readFileSync(path.join(ROOT, 'src/mcp-server.js'), 'utf8');
    for (const name of ['aspira_psychology_engine', 'aspira_long_term_memory', 'aspira_semantic_anchor']) {
      // 注意结尾是 `\n  },`(箭头函数的右花括号在后)，不是 `\n  ,`。
      const m = new RegExp(`\\n {2}${name}\\s*:\\s*\\(args[^)]*\\)\\s*=>\\s*\\{([\\s\\S]{0,1500}?)\\n {2}\\},`).exec(src);
      assertTrue(!!m, `应能定位 ${name} 的 handler`);
      assertTrue(/analyzePsychology|\.add\(|processMessage/.test(m[1]),
        `${name} 的 handler 应调用引擎的真实方法`);
      assertTrue(/必填参数/.test(m[1]),
        `${name} 的 handler 应对空参数给出必填提示`);
    }
    // knowledge_graph 必须真的 switch/分支，而不是只回显 action
    const kgm = new RegExp(`\\n {2}aspira_knowledge_graph\\s*:\\s*\\(args[^)]*\\)\\s*=>\\s*\\{([\\s\\S]{0,2500}?)\\n {2}\\},`).exec(src);
    assertTrue(!!kgm, '应能定位 aspira_knowledge_graph 的 handler');
    assertTrue(/switch\s*\(action\)/.test(kgm[1]),
      'knowledge_graph 应按 action 真正分支，而不是只回显');
    assertTrue(/ACTIONS\.includes/.test(kgm[1]),
      'knowledge_graph 应先校验 action 白名单(防未知 action 静默回退)');
  });

  test('原有 8 个契约测试必须仍在(防本文件再次覆盖它)', () => {
    // 首版把新测试直接写进了 mcp-param-contract.test.js，覆盖了原有 8 个，
    // 表现是 run-all 从 881 掉到 879——不是失败，是测试凭空消失。
    // 这里钉住那个文件仍然存在且仍有 8 个用例。
    const orig = path.join(ROOT, 'test', 'mcp-param-contract.test.js');
    assertTrue(fs.existsSync(orig), 'test/mcp-param-contract.test.js 必须存在');
    const src = fs.readFileSync(orig, 'utf8');
    const n = (src.match(/\n {2}test\(/g) || []).length;
    assertTrue(n >= 8, `原契约测试应仍有至少 8 个用例，实测 ${n}`);
    // 且两个文件不得同名互相覆盖
    assertTrue(path.basename(__filename) !== 'mcp-param-contract.test.js',
      '本文件不得与 mcp-param-contract.test.js 同名');
  });
};
