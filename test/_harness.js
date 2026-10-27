/**
 * Shared test harness — zero dependency.
 *
 * Lives in its own module so that test files which export `function ({ test, ... })`
 * can be executed in a *child process* (memory-isolated) instead of being required
 * into the runner's process. Mounting ~137 engine-loading test files in a single
 * process exhausted the heap and got the runner OOM-killed mid-run, which is why
 * the reported test totals used to vary between runs.
 *
 * Each process that requires this module gets its own counters and prints its own
 * `测试结果: N 通过, M 失败, 共 T 个` line, which the runner parses.
 */
'use strict';

// 文档探针的崩溃安全还原：写「探针目标」（根目录 *.md / VERSION /
// scripts/audit-doc-numbers.js）之前自动登记一份快照。装在这里是覆盖面的选择点：
// _mount.js require 本文件，jest 风格走 _jest-globals.js（那里另装了一份），
// 于是 run-all 的三种运行方式都拿到守护。
// 为什么需要它：探针的还原一直靠各自的 finally，而 run-all 的每个测试文件跑在
// 独立子进程里、CHILD_TIMEOUT 240 秒，被 kill 的进程没有 finally —— README /
// AGENTS / SKILL / audit-doc-numbers.js 就会留在注入态。详见
// test/_doc-probe-restore.js 头部与 test/doc-probe-crash-recovery.test.js。
require('./_doc-probe-restore.js').installWriteGuard();

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      // async：立即登记，完成后结算
      pending.push(ret.then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch(err => {
          failed++;
          console.log(`  ✗ ${name}`);
          console.log(`    ${err.message}`);
          failures.push({ name, error: err.message });
        }));
      return ret;
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failures.push({ name, error: err.message });
  }
}

const pending = [];

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) throw new Error(`期望 ${expected}，实际 ${actual}。${msg}`);
}
function assertTrue(value, msg = '') {
  if (!value) throw new Error(`期望 truthy，实际 ${value}。${msg}`);
}
function assertFalse(value, msg = '') {
  if (value) throw new Error(`期望 falsy，实际 ${value}。${msg}`);
}
function assertDefined(value, msg = '') {
  if (value === undefined || value === null) throw new Error(`期望有值，实际 ${value}。${msg}`);
}
function assertThrows(fn, msg = '') {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(`期望抛出异常。${msg}`);
}

const harness = { test, assertEqual, assertTrue, assertFalse, assertDefined, assertThrows };

/** 等待所有 async 测试结算，然后打印汇总行 */
async function summarize() {
  if (pending.length) await Promise.all(pending);
  console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
  if (failed > 0) process.exitCode = 1;
  return { passed, failed, failures };
}

module.exports = { ...harness, summarize, harness, getCounts: () => ({ passed, failed, failures }) };
