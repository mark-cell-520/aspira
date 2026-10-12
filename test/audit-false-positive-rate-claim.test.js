/**
 * test/audit-false-positive-rate-claim.test.js
 *   —— FP 率这个百分比自己必须被审计接住, 而文档声称必须等于独立实测
 *
 * [doc-honest-numbers·第二百三十轮] 新建。
 *
 * ═══ 缺口是怎么找到的 ═══
 * 本轮把 cycle 208 的问题("哪些读数一个 key 都没有")从 CURRENT_STATE.md 的待办区
 * 扩大到**全部 218 份被扫文档**: 用审计自己的 walkMd / EXEMPT_* / pats / NUMISH /
 * ENGINE_SELF / NARRATIVE(全部行区间切片复用, 不重实现)枚举"NUMISH 命中、且没有
 * 任何一条 pats 的匹配跨度覆盖它、且带 aspira 自称词"的形态, 得 158 条, 其中引擎
 * 自述文档里 50 条。最大的一条不是历史叙事:
 *
 *   README.md  "4. False-positive rate around 8% at baseline."
 *   SKILL.md   "4. **False-positive rate** — baseline around 8%"
 *
 * 两句都是**现在时**的已知限制, 而 AGENTS.md 早记下这个 8% 是"从未被测量过"的旧
 * 读数、已被实测取代(README 自己的 changelog 第 279 行写着 "nothing in the
 * repository had ever measured it", 当时实测 5.3% on 38/13; 语料长到 137/68 之后
 * 实测 0.0%)。两份文档是调用方最先读到的东西, 而审计对这句话零表达力。
 *
 * ═══ 为什么审计接不住它(两条, 都是实测) ═══
 * ① ENGINE_SELF 的词表里**明明有** false-positive —— 仪器认得这句话在说 aspira,
 *    而 52 条 pattern 里没有一条的 re 匹配 "…rate … N%"。**认得主语, 接不住宾语。**
 *    语料规模(cycle 8 加的 benign/malicious 两个 key)锁的是 FP 率的**分母**;
 *    这个百分比自己是分子除以分母的结果, 分母对了比率照样能是错的。
 * ② claims() 重建正则用的是 `new RegExp(p.re.source, 'g')` —— **它把 /gi 的 i 丢掉**。
 *    首版写了 /gi, 文档里是 "False-positive"(大写 F), 于是 0 匹配, 被死 pattern
 *    自检当场抓住。**一条靠 flag 的模式在这张表里等于没有。**
 *
 * ═══ 还有一个坑, 只靠跑一遍发现不了 ═══
 * narrativeQuote 的"数字之后"窗口是 `text.slice(mm.index, lineEnd)` —— 从**匹配
 * 起点**开始, 不是从数字开始。所以匹配文本里自带一个叙事词, 这条声称会被自己的
 * 前缀吞掉: 首版文档写 "False-positive rate measured at 0.0%", 其中 "measured at"
 * 正是 NARRATIVE 的一员, 于是 README 那条声称整条消失, 而审计报全绿。
 * 第六例把这个不变式钉住: 声称文本里不得含 NARRATIVE 词。
 *
 * ═══ 本锁的不变量 ═══
 * 锁的是"文档声称 === 独立实测", 不锁字面。语料会长, 读数会动, 两者可以一起动,
 * 但不允许再分开。
 */
const { execFileSync } = require('child_process');
const { withDocLock, readDoc } = require('./_doc-probe-lock.js');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
  const README = path.join(ROOT, 'README.md');
  const SKILL = path.join(ROOT, 'SKILL.md');

  // ── 注释剥离(长度不必保留, 只用于源级匹配) ──
  // cycle 19/25/194/195/197/214/218/221 的形状: 源级锁若不剥注释, 会把自己刚写
  // 的修复说明当成违规。本轮自己的修复注释里就引用了被删掉的 /gi 与 "measured at"。
  function noComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  function runAudit(scriptPath) {
    try {
      return execFileSync('node', [scriptPath || SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' }, timeout: 300000,
      });
    } catch (e) { return ((e.stdout || '') + (e.stderr || '')).toString(); }
  }

  const mismatchCount = (out) => {
    const m = out.match(/不一致:\s*(\d+)/);
    return m ? Number(m[1]) : -1;
  };

  // 从审计自己的 pats 表里取出这条 pattern 的 re 源(复用仪器, 不重实现)。
  // 收束必须容忍**任意 flag**: 首版写死 `/g,`, 于是把 flag 改回 /gi 的变异会让
  // 抽取返回 -1、用例在加载期就抛错 —— "锁崩了"不是"锁红了"(cycle 205 的教训)。
  // ⚠️ 锚点必须钉在 **what**(唯一)而不能钉在 key: cycle 231 给同一个
  // `falsePositive` key 加了第二种措辞(AGENTS.md 披露段)，于是
  // `indexOf("key: 'falsePositive'")` 虽然仍命中本轮这条(它在表里更靠前)，
  // 但这个唯一性假设已经不成立，且没有任何东西在守护它。
  // `what: 'false-positive rate'` 带收尾引号, 与
  // `what: 'false-positive rate (AGENTS 披露段)'` 不构成前缀包含, 是唯一的。
  function fpPatternSource() {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const keyAt = src.indexOf("what: 'false-positive rate'");
    assertTrue(keyAt > 0, '审计 pats 里找不到 what 为 false-positive rate 的那一条 —— 它被删了?');
    const reAt = src.lastIndexOf('re: /', keyAt);
    assertTrue(reAt > 0 && reAt < keyAt, '找不到该条的 re 字面量 —— 锚点已变');
    let close = -1;
    for (let k = reAt + 5; k < src.length; k++) {
      if (src[k] === '/' && src[k - 1] !== '\\' && /^[a-z]*,/.test(src.slice(k + 1, k + 6))) { close = k; break; }
    }
    assertTrue(close > reAt, '找不到该 re 字面量的收束 —— 锚点已变');
    return src.slice(reAt + 're: /'.length, close);
  }

  // 从审计源码里取出 currentClaimsOnly(复用仪器, 不重实现)。
  // 为什么必须用它: README 的 changelog 表里**合法地**写着 "false-positive rate
  // around 8%"(第 279 行, 记录当时"从未被测量过"这件事)。不剥掉 changelog 就把
  // 历史叙事当成了现在时声称 —— 首版本测试正是这么错的, 两条用例因此红。
  function currentClaimsFn() {
    const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n');
    const i = lines.findIndex(l => l.startsWith('function currentClaimsOnly('));
    assertTrue(i >= 0, '审计源码里找不到 currentClaimsOnly —— 锚点已变');
    let j = i;
    while (j < lines.length && lines[j] !== '}') j++;
    assertTrue(j < lines.length, '找不到 currentClaimsOnly 的收束 —— 锚点已变');
    return new Function('return ' + lines.slice(i, j + 1).join('\n'))();
  }
  const currentClaimsOnly = currentClaimsFn();
  // 前提自证: 剥离确实剥掉了 changelog(否则下面每条都可能空转)
  assertTrue(currentClaimsOnly('a\n| Version | Date | Change |\nb').length < 'a\n| Version | Date | Change |\nb'.length,
    'currentClaimsOnly 没有剥掉 changelog —— 前提自证失败');

  // 独立实测: 解析语料数组(不执行校准脚本) + 逐条过 gate.checkOutput
  function independentFPRate() {
    const { loadCorpus } = require('./_corpus-arrays.js');
    const gate = require(path.join(ROOT, 'src', 'gate.js'));
    const c = loadCorpus();
    let escalated = 0;
    for (const s of c.BENIGN) {
      const r = gate.checkOutput(s);
      if (r && r.gate && r.gate.action !== 'pass') escalated++;
    }
    return { rate: (escalated / c.benignCount * 100).toFixed(1), benign: c.benignCount, escalated };
  }

  // 文档侧的声称值: 用审计自己那条 pattern 去读(而不是测试里另写一条),
  // 且只读"当前声称"区域(剥掉 README 的 changelog 表)
  function docClaims() {
    const re = new RegExp(fpPatternSource(), 'g');
    const out = [];
    for (const [name, abs] of [['README.md', README], ['SKILL.md', SKILL]]) {
      const text = currentClaimsOnly(readDoc(abs));
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) out.push({ doc: name, value: m[1], match: m[0] });
    }
    return out;
  }

  // ── ① 源级: 测量 + 回填 + pattern 三样都必须在 ──────────────
  test('源级: 审计必须有 FP 率测量、actual 回填和接得住它的 pattern', () => {
    const raw = fs.readFileSync(SCRIPT, 'utf8');
    const src = noComments(raw);
    // 前提自证: 剥离没有剥掉真代码 —— 这三处的标识符必须还在
    assertTrue(/m\.falsePositive\s*=/.test(src), 'measure() 里没有 m.falsePositive 赋值');
    assertTrue(/actual\.falsePositive\s*=\s*m\.falsePositive/.test(src),
      'actual.falsePositive 的回填不在 rows 构造之前 —— 声称会掉进"无法实测"而不是"不符"');
    assertTrue(/key:\s*'falsePositive'/.test(src), 'pats 里没有 falsePositive 这一条');
    // 反向自证: 剥注释确实剥掉了东西(否则上面三条可能是没剥到的运气)
    assertTrue(noComments(raw).length < raw.length, '注释剥离是空操作 —— 前提自证失败');
  });

  // ── ② 读数不变式: 文档声称 === 独立实测 ────────────────────
  test('读数不变式: README/SKILL 的 FP 声称必须等于独立实测(不锁字面)', () => withDocLock(() => {
    const indep = independentFPRate();
    const claims = docClaims();
    assertTrue(claims.length >= 2,
      '两个站点的 FP 声称没都被读到(只读到 ' + claims.length + ' 条) —— '
      + '可能是 narrativeQuote 把声称吞了, 也可能是 pattern 不再匹配');
    for (const c of claims) {
      assertEqual(c.value, indep.rate,
        c.doc + ' 声称 FP 率 ' + c.value + '%, 独立实测 ' + indep.rate + '% '
        + '(' + indep.escalated + '/' + indep.benign + ')。若语料已增长, 请按实测更新文档, '
        + '不要把本测试改成字面。');
    }
  }));

  // ── ③ 活体注入: 两侧都注入错值, 审计必须按名红 ─────────────
  test('活体注入: 两侧注入错值后审计必须 exit≠0 且报出实测值', () => withDocLock(() => {
    const indep = independentFPRate();
    const origR = fs.readFileSync(README, 'utf8');
    const origS = fs.readFileSync(SKILL, 'utf8');
    const re = new RegExp(fpPatternSource(), 'g');
    const poisonR = origR.replace(re, (m) => m.replace(/(\d+(?:\.\d+)?)(\s*%)/, '3.0$2'));
    const poisonS = origS.replace(re, (m) => m.replace(/(\d+(?:\.\d+)?)(\s*%)/, '3.0$2'));
    assertTrue(poisonR !== origR && poisonS !== origS,
      '注入未生效 —— 锚点没匹配上, 本次活体注入无效');
    assertTrue(poisonR.includes('3.0%') && poisonS.includes('3.0%'),
      '注入没有把值改成 3.0% —— 变异未生效');
    fs.writeFileSync(README, poisonR);
    fs.writeFileSync(SKILL, poisonS);
    let code = 0, out = '';
    try {
      out = execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' }, timeout: 300000,
      });
    } catch (e) {
      code = e.status; out = ((e.stdout || '') + (e.stderr || '')).toString();
    } finally {
      fs.writeFileSync(README, origR);
      fs.writeFileSync(SKILL, origS);
    }
    assertTrue(fs.readFileSync(README, 'utf8') === origR, 'README.md 未字节还原');
    assertTrue(fs.readFileSync(SKILL, 'utf8') === origS, 'SKILL.md 未字节还原');
    assertTrue(code !== 0, '注入错值后审计仍 exit 0 —— 这条锁看不见 FP 声称');
    assertTrue(/README\.md 声称「false-positive rate = 3\.0」/.test(out),
      'README 的 FP 声称没被报成不符:\n' + out.split('\n').filter(l => /false-positive/.test(l)).join('\n'));
    assertTrue(/SKILL\.md 声称「false-positive rate = 3\.0」/.test(out),
      'SKILL 的 FP 声称没被报成不符:\n' + out.split('\n').filter(l => /false-positive/.test(l)).join('\n'));
    // 审计报的实测值必须等于独立实测 —— 否则锁住的可能是另一个数
    const actual = (out.match(/false-positive rate = 3\.0」实测 (\d+(?:\.\d+)?)/) || [])[1];
    assertEqual(actual, indep.rate,
      '审计自报实测 ' + actual + ' 与独立实测 ' + indep.rate + ' 不符 —— 测量本身有问题');
  }));

  // ── ④ 加了这条模式后审计仍须 0 不一致 ─────────────────────
  test('加了这条模式后审计仍须 0 不一致(不得误审别处)', () => withDocLock(() => {
    const out = runAudit();
    assertEqual(mismatchCount(out), 0,
      '新增 FP 模式后出现了不一致项 —— 它匹配到了不该审的文本:\n'
      + (out.split('❌ 与实测不符')[1] || '').split('\n').slice(0, 6).join('\n'));
    assertTrue(!/死 pattern 7 条/.test(out), 'false-positive rate 又变成死 pattern 了 —— flag 或大小写退回旧错');
  }));

  // ── ⑤ 反向证明: 删掉 pattern 块, 声称必须消失 ──────────────
  test('反向证明: 删掉 pattern 块后 FP 声称必须消失', () => withDocLock(() => {
    const orig = fs.readFileSync(SCRIPT, 'utf8');
    const start = orig.indexOf('// ── [doc-honest-numbers·第二百三十轮] FP 率本身 ──');
    assertTrue(start > 0, '源码里找不到新模式块 —— 锚点已变, 本反向证明无效');
    const keyAt = orig.indexOf("what: 'false-positive rate'");
    assertTrue(keyAt > start, '找不到该条的 what 行 —— 锚点已变, 本反向证明无效');
    // ⚠️ 收束必须从**本条自己的** `},` 算, 不能找 `\n      },`:
    // pats 表里绝大多数条目是单行 `{ re: ... },`,`},` 在行尾而前面是空格不是换行,
    // 于是 `\n      },` 第一次命中落在很远的多行条目(testsFailed)上 —— 首版这么写,
    // 一刀删掉了半张表(声称总数 104 → 32), 而副本照样跑完、照样打印汇总行,
    // 只有"总数对不对"这一条把它抓住。
    const closeAt = orig.indexOf('},', keyAt);
    assertTrue(closeAt > keyAt, '找不到该条的收束 —— 锚点已变');
    const blockEnd = orig.indexOf('\n', closeAt) + 1;
    assertTrue(blockEnd > closeAt, '找不到收束后的换行 —— 锚点已变');
    const removed = orig.slice(start, blockEnd);
    // 结构闸: 删掉的必须只有这一条(一个 re 字面量), 且不能吃掉下一条
    assertEqual((removed.match(/re: \//g) || []).length, 1,
      '反向证明要删掉的块里有 ' + (removed.match(/re: \//g) || []).length + ' 个 re 字面量 —— 切片吃掉了别的 pattern');
    assertTrue(removed.length < 4000, '要删掉的块有 ' + removed.length + ' 字符 —— 切片范围不对');
    assertTrue(!removed.includes("key: 'tools'"), '切片吃掉了下一条(MCP tools)—— 收束算错了');
    const broken = orig.slice(0, start) + orig.slice(blockEnd);
    // ⚠️ 判据必须钉在 **what** 而不是 key: cycle 231 给同一个 falsePositive key
    // 加了第二种措辞(AGENTS.md 披露段)，于是"key 字符串已消失"这条判据在删掉
    // 本轮这一条之后**永远不成立** —— 全套件因此红过一格(2389/1)。
    // 这是"改了共享契约就继承旧契约所有调用者"的又一次缴费: 不是 key 被删了，
    // 是 key 从唯一变成不唯一，而旧锁的唯一性假设没有任何东西在守护。
    assertTrue(broken !== orig && !broken.includes("what: 'false-positive rate'"),
      '变异未生效 —— 锚点没匹配上, 本次反向证明无效');
    const tmp = path.join(ROOT, 'scripts', '_audit-broken-230.tmp.js');
    fs.writeFileSync(tmp, broken);
    const realOut = runAudit();
    const realTotal = Number((realOut.match(/文档声称总数:\s*(\d+)/) || [])[1]);
    try {
      const out = runAudit(tmp);
      // 反向控制: 副本必须**完整跑完**(否则"消失"可能只是副本崩了)。
      // 判据是它自己的汇总行与声称总数, 而不是"另一条声称出现在输出里" ——
      // 审计只打印不符/无法实测的声称, 一致的声称根本不出现(首版就是这么错的)。
      assertTrue(/文档声称总数:\s*\d+/.test(out), '副本没有产出汇总行 —— 它跑失败了, 反向证明无效');
      const copyTotal = Number((out.match(/文档声称总数:\s*(\d+)/) || [])[1]);
      assertTrue(realTotal >= 100, '真实运行的声称总数 ' + realTotal + ' 异常小 —— 前提自证失败');
      assertEqual(copyTotal, realTotal - 2,
        '副本声称总数 ' + copyTotal + ' ≠ 真实 ' + realTotal + ' - 2(两个站点) —— 删掉的不只是 FP 这条');
      assertTrue(!/false-positive rate =/.test(out),
        '删掉整条模式后审计仍认出 FP 声称 —— 说明认出它的不是这条模式, 反向证明无效');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    assertTrue(!fs.existsSync(tmp), '临时副本没被删掉 —— 仓库里留下了 debris');
  }));

  // ── ⑥ 措辞不变式: 声称文本不得含 NARRATIVE 词 ──────────────
  test('措辞不变式: FP 声称的匹配文本里不得含叙事词(否则被自己的前缀吞掉)', () => withDocLock(() => {
    const NARRATIVE = /removed|was written|was\s|were\s|曾是|已删|此前|原先|曾经|写的是|grew|grow|added|additional|to recover|from\s+\d[\d,]*\s+to\s+\d|expanded|reverted|tried and|measured on|measured at/i;
    // 前提自证: 这条检查不是空转 —— NARRATIVE 必须真的含 measured at
    assertTrue(NARRATIVE.test('x measured at 0.0%'), 'NARRATIVE 已不含 measured at —— 本检查的前提失效, 请重估');
    const claims = docClaims();
    assertTrue(claims.length >= 2, '两个站点的声称没都被读到 —— 第六例的前提不成立');
    for (const c of claims) {
      assertTrue(!NARRATIVE.test(c.match),
        c.doc + ' 的 FP 声称文本 "' + c.match + '" 含叙事词 —— narrativeQuote 的 after 窗口'
        + ' 从匹配起点开始, 这条声称会被自己的前缀吞掉, 而审计仍报全绿');
    }
  }));

  // ── ⑦ 披露: 语料本地性措辞必须在, 8% 不得回归 ─────────────
  test('披露: 语料本地性措辞必须在两份文档里, 旧读数 8% 不得回归', () => withDocLock(() => {
    // 只查"当前声称"区域: README 的 changelog 里**合法地**记录着这个 8%
    // (它记的是"当时从未被测量过"这件事), 把它算成回归就是 cycle 219 的形状 ——
    // 一条描述过去缺陷的句子被仪器读成一条当前声称。
    const r = currentClaimsOnly(readDoc(README)), s = currentClaimsOnly(readDoc(SKILL));
    assertTrue(/corpus-local/i.test(r), 'README 的 FP 条目丢了"corpus-local"限定 —— 一个语料本地读数会被读成生产 SLO');
    assertTrue(/corpus-local/i.test(s), 'SKILL 的 FP 条目丢了"corpus-local"限定');
    assertTrue(/not a production SLO/i.test(r) || /不是.*SLO|非.*SLO/.test(r),
      'README 的 FP 条目没有声明它不是生产 SLO');
    assertTrue(/not a production SLO/i.test(s) || /不是.*SLO|非.*SLO/.test(s),
      'SKILL 的 FP 条目没有声明它不是生产 SLO');
    // 旧读数不得以现在时回归
    const stale = (t) => /false[- ]positive rate[^.\n]{0,40}?(?:around\s*)?8\s*%/i.test(t);
    assertTrue(!stale(r), 'README 的当前声称区又出现 "around 8%" 形态的 FP 读数');
    assertTrue(!stale(s), 'SKILL 又出现 "around 8%" 形态的 FP 读数');
  }));

  // ── ⑧ 分母一致: 句子里的样本数必须等于实测语料规模 ────────
  test('分母一致: FP 条目里写的样本数必须等于实测语料规模', () => withDocLock(() => {
    const indep = independentFPRate();
    for (const [name, abs] of [['README.md', README], ['SKILL.md', SKILL]]) {
      const text = currentClaimsOnly(readDoc(abs));
      const line = text.split('\n').find(l => /false[- ]positive rate/i.test(l) && /%/.test(l));
      assertTrue(!!line, name + ' 里找不到 FP 率那一行');
      const n = (line.match(/(\d+)[- ]sample/) || [])[1];
      assertEqual(Number(n), indep.benign,
        name + ' 的 FP 条目写 ' + n + ' 样本, 实测语料 ' + indep.benign
        + ' 条 —— 分母与句子里的数不一致');
    }
  }));
};
