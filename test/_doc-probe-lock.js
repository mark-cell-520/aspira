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
// [第一百零六轮] STALE_MS 原为 120000(2 分钟), 而第 61 行调用者的默认耐心
// timeoutMs 是 60000。**一个孤立锁只有在超过 STALE_MS 才会被强拆, 而调用者
// 在 60000ms 就放弃并抛错了** —— 于是孤立锁在调用者的等待窗口内永远不可能
// 被回收, 只会在 run-all 里稳定报'无法在 60000ms 内取得文档探针锁'。
// 这是 AGENTS.md 记了很久、但一直没修的一条(cycle-27 / cycle-31 都提过)。
// 修法: 把 STALE_MS 压到调用者耐心的**一半以下**, 让孤立锁在超时之前就被拆掉。
// 30000 是这个折中: 比 60000 的一半更小, 又远大于一次正常探针的持有时长
// (探针只做几秒钟的文档改写), 不会误拆活着的持有者。
const STALE_MS = 30000; // 30 秒未更新即视为陈旧(持有者已死)


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
  // [test-coverage-gap·第一百一十六轮] 默认等待超时 60000 → 300000。
  // 根因(三次测量收口): **锁没有租约, 等待者的耐心比持有者的工作还短。**
  //   ① 第一百零八轮: _doc-probe-lock 无 LEASE/maxHold 概念, withDocLock(fn)
  //      是 acquire(timeoutMs) 后同步跑 fn, 而 fn 内部 spawn 审计(数秒到一分钟);
  //   ② 第一百零九轮: 锁里多占 3 秒, run-all 失败数从 1 涨到 3, 每个都是同一句超时
  //      —— 机制被直接放大证实;
  //   ③ 第一百一十四轮 diff + 第一百一十五轮隔离 8/8 绿: 受害者是
  //      corpus-size-measured.test.js(隔离全绿, 合跑才红)。
  // 持有者合法工作可达 60s 级, 等待者 60s 就抛错 → 等待者永远先到期。
  // 300000 远大于持有者最长一次工作, 又不会让真死锁无限挂起。
  const deadline = Date.now() + (timeoutMs || 300000);
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
      throw new Error('无法在 ' + (timeoutMs || 300000) + 'ms 内取得文档探针锁 '
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
    // ═══ 周期21: `pid === null` 这个分支本身就是竞态 ═══
    // 旧代码 `pid === null || pid === 自己 || 陈旧` 就删锁。但 acquire() 是
    // 「mkdirSync 成功」与「writeFileSync(pid)」两步，两步之间有个窗口，
    // 此刻 pid 文件不存在。任何进程在这个窗口里调 release()，都会把
    // **别人刚拿到、还没写 pid 的锁**删掉 —— 两个进程都自以为持有锁，
    // 那正是第七轮引入本锁要消除的事故。实测后果:
    //   A 读备份(1.0.0)→写 9.9.9 ; B 读备份(此时已是 9.9.9)→写 9.9.9
    //   A 还原成 1.0.0 ; B 再把它的"备份"9.9.9 写回 → 文档永久污染，
    //   而两边都"成功恢复"了。表现为审计间歇性 79/84、探针间歇性红，
    //   单独跑与直接 spawn 却全绿 —— 典型"偶发失败"长相。
    // 修法: **绝不删除自己不持有的锁**。pid 读不到按"别人正在写"处理，
    // 只有确凿陈旧(超过 STALE_MS)才强拆。宁可多等一个窗口，也不能两个持有者。
    if (pid === String(process.pid)) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    } else if (pid !== null && lockAge() > STALE_MS) {
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

/**
 * 持锁读一份「探针会改写的文档」。
 *
 * ═══ 为什么读者也要持锁(周期21) ═══
 * 这把锁原本只保护**写者**: 8 个探针测试注入文档、跑审计、再还原，全部持锁。
 * 但**读者不持锁**——7 个测试文件直接 fs.readFileSync 读 README/SKILL 等文档。
 * 于是探针的「已注入、未还原」窗口对读者完全透明。
 *
 * 实测(周期21，非推测): 一个进程持锁往 AGENTS.md 写注入标记再还原，另一个进程
 * 不持锁读 4000 次，**3992 次看见了注入值**。竞态不是理论上的。
 *
 * 而它之所以一直表现为「偶发失败」而不是稳定失败，是因为: 只有当注入值恰好是
 * 读者检查的那个数时才失败。实测探针持锁时长仅 **0.65s**(带 ASPIRA_AUDIT_SKIP_TESTS
 * 跑一次审计)，8 个探针加起来不到 8 秒的污染窗口，读者随机落在窗口内的概率是个小数。
 * **窗口越窄，失败越偶发，越像"环境抖动"而不像缺陷**——这正是它难查的原因。
 *
 * 持锁读是安全的: 读者最多等一个探针的 0.65s，离 60s 等待上限极远。
 * 反过来，若读者不持锁，它读到的是探针的半成品——而半成品恰恰是这一整族
 * 工作(诚实数字)要防的东西。
 */
function readDoc(filePath, timeoutMs) {
  return withDocLock(() => fs.readFileSync(filePath, 'utf8'), timeoutMs);
}

// ── [第二十三轮] 版本行的还原必须写权威值，不能写回 backup ──
// 周期23 实测出一个**单向闩锁**: 探针读 backup → 文档已是 9.9.9 →
// POISON 的 replace 是空操作 → 还原写回 backup(还是 9.9.9) → 污染永久自锁。
// 实测: 从污染态连跑两轮套件都是 1364/7，SKILL.md 一直停在 9.9.9，
// 且**没有任何东西能把它修好** —— 每轮都从污染态起步，每轮都再把污染写回去。
// 这正是周期20 记下的"A hardcoded anchor goes silently dead once the document
// is polluted"，但当时的记录只说了"检查会空转"，没说空转的**后果是永久红**。
//
// 修法: 还原时把版本行按整行替换成 VERSION 读到的权威值。
// 为什么不构成周期20 担心的"自愈机制回滚人的合法编辑": 约定 #1 写明
// "VERSION 是唯一真相源，package.json 和 SKILL.md 必须匹配"，
// 所以**不存在**"SKILL.md 的 Engine version 行理应是别的值"这种合法状态。
// 这里修的是一个有唯一正确答案的字段，不是"内容与备份不同"这种无判据的差异。
const PROBE_VERSION = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
// [第二十四轮] 只替换版本号, **不碰行尾**。
// 周期23 的版本写成 `/(\|\s*Engine version\s*\|)[^\n]*/` → `[^\n]*` 把整行尾部
// 一起吃掉。而 SKILL.md 那一行后面挂着长长的审计说明:
//   | Engine version | 1.0.0 | `VERSION`, `package.json`, runtime `hf.VERSION`
//   (module-level) / `hf.version` (instance), and `src/core/version.js` agree |
// 实测 git show HEAD:SKILL.md 的第 153 行确实带这段尾巴, 而磁盘上只剩
// `| Engine version | 1.0.0 |` —— **还原动作把审计痕迹删掉了**, 而且每次都
// "成功还原"。这正是本仓库反复记载的形状: 报告成功却写错了东西, 比失败更糟。
// 用函数式替换而不是 '$1'+value: value 以数字开头时会变成 '$11.0.0' 这种
// 歧义的捕获组引用(实测 V8 恰好按 $1+字面量解析, 但那是实现细节, 不赌)。
function forceVersionLine(text, value) {
  return text.replace(/(\|\s*Engine version\s*\|\s*v?)\d+\.\d+\.\d+/, (m, p1) => p1 + value);
}
function restoreVersionLine(text) {
  return forceVersionLine(text, PROBE_VERSION);
}

// [第二十五轮] 两个名字同一个值, 都导出。
// 周期24 花了整轮没能解释一个测试失败: 测试导入 `PROBE_AUTH_VERSION`, 而这里
// 导出的是 `PROBE_VERSION` —— 解构失败**不抛错**, 拿到的是 undefined。于是
// 探针钩子写出 `p1 + undefined`, 也就是把 SKILL.md 的版本行改成
// `| Engine version | undefined`。审计的 labelledVersionOf 匹配不到版本号,
// 只能判成 drift, 而文档被留在一份**看起来像修好了其实写坏了**的状态里。
// 调用成功、没有异常、返回结构合法 —— 而内容是死的。这正是本仓库反复记载的
// 契约错配家族: 名字对不上时不响, 只在下游变成一个说不通的结果。
// 审计侧那个常量叫 PROBE_AUTH_VERSION(scripts/audit-doc-numbers.js), 这里叫
// PROBE_VERSION; 两边读的是同一个 VERSION 文件, 所以两个名字都指向它。
module.exports = {
  withDocLock, acquire, release, readDoc, LOCK_DIR, STALE_MS,
  restoreVersionLine, forceVersionLine,
  PROBE_VERSION, PROBE_AUTH_VERSION: PROBE_VERSION,
};
