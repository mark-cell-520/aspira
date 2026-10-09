/**
 * test/identity-domains-consistency.test.js — "N 大域" 曾是审计盲区
 *
 * [doc-honest-numbers·第一百六十四轮] 新建。
 *
 * ═══ 缺陷 ═══
 * 第一百六十三轮把能力域从 7 扩到 8(补 Classical texts 第 8 域)，README 与
 * SKILL.md 都改成了 "8 domains"，**IDENTITY.md 留在了旧值**:
 *
 *     IDENTITY.md L35: 「132 个模块真实加载、真实调用，分 7 大域：」
 *     且它自己列出 7 个域(逻辑/决策/认知/情绪心理/记忆/人格伦理/创造协作)
 *
 * 而审计**全绿** —— 因为 domains 的 pattern 只认英文:
 *
 *     { re: /(\d+)\s+domains?/g, key: 'domains', … }
 *
 * IDENTITY.md 用的是中文"分 7 大域"，那个形态不在任何 pattern 里，从不被核对。
 *
 * 这与第一百五十三轮 SKILL.md 的 "Capability map (N domains)" 是同一形状:
 * **同一个数字在第二份文档里用了不同措辞，就成了审计的盲区。** 区别是上一轮
 * 那份文档至少被 `(\d+)\s+domains?` 抓到(标题里含英文 domains 一词)，这一份
 * 连抓都没被抓过。
 *
 * ═══ 修法 ═══
 * 1. IDENTITY.md 补第 8 域(典籍域)，"分 7 大域"→"分 8 大域"，"这七域"→"这八域"
 * 2. 审计加中文 pattern `(\d+)\s*大域`，让这个形态进入闭环
 *
 * ═══ 实测 ═══
 *   审计声称总数 86 → **87**(新增中文 domains key)
 *   注入验证: 把 IDENTITY.md 改回"分 7 大域"，审计立刻报
 *     「IDENTITY.md 声称 capability domains (中文) = 7 实测 8」
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const { withDocLock } = require('./_doc-probe-lock.js');

  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
  const IDENTITY = path.join(ROOT, 'IDENTITY.md');

  function runAudit() {
    try {
      return execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
      });
    } catch (e) { return (e.stdout || '').toString(); }
  }

  // ── 一、源级: 审计必须有中文 domains pattern ────────────
  test('源级: 审计必须有中文"N 大域"形态的 domains pattern', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/key:\s*'domains'/.test(src), 'pats 必须有 domains key');
    assertTrue(/大域/.test(src),
      'pats 必须含中文"大域"形态 —— 只认英文 domains 时，IDENTITY.md 的' +
      '"分 N 大域"从不被核对(本轮就抓到一个停在旧值 7 的)');
  });

  // ── 二、IDENTITY.md 的域数必须与它自己列出的域数一致 ────
  test('IDENTITY.md 标题的域数必须等于它自己列出的域数', () => {
    const t = fs.readFileSync(IDENTITY, 'utf8');
    const title = (t.match(/分\s*(\d+)\s*大域/) || [])[1];
    assertTrue(!!title, 'IDENTITY.md 应含"分 N 大域"');
    // 数 "### N. XX域" 形态的条目
    const items = [...t.matchAll(/^###\s+(\d+)\.\s+(\S+域)/gm)].map(m => Number(m[1]));
    assertTrue(items.length >= 2, `前提失效: 只解析到 ${items.length} 个域条目`);
    assertEqual(Number(title), items.length,
      `IDENTITY.md 标题说 ${title} 大域, 但它自己列出 ${items.length} 个 —— 两者必须一致`);
    // 编号必须连续
    for (let k = 0; k < items.length; k++) {
      assertEqual(items[k], k + 1, `第 ${k + 1} 个域编号写成 ${items[k]}(不连续会让计数失真)`);
    }
  });

  // ── 三、三份文档的域数必须互相一致 ─────────────────────
  test('README / SKILL.md / IDENTITY.md 的域数必须互相一致', () => {
    const r = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const s = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
    const i = fs.readFileSync(IDENTITY, 'utf8');
    const rN = (r.match(/Capability domains\s*\((\d+)\s+domains?/) || [])[1];
    const sN = (s.match(/Capability (?:domains|map)\s*\((\d+)\s+domains?/i) || [])[1];
    const iN = (i.match(/分\s*(\d+)\s*大域/) || [])[1];
    assertTrue(!!rN && !!sN && !!iN, `三份文档都应有域数声称(实测 README=${rN} SKILL=${sN} IDENTITY=${iN})`);
    assertEqual(rN, sN, `README 写 ${rN} domains，SKILL.md 写 ${sN}`);
    assertEqual(rN, iN, `README 写 ${rN} domains，IDENTITY.md 写 ${iN} 大域`);
  });

  // ── 四、活体注入: 中文形态改错，审计必须报不一致 ────────
  test('活体验证: IDENTITY.md 的"大域"数改错，审计必须报不一致', () => withDocLock(() => {
    const backupPath = '/tmp/aspira-identity-domains-probe.bak';
    const current = fs.readFileSync(IDENTITY, 'utf8');
    if (/分\s*7\s*大域/.test(current)) {
      try { const bak = fs.readFileSync(backupPath, 'utf8'); if (!/分\s*7\s*大域/.test(bak)) fs.writeFileSync(IDENTITY, bak); } catch (_) {}
    }
    const backup = fs.readFileSync(IDENTITY, 'utf8');
    fs.writeFileSync(backupPath, backup);
    try {
      const injected = backup.replace(/分\s*(\d+)\s*大域/, '分 7 大域');
      assertTrue(injected !== backup, '注入应改变文件内容');
      fs.writeFileSync(IDENTITY, injected);
      const out = runAudit();
      assertTrue(/不一致:\s*[1-9]/.test(out),
        '把 IDENTITY.md 的"大域"数改错时，审计必须报出不一致 —— ' +
        '否则这个中文形态只是另一个永远绿的装饰');
      assertTrue(/IDENTITY\.md/.test(out) && /大域|domains/.test(out),
        '审计的不一致项必须点名 IDENTITY.md 的域数');
    } finally {
      fs.writeFileSync(IDENTITY, backup);
      const verify = fs.readFileSync(IDENTITY, 'utf8');
      if (/分\s*7\s*大域/.test(verify)) {
        throw new Error('恢复失败: IDENTITY.md 仍含探针值，请执行 git checkout -- IDENTITY.md');
      }
    }
    const after = runAudit();
    assertTrue(/不一致:\s*0/.test(after), '恢复 IDENTITY.md 后审计应重新全绿');
  }));
};
