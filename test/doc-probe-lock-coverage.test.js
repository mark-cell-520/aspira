/**
 * test/doc-probe-lock-coverage.test.js — 每个 spawn 文档审计的测试都必须持锁
 *
 * ═══ 由来 ═══
 * 第 56 轮修掉了并发探针冲突: 至少四个测试会改写 README/IDENTITY 再
 * spawn 审计，并发下 A 的审计看到 B 的探针，A 断言失败，
 * A 又用含 B 探针的备份恢复。修法是 test/_doc-probe-lock.js。
 *
 * **然后在第 9 轮，我自己连续两次违反这条规则**，两次都是新写的测试:
 *   ① `作用域计数不得被当成引擎总量` —— spawn 审计未持锁
 *   ② `行内代码跨度内的数字是被引用的字面量` —— 同上
 *
 * 失败形态**完全一样且特别隐蔽**:
 *   · 直接跑该文件: 全绿
 *   · 跑整套 run-all: 1 失败，且失败信息指向一个与真因无关的断言
 *
 * 为什么容易漏: 违规的测试本身**逻辑全对**。它失败不是因为自己错了，
 * 而是并发下读到了**别人**的探针注入。于是失败信息看起来像
 * "我的断言太严"，真因却是"我没持锁"——**报错指向的地方不是错的地方**。
 *
 * ═══ 首版守卫自己也错了两处(都已修) ═══
 * ① 用通用正则匹配 `execFileSync('node', [SCRIPT]`，把跑
 *    `mcp-contract-audit.js` / `mcp-echo-audit.js` 的测试也算进来了——
 *    它们根本不碰文档。判据必须精确到 `audit-doc-numbers.js`。
 * ② 检查 spawn **语句**是否在锁内。但 spawn 写在模块层的辅助函数里
 *    (`function runAudit() { return execFileSync(...) }`)，持锁发生在
 *    **调用处**。于是所有合规文件都被误报。
 *    正确判据: 找到含 spawn 的辅助函数名，再检查它的每个**调用点**。
 *
 * ═══ 本测试锁什么 ═══
 * 对每个 spawn `audit-doc-numbers.js` 的测试文件:
 *   ① 必须 require `_doc-probe-lock.js`
 *   ② 其审计辅助函数的每个调用点都必须在 withDocLock 回调内
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = __dirname;
const TARGET_SCRIPT = 'audit-doc-numbers.js';

module.exports = function ({ test, assertTrue }) {

  function listTestFiles(dir, out) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of ents) {
      if (e.name === 'archive' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) listTestFiles(p, out);
      else if (e.name.endsWith('.test.js')) out.push(p);
    }
    return out;
  }

  // 该文件是否真的 spawn 文档审计(而非别的审计脚本/仅在注释里提到它)
  // 判据: 必须同时有
  //   ① 指向 scripts/audit-doc-numbers.js 的路径常量
  //   ② 一个真的子进程调用
  // 首版只查字符串出现，把 test-runner-concurrency.test.js 误算了——
  // 它只是在注释里提到该脚本，实际 execSync 跑的是 test/run-all.js。
  function spawnsDocAudit(src) {
    const hasPath = /audit-doc-numbers\.js['"]\s*\)?/.test(src)
      && /path\.join\([^)]*audit-doc-numbers\.js/.test(src);
    if (!hasPath) return false;
    return /execFileSync\(\s*'node'\s*,\s*\[\s*SCRIPT/.test(src)
      || /execSync\([^)]*SCRIPT/.test(src)
      || /spawnSync\(\s*'node'\s*,\s*\[[^\]]*SCRIPT/.test(src);
  }

  // 含 spawn 语句的辅助函数名。
  // ⚠️ 必须锚定 **spawn 调用本身**再往前找声明:
  // 首版锚定字符串 'audit-doc-numbers'，而它首次出现在
  // `const SCRIPT = path.join(...)` 里，早于任何函数声明，
  // 于是所有合规文件都报"找不到函数名"。
  function helperName(src) {
    const m = src.match(/execFileSync\(\s*'node'\s*,\s*\[\s*SCRIPT|execSync\([^)]*SCRIPT|spawnSync\(\s*'node'\s*,\s*\[[^\]]*SCRIPT/);
    if (!m) return null;
    const before = src.slice(0, m.index);
    const cands = [...before.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|\w+)\s*=>)/g)];
    if (!cands.length) return null;
    const last = cands[cands.length - 1];
    return last[1] || last[2];
  }

  // 把源码里的**字符串字面量与注释**抹成等长空白, 只留真正的代码。
  // [第二十五轮] insideDocLock() 原来直接在原文上 match /\}\)\);/。而测试里的
  // 探针钩子是一堆**字符串数组**(HEAL_HOOK/DIRTY_HOOK/...), 其中一行以
  // `}));` 结尾 —— 原文匹配把它当成锁关闭, 于是真锁被提前"关上",
  // runAudit() 调用点被误判为未持锁, 门禁被挡红。
  // 这与周期19 记录的形态同族: **一个不看上下文做文本匹配的仪器,
  // 会把字符串里的图案当成代码。** 那次是注释剥离器删掉审计 44% 源码;
  // 这次是锁覆盖率分析器把钩子字符串里的 `}));` 当成了锁的右括号。
  // 抹成等长空白而不是删掉, 是为了不改变任何下标 —— 调用方传的是原文下标。
  function stripStringsAndComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') {           // 行注释
        while (i < n && src[i] !== '\n') { out += ' '; i++; }
        continue;
      }
      if (c === '/' && d === '*') {           // 块注释
        out += '  '; i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          out += (src[i] === '\n' ? '\n' : ' '); i++;
        }
        if (i < n) { out += '  '; i += 2; }
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {   // 字符串(含模板串)
        const q = c; out += ' '; i++;
        while (i < n) {
          if (src[i] === '\\') { out += '  '; i += 2; continue; }
          if (src[i] === q) { out += ' '; i++; break; }
          if (src[i] === '\n' && q !== '`') { break; }   // 行串不允许跨行
          out += (src[i] === '\n' ? '\n' : ' '); i++;
        }
        continue;
      }
      out += c; i++;
    }
    return out;
  }

  // 某个位置是否落在 withDocLock(() => { ... }) 之内。
  // [第二十五轮] 旧实现数 `\}));` 当闭合 —— 而那从来不是 withDocLock 的真实
  // 闭合语法(真实是 `});` 再接 `};`)。后果有两半, 而且**修掉前半会让后半恶化**:
  //   · 修前: 钩子字符串里有一行以 `}));` 结尾, 于是真锁被提前"关上",
  //     锁内的调用点被误判为未持锁 —— 周期24 靠这条挡红过一次门禁。
  //   · 只剥字符串不补配对: closes 变成 0, opens(1) > closes(0) 永真,
  //     **任何调用点都判成在锁内** —— 一个永不失败的检查, 和没有检查一样。
  // 实测过那个中间态: 造一个 require 了锁模块、但把 runAudit() 放在锁外的文件,
  // 仪器 2/2 通过, 一声不响。所以这里改成真正的花括号配对。
  function insideDocLock(src, at) {
    const code = stripStringsAndComments(src);
    // 找出每个 withDocLock(() => 的括号配对区间
    const re = /withDocLock\(\s*\(\)\s*=>/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      // 从箭头函数体开始做花括号配对
      let i = m.index + m[0].length;
      while (i < code.length && code[i] !== '{') i++;
      if (i >= code.length) continue;
      let depth = 0, end = -1;
      for (let j = i; j < code.length; j++) {
        if (code[j] === '{') depth++;
        else if (code[j] === '}') {
          depth--;
          if (depth === 0) { end = j; break; }
        }
      }
      if (end < 0) continue;                 // 括号不配对: 宁可信其无
      if (at > m.index && at < end) return true;
    }
    return false;
  }

  test('每个 spawn 文档审计的测试都必须持 doc-probe 锁', () => {
    const files = listTestFiles(TEST_DIR, []);
    const offenders = [];
    let checked = 0;
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      if (rel === path.join('test', 'doc-probe-lock-coverage.test.js')) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (!spawnsDocAudit(src)) continue;
      checked++;
      const requiresLock = /require\(['"]\.\/_doc-probe-lock\.js['"]\)/.test(src)
        || /require\(['"]\.\.\/test\/_doc-probe-lock\.js['"]\)/.test(src);
      if (!requiresLock) {
        offenders.push(rel + '  # spawn 文档审计但未 require _doc-probe-lock');
        continue;
      }
      const fn = helperName(src);
      if (!fn) {
        offenders.push(rel + '  # 找不到含 spawn 的辅助函数名，无法判定(宁可信其无)');
        continue;
      }
      // 该辅助函数的每个调用点都必须在锁内
      const callRe = new RegExp('(?<![\\w$.])' + fn.replace(/\$/g, '\\$') + '\\s*\\(', 'g');
      let m, calls = 0;
      while ((m = callRe.exec(src)) !== null) {
        // 跳过函数定义自身
        const before = src.slice(Math.max(0, m.index - 30), m.index);
        if (/function\s+$/.test(before) || /=\s*(\([^)]*\)|\w+)\s*=>\s*$/.test(before)) continue;
        calls++;
        if (!insideDocLock(src, m.index)) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(rel + ':' + line + '  # ' + fn + '() 调用点不在 withDocLock 内');
        }
      }
      if (calls === 0) {
        offenders.push(rel + '  # 找不到 ' + fn + '() 的调用点');
      }
    }
    assertTrue(checked > 0, '应至少扫到一个 spawn 文档审计的测试文件');
    assertTrue(offenders.length === 0,
      '以下测试 spawn 了文档审计却未正确持锁:\n  '
      + offenders.join('\n  ')
      + '\n\n第 56 轮修掉的就是这个缺陷，第 9 轮我又连续违反两次。'
      + '失败形态很隐蔽: 直接跑全绿，跑整套才失败，且失败信息指向一个'
      + '与真因无关的断言——因为读到的是别人的探针。'
      + '**报错指向的地方不是错的地方。**');
  });

  test('_doc-probe-lock 模块契约完好', () => {
    const lockSrc = fs.readFileSync(path.join(TEST_DIR, '_doc-probe-lock.js'), 'utf8');
    assertTrue(/withDocLock/.test(lockSrc), '必须导出 withDocLock');
    assertTrue(/module\.exports/.test(lockSrc), '必须导出模块');
    // 锁必须真的跨进程: 基于文件系统而非进程内变量
    assertTrue(/mkdirSync|renameSync|writeFileSync/.test(lockSrc),
      '锁必须落在文件系统上——进程内变量挡不住并发子进程');
  });
};
