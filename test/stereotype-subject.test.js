/**
 * test/stereotype-subject.test.js — stereotype 主语缺口的双向锁定
 *
 * 背景（第九十七轮量到, 第一百零二轮修, 第一百零三轮上锁）:
 * 第九十七轮按 STEREOTYPE_PATTERNS 的 zh/en 字面量写探针, 量到:
 *   '他们骨子里就是懒' 命中(stereotype count=1 → verify)
 *   '男人就是天生不擅长表达情感' **count=0 → pass**
 * 同一个判断只因为换了主语就漏 —— inherent_trait 族原来只有**他们**开头这一支。
 * corpus 永远看不见这种缺口, 因为 corpus 不按正则的分支结构铺样本。
 *
 * 第一百零二轮补了两条同形支路([男女]人 与 这种人 开头, 判据仍靠后面的
 * '就是|天然|骨子里|本来' 兜住), 实测 11/11 正例全中、5 个反向控制 0 误报。
 *
 * **反向控制里有两条是故意写进去的良性性别句**: '男人应该照顾好自己的身体'
 * 与 '女人也能成为优秀的工程师'。它们不含 '就是|天生|骨子里|本来', 所以新支路
 * 不命中。这两条钉的是**判据存在的意义** —— 放宽主语是唯一需要被约束的地方。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=mount 函数导出。
 */
module.exports = function ({ test, assertEqual }) {
  const idx = require('../src/index.js');
  const hit = t => { const d = idx.discriminate(t, []); return { count: ((d.dimensions || {}).stereotype || {}).count || 0, gate: d.gate.action }; };

  // 主语放宽后必须全部命中(第九十七轮的 9 个 + 新补的 2 个)
  const POSITIVE = [
    '所有程序员都是邋遢的',
    '男人就是天生不擅长表达情感',
    '女人就应该待在家里',
    '这种人根本不可理喻',
    '他们骨子里就是懒',
    'XX省的人都很有钱',
    '岁数大的人就是保守',
    '所有女人都很情绪化',
    '所有男人都喜欢体育',
    '这种人就是改不了',
    '男人骨子里就是懒',
  ];

  // 反向控制: 具体陈述 + **故意写的良性性别句**
  const NEGATIVE = [
    '这个函数的返回值为空时应该抛错',
    '测试覆盖从 1435 升到 1472',
    'The team shipped 3 releases this quarter',
    '男人应该照顾好自己的身体',
    '女人也能成为优秀的工程师',
  ];

  test('拓宽后的主语支路: 11 个正例必须全部命中 stereotype', () => {
    const missed = POSITIVE.filter(t => hit(t).count === 0);
    assertEqual(missed.length, 0, '以下正例未命中: ' + JSON.stringify(missed));
  });

  test('命中的必须推 gate(至少 verify)', () => {
    for (const t of POSITIVE) {
      const g = hit(t).gate;
      assertEqual(g === 'verify' || g === 'rewrite' || g === 'block', true,
        JSON.stringify(t) + ' 命中但门禁未抬级, 实得 ' + g);
    }
  });

  test('反向控制: 5 个良性句不得命中 stereotype', () => {
    const fired = NEGATIVE.filter(t => hit(t).count !== 0);
    assertEqual(fired.length, 0, '以下良性句被误判: ' + JSON.stringify(fired));
  });

  test('故意写的两条良性性别句必须 pass(钉住判据的意义)', () => {
    // 这是本文件最重要的一条。放宽主语必须被后面的 '就是|天生|骨子里|本来'
    // 约束; 若有人把主语支路放宽成无条件 '[男女]人.*', 这两条会立刻红。
    for (const t of ['男人应该照顾好自己的身体', '女人也能成为优秀的工程师']) {
      assertEqual(idx.discriminate(t, []).gate.action, 'pass', JSON.stringify(t) + ' 应为 pass');
    }
  });
};
