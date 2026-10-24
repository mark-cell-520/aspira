// 情绪操纵检测死表接线回归测试
//
// 背景: src/index.js 里原有一张 EMOTIONAL_MANIPULATION_PATTERNS(zh 9 条 + en 9 条),
// 声明在文件中部、全仓零处读取 —— checkEmotionalManipulation() 从头到尾只读
// EM_MANIPULATION_PATTERNS, 那 18 条正则一次都没执行过。本轮把其中未被本表覆盖的
// 8 条并入活表并删掉死表。本文件锁住"并入的条目真的在跑", 防止再次退化成死表。
module.exports = function ({ test }) {
  const m = require('../src/index.js');

  // 1. 源级守卫: 活表必须包含并入的 8 条, 且死表不得复活
  test('源级: 并入的 8 条必须在 EM_MANIPULATION_PATTERNS 里，死表不得存在', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '../src/index.js'), 'utf8');
    const merged = [
      '你不[^，。]*?就会[^，。]*?(后悔|错过|损失|失去)',
      '如果你不[^。]*?你一定会[^。]*?(后悔|遗憾)',
      '难道你忍心[^。]*?[吗？]',
      '你忍心[^。]*?[吗？]',
      '你对得起[^。]*?[吗？]',
      "you('ll| will)[^.]*?regret it if",
      "don't you (care|love|want)",
      'how could you[^.]*?after',
    ];
    for (const frag of merged) {
      if (!src.includes(frag)) throw new Error(`并入条目缺失: ${frag}`);
    }
    if (/const\s+EMOTIONAL_MANIPULATION_PATTERNS\s*=/.test(src)) {
      throw new Error('死表 EMOTIONAL_MANIPULATION_PATTERNS 又回来了');
    }
  });

  // 2. 行为: 并入的中文条目必须真的命中(修复前全部 count=0)
  test('行为: 道德胁迫/内疚句式必须被检出(修复前恒 0)', () => {
    const cases = [
      ['你忍心看我这样吗？', 'moral_coercion'],
      ['难道你忍心拒绝一个孩子吗？', 'moral_coercion'],
      ['你对得起我们吗？', 'guilt_induction'],
      ['如果你不按时完成，你一定会后悔。', 'guilt_induction'],
      ['你不听我的话就会错过最后的机会', 'fear_marketing'],
    ];
    for (const [text, type] of cases) {
      const r = m.checkEmotionalManipulation(text);
      if (r.count === 0) throw new Error(`未检出: ${text}`);
      if (!r.manipulations.some(x => x.type === type)) {
        throw new Error(`${text} 期望命中 ${type}，实际 ${JSON.stringify(r.manipulations.map(x => x.type))}`);
      }
    }
  });

  // 3. 行为: 并入的英文条目必须真的命中
  test('behavior: merged English entries must fire', () => {
    const cases = [
      ["Don't you care about me at all?", 'moral_coercion'],
      ['How could you say that after everything?', 'moral_guilt'],
      ['You will regret it if you leave now', 'guilt_induction'],
    ];
    for (const [text, type] of cases) {
      const r = m.checkEmotionalManipulation(text);
      if (r.count === 0) throw new Error(`未检出: ${text}`);
      if (!r.manipulations.some(x => x.type === type)) {
        throw new Error(`${text} 期望命中 ${type}，实际 ${JSON.stringify(r.manipulations.map(x => x.type))}`);
      }
    }
  });

  // 4. 反向: 日常陈述不得被并入条目误伤
  test('反向: 日常中文/英文陈述不得误报', () => {
    const benign = [
      '今天天气不错，我们出去玩吧',
      '请问这个函数怎么实现？',
      '妈妈很担心你，记得按时吃饭',
      '我建议先读文档再动手改代码',
      'Could you review this pull request when you have time?',
    ];
    for (const text of benign) {
      const r = m.checkEmotionalManipulation(text);
      if (r.count !== 0) {
        throw new Error(`误报: ${text} -> ${JSON.stringify(r.manipulations.map(x => x.type))}`);
      }
    }
  });
};
