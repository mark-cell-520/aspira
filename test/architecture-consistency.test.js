// architecture-consistency.test.js — 架构一致性检测器测试

const { checkArchitectureConsistency } = require('../src/architecture-consistency.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
function assertTrue(value, msg) { if (!value) throw new Error(`${msg || ''} 期望 truthy，实际 ${value}`); }
function assertGt(actual, n, msg) { if (!(actual > n)) throw new Error(`${msg || ''} 期望 >${n}，实际 ${actual}`); }
function assertEq(actual, expected, msg) { if (actual !== expected) throw new Error(`${msg || ''} 期望 ${expected}，实际 ${actual}`); }

test('empty input', () => {
  const r = checkArchitectureConsistency('');
  assertEq(r.score, 0, 'score');
  assertEq(r.issues.length, 0, 'issues');
});

test('naming mismatch: validate without check logic', () => {
  const text = `function validate(x) { return x; }`;
  const r = checkArchitectureConsistency(text);
  assertTrue(r.issues.some(i => i.type === 'naming_mismatch' && i.name === 'validate'), 'validate 应触发 naming_mismatch');
});

test('naming match: validate with boolean return', () => {
  const text = `function validate(x) { if (!x) return false; return true; }`;
  const r = checkArchitectureConsistency(text);
  assertEq(r.issues.filter(i => i.type === 'naming_mismatch').length, 0, 'validate 不应触发');
});

test('missing export detection', () => {
  const text = `function helperA() { return 1; }
function helperB() { return 2; }
function helperC() { return 3; }
function publicFn() { return 4; }
module.exports = { publicFn };`;
  const r = checkArchitectureConsistency(text);
  assertTrue(r.issues.some(i => i.type === 'missing_export' && i.missing.includes('helperA')), 'helperA 应被标记 missing_export');
});

test('mixed error styles', () => {
  const text = `function a() { throw new Error('x'); }
function b(err, callback) { callback(err); }`;
  const r = checkArchitectureConsistency(text);
  assertTrue(r.issues.some(i => i.type === 'error_style_mixed'), '应检测 throw + callback 混用');
});

test('clean module passes', () => {
  const text = `function validate(x) { if (!x) return false; return true; }
function parse(str) { return JSON.parse(str); }
module.exports = { validate, parse };`;
  const r = checkArchitectureConsistency(text);
  assertEq(r.score, 0, 'score');
});

// 汇总行：没有它，parseChildSummary 对本文件返回 null，6 条真实用例
// 在门禁总数里计 0（test/_child-summary.js 头部记载过同族 195 条）。
console.log(`\n📊 architecture-consistency — 测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
process.exit(failed > 0 ? 1 : 0);
