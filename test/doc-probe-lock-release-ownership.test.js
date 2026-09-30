/**
 * test/doc-probe-lock-release-ownership.test.js — release() 绝不删除自己不持有的锁
 *
 * ═══ 本轮(周期21)修的是哪个具体的洞 ═══
 * test/_doc-probe-lock.js 的 release() 旧写成:
 *
 *     if (pid === null || pid === String(process.pid) || lockAge() > STALE_MS) {
 *       fs.rmSync(LOCK_DIR, { recursive: true, force: true });
 *     }
 *
 * `pid === null` 看起来是"清理崩溃残留"，但它与 acquire() 的实现相撞:
 * acquire() 是 `mkdirSync(LOCK_DIR)` 与 `writeFileSync(pid)` **两步**，
 * 两步之间 pid 文件还不存在。任何进程在这个窗口里调 release()，
 * 都会把别人刚拿到、还没写 pid 的锁删掉。
 *
 * 于是两个进程都自以为持有锁，探针互相踩:
 *   A 读 SKILL.md 备份(1.0.0) → 写入 9.9.9
 *   B 读 SKILL.md 备份(此刻已是 9.9.9) → 写入 9.9.9
 *   A 还原成 1.0.0 → B 再把它的"备份"9.9.9 写回
 *   → 文档永久停留在污染态，而 A 和 B 都"成功恢复"了。
 *
 * 实测长相: 审计间歇性报 79/84(5 条不符)、探针间歇性红，
 * 而单独跑、直接 spawn run-all 全绿。**窗口越窄，失败越偶发。**
 *
 * 修法: 只有 pid 确实是本进程才删；pid 读不到按"别人正在写"处理，
 * 只有确凿陈旧(超过 STALE_MS)才强拆。
 *
 * ═══ 这条测试自己踩过的坑 ═══
 * 第一版每个用例各自 clearLock()，在并发 runner 下**把并发探针正持有的锁删了** ——
 * 它造成了它要检测的那个缺陷，表现为"陈旧锁必须能强拆"间歇性失败。
 * 现在整个文件全程持锁: 这些用例动的是**共享**锁目录，不持锁就不能动它。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lock = require('./_doc-probe-lock.js');
const { withDocLock, acquire, release, LOCK_DIR, STALE_MS } = lock;

const pidFile = path.join(LOCK_DIR, 'pid');
const mine = String(process.pid);
/** 确保锁目录存在且 pid 指向自己(即"我持有这把锁") */
const hold = () => {
  try { fs.mkdirSync(LOCK_DIR); } catch (_) {}
  try { fs.writeFileSync(pidFile, mine); } catch (_) {}
};

module.exports = function ({ test, assertTrue }) {

  test('release() 的所有权边界: 不删别人的锁，但陈旧锁仍可强拆', () => withDocLock(() => {
    // ① 窗口态: pid 文件不存在 —— 正是 acquire() 的 mkdir 与写 pid 之间
    hold();
    try { fs.unlinkSync(pidFile); } catch (_) {}
    release();
    assertTrue(fs.existsSync(LOCK_DIR),
      'release() 删掉了别人刚拿到、还没写 pid 的锁 —— 双持有者竞态仍然存在');
    hold();

    // ② pid 属于另一个进程(用一个确实活着的: 父进程)
    hold();
    fs.writeFileSync(pidFile, String(process.ppid));
    release();
    assertTrue(fs.existsSync(LOCK_DIR),
      'release() 删掉了别的进程持有的锁 —— 双持有者竞态仍然存在');
    hold();

    // ③ 确凿陈旧 → 必须能强拆。
    // 没有这一条，前两条可能只是因为"从来不删锁"而绿 ——
    // 一把永不失效的锁和没有锁是分不清的。
    // 顺序要紧: 先写 pid 再回溯 mtime。往目录里写文件会刷新目录 mtime，
    // 而 lockAge() 读的正是目录 mtime，顺序反了就把年龄清零。
    fs.writeFileSync(pidFile, String(process.ppid));
    const old = new Date(Date.now() - STALE_MS - 60000);
    fs.utimesSync(LOCK_DIR, old, old);
    release();
    assertTrue(!fs.existsSync(LOCK_DIR),
      '陈旧锁必须能被强拆，否则持锁者一旦死亡就再也没人拿得到锁');
    hold();

    // ④ 反复交替不残留，且结束时仍持有锁(withDocLock 的 finally 还要 release)
    for (let i = 0; i < 10; i++) { release(); hold(); }
    assertTrue(fs.existsSync(LOCK_DIR), '结束时必须仍持有锁，否则会让出锁给并发探针');
  }));

  test('STALE_MS 必须从模块导出(否则上一用例的"陈旧"是 NaN，检查不到任何东西)', () => {
    assertTrue(typeof STALE_MS === 'number' && STALE_MS > 0,
      'STALE_MS 必须是从 _doc-probe-lock.js 导出的正数; 实际=' + STALE_MS);
    assertTrue(lock.STALE_MS === STALE_MS, '导出必须指向同一个常量');
  });
};
