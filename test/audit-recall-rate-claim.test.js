/**
 * test/audit-recall-rate-claim.test.js
 *   —— AGENTS.md 披露段里 recall 那半个读数必须被审计接住
 *
 * [doc-honest-numbers·第二百三十一轮] 新建。
 *
 * ═══ 缺口 ═══
 * cycle 230 教会审计读 "False-positive rate … N%"(README/SKILL 的已知限制)，并加上了
 * m.falsePositive 测量。本轮重跑 cycle 208 的枚举仪器(内容锚点切片, 不再用行号 ——
 * cycle 230 的硬编码行号在本轮一编辑就腐烂)，在 218 份被扫文档里仍有 157 个接不住的
 * 形态, 其中引擎自述文档 49 个。逐条看: AGENTS.md 46 个几乎全是周期史(正确地不受审)，
 * **但第 242 行那条不是**:
 *
 *   "the current reading is **0.0% FP / 100% recall**"
 *
 * 两个半边都没有任何 pattern 接得住 —— 而 FP 这个量 cycle 230 刚刚教会审计去测。
 * 于是出现一个新形状: **测量存在、措辞不匹配**。这是 cycle 219("同一句话只审了一半")
 * 与 cycle 224("同一个数字换个词序就成了盲区")的第三例, 这次是同一句子里的另一个数。
 *
 * ═══ 为什么锚在 `current reading is` 上 ═══
 * 实测全仓裸形态 `N% FP|N% recall` 有 **12 处命中**, 其中 8 处在 AGENTS.md 的周期史里
 * ("the 0.9% FP and the 100% recall" / "The 100% recall above is *plaintext* recall" /
 * cycle 203 引用同一对数字的披露句……)，逐条都是历史读数或对读数的引用。不锚定就会一次
 * 制造 8 条假不符(cycle 141/205 的形状)。而 `current reading is` 在全仓**只出现一次**
 * (实测 grep)，锚上去恰好命中那一句、不碰任何历史叙述。第七例把"锚点仍唯一"钉住 ——
 * 否则这个精度声明会静默过期。
 *
 * ═══ 本轮自己踩的坑 ═══
 * recall 那条模式的间隔类首版写 `[^.\n]`(不许跨句)，而 "is" 到 recall 的数字之间隔着
 * FP 那半句的 "0.0"，里面就有一个点 —— 于是这条模式**结构上永远匹配不到**，被审计自己
 * 的死 pattern 自检当场抓住。与上一轮"靠 i flag 等于没有"同族: 一个跨不过自己句子里的
 * 标点的模式，等于没有。
 */
const { execFileSync } = require('child_process');
const { withDocLock, readDoc } = require('./_doc-probe-lock.js');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
  const AGENTS = path.join(ROOT, 'AGENTS.md');

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

  // 从审计源码里取出 currentClaimsOnly(复用仪器, 不重实现)
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

  // 独立实测: 解析语料数组(不执行校准脚本) + 逐条过 gate.checkOutput
  function independent() {
    const { loadCorpus } = require('./_corpus-arrays.js');
    const gate = require(path.join(ROOT, 'src', 'gate.js'));
    const c = loadCorpus();
    let esc = 0;
    for (const s of c.BENIGN) {
      const r = gate.checkOutput(s);
      if (r && r.gate && r.gate.action !== 'pass') esc++;
    }
    let caught = 0;
    for (const s of c.MALICIOUS) {
      const r = gate.checkOutput(s);
      const a = r && r.gate && r.gate.action;
      if (a === 'block' || a === 'rewrite') caught++;
    }
    return {
      fp: (esc / c.benignCount * 100).toFixed(1),
      recall: (caught / c.maliciousCount * 100).toFixed(1),
      benign: c.benignCount, malicious: c.maliciousCount, escalated: esc, caught,
    };
  }

  // 文档侧: 用审计自己那两条 pattern 的 re 源去读 AGENTS.md 的披露句
  function patternSource(what) {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const at = src.indexOf("what: '" + what + "'");
    assertTrue(at > 0, 'pats 里找不到 ' + what + ' 这一条 —— 它被删了?');
    const reAt = src.lastIndexOf('re: /', at);
    assertTrue(reAt > 0 && reAt < at, '找不到该条的 re 字面量 —— 锚点已变');
    let close = -1;
    for (let k = reAt + 5; k < src.length; k++) {
      if (src[k] === '/' && src[k - 1] !== '\\' && /^[a-z]*,/.test(src.slice(k + 1, k + 6))) { close = k; break; }
    }
    assertTrue(close > reAt, '找不到该 re 字面量的收束 —— 锚点已变');
    return src.slice(reAt + 're: /'.length, close);
  }

  function docClaims() {
    const out = {};
    for (const what of ['false-positive rate (AGENTS 披露段)', 'recall rate (AGENTS 披露段)']) {
      const re = new RegExp(patternSource(what), 'g');
      const text = currentClaimsOnly(readDoc(AGENTS));
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) out[what] = m[1];
    }
    return out;
  }

  // ── ① 源级: 测量 + 回填 + 两条模式 ─────────────────────────
  test('源级: 审计必须有 recall 测量、actual 回填和接得住它的两条模式', () => {
    const raw = fs.readFileSync(SCRIPT, 'utf8');
    const src = noComments(raw);
    assertTrue(/m\.recall\s*=/.test(src), 'measure() 里没有 m.recall 赋值');
    assertTrue(/actual\.recall\s*=\s*m\.recall/.test(src),
      'actual.recall 的回填不在 rows 构造之前 —— 声称会掉进"无法实测"而不是"不符"');
    assertTrue(/key:\s*'recall'/.test(src), 'pats 里没有 recall 这一条');
    assertTrue(/what:\s*'false-positive rate \(AGENTS 披露段\)'/.test(src),
      'pats 里没有 AGENTS 披露段的 FP 模式 —— 那句话的前半句仍不受审');
    // 前提自证: 剥离不是空操作
    assertTrue(noComments(raw).length < raw.length, '注释剥离是空操作 —— 前提自证失败');
  });

  // ── ② 读数不变式: 披露句两半都等于独立实测 ─────────────────
  test('读数不变式: AGENTS.md 披露句的 FP 与 recall 都必须等于独立实测', () => withDocLock(() => {
    const indep = independent();
    const claims = docClaims();
    assertTrue(claims['false-positive rate (AGENTS 披露段)'] !== undefined,
      'AGENTS.md 披露句的前半句(FP)没被读到 —— 那条模式不再匹配');
    assertTrue(claims['recall rate (AGENTS 披露段)'] !== undefined,
      'AGENTS.md 披露句的后半句(recall)没被读到 —— 那条模式不再匹配');
    assertEqual(claims['false-positive rate (AGENTS 披露段)'], indep.fp,
      'AGENTS.md 的 FP 读数 ' + claims['false-positive rate (AGENTS 披露段)']
      + ' 与独立实测 ' + indep.fp + ' 不符');
    assertEqual(claims['recall rate (AGENTS 披露段)'], indep.recall,
      'AGENTS.md 的 recall 读数 ' + claims['recall rate (AGENTS 披露段)']
      + ' 与独立实测 ' + indep.recall + ' 不符');
  }));

  // ── ③ 活体注入 recall: 后半个读数必须按名红 ────────────────
  test('活体注入: 把 recall 改成错值, 审计必须 exit≠0 且报出实测值', () => withDocLock(() => {
    const indep = independent();
    const orig = fs.readFileSync(AGENTS, 'utf8');
    const FROM = '**0.0% FP / 100.0% recall**';
    const TO = '**0.0% FP / 95.0% recall**';
    assertTrue(orig.includes(FROM), '源码里找不到披露句 —— 锚点已变, 本活体注入无效');
    fs.writeFileSync(AGENTS, orig.replace(FROM, TO));
    let code = 0, out = '';
    try {
      out = execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' }, timeout: 300000,
      });
    } catch (e) { code = e.status; out = ((e.stdout || '') + (e.stderr || '')).toString(); }
    finally {
      fs.writeFileSync(AGENTS, orig);
    }
    assertTrue(fs.readFileSync(AGENTS, 'utf8') === orig, 'AGENTS.md 未字节还原');
    assertTrue(code !== 0, '注入错 recall 后审计仍 exit 0 —— 这半个读数没被锁住');
    assertTrue(/AGENTS\.md 声称「recall rate \(AGENTS 披露段\) = 95\.0」/.test(out),
      'recall 声称没被报成不符:\n' + out.split('\n').filter(l => /recall/.test(l)).join('\n'));
    const actual = (out.match(/recall rate \(AGENTS 披露段\) = 95\.0」实测 (\d+(?:\.\d+)?)/) || [])[1];
    assertEqual(actual, indep.recall,
      '审计自报实测 ' + actual + ' 与独立实测 ' + indep.recall + ' 不符 —— 测量本身有问题');
  }));

  // ── ④ 活体注入 FP 半句: 同句的前半也必须受审 ───────────────
  test('活体注入: 把 FP 改成错值, 同一句话的前半句也必须按名红', () => withDocLock(() => {
    const orig = fs.readFileSync(AGENTS, 'utf8');
    const FROM = 'the current reading is **0.0% FP';
    const TO = 'the current reading is **1.5% FP';
    assertTrue(orig.includes(FROM), '源码里找不到披露句前半 —— 锚点已变, 本活体注入无效');
    fs.writeFileSync(AGENTS, orig.replace(FROM, TO));
    let code = 0, out = '';
    try {
      out = execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' }, timeout: 300000,
      });
    } catch (e) { code = e.status; out = ((e.stdout || '') + (e.stderr || '')).toString(); }
    finally {
      fs.writeFileSync(AGENTS, orig);
    }
    assertTrue(fs.readFileSync(AGENTS, 'utf8') === orig, 'AGENTS.md 未字节还原');
    assertTrue(code !== 0, '注入错 FP 后审计仍 exit 0 —— 披露句的前半句没被锁住');
    assertTrue(/AGENTS\.md 声称「false-positive rate \(AGENTS 披露段\) = 1\.5」/.test(out),
      '披露句前半的 FP 声称没被报成不符:\n' + out.split('\n').filter(l => /AGENTS/.test(l)).join('\n'));
  }));

  // ── ⑤ 加了模式后审计仍须 0 不一致, 且都不是死 pattern ──────
  test('加了两条模式后审计仍须 0 不一致, 且都不是死 pattern', () => withDocLock(() => {
    const out = runAudit();
    assertEqual(mismatchCount(out), 0,
      '新增模式后出现了不一致项 —— 它匹配到了不该审的文本:\n'
      + (out.split('❌ 与实测不符')[1] || '').split('\n').slice(0, 6).join('\n'));
    // 死 pattern 自检: 本轮两条都曾因"跨不过自己句子里的点"而空转过
    assertTrue(!/· recall rate \(AGENTS 披露段\)/.test(out),
      'recall 模式又变成死 pattern 了 —— 间隔类写回了 [^.\\n], 跨不过 FP 半句里的点');
    assertTrue(!/· false-positive rate \(AGENTS 披露段\)/.test(out),
      'AGENTS 披露段的 FP 模式变成死 pattern 了');
  }));

  // ── ⑥ 反向证明: 删掉 recall 模式块, 声称必须消失 ───────────
  test('反向证明: 删掉 recall 模式块后该声称必须消失', () => withDocLock(() => {
    const orig = fs.readFileSync(SCRIPT, 'utf8');
    const start = orig.indexOf("what: 'recall rate (AGENTS 披露段)'");
    assertTrue(start > 0, '找不到 recall 模式块 —— 锚点已变, 本反向证明无效');
    // 收束从**本条自己的** `},` 算(cycle 230: `\n      },` 只匹配多行条目)。
    // ⚠️ 起点必须回到**行首**: `re: /` 前面还有 "      { "，从 re: 开始切会把那个
    // 悬空的 `{ ` 留在副本里，副本语法破碎、跑不出汇总行 —— 而"副本跑失败"会被
    // 误读成"声称消失了"(cycle 206 的形状: 仪器测的不是它要测的东西)。
    const keyAt = orig.lastIndexOf('re: /', start);
    const closeAt = orig.indexOf('},', start);
    assertTrue(keyAt > 0 && closeAt > start, '找不到该条的起止 —— 锚点已变');
    const lineStart = orig.lastIndexOf('\n', keyAt) + 1;
    const blockEnd = orig.indexOf('\n', closeAt) + 1;
    const removed = orig.slice(lineStart, blockEnd);
    assertEqual((removed.match(/re: \//g) || []).length, 1,
      '反向证明要删掉的块里有 ' + (removed.match(/re: \//g) || []).length + ' 个 re 字面量 —— 切片吃掉了别的 pattern');
    assertTrue(removed.length < 4000, '要删掉的块有 ' + removed.length + ' 字符 —— 切片范围不对');
    assertTrue(/^\s*\{\s*$|^\s*\{\s*re:/.test(removed.split('\n')[0]),
      '切片起点不在条目行首上 —— 会留下悬空的括号');
    const broken = orig.slice(0, lineStart) + orig.slice(blockEnd);
    assertTrue(broken !== orig && !broken.includes("what: 'recall rate (AGENTS 披露段)'"),
      '变异未生效 —— 锚点没匹配上, 本次反向证明无效');
    const tmp = path.join(ROOT, 'scripts', '_audit-broken-231.tmp.js');
    fs.writeFileSync(tmp, broken);
    const realOut = runAudit();
    const realTotal = Number((realOut.match(/文档声称总数:\s*(\d+)/) || [])[1]);
    try {
      const out = runAudit(tmp);
      assertTrue(/文档声称总数:\s*\d+/.test(out), '副本没有产出汇总行 —— 它跑失败了, 反向证明无效');
      const copyTotal = Number((out.match(/文档声称总数:\s*(\d+)/) || [])[1]);
      assertTrue(realTotal >= 100, '真实运行的声称总数 ' + realTotal + ' 异常小 —— 前提自证失败');
      assertEqual(copyTotal, realTotal - 1,
        '副本声称总数 ' + copyTotal + ' ≠ 真实 ' + realTotal + ' - 1(一个站点) —— 删掉的不只是 recall 这条');
      assertTrue(!/recall rate \(AGENTS 披露段\)/.test(out),
        '删掉整条模式后审计仍认出 recall 声称 —— 说明认出它的不是这条模式, 反向证明无效');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    assertTrue(!fs.existsSync(tmp), '临时副本没被删掉 —— 仓库里留下了 debris');
  }));

  // ── ⑦ 披露: 锚点唯一 + 精度一致 + 语料本地性 ───────────────
  test('披露: 锚点 current reading is 在全仓仍唯一, 且两个读数精度一致', () => withDocLock(() => {
    // 锚点唯一性是本轮精度的前提: 一旦别处也写 "current reading is",
    // 这条模式可能命中一句与本声明无关的话。
    const text = currentClaimsOnly(readDoc(AGENTS));
    const n = (text.match(/current reading is/g) || []).length;
    assertEqual(n, 1,
      'AGENTS.md 的当前声称区里 "current reading is" 出现 ' + n + ' 次 —— 锚点不再唯一, 需重估模式精度');
    // 两个读数必须同精度(一位小数): 精度不一致会造出一条与值无关的假不符
    const m = text.match(/current reading is\s*\*\*(\d+(?:\.\d+)?)%\s*FP\s*\/\s*(\d+(?:\.\d+)?)%\s*recall/);
    assertTrue(!!m, '找不到披露句的完整形态 —— 它被改写了?');
    assertTrue(m[1].includes('.') && m[2].includes('.'),
      '披露句的两个读数精度不一致("' + m[1] + '" / "' + m[2] + '") —— 会造出一条与值无关的假不符');
    // 语料本地性限定必须还在(它是这个读数唯一的诚实边界)
    assertTrue(/corpus-local/i.test(text), 'AGENTS.md 丢了 "corpus-local" 限定 —— 一个语料本地读数会被读成生产 SLO');
  }));
};
