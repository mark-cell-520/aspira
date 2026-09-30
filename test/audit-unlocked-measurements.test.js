/**
 * test/audit-unlocked-measurements.test.js — 被测到却锁不住的键
 *
 * ═══ 由来(第十一轮) ═══
 * 前四轮依次问了审计的键、形态、闸门、文件集。本轮做加固，第一步是
 * **反向枚举**: 把 pats 的 key 与 measure() 里赋值的 key 对差。
 * 得到 21 个"被测但无模式"的键。其中绝大多数是中间量
 * (depsDeclared / depsOptional / nodeScannedFiles / instantInstallWorks …)，
 * 只是真正 key 的输入，不需要自己的模式。
 *
 * 但有两个是**文档里明明有当前声称、却一个模式都不核对**的:
 *
 * ① `version` —— 约定 #1 原文: "Never hardcode the version.
 *    VERSION is the single source of truth… package.json 和 SKILL.md
 *    必须匹配"。measure() 一直测 VERSION，audit 也打印它，
 *    **却没有任何模式拿它核对文档**。
 *    实测注入: README 的 "Measured on this repository at **v1.0.0**"
 *    改成 v9.9.9 → 审计仍 78/78、0 不符。
 *    这是第七轮 `domains` 那一类("被测到却锁不住")，
 *    而且中的是约定 #1 点名的那一个数字。
 *
 * ② `testsFailed` —— m.testsFailed 与 m.tests 出自同一个正则
 *    (都在解析 run-all 的输出)，却从未进 actual。
 *    实测注入: "0 failing" → "7 failing" → 同样 0 报告。
 *    于是 README/SKILL/CURRENT_STATE 三处的 "0 failing"
 *    是一句**永远不必为真**的话。
 *
 * ═══ 为什么版本模式只认带标签的形态 ═══
 * 实测已扫文档里有 **551 处** 版本形态，绝大多数是路线图/架构里程碑
 * (ARCHITECTURE.md 的 v6.3.0/v6.4.0/v6.5.0、ROADMAP.md 的 v6.0.6)，
 * 不是包版本。匹配裸 `v?\d+\.\d+\.\d+` 就是第 26 次仪器失效的同一条:
 * 枚举式过滤器每遇到一种新的叙述方式就漏一次，而版本号的叙述方式
 * 有十几种。故只认两种无歧义标签:
 *   `| Engine version | 1.0.0 |`   (SKILL.md 指标表)
 *   `> 版本 | v1.0.0`              (CURRENT_STATE.md 行首)
 * **deliberately 不认** `| 版本 |` 表格形态: REFLECTION.md 有一行
 * `| 版本 | 6.2.7 |`，位于 `## 现在（2026-07-25）` 之下——
 * 一份"过去/现在/未来"反思文档里钉在 2026-07-25 的**时点快照**，
 * 拿现在去核对就是制造假警报。该残留在此披露，不假装没有。
 *
 * ═══ SKIP_TESTS 的已知代价 ═══
 * 本测试的 runAudit 带 ASPIRA_AUDIT_SKIP_TESTS=1(否则审计会 spawn
 * run-all → 本测试 → 审计，无限递归)。该开关使 m.tests 与
 * m.testsFailed 同时变 null，于是"失败数"声称落入"无法实测"
 * 而非"不符"——与第九轮记录的 ASPIRA_AUDIT_SKIP_TESTS 伪影同性质。
 * 因此失败数只断言"被识别 + 已接线"，其"变红"一面由
 * 不带 SKIP_TESTS 的手工注入验证过(README 注入 7 failing → 实测 0)。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const README = path.join(ROOT, 'README.md');
const SKILL = path.join(ROOT, 'SKILL.md');
const CURRENT_STATE = path.join(ROOT, 'CURRENT_STATE.md');
const { withDocLock, restoreVersionLine, PROBE_VERSION } = require('./_doc-probe-lock.js');
const { execFileSync } = require('child_process');

function runAudit() {
  try {
    return execFileSync('node', [SCRIPT], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
    });
      // [第二十二轮] 审计退出码现在承载结论(mismatch/漂移 -> 1)，execFileSync 对
      // 非零退出抛异常。活体注入要的正是那份 stdout，所以从 e.stdout 取回 ——
      // 否则一个**正确报出不符**的审计会把探针自己炸掉(周期22 实测 13 例全红)。
  } catch (e) {
    return (e.stdout || '').toString();
  }
}
function mismatchCount(out) {
  const m = out.match(/不一致: (\d+)/);
  return m ? Number(m[1]) : -1;
}

module.exports = function ({ test, assertTrue, assertEqual }) {

  test('version 与 testsFailed 必须接进 actual', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/actual\.version\s*=\s*m\.version/.test(src),
      'actual.version 必须接线——约定 #1 点名 VERSION 是唯一真相源，'
      + '而它此前被测到、被打印，却没有任何模式能核对它');
    assertTrue(/actual\.testsFailed\s*=\s*m\.testsFailed/.test(src),
      'actual.testsFailed 必须接线——它与 m.tests 同出一个正则，'
      + '却从未进 actual，于是三处 "0 failing" 永远不必为真');
  });

  test('版本模式必须只认无歧义标签，不认裸语义版本号', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/Engine version/.test(src) && /版本 \(CURRENT_STATE 行首\)/.test(src),
      '必须有两种带标签的版本模式');
    // 不得出现裸语义版本号模式(实测 551 处版本形态，绝大多数是路线图标记)
    assertTrue(!/re:\s*\/[^/]*\\b\?v\?\\d\+\\\\\.\\d\+\\\\\.\\d\+/.test(src.split('Engine version')[0]),
      '不得在版本模式之前引入裸语义版本号匹配');
    assertTrue(/551/.test(src),
      '源码里必须记录"551 处版本形态"这个实测数字——它是选择标签化而非裸匹配的理由');
    assertTrue(/REFLECTION\.md/.test(src) && /2026-07-25/.test(src),
      '必须披露 REFLECTION.md 的 6.2.7 是钉在 2026-07-25 的时点快照、故意不审');
  });

  test('失败数模式必须存在且带 reject', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/key: 'testsFailed'/.test(src), '必须有 testsFailed 模式');
    assertTrue(/failing tests \(失败数\)/.test(src), '模式说明必须写清是失败数');
    assertTrue(/reject:[\s\S]{0,120}key: 'testsFailed'|key: 'testsFailed'[\s\S]{0,200}reject:/.test(src),
      'testsFailed 模式必须带 reject —— SKILL.md 有历史读数'
      + ' "711 passing / 1 failing (was 546)"，过去时 was 在数字之后');
  });

  test('活体注入: 引擎版本写错必须变红', () => withDocLock(() => {
    const backup = fs.readFileSync(SKILL, 'utf8');
    try {
      const target = backup.match(/\|\s*Engine version\s*\|\s*v?(\d+\.\d+\.\d+)/);
      assertTrue(!!target, 'SKILL.md 应有 Engine version 表格行');
      fs.writeFileSync(SKILL, backup.replace(target[0], '| Engine version | 9.9.9'));
      const out = runAudit();
      assertTrue(mismatchCount(out) >= 1,
        '引擎版本写错必须被报为不符——约定 #1 点名它，而它长期一个模式都不核对');
      assertTrue(/engine version \(标签表格\)/.test(out),
        '审计应通过"标签表格"模式把该行纳入 version 核对');
    } finally {
      // [第二十三轮] 还原写权威值，不写回 backup。写回 backup 在文档已被污染时
      // 会把 9.9.9 原样写回去，污染从此永久自锁(实测连跑两轮 1364/7 无人能修)。
      fs.writeFileSync(SKILL, restoreVersionLine(backup));
      if (!/\|\s*Engine version\s*\|\s*1\.0\.0/.test(fs.readFileSync(SKILL, 'utf8'))) {
        throw new Error('恢复失败: SKILL.md 的 Engine version 行异常，请 git checkout -- SKILL.md');
      }
    }
  }));

  test('活体注入: CURRENT_STATE 版本行写错必须变红', () => withDocLock(() => {
    const backup = fs.readFileSync(CURRENT_STATE, 'utf8');
    try {
      fs.writeFileSync(CURRENT_STATE, backup.replace('> 版本 | v1.0.0', '> 版本 | v2.0.0'));
      const out = runAudit();
      assertTrue(mismatchCount(out) >= 1, 'CURRENT_STATE 的版本行写错必须被报为不符');
      assertTrue(/版本 \(CURRENT_STATE 行首\)/.test(out), '审计应识别该版本行');
    } finally {
      // [第二十三轮] 同上: CURRENT_STATE 的版本行也按权威值还原。
      fs.writeFileSync(CURRENT_STATE, backup.replace(/(>\s*版本\s*\|\s*)v?\d+\.\d+\.\d+/, '$1v' + PROBE_VERSION));
      if (!/> 版本 \| v1\.0\.0/.test(fs.readFileSync(CURRENT_STATE, 'utf8'))) {
        throw new Error('恢复失败: CURRENT_STATE.md 版本行异常，请 git checkout -- CURRENT_STATE.md');
      }
    }
  }));

  test('失败数声称必须被识别(SKIP_TESTS 下只能验到这一层)', () => withDocLock(() => {
    // ⚠️ 不断言"变红": 本测试的 runAudit 带 SKIP_TESTS，
    // 该开关使 m.testsFailed=null，注入后落入"无法实测"而非"不符"。
    // 那是探针代价，不是模式失效——不带 SKIP_TESTS 的手工注入已验证过:
    // README 注入 "7 failing" → 报「failing tests (失败数) = 7」实测 0。
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const backup = fs.readFileSync(README, 'utf8');
    try {
      const target = backup.match(/(\d[\d,]*)\s+passing\s*\/\s*(\d[\d,]*)\s+failing/);
      assertTrue(!!target, 'README 应有 "N passing / N failing" 形态');
      const out0 = runAudit();
      assertTrue(/failing tests \(失败数\)/.test(out0),
        '审计必须识别失败数声称——它此前与 m.testsFailed 一样，从未被核对');
      // 注入只改失败数，声称必须仍在(即仍被识别)
      fs.writeFileSync(README, backup.replace(target[0], target[1] + ' passing / 7 failing'));
      const out1 = runAudit();
      assertTrue(/README\.md 声称「failing tests \(失败数\) = 7」/.test(out1)
        || /failing tests \(失败数\) = 7/.test(out1),
        '注入 7 后失败数声称必须仍被识别');
    } finally {
      fs.writeFileSync(README, backup);
      if (!/\d[\d,]*\s+passing\s*\/\s*0 failing/.test(fs.readFileSync(README, 'utf8'))) {
        throw new Error('恢复失败: README.md 的 Test suite 行异常，请 git checkout -- README.md');
      }
    }
  }));
};
