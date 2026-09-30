/**
 * test/doc-reader-lock-coverage.test.js — 读者也要持锁(周期21)
 *
 * ═══ 这条锁防的是什么 ═══
 * test/_doc-probe-lock.js 自第七轮起只保护**写者**: 8 个探针测试注入文档、跑审计、
 * 再还原，全部持锁。但**读者不持锁** —— 有 7 个测试文件直接 fs.readFileSync
 * 读 README/SKILL/CURRENT_STATE/IDENTITY。
 *
 * 于是探针「已注入、未还原」的窗口对读者完全透明。周期21 实测(非推测):
 *   一个进程持锁往 AGENTS.md 写注入标记再还原，另一个进程不持锁读 4000 次，
 *   **3992 次看见了注入值**。竞态不是理论上的。
 *
 * 而它一直表现为「偶发失败」而不是稳定失败，是因为只有注入值恰好是读者检查的
 * 那个数时才失败。实测探针持锁时长仅 **0.65s**(带 ASPIRA_AUDIT_SKIP_TESTS 跑一次
 * 审计)，8 个探针合计不到 8 秒污染窗口，读者随机落入的概率是个小数。
 * **窗口越窄，失败越偶发，越像"环境抖动"而不像缺陷** —— 这正是它难查的原因。
 *
 * 修法: 新增 readDoc()，读者持锁读。持锁读安全: 读者最多等一个探针的 0.65s，
 * 离 60s 等待上限极远。
 *
 * ═══ 证明方式为什么选同进程 ═══
 * 第一、二版都用两个子进程(写者持锁 + 读者)，两版都间歇性红:
 *   - 父进程持锁再 spawn 持锁读者 → 父等读者、读者等父，必然 ETIMEDOUT;
 *   - 写者做子进程 → 它要先和并发探针抢锁，注入可能发生在读者轮询窗口之后，
 *     于是"没看见"，反向证明自己变红。
 * 现在整个用例在**同进程内**完成: 先自己持锁并注入，再调 readDoc ——
 * 同一个进程已经持有锁，所以 readDoc 必然阻塞到超时。**没有任何时序依赖。**
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lock = require('./_doc-probe-lock.js');
const { withDocLock, readDoc, STALE_MS } = lock;

// 探针实际会注入的文档(周期20 实测的 8 个探针的并集)。AGENTS.md **不在其内** ——
// 没有探针注入它，所以读 AGENTS.md 的读者实际安全，这里如实披露而不是一律要求。
const PROBE_TARGET_DOCS = ['README.md', 'SKILL.md', 'CURRENT_STATE.md', 'IDENTITY.md'];
const DOC = path.join(ROOT, 'SKILL.md');
const MARK = 'ZZZ-CYCLE21-READER-LOCK-ZZZ';

function cleanDoc() {
  const cur = fs.readFileSync(DOC, 'utf8');
  if (cur.includes(MARK)) fs.writeFileSync(DOC, cur.split('\n' + MARK + '\n').join(''));
}

module.exports = function ({ test, assertTrue }) {

  test('机械覆盖: 每个读探针目标文档的测试文件都必须持锁读', () => {
    // 静态检查。它会漏(改个变量名就绕过)，所以下面有用例做行为证明。
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name === 'archive' || e.name === 'node_modules') continue;
          walk(p);
        } else if (e.name.endsWith('.test.js')) files.push(p);
      }
    })(path.join(ROOT, 'test'));

    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const reads = PROBE_TARGET_DOCS.filter(d =>
        src.includes("'" + d + "'") || src.includes('"' + d + '"'));
      if (reads.length === 0) continue;
      const holdsLock = /withDocLock/.test(src) || /readDoc\s*\(/.test(src);
      if (!holdsLock) offenders.push(path.relative(ROOT, f) + ' → ' + reads.join(', '));
    }
    assertTrue(offenders.length === 0,
      '这些测试文件读探针目标文档但不持锁，会看见探针的半成品: ' + offenders.join(' | '));
  });

  test('readDoc 必须真的存在且可导出(否则上面那条是空转)', () => {
    assertTrue(typeof readDoc === 'function', 'readDoc 必须是从 _doc-probe-lock.js 导出的函数');
    assertTrue(lock.readDoc === readDoc, '导出必须指向同一个函数');
  });

  test('持锁注入期间 readDoc 必须被挡住; 不持锁的裸读必然看得见(同进程，无时序依赖)', () => {
    cleanDoc();
    const original = fs.readFileSync(DOC, 'utf8');
    if (original.includes(MARK)) throw new Error('SKILL.md 已含注入标记，现场不干净');

    let blocked = false;
    let nakedSaw = false;
    try {
      withDocLock(() => {
        // 本进程已持有锁。此刻文档处于"已注入、未还原"状态。
        fs.writeFileSync(DOC, original + '\n' + MARK + '\n');

        // ① 不持锁的裸读必然看得见 —— 这就是缺陷本身，也是反向证明:
        //    没有它，"readDoc 被挡住"可能只是因为锁根本没被竞争。
        nakedSaw = fs.readFileSync(DOC, 'utf8').includes(MARK);

        // ② readDoc 必须被挡住: 同一个进程已经持有锁，它只能等到超时。
        //    超时上限取远小于 STALE_MS 的值，保证是"等锁超时"而非"陈旧强拆"。
        const shortWait = Math.min(700, Math.floor(STALE_MS / 4));
        try {
          readDoc(DOC, shortWait);
        } catch (e) {
          blocked = /无法在/.test(e.message);
        }

        fs.writeFileSync(DOC, original);
      });
    } finally {
      fs.writeFileSync(DOC, original);
      cleanDoc();
    }

    assertTrue(nakedSaw,
      '不持锁的裸读居然没看见注入 —— 现场没造成功，这条用例证明不了任何东西');
    assertTrue(blocked,
      '持锁注入期间 readDoc 没有被挡住(直接返回了)—— 读者持锁这条修复失效了，' +
      '它会在探针写入的瞬间读到半成品');
    assertTrue(!fs.readFileSync(DOC, 'utf8').includes(MARK), 'SKILL.md 必须已还原');
  });

  test('锁释放之后 readDoc 必须能正常读到还原后的内容', () => {
    cleanDoc();
    if (fs.readFileSync(DOC, 'utf8').includes(MARK)) throw new Error('SKILL.md 已含注入标记，现场不干净');
    const s = readDoc(DOC);
    assertTrue(!s.includes(MARK), 'readDoc 读到了注入标记');
    assertTrue(s.length > 1000, 'readDoc 应读到完整文档; 实际长度=' + s.length);
  });
};
