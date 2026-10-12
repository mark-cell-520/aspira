/**
 * test/audit-tests-count-partial-run.test.js —
 * 审计把"没有测到"报成"测到了而且不符": spawn 超时杀掉 run-all, 而它只读 stdout
 *
 * [doc-honest-numbers·第二百三十五轮] 新建。
 *
 * ═══ 缺陷(两个, 同一族, 都是实测出来的) ═══
 * 切片本轮问的是"审计自己报的『无法实测 6 项』里有没有其实是可测的"。
 * 回答那个问题的唯一办法是跑一遍**完整模式**审计(不带 ASPIRA_AUDIT_SKIP_TESTS),
 * 而这一跑就撞见了这个缺陷:
 *
 *   CURRENT_STATE.md 声称「tests passed (散文) = 2411」实测 8
 *   README.md       声称「test suite (表格)   = 2411」实测 8
 *   README.md       声称「passing tests (词序反转) = 2411」实测 8
 *   SKILL.md        声称「test suite (表格)   = 2411」实测 8
 *
 * 四条全判"与实测不符", exit 1。而**三份文档都是对的** —— 本轮串行实测
 * `ASPIRA_TEST_CONCURRENCY=1 node test/run-all.js` = 2411 通过 / 0 失败,
 * 用时 **1085 秒(18.1 分钟)**, 427 个文件。
 *
 * 根因是第二百一十三轮那次修复的**影子**: 那轮把审计的 spawn 改成串行以对齐
 * 门禁口径(对的), 却把 timeout 留在串行化之前的 900000(15 分钟)。套件从那时起
 * 一直在长, 于是 900 秒一到 spawnSync 就 SIGTERM 掉 run-all —— 离它打完汇总行
 * 还差约 3 分钟。而那段代码 `r.error` / `r.signal` 两个都不看, 只读 stdout:
 *   · `r.error.code === 'ETIMEDOUT'`、`r.signal === 'SIGTERM'`
 *   · stdout 里有 389 行 `测试结果: N 通过, 0 失败`(每个测试文件一行, run-all 的
 *     emitResult 又把子进程那行原样再打印一次, 因为它含"通过"落在 keep 里)
 *   · 取"最后一条"于是拿到**某个文件**的行 —— 本轮是 8
 *
 * 这是第二百一十三轮自己记的教训的更重版本: 那轮是"仪器与被测口径不同, 则它的
 * 读数不是读数"; 这轮是**仪器根本没有测到, 却把没测到报成测到了而且不符**。
 * 一份正确的文档被自己的仪器判红, 比仪器不报更糟 —— 它会训练人去改一份对的文档。
 *
 * ═══ 为什么这个缺陷能活过十几轮 ═══
 * 完整模式审计要 20 分钟, 而仓库里每一个探针都用 ASPIRA_AUDIT_SKIP_TESTS=1
 * (否则审计 spawn 的 run-all 会递归调回探针自己)。所以自第二百一十三轮起,
 * **没有一个轮次再跑过完整模式审计** —— 全部报的是"skip 模式 exit 0"。
 * 跳模式恰恰把 tests 族变成"无法实测", 于是这个缺陷在自己的 instrument 上
 * 永久隐身。又一个"仪器看不见的风险不存在, 直到它存在"。
 *
 * ═══ 修法(一个判据管两个缺陷) ═══
 * 只认 run-all **自己**那条汇总行: 它前面紧跟着一行 50 个 '=' 的分隔条
 * (run-all.js:310 `'='.repeat(50)`), 实测整个 stdout 里这个形状只出现一次,
 * 任何测试文件的汇总之行前面都没有它。锚不到 => 这一轮没测到 => 置 null,
 * 让那几条声称落进"无法实测"而不是"不符"。
 * **一次没有发生的测量, 不得被报成一次不一致的测量。**
 *
 * ═══ 本锁怎么在不跑 20 分钟的前提下锁住它 ═══
 * 把审计脚本复制一份到 scripts/(ROOT 由 `__dirname/..` 推导, 放 /tmp 会变成
 * 根目录 —— cycle 209 的教训), 只把 run-all 那个 spawn 的 timeout 改到 10 秒,
 * 于是**缺陷条件被完整复现**(run-all 被杀、汇总行从未打印), 而整轮只要几十秒。
 *
 * ⚠️ mount 形态: run-all 的 pickJob 只认 `module.exports = function/=>` 与 describe(
 * 两种, 其余走裸 node —— node:test 的 `ℹ tests N` 没有任何解析器读, 文件会跑完、
 * 会绿、却对总数贡献 0 例。本会话已在 cycle 232/233/234 各犯一次。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { withDocLock } = require('./_doc-probe-lock.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const COPY = path.join(ROOT, 'scripts', '_zz235-partial-probe.js');

/** 与其它源级锁同一条纪律: 先剥注释再匹配 */
function stripComments(src) {
  const out = [];
  let i = 0, n = src.length, inBlock = false;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (inBlock) { if (c === '*' && d === '/') { inBlock = false; out.push(' ', ' '); i += 2; continue; } out.push(c === '\n' ? '\n' : ' '); i++; continue; }
    if (c === '/' && d === '*') { inBlock = true; out.push(' ', ' '); i += 2; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out.push(' '); i++; } continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out.push(c); i++;
      while (i < n) { if (src[i] === '\\') { out.push(src[i], src[i + 1] || ' '); i += 2; continue; } if (src[i] === q) { out.push(src[i]); i++; break; } out.push(src[i]); i++; }
      continue;
    }
    out.push(c); i++;
  }
  return out.join('');
}

/** 旧实现的取法(缺陷那一版), 供反向证明内联回去 */
const OLD_EXTRACT = `  const all = [...out.matchAll(/测试结果:\\s*(\\d+)\\s*通过,\\s*(\\d+)\\s*失败/g)];
  const tm = all.length ? all[all.length - 1] : null;
  m.tests = tm ? Number(tm[1]) : null;
  m.testsFailed = tm ? Number(tm[2]) : null;`;

/**
 * 造一个变异副本。两个开关:
 *   shortTimeout —— 把 run-all 那个 spawn 的 timeout 改成 10 秒(复现缺陷条件)
 *   revert       —— 把新判据换回旧取法(证明锁看得见这个缺陷)
 * 每一步都带"变异必须生效"的自证(cycle 32: 一个没有发生的突变, 与一个不会失败的锁
 * 在输出上不可区分)。
 */
function makeCopy(opts) {
  let src = fs.readFileSync(SCRIPT, 'utf8');
  if (opts.shortTimeout) {
    const at = src.indexOf("['test/run-all.js']");
    if (at < 0) throw new Error('锚点失效: 找不到 run-all 的 spawn');
    const tAt = src.indexOf('timeout: ', at);
    if (tAt < 0 || tAt > at + 400) throw new Error('锚点失效: run-all spawn 里找不到 timeout');
    const m = /timeout: (\d+)/.exec(src.slice(tAt, tAt + 40));
    if (!m) throw new Error('锚点失效: timeout 值不可解析');
    src = src.slice(0, tAt) + 'timeout: 10000' + src.slice(tAt + m[0].length);
    if (!/timeout: 10000/.test(src)) throw new Error('突变没生效: timeout 未被改写');
  }
  if (opts.revert) {
    const re = /const AGG = [\s\S]*?m\.testsFailed = completed \? Number\(AGG\[2\]\) : null;/;
    if (!re.test(src)) throw new Error('锚点失效: 找不到新判据块(反向证明无效, 而不是通过)');
    src = src.replace(re, OLD_EXTRACT);
    if (/const AGG =/.test(src)) throw new Error('突变没生效: 新判据仍在');
    if (!/all\[all\.length - 1\]/.test(src)) throw new Error('突变没生效: 旧取法没回去');
  }
  fs.writeFileSync(COPY, src);
  return COPY;
}

/** 跑一个副本, 返回 { out, code }。审计退出码承载结论, 非零不抛。 */
function runCopy(file) {
  let out = '', code = 0;
  try {
    const r = spawnSync(process.execPath, [file], {
      cwd: ROOT, encoding: 'utf8', timeout: 200000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },   // **完整模式**: 不带 ASPIRA_AUDIT_SKIP_TESTS
    });
    out = (r.stdout || '').toString();
    code = r.status == null ? -1 : r.status;
  } catch (e) {
    out = (e.stdout || '').toString();
    code = -1;
  }
  return { out, code };
}

const badSection = (out) => (out.split('--- ❌')[1] || '').split('\n---')[0] || '';
const unmeasurableSection = (out) => (out.split('无法自动实测')[1] || '').split('\n---')[0] || '';
const claimsTotal = (out) => {
  const m = /文档声称总数: (\d+)/.exec(out);
  return m ? Number(m[1]) : 0;
};

module.exports = function ({ test, assertTrue }) {

  // ─── ① 缺陷条件复现: run-all 被杀 ⇒ 测试数必须"无法实测", 不得"不符" ───
  test('① 行为: spawn 超时杀掉 run-all 时, 测试数声称必须落入"无法实测"而非"不符"', () => withDocLock(() => {
    makeCopy({ shortTimeout: true });
    let res;
    try {
      res = runCopy(COPY);
    } finally {
      if (fs.existsSync(COPY)) fs.unlinkSync(COPY);
    }
    assertTrue(!fs.existsSync(COPY), '变异副本没被清掉 ——  debris 会混进 scripts/');
    // 反向控制: 副本必须真的跑出了一份完整报告, 否则下面两个断言会被一个崩掉的副本买通
    assertTrue(claimsTotal(res.out) > 0,
      '副本没有产出完整报告(文档声称总数读不到) —— 本条可能是被一个崩掉的副本满足的');
    assertTrue(/={50}/.test(res.out) === false || /测试结果:/.test(res.out),
      '副本输出形状异常');
    const bad = badSection(res.out);
    const un = unmeasurableSection(res.out);
    // 核心: 四条 tests 族声称一条都不得进"不符"
    for (const what of ['tests passed (散文)', 'test suite (表格)', 'passing tests (词序反转)', 'failing tests (失败数)']) {
      assertTrue(!bad.includes(what),
        `缺陷复现: 「${what}」被报成"与实测不符" —— 而 run-all 根本没跑完, 这是把没测到当成不符`);
      assertTrue(un.includes(what),
        `「${what}」没有落到"无法实测" —— 没测到的声称必须有地方去`);
    }
    // 没有一次测量发生 ⇒ 不得有人被报成测到了一个具体数字
    assertTrue(!/实测 \d/.test(bad), `不符段里出现了具体实测值: ${bad.slice(0, 200)}`);
  }));

  // ─── ② 源级: 分隔条锚 + 完成判据 + timeout 三者都必须在位 ───
  test('② 源级: 汇总行锚、完成判据、timeout 三者都必须在位', () => {
    const code = stripComments(fs.readFileSync(SCRIPT, 'utf8'));
    // (a) 只认 run-all 自己那条汇总行: 前面必须有 50 个 '=' 的分隔条
    assertTrue(code.includes("const AGG = /={50}\\s*\\n+测试结果:"),
      '汇总行锚不在 —— 又会退回"取最后一条 测试结果: 行", 而每个测试文件也打印那一行');
    // (b) 完成判据: 锚不到或 spawn 没正常结束都不得当成测到
    assertTrue(/const completed = !!AGG && !r\.error && !r\.signal;/.test(code),
      '完成判据不在 —— spawn 被 SIGTERM/ETIMEDOUT 杀掉时仍会把读到的东西当成测量值');
    assertTrue(code.includes('m.tests = completed ? Number(AGG[1]) : null;'),
      'm.tests 没有走完成判据');
    assertTrue(code.includes('m.testsFailed = completed ? Number(AGG[2]) : null;'),
      'm.testsFailed 没有走完成判据');
    // (c) timeout 必须大于实测的串行时长(1085 秒), 否则完成判据会永久为假。
    // 结构性取法而不是正则: `timeout: N, stdio: ['ignore','pipe','ignore']` 这个形状
    // 在脚本里出现两次(coverage-sweep 也是 300000), 用宽正则会把别处的 timeout
    // 当成 run-all 的 —— 第一版就这么错, 报了个不属于它的 300000。
    const at = code.indexOf("['test/run-all.js']");
    assertTrue(at >= 0, '锚点失效: 找不到 run-all 的 spawn');
    const tAt = code.indexOf('timeout: ', at);
    assertTrue(tAt >= 0 && tAt < at + 400, 'run-all 的 spawn 里找不到 timeout(锚点已变)');
    const tm = /timeout: (\d+)/.exec(code.slice(tAt, tAt + 40));
    assertTrue(!!tm, 'timeout 值不可解析');
    assertTrue(Number(tm[1]) >= 1200000,
      `run-all spawn 的 timeout 是 ${tm && tm[1]}ms —— 串行一遍实测 1085 秒, 小于它就会永远测不到`);
    // 非空洞自检: 剥注释没有把真代码剥掉
    assertTrue(/const AGG = /.test(code) && /spawnSync\('node', \['test\/run-all\.js'\]/.test(code),
      '剥注释把真代码剥掉了 —— 本条可能已空洞');
  });

  // ─── ③ 反向证明: 换回旧取法, 缺陷必须回来 ───
  test('③ 反向证明: 换回"取最后一条"的旧取法, 四条必须重新被报成不符', () => withDocLock(() => {
    makeCopy({ shortTimeout: true, revert: true });
    let res;
    try {
      res = runCopy(COPY);
    } finally {
      if (fs.existsSync(COPY)) fs.unlinkSync(COPY);
    }
    assertTrue(!fs.existsSync(COPY), '变异副本没被清掉');
    assertTrue(claimsTotal(res.out) > 0, '副本没有产出完整报告 —— 反向证明可能是被一个崩掉的副本满足的');
    const bad = badSection(res.out);
    // 旧取法在 run-all 被杀时读到的就是某个文件的行 ⇒ 必然与 2411 不符
    let hit = 0;
    for (const what of ['tests passed (散文)', 'test suite (表格)', 'passing tests (词序反转)']) {
      if (bad.includes(what)) hit++;
    }
    assertTrue(hit >= 1,
      '换回旧取法后缺陷没有复现 —— 本条锁不住东西(可能锚点已变或副本没跑起来)');
    assertTrue(/实测 \d/.test(bad), '旧取法没有报出具体实测值 —— 缺陷形态不对');
  }));

  // ─── ④ 披露: 完整模式审计的代价, 与这个缺陷为什么能隐身十几轮 ───
  test('④ 披露: 完整模式审计约 20 分钟, 而仓库里每个探针都用跳过模式', () => {
    // 探针一律跳过测试数实测(否则递归), 所以 skip 模式下 tests 族恒为"无法实测" ——
    // 那 6 条不是缺陷。本轮缺陷只在完整模式可见, 而完整模式没人跑。
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(src.includes('ASPIRA_AUDIT_SKIP_TESTS'), '递归防护开关不在');
    // 本锁自己必须能在合理时间内跑完: 两个副本各几十秒, 不触发完整模式的全长
    assertTrue(COPY.endsWith('_zz235-partial-probe.js'), '副本名变了 —— 记得同步清理');
  });
};
