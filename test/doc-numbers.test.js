/**
 * test/doc-numbers.test.js — 文档诚实数字回归
 *
 * 原则(AGENTS.md #5 Honest numbers)：文档必须说明代码实际做什么；
 * 任何被声称的指标必须可测量。不可证伪的数字比没有数字更糟。
 *
 * 本测试锁的是"文档声称 vs 代码实测"这一边界。历史上它反复漂移：
 *   - README 头部写 "740 passing tests" 而实测已 800
 *   - SKILL.md 写 "14-layer pipeline"，而 src/pipeline.js 实测 17 层
 *   - 该 14 层名单里 3 个层(evidence verify / rewriter / self-diagnosis)
 *     在代码中根本不存在，同时漏掉 9 个真实层
 *   - 名单把 gate 排在第 4 位，而代码里 gate 是第 10 个执行的层
 *   - discriminate(51 dims) 的维度数陈旧，实际 54
 *
 * 同类审计 scripts/audit-doc-numbers.js 做全量比对；本测试锁定其中最易腐烂的
 * 几项，使任何一次文档编辑如果改坏数字，test/run-all.js 立刻失败。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
const { withDocLock, readDoc } = require('./_doc-probe-lock.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(f) { return readDoc(path.join(ROOT, f)); }

// 从 src/pipeline.js 静态提取真实层名单(按执行顺序)
function realLayers() {
  const src = read('src/pipeline.js');
  const pushes = [...src.matchAll(/checked_by\.push\(\{\s*layer:\s*'([a-z-]+)'/g)].map(m => m[1]);
  const order = [];
  for (const p of pushes) if (!order.includes(p)) order.push(p);
  return order;
}

// 从 SKILL.md 提取文档声称的层名单
function docLayers() {
  const sk = read('SKILL.md');
  const blk = /## The (\d+)-layer check pipeline\s*\n```([\s\S]*?)```/.exec(sk);
  if (!blk) return null;
  // 代码块里 "a -> b -> c" 与 "a\n -> b" 两种折行都要处理
  const flat = blk[2].replace(/\s+/g, ' ');
  // lookahead 必须也接受 "(" —— 文档写 "discriminate(54 dims)"，层名后紧跟
  // 括号而非 "->"。首版只认 "->" 和行尾，于是 discriminate 被漏出名单，
  // 测试反过来把正确的文档报成"漏掉一层"。解析器的 bug，不是文档的 bug。
  const names = [...flat.matchAll(/([a-z][a-z-]+)(?=\s*->|\s*$|\s*\()/g)].map(m => m[1])
    .filter(n => n !== 'input' && n !== 'output' && n !== 'dims');
  return { claimedCount: Number(blk[1]), names };
}

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('pipeline 层数与文档声称一致', () => {
    const real = realLayers();
    const doc = docLayers();
    assertTrue(!!doc, 'SKILL.md 应包含 "## The N-layer check pipeline" 代码块');
    assertEqual(doc.claimedCount, real.length,
      `SKILL.md 声称 ${doc.claimedCount} 层，代码实测 ${real.length} 层`);
  });

  test('pipeline 层名单与代码一致(不漏、不虚构)', () => {
    const real = realLayers();
    const doc = docLayers();
    assertTrue(!!doc, 'SKILL.md 应包含 pipeline 代码块');
    const missing = real.filter(l => !doc.names.includes(l));
    const fictional = doc.names.filter(l => !real.includes(l));
    assertEqual(missing.length, 0, `代码存在但文档漏掉: ${missing.join(', ')}`);
    assertEqual(fictional.length, 0, `文档列出但代码不存在: ${fictional.join(', ')}`);
  });

  test('文档中的 pipeline 层顺序与代码执行顺序一致', () => {
    // 顺序错也是错: 旧文档把 gate 排第 4，代码里 gate 是第 10 个执行的层。
    const real = realLayers();
    const doc = docLayers();
    assertTrue(!!doc, 'SKILL.md 应包含 pipeline 代码块');
    // 只比对两侧都出现的层，按文档顺序看是否构成代码顺序的子序列
    const both = doc.names.filter(n => real.includes(n));
    let ri = 0;
    for (const n of both) {
      const at = real.indexOf(n, ri);
      assertTrue(at >= 0, `层顺序与代码不符: ${n} 出现在 ${real[ri] || '(末)'} 之前`);
      ri = at + 1;
    }
  });

  test('README/SKILL 头部的层数一致', () => {
    const real = realLayers().length;
    for (const f of ['README.md', 'SKILL.md']) {
      const m = new RegExp(`(\\d+)-layer pipeline`).exec(read(f));
      assertTrue(!!m, `${f} 应声称 N-layer pipeline`);
      assertEqual(Number(m[1]), real, `${f} 声称 ${m[1]} 层，实测 ${real}`);
    }
  });

  test('README 的测试数与实测一致', () => {
    // 这一条对应一个真实漂移: README 头部写 740 passing tests，实测已 800。
    // 测试数会随每轮升级增长，故此断言按"文档不得低于实测"的方向设计：
    // 文档数字必须等于或大于实测(大于说明文档超前，同样不允许)。
    const readme = read('README.md');
    const m = /(\d+) passing tests/.exec(readme) || /(\d+) passing \/ 0 failing/.exec(readme);
    assertTrue(!!m, 'README 应声称测试通过数');
    const claimed = Number(m[1]);
    // 实测通过数由调用方通过环境变量注入(run-all 已知)；未提供时跳过数值比对，
    // 但仍断言文档里确实有一个具体数字(而非空泛表述)。
    const measured = process.env.ASPIRA_MEASURED_TESTS ? Number(process.env.ASPIRA_MEASURED_TESTS) : null;
    if (measured != null) {
      assertEqual(claimed, measured, `README 声称 ${claimed} passing tests，实测 ${measured}`);
    } else {
      assertTrue(claimed > 0, 'README 的测试通过数应为正数');
    }
  });

  test('discriminate 维度数与文档一致', () => {
    const idx = require('../src/index.js');
    const dims = Object.keys(idx.discriminate('这是一个用于实测的句子。', []).dimensions).length;
    const sk = read('SKILL.md');
    const m = /discriminate\((\d+) dims\)/.exec(sk);
    assertTrue(!!m, 'SKILL.md 的 pipeline 图应标注 discriminate(N dims)');
    assertEqual(Number(m[1]), dims, `SKILL.md 标注 discriminate(${m[1]} dims)，实测 ${dims}`);
  });

  test('MCP 工具数与文档一致', () => {
    const { TOOLS } = require('../src/mcp/tools-registry.js');
    for (const f of ['README.md', 'SKILL.md', 'AGENTS.md']) {
      const m = new RegExp(`(\\d+)\\s+MCP tools`).exec(read(f));
      assertTrue(!!m, `${f} 应声称 MCP 工具数`);
      assertEqual(Number(m[1]), TOOLS.length, `${f} 声称 ${m[1]} 个工具，实测 ${TOOLS.length}`);
    }
  });
};
