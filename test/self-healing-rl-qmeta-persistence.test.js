/**
 * test/self-healing-rl-qmeta-persistence.test.js
 *
 * 缺陷：src/cortex/self-healing-rl.js 的 _qMeta 只进不出。
 *
 * _saveQMeta() 从写下起零调用，memory/q-meta.json 从来没被创建过；而
 * _loadQMeta() 在 autoCleanupRL / _calcMemoryImportance / getMemoryImportance
 * 三处被调用，永远读到 {}。于是 _touchEntry() 写的 accessCount /
 * lastAccessedAt、update 路径写的 updateCount、清理与遗忘路径的 delete
 * 全部只活在内存里，进程一退即归零。
 *
 * 这不是"少存一个文件"，而是两个机制的读数被钉死：
 *   · getMemoryImportance() 对每条记忆返回 accessCount:0 / accessScore:0 /
 *     recencyScore:1 → importance 恒等于 0（Titans 重要性公式退化为常数）；
 *   · autoCleanupRL() 的 `if (!meta) continue` 恒真 → cleaned 恒为 0，
 *     "无所得故"清理从不删任何条目。
 * 两者都返回结构完整的成功外形，所以没有任何东西会响。
 *
 * 本锁断言的是**读数不再恒定**，而不是文件是否存在——文件存在但内容是旧的，
 * 与文件不存在无法区分，那正是本缺陷的形状。
 *
 * 卫生说明：本测试会触发 _saveQTable()，而该函数写的是**整个**内存 Q-table
 * （本部署中 _loadQTable 的加载被 try/catch 吞掉，内存表常年为空，一存就把
 * 盘上旧内容整表覆盖）。所以这里对 memory/q-table.json 与 memory/q-meta.json
 * 做备份/还原，跑完原地恢复，不在仓库里留下探针条目。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { HealingMemoryRL } = require('../src/cortex/self-healing-rl.js');

const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const QTABLE_FILE = path.join(MEMORY_DIR, 'q-table.json');
const QMETA_FILE = path.join(MEMORY_DIR, 'q-meta.json');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}

// 用一个不可能与真实错误模式撞名的 context key，避免污染/误删真实学习成果。
const SENTINEL = '__ASPIRA_QMETA_PROBE__';
const CTX = { machineId: 'qmeta-probe', environment: 'qmeta-probe', region: 'qmeta-probe' };
const SENTINEL_KEY = `${SENTINEL}@qmeta-probe:qmeta-probe:qmeta-probe`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readMeta() {
  try { return JSON.parse(fs.readFileSync(QMETA_FILE, 'utf8')); } catch (_) { return null; }
}

function sentinelImportance(rl) {
  const out = rl.getMemoryImportance ? rl.getMemoryImportance() : null;
  const items = (out && (out.items || out.memories)) || [];
  // getMemoryImportance 的 key 被 slice(0,60)，而本探针键长 62，故用前缀匹配。
  const prefix = SENTINEL_KEY.slice(0, 24);
  return items.find(i => i.key === SENTINEL_KEY || String(i.key).startsWith(prefix)) || null;
}

// ─── 备份/还原：本测试不得在 memory/ 留下任何痕迹 ───
const _backups = new Map();
function backupOnce() {
  if (_backups.size) return;
  for (const f of [QTABLE_FILE, QMETA_FILE]) {
    _backups.set(f, fs.existsSync(f) ? fs.readFileSync(f) : null);
  }
}
function restoreAll() {
  for (const [f, buf] of _backups) {
    try {
      if (buf === null) { if (fs.existsSync(f)) fs.unlinkSync(f); }
      else fs.writeFileSync(f, buf);
    } catch (_) { /* 还原失败不影响判据结论，但要如实留下现场 */ }
  }
}

(async () => {
  backupOnce();
  try {
    // 并发说明：run-all.js 默认并发跑子进程，另一个测试(self-healing-rl-import-contract)
    // 也会实例化同一模块并触发落盘，它读到的 _qMeta 不含本探针的 key，写回时会把它冲掉。
    // 所以整组断言放在重试环里：探针的 key 能被写进盘并读回来，这一观测本身就足以证明
    // 落盘通路存在——修复前 q-meta.json 根本不存在，重试多少次都观测不到。
    let observed = null;
    let firstUpdateCount = null;
    for (let attempt = 1; attempt <= 25 && !observed; attempt++) {
      const rl = new HealingMemoryRL(100);
      rl.setContext(CTX);
      rl.updateFromRepair(SENTINEL, 'probe-strategy', false);
      try { await rl._saveQTable(); } catch (_) { /* 落盘失败由下面的观测判据负责报告 */ }

      const meta = readMeta();
      const entry = meta && meta[SENTINEL_KEY];
      if (entry && (entry.updateCount || 0) >= 1 && (entry.accessCount || 0) >= 1) {
        const imp = sentinelImportance(rl);
        if (imp && (imp.accessCount || 0) > 0 && (imp.importance || 0) > 0) {
          observed = { attempt, entry, imp };
        }
      }
      if (!observed) await sleep(20);
    }

    // ─── 1. 元数据必须真的落到 memory/q-meta.json ───
    ok(!!observed,
      observed ? `q-meta.json 被写入且含探针条目(第 ${observed.attempt} 次尝试观测到)` : 'q-meta.json 未被写入或不含探针条目');

    // ─── 2. 写进去的必须是本次更新产生的值，不是空壳 ───
    if (observed) {
      ok(observed.entry.updateCount >= 1, `updateCount 必须 >= 1(实际 ${observed.entry.updateCount}) —— update 路径的写入必须可见`);
      ok(observed.entry.accessCount >= 1, `accessCount 必须 >= 1(实际 ${observed.entry.accessCount}) —— _touchEntry 的写入必须可见`);
      ok(typeof observed.entry.lastAccessedAt === 'number' && observed.entry.lastAccessedAt > 0,
        'lastAccessedAt 必须是真实时间戳');
    }

    // ─── 3. 恒零判据锁：重要性读数不得再是常数 0 ───
    // 修复前 recencyScore 恒 1.0、accessScore 恒 0，于是 importance 恒 0。
    // 注意 sentinelImportance 走的是 getMemoryImportance → _loadQMeta() 的**读盘**路径，
    // 所以这条断言同时证明"盘上的值能被读回"，不只是进程内可见。
    if (observed) {
      ok(observed.imp.accessCount > 0, `getMemoryImportance 的 accessCount 必须 > 0(实际 ${observed.imp.accessCount})`);
      ok(observed.imp.importance > 0, `importance 必须 > 0(实际 ${observed.imp.importance}) —— 恒 0 正是本缺陷的读数形状`);
      ok(observed.imp.accessScore > 0, `accessScore 必须 > 0(实际 ${observed.imp.accessScore})`);
    } else {
      ok(false, 'getMemoryImportance 的读数无法验证（元数据未落盘）');
    }

    // ─── 4. 盘上的值必须随更新累加，而不是一个写死的常数 ───
    if (observed) {
      firstUpdateCount = observed.entry.updateCount;
      const rl = new HealingMemoryRL(100);
      rl.setContext(CTX);
      rl.updateFromRepair(SENTINEL, 'probe-strategy', false);
      try { await rl._saveQTable(); } catch (_) { /* 判据见下 */ }
      const after = readMeta();
      const entry2 = after && after[SENTINEL_KEY];
      ok(!!entry2 && entry2.updateCount > firstUpdateCount,
        `盘上 updateCount 必须严格增长(${firstUpdateCount} -> ${entry2 && entry2.updateCount}) —— 累加才是真落盘，写死值不是`);
    }

  } finally {
    restoreAll();
  }

  console.log(`\n  测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
  if (failed > 0) process.exitCode = 1;
})();
