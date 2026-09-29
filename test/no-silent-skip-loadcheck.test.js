/**
 * test/no-silent-skip-loadcheck.test.js
 *
 * ═══ 由来(第十五轮, test-coverage-gap 切片) ═══
 * 周期 14 修掉了"子目录 mount 文件被裸 node 跑、用例静默归零"。
 * 顺着同一条线索往下量: **还有哪些测试文件对 run-all 的总数贡献 0 个用例?**
 *
 * 实测 32 个文件贡献 0 个用例。它们不是 mount 风格，而是同一模板的
 * "模块加载检查"(33 个，含一个在根目录):
 *
 *   const assert = require('assert');        // require 了却从未使用
 *   async function run() {
 *     try {
 *       const mod = require('../../src/utils/logger.js');
 *       console.log('PASS logger.test.js (module loads)');
 *     } catch (e) {
 *       // Module may have optional deps or initialization requirements
 *       console.log('SKIP logger.test.js (' + e.code + ': ' + e.message.slice(0, 60) + ')');
 *     }
 *   }
 *   run().catch(e => console.log('SKIP logger.test.js: ' + e.code));
 *
 * 三个后果叠起来，使这个检查**等于不存在**:
 *   1. 加载失败时打印 SKIP，**退出码仍是 0**。实测: 把 require 指向一个
 *      不存在的模块，exit 同样为 0——加载失败与加载成功不可区分。
 *   2. PASS 与 SKIP 两行都不含"通过/失败"，run-all 的 emitResult 正则
 *      /(\d+) 通过, (\d+) 失败/ 匹配不到汇总行 → 贡献 0 个用例、0 个失败。
 *   3. 它 require 了 assert 却从未使用——一个结构上不可能失败的检查。
 *
 * 于是: **若 src/utils/logger.js 被删掉、被改名、或引入语法错误，
 * run-all 依然报全绿。** 这不是"测试覆盖率低"，这是"一个自称在检查的
 * 东西其实什么都没检查，而且它的失败形态与成功形态逐字节同义"。
 *
 * ═══ 为什么这值得单独一个测试 ═══
 * 仓库里已记载的形状: "一个把异常变成合理答复的 catch，比没有自检更危险——
 * 它让坏掉的自检显示为通过。" 那一条讲的是自检代码里的 catch;
 * 这一条是同一形状的**批量实例**: 33 个文件共享同一个 catch，
 * 而且它们的失败输出(SKIP ...)看起来就像一个正当的测试状态行。
 *
 * 本测试机械扫描全部测试文件，禁止这个形状再次出现。
 */
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;

/** 递归收集全部 .test.js(含 archive——仅用于披露，不用于断言) */
function collectAll(dir, base = dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectAll(full, base));
    else if (ent.name.endsWith('.test.js') && ent.name !== 'run-all.test.js') {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

/** 与 run-all 的 collectTestFiles 同规则: 跳过 archive，即"真正会被执行的集合" */
function collectLive(dir, base = dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'archive') continue;
      out.push(...collectLive(full, base));
    } else if (ent.name.endsWith('.test.js') && ent.name !== 'run-all.test.js') {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

/**
 * 剥掉块注释与行注释再判定。
 *
 * ⚠️ 这一步不是洁癖而是必需: 周期 15 的转换脚本把**旧模板原文**写进了每个
 * 被修文件的 JSDoc 里(用来说明它替换了什么)，于是"不许出现旧形状"的锁
 * 第一时间把 33 个刚修好的文件全判成违规——**锁咬到了修复自己的文档**。
 * 周期 14 的 run-all 源码锁踩过同一个坑(它的 JSDoc 引用了被删掉的旁路)，
 * 当时的结论是"先剥注释再匹配"，这次在 33 个文件的规模上又交了一次学费。
 * 一个把说明当罪证的锁会永远红着，直到有人连真锁一起删掉。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 判定一个文件是否是"静默 SKIP 加载检查"。
 * 四条同时满足才算(宁可漏，不可误报——误报会让人连真锁一起删掉):
 *   · 有 try { require(...) } 包住模块加载
 *   · catch 里打印 SKIP(而不是 rethrow / 设 exitCode)
 *   · 从不设置 process.exitCode / process.exit
 *   · 全文没有"测试结果"汇总行(即不接入 harness 计数)
 */
function isSilentSkipLoadCheck(src) {
  const code = stripComments(src);
  if (/测试结果/.test(code)) return false;                       // 已接入 harness
  if (/process\.exit(Code)?\s*=/.test(code)) return false;       // 失败会非零退出
  if (!/try\s*\{/.test(code) || !/catch\s*\(/.test(code)) return false;
  if (!/console\.log\(\s*['"`]SKIP/.test(code)) return false;    // catch 不打印 SKIP
  if (!/require\(['"][^'"]*src\//.test(code)) return false;      // 得是在加载 src 模块
  // catch 体内不得 rethrow
  const catchM = code.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
  if (catchM && /throw\s/.test(catchM[1])) return false;
  return true;
}

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('不得存在"把加载失败吞成 SKIP 且退出码 0"的测试文件', () => {
    // 只扫 run-all **真正执行**的集合——即与 collectTestFiles 同规则、跳过 archive。
    // 扫运行器从不执行的文件会让锁因为与门禁无关的原因变红，从而训练人忽略它。
    // 归档里的同形状文件在下面单独披露，不隐瞒也不冒充失败。
    const live = collectLive(TEST_DIR);
    const offenders = live.filter(rel => {
      let src = '';
      try { src = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8'); } catch (e) { return false; }
      return isSilentSkipLoadCheck(src);
    });
    assertEqual(offenders.join('\n'), '',
      '这些文件把模块加载失败吞成一行 SKIP 且退出码为 0，run-all 既不记通过也不记失败，'
      + '模块损坏时依然全绿:\n' + offenders.join('\n'));

    // 披露: archive/ 里同一形状的文件(它们指向的模块已删除，故被归档)
    const archived = collectAll(TEST_DIR).filter(r => r.startsWith('archive/') && (() => {
      try { return isSilentSkipLoadCheck(fs.readFileSync(path.join(TEST_DIR, r), 'utf8')); } catch (e) { return false; }
    })());
    if (archived.length > 0) {
      console.log(`      [note] archive/ 内另有 ${archived.length} 个同形状文件(指向已删除模块，run-all 不执行): `
        + archived.map(a => a.split('/').pop()).join(', '));
    }
  });

  test('被转换的加载检查必须真的接入 harness 计数', () => {
    // 正向锁: 周期 14/15 转换出来的那些文件现在必须是 mount 风格、
    // 且经 _mount.js 能数出至少 1 个用例。防止将来有人"改回去"。
    const { execFileSync } = require('child_process');
    const ROOT = path.join(TEST_DIR, '..');
    const MOUNT = path.join(TEST_DIR, '_mount.js');
    const converted = [
      'core/version.test.js', 'utils/logger.test.js', 'utils/lru-cache.test.js',
      'memory/memory-quality.test.js', 'mcp-server.test.js',
      'workflow/transmission/transmission-engine.test.js',
      'reasoning/debate-analyzer.test.js', 'search/semantic-search.test.js',
      'identity/EmpathyAssessment.test.js', 'core/utils.test.js',
    ];
    const bad = [];
    for (const rel of converted) {
      const p = path.join(TEST_DIR, rel);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (!/module\.exports\s*=\s*function/.test(src)) { bad.push(rel + ': 不是 mount 风格'); continue; }
      let out = '';
      try {
        out = execFileSync('node', [MOUNT, p], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
      const m = out.match(/测试结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败,\s*共\s*(\d+)\s*个/);
      if (!m) { bad.push(rel + ': 无汇总行'); continue; }
      if (parseInt(m[3], 10) < 1) bad.push(rel + ': 0 个用例');
      else if (parseInt(m[2], 10) > 0) bad.push(rel + ': ' + m[2] + ' 个失败');
    }
    assertEqual(bad.join('\n'), '',
      '这些已转换的加载检查没有正确接入 harness:\n' + bad.join('\n'));
  });

  test('加载检查不得 require 一个从不使用的 assert', () => {
    // 原模板的第三处问题: `const assert = require('assert')` 从未被使用。
    // 一个引入了断言库却一次不调用的检查，结构上就不可能失败。
    // 只查本轮转换涉及的那批文件，避免误伤别的写法。
    const all = collectAll(TEST_DIR).filter(rel => {
      let src = '';
      try { src = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8'); } catch (e) { return false; }
      return /module loads/.test(src) && /module\.exports\s*=\s*function/.test(src);
    });
    const unused = [];
    for (const rel of all) {
      const src = stripComments(fs.readFileSync(path.join(TEST_DIR, rel), 'utf8'));
      const body = src.slice(src.search(/module\.exports\s*=/));
      if (/require\(['"]assert['"]\)/.test(src) && !/\bassert\s*[.(]/.test(body)) unused.push(rel);
    }
    assertEqual(unused.join('\n'), '',
      '这些加载检查 require 了 assert 却从未使用:\n' + unused.join('\n'));
    assertTrue(all.length > 0, '应存在若干"module loads"形状的加载检查');
  });
};
