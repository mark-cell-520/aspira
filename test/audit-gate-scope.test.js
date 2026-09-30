/**
 * test/audit-gate-scope.test.js — 闸门的作用域: 别让自述文档的首页声称被吃掉
 *
 * ═══ 由来 ═══
 * 连续第九轮 doc-honest-numbers。前两轮的角度:
 *   第七轮  人工提问「全绿里有没有没被测量的」→ domains
 *   第八轮  机械化穷举「文档有哪些数字形态」  → benign/malicious
 *
 * 本轮换**第三个角度**，不问文档，问审计自己:
 *   **「审计自己的哪条规则永远不可能放行?」**
 *
 * ═══ 实测发现: README 首页摘要行整体不受审计 ═══
 * 拿 README 首页那行做探针:
 *   ```
 *   54 discrimination dimensions  ×  17-layer pipeline*  ×  132 modules
 *   ×  181 MCP tools  ×  1,510 dispatch routes  ×  1216 passing tests
 *   ×  0 runtime dependencies
 *   ```
 * 逐数字跑闸门，结果是:
 *   "0 runtime dependencies"        key=deps   ❌ 被 selfRef 排除
 *   "1216 passing tests"(散文形态)  key=tests  ❌ 被 selfRef 排除
 * 而同一份文档表格里的 "| Test suite | 1216 passing" 却 ✓ 纳入核对。
 *
 * 原因: selfRef 只在数字**之前**的文本里找
 * aspira|新愿|heartflow|引擎|本仓库|判别|discriminator。
 * 首页那行上下文里一个都没有——**它当然没有:
 * README 就是引擎在描述自己，不必在自己家里喊自己的名字。**
 *
 * 于是**全仓库最显眼的一行声称，七个数字全部不受审计**，
 * 包括「零运行时依赖」这条头条设计原则。
 *
 * ═══ 这与第 29 次失效同族，但更严重 ═══
 * 第 29 次是一条模式被 selfRef 吃掉;
 * 这次是**一整类文档(引擎自述)被系统性排除**。
 * 报 53/53 全绿只说明「它知道的那 53 条没错」。
 *
 * ═══ 修法: 收窄 selfRef 的作用域，而不是删掉它 ═══
 * selfRef 是为**子目录**文档加的——通用规范、案例描述、升级示例里的
 * 数字不是引擎规模。顶层自述文档(README/SKILL/AGENTS/IDENTITY/
 * CURRENT_STATE)的存在目的就是描述本引擎，其中的规模声称
 * **按构造**就是在说 aspira。
 *
 * ═══ 然后第二层闸门: 作用域计数 ═══
 * 放宽 selfRef 后，自述文档里大量**局部计数**立刻涌进来:
 *   "Never `require` a Tier-2 module at the top of `heartflow.js`"
 *   "At low effort only tier 1 modules run"
 *   "11 refs across 8 modules"
 * 它们都在说 aspira，但说的不是 aspira 的**总量**。
 * notScoped 回答第二问: 数字前紧邻作用域词(tier/across/only/each/...)
 * 时，它是局部量而非清单规模。
 *
 *   selfRef   回答「这条声称在说 aspira 吗」
 *   notScoped 回答「它在说 aspira 的**总量**吗」
 *
 * ═══ 本测试锁什么 ═══
 * ① selfRef 对引擎自述文档必须放行(首页摘要行不得再被吃掉)
 * ② 围栏内的散文形态测试数声称必须受审(活体注入)
 * ③ 围栏内的「零运行时依赖」必须受审(活体注入)
 * ④ 作用域计数不得被当成总量(当前文档里就有三类，审计必须 0 不符)
 * ⑤ 历史测量值("Measured on N")不得当成当前声称
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const README = path.join(ROOT, 'README.md');

const { withDocLock } = require('./_doc-probe-lock.js');

module.exports = function ({ test, assertTrue, assertEqual }) {

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
    const m = out.match(/与实测一致:\s*(\d+)\s*\|\s*不一致:\s*(\d+)/);
    return m ? Number(m[2]) : -1;
  }
  // ── [第十二轮] 靶向断言: 只看**不符清单里有没有我这条闸门该拦住的东西** ──
  // 原先两条回归锁写的是 assertEqual(mismatchCount(out), 0)，注释里
  // 自陈"「当前文档 0 不符」就是 notScoped 的回归锁"。
  // 那句话在第十二轮被证伪了: 我新增 formulas 模式后，三处文档
  // (INSTALL 2397 / CURRENT_STATE 1286 / formulas-README 382)对实测 608
  // 确实不符，于是这两条测试立刻变红——而失败信息指向 notScoped /
  // inCodeSpan，真因却是"别处的文档数字写错了"。
  // 这正是本仓库反复记载的误导形状: **失败信息指向一个与真因无关的断言**。
  // 把"全局 0 不符"当成"我的闸门有效"的代理，等于让每一次新增合法键
  // 都能把无关测试打红。改成靶向: 不符清单里不得出现我这条闸门
  // 负责拦住的那几句。notScoped 真被删掉时它们会立刻出现，锁依然有效，
  // 但不再被无关的文档错误误伤。
  function mismatchedLines(out) {
    const seg = out.split('❌ 与实测不符')[1] || '';
    return seg.split('\n').filter(l => l.includes('声称'));
  }
  function claimedTotal(out) {
    const m = out.match(/文档声称总数:\s*(\d+)/);
    return m ? Number(m[1]) : -1;
  }

  test('selfRef 必须对引擎自述文档放行', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/SELF_DESC_DOCS/.test(src) && /SELF_DESCRIPTION_DOC/.test(src),
      '必须有自述文档集合与作用域标志');
    assertTrue(/if \(SELF_DESCRIPTION_DOC\) return null;/.test(src),
      'selfRef 在自述文档里必须直接放行——README 首页摘要行'
      + '上下文没有任何自指词(它不必在自己家里喊自己的名字)，'
      + '否则「零运行时依赖」等头条声称整体不受审计');
    for (const d of ['README.md', 'SKILL.md', 'AGENTS.md', 'IDENTITY.md', 'CURRENT_STATE.md']) {
      assertTrue(src.includes("'" + d + "'"), '自述文档集合应含 ' + d);
    }
  });

  test('自述文档标志只对顶层文件生效', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/!f\.includes\(path\.sep\)\s*&&\s*SELF_DESC_DOCS\.has\(f\)/.test(src),
      '必须限定顶层——子目录里的 README.md 是该技能的说明，不是本引擎自述');
  });

  test('围栏内的散文测试数声称必须被识别', () => withDocLock(() => {
    // README 首页那行在代码围栏内，且形态是 "N passing tests"
    // (形容词在前)，与 "N tests passing" 词序相反——
    // 这是**三重不可见**叠加: 围栏 + 词序不匹配 + selfRef。
    //
    // ⚠️ 这里断言的是「被识别」，不是「注入后变红」。
    // 测试数声称的实测值来自跑 run-all，而在 run-all 内部再跑审计
    // 会**无限递归**(审计→run-all→本测试→审计→...)。
    // 故用 ASPIRA_AUDIT_SKIP_TESTS=1，此时 m.tests=null，
    // 该声称落入「无法实测」而非「不符」——探针的已知代价，
    // 与第八轮记录的 ASPIRA_AUDIT_SKIP_TESTS 伪影同性质。
    //
    // 「变红」这一面由下面两条注入测试(modules / deps)覆盖:
    // 它们同样在围栏内的首页摘要行，同样曾被 selfRef 整行吃掉。
    const backup = fs.readFileSync(README, 'utf8');
    try {
      const out0 = runAudit();
      const before = (out0.match(/README\.md 声称「passing tests \(词序反转\) = (\d+)」/) || [])[1];
      assertTrue(!!before,
        '审计必须识别 README 首页的 "N passing tests" 形态——'
        + '词序反转(形容词在前)曾使它匹配不上任何模式');
      const table = backup.match(/\|\s*Test suite\s*\|\s*([\d,]+)\s+passing/);
      assertTrue(!!table, 'README 应有 Test suite 表格行');
      assertEqual(Number(before.replace(/,/g, '')), Number(table[1].replace(/,/g, '')),
        '首页摘要行的测试数必须与表格行一致');
      const wrong = backup.replace(/(\d[\d,]*)\s+passing\s+tests/, '9999 passing tests');
      assertTrue(wrong !== backup && /9999 passing tests/.test(wrong), '注入应只改数字');
      fs.writeFileSync(README, wrong);
      const out1 = runAudit();
      assertTrue(/README\.md 声称「passing tests \(词序反转\) = 9999」/.test(out1),
        '注入 9999 后该声称必须仍被识别为 tests 声称');
    } finally {
      fs.writeFileSync(README, backup);
      if (!/passing tests/.test(fs.readFileSync(README, 'utf8'))) {
        throw new Error('恢复失败: README.md 首页摘要行异常，请 git checkout -- README.md');
      }
    }
  }));

  test('围栏内的「零运行时依赖」必须受审', () => withDocLock(() => {
    const backup = fs.readFileSync(README, 'utf8');
    try {
      const injected = backup.replace('0 runtime dependencies', '9 runtime dependencies');
      assertTrue(injected !== backup, '注入应改变文件内容');
      fs.writeFileSync(README, injected);
      const out = runAudit();
      assertTrue(mismatchCount(out) >= 1,
        '「零运行时依赖」是头条设计原则，改写它必须被报为不符');
      assertTrue(/runtime dependenc/.test(out), '审计应把该行纳入 deps 核对');
    } finally {
      fs.writeFileSync(README, backup);
      if (!/0 runtime dependencies/.test(fs.readFileSync(README, 'utf8'))) {
        throw new Error('恢复失败: README.md 首页摘要行异常，请 git checkout -- README.md');
      }
    }
  }));

  test('围栏内的引擎规模声称必须能变红', () => withDocLock(() => {
    // 「变红」这一面: 首页摘要行里的 modules 声称曾被 selfRef 整行吃掉。
    // 注入一个错值，审计必须报不符——这证明该行不再被静默跳过。
    const backup = fs.readFileSync(README, 'utf8');
    try {
      const target = backup.match(/(\d[\d,]*)\s+modules/);
      assertTrue(!!target, 'README 首页应有 "N modules" 形态');
      const wrong = backup.replace(target[0], '131 modules');
      fs.writeFileSync(README, wrong);
      const out = runAudit();
      assertTrue(mismatchCount(out) >= 1,
        '首页摘要行的 modules 声称写错必须被报为不符——'
        + 'selfRef 曾把整行吃掉(七个数字全部不受审计)');
    } finally {
      fs.writeFileSync(README, backup);
      if (!/\b132 modules\b/.test(fs.readFileSync(README, 'utf8'))) {
        throw new Error('恢复失败: README.md 首页摘要行异常，请 git checkout -- README.md');
      }
    }
  }));

  test('作用域计数不得被当成引擎总量', () => withDocLock(() => {
    // ⚠️ 必须持 doc-probe 锁: 本测试 spawn 审计，而并发下
    // audit-domains-blindspot 等测试正在往 README/AGENTS 注入探针。
    // 不持锁就会读到别人的探针，把假阳性当成 notScoped 失效——
    // **这正是第 56 轮修掉的并发缺陷，我这一轮又犯了一次**:
    // 直接跑 8/8 全过，run-all 里 1 失败，而失败信息指向一个
    // 与真因无关的断言。一个 spawn 审计的测试若忘了持锁，
    // 它会在并发下报告一个并不存在的问题。
    //
    // 当前文档里就有三类作用域计数(实测):
    //   AGENTS.md  "Never `require` a Tier-2 module at the top of heartflow.js"
    //   SKILL.md   "At low effort only tier 1 modules run"
    //   SKILL.md   "11 refs across 8 modules"
    // 若 notScoped 被移除，这三条会立刻变成"不符"。
    // 所以「当前文档 0 不符」就是 notScoped 的回归锁。
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/function notScoped/.test(src) && /SCOPED_BEFORE/.test(src),
      '必须有作用域闸门');
    assertTrue(/notScoped\(s, mm\.index\)/.test(src),
      'notScoped 必须在 claims() 的匹配循环里生效');
    const out = runAudit();
    const bad = mismatchedLines(out);
    assertTrue(!bad.some(l => /Tier-2 module|tier 1 modules|across 8 modules/.test(l)),
      '当前文档里的 "Tier-2 module" / "tier 1 modules" / "across 8 modules" '
      + '都不得被当成引擎总量——它们都在说 aspira，但说的不是 aspira 的总量。'
      + '(靶向断言: 只查这些短语有没有进不符清单，**不断言全局 0 不符**——'
      + '第十二轮实测: 新增 formulas 模式后三处文档数字确实写错(2397/1286/382 vs 实测 608)，'
      + '全局 0 不符立刻把这条测试打红，而失败信息指向 notScoped，真因在别处。'
      + '一个用"全局绿"当代理的回归锁，会被每一次新增合法键误伤。)');
  }));

  test('历史测量值不得当成当前声称', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/measured on/.test(src),
      'NARRATIVE 必须认 "Measured on N ..." —— 那是过去的实测读数，'
      + '不是当前声称(AGENTS.md 讲述上轮仪器缺陷时引用了 102 benign)');
  });

  test('行内代码跨度内的数字是被引用的字面量，不是当前声称', () => withDocLock(() => {
    // 本轮修复后，AGENTS.md 用行内代码引用修复前的旧读数:
    //   "the docs write `1216 passing tests` ..."
    //   "(`| Test suite | 1216 passing`) was audited"
    // 形状与当前声称完全一致，于是被报成不符。
    //
    // 两个实现陷阱(都实测踩到):
    // ① 首版把检查放在 narrativeQuote 里，而**表格模式不带 reject**，
    //    永远走不到——一个正确的判据放错了地方等于没有。
    // ② 按**行**数反引号: 该引用在源码里被折行，开引号在上一行，
    //    数出来是 0(偶数)而漏掉。必须跨行数。
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/function inCodeSpan/.test(src), '必须有 inCodeSpan 判据');
    assertTrue(/inCodeSpan\(s, mm\.index\)/.test(src),
      'inCodeSpan 必须在 claims() 匹配循环里对**所有**模式生效——'
      + '文本属性不是某条模式的调优，放在 reject 里会让不带 reject 的'
      + '表格模式永远走不到');
    assertTrue(/text\.slice\(0, at\)\.replace/.test(src),
      '必须跨行计数并先剥掉围栏定界行——否则围栏里的 ``` 会翻转奇偶性');
    const out = runAudit();
    const bad = mismatchedLines(out);
    // AGENTS.md 里引用的旧读数形如 `1216 passing tests` / `| Test suite | 1216 passing`。
    // inCodeSpan 失效时它们会以"声称…= 1216"的形态进不符清单。
    assertTrue(!bad.some(l => /= 1216|= 1210|= 1227|= 1233/.test(l)),
      'AGENTS.md 里对修复前状态的引用不得被当成当前声称'
      + '(靶向断言: 只查这些历史读数有没有进不符清单，不断言全局 0 不符——'
      + '同第十二轮 formulas 一例: 全局 0 不符这个代理会被别处的文档错误误伤)');
  }));

  test('恢复后 README 无注入残留', () => {
    const s = fs.readFileSync(README, 'utf8');
    assertTrue(!/9999/.test(s), 'README.md 不得残留 9999 注入');
    assertTrue(!/9 runtime dependencies/.test(s), 'README.md 不得残留 9 runtime dependencies 注入');
    assertTrue(/0 runtime dependencies/.test(s), 'README.md 应仍有「零运行时依赖」声称');
    assertTrue(/passing tests/.test(s), 'README.md 应仍有 passing tests 声称');
  });
};
