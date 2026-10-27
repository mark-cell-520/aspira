/**
 * test/doc-probe-crash-recovery.test.js — 探针被 kill 后，文档必须能被还原
 *
 * ═══ 为什么要有这个测试 ═══
 * 探针测试的还原一直靠各自的 `finally`。而 run-all.js 的每个测试文件跑在独立
 * 子进程里，CHILD_TIMEOUT 240 秒；12 个 doc 探针在同一把锁上串行、每个持锁期
 * spawn 一次完整审计，队尾等待实测可超时被 kill。**被 kill 的进程没有 finally。**
 *
 * 这不是理论推演：2026-10-25 与 2026-10-27 两次推送前清点，工作区脏项几乎全是
 * 这个形状，且两次注入逐字相同。test/_doc-probe-restore.js 把它统一成共享机制，
 * 本文件钉住四件事：
 *
 *   ① 覆盖判据本身不能悄悄漂移（该护的护住，运行期数据不碰）；
 *   ② 子进程写入探针后被 SIGKILL（finally 来不及跑）→ 恢复必须写回快照；
 *   ③ 持有者进程还活着 → 恢复必须跳过（否则并发的兄弟探针会被误还原）；
 *     持有者死后 → 必须能恢复。
 *   ④ 测试自己还原成功后退出 → 登记必须被撤掉（否则快照无限堆积）。
 *
 * ═══ 为什么②③④必须在同一个用例里顺序跑 ═══
 * 首版把它们写成四个独立用例，结果三个全红，而机制本身是好的。原因在 harness：
 * `test()` 对返回 Promise 的用例是**立即调用然后挂起**，四个用例并发启动，而它们
 * 读 `orig` 的代码在 `withDocLock` **之前**——于是有的用例读到了别的用例子进程
 * 正在注入中的 README，`orig` 自带别人的探针标记，之后的逐字节比对必然不相等。
 * **失败的样子像机制坏了，实际是用例自己并发踩自己。**
 * 现在合成一个用例顺序执行，`orig` 与断言都在同一把锁的保护区间内。
 *
 * ═══ 为什么动的是真 README 而不是临时文件 ═══
 * 覆盖范围判据是「根目录 *.md」这类路径形状，换一个临时 .md 文件就测不到真实的
 * 判据。全程持 doc-probe 锁，且每一步之后都兜一次底，所以不会把 README 留在
 * 注入态。真被 kill 了也不怕：子进程登记的 pid 已死，下一次跑任何测试前的
 * recoverOrphans() 会把它还原 —— 这正是本测试要证的性质。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { withDocLock } = require('./_doc-probe-lock.js');
const restore = require('./_doc-probe-restore.js');

const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const MOD = path.resolve(__dirname, '_doc-probe-restore.js');

const MARKER_KILL = '<!-- PROBE-RESTORE-SELFTEST-KILLED -->';
const MARKER_LIVE = '<!-- PROBE-RESTORE-SELFTEST-LIVE -->';
const MARKER_SELF = '<!-- PROBE-RESTORE-SELFTEST-SELFRESTORED -->';

/**
 * 已知会被探针写进受跟踪文档的记号。命中任何一条都说明有探针注入后没还原。
 * 只列**只会由探针产生**的串：aspira-probe 是探针产物目录/agentId 的前缀，
 * ASPIRA-BLINDSPOT-PROBE 是盲探测试注入进 README 的字面 HTML 注释。
 * 两者都不可能是合法内容 —— 合法编辑不会写这两个串。
 */
const PROBE_MARKERS = ['ASPIRA-BLINDSPOT-PROBE', 'aspira-probe', 'PROBE-RESTORE-SELFTEST'];

/** 持锁扫描的范围：与 _doc-probe-restore.js 的探针目标判据一致。 */
const SCAN_TARGETS = ['README.md', 'AGENTS.md', 'SKILL.md', 'IDENTITY.md', 'CURRENT_STATE.md', 'VERSION',
  path.join('scripts', 'audit-doc-numbers.js')];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个子进程跑一段代码，等它退出，返回 {code, signal} */
function runNode(code) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], { cwd: ROOT, stdio: 'ignore' });
    child.on('error', (e) => resolve({ code: null, signal: null, err: e }));
    child.on('close', (code, signal) => resolve({ code, signal, err: null }));
  });
}

/** 子进程代码：装 guard，把一行标记追加到 README，然后各自走各自的结局 */
function injectCode(marker, ending) {
  return [
    'const m = require(' + JSON.stringify(MOD) + ');',
    'm.installWriteGuard();',
    'const fs = require("fs");',
    'const P = ' + JSON.stringify(README) + ';',
    'fs.writeFileSync(P, fs.readFileSync(P, "utf8") + ' + JSON.stringify('\n' + marker + '\n') + ');',
    ending,
  ].join('\n');
}

/** 每一步之后都确认 README 没被留在注入态；真出问题就地修回 orig。 */
function assertClean(text, orig, label) {
  if (text.includes(MARKER_KILL) || text.includes(MARKER_LIVE) || text.includes(MARKER_SELF)) {
    throw new Error(label + ': README 仍含探针标记，本测试自己造成了污染');
  }
  if (text !== orig) {
    throw new Error(label + ': README 与介入前不一致（长度 ' + text.length + ' vs ' + orig.length + '）');
  }
}

module.exports = function ({ test, assertEqual, assertTrue }) {
  // ─── ① 判据本身先被钉住：覆盖范围不能悄悄漂移 ───
  test('探针目标判据只覆盖文档类受跟踪文件，不碰运行期数据', () => {
    assertTrue(restore.isProbeTarget(README), '根目录 README.md 必须是探针目标');
    assertTrue(restore.isProbeTarget(path.join(ROOT, 'SKILL.md')), 'SKILL.md 必须是探针目标');
    assertTrue(restore.isProbeTarget(path.join(ROOT, 'VERSION')), 'VERSION 必须是探针目标');
    assertTrue(restore.isProbeTarget(path.join(ROOT, 'scripts', 'audit-doc-numbers.js')),
      '文档数字审计脚本必须是探针目标');
    assertTrue(!restore.isProbeTarget(path.join(ROOT, 'src', 'data', 'tom', 'agents.json')),
      'src/data 下的运行期数据不是自动探针目标');
    assertTrue(!restore.isProbeTarget(path.join(ROOT, 'src', 'memory', 'x.jsonl')),
      'memory 运行期数据不是自动探针目标');
    assertTrue(!restore.isProbeTarget(path.join(ROOT, 'test', 'x.test.js')),
      '测试文件不是自动探针目标');
    assertTrue(!restore.isProbeTarget(path.join(ROOT, 'package.json')),
      'package.json 不在自动范围内（没有测试合法留它脏，也没有探针注入它）');
  });

  // ─── ⑤ 污染必须看得见：不能等某次推送前人工清点才发现 ───
  // 2026-10-25 与 10-27 两次推送前审计，都是靠人逐段读 git diff 才认出脏项是
  // 探针遗产而非工作成果。那个成本本可以是一行红。
  // 范围刻意只含文档类探针目标：它们由 doc-probe 锁保护，持锁扫描是确定性的。
  // **不含** src/data/tom/agents.json 这类运行期数据 —— 那里的探针记录是引擎自己
  // 把探针输入存成的（没有任何测试写它，见 .gitignore 里「把已跟踪的运行期文件
  // 移出版本控制是另一个决定，本轮不做」），扫描它会常红，常红的断言等于没有断言。
  test('受跟踪文档里不得残留探针记号（污染必须被门禁看见，而不是等人工清点）', async () => {
    await withDocLock(async () => {
      const hits = [];
      for (const rel of SCAN_TARGETS) {
        const p = path.join(ROOT, rel);
        if (!fs.existsSync(p)) continue;
        const txt = fs.readFileSync(p, 'utf8');
        for (const mk of PROBE_MARKERS) {
          if (txt.includes(mk)) hits.push(rel + ' 含 ' + mk);
        }
      }
      assertEqual(hits.length, 0,
        '受跟踪文档里有探针注入未还原的残留：' + hits.join('；')
        + '。先跑一次 node test/run-all.js（启动前的 recoverOrphans 会还原），'
        + '仍不行再按 test/audit-self-pollution.test.js 记的方法手工处理');
    });
  });

  // ─── ②③④ 顺序执行，见文件头「为什么必须在同一个用例里」 ───
  test('探针被 kill / 持有者活着 / 自己还原干净，三种结局都被正确处理', async () => {
    await withDocLock(async () => {
      const orig = fs.readFileSync(README, 'utf8');
      assertClean(orig, orig, '起点');
      try {
        // ── ② 崩溃：finally 来不及跑，快照仍能还原 ──
        const r = await runNode(injectCode(MARKER_KILL, 'process.kill(process.pid, "SIGKILL");'));
        assertEqual(r.signal, 'SIGKILL',
          '子进程必须是被 SIGKILL 终止的，否则测不到 finally 来不及跑（实际 signal=' + r.signal + '）');
        const polluted = fs.readFileSync(README, 'utf8');
        assertTrue(polluted.includes(MARKER_KILL),
          '子进程被 kill 后 README 应留在注入态 —— 否则本测试没有测到任何东西');

        const res = restore.recoverOrphans({ quiet: true });
        assertTrue(res.recovered.some((f) => f === README),
          'recoverOrphans 必须报出恢复了 README，实际: ' + JSON.stringify(res.recovered));
        assertClean(fs.readFileSync(README, 'utf8'), orig, '② 恢复后');

        // ── ③ 并发：持有者活着就不能动它的文件；死了才能动 ──
        const child = spawn(process.execPath,
          ['-e', injectCode(MARKER_LIVE, 'setTimeout(() => {}, 60000);')],
          { cwd: ROOT, stdio: 'ignore' });
        await sleep(1500); // 等它写完
        assertTrue(fs.readFileSync(README, 'utf8').includes(MARKER_LIVE), '子进程应已注入标记');

        const skip = restore.recoverOrphans({ quiet: true });
        assertTrue(!skip.recovered.some((f) => f === README),
          '持有者活着时不得恢复 README，实际恢复了: ' + JSON.stringify(skip.recovered));
        assertTrue(fs.readFileSync(README, 'utf8').includes(MARKER_LIVE),
          '持有者活着时 README 必须保持注入态');

        // 必须等 exit 事件：不等的话子进程变僵尸，而 signal 0 对僵尸仍然成功，
        // 存活判据会把这个已经死透的持有者判成活着（实测 recoverOrphans 返回 []）。
        child.kill('SIGKILL');
        await new Promise((done) => { child.on('exit', () => done()); setTimeout(done, 3000); });
        const res2 = restore.recoverOrphans({ quiet: true });
        assertTrue(res2.recovered.some((f) => f === README),
          '持有者死后必须能恢复，实际: ' + JSON.stringify(res2.recovered));
        assertClean(fs.readFileSync(README, 'utf8'), orig, '③ 持有者死后恢复');

        // ── ④ 干净退出：登记不许无限堆积 ──
        const code = [
          'const m = require(' + JSON.stringify(MOD) + ');',
          'm.installWriteGuard();',
          'const fs = require("fs");',
          'const P = ' + JSON.stringify(README) + ';',
          'const o = fs.readFileSync(P, "utf8");',
          'fs.writeFileSync(P, o + ' + JSON.stringify('\n' + MARKER_SELF + '\n') + ');',
          'm.restore(P);',
        ].join('\n');
        const r4 = await runNode(code);
        assertEqual(r4.code, 0, '子进程应正常退出，实际 code=' + r4.code + ' signal=' + r4.signal);
        assertClean(fs.readFileSync(README, 'utf8'), orig, '④ 子进程自还原后');

        const after = restore.recoverOrphans({ quiet: true });
        assertTrue(!after.recovered.some((f) => f === README),
          '干净退出的子进程不该留下待恢复登记，实际: ' + JSON.stringify(after.recovered));
        assertClean(fs.readFileSync(README, 'utf8'), orig, '④ 结尾');
      } finally {
        // 兜底：任何一步失败都不许把 README 留在注入态
        const cur = fs.readFileSync(README, 'utf8');
        if (cur !== orig) fs.writeFileSync(README, orig);
        restore.recoverOrphans({ quiet: true });
      }
    });
  });
};
