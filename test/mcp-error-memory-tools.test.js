/**
 * test/mcp-error-memory-tools.test.js —
 * 四个对外宣传的 MCP 工具结构上不可能工作, 而实现就在隔壁目录
 *
 * [mcp-tool-enhancement·第一百九十二轮] 新建。
 *
 * ═══ 本轮切口 ═══
 * cycle 17/29 立下的方法: **静态数工具数不是检验, 要真的调用每一个 handler**。
 * 本轮对 181 个工具做了行为普查(await, 不用同步调用 —— cycle 17 的教训是同步调用
 * 会让 async handler 的 Promise 被 JSON.stringify 成 {})。结果 159 ok / 2 参数校验 /
 * 20 errorObj / 0 threw / 0 missing。20 条 errorObj 里 16 条是探针传占位符 'probe'
 * 触发的**正确**校验(未知 action/mode), 真正值得追的是这 4 个:
 *
 *   aspira_error_store / _query / _fix / _verify
 *   → `{error: 'error-memory 能力未实现: heartflow._hfCore 与
 *      src/core/error-memory.js 均不存在, 不是初始化时机问题'}`
 *
 * ═══ 缺陷: 一个只对了一半的诊断, 让 4 个工具死了十几轮 ═══
 * cycle 121 在这里写下"这个能力从未被实现", 依据是 `src/core/error-memory.js`
 * require 不到(MODULE_NOT_FOUND)。**那个诊断只对了一半**:
 *   实现在 `src/error-memory.js` —— src/ 根下, 不在 core/ 里。
 * 它导出 12 个方法, 其中 logCorrection / querySimilar / logFix / logVerify
 * 与四个 handler 需要的一一对应, 实测全部可用:
 *   logCorrection('overconfidence', …) → {success:true, updated:1, recurrence:true}
 *
 * 于是: 调用成功、不抛错、返回结构良好的 `{error: ...}`, 而能力就在隔壁目录。
 * 这是本仓库记录最多的形状 —— *响应结构良好, 内容是死的* —— 而它踩着 cycle 16
 * 已记录的同族错误: **注释/诊断说"不存在", 而东西就在隔壁**(那次是
 * self-diagnostic 的引擎表把 src/emotion 写成 src/core, 而同一行的注释写着正确位置)。
 *
 * ═══ 修法 ═══
 * 四个 handler 改为直接 require `src/error-memory.js`, 不再走
 * `heartflow._hfCore.errorMemory` 这条 cycle 121 已实测从未被赋值的路径。
 * `problem` 是自由文本而 logCorrection 的 category 必须是 7 个枚举值之一,
 * 故用模块自带的 classifyError 推断 —— 不猜、不让调用方多传一个参数。
 *
 * ═══ 锁什么 ═══
 * ① store 必须真的落库(返回 success:true, 不是 error);
 * ② query 必须真的检出刚存入的错误(闭环可往返);
 * ③ fix/verify 必须真的推进状态机 open→fixed→verified;
 * ④ 验证后 query 不得再警告同一条(状态机语义);
 * ⑤ 不存在的 id 必须报"错误不存在"而不是 success;
 * ⑥ 缺参数仍走原来的校验分支(不许把参数校验修掉);
 * ⑦ 源级: 四个 handler 必须引用真实模块路径 src/error-memory.js;
 * ⑧ 反向: 把路径改回 src/core/error-memory.js, ①必须按名红。
 *
 * ⚠️ 本锁会写 data/error-memory.json(该功能的正常数据文件, runtime data,
 *    不被 git 跟踪)。每条用例前备份、结束后恢复, 不在仓库里留下探针记录。
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const MCP = path.join(ROOT, 'src', 'mcp-server.js');
const EM = path.join(ROOT, 'src', 'error-memory.js');
const DATA = path.join(ROOT, 'data', 'error-memory.json');

function handlers() {
  // 每次取新的 handler 表, 避免跨用例共享模块状态
  const srv = require(MCP);
  return srv.HANDLERS;
}
// 备份/恢复 runtime 数据文件, 不在仓库里留下探针写入的记录。
// ⚠️ 第二参数 emptyStart: **从空库开始跑**。logCorrection 按 category 去重
//    (工具描述原话"同类错误不会重复"): 若该分类已有记录, 它只递增
//    recurrenceCount 而**不新建**, 于是 store 返回 success 但文件里永远
//    找不到我那条 —— 首版三个用例因此报"前提失效: 找不到刚存入的记录"。
//    状态机测试需要一条**属于自己的**记录, 故从空库起步。
function withBackup(fn, emptyStart = false) {
  const had = fs.existsSync(DATA);
  const orig = had ? fs.readFileSync(DATA, 'utf8') : null;
  if (emptyStart) fs.writeFileSync(DATA, JSON.stringify({ errors: [] }, null, 2));
  try { return fn(); } finally {
    if (had) fs.writeFileSync(DATA, orig);
    else if (fs.existsSync(DATA)) fs.unlinkSync(DATA);
  }
}

// 空库起步的包装: 状态机测试需要一条**属于自己的**记录
function withEmptyBackup(fn) { return withBackup(fn, true); }

module.exports = function ({ test, assertEqual, assertTrue }) {

  // ── 一、store 必须真的落库 ──────────────────────────────
  test('aspira_error_store 必须真的落库(返回 success, 不是 error)', () => {
    withBackup(() => {
      const H = handlers();
      const r = H.aspira_error_store({
        problem: 'cycle 192 lock probe: 说了绝对化结论',
        action: '直接断言', outcome: '缺少依据',
      }, {});
      assertTrue(r && r.error === undefined,
        `store 返回了 error: ${r && r.error} —— 四个 error-memory 工具曾在 181 个里`
        + '结构上不可能工作: 调用成功、不抛错、返回 {error: …能力未实现…}, '
        + '而实现在 src/error-memory.js(src/ 根下, 不在 cycle 121 找的 src/core/)');
      assertEqual(r.success, true, 'store 必须报告 success:true');
      assertTrue(typeof r.updated === 'number', 'store 必须返回 updated 计数');
    });
  });

  // ⚠️ querySimilar 的真实契约是**按分类聚合**: previousCount 是该分类下
  //    **未验证的记录数**, 而 logCorrection 对同类错误去重(1 小时内只递增
  //    recurrenceCount, 不新增记录)。故必须**空库起步**才能观测到 0→1;
  //    首版依赖库的既有状态, 单跑都红(库里已有 1 条 open 的 overconfidence,
  //    store 因去重不新增 → previousCount 不变), 且在 run-all 并发下更脆。
  test('aspira_error_query 必须真的检出刚存入的错误(闭环可往返)', () => {
    withEmptyBackup(() => {
      const H = handlers();
      const probe = 'cycle 192 lock probe: 毫无疑问这是唯一正确的做法';
      const cat = require(EM).classifyError(probe).code;
      const before = H.aspira_error_query({ problem: probe, limit: 5 }, {});
      const n0 = (before.warnings || [])
        .filter(w => w.category === cat)
        .reduce((s, w) => s + (w.previousCount || 0), 0);
      assertEqual(n0, 0, `前提失效: 空库下分类「${cat}」的 previousCount 应为 0, 实测 ${n0}`);
      H.aspira_error_store({ problem: probe, action: '绝对化断言', outcome: '无依据' }, {});
      const after = H.aspira_error_query({ problem: probe, limit: 5 }, {});
      const n1 = (after.warnings || [])
        .filter(w => w.category === cat)
        .reduce((s, w) => s + (w.previousCount || 0), 0);
      assertTrue(after && after.error === undefined, `query 返回了 error: ${after && after.error}`);
      assertTrue(Array.isArray(after.warnings), 'query 必须返回 warnings 数组');
      assertEqual(n1, 1,
        `store 后分类「${cat}」的 previousCount 应从 0 变为 1, 实测 ${n1} —— `
        + 'store 与 query 不互通, 闭环是断的');
    });
  });

  // 从 runtime 数据文件里取回 detail 含标记的那条的 id。
  // querySimilar 按分类聚合、不返回我刚存的那条, 故状态机测试直接读文件。
  function findProbeId(mark) {
    const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const rec = (data.errors || []).find(e => String(e.detail || '').includes(mark));
    return rec ? rec.id : null;
  }

  // ── 三、fix/verify 必须真的推进状态机 ───────────────────
  test('aspira_error_fix / _verify 必须真的推进 open→fixed→verified', () => {
    withEmptyBackup(() => {
      const H = handlers();
      const mark = '您说得对完全同意 (cycle 192 lock probe: 状态机闭环)';
      const st = H.aspira_error_store({ problem: mark, action: 'probe', outcome: 'probe' }, {});
      assertTrue(st && st.error === undefined, `store 失败: ${st && st.error}`);
      const id = findProbeId(mark);
      assertTrue(id !== null, '前提失效: 数据文件里找不到刚存入的记录');
      const fx = H.aspira_error_fix({ id, note: 'cycle 192 probe fix' }, {});
      assertTrue(fx && fx.error === undefined, `fix 返回 error: ${fx && fx.error}`);
      assertEqual(fx.status, 'fixed', 'fix 必须把状态推到 fixed');
      const vf = H.aspira_error_verify({ id, note: 'cycle 192 probe verify' }, {});
      assertTrue(vf && vf.error === undefined, `verify 返回 error: ${vf && vf.error}`);
      assertEqual(vf.status, 'verified', 'verify 必须把状态推到 verified');
      // 落库状态必须真的是 verified(不是只在返回值里说)
      const rec = JSON.parse(fs.readFileSync(DATA, 'utf8')).errors.find(e => e.id === id);
      assertEqual(rec.status, 'verified', '数据文件里的 status 必须已是 verified');
    });
  });

  // ── 四、验证后不得再算历史重犯 ─────────────────────────
  test('验证通过后不得再算历史重犯(状态机语义)', () => {
    withEmptyBackup(() => {
      const H = handlers();
      const mark = '据了解相关部门 (cycle 192 lock probe: 验证后静默)';
      const cat = require(EM).classifyError(mark).code;
      H.aspira_error_store({ problem: mark, action: 'probe', outcome: 'probe' }, {});
      const id = findProbeId(mark);
      assertTrue(id !== null, '前提失效: 找不到刚存入的记录');
      // 验证前该分类必须真的在警告(否则下面"静默"是被别处买通的)
      const q0 = H.aspira_error_query({ problem: mark, limit: 10 }, {});
      assertTrue((q0.warnings || []).some(w => w.category === cat),
        `前提失效: 验证前分类「${cat}」就不在 warnings 里, 无法证明静默是验证带来的`);
      H.aspira_error_fix({ id, note: 'x' }, {});
      H.aspira_error_verify({ id, note: 'x' }, {});
      const q1 = H.aspira_error_query({ problem: mark, limit: 10 }, {});
      // ⚠️ 真实契约比首版断言更强: 验证后 query 直接返回
      //    {warnings: [], safe: true} —— 该分类**完全静默**, 而不是
      //    "仍警告但 verifiedCount +1"(首版那样写是因为 warnings 里已无处可加)。
      const stillWarn = (q1.warnings || []).filter(w => w.category === cat);
      assertEqual(stillWarn.length, 0,
        `验证后分类「${cat}」仍出现在 query 的 warnings 里 —— `
        + '「验证通过后不再算历史重犯」这句工具描述就是假的');
      // 且该条自身状态必须是 verified, 不再是 open
      const rec = JSON.parse(fs.readFileSync(DATA, 'utf8')).errors.find(e => e.id === id);
      assertEqual(rec.status, 'verified', '该条状态必须已是 verified');
    });
  });

  // ── 五、不存在的 id 必须报错而非 success ─────────────────
  test('不存在的 id 必须报"错误不存在", 不得返回 success', () => {
    withBackup(() => {
      const H = handlers();
      const r = H.aspira_error_fix({ id: 999999, note: 'x' }, {});
      assertTrue(r && r.success !== true,
        '对一个不存在的 id 返回了 success —— 静默"修好"一个不存在的东西, '
        + '比报错更糟: 调用方会以为闭环成立了');
      assertTrue(/不存在|not found|未找到/i.test(JSON.stringify(r)),
        `对不存在的 id 应报"不存在", 实测: ${JSON.stringify(r)}`);
    });
  });

  // ── 六、缺参数仍走原校验分支 ────────────────────────────
  test('缺参数仍必须走参数校验(不许把校验修掉)', () => {
    const H = handlers();
    const r = H.aspira_error_store({ problem: '只有问题' }, {});
    assertTrue(r && r.error !== undefined,
      '缺 action/outcome 时没有报错 —— 参数校验被修掉了, 那会把畸形请求写进库');
    assertEqual(r.error, 'need problem, action, outcome', '应保持原有校验文案');
    const r2 = H.aspira_error_query({}, {});
    assertTrue(r2 && r2.error !== undefined, 'query 缺 problem 时必须报错');
    const r3 = H.aspira_error_fix({}, {});
    assertTrue(r3 && r3.error !== undefined, 'fix 缺 id 时必须报错');
  });

  // ── 七、源级: 必须引用真实模块路径 ──────────────────────
  test('源级: 四个 handler 必须引用 src/error-memory.js(不是 src/core/)', () => {
    const src = fs.readFileSync(MCP, 'utf8');
    const n = (src.match(/require\(HF_DIR \+ '\/src\/error-memory\.js'\)/g) || []).length;
    assertEqual(n, 4,
      `应有 4 处 require(HF_DIR + '/src/error-memory.js'), 实测 ${n} 处 —— `
      + '四个 handler 必须都接到真实模块上');
    // 且不得再走那条从未被赋值的路径
    assertTrue(!/heartflow\._hfCore\.errorMemory\.(store|query|fix|verify)/.test(src),
      '仍有 handler 在调 heartflow._hfCore.errorMemory.* —— cycle 121 已实测 '
      + 'start() 前后 _hfCore 都是 undefined, 那条路永远走不通');
    // 真实模块必须真的存在且导出那四个能力
    assertTrue(fs.existsSync(EM), 'src/error-memory.js 必须存在');
    const em = require(EM);
    for (const fn of ['logCorrection', 'querySimilar', 'logFix', 'logVerify', 'classifyError']) {
      assertEqual(typeof em[fn], 'function', `src/error-memory.js 必须导出 ${fn}`);
    }
  });

  // ── 八、反向: 路径改回 core/ 必须按名红 ─────────────────
  test('反向: 把路径改回 src/core/ 后, store 必须失败', () => {
    const orig = fs.readFileSync(MCP, 'utf8');
    const OLD = "require(HF_DIR + '/src/error-memory.js')";
    const count = (orig.match(new RegExp(OLD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    assertEqual(count, 4, `前提失效: 预期 4 处真实路径, 实测 ${count}`);
    const broken = orig.split(OLD).join("require(HF_DIR + '/src/core/error-memory.js')");
    assertTrue(broken !== orig, '变异未生效');
    const tmp = path.join(ROOT, 'src', '_mcp-probe.js');
    try {
      fs.writeFileSync(tmp, broken);
      const srv = require(tmp);
      const r = srv.HANDLERS.aspira_error_store({
        problem: 'cycle 192 reverse probe', action: 'x', outcome: 'y',
      }, {});
      assertTrue(r && r.error !== undefined,
        '反向证明失效: 路径改回 src/core/ 后 store 仍成功 —— '
        + '说明它不依赖这个路径, 本条的通过是被别处买通的');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    assertEqual(fs.readFileSync(MCP, 'utf8'), orig, '共享的 mcp-server.js 必须未被本测试改动');
  });
};
