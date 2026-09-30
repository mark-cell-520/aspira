/**
 * test/audit-drift-detection.test.js — [第二十二轮]
 *
 * 锁什么: 第十九轮引入的 DOC_SNAPSHOT 修好了"读"的一侧(claims() 只读快照,
 * 探针在 measure() 期间的注入看不见), 但同一个决定也放过了一样东西 ——
 * 探针若注入后没有还原, 磁盘上的文档就停在污染态, 而审计的每一条声称都读自
 * 快照, 于是它报「不一致: 0」。**全绿, 而文档是脏的。**
 *
 * 周期22 实测确认过这个盲区: 带一个"只弄脏不还原"的钩子跑审计, 修复前的审计
 * 报 84/84、退出码 0, 而 SKILL.md 磁盘上就是 9.9.9。这不是理论顾虑 ——
 * 第十九轮自己就是这么发现污染的: 它杀掉自己的审计 run, SIGTERM 传到探针,
 * 探针死在注入与还原之间。
 *
 * 所以快照必须是双刃的: 它挡住污染进入声称, 就必须让污染在别处发声。
 * 本文件锁的就是"别处"——claims() 之后把每份文档重新读一遍, 与快照逐字节比对,
 * 有差异就单独报一类(不计入"不一致", 那会把脏文档误判成文档写错), 并置退出码 1。
 *
 * ══ 首版守卫自己也错了一处(已修) ═══
 * 反向证明最初想靠"临时删掉审计里的 DRIFT 循环"来做。但那是在改**共享源码**,
 * 而本测试只持文档锁——并发跑着的 audit-doc-coverage / doc-probe-lock-coverage
 * 等纯读者不持锁也会读这份源码, 于是我把它们变成了受害者。改为: 把审计复制一份
 * 到 test/ 下、只在那份副本上摘掉 DRIFT 循环, 共享源码一个字节都不动。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withDocLock, restoreVersionLine, PROBE_AUTH_VERSION } = require('./_doc-probe-lock.js');

// [第二十五轮] 导入解构**失败不抛错**, 只会安静地变成 undefined。
// 周期24 花了整轮解释一个测试失败: 测试导入 PROBE_AUTH_VERSION, 而
// _doc-probe-lock.js 导出的是 PROBE_VERSION —— 解构拿到 undefined, 于是
// HEAL_HOOK 写出 `p1 + undefined`, 把 SKILL.md 版本行改成
// `| Engine version | undefined`。审计匹配不到版本号, 只能判成 drift,
// 而文档被留在一份"看起来修好了其实写坏了"的状态里。
// **调用成功、没有异常、返回结构合法 —— 而内容是死的。**
// 这个守卫让那种错位在加载时就炸, 而不是等到探针把垃圾写进文档。
if (typeof PROBE_AUTH_VERSION !== 'string' || !/^\d+\.\d+\.\d+$/.test(PROBE_AUTH_VERSION)) {
  throw new Error(
    'PROBE_AUTH_VERSION 未从 ./_doc-probe-lock.js 正确导出(导出名对不上时解构不抛错, 只会是 undefined)。'
    + ' 实测值: ' + JSON.stringify(PROBE_AUTH_VERSION)
    + '。VERSION 文件内容: ' + JSON.stringify(fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim())
  );
}

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const SKILL = path.join(ROOT, 'SKILL.md');
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();

// 审计默认会 spawn 整个 run-all.js(约 26s)。本测试要跑四次审计, 且每次都需要
// 钩子真的触发(它拦的就是那个 spawn), 所以**不能**设 ASPIRA_AUDIT_SKIP_TESTS ——
// 那个开关会让审计根本不 spawn, 钩子也就永远不 firing。
function runAudit(hookPath, extraArgs) {
  // [第二十四轮] hookPath 为 null 时不设 NODE_OPTIONS。旧写法无条件拼
  // '--require ' + hookPath, 传 null 会得到 '--require null' —— 审计进程
  // 连启动都失败, 输出为空, 于是断言看到的是"(无汇总行)"而不是真结果。
  // 一个连被测进程都没跑起来的断言, 和永不会失败的断言一样没有价值。
  const env = hookPath
    ? { ...process.env, NODE_OPTIONS: '--require ' + hookPath }
    : { ...process.env };
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT].concat(extraArgs || []), {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
    }) };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: (e.stdout || '').toString() };
  }
}

// [第二十五轮] 从 stdout 里取出 --json 的那一段。
// 审计在 JSON 之前会打几行引擎日志([memory-encrypt] / [MemoryBank] /
// [FormulaEngine] ...), 所以不能直接 JSON.parse 整个 stdout。
// 这正是"一个连被测进程都没跑起来的断言"的兄弟形态: 解析失败的断言看不到结果。
function parseAuditJson(out) {
  const i = out.indexOf('{\n  "measured"');
  if (i < 0) return null;
  try { return JSON.parse(out.slice(i)); } catch (_) { return null; }
}

// 钩子 A: 在审计 spawn run-all 的**那一刻**把 SKILL.md 弄脏, 然后不还原。
// 返回的假汇总与文档声称一致(1365), 于是"不一致"必须是 0 —— 把漂移单独隔离出来。
const DIRTY_HOOK = [
  "const cp = require('child_process');",
  "const fs = require('fs');",
  "const real = cp.spawnSync;",
  "cp.spawnSync = function (cmd, args, opts) {",
  "  if (args && args[0] && String(args[0]).indexOf('run-all.js') >= 0) {",
  "    const p = process.cwd() + '/SKILL.md';",
  "    const orig = fs.readFileSync(p, 'utf8');",
  "    fs.writeFileSync(p, orig.replace(/(\\|\\s*Engine version\\s*\\|\\s*v?)(\\d+\\.\\d+\\.\\d+)/, '$19.9.9'));",
  "    return { stdout: '测试结果: " + MEASURED_TESTS() + " 通过, 0 失败, 共 " + MEASURED_TESTS() + " 个\\n', status: 0 };",
  "  }",
  "  return real.apply(cp, arguments);",
  "};",
].join('\n');

// 钩子 B: 同样弄脏, 但**当场还原**。快照读到的是干净内容, 漂移比对读到的也是
// 干净内容, 所以必须一声不响 —— 这是"不得误报"的那一侧。
const RESTORE_HOOK = [
  "const cp = require('child_process');",
  "const fs = require('fs');",
  "const real = cp.spawnSync;",
  "cp.spawnSync = function (cmd, args, opts) {",
  "  if (args && args[0] && String(args[0]).indexOf('run-all.js') >= 0) {",
  "    const p = process.cwd() + '/SKILL.md';",
  "    const orig = fs.readFileSync(p, 'utf8');",
  "    const dirty = orig.replace(/(\\|\\s*Engine version\\s*\\|\\s*v?)(\\d+\\.\\d+\\.\\d+)/, '$19.9.9');",
  "    fs.writeFileSync(p, dirty);",
  "    fs.writeFileSync(p, orig);",
  "    return { stdout: '测试结果: " + MEASURED_TESTS() + " 通过, 0 失败, 共 " + MEASURED_TESTS() + " 个\\n', status: 0 };",
  "  }",
  "  return real.apply(cp, arguments);",
  "};",
].join('\n');

// 钩子 C: 在 spawn 的**那一刻把文档治好** —— 写权威版本号, 而不是弄脏。
// 这是 DIRTY_HOOK 的镜像, 用来测漂移判定的**另一个方向**: 快照脏而当前干净。
// 周期23 实测过这个方向的误报: 上一轮把 SKILL.md 留在 9.9.9, 本轮审计的快照
// 本身就是脏的, 套件把它治愈成 1.0.0, 于是旧的漂移检查报「被改写且未还原」,
// 而旧文案的修法是"还原到快照内容"—— 照做就把 9.9.9 写回刚修好的文档。
// **一个把修复方向指反的报告, 比没有报告更糟。**
// ⚠️ 它和 DIRTY_HOOK 一样必须返回假汇总: 不拦 spawn 就会真的跑起整个套件,
// 而套件里就有本文件 —— 周期21 确立"不存在嵌套路径", 无钩子会把它打破。
// ⚠️ 只换版本号、不碰行尾: SKILL.md 那一行后面挂着约定 #1 的审计痕迹,
// 整行替换会把它删掉(周期24 实测踩过)。
const HEAL_HOOK = [
  "const cp = require('child_process');",
  "const fs = require('fs');",
  "const real = cp.spawnSync;",
  "cp.spawnSync = function (cmd, args, opts) {",
  "  if (args && args[0] && String(args[0]).indexOf('run-all.js') >= 0) {",
  "    const p = process.cwd() + '/SKILL.md';",
  "    const orig = fs.readFileSync(p, 'utf8');",
  "    fs.writeFileSync(p, orig.replace(/(\\|\\s*Engine version\\s*\\|\\s*v?)(\\d+\\.\\d+\\.\\d+)/, function (m, p1) { return p1 + " + JSON.stringify(PROBE_AUTH_VERSION) + "; }));",
  "    return { stdout: '测试结果: " + MEASURED_TESTS() + " 通过, 0 失败, 共 " + MEASURED_TESTS() + " 个\\n', status: 0 };",
  "  }",
  "  return real.apply(cp, arguments);",
  "};",
].join('\n');

// 假汇总写一个**错的**测试数, 用来制造一条真的"不一致"。
const WRONG_SUMMARY_HOOK = [
  "const cp = require('child_process');",
  "const real = cp.spawnSync;",
  "cp.spawnSync = function (cmd, args, opts) {",
  "  if (args && args[0] && String(args[0]).indexOf('run-all.js') >= 0) {",
  "    return { stdout: '测试结果: 999 通过, 0 失败, 共 999 个\\n', status: 0 };",
  "  }",
  "  return real.apply(cp, arguments);",
  "};",
].join('\n');

// 反向证明用的副本: 只摘掉 DRIFT 循环, 其余原样。放在 test/ 下而不是 /tmp,
// 因为审计用 path.join(__dirname, '..') 推导 ROOT —— 放 /tmp 会让 ROOT 变成 /。
const REVERSE_COPY = path.join(__dirname, '.drift-reverse-proof-tmp.js');

function MEASURED_TESTS() {
  // 假汇总里的测试数必须与文档声称一致, 否则"漂移"会被"不一致"污染。
  // 从 SKILL.md 现读, 不硬编码 —— 硬编码的数是会腐烂的数。
  const s = fs.readFileSync(SKILL, 'utf8');
  const m = s.match(/\|\s*Test suite\s*\|\s*(\d+)\s*passing\s*\/\s*\d+\s*failing/);
  return m ? m[1] : '1365';
}

module.exports = function ({ test, assertTrue }) {
  // 整个文件全程持锁: 它往 SKILL.md 写污染, 也 spawn 会 spawn 整个套件的审计。
  // 不持锁时它读到/写到的都是别人的探针 —— 周期21 记的就是这个形状。
  withDocLock(() => {
    const backup = fs.readFileSync(SKILL, 'utf8');
    const hooks = [];
    const writeHook = (name, src) => {
      const p = path.join(os.tmpdir(), name);
      fs.writeFileSync(p, src);
      hooks.push(p);
      return p;
    };

    try {
      // ── 用例 1: 污染没还原时, 审计必须发声 ──
      // 这是本文件的全部理由: 快照让"不一致: 0", 但文档在磁盘上是脏的。
      test('探针弄脏文档而未还原时，审计必须单独报出"被改写且未还原"', () => {
        fs.writeFileSync(SKILL, restoreVersionLine(backup)); // 基线还原: 写权威值而非 backup
        const hook = writeHook('aspira-cycle22-dirty.cjs', DIRTY_HOOK);
        const r = runAudit(hook);
        assertTrue(/被改写且未还原/.test(r.out),
          '审计必须报出文档在审计期间被改写，实测输出无该节选: ' + summary(r.out));
        assertTrue(/SKILL\.md/.test(r.out.split('被改写且未还原')[1] || ''),
          '必须点出是哪份文档，实测: ' + summary(r.out));
        assertTrue(/不一致: 0/.test(r.out),
          '快照必须仍然挡住污染进入"不一致"(否则两类缺陷会互相掩盖)，实测: ' + summary(r.out));
        assertTrue(r.code !== 0, '退出码必须非零，实测: ' + r.code);
        // [第二十四轮] 这一侧还必须**不是**"被治愈"—— 否则方向判定可以把
        // "探针弄脏了文档"报成"文档被修好了", 而两者都要退出码 1, 光看退出码
        // 分不出来。方向本身必须被钉住。
        assertTrue(!/已被治愈/.test(r.out),
          '探针弄脏文档必须报"被改写且未还原"，不得报成"已被治愈"，实测: ' + summary(r.out));
      });

      // ── 用例 2: 探针自己还原干净时, 审计必须一声不响 ──
      // 没有这一侧, 用例 1 的断言可以是"永远报漂移"换来的。
      test('探针当场还原干净时，审计不得误报漂移，退出码必须为 0', () => {
        fs.writeFileSync(SKILL, restoreVersionLine(backup)); // 基线还原: 写权威值而非 backup
        const hook = writeHook('aspira-cycle22-restore.cjs', RESTORE_HOOK);
        const r = runAudit(hook);
        assertTrue(!/被改写且未还原/.test(r.out),
          '已还原就不得报漂移，实测却报了: ' + summary(r.out));
        assertTrue(/不一致: 0/.test(r.out), '应全绿，实测: ' + summary(r.out));
        assertTrue(r.code === 0, '退出码必须为 0，实测: ' + r.code);
      });

      // ── 用例 3: 退出码必须承载结论 ──
      // 周期22 实测: 审计带 1 条真 mismatch 时退出码是 0。任何用 spawnSync /
      // execFileSync 调它的调用方只能靠解析中文文本判断红绿。
      test('文档声称真错时，审计必须既报"不一致"又以非零退出码收场', () => {
        fs.writeFileSync(SKILL, restoreVersionLine(backup)); // 基线还原: 写权威值而非 backup
        const hook = writeHook('aspira-cycle22-wrongsummary.cjs', WRONG_SUMMARY_HOOK);
        const r = runAudit(hook);
        assertTrue(/不一致: [1-9]/.test(r.out),
          '必须报出不一致，实测: ' + summary(r.out));
        assertTrue(r.code !== 0, '退出码必须非零，实测: ' + r.code);
      });

      // ── 用例 4: 反向证明 —— 摘掉 DRIFT 循环的审计必须对同一污染视而不见 ──
      // 不碰共享源码: 复制一份, 只在那份上摘。
      test('反向证明: 去掉漂移比对的审计必须报不出"被改写且未还原"', () => {
        fs.writeFileSync(SKILL, restoreVersionLine(backup)); // 基线还原: 写权威值而非 backup
        const src = fs.readFileSync(SCRIPT, 'utf8');
        // [第二十四轮] 锚点随审计的分类块一起更新。旧锚点指向周期22 的那行
        // `if (readDocRaw(f) !== DOC_SNAPSHOT.get(f)) DRIFT.push(f);` ——
        // 本轮把漂移分成"变脏/变干净"两个方向后它就不存在了, 于是本反向证明
        // 如设计般大声失效("锚点已变")而不是静默通过。
        // **改变共享契约就继承了旧契约的所有调用方** —— 周期22 为退出码付过
        // 一次学费, 本轮为漂移分类再付一次, 而这次是锚点先发现的。
        const anchor = 'for (const f of DOCS_RECURSIVE) {\n'
          + '  const cur = readDocRaw(f), snap = DOC_SNAPSHOT.get(f);\n'
          + '  if (cur === snap) continue;\n'
          + '  const curV = labelledVersionOf(cur), snapV = labelledVersionOf(snap);\n'
          + '  if (curV !== null && snapV !== null && curV === PROBE_AUTH_VERSION && snapV !== PROBE_AUTH_VERSION) {\n'
          + '    HEALED.push(f);\n'
          + '  } else {\n'
          + '    DRIFT.push(f);\n'
          + '  }\n'
          + '}';
        if (src.indexOf(anchor) < 0) {
          throw new Error('审计里找不到 DRIFT 分类循环(锚点已变)，本反向证明失效，请更新锚点');
        }
        // 摘掉分类: DRIFT 与 HEALED 都恒为空 —— 副本必须对污染完全视而不见。
        fs.writeFileSync(REVERSE_COPY, src.replace(anchor, '/* 反向证明: 故意摘掉分类 */'));
        const hook = writeHook('aspira-cycle22-dirty2.cjs', DIRTY_HOOK);
        let out = '', code = 0;
        try {
          out = execFileSync('node', [REVERSE_COPY], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NODE_OPTIONS: '--require ' + hook },
          });
        } catch (e) {
          code = typeof e.status === 'number' ? e.status : 1;
          out = (e.stdout || '').toString();
        }
        assertTrue(!/被改写且未还原/.test(out),
          '摘掉比对的副本本应看不见污染，它却报了 —— 说明断言抓的不是漂移检测: ' + summary(out));
        assertTrue(/不一致: 0/.test(out),
          '副本的快照仍应挡住"不一致"(否则两类缺陷混在一起，证明不成立)，实测: ' + summary(out));
      });
      // ── 用例 5: 反向的那一半 —— 快照脏而当前干净, 必须报"已被治愈" ──
      // [第二十四轮] **本轮加了这个用例又撤了, 原因记在这里而不是删掉。**
      // 审计侧的行为已用 --json 直接实测确认是对的:
      //   污染 SKILL.md(版本行带尾部) → 带 HEAL_HOOK 跑审计 --json
      //   → {"drift": [], "healed": ["SKILL.md"]}
      // 也就是说脚本里 DRIFT/HEALED 的分类、以及人类可读分支里的
      // "⚠️ 审计开始时文档已带污染, 本轮已被治愈" 和 "⛔ 绝不要按快照还原"
      // 都按设计工作。但在**测试里**同一个场景却报"被改写且未还原"。
      // 已排除: 锚点失配(会抛"锚点已变")、钩子未触发(触发时 measured.tests
      // 来自假汇总)、$n 捕获组歧义(实测 V8 按 $1+字面量解析)、整行替换吃掉尾部
      // (已改成只换版本号)。剩下的差异没能隔离, 所以按周期规则撤用例不撤修复。
      // **一个我没法解释失败的断言, 比一个没有的断言更糟** —— 它会让下一轮
      // 以为这条行为已被锁住。下次接手: 先复现
      //   node -e "污染 SKILL.md" && NODE_OPTIONS=--require <HEAL_HOOK> \
      //     node scripts/audit-doc-numbers.js --json
      // 看 drift/healed, 再对比 runAudit() 的 env 差异(cwd/NODE_OPTIONS/
      // ASPIRA_TEST_RUNNER), 差异就在那三者之一里。
      // ── 用例 5: 反向的那一半 —— 快照脏而当前干净, 必须判成"已被治愈" ──
      // [第二十四轮→第二十五轮] 周期23 实测出一个反向误报: 上一轮把 SKILL.md
      // 留在 9.9.9, 本轮审计的**快照本身就是脏的**; 套件里的探针把它治愈成
      // 1.0.0, 于是旧的漂移检查报「被改写且未还原」—— 方向是反的。而旧文案
      // 的修法是"把污染还原到快照内容", 照做就会把 9.9.9 写回一份刚修好的文档。
      // **一个把修复方向指反的报告, 比没有报告更糟。**
      // 周期24 加了这个用例又撤了: 断言打在人类可读分支的中文文案上, 而在测试里
      // 同一场景报的是"被改写且未还原", 手动跑却报"已被治愈", 差异没隔离。
      // 本轮先补一次决定性的复现, 发现两件事:
      //   (a) 审计的**两个分支都是对的** —— 带钩子手动跑, 人类可读分支报
      //       "已被治愈"1 次、"被改写且未还原"0 次; --json 分支报
      //       {"drift": [], "healed": ["SKILL.md"]}。
      //   (b) /tmp/dbg-aspira-cycle24-heal.cjs **根本不存在** —— 用例5 被撤时
      //       连 writeHook 一起撤了, 所以"测试里报 DRIFT"这个观察从未在最终
      //       形态下复现过, 它读的是一份更早的陈旧输出。
      // 本轮改用 **--json 的结构化输出**断言, 而不是匹配中文文案:
      //   · 中文文案会变, drift/healed 两个数组是契约;
      //   · 结构化断言顺带排掉"输出里恰好有这几个字"的假通过。
      test('快照脏而当前干净时，审计必须判成"已被治愈"而不是"被改写且未还原"', () => {
        // 起步即污染(让**快照**是脏的), 再用 HEAL_HOOK 在 measure() 期间治好。
        fs.writeFileSync(SKILL, backup.replace(
          /(\|\s*Engine version\s*\|\s*v?)(\d+\.\d+\.\d+)/, '$19.9.9'));
        const hook = writeHook('aspira-cycle25-heal.cjs', HEAL_HOOK);
        const r = runAudit(hook, ['--json']);
        const j = parseAuditJson(r.out);
        assertTrue(j !== null,
          '必须能从审计 stdout 里解析出 --json 结果(引擎日志在 JSON 之前), 实测: ' + summary(r.out));
        assertTrue(Array.isArray(j.healed) && j.healed.indexOf('SKILL.md') >= 0,
          '快照脏而当前干净必须判成 healed, 实测 healed=' + JSON.stringify(j.healed)
          + ' drift=' + JSON.stringify(j.drift));
        assertTrue(j.drift.indexOf('SKILL.md') < 0,
          '不得把"被治愈"误判成 drift —— 那会让读者按脏快照还原, 把刚修好的文档重新弄脏');
        // 退出码仍必须非零: 脏快照同样让报告里的"与实测一致"不可信。
        assertTrue(r.code !== 0, '退出码仍必须非零(快照脏 ⇒ 上面的"与实测一致"不可信)，实测: ' + r.code);
        // 治愈必须真的发生了: 当前磁盘内容是权威值。
        assertTrue(new RegExp('\\| Engine version \\| ' + PROBE_AUTH_VERSION + ' \\|')
          .test(fs.readFileSync(SKILL, 'utf8')), '测试后 SKILL.md 必须是权威版本');
        // 行尾的审计痕迹必须还在(周期24 实测被整行替换吃掉过)。
        assertTrue(/agree \|/.test(fs.readFileSync(SKILL, 'utf8')),
          '测试后 SKILL.md 版本行的审计尾部必须还在');
      });
    } finally {
      // 还原必须在 finally: 上面四个用例都会把 SKILL.md 弄脏。
      // [第二十三轮] 还原必须写权威版本行。写回 backup 在文档已被污染时
      // 会把 9.9.9 原样写回去，污染从此永久自锁(实测连跑两轮 1364/7 无人能修)。
      fs.writeFileSync(SKILL, restoreVersionLine(backup));
      for (const p of hooks) { try { fs.unlinkSync(p); } catch (_) {} }
      try { fs.unlinkSync(REVERSE_COPY); } catch (_) {}
      assertTrue(!/9\.9\.9/.test(fs.readFileSync(SKILL, 'utf8')),
        '测试后 SKILL.md 必须已还原');
    }
  });
};

function summary(out) {
  const line = (out.match(/文档声称总数[^\n]*/) || ['(无汇总行)'])[0];
  return line + (out.indexOf('被改写且未还原') >= 0 ? ' | 含漂移节选' : '');
}
