/**
 * test/mcp-optional-dep-error-shape.test.js
 *
 * [mcp-tool-enhancement·第二百一十五轮] 新建。
 *
 * ═══ 缺口 ═══
 * 本切片的纪律是"数工具不等于调工具"(cycle 17/29/192/193/204)。本轮重跑 181 个
 * handler 的端到端普查(每个都 await、每个都按 inputSchema.required 填实参)，
 * 读出 ok 168 / errorObj 13 / threw 0。逐个分辨后, 13 个里 12 个是**正确的缺参
 * 校验**或 cycle 29 已记录的诚实错误, 只有一个是真缺陷:
 *
 *   aspira_formula_calc → { error: "Cannot find module 'mathjs'\nRequire stack:
 *                          - /Users/mm/Pictures/aspira/src/mcp-server.js\n- ..." }
 *
 * 三件事同时错在这一个返回里:
 *   ① **泄露部署的绝对路径** —— 实测那是全部 181 个工具里唯一把服务器文件系统
 *      路径返回给调用方的一处, 且在任何未装 mathjs 的部署上 100% 复现。
 *   ② **把合法状态报成代码错误** —— mathjs 在 package.json 的
 *      optionalDependencies 里, 缺失是**设计上的合法状态**。
 *      src/formula/formula-calculator.js 顶部的注释写得明白: "mathjs 是
 *      optionalDependencies: 缺失是合法状态, 不是异常", 并备好了完整的降级措辞。
 *   ③ **与自己的 sibling 自相矛盾** —— 同一个错误在 formula-calculator 里是
 *      "符号计算需要可选依赖 mathjs, 当前未安装。公式搜索/查表仍可用……",
 *      在 MCP 工具面却是 Node 的 MODULE_NOT_FOUND。
 *
 * 根因: handleFormulaCalc 自己裸 require('mathjs'), 失败后被下面那个**笼统的**
 * catch 接住并 `return { error: e.message }` —— 于是"缺哪个可选依赖"这件
 * 可以被精确判断的事, 被一个不分辨错误类型的 catch 抹平了。
 *
 * ═══ 修法 ═══
 * 把 formula-calculator 里内联的降级 Error 提成模块级并导出
 * (`optionalDepMissingError(dep)`), handleFormulaCalc 的 require 单独设 guard:
 * 只有 MODULE_NOT_FOUND 且消息点名 mathjs 时才走降级, 其余错误仍原样返回
 * (guard 不能过宽, 否则无关的缺模块会被误报成"可选依赖缺失")。
 *
 * ═══ 本锁钉的四条 ═══
 * ① aspira_formula_calc 的两个分支都钉: mathjs 可用→走计算路径; 缺失→诚实降级。
 *   两条都钉而不是只钉缺失, 是因为本部署 mathjs 缺失是偶然, 装上了锁不该误红。
 * ② **可泛化不变量**: 181 个 handler 用空实参逐个调, 任何返回体都不得含绝对
 *   路径。这是类锁 —— 下一个泄露路径的 handler 不管是谁都会被抓到。
 *   实测零副作用: 普查前后 data/_tc_* 目录数 1941 → 1941, 已跟踪数据文件改动数不变。
 * ③ 措辞只能有一份: handler 必须复用 optionalDepMissingError, 且该函数必须真的
 *   被 formula-calculator 导出 —— 否则又会在 mcp-server 里抄一份会漂的副本。
 * ④ guard 不得过宽: 无关模块的 MODULE_NOT_FOUND 不得变成 OPTIONAL_DEP_MISSING。
 * ⑤ 反向证明: 把修复前的 handler 原样内联进测试, 要求它**确实**泄露路径 ——
 *   否则②可能只是一个永远绿的谓词。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const { execFileSync } = require('child_process');

  const ROOT = path.join(__dirname, '..');
  const SERVER = path.join(ROOT, 'src', 'mcp-server.js');
  const CALC = path.join(ROOT, 'src', 'formula', 'formula-calculator.js');

  // 绝对路径形态: POSIX 家目录/根、macOS 私有临时目录、Windows 盘符
  const PATH_RE = /(\/Users\/|\/home\/|\/root\/|\/private\/var\/|\/tmp\/|[A-Z]:\\)/;

  // ── ① 两个分支都钉 ────────────────────────────────────────────
  // mathjs 可用与否由子进程里的 Module._resolveFilename 覆写决定 —— 同进程内
  // 切模式不可靠: Node 的 Module._load 有一张不暴露的 relativeResolveCache,
  // 第一次把 'mathjs' 解析到桩之后, 后续 require 连 _resolveFilename 都不再
  // 调用(实测计数 0), "缺失"模式会静默地走成功路径, 报出一个形态完好、
  // 什么都没测的读数。每个模式一个独立子进程。
  test('aspira_formula_calc: mathjs 可用走计算, 缺失走诚实降级且不泄露路径', () => {
    const probe = path.join(os.tmpdir(), 'mcp-optdep-215.cjs');
    const src = `
      const Module = require('module');
      const fs = require('fs');
      const path = require('path');
      const ROOT = ${JSON.stringify(ROOT)};
      const mode = process.argv[2];
      const STUB = ${JSON.stringify(path.join(os.tmpdir(), 'mathjs-stub-215.js'))};
      fs.writeFileSync(STUB, "const m=()=>({parse:s=>({__s:String(s)}),evaluate:n=>1,solve:()=>({}),import:()=>{}});m.all={};m.create=()=>m();module.exports=m;");
      const orig = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (request === 'mathjs') {
          if (mode === 'present') return STUB;
          const e = new Error("Cannot find module 'mathjs'\\nRequire stack:\\n- /some/where");
          e.code = 'MODULE_NOT_FOUND'; throw e;
        }
        return orig.call(this, request, ...rest);
      };
      const { HANDLERS } = require(path.join(ROOT, 'src', 'mcp-server.js'));
      const r = HANDLERS.aspira_formula_calc({ formula: 'x^2+1', variables: { x: 2 } });
      fs.writeFileSync(process.argv[3], JSON.stringify(r));
    `;
    fs.writeFileSync(probe, src);
    const outFile = path.join(os.tmpdir(), 'mcp-optdep-215-out.json');
    try {
      // 分支 A: mathjs 可用 → 必须真的计算
      execFileSync('node', [probe, 'present', outFile], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
      const ok = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      assertTrue(!!ok.result, `mathjs 可用时应返回 result, 实得 ${JSON.stringify(ok).slice(0, 120)}`);
      assertTrue(!ok.error, `mathjs 可用时不应报错: ${ok.error}`);

      // 分支 B: mathjs 缺失 → 诚实降级 + 不泄露路径
      execFileSync('node', [probe, 'missing', outFile], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
      const bad = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const s = JSON.stringify(bad);
      assertEqual(bad.code, 'OPTIONAL_DEP_MISSING', 'mathjs 缺失时必须带 code=OPTIONAL_DEP_MISSING');
      assertEqual(bad.optionalDep, 'mathjs', '必须点名是哪个可选依赖缺失');
      assertTrue(!PATH_RE.test(s),
        '降级消息泄露了部署绝对路径 —— 这正是本轮修的缺陷: ' + String(bad.error).slice(0, 140));
      assertTrue(/optionalDependencies/.test(String(bad.error)),
        '降级消息必须说明 mathjs 是 optionalDependencies(缺失是合法状态)');
      assertTrue(/npm i mathjs/.test(String(bad.error)),
        '降级消息必须给出补救动作');
    } finally {
      try { fs.unlinkSync(probe); } catch (_) {}
      try { fs.unlinkSync(outFile); } catch (_) {}
    }
  });

  // ── ② 可泛化不变量: 错误路径不得泄露绝对路径 ──────────────────
  // 范围收窄过一次, 原因是第一版把"返回体含路径"当成缺陷, 于是抓到两个**有意**
  // 披露的 handler(实测): aspira_benchmark_status 返回 dataDir(它本就要告诉
  // 调用方数据包放哪), aspira_philosophy 返回自己状态文件的 path。
  // 那把锁认不出自己该管什么, 于是全红 —— 与本轮 AGENTS.md 条目里记的
  // "第二例第一版要求所有常量都解析" 同一个形状。
  // 真正的缺陷类是**意外的模块解析错误到达调用方**: error 字段里出现绝对路径
  // 或 Require stack。那正是 aspira_formula_calc 修前的形态。
  // 局限(记录而非掩饰): ② 只用空实参调用, 所以只覆盖"空实参能到达的错误路径"。
  // aspira_formula_calc 缺 formula 时在到达 require 之前就返回了, 所以它自己的
  // 错误路径② 碰不到 —— 那条由 ① 钉(① 传了 formula, 两个分支都走到底)。
  // 实测: 摘掉 guard 后 ① 和 ③ 按名红, ② 不变, 就是这个原因。
  test('181 个 handler 用空实参调用, error 字段不得含绝对路径或 Require stack', () => {
    const { HANDLERS, TOOLS } = require(SERVER);
    assertEqual(Object.keys(HANDLERS).length, TOOLS.length,
      'handler 数与工具数应一致(否则本例外覆盖的面不完整)');
    const leaks = [];
    const intentional = [];
    for (const name of Object.keys(HANDLERS)) {
      let res;
      try { res = HANDLERS[name]({}); } catch (e) { res = { error: String(e && e.message) }; }
      // handler 可能是 async; await 不到就跳过(那些由别的锁覆盖)
      if (res && typeof res.then === 'function') continue;
      const s = JSON.stringify(res);
      if (!s) continue;
      // 缺陷类: 错误串里带路径 / Require stack
      const errStr = res && typeof res === 'object' && typeof res.error === 'string' ? res.error : null;
      if (errStr && (PATH_RE.test(errStr) || /Require stack/.test(errStr))) {
        leaks.push(name + ' → ' + errStr.slice(0, 120));
      } else if (!errStr && PATH_RE.test(s)) {
        // 非 error 字段里的路径: 记为有意披露, 不当缺陷
        intentional.push(name);
      }
    }
    assertEqual(leaks.length, 0,
      '这些 handler 的错误串把部署路径返回给了调用方: ' + leaks.join(' | '));
    // 前提自证: 本例外必须真的检查到了东西, 不能是空转
    assertTrue(intentional.length >= 2,
      `预期至少 2 个 handler 在非 error 字段里有意返回路径(实测 aspira_benchmark_status / ` +
      `aspira_philosophy), 实得 ${intentional.length} —— 若为 0 说明本外边的判据变了, 它已空转`);
  });

  // ── ③ 措辞只能有一份 ─────────────────────────────────────────
  test('降级措辞必须只有一份: handler 复用 formula-calculator 的出口', () => {
    const calcSrc = fs.readFileSync(CALC, 'utf8');
    assertTrue(/module\.exports\s*=\s*\{[^}]*optionalDepMissingError/.test(calcSrc),
      'formula-calculator 必须导出 optionalDepMissingError');
    const srvSrc = fs.readFileSync(SERVER, 'utf8');
    // 只看 handleFormulaCalc 自己那一段(整文件里到处都会出现 require)
    const at = srvSrc.indexOf('function handleFormulaCalc');
    assertTrue(at >= 0, '找不到 handleFormulaCalc —— 锚点已变, 本例外失效');
    let end = srvSrc.indexOf('\nconst HANDLERS', at);
    if (end < 0) end = at + 4000;
    const body = srvSrc.slice(at, end);
    assertTrue(body.includes('optionalDepMissingError'),
      'handleFormulaCalc 必须复用 optionalDepMissingError, 而不是自己抄一份措辞');
    assertTrue(!/符号计算需要可选依赖/.test(body),
      'handleFormulaCalc 里又出现了一份降级措辞 —— 那就是会漂的第二份副本');
  });

  // ── ④ guard 不得过宽 ─────────────────────────────────────────
  test('无关模块的 MODULE_NOT_FOUND 不得被误报成可选依赖缺失', () => {
    const probe = path.join(os.tmpdir(), 'mcp-optdep-width-215.cjs');
    const src = `
      const Module = require('module');
      const fs = require('fs');
      const path = require('path');
      const ROOT = ${JSON.stringify(ROOT)};
      const orig = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (request === 'mathjs') {
          const e = new Error("Cannot find module 'some-unrelated-pkg'");
          e.code = 'MODULE_NOT_FOUND'; throw e;
        }
        return orig.call(this, request, ...rest);
      };
      const { HANDLERS } = require(path.join(ROOT, 'src', 'mcp-server.js'));
      const r = HANDLERS.aspira_formula_calc({ formula: 'x^2+1' });
      fs.writeFileSync(process.argv[2], JSON.stringify(r));
    `;
    fs.writeFileSync(probe, src);
    const outFile = path.join(os.tmpdir(), 'mcp-optdep-width-215-out.json');
    try {
      execFileSync('node', [probe, outFile], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
      const r = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      assertTrue(r.code !== 'OPTIONAL_DEP_MISSING',
        '无关模块缺失被误报成 OPTIONAL_DEP_MISSING —— guard 过宽, 把别的故障藏进了"可选依赖"这个筐');
      assertTrue(/some-unrelated-pkg/.test(String(r.error)),
        '无关错误应原样返回, 实得: ' + String(r.error).slice(0, 120));
    } finally {
      try { fs.unlinkSync(probe); } catch (_) {}
      try { fs.unlinkSync(outFile); } catch (_) {}
    }
  });

  // ── ⑤ 反向证明: 修复前的形态确实泄露路径 ──────────────────────
  // 内联修复前的 handler 原文(cycle 194 的同族做法: 逻辑等价的重建, 不去动
  // 真文件 —— mcp-server.js 有 5700 行且被多个测试读, 在它身上变异会伤及无辜)。
  test('反向证明: 修复前的裸 require 形态确实泄露路径(锁能红)', () => {
    const probe = path.join(os.tmpdir(), 'mcp-optdep-rev-215.cjs');
    const src = `
      const Module = require('module');
      const fs = require('fs');
      const ROOT = ${JSON.stringify(ROOT)};
      const orig = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (request === 'mathjs') {
          // 路径必须**真的像一条绝对路径**: 第一版写的是 /some/where, 于是
          // ② 的谓词(PATH_RE)在修复前的形态上抓不到它, 反向证明自己红了 ——
          // 一个证明不了"锁能红"的反向证明是装饰。
          const e = new Error("Cannot find module 'mathjs'\\nRequire stack:\\n- /Users/someone/proj/src/mcp-server.js");
          e.code = 'MODULE_NOT_FOUND'; throw e;
        }
        return orig.call(this, request, ...rest);
      };
      // ↓↓↓ 修复前的 handleFormulaCalc 原文 ↓↓↓
      function handleFormulaCalc(args) {
        const { formula, variables = {} } = args || {};
        if (!formula) return { error: 'formula 是必填参数' };
        try {
          const math = require('mathjs').create(require('mathjs').all, { matrix: 'Array', number: 'number' });
          math.import({ 'import': function() { throw new Error('mathjs import disabled'); } }, { override: true });
          const scope = { ...variables };
          let result;
          if (formula.includes('=')) {
            const [left, right] = formula.split('=');
            const solved = math.solve(math.parse(left), math.parse(right), Object.keys(variables));
            result = { type: 'equation', solution: solved };
          } else {
            const value = math.evaluate(math.parse(formula), scope);
            result = { type: 'expression', value };
          }
          return { formula, variables, result, timestamp: Date.now() };
        } catch (e) {
          return { error: e.message, formula };
        }
      }
      const r = handleFormulaCalc({ formula: 'x^2+1' });
      fs.writeFileSync(process.argv[2], JSON.stringify(r));
    `;
    fs.writeFileSync(probe, src);
    const outFile = path.join(os.tmpdir(), 'mcp-optdep-rev-215-out.json');
    try {
      execFileSync('node', [probe, outFile], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
      const old = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const s = JSON.stringify(old);
      // 自证: 这个内联的重建确实复现了缺陷形态, 否则本例外是装饰
      assertTrue(PATH_RE.test(s) || /Require stack/.test(s),
        '内联的修复前形态没有复现路径泄露 —— 反向证明的重建不成立, 它证明不了任何事');
      assertTrue(old.code !== 'OPTIONAL_DEP_MISSING',
        '修复前形态竟已带 OPTIONAL_DEP_MISSING —— 重建的不是修复前, 反向证明无效');
      // 于是: ② 的谓词若用在修复前的代码上, 必然按名红
      assertTrue(PATH_RE.test(s), '② 的谓词应能在修复前的代码上红 —— 若此断言失败, 说明②是永真的');
    } finally {
      try { fs.unlinkSync(probe); } catch (_) {}
      try { fs.unlinkSync(outFile); } catch (_) {}
    }
  });
};
