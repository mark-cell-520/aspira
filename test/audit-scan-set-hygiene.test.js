/**
 * test/audit-scan-set-hygiene.test.js — 审计的扫描集本身必须诚实
 *
 * ═══ 由来(第十轮) ═══
 * 前九轮问的一直是"文档里哪个数字没被测到"。第十轮换了个方向:
 * **审计到底扫了哪些文件?** 前三轮问了键、形态、闸门，从没问过文件集。
 *
 * 实测三件事，每一件都让"覆盖面"这个数字失真:
 *
 * ① **data/ 下有 682 份 CORE_VALUES.md 的逐字节相同副本**
 *    (`_tc_<ts>_<rand>/` 与 `_cache_probe_<ts>/`，测试泄漏的缓存/探针产物)。
 *    于是自报「已扫文档 904 份」把 682 份副本算成 682 份文档——
 *    真实不同文档只有 222 份，**自报虚高 4 倍**。
 *    NUMISH 粗计 28,592 条里 6,192 条(21.7%)来自这 682 份副本，
 *    覆盖率的分子分母同时被同一份 332 字节文件污染。
 *    (与已记录的「22.3% 分母只数根目录、自报偏乐观」同族，方向相反:
 *     那次分母太小，这次分母里塞了不是分母的东西。)
 *
 * ② **仓库根目录有个字面名为 `"` 的目录**，里面套着一整棵
 *    `/var/folders/.../T/aspira-mx-D4BRqZ"`(带引号的绝对路径)，
 *    含 CORE_VALUES.md / .opencode/memory/heartflow_state.json / data/agent-card.json。
 *    由来已记录: resolveHFDir() 曾原样返回 HEARTFLOW_DIR 且零校验。
 *    **入口已修**(两处副本都加了 sanitizeHFDir)，.gitignore 也有
 *    `*aspira-mx-*`，但这棵已泄漏的树从未清理，审计一直在扫它。
 *
 * ③ **去重自己的 catch 把异常吞成了看似合理的答案**:
 *    首版写 `catch (_) { nDistinct++; continue; }`，而 crypto 根本没 import，
 *    于是 `crypto.createHash` 抛 ReferenceError 被这个 catch 吞掉，
 *    每个文件都走进"算一份不同内容"分支——去重输出 811 份全不同、0 重复，
 *    看起来正常工作，实际**一次都没去重**。
 *    一个把异常吞成合理答案的 catch，比没有去重更危险:
 *    它让一个坏掉的自检显示为通过。
 *
 * ═══ 本测试锁什么 ═══
 * 结构断言 + 活体注入: 造一个名字带引号的目录放一份 CORE_VALUES.md，
 * 审计的已扫文档数不得因此增加。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const { withDocLock } = require('./_doc-probe-lock.js');
const { execFileSync } = require('child_process');

function runAudit() {
  return execFileSync('node', [SCRIPT], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
  });
}

function scannedCount(out) {
  const m = out.match(/已扫文档 (\d+) 份/);
  return m ? Number(m[1]) : null;
}

function distinctCount(out) {
  const m = out.match(/其中\*\*不同内容\*\* (\d+) 份/);
  return m ? Number(m[1]) : null;
}

module.exports = function ({ test, assertTrue, assertEqual }) {

  test('data/ 必须整份移出文档扫描集', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/'data':/.test(src) && /EXEMPT_DIRS/.test(src),
      'EXEMPT_DIRS 必须含 data/，并附理由');
    assertTrue(/运行时数据而非文档/.test(src),
      'data/ 的豁免理由必须写明"运行时数据而非文档"');
  });

  test('walkMd 必须跳过名字带引号/控制字符的目录', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/ARTIFACT_DIRS/.test(src), '必须有泄漏产物目录收集器');
    // 判据本身: 引号/反引号/NUL/控制字符
    assertTrue(/\["'`\]\|\[\\x00-\\x1f\]/.test(src),
      '判据必须是 引号/反引号/控制字符 —— 合法文档目录不会在名字里放引号');
    assertTrue(/运行时泄漏产物目录/.test(src),
      '自报必须列出泄漏产物目录数——未审集要说清"还有什么没审"');
  });

  test('去重必须真的去重(crypto 已导入且不静默吞异常)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/const crypto = require\('crypto'\)/.test(src),
      '必须 import crypto —— 首版没导入，去重静默失效');
    // 读不到文件必须发声，不能静默算成"不同内容"
    assertTrue(/unreadable\.length/.test(src) && /⚠️ 去重时读不到/.test(src),
      '去重时读不到文件必须报警，不能静默计入不同内容数');
  });

  test('自报必须同时给文件数与不同内容数', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/不同内容/.test(src), '自报必须报不同内容数');
    assertTrue(/逐字节重复/.test(src), '自报必须报逐字节重复数');
  });

  test('活体注入: 名字带引号的目录不得增加已扫文档数', () => withDocLock(() => {
    // 造一个与仓库里那处泄漏产物同形的目录: 名字带双引号，
    // 里面放一份 CORE_VALUES.md(与正本逐字节相同)。
    // 若 walkMd 的判据失效，已扫文档数会 +1。
    const before = runAudit();
    const n0 = scannedCount(before);
    assertTrue(n0 !== null, '审计必须输出"已扫文档 N 份"');
    const artifact = path.join(ROOT, 'aspira-probe-quote"');
    const inner = path.join(artifact, 'sub');
    let created = false;
    try {
      fs.mkdirSync(inner, { recursive: true });
      fs.writeFileSync(path.join(inner, 'CORE_VALUES.md'), fs.readFileSync(path.join(ROOT, 'CORE_VALUES.md')));
      created = true;
      const after = runAudit();
      const n1 = scannedCount(after);
      assertEqual(n1, n0,
        '名字带引号的目录必须被跳过——它是运行时泄漏产物，不是文档目录');
      assertTrue(/运行时泄漏产物目录 [1-9]/.test(after),
        '自报必须把这处泄漏产物目录数出来');
    } finally {
      if (created) {
        try { fs.rmSync(artifact, { recursive: true, force: true }); } catch (_) {}
      }
      // 恢复校验: 注入目录必须已清掉
      assertTrue(!fs.existsSync(artifact), '注入的带引号目录必须已清理');
    }
  }));

  test('活体注入: 重复文档必须被报为重复而非算作多份文档', () => withDocLock(() => {
    // 仓库里 CORE_VALUES.md 与 src/CORE_VALUES.md 本就逐字节相同。
    // 自报必须体现"重复 1 份"，而不是把两份都算成不同文档。
    const out = runAudit();
    const n = scannedCount(out);
    const d = distinctCount(out);
    assertTrue(n !== null && d !== null, '必须同时输出文件数与不同内容数');
    assertTrue(d <= n, '不同内容数不得大于文件数');
    if (n > d) {
      assertTrue(new RegExp('逐字节重复 ' + (n - d) + ' 份').test(out),
        '重复份数必须与 文件数-不同内容数 对得上');
    }
  }));
};
