/**
 * test/reasoning-wiring-audit.test.js
 *
 * [2026-11-02 全面代码审计] 新建。三条都是「读了一个产出侧不存在的键/标识符」，
 * 形态是静默失败而不是报错，所以从写下起没有任何测试红过。
 */
const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];
const pending = [];
function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      // 异步用例先挂起，等全部同步用例跑完再 await —— 否则汇总行会在
      // passed++ 之前打印，异步通过数不计入总数（本文件第一版就是这个错）。
      pending.push(ret.then(() => { passed++; console.log(`  ✓ ${name}`); },
        (e) => { failed++; console.log(`  ✗ ${name}`); console.log(`    ${e.message}`); failures.push(name); }));
      return;
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failures.push(name);
  }
}

const ROOT = path.join(__dirname, '..');

// ─── 1. 学术核查链路：大小写不一致导致 100% 失败 ──────────────────
test('学术核查链路真的接上了（不再是 openalexClient is not defined）', async () => {
  const fc = require(path.join(ROOT, 'src/reasoning/fact-checker.js'));
  const r = await fc.factChecker.checkAcademicClaim('attention is all you need');
  assert.strictEqual(typeof r.error, 'undefined',
    `checkAcademicClaim 仍返回 error: ${r.error} —— openalex 客户端没接上`);
  assert.strictEqual(r.checked, true, '客户端不可用时 checked 必须是 true 才算真核查过');
  assert.ok(Array.isArray(r.works) && r.works.length > 0,
    '一篇真实存在的论文应该被检索到，实测 works=' + JSON.stringify(r.works));
  assert.strictEqual(r.confidence, 'high', '检索到论文时置信度应为 high');
});

test('客户端不可用与「查过了没找到」必须可区分', () => {
  // checked:true + 低置信度 正是让一条 100% 失败的链路看起来像正常工作的形状。
  const src = require('fs').readFileSync(path.join(ROOT, 'src/reasoning/fact-checker.js'), 'utf8');
  assert.ok(/checked:\s*false/.test(src),
    'fact-checker 里必须存在 checked:false 分支 —— 否则"没核查能力"会被印成"查过了没找到"');
});

// ─── 2. 括号作者-年份引用的正则：双反斜杠永不匹配 ────────────────
test('括号作者-年份引用不再被静默漏抽', () => {
  const ce = require(path.join(ROOT, 'src/reasoning/claim-extractor.js'));
  const ex = ce.claimExtractor || ce;
  const got = ex.extractCitations('见 (Smith et al., 2024)、[@wang2024] 与 (Li & Zhao, 2019)。');
  const vals = got.map((c) => c.value);
  assert.ok(vals.includes('(Smith et al., 2024)'),
    '(Smith et al., 2024) 漏抽 —— 正则里的 \\s 仍是双反斜杠。实测: ' + JSON.stringify(vals));
  assert.ok(vals.includes('(Li & Zhao, 2019)'),
    '(Li & Zhao, 2019) 漏抽。实测: ' + JSON.stringify(vals));
  assert.ok(vals.includes('[@wang2024]'), 'pandoc 形态的引用不应该被这次修复弄丢');
});

// ─── 3. progress-judgment 的 standGround.reason 从不被写 ─────────
test('伪进步警示读的是产出侧真实存在的字段', () => {
  const pj = require(path.join(ROOT, 'src/core/progress-judgment.js'));
  const M = pj.ProgressJudgment || pj.progressJudgment;
  const j = (typeof M === 'function' ? new M() : M)
    .judge({ action: '这个更好', claim: '', userIntent: '这个更好' });
  assert.ok(j.standGround, '前提失效: 该句没有触发 standGround');
  assert.deepStrictEqual(Object.keys(j.standGround).sort(),
    ['framing', 'guardianNote', 'myPosition', 'reasons'],
    'standGround 的键集变了 —— 先复核 pipeline.js 的读取字段是否还对得上');
  assert.ok(!('reason' in j.standGround),
    'standGround 仍然写 reason 字段了 —— 那 pipeline 的老代码就是对的，本修复的理由需要复核');
});

test('pipeline 的伪进步警示必须带真实原因，不许恒为兜底文案', () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'src/pipeline.js'), 'utf8');
  assert.ok(/standGround\.reasons/.test(src),
    'pipeline.js 仍在只读 standGround.reason（产出侧从不写它）—— '
    + 'gate.reason 会恒为「需独立验证」');
});

(async () => {
  await Promise.all(pending);
  console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
  if (failed > 0) process.exitCode = 1;
})();
