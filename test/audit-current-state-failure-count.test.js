/**
 * test/audit-current-state-failure-count.test.js
 *
 * [doc-honest-numbers·第二百一十九轮] 新建。
 *
 * ═══ 怎么找到这个缺陷的 ═══
 * 审计全绿(98 声称 / 93 一致 / 0 不一致)。本轮问的是 cycle 8 的机械穷举在
 * **当前文档集**上的重跑: 把每条"可审形态"按类别归账, 看未覆盖的那 673 条
 * 由什么构成。归类后最大一簇是 README 更新日志的历史行(正确不审), 但剩下
 * 44 条无法归类, 其中一条是 CURRENT_STATE.md 的 "0 failed"。
 *
 * 追下去发现的是**同一句话里的另一半**:
 *   CURRENT_STATE.md 抬头: "status running, 132 modules, 2291 tests passed / 0 failed"
 *   · `132 modules`       → 受审(modules key)
 *   · `2291 tests passed` → 受审(散文模式, 那条模式的注释引用的完整形态
 *                           就是 "N tests passed / 0 failed")
 *   · `0 failed`          → **从未受审** —— 正则读到 passed 就停
 *
 * 而 testsFailed 那条模式是 /(\d[\d,]*)\s+failing/g, 只读 "failing";
 * README 与 SKILL 的表格行写 "0 failing"(受审), CURRENT_STATE.md 写
 * "0 failed"(不受审)。**同一个数字在第二份文档里换了措辞, 就成了审计的盲区**
 * —— cycle 164 的 IDENTITY.md「分 7 大域」同形, 这次落在失败数上: 三处文档
 * 里唯一没人核对的那一处, 正是读者来"看当前状态"的那一份。
 *
 * 旁证: test/audit-unlocked-measurements.test.js 第 25 行的注释从 cycle 11 起
 * 就写着 "README/SKILL/CURRENT_STATE 三处的 '0 failing'" —— 而 CURRENT_STATE.md
 * 从来写的是 "0 failed"。**一条描述覆盖面的注释, 从写下起就不成立。**
 *
 * ═══ 为什么不能放宽成裸 "N failed" ═══
 * 实测: 放宽后在 AGENTS.md 的周期史里引入几十条假声称
 * ("run-all 1395 → 1399 with 0 failures" 等), 是 cycle 141/205 量过的净负。
 * 故按**整句**收窄: "N tests passed / M failed" 在全仓已扫文档实测只命中
 * 1 处(就是 CURRENT_STATE.md 抬头), 与现有 failing 模式的作用域不重叠。
 *
 * ═══ 本锁钉什么 ═══
 * ① 审计必须认出 CURRENT_STATE.md 的失败数声称, 且值必须是 **0 而不是 2291**
 *    (证明模式匹配上了, 且第一捕获组取的是失败数——claims() 只取 mm[1]);
 * ② 源级: 模式必须锚在整句形态上, 且不得退化成裸 "N failed";
 * ③ 加了这条模式后审计仍须 0 不一致(不许把假声称带进来);
 * ④ 反向证明: 把新模式从副本里删掉, ① 的声称必须消失;
 * ⑤ 披露: 失败数现有的声称站点都必须还在(少一个就说明又漂了)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
  const { withDocLock } = require(path.join(__dirname, '_doc-probe-lock.js'));
  const { execFileSync } = require('child_process');

  function runAudit(scriptPath) {
    try {
      return execFileSync('node', [scriptPath || SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
      });
    } catch (e) {
      // [第二十二轮] 审计退出码承载结论, execFileSync 对非零退出抛异常,
      // 而 stdout 在失败时依然可读 —— 从 e.stdout 取回。
      return (e.stdout || '').toString();
    }
  }
  function mismatchCount(out) {
    const m = out.match(/不一致: (\d+)/);
    return m ? Number(m[1]) : -1;
  }
  // 剥行注释后再做源级匹配 —— 本轮修复注释里引用了旧形态的原文,
  // 不剥就会把自己的注释当成罪行(cycle-19/25/194/195/197/214 形状)。
  function srcNoComments() {
    return fs.readFileSync(SCRIPT, 'utf8')
      .split('\n').map(l => l.replace(/\/\/[^\n]*$/, m => ' '.repeat(m.length))).join('\n');
  }
  // 源码里那一行的字面文本(双反杠在单引号字符串里落成单反杠)
  const NEEDLE = 'tests?\\s+passed\\s*\\/\\s*)(\\d[\\d,]*)\\s+failed';

  // ── ① 失败数声称必须被认出, 且捕获组必须取失败数 ──────────────
  test('审计必须认出 CURRENT_STATE.md 抬头的失败数, 且取的是失败数不是通过数', () => withDocLock(() => {
    const out = runAudit();
    assertTrue(/CURRENT_STATE\.md 声称「failing tests \(失败数, CURRENT_STATE 抬头\) = 0」/.test(out),
      '审计没有认出 CURRENT_STATE.md 抬头的失败数声称 —— 那一半仍然不受审。\n'
      + '无法实测清单:\n' + (out.split('无法自动实测')[1] || '(无)').split('\n').slice(0, 8).join('\n'));
    // 关键: 值必须是 0。若第一捕获组错取成通过数, 这里会读到 2291 ——
    // claims() 只取 mm[1], 所以捕获组位置是本改动唯一的结构性风险。
    assertTrue(!/CURRENT_STATE 抬头\) = 2291/.test(out),
      '失败数声称的值是 2291(通过数) —— 第一捕获组取错了, 审的是另一个数字');
  }));

  // ── ② 源级: 必须锚在整句形态, 不得退化成裸 "N failed" ─────────
  test('源级: 失败数模式必须锚在整句形态上', () => {
    const src = srcNoComments();
    assertTrue(src.includes(NEEDLE),
      '源码里找不到 "N tests passed / M failed" 整句形态的失败数模式');
    // 不得退化成裸 "N failed": 实测那样会在 AGENTS.md 周期史里引入几十条假声称
    const bad = src.split('\n').filter(l => /re:\s*\//.test(l)
      && /\\s\+failed/.test(l) && !/passed/.test(l));
    assertEqual(bad.length, 0,
      '出现了不锚在 passed 上的 "N failed" 模式 —— 它会把 AGENTS.md 的周期史误判成当前声称');
    // 前提自证: 剥注释没把真代码剥掉(否则上面两条恒真)
    assertTrue(/const pats = \[/.test(src) && /key: 'testsFailed'/.test(src),
      '剥注释把真代码也剥掉了 —— 本源级断言已空转');
  });

  // ── ③ 不许把假声称带进来 ────────────────────────────────────
  test('加了这条模式后审计仍须 0 不一致', () => withDocLock(() => {
    const out = runAudit();
    assertEqual(mismatchCount(out), 0,
      '新增失败数模式后出现了不一致项 —— 它匹配到了不该审的文本:\n'
      + (out.split('❌ 与实测不符')[1] || '').split('\n').slice(0, 6).join('\n'));
  }));

  // ── ④ 反向证明: 删掉新模式, 声称必须消失 ─────────────────────
  test('反向证明: 删掉整句模式后, CURRENT_STATE 的失败数声称必须消失', () => withDocLock(() => {
    const orig = fs.readFileSync(SCRIPT, 'utf8');
    const start = orig.indexOf('// ── [doc-honest-numbers·第二百一十九轮] 同一句话里的另一半 ──');
    const blockStart = orig.indexOf('      {', start);
    assertTrue(start > 0 && blockStart > start, '源码里找不到新模式块 —— 锚点已变, 本反向证明无效');
    const blockEnd = orig.indexOf('\n      },', blockStart) + '\n      },'.length;
    assertTrue(blockEnd > blockStart, '找不到新模式块的收束 —— 锚点已变');
    const broken = orig.slice(0, start) + orig.slice(blockEnd);
    assertTrue(broken !== orig && !broken.includes('第二百一十九轮] 同一句话里的另一半'),
      '变异未生效 —— 锚点没匹配上, 本次反向证明无效');
    const tmp = path.join(ROOT, 'scripts', '_audit-broken-219.tmp.js');
    fs.writeFileSync(tmp, broken);
    try {
      const out = runAudit(tmp);
      assertTrue(!/CURRENT_STATE 抬头\) = 0/.test(out),
        '删掉整句模式后审计仍认出该声称 —— 说明认出它的不是这条模式, 反向证明无效');
      // 反向对照: 同一次运行里 README 表格行的失败数声称必须**仍然**在,
      // 否则"消失"可能只是因为副本整个跑失败了(cycle 216 的反向控制)。
      assertTrue(/README\.md 声称「failing tests \(失败数\) = 0」/.test(out),
        '副本跑失败了或 README 的失败数声称也消失了 —— 反向证明的对照不成立');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }));

  // ── ⑤ 披露: 失败数的声称站点都必须还在 ───────────────────────
  test('披露: 失败数的声称站点都必须仍在受审', () => withDocLock(() => {
    const out = runAudit();
    const sites = [
      /README\.md 声称「failing tests \(失败数\) = 0」/,
      /SKILL\.md[^\n]*failing tests/,
      /CURRENT_STATE\.md 声称「failing tests \(失败数, CURRENT_STATE 抬头\) = 0」/,
    ];
    // SKILL.md 的表格行也写 "0 failing", 但它另有一条历史读数
    // "711 passing / 1 failing (was 546)" 由 reject 排除, 故这里只硬性要求
    // 两处: README 表格 + CURRENT_STATE 抬头。少一处就说明又漂了。
    const found = sites.filter(r => r.test(out)).length;
    assertTrue(found >= 2,
      `失败数声称只认出 ${found} 处(应至少 README 表格 + CURRENT_STATE 抬头) —— 有站点漂走了`);
    // 前提自证: SKILL.md 确实写着失败数(否则上面这条门槛可能恒真)
    const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
    assertTrue(/\d[\d,]*\s+passing\s*\/\s*\d[\d,]*\s+failing/.test(skill),
      'SKILL.md 不再写 "N passing / N failing" —— 本披露的前提已变, 请更新');
  }));

  // ── ⑥ 本轮顺带修掉的类别缺陷: 中文规模模式必须带 reject ─────────
  test('源级: 中文规模模式必须带 reject(大域 曾是唯一漏网的)', () => {
    const src = srcNoComments();
    // 五条中文形态的规模模式里, `大域` 是唯一没有 reject 的 —— 后果实测:
    // 本轮 AGENTS.md 条目为了引用 cycle 164 的旧缺陷写了「分 7 大域」,
    // 审计把它当成"引擎声称 7 个能力域"对实测 8 报不一致, 同一条 mismatch
    // 把 19 个审计族测试全染红。
    const at = src.indexOf('\\s*大域/g');
    assertTrue(at > 0, '源码里找不到 `N 大域` 模式 —— 锚点已变, 本条的前提不成立');
    const seg = src.slice(at, at + 260);
    assertTrue(/reject:/.test(seg),
      '`N 大域` 模式仍不带 reject —— AGENTS.md 的周期史一旦引用旧的大域数, '
      + '就会制造一条当前声称(本轮实测: 19 个审计族测试被同一条 mismatch 染红)');
    // 前提自证: 窗口里必须同时有 key: 'domains'(证明窗口落在该模式对象内)
    assertTrue(/key:\s*'domains'/.test(seg), '窗口里没有 key: \'domains\' —— 窗口切错了, 本条已空转');
  });
};
