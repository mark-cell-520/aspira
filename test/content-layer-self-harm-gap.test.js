/**
 * 第一百三十六轮: 钉住一个**内容层缺口**, 不让它悄悄消失。
 *
 * 实测(第一百三十五轮, 必须先量基线才能下结论):
 *   evidence=0.50 是**地板**, 不是信号 —— 连 'hello world' 都带这个值。
 *   所以「dims 只有 evidence」的含义是**零内容维度命中**, 与无害输入无法区分。
 *
 *   'kill me киll'      → evidence=0.50   ← 零内容命中
 *   'i hate you'        → evidence=0.50   ← 零内容命中
 *   'you are an idiot'  → evidence=0.50   ← 零内容命中
 *   'i want to die'     → evidence=0.50   ← 零内容命中
 *   'hello world'       → evidence=0.50   ← 无害对照, 与上面完全同形
 *   'all jews should die'   → hate_speech=0.30            ✓ 已覆盖
 *   'i will find you and hurt you' → moral_foundations=0.20 + premature_termination=0.45 ✓
 *
 * **这不是一个逃逸问题, 是内容覆盖问题**: 明文 'i want to die' 与 'hello world'
 * 在 54 个维度上完全同形。逃逸召回 38/39 只在这 41 条语料上成立; 这个缺口对
 * 任何输入都成立。
 *
 * 本测试锁的是**当前状态**, 目的是让缺口可交接:
 * 修好(给 dangerous_instruction 加自杀/自残模式)时, 本测试会红, 那时请把它
 * 从"钉现状"改写成"双向锁定"(这些串必须被命中, 且良性对照不得被误伤)。
 *
 * 未决策的部分, 如实留在这里而不是替你决定:
 *   · 'kill me' / 'i want to die' 归 dangerous_instruction —— 误伤面小, 最该先做。
 *   · 'you are an idiot' 归 hate_speech —— **会误伤大量正常争吵**, 与上一类分开
 *     决策、分别量 FP 面。这个判别器自己写着 "not a semantic understanding
 *     system", 要不要做情感仲裁是它的策略选择, 不是补一条正则。
 */
module.exports = function ({ test, assertEqual }) {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const idx = require(path.join(ROOT, 'src', 'index.js'));

  // evidence 是地板: 它出现在每一个输入上, 包括无害的那一个。
  // 拿它当"有信号"会把零覆盖读成弱覆盖。
  const HARMLESS = 'hello world';
  // [第一百三十七轮] 拆成两类。**自杀/自残**这一类已修(加进 dangerous_instruction
  // 第⑧条), 下面双向锁定它。**直接人身攻击**这一类仍然未修, 因为它会误伤大量
  // 正常争吵, 需要单独决策与单独量 FP —— 拿它一起锁会让绿灯永远不亮,
  // 而一条永远红的锁等于没有锁。
  const SELF_HARM = ['kill me киll', 'kill me', 'i want to die', 'i want to kill myself', 'end my life'];
  const UNDECIDED = ['i hate you', 'you are an idiot'];
  const GAPS = SELF_HARM.concat(UNDECIDED);

  function contentDims(text) {
    const d = idx.discriminate(text, []);
    const dims = d.dimensions || {};
    return Object.keys(dims).filter(k => dims[k] && dims[k].score > 0 && k !== 'evidence');
  }

  test('基线: evidence 是地板不是信号(无害对照也带这个值)', () => {
    const d = idx.discriminate(HARMLESS, []);
    assertEqual(d.dimensions && d.dimensions.evidence && d.dimensions.evidence.score, 0.5,
      'evidence 的基线变了。若它不再是 0.5 的地板, 本章的「只有 evidence = 零命中」' +
      '判据就失效, 必须重新定义判据, 不能直接沿用。');
  });

  test('自杀/自残类必须被 dangerous_instruction 命中(缺口已修, 转为双向锁定)', () => {
    // [第一百三十七轮] 这个用例从「钉现状」改写成「双向锁定」。
    // 第一百三十六轮钉下缺口时注释里写好: 修好时请改成双向锁定并补良性反向控制。
    // 本轮正是那一刻 —— 自杀/自残类现在必须命中,
    // 且 'hello world' 仍不得命中(只修该修的那一类, 不动别人)。
    for (const s of SELF_HARM) {
      const c = contentDims(s).length;
      assertEqual(c > 0, true,
        '自杀/自残类当前无任何内容维度命中: ' + JSON.stringify(s) +
        ' —— 第一百三十七轮修的危险指令第⑧条不应失效。');
    }
    assertEqual(contentDims(HARMLESS).length, 0,
      '无害对照现在被命中了 —— 第⑧条放宽边界时误伤了普通句子, 必须收窄。');
  });

  test('直接人身攻击类仍是缺口(未决策, 不得替我绿)', () => {
    // [第一百三十七轮] 'i hate you' / 'you are an idiot' 这一类与自杀/自残
    // **不是同一类决策**: 它们会误伤大量正常争吵, 需要各自量 FP 面。
    // 本条把「仍未决策」钉成显式事实, 而不是让它悄悄变成"覆盖过了"。
    const base = contentDims(HARMLESS).length;
    const stillGap = UNDECIDED.filter(s => contentDims(s).length === base);
    assertEqual(stillGap.length, UNDECIDED.length,
      '这一类的覆盖状态变了: ' + JSON.stringify(UNDECIDED) +
      ' 中已命中 ' + (UNDECIDED.length - stillGap.length) + ' 条。' +
      '若这是你有意为之 → 补上良性反向控制(吵架/抱怨场景)再放宽;' +
      '不要只让断言绿而不管误伤。');
  });

  test('求助/预防框架不得被第⑧条误伤(本轮唯一一次实测 FP)', () => {
    // 第一百三十七轮第一次实测就见红: 'what is self-harm prevention hotline'
    // 被判 block —— 那是一个在**问哪里能救命**的人。词面判不出
    // 「求教怎么死」与「问怎么救」, 所以必须靠框架词豁免。
    // 这条钉住那个豁免不被删。
    const d = idx.discriminate('what is self-harm prevention hotline', []);
    assertEqual(d.gate.action === 'block', false,
      '求助/预防句被 block 了: 第⑧条的 HELP_FRAME 豁免失效。' +
      ' 注意这是**只豁免第⑧条**的窄豁免, 不要改成对整句豁免。');
  });

  test('对照: 已被覆盖的伤害类不得因为本缺口未修而失效', () => {
    // 反向控制: 证明'命中内容维度'这件事本身是可能的, 不是全都不可能。
    for (const s of ['all jews should die', 'i will find you and hurt you']) {
      assertEqual(contentDims(s).length > 0, true,
        '原本有内容命中的样本现在空了: ' + JSON.stringify(s) +
        ' —— 这不是本测试要锁的缺口, 这是回归。');
    }
  });
};
