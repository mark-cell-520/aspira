/**
 * test/mcp-echo-audit.test.js — action 回声 / 参数未声明 全量扫描仪器
 *
 * ═══ 为什么需要这个脚本与测试 ═══
 * 上轮在 `aspira_forgetting` 上抓到两个缺陷，都是**同一个形状**:
 *   (a) 处理器读了 action 却只把它回声回去，从不分支
 *   (b) MCP 中央参数校验按 inputSchema.properties 建白名单，
 *       **静默丢弃未声明的参数** → 处理器永远收不到调用方传的参数
 *
 * 两者都是静默的: 工具返回 200、有 action 字段、看起来正常。
 * 而 `test/mcp-param-contract.test.js` 只做静态源码分析(参数是否被读)，
 * 工具清单还只有 9 个 —— 连已修的 aspira_knowledge_graph 都不在里面。
 *
 * `scripts/mcp-echo-audit.js` 把检查推到**全部 181 个工具**。
 *
 * ═══ 仪器本轮错了三次(最重要的记录) ═══
 * 1. **解构默认值被当成键名**: `const { action = 'decide' } = args` 里
 *    我只 split(':')，于是把 `action = 'decide'` 整个当键名，
 *    报出 5 个假阳性(agentic_memory / executable_reasoning / tom_model /
 *    debate / evolutionary_search)—— 全是正常用法。
 * 2. **只认内联箭头函数**: 55 个工具写成 `aspira_xxx: handleXxx`
 *    函数引用形态，完全没被检查。而 aspira_gate* 那类历史缺陷
 *    正是出在函数引用上(调错函数)。补上函数引用与外部文件追踪后才覆盖全。
 * 3. **花括号配平被字符串/正则带偏**: 补上函数引用后，
 *    `handleDecisionRouter` 的函数体被测出 **125,732 字符**，
 *    并列出一百多个"未声明参数"—— 那些其实是后面无数个 handler 的参数。
 *    原因是朴素 `{`/`}` 计数被字符串、模板字面量、正则、注释里的花括号带偏，
 *    一路吞到文件末尾。改为维护词法状态(code/单引号/双引号/模板/行注释/
 *    块注释/正则)后才正确。
 *
 * 这是 dimension-health-audit(2次)、dead-counter-audit(2次)、
 * mcp-contract-audit(4次)之后，"仪器把自己的局限说成引擎缺陷"
 * 这一故障模式的第 9–11 次。
 *
 * ═══ 断言的边界 ═══
 * · 本测试锁的是**仪器正确性**与**两类缺陷归零**，不锁总数。
 * · "两类均为 0"是断言: 将来再出现同类缺陷它必须响。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'mcp-echo-audit.js');

  const run = () => execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf8' });

  // ─── 仪器自身: 必须覆盖全部 181 个工具 ─────────────────────────────
  test('仪器覆盖全部工具，无遗漏(曾因只认内联箭头函数漏掉 55 个)', () => {
    const out = run();
    const m = out.match(/工具总数: (\d+)/);
    assertTrue(!!m, '应输出工具总数');
    const total = Number(m[1]);
    assertTrue(total > 150, `应覆盖全部工具，实测 ${total}`);
    const miss = out.match(/未在内联处理器中找到定义[^:]*: (\d+)/);
    assertTrue(!!miss, '应输出未找到数');
    assertEqual(Number(miss[1]), 0,
      `不得有工具没被检查(函数引用/外部文件形态都要能跟上)，实测 ${miss[1]}`);
  });

  // ─── 缺陷形态一: action 只回声不分派，必须归零 ─────────────────────
  test('形态一(action 只回声不分派)必须为 0 —— aspira_forgetting 已修', () => {
    const out = run();
    const m = out.match(/形态一: action 只回声、不分派 \((\d+)\)/);
    assertTrue(!!m, '应输出形态一计数');
    assertEqual(Number(m[1]), 0,
      `不得存在"读了 action 只回声不分支"的处理器，实测 ${m[1]} 处`);
  });

  // ─── 缺陷形态二: 读了参数但 schema 未声明，必须归零 ─────────────────
  test('形态二(读了参数但 schema 未声明)必须为 0', () => {
    const out = run();
    const m = out.match(/形态二: 处理器读了参数但 inputSchema 未声明 \((\d+)\)/);
    assertTrue(!!m, '应输出形态二计数');
    assertEqual(Number(m[1]), 0,
      `不得存在"handler 读了参数但 schema 未声明"(会被中央校验静默丢弃)，实测 ${m[1]} 处`);
    // 具体点名: 本轮修过的三个不得回归
    for (const t of ['aspira_forgetting', 'aspira_emotion_dynamics',
                     'aspira_skill_evolution', 'aspira_confidence_calibrate',
                     'aspira_gate_pipeline', 'aspira_crowdtest_evaluate']) {
      assertTrue(!out.includes(t),
        `${t} 不应再出现在未声明清单里(本轮已补全 schema)`);
    }
  });

  // ─── 仪器自身: 不得把解构默认值当键名 ─────────────────────────────
  test('仪器不得把解构默认值当成键名(曾报 5 个假阳性)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    // 必须按 '=' 与 ':' 双重切分
    assertTrue(/split\('='\)\[0\]\.split\(':'\)\[0\]/.test(src),
      '解构键提取必须先切掉默认值(=)再切重命名(:)');
    // 且这些正常工具不得出现在输出里
    const out = run();
    for (const t of ['aspira_agentic_memory', 'aspira_executable_reasoning',
                     'aspira_tom_model', 'aspira_debate', 'aspira_evolutionary_search']) {
      assertTrue(!out.includes(t), `${t} 使用解构默认值，不应被报成缺陷`);
    }
  });

  // ─── 仪器自身: 花括号配平必须跳过字符串/模板/正则/注释 ─────────────
  test('仪器必须按词法状态配平花括号(曾把 handleDecisionRouter 体测成 125K 字符)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    for (const state of ['lineComment', 'blockComment', 'tpl']) {
      assertTrue(src.includes(`'${state}'`), `bodyFrom 应处理 ${state} 状态`);
    }
    // 端到端: 若配平正确，decision_router 不得带出一百多个未声明参数
    const out = run();
    assertTrue(!/aspira_decision_router\s+未声明/.test(out),
      'handleDecisionRouter 的函数体不得吞掉后续 handler(配平缺陷)');
  });
};
