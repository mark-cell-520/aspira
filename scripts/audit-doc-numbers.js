/**
 * scripts/audit-doc-numbers.js — 文档诚实数字审计
 *
 * 原则(AGENTS.md #5 Honest numbers)：文档必须说明代码实际做什么；
 * 任何被声称的指标必须可测量。不可证伪的数字比没有数字更糟。
 *
 * 本脚本把 README.md / SKILL.md / AGENTS.md 里声称的每个数字都与代码实测比对。
 * 只报"可测量"的那些——不可测量的说法(如"zero LLM dependency")单独列为待人工确认。
 *
 * 用法: node scripts/audit-doc-numbers.js [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = ['README.md', 'SKILL.md', 'AGENTS.md'];

function readDoc(f) { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } }

// 剥掉 README 的 changelog 表。原因: 表里逐周期记录"当时的数字"(如
// "Modules 132, dispatch routes 1,510 ... 757 tests")，那是历史快照而非当前声称。
// 不剥掉就会把历史记录当成当前声明来核对——修好 routes 实测后，
// "132, dispatch routes" 会变成一条假警报。审计的语义是"现在声称什么"。
function currentClaimsOnly(text) {
  // changelog 表以 "| Version | Date | Change |" 表头开始
  const idx = text.indexOf('| Version | Date | Change |');
  return idx >= 0 ? text.slice(0, idx) : text;
}

// ── 实测 ──────────────────────────────────────────────
function measure() {
  const m = {};

  // 维度数：discriminate() 返回的 dimensions 键数
  const idx = require(path.join(ROOT, 'src', 'index.js'));
  const r = idx.discriminate('这是一个用于实测的句子。', []);
  m.dimensions = Object.keys(r.dimensions || {}).length;

  // 模块数 / 路由数 / initErrors
  // 模块表在 heartflow._modules，但必须走 start() 才注册——构造后直接数是 0，
  // 会把手正确的文档报成「声称132实测0」。审计自己的测量方式错了。
  try {
    const hf = require(path.join(ROOT, 'src', 'core', 'heartflow.js'));
    const inst = new hf.Aspira({ rootPath: ROOT, silent: true });
    if (typeof inst.start === 'function') inst.start();
    m.modules = Object.keys(inst._modules || {}).length;
    m.initErrors = inst.initErrors != null ? inst.initErrors : null;
    try {
      const rt = typeof inst.routes === 'function' ? inst.routes() : null;
      // routes() 返回 {模块名: [路由...]}。文档说的"dispatch routes"是**展开后**的
      // 条目数(1510)，不是模块级键数(132)。首版数键数，于是把正确的 1,510 报成
      // 无法实测——测量口径与文档口径不一致，又是审计自己的错。
      if (rt && typeof rt === 'object') {
        let total = 0;
        for (const k of Object.keys(rt)) {
          const v = rt[k];
          if (Array.isArray(v)) total += v.length;
          else if (v && typeof v === 'object') total += Object.keys(v).length;
          else total += 1;
        }
        m.routes = total;
        m.routesTopLevel = Object.keys(rt).length;
      } else { m.routes = null; }
    } catch (_) { m.routes = null; }
  } catch (_) { m.modules = null; m.initErrors = null; m.routes = null; }

  // MCP 工具数
  try {
    const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));
    m.tools = TOOLS.length;
  } catch (_) { m.tools = null; }

  // 测试文件数 / 用例数由调用方测(需要跑 run-all，慢)

  // 分层计数：按 gate 动作归类维度(读 AGENTS.md 的三张表并核对)
  const doc = readDoc('AGENTS.md');
  const grab = (label) => {
    const re = new RegExp(`\\*\\*${label}[^*]*\\*\\*:?\\s*([^\\n]+)`);
    const mm = re.exec(doc);
    return mm ? mm[1].trim() : null;
  };
  const blockList = grab('Block-level');
  const rewriteList = grab('Rewrite-level');
  const verifyList = grab('Verify-level');
  const scoredList = /Dimensions that are scored but do not force a gate action:\s*([\s\S]*?)\n\n/.exec(doc);
  m.tiers = {
    block: blockList ? blockList.split(',').filter(Boolean).length : null,
    rewrite: rewriteList ? rewriteList.split(',').filter(Boolean).length : null,
    verify: verifyList ? verifyList.split(',').filter(Boolean).length : null,
    scored: scoredList ? scoredList[1].split(/[,\n]/).map(s => s.trim()).filter(Boolean).length : null,
  };

  // 包声明的最低 Node 版本
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    m.nodeReq = (pkg.engines && pkg.engines.node) || null;
  } catch (_) { m.nodeReq = null; }

  // VERSION
  try {
    m.version = require(path.join(ROOT, 'src', 'core', 'version.js')).VERSION || null;
  } catch (_) { m.version = null; }

  return m;
}

// ── 文档声称 ──────────────────────────────────────────
function claims() {
  const out = [];
  for (const f of DOCS) {
    const s = currentClaimsOnly(readDoc(f));
    if (!s) continue;
    const pats = [
      { re: /(\d+)\s+discrimination dimensions/g, key: 'dimensions', what: 'dimensions' },
      { re: /(\d+)\s+modules\s*[×,.]/g, key: 'modules', what: 'modules' },
      { re: /(\d+)\s+MCP tools/g, key: 'tools', what: 'MCP tools' },
      // 千分位逗号必须一起吃下: "1,510 dispatch routes" 否则只捕到 510，
      // 于是把正确的文档报成不符——审计自己的正则 bug。
      { re: /(\d[\d,]*)\s+dispatch\s+routes/g, key: 'routes', what: 'dispatch routes' },
      { re: /(\d+)-layer pipeline/g, key: 'layers', what: 'pipeline layers' },
      { re: /Block-level\s*\((\d+)\)/g, key: 'tier_block', what: 'Block-level count' },
      { re: /Rewrite-level\s*\((\d+)\)/g, key: 'tier_rewrite', what: 'Rewrite-level count' },
      { re: /Verify-level\s*\((\d+)\)/g, key: 'tier_verify', what: 'Verify-level count' },
      // Node.js 要求带 >= 前缀，声称值要连前缀一起取，否则 "18.17" vs ">=18.17"
      // 会被判成不符——又一个正则 bug 产出假发现。
      { re: /Node\.js\s*(>=\s*\d+(?:\.\d+)*)/g, key: 'nodeReq', what: 'Node.js requirement' },
      // ── 表格形态(数字在标签之后) ──
      // [审计盲区修复] 以上全部是"数字在前"的散文形态。SKILL.md 的
      // "## Verified metrics" 是一张 `| 指标 | 值 | 实测方法 |` 表，数字在标签**之后**，
      // 于是整张表的腐烂完全不可见: 实测 dimensions=54 而表里写 51、
      // tools=181 而表里写 180、测试数 852 而表里写 740——审计却报 20/20 全一致。
      // 章节标题里的数字同样漏网: "separate from the 51 text dimensions"。
      // 这些不是历史记录(SKILL.md 没有 changelog 表，整篇都是当前声称)。
      { re: /\|\s*Discrimination dimensions\s*\|\s*(\d+)\s*\|/g, key: 'dimensions', what: 'dimensions (表格)' },
      { re: /\|\s*Modules registered\s*\|\s*(\d+)\s*\|/g, key: 'modules', what: 'modules (表格)' },
      { re: /\|\s*MCP tools\s*\|\s*(\d+)\s*\|/g, key: 'tools', what: 'MCP tools (表格)' },
      { re: /\|\s*Dispatch routes\s*\|\s*([\d,]+)\s*\|/g, key: 'routes', what: 'dispatch routes (表格)' },
      { re: /\|\s*Test suite\s*\|\s*([\d,]+)\s+passing/g, key: 'tests', what: 'test suite (表格)' },
      { re: /separate from the (\d+) text dimensions/g, key: 'dimensions', what: 'dimensions (章节标题)' },
      // 分层散文形态: "**9 can `block`**" 等(数字在形容词前，与 Block-level(N) 不同形)
      { re: /\*\*(\d+) can `block`\*\*/g, key: 'tier_block', what: 'Block-level count (散文)' },
      { re: /\*\*(\d+) can force\s*a `rewrite`\*\*/g, key: 'tier_rewrite', what: 'Rewrite-level count (散文)' },
      { re: /\*\*(\d+) request `verify`\*\*/g, key: 'tier_verify', what: 'Verify-level count (散文)' },
    ];
    for (const p of pats) {
      let mm;
      const re = new RegExp(p.re.source, 'g');
      while ((mm = re.exec(s)) !== null) out.push({ doc: f, what: p.what, key: p.key, claimed: mm[1] });
    }
  }
  return out;
}

const m = measure();
const cl = claims();

// 每个声称对应的实测值
// 注意求值顺序: m.routes / m.layers 在下面的 try 块里才被赋值，
// 若在对象字面量里提前引用会得到 undefined——首版正是如此，把已测得的层数
// 报成"无法实测"。故此处先用占位，测量后再回填。
const actual = {
  dimensions: m.dimensions,
  modules: m.modules,
  tools: m.tools,
  routes: null,
  layers: null,
  tier_block: m.tiers.block,
  tier_rewrite: m.tiers.rewrite,
  tier_verify: m.tiers.verify,
  nodeReq: m.nodeReq,
  tests: null,
};

// 测试条数实测: 必须跑 run-all 取权威数字。
// 不能静态数 test( 声明——实测静态 808 而 run-all 报 852，差 44:
// 有用例在循环里生成(如对每个维度各建一例)，静态扫描数不到。
// 这同时意味着 test/doc-numbers.test.js 里那个 ASPIRA_MEASURED_TESTS
// 环境变量从未被任何地方设置过，该断言一直静默退化成"只断言是正数"——
// 真正的测试条数校验只能由本脚本(或调用方)完成。
try {
  const { execSync } = require('child_process');
  const out = execSync('node test/run-all.js', { cwd: ROOT, encoding: 'utf8', timeout: 900000, stdio: ['ignore', 'pipe', 'ignore'] });
  // 必须取**最后**一条匹配: run-all.js 对每个测试文件都打印一行
  // "测试结果: N 通过, 0 失败, 共 N 个"，最终汇总行形状与之相同。
  // 首版用 exec 取第一条，拿到的是某个测试文件的 10 通过，于是一条
  // 正确的文档声称被报成"实测 10"——审计自己的 bug 产出假警报。
  const all = [...out.matchAll(/测试结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败/g)];
  const tm = all.length ? all[all.length - 1] : null;
  m.tests = tm ? Number(tm[1]) : null;
  m.testsFailed = tm ? Number(tm[2]) : null;
} catch (_) { m.tests = null; }

// 层数实测: 从 src/pipeline.js 的 checked_by.push({ layer: 'X' }) 静态提取。
// 不能靠跑一次 pipeline 数 checked_by——那条路径只走命中分支(实测同一输入
// 只得 12 条)，会低估真实层数。静态提取去重后得 17 层。
// 文档此前声称"14 层"，且名单里 3 个层(evidence verify / rewriter /
// self-diagnosis)在代码中根本不存在，同时漏掉 8 个真实层——静态提取才能查出。
try {
  const pipeSrc = fs.readFileSync(path.join(ROOT, 'src', 'pipeline.js'), 'utf8');
  const pushes = [...pipeSrc.matchAll(/checked_by\.push\(\{\s*layer:\s*'([a-z-]+)'/g)].map(x => x[1]);
  const order = [];
  for (const p of pushes) if (!order.includes(p)) order.push(p);
  m.layers = order.length;
  m.layerOrder = order;
} catch (_) { m.layers = null; m.layerOrder = null; }

actual.routes = m.routes;
actual.layers = m.layers;
actual.tests = m.tests;

const rows = cl.map(c => {
  const a = actual[c.key];
  // 千分位归一化后再比: 文档写 1,510，实测 1510
  // 归一化: 去千分位逗号、去所有空白。文档写 ">= 18.17" 而 package.json 写
  // ">=18.17"——那是排版差异不是数字不符，首版因此产出两条假警报。
  const norm = (v) => String(v).replace(/,/g, '').replace(/\s+/g, '').trim();
  const ok = a == null ? null : norm(a) === norm(c.claimed);
  return { ...c, actual: a, ok };
});

// 层名单比对: SKILL.md 的 "## The N-layer check pipeline" 代码块
let layerListClaim = null;
try {
  const sk = readDoc('SKILL.md');
  const blk = /## The (\d+)-layer check pipeline\s*\n```([\s\S]*?)```/.exec(sk);
  if (blk) {
    // 与 test/doc-numbers.test.js 同一套解析: lookahead 需接受 "("，
    // 否则 "discriminate(54 dims)" 里的 discriminate 会被漏出名单。
    const flat = blk[2].replace(/\s+/g, ' ');
    const names = [...flat.matchAll(/([a-z][a-z-]+)(?=\s*->|\s*$|\s*\()/g)].map(x => x[1])
      .filter(n => n !== 'input' && n !== 'output' && n !== 'dims');
    layerListClaim = { claimedCount: Number(blk[1]), names };
  }
} catch (_) {}


const bad = rows.filter(r => r.ok === false);
const unmeasurable = rows.filter(r => r.ok === null);
const okRows = rows.filter(r => r.ok === true);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ measured: m, rows }, null, 2));
} else {
  console.log('=== 文档诚实数字审计 ===');
  console.log(`实测: dimensions=${m.dimensions} modules=${m.modules} tools=${m.tools} `
    + `initErrors=${m.initErrors} layers=${actual.layers} nodeReq=${m.nodeReq} VERSION=${m.version}`);
  console.log(`AGENTS.md 分层声明: block=${m.tiers.block} rewrite=${m.tiers.rewrite} verify=${m.tiers.verify} scored=${m.tiers.scored}`);
  console.log(`\n文档声称总数: ${rows.length} | 与实测一致: ${okRows.length} | 不一致: ${bad.length} | 无法实测: ${unmeasurable.length}`);
  if (bad.length) {
    console.log('\n--- ❌ 与实测不符(必须修) ---');
    for (const r of bad) console.log(`  ${r.doc} 声称「${r.what} = ${r.claimed}」实测 ${r.actual}`);
  }
  if (layerListClaim) {
    const real = m.layerOrder || [];
    const missing = real.filter(l => !layerListClaim.names.includes(l));
    const fictional = layerListClaim.names.filter(l => !real.includes(l));
    console.log(`\n--- 层名单比对(SKILL.md 代码块) ---`);
    console.log(`  文档声称 ${layerListClaim.claimedCount} 层、列出 ${layerListClaim.names.length} 个层名; 代码实测 ${real.length} 层`);
    if (missing.length) console.log(`  ❌ 代码存在但文档漏掉(${missing.length}): ${missing.join(', ')}`);
    if (fictional.length) console.log(`  ❌ 文档列出但代码不存在(${fictional.length}): ${fictional.join(', ')}`);
    if (!missing.length && !fictional.length) console.log(`  ✓ 名单一致`);
    console.log(`  代码实测顺序: ${real.join(' → ')}`);
  }
  if (unmeasurable.length) {
    console.log('\n--- ⚠ 无法自动实测(需人工确认) ---');
    const seen = new Set();
    for (const r of unmeasurable) {
      const k = `${r.doc}|${r.what}|${r.claimed}`;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`  ${r.doc} 声称「${r.what} = ${r.claimed}」`);
    }
  }
}
