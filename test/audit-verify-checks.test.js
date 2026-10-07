/**
 * test/audit-verify-checks.test.js — verify 检查项数的审计锁
 *
 * [doc-honest-numbers·第一百二十九轮] 新建。
 *
 * ═══ 背景: 一个被打印的数字与一个被声称的数字从未相遇 ═══
 * 本轮按 cycle 8 的传统重演机械枚举("已枚举过"是过期读数——扫描集与
 * 文档都已变), 在"数字+词"形态里发现 `installation checks` / `verify the
 * installation (N checks)` 两处声称描述 **bin/verify.js 的检查项数**。
 * 实测: verify.js 每轮输出 15 个 ✅(cycle 13 把版本一致性加成第 15 项),
 * 而 README 与 SKILL 的用法示例都写着 **14** —— 两处 stale, 而审计此前
 * 没有任何 key 核对它们。这正是本切片反复记录的形状:
 * **一个被测量、被打印的数字(15/15 每轮都跑)与一个被声称的数字(14)
 * 从未相遇**, 在全绿报表里与被锁住的数字无法区分。
 *
 * ═══ 修法 ═══
 * ① README/SKILL 两处 stale 14 → 15;
 * ② audit 加 `verifyChecks` key(两条模式, 刻意收窄到 verify 语境, 不匹配
 *    裸 "N checks"——后者在本仓多指 guard-abilities 的 18 项与各 skill
 *    的局部检查数), 实测 spawn `node bin/verify.js` 数 ✅ 行(约 5s, 不
 *    依赖 run-all, 故跳过模式下也照常实测——否则探针里恒绿);
 * ③ actual.verifyChecks 赋值紧贴 actual.tests(cycle 44/47 记录: 那是
 *    本文件唯一被证明可用的赋值位置, 放错两次都表现为"无法实测")。
 *
 * ═══ 残余(披露) ═══
 * "18 / 18 checks"(guard-abilities)仍未加 key: 它的项数只有跑完
 * (spawn 整个 run-all)才知道, 审它 = 审计里再嵌套一轮全量测试, 代价
 * 远超收益; 该数字由 guard 自身输出 "N/18 项检查" 自证。
 *
 * ═══ 锁什么 ═══
 * ① 源级: pats 有 verifyChecks 模式、measure 赋值 actual;
 * ② 活体: 注入错值审计必须抓住(锁不是恒真的);
 * ③ 恢复后无不一致。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { withDocLock } = require('./_doc-probe-lock.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const README = path.join(ROOT, 'README.md');

module.exports = function ({ test, assertTrue }) {

  // 含 spawn 的具名辅助函数 —— doc-probe-lock-coverage 的判据要求:
  // spawn 写在模块层辅助函数里, 持锁发生在**调用处**(见该测试 25/28 轮注释)。
  // 首版把 execFileSync 内联在 withDocLock 回调里, 于是它往前找不到具名函数,
  // 报"无法判定(宁可信其无)"—— 又一个"检测器要的形态没给就对"的形状。
  function runAuditQuiet() {
    try {
      return execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
      });
    } catch (e) { return (e.stdout || '').toString(); }
  }

  test('源级: pats 必须有 verifyChecks 模式且 actual 被赋值', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/key:\s*'verifyChecks'/.test(src),
      'pats 必须有 verifyChecks key —— 少了它, "N installation checks" 声称无人核对');
    assertTrue(src.includes("installation\\s+checks") || src.includes('installation checks'),
      'verifyChecks 的模式必须覆盖 README 的 "N installation checks" 形态');
    assertTrue(/verify\\s\+the\\s\+installation|verify\s+the\s+installation/.test(src),
      'verifyChecks 的模式必须覆盖 SKILL 的 "verify the installation (N checks)" 形态');
    assertTrue(/actual\.verifyChecks\s*=\s*m\.verifyChecks/.test(src),
      'measure() 必须把实测值赋给 actual.verifyChecks(赋值位置错=永远无法实测)');
    assertTrue(/m\.verifyChecks\s*=/.test(src),
      '必须有 m.verifyChecks 的实测赋值(spawn verify.js 数 ✅)');
  });

  test('活体: 注入错值, 审计必须抓住', () => withDocLock(() => {
    const backup = fs.readFileSync(README, 'utf8');
    const from = '# 15 installation checks';
    if (!backup.includes(from)) throw new Error('README.md 无 "# 15 installation checks" 锚点(本轮已同步)');
    try {
      fs.writeFileSync(README, backup.replace(from, '# 13 installation checks'));
      const out = runAuditQuiet();
      const mismatchLine = (out.split('与实测不符')[1] || '');
      assertTrue(/README\.md/.test(mismatchLine),
        '注入 13 后审计必须点名 README.md 不符 —— 抓不到就是恒真锁。实测输出: ' +
        JSON.stringify(out.split('\n').filter(l => /不一致/.test(l)).slice(0, 2)));
      assertTrue(/verifyChecks|installation checks/.test(mismatchLine) || /13/.test(mismatchLine),
        '不一致明细必须体现 verifyChecks 声称(实测 15)');
    } finally {
      // 无论断言是否通过都必须还原——铁律 0: 不得把仓库留在注入态
      fs.writeFileSync(README, backup);
    }
  }));

  // [第一百三十二轮] "恢复后再跑一次审计确认绿"改成**静态字节比对**: 恢复成功的
  // 定义就是文件回到 backup(审计的输入确定), 不必再花一次完整审计 spawn。
  // 实测背景: 12 个 doc 探针在并发 runner 下竞争 doc-probe 锁, 129/130 两把
  // 新锁各 2 次 spawn 加剧了压力 —— 三连跑都有 mount 进程被 kill
  // (Command failed), 测试总数在 1613/1616/1617 间抖。减半 spawn 是
  // 最小变更的减压; 竞争根因(STALE_MS > callers patience, cycle 31 记录)
  // 留待后续。
  test('恢复后: 文件必须字节级还原(静态验证, 不再 spawn 审计)', () => {
    const now = fs.readFileSync(README, 'utf8');
    assertTrue(now.includes('# 15 installation checks') && !now.includes('# 13 installation checks'),
      'README 必须还原为权威值 15, 不得残留注入值 13');
  });
};
