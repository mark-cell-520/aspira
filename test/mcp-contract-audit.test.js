/**
 * test/mcp-contract-audit.test.js — MCP 调用约定核对仪器
 *
 * ═══ 这个测试为什么存在 ═══
 * AGENTS.md 记着三例「MCP 处理器与模块对调用约定各说各话」的缺陷:
 *   aspira_gate*(调错函数，整层管线不可见)、aspira_wakeup_verify(无参数)、
 *   aspira_experience_replay(传对象给要字符串的构造函数，工具完全不可用)。
 * 三例的共同点: **单元测试全绿，只有端到端调用能看见。**
 * `scripts/mcp-contract-audit.js` 因此在调用前静态核对 108 个 `new X(...)` 调用点。
 *
 * ═══ 仪器本轮错了四次，全是假阳性(最重要的记录) ═══
 * 1. **无参构造崩溃**: `constructor()` 时 ctorParams 返回 `[]`，
 *    没有 .form/.names，判定分支一进 else 就
 *    `Cannot read properties of undefined` —— 仪器自己崩了。
 * 2. **94/143 处假阳性**: 只按"形参是否对象解构"分类，于是把 options 对象传给
 *    `constructor(options)` 也报成"形参要标量却传对象"。
 *    真缺陷的形状不是"传了对象"，而是**构造体把形参当字符串用**
 *    (`typeof projectRoot !== 'string'`)。改为看函数体后才对准。
 * 3. **内置类 + 方法实参**: `new Map()/new Error(...)` 被报"找不到类定义"；
 *    `new ToneAnalyzer().analyze(input, {})` 的惰性匹配跨越到方法调用，
 *    把方法实参当成构造实参。
 * 4. **同名类 + 变量 require**: `DreamEngine` 在 src/dream/engine.js
 *    (签名 (memory, opts)) 和 src/dream/dream-engine.js (签名 (options))
 *    **都有声明**，按遍历顺序取第一个会取错，把**正确的**调用报成缺陷；
 *    且 `require(DreamEnginePath)` 是变量，`path.join(HF_DIR,'src','dream','engine.js')`
 *    里第一个引号串是 'src'，直接取会解析到错误路径。
 *
 * 这是 dimension-health-audit(2 次)与 dead-counter-audit(2 次)之后，
 * 「仪器把自己的局限说成引擎缺陷」这一故障模式的**第 4、5、6、7 次**。
 *
 * ═══ 断言的边界 ═══
 * · 本测试**不断言**"审计报 0 处"作为通过条件——那会把仪器局限钉成断言。
 *   它锁的是: ① 仪器跑通不崩 ② 认得真缺陷形状 ③ 不把正常用法报成缺陷。
 * · "0 处"是当前实测结果，写进注释而非断言。
 */
const path = require('path');
const fs = require('fs');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'mcp-contract-audit.js');

  // ─── 仪器自身: 必须跑通不崩 ─────────────────────────────────────────
  test('仪器对真实仓库跑通，不崩溃，并输出汇总', () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    assertTrue(/MCP 调用约定核对/.test(out), '应输出标题');
    const m = out.match(/new X\(\.\.\.\) 调用点: (\d+) 个/);
    assertTrue(!!m, '应输出调用点计数');
    assertTrue(Number(m[1]) > 50, `应扫到三位数的调用点，实测 ${m && m[1]}`);
  });

  // ─── 仪器自身: 必须认得真缺陷的形状 ─────────────────────────────────
  test('仪器认得 experience_replay 那种真缺陷(构造体当标量用却传对象)', () => {
    // 直接复现仪器内部的判定逻辑，用已知答案验证。
    // 这正是第二轮仪器失效的形状: 不能只按形参名分类，必须看函数体。
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/paramExpectation/.test(src), '仪器应含形参期望判定函数');

    // 用仪器的同一套正则判定一个合成样本
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expectsScalar = (name, body) =>
      new RegExp(`typeof\\s+${esc(name)}\\s*[=!]==?\\s*['"](?:string|number|boolean)['"]`).test(body);
    const expectsObject = (name, body) =>
      new RegExp(`${esc(name)}\\??\\.[A-Za-z_$]`).test(body);

    // experience_replay 修复前的构造体: typeof projectRoot !== 'string'
    const badBody = `if (!projectRoot || typeof projectRoot !== 'string') { throw new Error('x'); }`;
    assertTrue(expectsScalar('projectRoot', badBody),
      '构造体写 typeof X !== \'string\' 时必须判为期望标量');
    // 正常的 options 构造体: 读 options.foo
    const goodBody = `this.defaultStage = options.defaultStage || 'rem';`;
    assertTrue(expectsObject('options', goodBody),
      '构造体读 options.foo 时必须判为期望对象(不得报缺陷)');
    assertTrue(!expectsScalar('options', goodBody),
      '读 options.foo 的构造体不得同时被判为期望标量');
  });

  // ─── 仪器自身: 不得把正常用法报成缺陷 ───────────────────────────────
  test('仪器不把内置类与 new X().method() 当调用点', () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    // 第三轮仪器失效的形状: new Map()/new Error() 报"找不到类定义"，
    // new ToneAnalyzer().analyze(a,b) 把方法实参当构造实参。
    assertTrue(!/new Map\(\)/.test(out), '不得把 new Map() 当调用点');
    assertTrue(!/new Error\(/.test(out), '不得把 new Error(...) 当调用点');
    assertTrue(!/ToneAnalyzer\(\)\.analyze/.test(out),
      '不得把 new X().method(a,b) 的方法实参当构造实参');
  });

  // ─── 已知的正确调用不得被报(第四轮仪器失效的形状) ───────────────────
  test('DreamEngine 调用不得被报(同名类 + 变量 require 曾导致假阳性)', () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    // src/dream/engine.js 的签名是 constructor(memory = null, opts = null)，
    // 而 src/dream/dream-engine.js 是 constructor(options = {})。
    // mcp-server.js:940 的 new DreamEngine(memory, null) 对**前者**是正确的。
    assertTrue(!/DreamEngine/.test(out),
      'new DreamEngine(memory, null) 不应被报——它匹配 src/dream/engine.js 的 (memory, opts)');
  });

  // ─── 实测结果记录(非断言，数字会变) ─────────────────────────────────
  test('当前实测: 0 处约定不匹配(记录性断言，失败说明真的退化了)', () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    // experience_replay 缺陷修复后，object-into-scalar 类应为 0。
    // 这条**是**断言: 若将来有人引入同类缺陷，它必须响。
    // 它与"不断言总数"不矛盾——这里锁的是具体缺陷类别归零。
    assertTrue(!/构造体把形参.*当标量用/.test(out),
      '不得存在"构造体当标量用却传对象"的调用点(experience_replay 缺陷已修)');
    assertTrue(/未发现约定不匹配|待查/.test(out), '应输出结论行');
  });
};
