/**
 * test/corpus-dimension-reach-disclosure.test.js — 文档必须披露校准语料的维度触达面
 *
 * ═══ 第二百零三轮 ═══
 * 切片 dimension-health-audit。
 *
 * 仪器的逐维度表早就全绿: 54 维全部"曾触发且推 finding"，0 个"从不推"，
 * 0 个"从未触发"。但这个全绿回答的是"**维度还活着吗**"，不是"**校准读数
 * 覆盖了多少维度**"。`scripts/dimension-health-audit.js` 在 cycle 131 为此补了
 * 一段 corpus-only 报告，实测读数是:
 *
 *     语料 199 条上触发过的维度: 22/54
 *     语料从未触达的维度 32 个 —— 行为仅由测试字面量锁定,
 *       校准的 FP/recall 读数对它们零表达力
 *
 * 而 AGENTS.md 的 FP/recall 段**完全没有提这件事**。它说 "0.0% FP / 100% recall"，
 * 并劝读者"read it as 'no false positives this corpus can express'"——
 * 语气上已经留了余地，但**没有说这个语料只触达 22/54 个维度**。一个读者
 * 合理地会以为那个 0.0% 覆盖全部 54 维; 实测另外 32 个维度的误报与漏报行为
 * 它一句话都没说过。这正是本仓库反复记载的形状: **仪器看不见的风险等于不存在,
 * 直到它存在**——只不过这次仪器看见了，是文档没写。
 *
 * 修法: AGENTS.md 的 FP 段补上触达面披露，两个数字必须一起引用
 * (语料规模 199 条, 维度触达 22/54)。本锁锁的是**不变式**而不是字面值:
 *
 *   文档写的触达数  ==  实测触达数
 *
 * 语料此后每增长一次，文档不同步更新这条就红——所以它不可能悄悄漂移。
 * 反过来，若将来语料补全到触达全部 54 维，`reach < 54` 那条会红，
 * 那时按注释说明把披露改写成"无盲区"即可(那条断言的存在就是为了提醒这一刻)。
 *
 * ═══ 测量口径 ═══
 * 判据刻意走**裸 discriminate**(dimensions{} 键的 score>0)，与仪器一致，
 * 而不用 gate findings——后者会因 gate 聚合/降级把低分维度藏起来。
 * 信号判据复刻仪器的 `signalOf()` 取值顺序(与仪器同序，未导出故照抄)。
 * 复刻会有漂移风险，所以本锁加了两侧防呆: 实测触达数若恒 0 或恒 54，
 * "文档读数 == 实测读数" 一样会红，判据坏掉两个方向都逃不过去。
 *
 * ═══ 不执行校准脚本 ═══
 * `scripts/calibrate-fp-recall.js` 的顶层会跑完整校准并写
 * `data/feedback/`，所以这里只**解析**它的数组字面量，不 require 它。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const AGENTS = path.join(ROOT, 'AGENTS.md');
  const CALIB = path.join(ROOT, 'scripts', 'calibrate-fp-recall.js');

  // ─── 解析语料数组(不执行脚本) ──────────────────────────────────

  function parseCorpusArray(src, name) {
    const m = src.match(new RegExp('const ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\n\\];'));
    if (!m) throw new Error('找不到 ' + name + ' 数组字面量(锚点已变?)');
    const out = [];
    for (const line of m[1].split('\n')) {
      const s = line.match(/^\s*'((?:[^'\\]|\\.)*)'/);
      if (s) out.push(s[1].replace(/\\'/g, "'"));
    }
    return out;
  }

  function signalOf(v) {
    if (!v || typeof v !== 'object') return 0;
    for (const k of ['count', 'score', 'totalHits', 'hits', 'matches', 'claims', 'fallacies', 'signals', 'injections', 'risk']) {
      const x = v[k];
      if (typeof x === 'number' && x > 0) return x;
    }
    return 0;
  }

  // 文档里写的触达面读数: "维度触达 22/54"
  // (刻意不匹配「数字+个+维度」形态 —— 那正是审计的 dimensions 中文 pattern,
  //  见 AGENTS.md 第二百零三轮那段关于措辞的留证。)
  function documentedReach(agentsSrc) {
    const m = agentsSrc.match(/维度触达\s*(\d+)\s*\/\s*54/);
    return m ? parseInt(m[1], 10) : null;
  }

  function measure() {
    const idx = require(path.join(ROOT, 'src', 'gate.js'));
    const src = fs.readFileSync(CALIB, 'utf8');
    const corpus = parseCorpusArray(src, 'BENIGN').concat(parseCorpusArray(src, 'MALICIOUS'));
    const fired = new Set();
    for (const t of corpus) {
      let r;
      try { r = idx.discriminate(t, []); } catch (e) { continue; }
      const d = (r && r.dimensions) || {};
      for (const [k, v] of Object.entries(d)) if (signalOf(v) > 0) fired.add(k);
    }
    return { corpusSize: corpus.length, reach: fired.size };
  }

  // ─── 主不变式: 文档读数 == 实测读数 ───────────────────────────

  test('AGENTS.md 披露的语料维度触达数必须等于实测值(不写死, 语料增长即同步)', () => {
    const agents = fs.readFileSync(AGENTS, 'utf8');
    const doc = documentedReach(agents);
    assertTrue(doc !== null,
      'AGENTS.md 里找不到 "N / 54 个维度" 形态的触达面披露 —— 第二百零三轮补的那段被删了?');
    const { corpusSize, reach } = measure();
    assertTrue(corpusSize > 0, '语料解析出 0 条, 解析器坏了');
    assertEqual(doc, reach,
      `文档写触达 ${doc} / 54, 实测 ${reach} / 54(语料 ${corpusSize} 条)——` +
      '语料增长后文档没同步, 或披露被改动');
  });

  test('实测触达数必须真的小于 54(即盲区此刻存在, 防判据退化成恒 54)', () => {
    const { reach, corpusSize } = measure();
    assertTrue(reach > 0 && reach < 54,
      `实测触达 ${reach} / 54(语料 ${corpusSize} 条)。若为 0 说明信号判据坏了; ` +
      '若为 54 说明语料已补全——那时请把 AGENTS.md 的披露改写成"无盲区"，' +
      '并把本断言反转为 reach === 54');
  });

  test('语料规模必须与文档所称一致(防解析器悄悄少读)', () => {
    const src = fs.readFileSync(CALIB, 'utf8');
    const size = parseCorpusArray(src, 'BENIGN').length + parseCorpusArray(src, 'MALICIOUS').length;
    const agents = fs.readFileSync(AGENTS, 'utf8');
    const m = agents.match(/维度触达\s*\d+\s*\/\s*54[^。]*。?[^。]*?(\d+)\s*条/) || agents.match(/(\d+)\s*条[，,]\s*维度触达/);
    // 文档写的是"两个数字必须一起引用: 语料规模 199 条, 维度触达 22/54"
    const sizeM = agents.match(/语料\s*规模\s*(\d+)\s*条/);
    assertTrue(sizeM !== null, 'AGENTS.md 里找不到"语料规模 N 条"的披露');
    assertEqual(parseInt(sizeM[1], 10), size,
      `文档写语料规模 ${sizeM[1]} 条, 实测解析出 ${size} 条`);
  });

  // ─── 反向证明: 改错文档读数, 本锁必须能看见 ───────────────────

  test('反向证明: 文档读数被改错时, 主不变式必须红(证明它真能失败)', () => {
    const agents = fs.readFileSync(AGENTS, 'utf8');
    const real = documentedReach(agents);
    assertTrue(real !== null, '锚点不在, 反向证明无效');
    const wrong = real === 54 ? 53 : real + 1;
    const tampered = agents.replace(/(维度触达\s*)(\d+)(\s*\/\s*54)/, '$1' + wrong + '$3');
    assertTrue(tampered !== agents, '替换没有生效, 反向证明无效');
    assertEqual(documentedReach(tampered), wrong, '改动后的文档读数应等于改写的值');
    const { reach } = measure();
    assertTrue(wrong !== reach,
      `把文档读数从 ${real} 改成 ${wrong} 居然仍与实测一致 —— 要么实测也变了, ` +
      '要么本锁的探针失效');
  });

  // ─── 已披露: 本锁治不了的那一类 ─────────────────────────────

  test('已披露: 那 32 个未触达维度的 FP/recall 行为仍只由测试字面量锁定', () => {
    // 本锁只保证"文档披露的触达数与实测一致"，不保证触达面变大。
    // 把 32 个维度纳入校准视野需要补语料样本，是 fp-recall-calibration 切片的工作。
    const { reach } = measure();
    assertTrue(reach < 54,
      `触达面已到 ${reach}/54 —— 若这是真的，请删除本披露并把语料盲区改写为已闭合`);
  });
};
