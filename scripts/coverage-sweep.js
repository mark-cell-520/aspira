#!/usr/bin/env node
/**
 * scripts/coverage-sweep.js — 找出「没有测试引用」的 src/ 模块
 *
 * ═══ 为什么要区分两类 ═══
 * AGENTS.md 里记着这个教训: 按文件名匹配会把「仅被间接调用」的模块
 * 报成未覆盖。所以每个候选都必须再查一次「src/ 里有没有人 require 它」。
 *
 * 三类，价值完全不同:
 *   A. **无测试引用 + 无 src 引用** → 可能是死代码。先确认再动手。
 *   B. **无测试引用 + 有 src 引用** → **活着但没测**。这是最高价值的缺口:
 *      管线在跑它，却没有任何断言说它应该怎样工作。
 *   C. 有测试引用 → 已覆盖。
 *
 * 本脚本只做事实清点，不下结论。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TEST = path.join(ROOT, 'test');

function walk(dir, filter) {
  const out = [];
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { rec(p); continue; }
      if (filter(e.name)) out.push(p);
    }
  };
  rec(dir);
  return out;
}

const srcFiles = walk(SRC, n => n.endsWith('.js'));
const testFiles = walk(TEST, n => n.endsWith('.js'));

// 每个模块的 basename(不含 .js)与相对路径
const mods = srcFiles.map(f => ({
  file: f,
  rel: path.relative(ROOT, f),
  base: path.basename(f, '.js'),
  lines: fs.readFileSync(f, 'utf8').split('\n').length,
}));

// 测试文件内容(用于判断是否引用)
const testSrc = testFiles.map(f => fs.readFileSync(f, 'utf8'));
// src 文件内容(用于判断是否被其他模块 require)
const srcSrc = srcFiles.map(f => ({ rel: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf8') }));

const referencedByTest = (m) => testSrc.some(s => s.includes(m.base));
// 被 src 引用: require('./xxx') 或 require('../dir/xxx')，按 basename 匹配
const requiredBySrc = (m) => srcSrc.some(x => {
  if (x.rel === m.rel) return false;                    // 自己不算
  const re = new RegExp(`require\\(\\s*['"][^'"]*${m.base}(?:\\.js)?['"]\\s*\\)`);
  return re.test(x.src);
});

const cats = { A: [], B: [], C: [] };
for (const m of mods) {
  const byTest = referencedByTest(m);
  const bySrc = requiredBySrc(m);
  if (byTest) cats.C.push(m);
  else if (bySrc) cats.B.push(m);
  else cats.A.push(m);
}

const byLines = (a, b) => b.lines - a.lines;
cats.A.sort(byLines); cats.B.sort(byLines); cats.C.sort(byLines);

console.log('\n=== 测试覆盖清点 ===\n');
console.log(`  src 模块 ${mods.length} 个 | 测试文件 ${testFiles.length} 个`);
console.log(`  A 无测试引用且无 src 引用(疑似死代码): ${cats.A.length}`);
console.log(`  B 无测试引用但有 src 引用(活着但没测): ${cats.B.length}`);
console.log(`  C 有测试引用: ${cats.C.length}`);

console.log('\n  ── B: 活着但没测(最高价值缺口) ──');
for (const m of cats.B.slice(0, 40)) {
  console.log(`    ${String(m.lines).padStart(5)} 行  ${m.rel}`);
}
if (cats.B.length > 40) console.log(`    …另 ${cats.B.length - 40} 个`);

console.log('\n  ── A: 疑似死代码(动手前先确认) ──');
for (const m of cats.A.slice(0, 25)) {
  console.log(`    ${String(m.lines).padStart(5)} 行  ${m.rel}`);
}
if (cats.A.length > 25) console.log(`    …另 ${cats.A.length - 25} 个`);

const bLines = cats.B.reduce((s, m) => s + m.lines, 0);
const aLines = cats.A.reduce((s, m) => s + m.lines, 0);
console.log(`\n  B 合计 ${bLines} 行 | A 合计 ${aLines} 行\n`);

module.exports = { cats, mods };
