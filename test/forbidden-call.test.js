// forbidden-call.test.js — 禁止未确认即委派检测测试

const { checkForbiddenCall } = require('../src/forbidden-call.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
function assertEq(actual, expected, msg) { if (actual !== expected) throw new Error(`${msg || ''} 期望 ${expected}，实际 ${actual}`); }
function assertTrue(value, msg) { if (!value) throw new Error(`${msg || ''} 期望 truthy，实际 ${value}`); }

test('empty input', () => {
  const r = checkForbiddenCall('');
  assertEq(r.count, 0);
  assertEq(r.score, 0);
});

test('clean plan passes', () => {
  const r = checkForbiddenCall('const x = 1;\nmodule.exports = { x };');
  assertEq(r.count, 0);
});

test('delegate_task triggers forbidden call', () => {
  const r = checkForbiddenCall('delegate_task("x")');
  assertEq(r.count, 1);
  assertTrue(r.hits[0].kind === 'delegate_unknown');
});

test('spawn agent triggers forbidden call', () => {
  const r = checkForbiddenCall('spawn agent to fix bug');
  assertEq(r.count, 1);
  assertTrue(r.hits[0].kind === 'agent_spawn');
});

// 汇总行：没有它，parseChildSummary 对本文件返回 null，4 条真实用例
// 在门禁总数里计 0（test/_child-summary.js 头部记载过同族 195 条）。
console.log(`\n📊 forbidden-call: ${passed} passed, ${failed} failed, total ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
