/**
 * test/audit-domains-blindspot.test.js — 全绿报表里藏着从未被测量过的数字
 *
 * ═══ 由来 ═══
 * 连续第七轮 doc-honest-numbers。第六轮的结论是「六个角度已推进完毕、
 * 接近枯竭」，并建议置 exhausted 让轮换发生。
 *
 * **本轮证明那个结论下早了。**
 *
 * ═══ 枯竭检验的方法 ═══
 * 不问「还有哪些数字没审」，而问:
 *   **45/45 全绿，绿的里面有没有形式上是绿的、实际上根本没被检验的?**
 *
 * 把 pats 的 key 列出来只有 8 类:
 *   dimensions / modules / tools / routes / layers
 *   / tier_block / tier_rewrite / tier_verify / tests / nodeReq / deps
 *
 * 而 README 的能力域小节标题是:
 *   `### Capability domains (7 domains, 132 modules)`
 *
 * —— **"domains" 这个 key 不在审计的任何模式里。**
 *
 * 实测: 标题写 7，紧随的表格也正好 7 行，所以数字为真;
 * 但它是**碰巧为真**。将来加一个能力域、改了表格忘了改标题，
 * 没有任何仪器会报警——因为审计从不看这个数。
 *
 * ═══ 这为什么重要 ═══
 * 这正是本切片反复出现的形状:
 *   **一个从未被测量过的数字，在全绿的报表里
 *    与已被测量的数字无法区分。**
 * 报表说 45/45，读者无法知道其中 44 个被真的量过、
 * 1 个只是恰好写对了。而"恰好写对"和"被锁住"的区别，
 * 只在它开始变错的那一天才显现。
 *
 * ═══ 本轮修法 ═══
 * 加 `domains` key 到 pats + measure()，实测值是 README 能力域表格行数。
 * 这是**文档内部的自洽性检验**(标题 vs 表格)，不是文档 vs 代码——
 * 引擎没有 domain 一等概念，132 个模块在注册表里平铺，
 * 域只是 README 的分类视角。若不测，标题与表格可以各自漂移。
 *
 * ═══ 本测试锁什么 ═══
 * ① 审计必须实测 domains
 * ② 必须能抓住「表格加一行、标题不改」的漂移(活体注入验证)
 * ③ README 与 SKILL.md 的 domains 声称必须一致
 * ④ 标题数与表格行数必须相等(自洽)
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
// [第七轮] 共享文档探针必须互斥。run-all.js 改成有界并发后，
// 多个探针测试同时改写 README/IDENTITY 并 spawn 审计，互相破坏前提，
// 失败表现是"仪器没报警"——**看起来像仪器的错，实际是探针的错**。
// 详见 test/_doc-probe-lock.js。
const { withDocLock } = require('./_doc-probe-lock.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const README = path.join(ROOT, 'README.md');

module.exports = function ({ test, assertTrue, assertEqual }) {

  // ⚠️ 必须用 ASPIRA_AUDIT_SKIP_TESTS=1。
  // 审计默认会 spawn 整个 run-all.js(约 40s)，本测试要跑三次审计，
  // 不跳过就会超时。skip 模式只把 m.tests 置 null(测试数无法实测)，
  // **不影响 domains 实测** —— 它读的是 README 表格，与测试套件无关。
  function runAudit() {
    return execFileSync('node', [SCRIPT], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
    });
  }

  function readmeDomainRows() {
    const r = fs.readFileSync(README, 'utf8');
    const sec = r.match(/###\s*Capability domains[^\n]*\n([\s\S]*?)(?=\n---|\n##\s)/);
    if (!sec) return null;
    // 与 scripts/audit-doc-numbers.js 的实测逻辑保持同构:
    // 以 | 开头的行，排除分隔行(|---|)，第一行是表头故减 1
    const SEP = /^\s*\|[\s:|-]+\|\s*$/;
    const rows = sec[1].split('\n').filter(l => /^\s*\|/.test(l) && !SEP.test(l));
    return Math.max(0, rows.length - 1);
  }

  test('审计必须实测 capability domains(该 key 此前完全缺失)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/key:\s*'domains'/.test(src),
      'pats 必须有 domains 模式——它此前不在审计的任何模式里，'
      + '于是 README 标题的 "N domains" 从未被核对');
    assertTrue(/m\.domains\s*=/.test(src), 'measure() 必须实测 domains');
    assertTrue(/actual\.domains\s*=/.test(src), 'actual 必须映射 domains');
  });

  test('README 标题的 domains 数必须等于能力域表格行数', () => {
    const r = fs.readFileSync(README, 'utf8');
    const title = (r.match(/###\s*Capability domains\s*\((\d+)\s+domains?/) || [])[1];
    const rows = readmeDomainRows();
    assertTrue(!!title, 'README 应有 "### Capability domains (N domains, ...)" 标题');
    assertTrue(rows !== null, 'README 应有能力域表格');
    if (title && rows !== null) {
      assertEqual(Number(title), rows,
        `标题声称 ${title} domains，但表格有 ${rows} 行——两者必须一致，`
        + '否则将来加一个域、改了表格忘了改标题，没有任何仪器会报警');
    }
  });

  test('活体验证: 表格加一行而标题不改，审计必须抓住', () => withDocLock(() => {
    // 这是本测试的核心: 一个永远绿的模式只是装饰。
    // 注入一处真实漂移，确认审计变红，然后恢复。
    //
    // ⚠️ 首版把备份只存在内存里，测试被 SIGTERM kill 时 finally 来不及跑，
    // README 残留了 7 行探针。**一个会污染被测文件的测试，'
    // 失败时会把自己的污染说成产品的回归。**
    // 现在: 备份同时落盘到 /tmp，且在测试**开头**先清理上一次的残留。
    const backupPath = '/tmp/aspira-readme-domains-probe.bak';
    const current = fs.readFileSync(README, 'utf8');
    if (/Meta \| metaEngine/.test(current)) {
      // 上一次的残留: 从备份恢复
      try {
        const bak = fs.readFileSync(backupPath, 'utf8');
        if (!/Meta \| metaEngine/.test(bak)) {
          fs.writeFileSync(README, bak);
        }
      } catch (_) { /* 无备份则交给 git */ }
    }
    const backup = fs.readFileSync(README, 'utf8');
    fs.writeFileSync(backupPath, backup);
    const anchor = '| Creation / collaboration | skillEvolution, worldModel, multiAgentDialogue, codeExecutor, formula |';
    try {
      assertTrue(backup.includes(anchor), 'README 应含能力域表格末行锚点');
      const injected = backup.replace(anchor,
        anchor + '\n| Meta | metaEngine, selfReflection, goalAudit |');
      assertTrue(injected !== backup, '注入应改变文件内容');
      assertEqual((injected.match(/Meta \| metaEngine/g) || []).length, 1,
        '注入必须只加一行(首版因重复执行叠加了多行)');
      fs.writeFileSync(README, injected);
      const out = runAudit();
      assertTrue(/capability domains/.test(out) && /实测\s+\d+/.test(out),
        '审计必须报出 domains 的实测值');
      assertTrue(/不一致:\s*[1-9]/.test(out),
        '表格加一行而标题不改时，审计必须报出不一致——'
        + '否则这个模式只是另一个永远绿的装饰');
    } finally {
      // 双重保险: 先写回备份，再验证无残留
      fs.writeFileSync(README, backup);
      const verify = fs.readFileSync(README, 'utf8');
      if (/Meta \| metaEngine/.test(verify)) {
        throw new Error('恢复失败: README 仍含探针行，请执行 git checkout -- README.md');
      }
    }
    // 恢复后必须重新变绿
    const after = runAudit();
    assertTrue(/不一致:\s*0/.test(after), '恢复 README 后审计应重新全绿');
  }));

  test('README 与 SKILL.md 的 domains 声称必须一致', () => {
    const r = fs.readFileSync(README, 'utf8');
    const rTitle = (r.match(/###\s*Capability domains\s*\((\d+)\s+domains?/) || [])[1];
    const s = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
    // ⚠️ SKILL.md 用的是 `## Capability map (N domains, ...)` ——
    // **同一件事在两份文档里用了不同的标题词**(domains vs map)。
    // 首版只匹配 "Capability domains"，于是 SKILL.md 那条从未被读到，
    // 而审计的正则 `(\d+)\s+domains?` 抓到了它。
    // **一个测试读不到的地方，正是文档可能撒谎的地方。**
    const sTitle = (s.match(/Capability (?:domains|map)\s*\((\d+)\s+domains?/i) || [])[1];
    assertTrue(!!rTitle, 'README 应有 domains 标题');
    assertTrue(!!sTitle, 'SKILL.md 应有 domains 标题(标题词是 "Capability map")');
    if (rTitle && sTitle) {
      assertEqual(rTitle, sTitle, `README 写 ${rTitle} domains，SKILL.md 写 ${sTitle} domains——两份文档必须一致`);
    }
  });

  test('恢复后 README 无探针残留', () => {
    const r = fs.readFileSync(README, 'utf8');
    assertTrue(!/Meta \| metaEngine/.test(r), 'README 不得残留探针注入的 domain 行');
    assertTrue(!/ASPIRA-BLINDSPOT-PROBE/.test(r), 'README 不得残留盲区探针标记');
  });
};
