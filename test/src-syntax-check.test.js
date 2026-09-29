/**
 * test/src-syntax-check.test.js
 *
 * ═══ 由来(第十六轮, test-coverage-gap 切片) ═══
 * 约定 #6 原文: **"Verify syntax after every edit: `node --check <file>`."**
 *
 * 这是一条**纯人的纪律**: 实测全仓库没有任何测试机械执行它——
 * `grep` 只在一处注释里提到 `node --check`(`test/unwired-module-coverage.test.js`
 * 的说明文字)，没有一处真正调用。前三个周期依次锁住了约定 #1(版本五处一致)、
 * #4(测试可达性)、以及 33 个静默 SKIP 加载检查; #6 是剩下的一条**零强制**约定。
 *
 * 为什么值得锁，而不是"靠人记得":
 * `src/` 下共 **351** 个 JS 文件(排除 data/ 与 memory/ 运行时目录)。
 * 只要其中一个**从未被任何测试加载**的模块出现语法错误，整套门禁是瞎的——
 * run-all 只加载测试触及的模块，verify 同样如此。于是一个坏文件躺在
 * `src/` 里，全绿如常，直到某个真实调用方在生产里 `require` 它。
 *
 * ═══ 作用域为什么恰好是 src/ ═══
 * `test/` 与 `scripts/` 不扫: 那里的语法错误**天然是响的**——文件跑不起来，
 * run-all 立刻失败。而 `src/` 里的语法错误只在"该模块被加载时"才响，
 * 未被覆盖的模块则永远不响。**一个失败听不见的地方才需要锁。**
 *
 * ═══ 仪器选择: 为什么是 node --check 本身 ═══
 * 第一版想过用 `new vm.Script(src)` 在进程内解析(快 180 倍: 34ms vs 6159ms)。
 * 实测它报 `src/core/heartflow.js` **"Illegal return statement"**，
 * 而 `node --check` 报 0 个错误。根因: `vm.Script` 不包装模块，
 * 而 `node --check` 按 CommonJS 包装(顶层 `return` 在 CJS 里合法)。
 * 这正是仓库反复记载的形状——**仪器把自己的局限当成引擎的缺陷**:
 * 若当时直接采用 vm.Script，这把锁一上线就是红的，而且指向的文件完全无辜。
 * 故最终用约定 #6 字面所写的 `node --check`，零翻译层。
 * (351 次子进程实测 ~6.2s，远小于 run-all 的 CHILD_TIMEOUT=90s。)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');

/** 收集 src/ 下全部 .js，跳过运行时目录 data/ 与 memory/ */
function collectSrc(dir, base = dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // data/ 与 memory/ 是运行时产物(且被 .gitignore)，不是源码
      if (ent.name === 'data' || ent.name === 'memory') continue;
      out.push(...collectSrc(full, base));
    } else if (ent.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** 用 node --check 检查一个文件，返回 null(通过) 或错误摘要 */
function checkOne(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (e) {
    const lines = String(e.stderr || e.stdout || e.message).split('\n').filter(s => s.trim());
    if (lines.length === 0) return '(无输出) ' + String(e.message).slice(0, 120);
    // 优先取真正的错误行(SyntaxError: ...)。node --check 的输出形如:
    //   <file>:<line>
    //   <源码行>
    //        ^^
    //   SyntaxError: Invalid or unexpected token
    // 早期版本只取前 3 行，正好把最关键的 SyntaxError 行截掉——
    // 于是"仪器能不能报错"这条自检自己失灵了。**先找错误行，找不到再退回首行。**
    const errLine = lines.find(l => /\w*Error\s*:/.test(l));
    return (errLine || lines[0]).slice(0, 200);
  }
}

module.exports = function ({ test, assertEqual, assertTrue, log }) {

  test('src/ 下每个 .js 文件都必须通过 node --check(约定 #6)', () => {
    const files = collectSrc(SRC);
    assertTrue(files.length > 100, `应有上百个源码文件，实测 ${files.length} 个`);
    const bad = [];
    for (const f of files) {
      const err = checkOne(f);
      if (err) bad.push(path.relative(path.join(__dirname, '..'), f) + ': ' + err);
    }
    if (log) log(`      已检查 ${files.length} 个 src/ 源码文件，语法错误 ${bad.length} 个`);
    assertEqual(bad.join('\n'), '',
      '这些源码文件有语法错误(它们可能从未被任何测试加载，所以 run-all 全绿也看不见):\n' + bad.join('\n'));
  });

  test('这把锁本身必须能变红: 一个坏文件必须被 node --check 报出来', () => {
    // ⚠️ 这一条比上一条更重要。
    // 仓库里有过一次教训: 去重逻辑 `catch (_) { nDistinct++; continue; }`
    // 因为 crypto 未 import 而抛 ReferenceError，被 catch 吞掉，
    // 于是每个文件都走"算作不同"分支——输出写着"811 份全不同、0 重复"，
    // 看起来像个正常工作的去重器，实际一次都没跑过。
    // **一个永远通过的检查与没有检查不可区分。**
    // 所以这里用一个临时目录里的坏文件，证明本测试用的仪器真的会失败。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-syntax-probe-'));
    try {
      const good = path.join(tmp, 'good.js');
      const broken = path.join(tmp, 'broken.js');
      fs.writeFileSync(good, 'module.exports = 1;\n');
      fs.writeFileSync(broken, 'module.exports = 1;\nthis is not javascript !!!\n');

      assertEqual(checkOne(good), null, '语法正确的文件必须通过');
      const err = checkOne(broken);
      assertTrue(err !== null, '语法错误的文件必须被报出来——若为 null，这把锁永远绿着');
      assertTrue(/SyntaxError|Invalid|Unexpected/i.test(err),
        '报错信息应指向语法问题，实际: ' + err);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录，忽略 */ }
    }
  });
};
