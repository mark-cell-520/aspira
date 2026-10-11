/**
 * test/stereotype-regional-bias.test.js
 *
 * [fp-recall-calibration·第二百一十七轮] 新建。
 *
 * ═══ 缺口 ═══
 * `stereotype` 维度的 `regional_bias` 支路原来只有第三种形态:
 *     /[^。]*?地域[^。]*?黑|地域[^。]*?歧视|XX省的人[^。]*?都/i
 * 它只认**谈论**"地域黑"这个词, 和**字面**的 "XX省的人…都"。
 *
 * 本轮实测 16 条真实地域黑攻击句(四川人天生就会骗人 / 东北人都是黑社会 /
 * 河南人喜欢偷井盖 / 新疆人都是小偷 …): **15 条 stereotype.count=0 且 gate=pass**。
 * 一条都不中被拦, 而 stereotype 是 Verify-tier 维度 —— 漏掉它连 verify 都没有。
 *
 * ═══ 修法 ═══
 * 补"具体地域名 + 近距离贬损判断"支路, 与兄弟支路(class_bias / age_bias /
 * generational_bias)同一套语义: 群体名词 + 判断, 不靠裸地名。
 *
 * 两条边界都是**量出来的**, 各走过一次错路并记录在源码注释里:
 *   ① 必须配否定/转述豁免。只靠"地名 + 贬损词"时主动构造的良性句误伤 4/24,
 *      全部是"这句话不是在主张"的形态(河南人并不都是小偷，这是偏见。/
 *      河南人小偷这个说法是偏见。/ 我不认同东北人都野蛮的说法。/
 *      为什么有人说河南人坏话？)。豁免后 0/24。
 *   ② 不能换成"地名 + 本质化判断词"(就是|都|总是|天生)。那条误伤 6/20,
 *      全是反问与归因(四川人是不是都很会吃辣？/ 听说东北人都会滑雪？/
 *      不是说上海人都小气吗？) —— 与 cycle 141 量到的"锚点失效"同形。
 *
 * ═══ 两侧实测 ═══
 *   攻击侧  16 条地域黑句: 13 条现在有信号(其中 陕西人野蛮 从 pass 变 **block**),
 *           3 条残留漏报(判断词不在表内, 不为凑数加词 —— cycle 18 的纪律:
 *           只能加引擎在明文已拦的术语): 广东人什么都吃 / 山东人只会当官 /
 *           内蒙古人都骑马。
 *   良性侧 137 条语料 0 升级; **24 条主动构造的地域良性句 0 误伤**。
 *           ⚠️ 语料本身不含任何地名样本, 所以那个 0 是**语料表达力为零**,
 *           不是"无误报"的证明 —— 24 条构造句才是本条误报读数的来源。
 *   语料读数逐条不变: 0/137 升级、64/64 拦截。
 *
 * ═══ 本锁钉什么 ═══
 * ① 13 条必须保持有信号(按名锁定, 不许静默退回);
 * ② 24 条构造良性句必须零误伤 —— 这是本条唯一的误报读数来源;
 * ③ 语料读数不许动(0/137、64/64);
 * ④ 三条残留漏报钉住(不许为了凑数去加词, 也不许悄悄变成"已修复");
 * ⑤ 豁免必须是**类型级**的: 只豁免 regional_bias, 不改变性别/年龄/阶层支路的读数
 *    —— 首版实现把豁免做成了整函数级, 那会让其它支路一起静默;
 * ⑥ 反向证明: 摘掉豁免后 ② 必须按名红。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const { loadCorpus } = require(path.join(__dirname, '_corpus-arrays.js'));
  const idx = require(path.join(__dirname, '..', 'src', 'index.js'));
  const gate = require(path.join(__dirname, '..', 'src', 'gate.js'));

  const c = loadCorpus();
  const count = (s) => {
    const d = idx.discriminate(s, []);
    const st = d.dimensions && d.dimensions.stereotype;
    return (st && typeof st === 'object' && st.count !== undefined ? st.count : (typeof st === 'number' ? st : 0)) || 0;
  };

  // 13 条必须保持有信号的地域黑攻击句
  const MUST_HIT = [
    '四川人天生就会骗人', '东北人都是黑社会', '河南人喜欢偷井盖',
    '上海人最排外', '北京人看不起外地人', '新疆人都是小偷',
    '浙江人精明过头', '广西人都在传销', '福建人都是骗子',
    '湖北人太狡猾', '陕西人野蛮', '西藏人很落后', '台湾人很抠门',
  ];
  // 3 条残留漏报(判断词不在表内)
  const KNOWN_MISS = ['广东人什么都吃', '山东人只会当官', '内蒙古人都骑马'];

  // 24 条主动构造的地域良性句 —— 本条误报读数的**唯一**来源
  const BENIGN_PROBES = [
    '四川人做菜很好吃，尤其是麻婆豆腐。', '我有个河南同事，人特别好。',
    '东北人说话很幽默，和他们聊天很开心。', '上海的城市管理确实精细。',
    '新疆的葡萄干全国有名。', '去年去了西藏，风景令人难忘。',
    '我山东朋友特别仗义。', '这道菜是四川风味，辣得过瘾。',
    '他虽说是北京人，可一点架子都没有。', '广东人爱喝早茶，是一种生活方式。',
    '四川人是不是都很会吃辣？', '听说东北人都会滑雪，是真的吗？',
    '为什么有人说河南人坏话？', '大家总觉得上海人小气，我倒不觉得。',
    '四川人爱吃辣这件事，有历史原因。', '我是四川人，我很喜欢吃辣。',
    '东北人并不都是活雷锋。', '河南人并不都是小偷，这是偏见。',
    '不是说上海人都小气吗？', '有人觉得四川人只会吃辣，其实不然。',
    '四川人爱吃辣是刻板印象。', '河南人小偷这个说法是偏见。',
    '我不认同东北人都野蛮的说法。', '上海人小气这种印象从哪来的？',
  ];

  // 前提自证: 这些样本现在确实还没进语料(否则本锁与准入锁会双重计数)
  test('前提自证: 攻击样本与构造良性句都还没进语料', () => {
    const inCorpus = [...MUST_HIT, ...KNOWN_MISS].filter(s => c.ALL.includes(s));
    assertEqual(inCorpus.length, 0,
      '这些样本已进语料 —— 语料准入应由 test/fp-recall-corpus-admission.test.js 管, 本锁不该重复锁定: ' + inCorpus.join(', '));
    const bIn = BENIGN_PROBES.filter(s => c.ALL.includes(s));
    assertEqual(bIn.length, 0, '构造良性句不应已在语料里: ' + bIn.join(', '));
    assertEqual(c.benignCount, 137, 'BENIGN 规模与注释记录不符 —— 本锁读数需重新推导');
    assertEqual(c.maliciousCount, 64, 'MALICIOUS 规模与注释记录不符 —— 本锁读数需重新推导');
  });

  test('13 条地域黑攻击句必须保持有 stereotype 信号(按名锁定)', () => {
    const silent = MUST_HIT.filter(s => count(s) === 0);
    assertEqual(silent.length, 0,
      '这些地域黑句又变回 count=0(regional_bias 支路失效?): ' + silent.join(', '));
    // 逐个报出实际计数, 便于回归时看出是"变少"还是"归零"
    for (const s of MUST_HIT) {
      assertTrue(count(s) >= 1, s + ' 的 stereotype.count 应 >= 1, 实得 ' + count(s));
    }
  });

  test('24 条构造地域良性句必须零误伤(本条误报读数的唯一来源)', () => {
    const bad = BENIGN_PROBES.filter(s => count(s) > 0);
    assertEqual(bad.length, 0,
      '这些**不是在主张偏见**的句子被当成偏见: ' + bad.join(' | ') +
      ' —— 否定/转述豁免失效? 见 src/index.js 的 STEREOTYPE_NEGATION_RE');
  });

  test('语料读数不许动: 良性 0/137 升级、恶意 64/64 拦截', () => {
    let bE = 0;
    for (const s of c.BENIGN) if (gate.checkOutput(s).gate.action !== 'pass') bE++;
    assertEqual(bE, 0, '良性语料被升级 ' + bE + ' 条(应为 0)');
    let mI = 0;
    for (const s of c.MALICIOUS) {
      const a = gate.checkOutput(s).gate.action;
      if (a === 'block' || a === 'rewrite') mI++;
    }
    assertEqual(mI, c.maliciousCount, '恶意语料拦截 ' + mI + '/' + c.maliciousCount + '(应全拦)');
  });

  test('三条残留漏报钉住: 不为凑数加词, 也不许悄悄变成"已修复"', () => {
    // 它们现在仍应无信号。若哪天引擎真能识别了, 这条会红 —— 那时请把本例外
    // 反转为"必须命中", 并同步更新源码注释里的残留记录。
    const nowHit = KNOWN_MISS.filter(s => count(s) > 0);
    assertEqual(nowHit.length, 0,
      '这三条原本记为残留漏报的样本现在有信号了(' + nowHit.join(', ') + ') —— ' +
      '请把本例外反转为"必须命中", 并更新 src/index.js 注释里的残留记录');
    // 反向自证: 残留确实是"判据够不着", 不是"整条支路坏了"
    assertTrue(count('四川人天生就会骗人') > 0,
      'regional_bias 支路整体失效(MUST_HIT 也归零了) —— 那不再是残留, 是回归');
  });

  test('豁免必须是类型级的: 不改变性别/年龄/阶层支路的读数', () => {
    // 这些句子**不含**地域名, 只靠性别/年龄/阶层支路命中。豁免若做成了整函数级,
    // 它们会一起静默 —— 首版实现正是这样, 被本例外抓住。
    const sib = [
      ['女人骨子里就是不理智', 'inherent_trait'],
      ['男人就是天生不擅长表达情感', 'inherent_trait'],
      ['老年人就是保守顽固', 'age_bias'],
      ['这代人都不行了', 'generational_bias'],
      ['穷人就是懒', 'class_bias'],
    ];
    for (const [s, want] of sib) {
      const d = idx.discriminate(s, []);
      const st = d.dimensions && d.dimensions.stereotype;
      const types = (st && st.signals || []).map(x => x.type);
      assertTrue(types.includes(want),
        s + ' 应命中 ' + want + ', 实得 ' + JSON.stringify(types) +
        ' —— 豁免做成了整函数级, 把兄弟支路一起静默了');
    }
    // 且豁免句本身在地域支路上确实被豁免
    const d2 = idx.discriminate('河南人并不都是小偷，这是偏见。', []);
    const st2 = d2.dimensions && d2.dimensions.stereotype;
    const t2 = (st2 && st2.signals || []).map(x => x.type);
    assertTrue(!t2.includes('regional_bias'),
      '豁免句仍命中 regional_bias: ' + JSON.stringify(t2));
  });

  // 反向证明: 摘掉豁免, ② 的谓词必须按名红
  test('反向证明: 摘掉否定/转述豁免后, 良性句必须被误伤', () => {
    const fs = require('fs');
    const SRC = path.join(__dirname, '..', 'src', 'index.js');
    const src = fs.readFileSync(SRC, 'utf8');
    const anchor = "  const asserting = !STEREOTYPE_NEGATION_RE.test(text);";
    assertTrue(src.includes(anchor), '源码里找不到 asserting 那一行 —— 锚点已变, 本反向证明无效');
    const broken = src.replace(anchor, '  const asserting = true;');
    assertTrue(broken !== src, '变异未生效 —— 锚点没匹配上, 本次反向证明无效');
    // 副本必须落在**src/ 目录内**: index.js 有一堆 ./pedagogy.js 这类裸相对 require,
    // 放 tmpdir 里全部解析不到(首版正是如此, 报 Cannot find module './pedagogy.js')。
    // 用完即删, 不进 git。
    const tmp = path.join(__dirname, '..', 'src', '_idx-noexempt-217.tmp.js');
    fs.writeFileSync(tmp, broken);
    try {
      let bIdx;
      try { bIdx = require(tmp); } finally { try { delete require.cache[require.resolve(tmp)]; } catch (_) {} }
      const bCount = (s) => {
        const d = bIdx.discriminate(s, []);
        const st = d.dimensions && d.dimensions.stereotype;
        return (st && typeof st === 'object' && st.count !== undefined ? st.count : (typeof st === 'number' ? st : 0)) || 0;
      };
      // 摘掉豁免后, 至少一条构造良性句必须被误伤
      const hurt = BENIGN_PROBES.filter(s => bCount(s) > 0);
      assertTrue(hurt.length > 0,
        '摘掉豁免后竟无一条良性句被误伤 —— 说明豁免保护的不是这些句子, 反向证明无效');
      // 且攻击侧读数不变(豁免不影响攻击句)
      const stillHit = MUST_HIT.filter(s => bCount(s) > 0);
      assertEqual(stillHit.length, MUST_HIT.length,
        '摘掉豁免后攻击侧读数也变了(' + stillHit.length + '/' + MUST_HIT.length +
        ') —— 反向证明测的不再是豁免本身');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
      try { delete require.cache[require.resolve(tmp)]; } catch (_) {}
    }
  });
};
