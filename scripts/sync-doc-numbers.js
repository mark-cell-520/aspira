#!/usr/bin/env node
/**
 * sync-doc-numbers.js — 把"测试条数"这一类会漂移的数字从实测值同步进文档。
 *
 * 为什么要有这个脚本:
 *   审计(audit-doc-numbers.js)是**独立校验器**, 它跑 run-all.js 取权威数字,
 *   再和文档里的声称逐条比对。这是对的——校验器必须可能报红, 否则它什么也没证明。
 *   但凡是手填常数的地方, 套件一涨、文档忘改, 审计就红。本会话为此连续修过数轮
 *   (1401 vs 1435 漂了 34 个, 跨 README/SKILL/CURRENT_STATE 四处称呼点)。
 *
 * ⚠ 这个脚本**刻意不**并进审计:
 *   如果审计自己修文档, 它就在也无法报红了——"能顺手修好的校验"等于没校验。
 *   所以修在这里(手动调用), 审在那里(只读)。两条路径分开, 各自保持诚实。
 *
 * 用法:
 *   node scripts/sync-doc-numbers.js          # 同步并打印改了什么
 *   node scripts/sync-doc-numbers.js --dry    # 只报告, 不落盘
 *
 * 它只同步**测试条数**这一类。版本号、模块数、工具数等其他数字不在此列——
 * 那些有各自的来源(VERSION 是唯一真源), 不该由本脚本推断。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

/**
 * **纯函数**: 从 run-all.js 的 stdout 文本里解析出 (passed, failed)。
 *
 * 为什么单拎出来: 这两个坑都出在这一步, 而不在改文件那一步——
 *   ① 把 stderr 也拼进输出, 于是"最后一个匹配"落到 stderr 里某个测试文件
 *      自己的行上, 实测值变成 10;
 *   ② 用 match() 取第二条(其实是第二个**完整匹配**, 不是第二个分组),
 *      拿到的同样是某个测试文件的 "10 通过"。
 * 单拎成纯函数后, 这两个坑都能在**毫秒级**的测试里钉住, 不必每次跑 90 秒 run-all。
 * test/sync-doc-numbers-parsing.test.js 锁定它。
 *
 * ⚠ 这个坑 audit-doc-numbers.js 的注释里已经写过一遍, 我又踩了一次:
 *   "首版用 exec 取第一条，拿到的是某个测试文件的 10 通过，于是一条
 *    正确的文档声称被报成'实测 10'——审计自己的 bug 产出假警报。"
 *
 * @param {string} stdout run-all.js 的 stdout
 * @returns {{passed: (number|null), failed: (number|null)}}
 */
function parseRunAllOutput(stdout) {
  const out = (stdout === null || stdout === undefined) ? '' : String(stdout);
  // 必须取**最后**一条匹配: run-all.js 对每个测试文件都打印一行
  // "测试结果: N 通过, 0 失败, 共 N 个", 最终汇总行形状与之相同。
  const all = [...out.matchAll(/测试结果:\s*(\d+)\s+通过,\s*(\d+)\s+失败/g)];
  const tm = all.length ? all[all.length - 1] : null;
  if (!tm) return { passed: null, failed: null };
  return { passed: Number(tm[1]), failed: Number(tm[2]) };
}

/** 与 audit-doc-numbers.js 同一套取数逻辑(逐字对齐, 包括它注释里记的那个坑)。 */
function measureTests() {
  const r = spawnSync('node', ['test/run-all.js'], {
    cwd: ROOT, encoding: 'utf8', timeout: 900000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  // 只读 stdout。首版我把 stdout+stderr 拼接, 于是"最后一个匹配"落到了
  // stderr 里, 实测值变成 10, 把 1435 写成 10。
  return parseRunAllOutput(r && r.stdout ? r.stdout.toString() : '');
}

/**
 * 四项称呼点。repl() 统一做同一件事: 拿实测值替换"通过数"分组,
 * 失败数只在表格形态里出现, 一并同步。
 * 正则与 audit 里的核对形态一一对应, 保证"同步器写的"就是"审计看的"。
 */
const SITES = [
  {
    file: 'README.md', label: '指标横条 (passing tests)', numGroup: 1,
    re: /(×\s+)([\d,]+)(\s+passing tests)/g,
    repl: (n, f) => (m, g1, _g2, g3) => g1 + n + g3,
  },
  {
    file: 'README.md', label: '指标表 (Test suite | N passing / F failing)', numGroup: 1,
    re: /(\|\s*Test suite\s*\|\s*)([\d,]+)(\s+passing\s*\/\s*)([\d,]+)(\s+failing\s*\|)/g,
    repl: (n, f) => (m, g1, _g2, g3, _g4, g5) => g1 + n + g3 + f + g5,
  },
  {
    file: 'SKILL.md', label: '指标表 (Test suite | N passing / F failing)', numGroup: 1,
    re: /(\|\s*Test suite\s*\|\s*)([\d,]+)(\s+passing\s*\/\s*)([\d,]+)(\s+failing\s*\|)/g,
    repl: (n, f) => (m, g1, _g2, g3, _g4, g5) => g1 + n + g3 + f + g5,
  },
  {
    file: 'CURRENT_STATE.md', label: '状态行 (N tests passed / F failed)', numGroup: 0,
    re: /(\d[\d,]*)(\s+tests?\s+passed)/g,
    repl: (n) => (m, _g1, g2) => n + g2,
  },
];

function main() {
  const m = measureTests();
  if (m.passed === null) {
    console.error('sync-doc-numbers: 无法从 run-all.js 取到测试条数, 放弃(不改任何文件)。');
    process.exit(1);
  }
  // [安全闸] 有失败的一律不同步。
  // 实测踩到过: 同一次改动, run-all 一会 1435/0 一会 1431/4(audit 活体写入族
  // 间歇性红灯)。首版没有这道闸, 于是一次 flaky 读数被原样写进了四个文档,
  // 下一次干净运行又会把审计照红——**同步器成了漂移的传播者**。
  // 原则: 只从**全绿**的运行里取数, 否则宁可不动。
  if (m.failed !== 0) {
    console.error(`sync-doc-numbers: 本轮 run-all 报 ${m.passed} 通过 / ${m.failed} 失败, 非全绿, 拒绝同步。`);
    console.error('  请先查那几条失败(已知的 audit 活体写入族会间歇性红灯, 隔离复跑可确认), 全绿后再同步。');
    process.exit(2);
  }
  const total = String(m.passed);
  console.log(`实测: ${m.passed} 通过 / ${m.failed} 失败`);
  console.log(DRY ? '(dry-run: 只报告, 不落盘)' : '');

  // 按文件分组, 先读全再写, 避免半文件状态。
  const byFile = new Map();
  for (const s of SITES) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file).push(s);
  }

  let changed = 0;
  for (const [file, sites] of byFile) {
    const p = path.join(ROOT, file);
    let text = fs.readFileSync(p, 'utf8');
    const before = text;
    for (const s of sites) {
      s.re.lastIndex = 0;
      const seen = [];
      text = text.replace(s.re, (...args) => {
        const whole = args[0];
        const groups = args.slice(1, -2);
        const oldNum = groups[s.numGroup];
        seen.push(oldNum);
        if (oldNum === total) return whole;
        return s.repl(total, String(m.failed))('', ...groups);
      });
      for (const n of seen) {
        const mark = n === total ? ' 一致' : ` → ${total}`;
        console.log(`  ${file} [${s.label}]: ${n}${mark}`);
        if (n !== total) changed++;
      }
    }
    if (text !== before) {
      if (DRY) console.log(`  ${file}: 有改动, dry-run 未写入`);
      else { fs.writeFileSync(p, text); console.log(`  ${file}: 已写入`); }
    }
  }

  if (changed === 0) console.log('\n无需改动: 所有称呼点已与实测一致。');
  else console.log(`\n共 ${changed} 处不一致。同步后请重跑 node scripts/audit-doc-numbers.js 复核。`);
}

// 只在被**直接执行**时同步; 被 require(测试) 时不跑 main,
// 否则 test/sync-doc-numbers-parsing.test.js 一加载就会去 spawn 整个 run-all。
if (require.main === module) main();

module.exports = { parseRunAllOutput, SITES, ROOT };
