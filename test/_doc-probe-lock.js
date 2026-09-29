/**
 * test/_doc-probe-lock.js — 共享文档探针的互斥锁
 *
 * ═══ 由来 ═══
 * 第七轮 doc-honest-numbers 引入 test/audit-domains-blindspot.test.js，
 * 它注入一行假 domain 到 README、跑审计、再恢复。
 * 单独跑 5/5 通过，`node test/run-all.js` 里却失败。
 *
 * ═══ 根因: 并发执行下的共享文件写冲突 ═══
 * run-all.js 在 2026-09-28 改成有界并发(默认 max(2,min(12,cpus-2)))。
 * 当时的风险评估写的是:
 *   "0 test files write under `data/` or `memory/`"
 * —— **它只查了 data/ 和 memory/，没查"改写仓库里的 md 文档"。**
 *
 * 而至少有四个测试要改文档再 spawn 审计:
 *   audit-domains-blindspot.test.js   → README.md
 *   audit-pattern-blindspot.test.js   → README.md
 *   doc-honest-numbers-chinese.test.js→ IDENTITY.md
 *   audit-doc-coverage.test.js        → README.md(扫描集)
 *
 * 它们并发跑时: A 写入探针 → B 写入自己的探针(基于 A 已污染的副本)
 * → A 跑审计看到 B 的探针 → A 的断言失败 → A 用**含 B 探针的备份**恢复
 * → README 残留多个探针标记。首轮实测: README 残留 7 行。
 *
 * ═══ 为什么这不是"测试写得不好"而是真缺陷 ═══
 * 探针测试的本质是**在真实文件上制造一处可控的错误，再确认仪器报警**。
 * 它的价值全在于"除了这一处，其余与生产一致"。
 * 两个探针同时在同一个文件上，就同时毁掉彼此的前提——
 * 而失败的表现是"仪器没报警"，**看起来像仪器的错，实际是探针的错**。
 * 这正是本仓库反复记载的形状: 让失败看不见的机制，往往就是让失败发生的机制。
 *
 * ═══ 修法 ═══
 * 一把基于 mkdir 的跨进程文件锁。探针测试在做任何注入前必须先取得锁，
 * 用完释放。不改变并发度(那会牺牲 6.8x 的加速)，
 * 只让"改写共享文档"这个动作串行。
 *
 * 用法:
 *   const { withDocLock } = require('./_doc-probe-lock.js');
 *   withDocLock(() => { ...注入/跑审计/恢复... });
 */
const fs = require('fs');
const path = require('path');

const LOCK_DIR = '/tmp/aspira-doc-probe.lock';
const STALE_MS = 120000; // 2 分钟未更新即视为陈旧(持有者已死)

function lockAge() {
  try {
    const st = fs.statSync(LOCK_DIR);
    return Date.now() - st.mtimeMs;
  } catch (_) { return Infinity; }
}

function touch() {
  try { fs.utimesSync(LOCK_DIR, new Date(), new Date()); } catch (_) {}
}

function acquire(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 60000);
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(path.join(LOCK_DIR, 'pid'), String(process.pid));
      touch();
      return true;
    } catch (_) { /* 已被持有 */ }
    // 陈旧锁: 持有者大概已死，强行接管
    if (lockAge() > STALE_MS) {
      try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (_) {}
      continue;
    }
    if (Date.now() > deadline) {
      // 超时: 不静默失败——静默失败会让探针在无锁状态下跑，
      // 那正是本模块要消除的情况。
      throw new Error('无法在 ' + (timeoutMs || 60000) + 'ms 内取得文档探针锁 '
        + LOCK_DIR + '；这说明有探针测试卡死或锁未释放');
    }
    // 自旋等待(短 sleep 由 Atomics.wait 提供，避免 busy-loop)
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    } catch (_) {
      const until = Date.now() + 25;
      while (Date.now() < until) { /* 兜底 */ }
    }
  }
}

function release() {
  try {
    // 只释放自己持有的锁，避免误删别人的
    const pidFile = path.join(LOCK_DIR, 'pid');
    let pid = null;
    try { pid = fs.readFileSync(pidFile, 'utf8'); } catch (_) {}
    if (pid === null || pid === String(process.pid) || lockAge() > STALE_MS) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  } catch (_) {}
}

/**
 * 在持锁状态下执行 fn。fn 可以同步或返回 Promise。
 * 锁在 fn 返回后(同步)或 Promise settle 后释放。
 */
function withDocLock(fn, timeoutMs) {
  acquire(timeoutMs);
  let result;
  try {
    result = fn();
  } catch (e) {
    release();
    throw e;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => { release(); return v; },
      (e) => { release(); throw e; }
    );
  }
  release();
  return result;
}

module.exports = { withDocLock, acquire, release, LOCK_DIR };
