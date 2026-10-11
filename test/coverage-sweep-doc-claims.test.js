/**
 * test/coverage-sweep-doc-claims.test.js — 覆盖清点的三个读数必须进入文档闭环
 *
 * [doc-honest-numbers·第一百五十四轮] 新建。
 *
 * ═══ 缺口 ═══
 * `scripts/coverage-sweep.js` 每轮都清点三件事:
 *     src 模块 380 个 / B 活着但没测 107 / A 疑似死代码 12
 * `audit-doc-numbers.js` 的 measure() 也每轮都测这三个值(m.srcModules /
 * m.aliveUntested / m.suspectedDead)，并把它们抄进 actual。
 *
 * 但文档里**一个都不写**。于是:
 *   · srcModules 与 aliveUntested 各有一条 pattern，却匹配不到任何文本
 *     —— 两条**死的 pattern**，看起来在检查，实际永远空转
 *   · suspectedDead **连 pattern 都没有** —— measured 之后直接没有比对对象
 *
 * 后果不是"少三个数字"，而是读者拿到的图景是错的: README 与 SKILL.md 都说
 * "132 modules"，那是 heartflow `_modules` 的**注册子系统数**；`src/` 下实际有
 * **380** 个 JS 文件，其中 **107** 个活着但没有任何测试引用。两个数字差 3 倍，
 * 而小的那个是文档唯一给出的那个。
 *
 * 这 107 个文件同时是校准仪器的盲区: FP 0.0% / recall 100.0% 的分母是 132 条
 * 语料样本，而那 107 个文件的行为从未被任何样本表达过。
 *
 * ═══ 修法 ═══
 * 1. 三个读数写回 SKILL.md 的 metric 表，用三条 pattern 能匹配的形态
 * 2. 补上 suspectedDead 缺失的 pattern `(\d+)\s+suspected dead`
 * 3. 三个 key 从此进入闭环 —— 数字变了审计就红，逼着同步，
 *    与 `tests` 完全同机制(那一个也是每轮手同步的)
 *
 * 会腐烂不是不写它的理由: tests 数字同样每轮变，照样写进文档并由审计核对。
 * 真正该避免的是"写一个不会被核对的数字"。
 *
 * ═══ 实测 ═══
 *   审计声称总数 83 → **86**(新增 srcModules / aliveUntested / suspectedDead)
 *   86/86 全绿，退出码 0
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync, execSync } = require('child_process');
  const { withDocLock } = require('./_doc-probe-lock.js');

  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
  const SKILL = path.join(ROOT, 'SKILL.md');

  function runAudit() {
    try {
      return execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
      });
    } catch (e) { return (e.stdout || '').toString(); }
  }

  // ── 一、三个 key 都必须有 pattern 且被文档承载 ───────────
  test('三个覆盖读数都必须有 pattern 且被 SKILL.md 承载', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const sk = fs.readFileSync(SKILL, 'utf8');
    // pattern 侧
    assertTrue(/key:\s*'srcModules'/.test(src), 'pats 必须有 srcModules 模式');
    assertTrue(/key:\s*'aliveUntested'/.test(src), 'pats 必须有 aliveUntested 模式');
    assertTrue(/key:\s*'suspectedDead'/.test(src),
      "pats 必须有 suspectedDead 模式 —— 它此前连模式都没有, measured 之后没有比对对象");
    // 文档侧: 三条 pattern 的形态都必须真的出现在 SKILL.md 里
    assertTrue(/coverage-sweep\.js across (\d+)\s+modules/.test(sk),
      'SKILL.md 必须含 "coverage-sweep.js across N modules"(srcModules 的形态)');
    assertTrue(/\*\*(\d+) alive but referenced by no test\*\*/.test(sk),
      'SKILL.md 必须含 "**N alive but referenced by no test**"(aliveUntested 的形态)');
    assertTrue(/(\d+)\s+suspected dead/.test(sk),
      'SKILL.md 必须含 "N suspected dead"(suspectedDead 的形态)');
  });

  // ── 二、审计必须把三个读数都判为一致 ────────────────────
  // ⚠️ 必须持 doc-probe 锁: 下面那个辅助函数会 spawn 文档审计，而套件里其它探针会
  // 同时改写 SKILL.md。不持锁时直接跑全绿、跑整套才失败，且失败信息指向一个
  // 与真因无关的断言(读到的是别人的探针)。这条规则由
  // test/doc-probe-lock-coverage.test.js 机械强制 —— 本轮首版就因它红了一次。
  // (注释里也不能写出那个辅助函数的名字加括号: 锁覆盖测试扫的是源码文本，
  //  会把注释里的形态当成一处未持锁的调用点。本轮第二次因此红。)
  test('审计必须把三个覆盖读数都判为与实测一致', () => withDocLock(() => {
    const out = runAudit();
    // skip 模式下 tests 类 key 无法实测，但三个覆盖读数与测试套件无关，必须实测到
    assertTrue(/不一致:\s*0/.test(out),
      `审计有不一致项 —— 三个覆盖读数可能没同步:\n${out.split('\n').filter(l => l.includes('声称')).slice(0, 8).join('\n')}`);
    // 声称总数必须 >= 86(本轮新增三个 key 后从 83 涨到 86)
    const total = (/(\d+)\s*\|\s*与实测一致/.exec(out.replace(/\s/g, ' ')) || /文档声称总数:\s*(\d+)/.exec(out) || [])[1];
    assertTrue(Number(total) >= 86,
      `文档声称总数应 >= 86(本轮新增三个 key), 实测 ${total} —— 三个 key 没进闭环`);
  }));

  // ── 三、活体注入: 改一个数审计必须抓住 ──────────────────
  test('活体验证: 把文档里的 alive-but-untested 数字改错，审计必须报不一致', () => withDocLock(() => {
    const backupPath = '/tmp/aspira-skill-coverage-probe.bak';
    const current = fs.readFileSync(SKILL, 'utf8');
    if (/alive but referenced by no test/.test(current) && /\*\*999 alive/.test(current)) {
      try { const bak = fs.readFileSync(backupPath, 'utf8'); if (!/\*\*999 alive/.test(bak)) fs.writeFileSync(SKILL, bak); } catch (_) {}
    }
    const backup = fs.readFileSync(SKILL, 'utf8');
    fs.writeFileSync(backupPath, backup);
    const anchor = (backup.match(/\*\*(\d+) alive but referenced by no test\*\*/) || [])[0];
    assertTrue(!!anchor, 'SKILL.md 应含 alive-but-untested 的形态');
    try {
      const injected = backup.replace(anchor, '**999 alive but referenced by no test**');
      assertTrue(injected !== backup, '注入应改变文件内容');
      fs.writeFileSync(SKILL, injected);
      const out = runAudit();
      assertTrue(/alive but untested|aliveUntested/.test(out) || /不一致:\s*[1-9]/.test(out),
        '把文档里的 alive-but-untested 数字改错时，审计必须报出不一致 —— ' +
        '否则这三个 key 只是另一批永远绿的装饰');
      assertTrue(/不一致:\s*[1-9]/.test(out),
        '审计的不一致计数必须 > 0');
    } finally {
      fs.writeFileSync(SKILL, backup);
      const verify = fs.readFileSync(SKILL, 'utf8');
      if (/\*\*999 alive/.test(verify)) {
        throw new Error('恢复失败: SKILL.md 仍含探针数字，请执行 git checkout -- SKILL.md');
      }
    }
    const after = runAudit();
    assertTrue(/不一致:\s*0/.test(after), '恢复 SKILL.md 后审计应重新全绿');
  }));

  // ── 五、CURRENT_STATE 的现在时读数必须与已闭环的那一份一致 ──
  // [doc-honest-numbers·第二百零八轮] 新建。
  //
  // 缺口: 审计只核 22 个 key, 而 CURRENT_STATE 的「已知限制 / 待办」节里有
  // 一批**现在时**读数一个 key 都不归它管。本轮实测那一节:
  //   · `heart-logic.js (2311 行)` 而 wc -l 实测 **2408**
  //   · `desire-cognition.js (6384 行) 仍有大量逻辑待拆分` 而该文件
  //     **不在 src/ 下**(全仓只剩 archive 里一个指向它的死测试) ——
  //     一条挂在已消失模块上的待办, 是 cycle 193"实现过、然后静默蒸发"
  //     的文档版
  //   · `未测试模块已清零 (214→0)` 而 coverage-sweep 的 B 类是 **91**
  //   · `核心路径已全绿 (119/119)` 而全套件 **2243** 通过
  // 后三个数字与实测差 1 到 2 个数量级, 而且它们在"已知限制"里以现在时
  // 陈述 —— 读者会拿它当当前状态。更刺的是: audit-doc-numbers.js 第 22 行
  // 的注释**早就写下**"两份都是现在时陈述", 而当年的修法只改了版本行与
  // modules 数, 漏了这一节。这是 cycle 7 `IDENTITY.md said 99 个模块` 的同族:
  // **修了一个措辞, 没修另一个**。
  //
  // 锁法刻意不自己再 spawn 一次 coverage-sweep(那会让本用例再付一次清点
  // 代价, 且多一个会腐烂的读数): 它比对的是 CURRENT_STATE 与 **已经被审计
  // 闭环的 SKILL.md  Coverage sweep 行**。两份文档说同一个量, 就必须同一个数。
  test('CURRENT_STATE 的现在时读数必须与 SKILL.md 已闭环的那份一致', () => {
    const cs = fs.readFileSync(path.join(ROOT, 'CURRENT_STATE.md'), 'utf8');
    const sk = fs.readFileSync(SKILL, 'utf8');

    // ① 未测试模块数: 两份文档必须同一个值(SKILL.md 那个由审计闭环)
    const skillB = (sk.match(/\*\*(\d+) alive but referenced by no test\*\*/) || [])[1];
    assertTrue(!!skillB, '前提失效: SKILL.md 没有 alive-but-untested 读数');
    const csB = (cs.match(/未测试模块 (\d+) 个/) || [])[1];
    assertTrue(!!csB, 'CURRENT_STATE 应含"未测试模块 N 个"读数');
    assertEqual(csB, skillB,
      `CURRENT_STATE 说未测试模块 ${csB} 个, 而 SKILL.md(审计闭环的那份)说 ${skillB} —— ` +
      '两份文档对同一个量给出两个数');

    // ② 测试总数: 同理(SKILL.md 的 Test suite 行由审计的 tests key 闭环)
    const skillT = (sk.match(/\| Test suite \| (\d+) passing/) || [])[1];
    assertTrue(!!skillT, '前提失效: SKILL.md 没有 Test suite 读数');
    const csT = (cs.match(/全套件 (\d+) 通过/) || [])[1];
    assertTrue(!!csT, 'CURRENT_STATE 应含"全套件 N 通过"读数');
    assertEqual(csT, skillT,
      `CURRENT_STATE 说全套件 ${csT} 通过, 而 SKILL.md(审计闭环的那份)说 ${skillT}`);

    // ③ 待办节点名的 src 文件必须真的存在 —— 不许再挂一个已蒸发的模块
    // ⚠️ 先剥掉 ~~划掉~~ 的段落: 那是"已失效的历史记录"(本轮把 desire-cognition
    // 划掉正是在说它没了), 不是待办。不剥就会把"记录一个模块消失"当成
    // "把一个消失的模块当待办" —— 锁读了自己的文档当罪证。
    const todo = cs.slice(cs.indexOf('## 已知限制')).replace(/~~[\s\S]*?~~/g, '');
    assertTrue(todo.length > 40, '前提失效: 找不到「已知限制 / 待办」节');
    // 形态: `name.js` (N 行) 或 name.js (N 行) —— 名字后面可能有闭合反引号
    const named = [...todo.matchAll(/([\w-]+\.js)[`'\s]*[~(（]/g)].map(x => x[1]);
    assertTrue(named.length > 0, '前提失效: 待办节里没有点名任何 .js 文件');
    for (const f of named) {
      const hit = execSync(`find src -name '${f}' -not -path '*/archive/*'`, {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      assertTrue(hit.length > 0,
        `待办节点名的 ${f} 在 src/ 下不存在 —— 一条挂在已消失模块上的待办 ` +
        '(实测: desire-cognition.js 就这样挂了若干部周期)');
    }
  });

  // ── 四、文档必须说清 380 与 132 不是一回事 ──────────────
  test('文档必须点明 coverage-sweep 的 380 与注册子系统 132 是两个口径', () => {
    // 这是本轮缺口的实质: 两个数字差 3 倍，而文档只给小的那个。
    // 加行时必须同时写清"这不是 132"，否则读者会把 380 当成矛盾。
    const sk = fs.readFileSync(SKILL, 'utf8');
    const line = sk.split('\n').find(l => l.includes('Coverage sweep'));
    assertTrue(!!line, 'SKILL.md 应含 Coverage sweep 行');
    assertTrue(/132/.test(line),
      'Coverage sweep 行必须点明 132 这个口径 —— 只写 380 会让读者以为文档自相矛盾');
    assertTrue(/not|而不是|两个口径|file count/i.test(line),
      'Coverage sweep 行必须说明 380 是 src/ 文件数、与 132 注册子系统不同口径');
  });
};
