/**
 * test/_doc-probe-restore.js — 文档探针的崩溃安全还原
 *
 * ═══ 由来 ═══
 * 探针测试的本质是「在真实文件上制造一处可控的错误，再确认仪器报警」。
 * 它的价值全在于「除了这一处，其余与生产一致」，所以**还原**和注入一样重要。
 * 而还原一直是每个测试各自的 `finally { fs.writeFileSync(p, orig) }` ——
 * 只在进程活着的时候有效。
 *
 * run-all.js 每个测试文件跑在独立子进程里，CHILD_TIMEOUT 240 秒；
 * 12 个 doc 探针在同一把锁上串行，每个持锁期 spawn 一次完整审计（约 10 秒），
 * 队尾等待实测可超时被 kill（CHILD_TIMEOUT 那条注释自己记着「连续三跑各有 6 个
 * mount 进程 Command failed，失败探针组合每次不同、单独跑全绿」）。
 * **被 kill 的进程没有 finally** —— 于是 README.md / AGENTS.md / SKILL.md /
 * scripts/audit-doc-numbers.js 被留在注入态，直到有人手动清理。
 *
 * 2026-10-25 与 2026-10-27 两次推送前清点，工作区的脏项几乎全是这个形状，
 * 且两次注入逐字相同（连 `682 份` 那个最像普通回退的倒退都在）——
 * 说明它不是一次性事件，是每轮都在发生的常态。
 *
 * ═══ 已有的半截修法 ═══
 * test/audit-domains-blindspot.test.js 第 117-128 行自己实现了「备份落盘 +
 * 下次启动清理残留」，注释里写明「首版把备份只存在内存里，测试被 SIGTERM kill 时
 * finally 来不及跑，README 残留了 7 行探针」。**方向是对的，但是每个测试各自为政：
 * 有的有、有的没有，而且判据是各自硬编码的探针标记。**
 * 本模块把那件事统一成一个共享机制。
 *
 * ═══ 为什么不走 git checkout -- ═══
 * test/audit-self-pollution.test.js 自己记载过这个坑：清理探针污染时用了
 * `git checkout -- SKILL.md README.md CURRENT_STATE.md`，结果退回到 HEAD(8b2853c)，
 * 而 HEAD 早于周期 12-18 的文档同步，测试数退回 1182、公式数退回 1286。
 * **探针污染和合法内容住在同一个文件里，git 分不开。**
 * 所以还原的目标不是 HEAD，而是「这一次注入之前磁盘上的内容」。
 *
 * ═══ 机制 ═══
 * 1. 读：`readFileSync` 被包一层，探针目标文件**第一次被读到时的内容**记进内存
 *    （只记内存，不落盘）。
 * 2. 写：`writeFileSync` 被包一层，探针目标文件第一次被写时，把第 1 步记住的
 *    内容落成 `.probe-restore/<key>.bak`，并在 index.json 登记 {file, pid, at}。
 * 3. 退出：进程正常退出时**一律撤掉自己登记的所有项**。
 * 4. 恢复：`recoverOrphans()` 在 run-all.js 启动时、以及子进程被 kill 之后调用：
 *    登记的 pid 已死（僵尸按已死算）、且磁盘内容与快照不同 → 写回快照。
 *
 * ═══ 三个不显然的设计决定，都是被真实失败逼出来的 ═══
 *
 * ① 快照取「第一次读到的内容」，不是「写入前一刻的内容」。
 *    首版取的是写入前一刻。于是测试在 finally 里写回原文时，守护把**已被污染的
 *    当前内容**登记成快照、pid 记成测试进程自己；退出时「当前 !== 快照」让登记
 *    被保留，下一次恢复就把污染内容写回磁盘 —— 一个自我污染的循环，而且它长得
 *    完全不像bug：每一轮都「成功恢复」了一次污染。取第一次读到的内容，还原的
 *    目标就固定成「本进程介入之前世界的样子」，与写入顺序无关。
 *
 * ② 正常退出一律撤登记，不搞「没还原干净就留着下次修」。
 *    留着的那条安全网看着更周到，但它正是①的传播路径：任何一次正常退出只要
 *    「当前 !== 快照」，就会留下一个可能基于污染内容的登记。而真正需要恢复的
 *    情形——子进程被 kill——根本不会执行 exit 钩子，留不留登记都与它无关。
 *    测试没还原干净时，探针测试自己的断言（「恢复后审计必须重新全绿」）会红，
 *    那条路是可见的；这里不再叠一条看不见的自动写回。
 *
 * ③ pid 存活判据必须认得僵尸进程。
 *    `process.kill(pid, 0)` 对僵尸仍然成功，而 spawn 出去不等 exit 的子进程正会
 *    变成僵尸。首版因此把已死的持有者判成活着，恢复永远不触发（实测：
 *    recoverOrphans 返回 []，而 README 确实带着探针标记）。用 ps 看状态，
 *    Z 开头按已死处理；ps 不可用时保守按活着处理（宁可多等，不可误还原）。
 *
 * ═══ 覆盖范围 ═══
 * 「探针会注入的受跟踪文档」：仓库根目录的 *.md、VERSION、
 * scripts/audit-doc-numbers.js。**刻意不含** src/**、data/**、memory/**、state/**、
 * test/**、*.json —— 那些是运行期数据，测试合法地写它们且不还原，自动还原会把
 * 合法状态改坏。src/data/tom/agents.json 曾被探针写入，那需要该测试自己显式清理，
 * 不属于本模块的自动范围。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SNAP_DIR = path.join(ROOT, '.probe-restore');
const INDEX = path.join(SNAP_DIR, 'index.json');

/** 本进程登记过的文件（绝对路径 → 快照内容）。退出时据此撤登记。 */
const mine = new Map();
/** 本进程第一次读到探针目标时的内容。快照以它为准，见设计决定①。 */
const firstRead = new Map();
let guardInstalled = false;
let exitHookInstalled = false;

function isProbeTarget(absPath) {
  if (typeof absPath !== 'string') return false;
  const p = absPath;
  if (path.dirname(p) === ROOT && p.toLowerCase().endsWith('.md')) return true;
  if (p === path.join(ROOT, 'VERSION')) return true;
  if (p === path.join(ROOT, 'scripts', 'audit-doc-numbers.js')) return true;
  return false;
}

function keyFor(absPath) {
  return crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 16);
}

function ensureDir() {
  try { fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch (_) { /* 已存在 */ }
}

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch (_) { return {}; }
}

/** 原子写：先写临时文件再 rename，避免半份 index 让下次恢复读不到登记。 */
function writeIndex(idx) {
  ensureDir();
  const tmp = INDEX + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 1));
  try { fs.renameSync(tmp, INDEX); } catch (_) { /* rename 失败时保留 tmp 供人工 */ }
}

function readSnapshot(key) {
  try { return fs.readFileSync(path.join(SNAP_DIR, key + '.bak'), 'utf8'); } catch (_) { return null; }
}

function writeSnapshot(key, content) {
  ensureDir();
  const f = path.join(SNAP_DIR, key + '.bak');
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, content);
  try { fs.renameSync(tmp, f); } catch (_) { /* 保留 tmp */ }
}

/** 见设计决定③：僵尸进程对 signal 0 仍然成功，必须再看一眼状态。 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); } catch (e) { return !!(e && e.code === 'EPERM'); }
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(n)],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/^Z/.test(stat)) return false;
  } catch (_) { /* ps 不可用：保守按活着处理 */ }
  return true;
}

/**
 * 登记一份快照。同一个进程对同一文件只登记第一次。
 * 内容取「本进程第一次读到该文件时的内容」；从未读过则退化为写入前的内容。
 */
function snapshot(absPath) {
  const p = path.resolve(absPath);
  if (mine.has(p)) return false;
  const content = firstRead.has(p) ? firstRead.get(p) : safeRead(p);
  if (content === null) return false; // 文件不存在：无从快照
  const key = keyFor(p);
  writeSnapshot(key, content);
  const idx = readIndex();
  idx[key] = { file: p, pid: process.pid, at: Date.now() };
  writeIndex(idx);
  mine.set(p, content);
  return true;
}

function safeRead(p) {
  try { return rawRead.call(fs, p, 'utf8'); } catch (_) { return null; }
}

/** 未被包装的 readFileSync。包装器内部一律走它，否则「包一层 → 登记 → 再读一次」
 *  会调回包装器本身，形成无限递归直到栈溢出（实测：每一读都炸一次，栈深近万帧）。
 *  首版正是在这里递归的，而它的症状是「恢复从不触发」而非报错 —— 因为每一层
 *  catch 都把 RangeError 吞了，只剩下 firstRead 永远填不进去。 */
let rawRead = fs.readFileSync;

/**
 * 还原到快照（内容不同才写），并撤掉登记。
 * 之后同一文件再次被写会重新登记 —— 所以可以连着做多轮探针。
 */
function restore(absPath) {
  const p = path.resolve(absPath);
  const key = keyFor(p);
  const orig = mine.has(p) ? mine.get(p) : readSnapshot(key);
  if (orig === null) return false;
  const current = safeRead(p);
  if (current === orig) { dropEntry(p); return false; }
  try { fs.writeFileSync(p, orig); } catch (_) { return false; }
  dropEntry(p);
  return true;
}

function dropEntry(absPath) {
  const p = path.resolve(absPath);
  const key = keyFor(p);
  mine.delete(p);
  const idx = readIndex();
  if (idx[key]) { delete idx[key]; writeIndex(idx); }
  try { fs.unlinkSync(path.join(SNAP_DIR, key + '.bak')); } catch (_) { /* 已不在 */ }
}

/**
 * 恢复孤儿快照：登记的进程已死、且磁盘内容与快照不同 → 写回快照。
 * pid 还活着（含僵尸判定）的一律跳过，所以并发的兄弟探针不会被误还原。
 */
function recoverOrphans(opts) {
  const quiet = opts && opts.quiet;
  const idx = readIndex();
  const recovered = [];
  let dropped = 0;
  for (const key of Object.keys(idx)) {
    const entry = idx[key] || {};
    const file = entry.file;
    if (!file) { delete idx[key]; dropped++; continue; }
    const orig = readSnapshot(key);
    if (orig === null) { delete idx[key]; dropped++; continue; }
    if (pidAlive(entry.pid)) continue; // 持有者可能还活着：不碰
    const current = safeRead(file);
    if (current === null) continue; // 文件不存在：不凭空造
    if (current === orig) {
      // 测试自己还原成功了，只是没来得及撤登记
      delete idx[key]; dropped++;
      try { fs.unlinkSync(path.join(SNAP_DIR, key + '.bak')); } catch (_) { /* 已不在 */ }
      continue;
    }
    try { fs.writeFileSync(file, orig); recovered.push(file); }
    catch (_) { continue; }
    delete idx[key];
    try { fs.unlinkSync(path.join(SNAP_DIR, key + '.bak')); } catch (_) { /* 已不在 */ }
  }
  writeIndex(idx);
  if (!quiet) {
    for (const f of recovered) console.log('[probe-restore] 恢复被探针写入后未还原的文件: ' + f);
  }
  return { recovered, dropped };
}

/** 本进程退出：一律撤掉自己登记的所有项。见设计决定②。 */
function dropAllMine() {
  for (const p of Array.from(mine.keys())) dropEntry(p);
  mine.clear();
}

/**
 * 给 fs 的读写套一层。装在 _harness.js 里（jest 风格在 _jest-globals.js 另装一份），
 * 于是 run-all 的三种运行方式都拿到守护，无需逐个测试改造。
 */
function installWriteGuard() {
  if (guardInstalled) return;
  guardInstalled = true;

  const origRead = fs.readFileSync;
  rawRead = origRead;
  fs.readFileSync = function (file, options) {
    try {
      const p = resolveMaybe(file);
      if (p && isProbeTarget(p) && !firstRead.has(p)) {
        const c = safeRead(p);
        if (c !== null) firstRead.set(p, c);
      }
    } catch (_) { /* 记录失败不能挡住读本身 */ }
    return origRead.apply(fs, arguments);
  };

  const origWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, data, options) {
    try {
      const p = resolveMaybe(file);
      if (p && isProbeTarget(p) && !mine.has(p)) snapshot(p);
    } catch (_) { /* 快照失败不能挡住写入本身 */ }
    return origWrite.apply(fs, arguments);
  };

  installExitHook();
}

function resolveMaybe(file) {
  if (typeof file === 'string') return path.resolve(file);
  if (file && typeof file === 'object' && typeof file.path === 'string') return path.resolve(file.path);
  if (Buffer.isBuffer(file)) return null;
  if (file instanceof URL) return path.resolve(file.pathname);
  return null;
}

/**
 * 进程退出时撤掉自己登记的所有项。
 * 注意这是 exit 钩子而非 finally —— 被 kill 的进程不会走到这里，
 * 而那正是登记需要保留下来的情况。
 */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    try { if (mine.size) dropAllMine(); } catch (_) { /* 清理失败不影响退出码 */ }
  });
}

module.exports = {
  ROOT,
  SNAP_DIR,
  snapshot,
  restore,
  recoverOrphans,
  installWriteGuard,
  isProbeTarget,
};
