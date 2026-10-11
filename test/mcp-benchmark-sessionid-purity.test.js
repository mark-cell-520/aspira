/**
 * test/mcp-benchmark-sessionid-purity.test.js — 带 sessionId 调 handler 不得抛错
 *
 * ═══ 第二百零四轮 ═══
 * 切片 mcp-tool-enhancement。本切片立了四轮的规矩: **数工具不等于调工具**
 * (cycle 17/29/192/193)。两个教训本轮都遵守了:
 *   ① await —— cycle 17 同步调用让 async handler 的 Promise 被 stringify 成 {},
 *      把十二个健康工具报成"返回 size 2"。
 *   ② 按 inputSchema 的 required 填真实参数 —— cycle 193 用占位符跑出
 *      ok 146 / errorObj 24, 其中 21 个是**正确的**缺参校验, 测到的是 validator。
 *
 * 本轮 181 个 handler 全调一遍: ok 172 / errorObj 9 / threw 0。九个里的两个是
 *   aspira_benchmark_run            → getOrCreateInstance is not defined
 *   aspira_benchmark_import_failures → getOrCreateInstance is not defined
 *
 * ═══ 根因 ═══
 * `getOrCreateInstance` 在**全仓从未定义、从未导入** —— 两处调用、零处定义。
 * 它由一个 message 写着 "docs: rewrite README for v6.7.69" 的 commit
 * (cb3d9d6) 引入, 而那个 commit 实际往 src/mcp-server.js **新增了两个 handler
 * 函数**。一个文档提交引入了代码缺陷, 这是它最值得记的一面。
 *
 * ═══ 为什么它逃过了每一道检查 ═══
 * 中央 dispatch 恒传 `crypto.randomUUID()` 生成的 sessionId(5284 行), 所以
 * `sessionId ? getOrCreateInstance(sessionId) : heartflow` 这条分支 **100% 抛错**。
 * 但 dispatch 有一个"兼容单参 handler"的 fallback: 第一次抛错后, 用**无
 * sessionId** 再调一次, 那次走 heartflow 分支就成功了。于是:
 *   · 用户看到正确结果(工具"看起来能用")
 *   · 每次调用白抛一次 ReferenceError、前置的 path-guard 与 require 双跑
 *   · dispatch 的 catch 是 `catch (_) {}` 静默的 —— server 输出零痕迹
 *   · 单元测试直接调 handler 不传 sessionId, 恰好绕开触发条件
 * cycle 193 修 src/benchmark/ 三个模块时的实测正是"直接调 handler 不传
 * sessionId"那样测的, 所以漏掉了它 —— **修复的验证方法本身看不见新缺陷**。
 *
 * ═══ 修法 ═══
 * 两处 `const hf = sessionId ? getOrCreateInstance(sessionId) : heartflow;`
 * 改成 `const hf = heartflow;`。不实现那个函数: "按 sessionId 取引擎实例"需要
 * 决定实例生命周期(进程单例 / 按 session / 落盘), 属产品判断; 且同文件其他
 * handler 一律直接用模块级 heartflow。
 *
 * ═══ 本锁锁什么 ═══
 * 锁的是**一类形状**, 不是这一个案例: **HANDLERS 表里任何签名带 sessionId 的
 * handler, 用非空 sessionId 调用都不得抛 ReferenceError**。今天只有三个
 * benchmark handler 符合, 跑起来 <1s; 将来新增的带 sessionId 的 handler 若犯
 * 同一个错, 这条会抓住它。
 * 源级那一侧剥行注释后再匹配 —— 本仓库为"修复注释逐字引用被删代码而被源级
 * 匹配读成犯罪"这个形状付过七次学费(cycle 19/25/194/195/197/201/203)。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SRC = path.join(ROOT, 'src', 'mcp-server.js');

  function stripComments(src) {
    return src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  }

  // ─── 源级: 那个名字不得回来 ─────────────────────────────────────

  test('源级: getOrCreateInstance 在剥行注释后一处都不得有', () => {
    const raw = fs.readFileSync(SRC, 'utf8');
    const code = stripComments(raw);
    assertEqual((code.match(/getOrCreateInstance/g) || []).length, 0,
      '剥行注释后仍能匹配到 getOrCreateInstance —— 那个从未定义的调用回来了');
    // 反向自证: 原始文本里允许它在注释中出现(历史说明), 但代码里不行
    assertTrue(raw.length > 0, '读不到源码');
  });

  test('源级: 三个 benchmark handler 都必须直接用模块级 heartflow', () => {
    const code = stripComments(fs.readFileSync(SRC, 'utf8'));
    for (const fn of ['handleBenchmarkRun', 'handleBenchmarkImportFailures', 'handleBenchmarkStatus']) {
      const start = code.indexOf('function ' + fn + '(');
      assertTrue(start >= 0, '找不到 ' + fn + '(锚点已变?)');
      // 括号配平取函数体
      let depth = 0, i = code.indexOf('{', start), end = -1;
      for (let j = i; j < code.length; j++) {
        if (code[j] === '{') depth++;
        else if (code[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
      const body = code.slice(i, end);
      assertTrue(!/getOrCreateInstance/.test(body), fn + ' 仍引用那个从未定义的函数');
    }
    // 两处修好的地方必须是 const hf = heartflow;
    assertEqual((code.match(/const hf = heartflow;/g) || []).length, 2,
      '应有正好两处 `const hf = heartflow;`(benchmark run 与 import)');
  });

  // ─── 行为: 带 sessionId 调 handler 不得抛 ──────────────────────

  test('行为: 带非空 sessionId 调三个 benchmark handler 都不得返回 ReferenceError', async () => {
    const { HANDLERS } = require(path.join(ROOT, 'src', 'mcp-server.js'));
    const SESSION = '11111111-2222-3333-4444-555555555555'; // 形如 crypto.randomUUID()
    for (const name of ['aspira_benchmark_run', 'aspira_benchmark_import_failures', 'aspira_benchmark_status']) {
      const h = HANDLERS[name];
      assertTrue(typeof h === 'function', name + ' 没有 handler');
      let r, threw = null;
      // 必须 await: 这三个 handler 是 async function, 同步调用拿到的是 Promise,
      // JSON.stringify(Promise) 是 '{}' —— cycle 17 记为"十二个健康工具被报成
      // 返回 size 2"的那个坑。本锁第一版正是同步调的, 变异验证当场抓不住,
      // 是 cycle 17 的学费在本轮又付了一次。
      try { r = await h({}, SESSION); } catch (e) { threw = e.message; }
      assertTrue(threw === null, name + ' 带 sessionId 抛错: ' + threw);
      // handler 自己有一个包住整体的 try/catch, 会把 ReferenceError
      // **吞成 {error: e.message} 返回**而不抛。所以只断言"不抛"不够,
      // 必须连返回内容一起查。
      const s = JSON.stringify(r);
      assertTrue(!/getOrCreateInstance/.test(s),
        name + ' 带 sessionId 的返回里出现 getOrCreateInstance —— 那个从未定义的调用又能在真实路径上触发了');
      assertTrue(!/is not defined/.test(s),
        name + ' 带 sessionId 的返回里出现 "is not defined" —— 有未定义标识符被调用, 实测: ' + s.slice(0, 200));
    }
  });

  test('行为: sessionId 不得再改变这三个 handler 的返回(两条路径已等价)', async () => {
    const { HANDLERS } = require(path.join(ROOT, 'src', 'mcp-server.js'));
    const SESSION = '11111111-2222-3333-4444-555555555555';
    const cases = [
      ['aspira_benchmark_run', {}],
      ['aspira_benchmark_status', {}],
      ['aspira_benchmark_import_failures', { filePath: path.join(ROOT, 'data', 'benchmark', '__no_such_file__.jsonl') }],
    ];
    for (const [name, args] of cases) {
      const h = HANDLERS[name];
      const a = await h(args, SESSION);
      const b = await h(args);
      // 逐字比较(时间戳字段除外)
      const norm = (o) => JSON.stringify(o, (k, v) => (k === 'timestamp' ? 0 : v));
      assertEqual(norm(a), norm(b),
        name + ' 带与不带 sessionId 的返回不同 —— sessionId 仍在改变行为');
    }
  });

  // ─── 反向证明: 旧形状确实会抛 ─────────────────────────────────

  test('反向证明: 旧表达式在非空 sessionId 上必须抛 ReferenceError', () => {
    // 无法在 /tmp 重建 mcp-server(相对 require 链太深), 故内联旧判据本身,
    // 要求它 diverges —— 这证明行为锁要抓的那个错误确实会发生。
    const oldBranch = (sessionId, heartflow) => (sessionId ? getOrCreateInstance(sessionId) : heartflow);
    let threw = null;
    try { oldBranch('11111111-2222-3333-4444-555555555555', {}); } catch (e) { threw = e.message; }
    assertTrue(threw !== null && /getOrCreateInstance is not defined/.test(threw),
      '旧表达式居然不抛 —— 要么缺陷已不存在, 要么本反证失效。实测: ' + threw);
    // 而空 sessionId 走另一支, 不抛(这正是它逃过检查的原因)
    let threwEmpty = null;
    try { oldBranch('', {}); } catch (e) { threwEmpty = e.message; }
    assertEqual(threwEmpty, null, '空 sessionId 也应走 heartflow 支不抛错');
  });

  // ─── 已披露: 本轮看到但没修的一类 ─────────────────────────────

  test('已披露: 五个工具的 schema required 只列 action, handler 却按 action 再要参数', () => {
    // aspira_false_positive / aspira_tom_model / aspira_debate /
    // aspira_evolutionary_search / aspira_bulk_discriminate 的 inputSchema.required
    // 都只有 action(或 texts), 而 handler 分派后还要求 text / agentId / topic /
    // searchSpace / 非空数组。补条件 required 要逐个 action 判定, 属产品判断。
    // 本锁只把这个事实钉住, 不假装已修。
    const { TOOLS } = require(path.join(ROOT, 'src', 'mcp-server.js'));
    const names = ['aspira_false_positive', 'aspira_tom_model', 'aspira_debate',
      'aspira_evolutionary_search', 'aspira_bulk_discriminate'];
    for (const n of names) {
      const t = TOOLS.find(x => x.name === n);
      assertTrue(t && t.inputSchema, n + ' 应有 inputSchema');
      const req = (t.inputSchema.required) || [];
      assertTrue(req.length <= 2, n + ' 的 required 仍只列少量字段(实测 ' + JSON.stringify(req) + ')');
    }
  });
};
