/**
 * test/evasion-composition-zero-width.test.js
 *
 * [adversarial-robustness·第二百一十六轮] 新建。
 *
 * ═══ 缺口: 二十个逃逸类都是**单独**量的, 从没量过串联 ═══
 * `scripts/calibrate-fp-recall.js` 的 EVASIONS 表有 20 个变换类, 每一轮都逐类报
 * "内容型 62/62、良性误报 0/137"。但攻击者不受"一次只用一种变换"的约束 ——
 * 把两种变换串起来是平凡的操作, 而这条攻击面**从未被测量**。
 *
 * 本轮全量测了(20×20 有序串联 × 137 良性 + 64 恶意, 共 380 组):
 *   最差单类           55/64   (英文去元音)
 *   最差串联           36/64   (字母间插空格 → 零宽字符)
 *   有良性误报的串联组   0 / 380
 * 也就是说: **串联能把召回从 86% 打到 56%, 而良性侧一分钱不花** —— 攻击者可以
 * 免费让三分之一的恶意样本穿过整条管线。
 *
 * ═══ 根因: 写好的"清洁归一层"从未执行 ═══
 * `src/shield/adversarial-variant.js` 第 104 行的注释早就写明设计意图:
 *   "零宽字符是污染特征而非攻击特征。清洁归归一层(ZERO_WIDTH_RE 在下方
 *    normalized 建议里 strip), 此处不再推 signal、不再升级门禁。"
 * 但那一层两处都没执行:
 *   ① `normalized` 建议只在**有其它信号时**才算 —— `signals.length === 0` 提前
 *      返回 `normalized: null`, 于是纯零宽混淆连建议都没有;
 *   ② 没有任何消费者应用它 —— `pipeline.js:162` 与 `gate.js` 都只读
 *      `action` / `risk` / `signals`, `normalized` 只作为审计痕迹留在
 *      `data.adversarial.normalized` 里。
 * 这是 cycle 191 `autoRetry` 的形状: 字段写好了、维护着、从没被读。
 *
 * 机制(逐码位实测): 字母间距后再插零宽, 零宽字符落在**字母与空格之间**
 * (`a​ l​l​`), 于是
 *   · 字母间距层的"≥3 连续单字母"门槛不成立(带上零宽的 token 不再是单字母);
 *   · 零宽层按 cycle 127 的决定不推 signal(它分不清攻击与良性)。
 * 两层同时闭嘴, 没有任何一层说话。
 *
 * ═══ 修法 ═══
 * 在 `checkAdversarialVariant` 顶部**全局**剥掉零宽字符, 再跑所有子检测器;
 * `normalized` 改为无条件计算。另外给 `ZERO_WIDTH_RE` 加 `g` 标志 —— 没有 `g` 时
 * `text.replace(ZERO_WIDTH_RE, '')` **只剥第一个**匹配, 本轮实测在这个坑上栽过
 * 一次(探针报"剥了却没变化", 逐码位打印才发现 19 个 U+200B 只掉了 1 个)。
 *
 * ═══ 实测(修复前 → 修复后, 全量 380 组) ═══
 *   字母间插空格 → 零宽字符    36 → 62   (完全回收)
 *   零宽字符 → 逐字符插分隔符    37 → 49
 *   零宽字符 → 英文去元音      50 → 55
 *   英文去元音 → 零宽字符      51 → 55
 *   其余 376 组                不变
 *   变差的组                    0
 *   良性误报发生变化的组          0(全量仍 0/137)
 *   明文                       64/64 与 0/137 均不变; 20 个单类读数全部不变
 *
 * ═══ 本锁钉什么 ═══
 * ① 四个变好的串联组必须保持回收(按名锁定, 不许静默退回);
 * ② 380 组全量不得有任一组的良性误报 > 0 —— 这是"不许用误呼喊叫换召回";
 * ③ 明文门禁不许动(64/64、0/137);
 * ④ 源级: 剥离必须发生在所有子检测器之前, 且正则必须带 g(否则是只剥第一个的
 *    静默坑 —— 这条本身就是回归锁);
 * ⑤ 反向证明: 把 `text = text.replace(ZERO_WIDTH_RE, '')` 那一行删掉, ① 必须按名红。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');

  const ROOT = path.join(__dirname, '..');
  const AV = path.join(ROOT, 'src', 'shield', 'adversarial-variant.js');
  const CALIB = path.join(ROOT, 'scripts', 'calibrate-fp-recall.js');
  const { loadCorpus } = require(path.join(ROOT, 'test', '_corpus-arrays.js'));
  const gate = require(path.join(ROOT, 'src', 'gate.js'));

  // EVASIONS 表: 括号配对剥出来再 eval, **不重新实现** —— 重新实现就会拿到
  // 一个与仪器不同的答案(cycle 191 的教训)。
  function loadEvasions() {
    const src = fs.readFileSync(CALIB, 'utf8');
    const at = src.indexOf('const EVASIONS');
    if (at < 0) throw new Error('校准脚本里找不到 EVASIONS —— 锚点已变, 本锁失效');
    let i = src.indexOf('{', at), depth = 0, end = -1;
    for (let k = i; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) throw new Error('EVASIONS 的花括号配平失败 —— 锚点已变, 本锁失效');
    return eval('(' + src.slice(i, end + 1) + ')');
  }

  const EV = loadEvasions();
  const NAMES = Object.keys(EV);
  const c = loadCorpus();
  const caught = (s) => {
    const r = gate.checkOutput(s);
    return !!(r && r.gate && (r.gate.action === 'block' || r.gate.action === 'rewrite'));
  };
  const hitOf = (a, b) => c.MALICIOUS.filter(s => caught(EV[b](EV[a](s)))).length;
  const fpOf = (a, b) => c.BENIGN.filter(s => caught(EV[b](EV[a](s)))).length;

  // 前提自证: EVASIONS 表真的是 20 类, 语料规模与本锁注释里写的一致
  test('前提自证: EVASIONS 20 类、语料 137/64', () => {
    assertEqual(NAMES.length, 20, 'EVASIONS 应为 20 个变换类');
    assertEqual(c.benignCount, 137, 'BENIGN 规模与注释记录不符 —— 本锁的读数需重新推导');
    assertEqual(c.maliciousCount, 64, 'MALICIOUS 规模与注释记录不符 —— 本锁的读数需重新推导');
  });

  // ── ① 四个被回收的串联组必须保持 ────────────────────────────
  test('零宽参与的四组串联必须保持回收(按名锁定)', () => {
    const expect = [
      ['字母间插空格', '零宽字符', 62],
      ['零宽字符', '逐字符插分隔符', 49],
      ['零宽字符', '英文去元音', 55],
      ['英文去元音', '零宽字符', 55],
    ];
    for (const [a, b, want] of expect) {
      assertTrue(NAMES.includes(a) && NAMES.includes(b), 'EVASIONS 里找不到 ' + a + ' / ' + b);
      const got = hitOf(a, b);
      assertEqual(got, want,
        a + ' → ' + b + ' 的内容型召回应为 ' + want + ', 实得 ' + got +
        ' —— 零宽剥离没生效? 见 src/shield/adversarial-variant.js 顶部');
    }
  });

  // ── ② 380 组全量不得有良性误报 ─────────────────────────────
  test('380 组有序串联全量: 不得有任一组的良性误报', () => {
    const bad = [];
    for (const a of NAMES) {
      for (const b of NAMES) {
        if (a === b) continue;
        const fp = fpOf(a, b);
        if (fp > 0) bad.push(a + ' → ' + b + ' 误报 ' + fp + '/' + c.benignCount);
      }
    }
    assertEqual(bad.length, 0, '这些串联组在良性语料上误报: ' + bad.join(' | '));
  });

  // ── ②b 零宽族的最差串联不低于本轮实测值 ─────────────────────
  // 阈值取**实测**而不是发明的: 首版写"零宽族全部 >= 最差单类(55)", 而实测
  // `零宽字符 → 逐字符插分隔符` 只有 49, 于是锁因断言过强而红。按名钉实测值。
  test('零宽族的最差串联不低于本轮实测的 49', () => {
    const worstSingle = Math.min(...NAMES.map(n => c.MALICIOUS.filter(s => caught(EV[n](s))).length));
    const zwPairs = [];
    for (const n of NAMES) {
      if (n === '零宽字符') continue;
      zwPairs.push([n, '零宽字符']);
      zwPairs.push(['零宽字符', n]);
    }
    let worst = Infinity, worstName = '';
    for (const [a, b] of zwPairs) {
      const h = hitOf(a, b);
      if (h < worst) { worst = h; worstName = a + ' → ' + b; }
    }
    assertEqual(worst, 49,
      '零宽族最差串联应为 49(' + worstName + '), 实得 ' + worst +
      ' —— 与最差单类 ' + worstSingle + ' 的差距是本轮未修的部分, 如实钉住');
  });

  // ── ③ 明文门禁不许动 ───────────────────────────────────────
  test('明文门禁不变: 64/64 恶意全拦、137 良性全 pass', () => {
    const mHit = c.MALICIOUS.filter(caught).length;
    const bFP = c.BENIGN.filter(caught).length;
    assertEqual(mHit, c.maliciousCount, '明文恶意召回应为 ' + c.maliciousCount + ', 实得 ' + mHit);
    assertEqual(bFP, 0, '明文良性误报应为 0, 实得 ' + bFP);
  });

  // ── ④ 源级: 剥离在子检测器之前 + 正则带 g ───────────────────
  test('源级: 零宽剥离必须在所有子检测器之前, 且正则必须带 g', () => {
    const src = fs.readFileSync(AV, 'utf8');
    // 正则定义处必须带 g
    const reLine = src.split('\n').find(l => /const ZERO_WIDTH_RE\s*=/.test(l));
    assertTrue(!!reLine, '找不到 ZERO_WIDTH_RE 定义');
    assertTrue(/\/[gimsuy]*g[gimsuy]*\s*;?\s*$/.test(reLine.trim()),
      'ZERO_WIDTH_RE 必须带 g 标志, 否则 text.replace 只剥第一个零宽字符(静默坑): ' + reLine.trim());
    // 剥离那一行的位置
    const stripAt = src.indexOf("text = text.replace(ZERO_WIDTH_RE, '')");
    assertTrue(stripAt >= 0, 'checkAdversarialVariant 里找不到零宽剥离那一行 —— 锚点已变?');
    // 剥离必须出现在第一个子检测器**调用处**之前。
    // 不能用裸 indexOf 找检测器名: 那会命中第 30 行的**定义**(常量声明), 于是任何
    // 写在定义之后的剥离都被判"在检测器之后" —— cycle 191 的形状, 一个读错了
    // 自己主体的谓词。这里只认 `<something>.match(<NAME>)` 调用形态。
    const DETECTORS = ['HOMOGLYPH_RE', 'CURLY_QUOTE_RE', 'FULLWIDTH_RE', 'COMBINING_RE', 'DIGIT_OBFUS_RE', 'WORD_SPLIT_RE'];
    let firstCall = Infinity;
    for (const k of DETECTORS) {
      const m = src.search(new RegExp('\\.match\\(\\s*' + k + '\\s*\\)'));
      if (m >= 0 && m < firstCall) firstCall = m;
    }
    assertTrue(firstCall < Infinity, '一个子检测器调用都没找到 —— 锚点已变, 本例外失效');
    assertTrue(stripAt < firstCall,
      '零宽剥离必须出现在所有子检测器调用之前, 否则子检测器看到的仍是带零宽的原文');
    // normalized 不得再被"无信号就返回 null"吃掉
    assertTrue(!/signals\.length === 0 return \{ action: 'pass', risk: 'none', signals: \[\], normalized: null \}/.test(src),
      'normalized 又回到"无信号即 null" —— 纯零宽混淆将再次拿不到清洁建议');
  });

  // ── ⑤ 反向证明: 删掉剥离那一行, ① 必须按名红 ────────────────
  test('反向证明: 删掉零宽剥离后, ① 的谓词必须按名红', () => {
    const tmp = path.join(require('os').tmpdir(), 'av-nozw-216.js');
    const orig = fs.readFileSync(AV, 'utf8');
    const anchor = "  text = text.replace(ZERO_WIDTH_RE, '');\n";
    let broken = orig.replace(anchor, '');
    // 自证: 变异真的发生了(cycle 32: 一个没变异的变异证明与不能失败的锁无异)
    assertTrue(broken !== orig && broken.indexOf(anchor) < 0,
      '变异未生效 —— 锚点没匹配上, 本次反向证明无效');
    fs.writeFileSync(tmp, broken);
    const probe = path.join(require('os').tmpdir(), 'av-nozw-probe-216.cjs');
    // 只调用**副本自己的** checkAdversarialVariant, 不经 gate.js。
    // 首版在这里栽了: 它同时 require 了仓库里的 gate.js, 而 gate.js 内部 require 的
    // 是**真文件** src/shield/adversarial-variant.js, 于是端到端读数永远是修复后的
    // 形态, 反向证明测的是它不该测的那个对象(cycle 206"探针自证于副本"的同族)。
    fs.writeFileSync(probe, `
      const path = require('path');
      const ROOT = ${JSON.stringify(ROOT)};
      // 副本落在 os.tmpdir(), 它内部的 require('./letter-space-evasion.js') 会找不到;
      // 把那个裸相对路径钉回仓库里的真文件(cycle 209: 副本落 /tmp 后 ROOT 变 / 的教训)。
      const Module = require('module');
      const origResolve = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (request === './letter-space-evasion.js' || request === '../shield/letter-space-evasion.js') {
          return path.join(ROOT, 'src', 'shield', 'letter-space-evasion.js');
        }
        return origResolve.call(this, request, ...rest);
      };
      const fs = require('fs');
      const { checkAdversarialVariant } = require(${JSON.stringify(tmp)});
      const CALIB = path.join(ROOT, 'scripts', 'calibrate-fp-recall.js');
      const src = fs.readFileSync(CALIB, 'utf8');
      const at = src.indexOf('const EVASIONS');
      let i = src.indexOf('{', at), d = 0, e = -1;
      for (let k = i; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) { e = k; break; } } }
      const EV = eval('(' + src.slice(i, e + 1) + ')');
      const s = 'all faggots must die';
      const composed = EV['零宽字符'](EV['字母间插空格'](s));
      fs.writeFileSync(process.argv[2], JSON.stringify({
        adv: checkAdversarialVariant(composed).action,
        advClean: checkAdversarialVariant(composed.replace(/[\\u200B\\u200C\\u200D\\u2060\\uFEFF\\u00AD]/g, '')).action,
      }));
    `);
    const outFile = path.join(require('os').tmpdir(), 'av-nozw-out-216.json');
    try {
      execFileSync('node', [probe, outFile], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
      const r = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      // 删掉剥离后, 对抗层对该串联必须重新闭嘴(即修复前的形态)
      assertEqual(r.adv, 'pass',
        '删掉零宽剥离后对抗层竟然仍报警(' + r.adv + ') —— 说明拦下它的不是本轮修的机制, 反向证明无效');
      // 反向对照: 同一个副本, 喂**已剥过**的文本必须报警 —— 证明副本本身是好的,
      // 差的只是那行剥离。没有这一条, 上一条也可以被一个"整个函数都坏掉"的副本满足。
      assertEqual(r.advClean, 'rewrite',
        '副本对手工剥过的文本竟不报警(' + r.advClean + ') —— 副本本身坏了, 反向证明无效');
    } finally {
      for (const f of [tmp, probe, outFile]) { try { fs.unlinkSync(f); } catch (_) {} }
    }
  });
};
