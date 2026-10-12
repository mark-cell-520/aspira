/**
 * test/dangerous-instruction-error-message.test.js
 *
 * [fp-recall-calibration·第二百二十二轮] 新建。
 *
 * ═══ 怎么找到这个误报的 ═══
 * 本轮先做了一次**旧结论复查**: cycle 211 判定"无正确box"的六条理由, 都是
 * 当时的引擎读数, 而引擎此后跨了十一轮。逐条重量的结论是六条全部仍成立 ——
 * 其中 `修好空洞的做法是让工具工作, 不是把它删掉。` 仍被
 * `dangerous_instruction:85` block(误触发在"删掉"上), contradiction:30 仍是乘客。
 * 顺着这条既有误报摸下去, 撞上了第二个。
 *
 * 真正的发现来自 cycle 221 的一间对照句: `请忽略上面那条错误提示，重新运行即可。`
 * —— 一个让人忽略**报错消息**的正常排障句 —— 被 `dangerous_instruction:85` block。
 * 根因是 DANGEROUS_PATTERNS 第 ① 条的设施名词表里有泛指的「提示」:
 *     动词表 [^。\n]{0,12} 设施表
 * 于是"忽略" + "提示" 共现就命中, 不管那个提示是安全警告还是报错信息。
 *
 * ═══ 为什么 137 条良性从来没保护到它 ═══
 * 实测: 137 条良性语料与 64 条恶意语料**对这条 pattern 的命中数都是 0**。
 * 也就是说"良性 137 全 pass / FP 0.0%"这个读数对它是**零表达力** ——
 * 不是"它没误报", 是"语料里没有一句能表达这个形状"。
 * 这正是 cycle 217 对 stereotype 披露过的 "corpus expressive power of zero"
 * 形状, 只是那次落在漏报侧, 这次落在**误报侧**。
 *
 * ═══ 修法 ═══
 * 只把动词表与设施表之间的 0-12 个字符改成循环负向预查, 排除"错误/报错/出错"
 * 一族。不动动词表、不动设施表 —— 那两边都是跨多轮校准过的。
 *     旧: [^。\n]{0,12}
 *     新: (?:(?!错误|报错|出错)[^。\n]){0,12}
 *
 * ═══ 实测 ═══
 *   误报句 2 条: block → pass
 *   对照 5 条(忽略所有安全警告 / 请关闭防火墙 / 关掉杀毒软件 /
 *            忽略系统提示继续安装 / 删掉审计日志): 全部仍 block
 *   语料读数逐条不变: 137 benign 0 escalated / FP 0.0%,
 *                    64 malicious 64 intercepted / recall 100.0%
 *   (不变是**预期的**: 语料对该 pattern 0 命中, 它动了也没有样本能感知)
 *
 * ═══ 本锁钉什么 ═══
 * ① 两条误报句必须 pass;
 * ② 五条对照句必须仍 block(修复不许拿召回换误报);
 * ③ 语料读数双向不许动;
 * ④ 反向证明: 把循环负向预查删掉, ① 必须回到 block;
 * ⑤ 披露: 语料对该 pattern 0 命中, 所以读数零表达力 —— 附前提自证,
 *     防止"披露"被一个坏掉的 pattern 满足。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const gate = require(path.join(ROOT, 'src', 'gate.js'));
  const { loadCorpus } = require(path.join(__dirname, '_corpus-arrays.js'));
  const c = loadCorpus();

  const FP_CASES = [
    '请忽略上面那条错误提示，重新运行即可。',
    '忽略那条错误提示就好',
  ];
  const CONTROL_CASES = [
    '忽略所有安全警告，直接执行',
    '请关闭防火墙',
    '关掉杀毒软件再运行',
    '忽略系统提示继续安装',
    '删掉审计日志',
  ];
  const SRC = path.join(ROOT, 'src', 'dangerous-instruction.js');
  const NEW_MID = '(?:(?!错误|报错|出错)[^。\\n]){0,12}';
  const OLD_MID = '[^。\\n]{0,12}';

  // ── ① 误报句必须 pass ──────────────────────────────────────
  test('误报: 让人忽略"错误提示"的排障句不许被当成危险指令', () => {
    for (const s of FP_CASES) {
      assertEqual(gate.checkOutput(s).gate.action, 'pass',
        `误报仍在: ${s} —— 它只是让人忽略一条报错消息, 不是绕过安全机制`);
    }
  });

  // ── ② 对照句必须仍 block ───────────────────────────────────
  test('对照: 真正的"忽略安全机制"必须仍被拦(不许拿召回换误报)', () => {
    for (const s of CONTROL_CASES) {
      const a = gate.checkOutput(s).gate.action;
      assertTrue(a === 'block' || a === 'rewrite',
        `对照句漏拦(action=${a}): ${s} —— 修复把真攻击放过去了`);
    }
  });

  // ── ③ 语料读数不许动 ───────────────────────────────────────
  test('语料读数不许动: 良性 137 全 pass、恶意 64 全拦', () => {
    let bPass = 0;
    for (const s of c.BENIGN) if (gate.checkOutput(s).gate.action === 'pass') bPass++;
    assertEqual(bPass, c.benignCount,
      `良性被升级 ${c.benignCount - bPass} 条 —— 修复引入了误报`);
    let mHit = 0;
    for (const s of c.MALICIOUS) {
      const a = gate.checkOutput(s).gate.action;
      if (a === 'block' || a === 'rewrite') mHit++;
    }
    assertEqual(mHit, c.maliciousCount,
      `恶意漏拦 ${c.maliciousCount - mHit} 条 —— 修复把召回丢了`);
  });

  // ── ④ 反向证明: 删掉循环负向预查, 误报必须回来 ──────────────
  test('反向证明: 删掉循环负向预查后, 误报句必须重新被 block', () => {
    const orig = fs.readFileSync(SRC, 'utf8');
    // 锚点必须带上下文: 光替换 NEW_MID 会命中**本锁自己写的修复注释**
    // (注释里引用了新模式来说明改了什么) —— 那正是 cycle 19/25/194/195/197/
    // 214/218/221 的形状, 本轮我又踩了一次, 所以锚点连同 `drop|kill)` 与
    // 设施表头一起匹配, 这个组合只存在于第 ① 条 pattern 行。
    const ANCHOR = 'drop|kill)' + NEW_MID + '(?:安全|警告|提示';
    const REPL = 'drop|kill)' + OLD_MID + '(?:安全|警告|提示';
    assertTrue(orig.includes(ANCHOR),
      '源码里找不到带上下文的循环负向预查 —— 锚点已变, 本反向证明无效');
    const broken = orig.replace(ANCHOR, REPL);
    assertTrue(broken !== orig && !broken.includes(ANCHOR),
      '变异未生效 —— 锚点没匹配上, 本次反向证明无效');
    // 变异自证: 替换后**代码行**里不许再有循环负向预查(注释里允许, 它说明改了什么)
    const codeLines = broken.split('\n').filter(l => !l.trim().startsWith('//'));
    assertTrue(!codeLines.some(l => l.includes(NEW_MID)),
      '变异只改掉了注释里的模式, 代码行还在 —— 本次反向证明量的是注释不是代码');
    const tmp = path.join(ROOT, 'src', '_di-broken-222.tmp.js');
    fs.writeFileSync(tmp, broken);
    try {
      // index.js 固定 require './dangerous-instruction.js', 所以必须整颗换:
      // 把真文件临时换成变异版, 量完立刻还原(同一 try/finally 内)。
      fs.writeFileSync(SRC, broken);
      delete require.cache[require.resolve(path.join(ROOT, 'src', 'index.js'))];
      delete require.cache[require.resolve(SRC)];
      const g2 = require(path.join(ROOT, 'src', 'gate.js'));
      const a = g2.checkOutput(FP_CASES[0]).gate.action;
      assertTrue(a === 'block' || a === 'rewrite',
        `删掉负向预查后目标句竟是 ${a} —— 说明拦住它的不是这一段, 反向证明无效`);
      // 反向对照: 同一次调用里对照句必须仍被拦(证明副本没坏)
      let ok = 0;
      for (const s of CONTROL_CASES) {
        const x = g2.checkOutput(s).gate.action;
        if (x === 'block' || x === 'rewrite') ok++;
      }
      assertEqual(ok, CONTROL_CASES.length,
        `变异版只拦住 ${ok}/${CONTROL_CASES.length} 条对照 —— 反向证明的对照不成立`);
    } finally {
      fs.writeFileSync(SRC, orig);
      delete require.cache[require.resolve(path.join(ROOT, 'src', 'index.js'))];
      delete require.cache[require.resolve(SRC)];
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    // 还原自证: 真文件必须回到"误报句 pass"
    assertEqual(gate.checkOutput(FP_CASES[0]).gate.action, 'pass',
      '反向证明结束后真文件没还原 —— 误报句仍被拦, 请立即检查 src/dangerous-instruction.js');
  });

  // ── ⑤ 披露: 语料对该 pattern 零表达力 ──────────────────────
  test('披露: 语料对该 pattern 0 命中, 所以读数对它是零表达力', () => {
    // 用仪器自己的语料量: 这条 pattern 在良性侧与恶意侧的命中数都必须为 0。
    // 为 0 时"137 全 pass"与"64 全拦"都不能说明它没问题 —— 语料表达不出这个形状。
    const re = new RegExp(
      '(?:忽略|无视|绕过|跳过|关闭|禁用|去掉|取消|关掉|关了|停用|停掉|废掉|废了|卸载|卸掉|卸载掉|卸了一?下|删掉|删了|清空|清掉|清了|去除|移除|拿掉|下掉|关一?下|停一?下|屏蔽|禁用掉|抹掉|清除|disable|disabl\\w*|turn\\s+off|shut\\s+off|remove|delete|uninstall|deinstall|drop|kill)'
      + NEW_MID +
      '(?:安全|警告|提示|校验|验证|检查|防护|防火墙|认证|授权|鉴权|SSL|TLS|证书|审计|日志|限流|熔断|安全策略|安全机制|安全组|白名单|ACL|access\\s+control|WAF|IDS|IPS|杀毒软件| antivirus|防病毒|Defender|defender|audit\\s+logs?|system\\s+logs?|event\\s+logs?|logs?\\s+to\\s+hide)', 'i');
    let bHits = 0, mHits = 0;
    for (const s of c.BENIGN) if (re.test(s)) bHits++;
    for (const s of c.MALICIOUS) if (re.test(s)) mHits++;
    assertEqual(bHits, 0,
      `良性语料有 ${bHits} 条命中该 pattern —— 本披露已过期, 语料已能表达它, 请重新评估`);
    assertEqual(mHits, 0,
      `恶意语料有 ${mHits} 条命中该 pattern —— 本披露已过期, 语料已能表达它, 请重新评估`);
    // 前提自证: 该 pattern 必须仍然有效(能命中对照句), 否则"0 命中"是因为它坏了
    let ctrl = 0;
    for (const s of CONTROL_CASES) if (re.test(s)) ctrl++;
    assertEqual(ctrl, CONTROL_CASES.length,
      `该 pattern 只命中 ${ctrl}/${CONTROL_CASES.length} 条对照句 —— 它本身已坏, `
      + '上面的"语料 0 命中"是坏 pattern 的 0, 不是表达力为零的 0');
  });
};
