/**
 * test/audit-dead-pattern-selfcheck.test.js — 写在 pats 里却永远空转的 pattern 必须被报出来
 *
 * [doc-honest-numbers·第一百六十五轮] 新建。
 *
 * ═══ 缺口 ═══
 * 审计的 `claims()` 维护一份 pattern 表(pats)，每条 pattern 期望在文档里匹配到
 * 某个规模级声称。但如果一条 pattern **在所有文档都匹配不到**，它看起来在检查，
 * 实际永远空转 —— 而全绿报告里它与真在工作的 pattern 无法区分。
 *
 * 这与 cycle 154 记录的 "measured but no pattern" 是同一形状的**反面**:
 *   · cycle 154: 有测量值，但没有 pattern 去读文档里的声称
 *   · 本轮:     有 pattern，但文档里没有任何形态让它匹配
 * 两者共同后果: **pats 表的表面覆盖比真实覆盖更全**，读者无法从 87/87 里看出
 * 哪几条是真在干活。
 *
 * 本轮实测(重跑 cycle 8 穷举枚举后)有 6 条死 pattern:
 *   MCP tools (中文) / dispatch routes (中文) / pipeline layers (中文) /
 *   tests (中文) / tests passing (英文复数容忍) / module init errors (散文)
 * 它们全是"为不存在的形态而写"的防御性 pattern: 文档实际不用"个 MCP 工具"这种
 * 中文措辞；表格形态的数字在标签之后(`| Module init errors | 0 |`)，而散文模式
 * 要求数字在前("0 init errors")。
 *
 * ═══ 修法 ═══
 * 不删这些 pattern(删掉就丢了将来的防线 —— IDENTITY.md 的"分 7 大域"正是中文
 * 形态漂移而英文 pattern 抓不到，见第一百六十四轮)，而是把它们**报出来**:
 * 审计输出里新增一段"⚠️ 死 pattern N 条"，列出名字与原因。
 *
 * ═══ 本轮踩的坑(值得单独记) ═══
 * 首版按**文档**判死，报出 **49 条**。原因是 pats 是全局列表——每份文档都跑同一份
 * pattern 表，于是一条只在 SKILL.md 出现过的 pattern(`dimensions (表格)`)会在其余
 * 200+ 份文档里 0 匹配，被算成死。改成按 **what 聚合总匹配数、总数 0 才算死**
 * 之后，49 → 6，与第一百六十四轮用独立探针量出的 7 条(其中一条已被更早加的中文
 * domains pattern 覆盖)对上了。
 * 这是本仓库反复记录的形状: **一个按错误粒度聚合的统计，会把局部的 0 放大成
 * 全局的 0** —— 与 cycle 11/16 的"仪器报自己的局限为引擎缺陷"同族。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
const { execFileSync } = require('child_process');
const { withDocLock } = require('./_doc-probe-lock.js');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');

  function runAudit() {
    try {
      return execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' }, timeout: 300000,
      });
    } catch (e) { return (e.stdout || '').toString(); }
  }

  // ── 一、源级: 必须统计并报出死 pattern ──────────────────
  test('源级: 审计必须统计死 pattern 并在报告里报出', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assertTrue(/HITS\.set\(/.test(src) || /_nMatch/.test(src),
      '审计必须统计每条 pattern 真的匹配到几次(否则死 pattern 不可见)');
    assertTrue(/out\.dead\s*=/.test(src), 'claims() 必须把死 pattern 挂到返回值上');
    assertTrue(/死 pattern/.test(src), '报告层必须打印死 pattern 段落');
    // 判据必须是**总数**为 0，不能按文档判
    assertTrue(/n\s*===\s*0/.test(src),
      '死 pattern 的判据必须是"全部文档总匹配数为 0" —— 按文档判会把只在 SKILL.md ' +
      '出现过的 pattern 算成死(本轮实测 49 条假阳性)');
  });

  // ── 二、行为: 审计输出里必须真的出现死 pattern 段落 ────
  test('行为: 审计输出必须包含死 pattern 段落', () => withDocLock(() => {
    const out = runAudit();
    assertTrue(/死 pattern/.test(out),
      '审计输出里没有"死 pattern"段落 —— 自检没接上(不删 pattern 可以，但必须报出来)');
    const m = /死 pattern (\d+) 条/.exec(out);
    assertTrue(!!m, '死 pattern 段落应带数量');
    assertTrue(Number(m[1]) >= 1,
      `死 pattern 应 >= 1 条(当前 6 条)，实测 ${m ? m[1] : '?'} —— ` +
      '若为 0，说明文档形态变了或 pattern 被删，请复核后更新本测试');
    // 不得退化成"49 条"那种按文档聚合的假阳性
    assertTrue(Number(m[1]) <= 15,
      `死 pattern 报出 ${m[1]} 条，超过 15 条 —— 判据可能退化成"按文档判死"了` +
      '(pats 是全局列表，按文档判会把只在 SKILL.md 出现过的 pattern 算成死)');
  }));

  // ── 三、已知的 6 条死 pattern 必须仍在列表里 ───────────
  test('已知的 6 条死 pattern 必须仍被报出(防被静默删除)', () => withDocLock(() => {
    const out = runAudit();
    const KNOWN = [
      'MCP tools (中文)',
      'dispatch routes (中文)',
      'pipeline layers (中文)',
      'tests (中文)',
      'tests passing (英文复数容忍)',
      'module init errors (散文)',
    ];
    const missing = KNOWN.filter(k => !out.includes(k));
    assertEqual(missing.join(', '), '',
      `以下已知死 pattern 不再被报出 —— 它们被删了? 若确实删，请同步更新本测试:\n  ${missing.join('\n  ')}`);
  }));
};
