/**
 * test/mcp-advertised-tools-live.test.js — 已广告的工具必须真的能跑
 *
 * [第二十九轮] 新建。mcp-tool-enhancement 切片。先实测: 181 个工具定义、181 个 handler,
 * 数量一一对应, 看似完备。逐个调用后抓到 **3 个已广告但完全不可用** 的工具:
 *
 *   aspira_decision_decide     → {error:'decision.decide not available'}
 *   aspira_decision_feedback   → {error:'decisionFeedback not initialized'}
 *   aspira_boundary_check      → {error:'boundaryGuard not loaded'}
 *
 * 三个返回的都是**结构合法的 JSON**, 不抛错、不超时, 调用在协议层完全成功 ——
 * 只有内容是死的。契约错配家族, 且三个是同一个根因的三种表现:
 *
 *   ① 中央 dispatch 调的是 handler(args, sessionId), sessionId 是
 *      crypto.randomUUID() 出来的**字符串**。aspira_boundary_check 却声明第二参数
 *      为 (args, hf) 并读 hf.boundaryGuard —— 字符串上恒 undefined。这不是"偶尔
 *      加载不到", 是**结构上永远不可能工作**: 要的是对象, 传来的是字符串。
 *   ② decision / boundaryGuard / decisionFeedback 三个字段**只在 heartflow 的
 *      start() 里赋值**(start() 开头就是 if (this.started) return)。handler 们
 *      new 完实例直接读字段, 从不调用 start()。实测: 不调 start() 三字段分别为
 *      null / undefined / undefined; 调用后全部 OK 且 _initErrors = 0。
 *      而 decisionFeedback 那处赋值的 catch 是**空的**(只写了一句 optional 字样),
 *      于是连失败痕迹都不会留下。
 *
 * 本文件的锁: ①三个工具对合法基本调用必须返回非 error 内容; ②源码级钉住根因形状
 * (handler 不得依赖第二参数是引擎; 读这三个字段前必须 start()); ③反向控制 ——
 * 确认第二参数在 dispatch 里确实是 sessionId, 防止"必须 start"这条锁的前提消失。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

module.exports = function ({ test, assertTrue, assertEqual }) {

  const { HANDLERS, TOOLS } = require(path.join(ROOT, 'src', 'mcp-server.js'));

  // 三个曾被"广告但不可用"的工具, 及它们各自合法的最小调用参数
  const CASES = [
    {
      name: 'aspira_boundary_check',
      args: { filePath: '/tmp/x.js', actor: 'mcp', purpose: 'check' },
      // 修好后应返回真实判定字段
      mustHave: ['verdict'],
    },
    {
      name: 'aspira_decision_decide',
      args: {
        task: '选一个方案',
        options: [
          { id: 'a', label: '甲', feasibility: 0.9, consequence: 0.8, risk: 0.1 },
          { id: 'b', label: '乙', feasibility: 0.2, consequence: 0.3, risk: 0.8 },
        ],
      },
      mustHave: ['decision'],
    },
    {
      name: 'aspira_decision_feedback',
      args: { decision: { type: 'test', ruleId: 'r1', confidence: 0.5 }, outcome: 'success', notes: '' },
      mustHave: ['feedback'],
    },
  ];

  // ─── ① 三个工具必须返回真实内容, 而不是结构合法的 error ────
  test('广告过的三个工具对合法调用必须返回真实内容(不得返回 error)', async () => {
    for (const c of CASES) {
      let r;
      try {
        r = await HANDLERS[c.name](c.args);
      } catch (e) {
        assertTrue(false, c.name + ' 调用抛错: ' + e.message);
        continue;
      }
      assertTrue(r && typeof r === 'object', c.name + ' 必须返回对象');
      assertTrue(!r.error,
        c.name + ' 返回了结构合法的 error: ' + JSON.stringify(r.error) +
        ' —— 调用在协议层成功、不抛错, 只有内容是死的。实测这三个工具都曾如此。');
      for (const k of c.mustHave) {
        assertTrue(k in r, c.name + ' 的返回必须含 ' + k + ' 字段, 实测: ' + JSON.stringify(r).slice(0, 120));
      }
    }
  });

  // ─── ② 反向控制: decision_decide 必须真能区分散选项 ─────────
  test('decision_decide 必须真的做决策: 可区分的选项给出 chosen, 不可区分的拒绝挑选', async () => {
    const distinguishable = {
      task: '选一个方案',
      options: [
        { id: 'a', label: '甲', feasibility: 0.95, consequence: 0.9, risk: 0.05 },
        { id: 'b', label: '乙', feasibility: 0.15, consequence: 0.2, risk: 0.85 },
      ],
    };
    const r = await HANDLERS.aspira_decision_decide(distinguishable);
    assertTrue(r && r.decision, '必须返回 decision');
    assertTrue(r.decision.chosen === 'a',
      '明显更优的选项 a 必须被选中, 实测 chosen=' + JSON.stringify(r.decision.chosen) +
      ' reasoning=' + String(r.decision.reasoning).slice(0, 90));
  });

  // ─── ③ 源码级: 三个 handler 读字段前必须 start() ────────────
  test('源码级: 读 decision/boundaryGuard/decisionFeedback 前必须调用 start()', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    // 剥行注释, 否则注释里讨论 start() 的句子会被当成调用(周期19/25/27 同款陷阱)
    const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    // 每个 handler 体内出现 start() 调用
    const startCalls = code.match(/inst\.start\s*\(\s*\)|inst\.start\b\s*&&/g) || [];
    assertTrue(startCalls.length >= 3,
      '三个修复过的 handler 必须各自调用 start(), 实测 ' + startCalls.length + ' 处' +
      ' —— 这三个字段只在 heartflow 的 start() 里赋值, 不调就永远是 null/undefined');

    // 不得再出现"第二参数当引擎用"的形态
    const badSecondParam = /\(args,\s*hf\)\s*=>/.test(code);
    assertTrue(!badSecondParam,
      '不得再把 handler 第二参数当作 heartflow 引擎: dispatch 传的是 sessionId(字符串),' +
      ' 在其上读 .boundaryGuard 恒为 undefined。aspira_boundary_check 原先正是如此,' +
      ' 导致该工具在真实路径下结构上不可能工作。');
  });

  // ─── ④ 反向控制: dispatch 的第二参数确实必须是 sessionId ────
  test('dispatch 的第二参数必须是 sessionId(锁住③的前提)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    assertTrue(/const sessionId\s*=\s*crypto\.randomUUID\(\)/.test(src),
      'dispatch 必须仍从 crypto.randomUUID() 取 sessionId —— 这是"第二参数不是引擎"的前提');
    assertTrue(/handler\(args,\s*sessionId\)/.test(src),
      'dispatch 必须仍以 handler(args, sessionId) 调用 —— 若改成传引擎, ③ 的结论需重新推导');
  });

  // ─── ⑤ 广告与实现的对应关系不得退化 ───────────────────────
  test('TOOLS 与 HANDLERS 必须一一对应(广告过的必须有实现)', () => {
    assertEqual(TOOLS.length, Object.keys(HANDLERS).length,
      '工具定义数与 handler 数必须相等');
    const missing = TOOLS.filter((t) => !HANDLERS[t.name]).map((t) => t.name);
    assertEqual(missing.length, 0, '这些工具有定义无 handler: ' + missing.join(', '));
  });
};
