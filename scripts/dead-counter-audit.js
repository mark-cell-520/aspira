#!/usr/bin/env node
/**
 * scripts/dead-counter-audit.js — 扫「被指标依赖却从未自增的计数器」
 *
 * ═══ 这个脚本为什么存在 ═══
 * 上一轮(cycle 20)在填测试覆盖缺口时，连续抓到两个形状完全相同的缺陷:
 *   · kv-cache.js 的 `hitRate = hits / Math.max(1, loads)` —— `loads` 从未自增
 *   · reflexion-engine.js 的 `successRate` —— 依赖的过滤器读错字段，永远数出 0
 * 两个都是「**一个被报告指标依赖的计数，实际上永远是 0 / 恒值**」。
 * 两个就够了: 形状如此明确，很可能是系统性的，值得全库扫一遍。
 *
 * ═══ 方法(以及它自己的盲区) ═══
 * 对每个 src 模块，找出形如 `this._stats.X++` / `this.stats.X++` / `this.X++` 的自增，
 * 以及形如 `this._stats.X` 的读取，然后报告「被读取但从未自增」的字段名。
 *
 * **盲区一(最重要): 自增可能不在本文件。** 若计数器定义在 A 模块、
 * 由 B 模块自增，本脚本会把 A 的该字段误报成死计数器。所以每个命中都必须
 * 人工确认「有没有别处自增它」——脚本只负责缩小范围，不下结论。
 *
 * **盲区二: 自增可能写得不一样。** `this._stats.loads = (this._stats.loads||0)+1`、
 * `this._stats.loads += 1`、`Object.assign` 都不匹配 `++` 字面量。
 * 本脚本三种都认，但仍可能有漏网写法。
 *
 * **盲区三: 有些计数器设计上就该是 0**(例如只在特定分支递增的失败计数)。
 * 所以输出是「待查清单」而非「缺陷清单」。
 *
 * ═══ 上一轮的教训 ═══
 * dimension-health-audit 的两版错误都是「把仪器的局限说成引擎的缺陷」。
 * 本脚本刻意把输出标成 CANDIDATE，并且在头部写清三个盲区——
 * 一个会误报的审计比没有审计更糟。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function walk(dir) {
  const out = [];
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { rec(p); continue; }
      if (e.name.endsWith('.js')) out.push(p);
    }
  };
  rec(dir);
  return out;
}

const srcFiles = walk(SRC);

// 全库源码，用于跨文件确认
const ALL_SRC = srcFiles.map(f => ({ rel: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf8') }));

const candidates = [];

for (const f of srcFiles) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');

  // 收集本文件里所有被自增的计数器「对象.字段」组合
  //
  // ⚠️ 首版正则是 `/\b(this\.X)\s*(\+\+|...)\s*1?\b/`，尾部的 `\s*1?\b`
  // 在 `++` 位于**行尾**时永远不匹配(后面没有字符可构成 \b)，
  // 于是每一句单独的 `this._stats.foo++;` 都被判成「从未自增」——
  // 第一遍跑出 193 处命中，其中一大半是这种假阳性。
  // 这是 dimension-health-audit 错两次的同源故障第三次出现:
  // **仪器把自己的正则缺陷报告成引擎缺陷。** 先修仪器，再看结果。
  const incremented = new Set();
  // 形式一: expr++ / expr-- / expr += 1 / expr -= 1
  const incRe = /\b((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*(?:\+\+|--|\+=|-=)/g;
  // 形式二: expr = expr + 1 / expr = (expr || 0) + 1 / expr = expr - 1
  //         注意 `[^;]*?` 必须放到 \1 之后，因为兜底写法
  //         `x = (x || 0) + 1` 在 x 与 +1 之间隔着 `|| 0)`。
  //         首版写成 `\1\s*(?:\+|-)\s*1`，于是每一处 `(x||0)+1` 都被判成
  //         「从未自增」——本轮仪器第二次出错，同样是假阳性。
  const selfIncRe = /\b((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*=\s*[^;]*?\b\1\b[^;]*?\s*(?:\+|-)\s*1\b/g;
  // 形式三: 动态键自增，如 this._stats.byType[t] = (this._stats.byType[t] || 0) + 1
  //         取容器名(去掉最后一段)，按容器认定其字段被自增
  const dynIncRe = /\b((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\[[^\]]*\]\s*=\s*[^;]*?\b\1\b\s*\[[^\]]*\][^;]*?\s*(?:\+|-)\s*1\b/g;
  for (const l of lines) {
    if (/^\s*\/\//.test(l)) continue;               // 跳过注释行
    let m;
    incRe.lastIndex = 0;
    while ((m = incRe.exec(l))) incremented.add(m[1]);
    selfIncRe.lastIndex = 0;
    while ((m = selfIncRe.exec(l))) incremented.add(m[1]);
    dynIncRe.lastIndex = 0;
    while ((m = dynIncRe.exec(l))) {
      // 记容器本身，使该容器下任何字段都不再报候选
      const parts = m[1].split('.');
      if (parts.length >= 3) incremented.add(parts.slice(0, -1).join('.'));
    }
  }

  // 找出所有 `X.Y` 形式的字段访问，若该组合从未自增，则是候选
  // 只关心统计类容器，避免把普通属性也扫进来
  const STAT_CONTAINERS = /(?:^|\.)(_?stats|_stats|counters|metrics|_metrics)$/;
  const seen = new Set();
  const fieldRe = /\b(this\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\b/g;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\/\//.test(l)) continue;
    let m;
    fieldRe.lastIndex = null;
    fieldRe.lastIndex = 0;
    while ((m = fieldRe.exec(l))) {
      const expr = m[1];                       // 例如 this._stats.loads
      const parts = expr.split('.');
      // 至少三段: this.<container>.<field>
      if (parts.length < 3) continue;
      const container = parts[parts.length - 2];
      if (!STAT_CONTAINERS.test(container)) continue;
      const field = parts[parts.length - 1];
      const key = expr;
      if (seen.has(key)) continue;
      seen.add(key);
      if (incremented.has(expr)) continue;     // 本文件自增过，跳过
      // 容器被动态自增过(如 byType[t]++),该容器下字段都跳过
      if (parts.length >= 3 && incremented.has(parts.slice(0, -1).join('.'))) continue;
      // **直接赋值的重算值不是计数器**: `this.stats.totalMemories = this.memories.size`
      // 这类字段设计上就是每次重算，不该进候选清单。
      // 首版没排它，于是 3 处 totalMemories / totalRelationships / lastCleanup
      // 全被误报——又一个"仪器局限当引擎缺陷"。
      const directAssign = new RegExp(
        `\\b${expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?!\\s*(?:${expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*)?(?:\\+|-)\\s*1\\b)`
      );
      if (directAssign.test(l)) continue;
      // 跨文件确认: 全库有没有别处自增它
      const incElsewhere = ALL_SRC.some(x => {
        if (x.rel === rel) return false;
        const re = new RegExp(`\\b${expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\+\\+|--|\\+=|-=)`);
        return re.test(x.src);
      });
      if (incElsewhere) continue;              // 别处自增，非死计数器
      candidates.push({ rel, line: i + 1, expr, snippet: l.trim().slice(0, 110) });
    }
  }
}

// 按字段聚合，找出「出现多次但从未自增」的(更可能是真缺陷)
const byField = new Map();
for (const c of candidates) {
  const k = c.expr;
  if (!byField.has(k)) byField.set(k, []);
  byField.get(k).push(c);
}

console.log('\n=== 死计数器候选(需人工确认，非缺陷清单) ===\n');
console.log(`  扫描 ${srcFiles.length} 个 src 模块，命中 ${candidates.length} 处读取、${byField.size} 个字段\n`);

const rows = [...byField.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [expr, hits] of rows.slice(0, 40)) {
  console.log(`  ${expr}  (${hits.length} 处读取, 0 处自增)`);
  for (const h of hits.slice(0, 3)) {
    console.log(`      ${h.rel}:${h.line}  ${h.snippet}`);
  }
}
if (rows.length > 40) console.log(`  …另 ${rows.length - 40} 个字段`);

console.log('\n  盲区: ① 自增可能在别的文件(已尽量跨文件排除)');
console.log('        ② 非 ++ 写法的自增可能漏认');
console.log('        ③ 设计上就该为 0 的计数器会出现在此清单里');
console.log('        → 这是待查清单，不是缺陷清单。每个命中都要先复现再下结论。\n');

module.exports = { candidates, byField };
