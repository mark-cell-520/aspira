/**
 * test/zero-runtime-deps.test.js — "0 runtime dependencies" 从口号变成实测
 *
 * ═══ 由来 ═══
 * 连续第四轮 doc-honest-numbers。前三轮修了「扫哪些文件」「读哪些写法」
 * 「怎么测量层数」。本轮审的是**声明型数字**: 文档三处(README / AGENTS.md /
 * SKILL.md)都写 "0 runtime dependencies / instant install"，而
 * package.json 的 **dependencies 里挂着 4 个包**:
 *   @xenova/transformers, js-yaml, mathjs, pm2
 * 审计从不核对依赖数——它只查 engines.node。**一个被三份文档重复的声称，
 * 没有任何仪器验证过。**
 *
 * ═══ 判定: 谁不诚实 ═══
 * 运行时语义上"零依赖"是**真的**: node_modules 完全不存在时
 *   · 引擎启动 132 个模块
 *   · initErrors === undefined
 *   · think() 完整工作
 * 因为 mathjs / transformers 的 require 都在 try/catch 或惰性 getter 里。
 * 所以修法**不是改文档迁就声明**，而是把声明改成与事实一致:
 * 四个包移入 optionalDependencies。
 *
 * ═══ 顺带抓到两个仪器缺陷 ═══
 * (a) 第 28 次失效: 扫 src/ 的外部 require 时没剥注释，把文档块里的
 *     `require('@yun520-1/heartflow')` 示例当成真依赖报出来。
 *     **写在注释里的示例 require 不是依赖，正如写在散文里的旧数字不是声称。**
 * (b) 剥掉注释后只剩 mathjs 一个真硬依赖——`formula-calculator.js` 的
 *     getMath() 里 `require('mathjs')` **没有 try/catch**，
 *     node_modules 缺失时符号计算路径直接抛 MODULE_NOT_FOUND。
 *     「可选」名不副实。已改为缺失即返回 null + 明确的
 *     OPTIONAL_DEP_MISSING 说明。
 *
 * ═══ 既有守卫的反对是对的，但它维护的是旧事实 ═══
 * bin/verify.js 有一条 `if (deps < 1) throw '新愿至少需要 mathjs'`，
 * 标题却写「npm 必选依赖为空」——**标题与内容自相矛盾**，是旧事实的化石。
 * 它在本轮正确地失败了，但失败理由是错的。已改成锁新契约(见下)。
 *
 * ═══ 本测试锁什么 ═══
 * ① dependencies 为空
 * ② optionalDependencies 的 require 点都在 try/catch 内
 * ③ mathjs 缺失时 FormulaCalculator 构造不抛、查表路径返回诚实结果
 * ④ verify.js 不再要求依赖非空
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('dependencies 必须为空(声明侧与 "0 runtime dependencies" 一致)', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    assertEqual(deps.length, 0,
      `dependencies 应空，实测 ${deps.length} 个: ${deps.join(', ')}。`
      + '文档三处声称 0 runtime dependencies，声明必须与之一致');
  });

  test('optionalDependencies 的 require 点必须可被 catch', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
    const opt = Object.keys(pkg.optionalDependencies || {});
    assertTrue(opt.length > 0, 'optionalDependencies 应列出可选依赖(它们确实被 require)');
    // 对每个可选依赖，找到 src/ 里 require 它的位置，确认在 try 内
    const strip = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const srcFiles = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) srcFiles.push(p);
      }
    })(path.join(ROOT, 'src'));
    for (const dep of opt) {
      let found = 0, guarded = 0;
      for (const f of srcFiles) {
        const src = strip(fs.readFileSync(f, 'utf8'));
        for (const m of src.matchAll(new RegExp("require\\(\\s*['\"]" + dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "['\"]\\s*\\)", 'g'))) {
          found++;
          const before = src.slice(0, m.index);
          const opens = (before.match(/\btry\s*\{/g) || []).length;
          const closes = (before.match(/\}\s*catch\b/g) || []).length;
          if (opens > closes) guarded++;
        }
      }
      if (found === 0) continue;   // 该依赖没被 src/ require(如 js-yaml/pm2)，无需守卫
      assertEqual(guarded, found,
        `${dep} 被 src/ require ${found} 次，但只有 ${guarded} 次在 try/catch 内——`
        + '「可选」名不副实，缺失时会抛 MODULE_NOT_FOUND');
    }
  });

  test('mathjs 缺失时 FormulaCalculator 必须降级而非崩溃', () => {
    // 本仓库 node_modules 不存在(mathjs 未安装)，正好是缺失场景
    const { FormulaCalculator } = require(path.join(ROOT, 'src', 'formula', 'formula-calculator.js'));
    let c;
    try {
      c = new FormulaCalculator();
    } catch (e) {
      throw new Error('mathjs 缺失时构造 FormulaCalculator 不应抛: ' + e.message);
    }
    // _math 为 null 是**合法降级态**，不是异常
    if (c._math !== null) {
      // mathjs 装了的机器上这条跳过(它不是缺失场景)
      return;
    }
    // 查表路径必须仍可用且返回诚实结果
    const r = c.calculate('physics_14', { m: 2, v: 3 });
    assertTrue(r && typeof r === 'object', '查表路径应返回对象');
    assertTrue(!(r instanceof Error), '查表路径不应抛');
    // _mathOrThrow 必须给出明确的可选依赖说明
    let thrown = null;
    try { c._mathOrThrow(); } catch (e) { thrown = e; }
    assertTrue(!!thrown, '符号计算路径应抛降级说明');
    if (thrown) {
      assertEqual(thrown.code, 'OPTIONAL_DEP_MISSING', '应带 OPTIONAL_DEP_MISSING 错误码');
      assertTrue(/mathjs/.test(thrown.message), '错误信息应点名缺失的依赖');
    }
  });

  test('verify.js 不得再要求 dependencies 非空', () => {
    // 先剥注释。本轮刚学过这一课(第 28 次失效): 写在注释里的
    // `deps < 1` 是**对旧断言的引述**，不是活代码。首版没剥，
    // 于是一条已经修好的守卫被测成"仍在要求依赖非空"——测试自己被注释骗了。
    const raw = fs.readFileSync(path.join(ROOT, 'bin', 'verify.js'), 'utf8');
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    assertTrue(!/deps\s*<\s*1/.test(src),
      'verify.js 不得要求依赖非空——mathjs 从来不是必选，这条断言维护的是旧事实');
    assertTrue(/deps !== 0/.test(src),
      'verify.js 应改为锁「dependencies 为空」这一真实契约');
  });

  test('三份文档的 0 runtime dependencies 声称必须被审计覆盖', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-doc-numbers.js'), 'utf8');
    assertTrue(/depsActuallyRequired/.test(src),
      '审计必须实测 src/ 内的硬依赖数——否则「0 runtime dependencies」仍是无人验证的口号');
    assertTrue(/runtime\\s\+dependenc/.test(src),
      '审计必须有匹配 "N runtime dependencies" 声称的模式');
  });
};
