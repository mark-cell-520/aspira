/**
 * frame-check-stateless-regex.test.js — 叙事框架检查的模式表无状态性
 *
 * 钉住的缺陷: frame-check.js 的四张模式表都是模块级 /g 正则，而 check() 对它们
 * 做的是裸 re.test(text)。带 g 的 test 从 re.lastIndex 起匹配并把 lastIndex 推到
 * 命中末尾，本文件命中之后没有任何 exec/match 去复位，于是同一个文本的读数取决于
 * 上一次 check() 留下了什么 —— 同一句连调三次，findings 在 1/0/1 之间跳，门禁在
 * pass 与 hedge/rewrite 之间反复。frame-check 是 pipeline Layer 6 的产出侧，而
 * Layer 6 是无条件覆写 currentGate 的，这个抖动直接进最终 gate.action。
 *
 * 同仓 doubt-engine.js 是反面参照: checkKnowledgeBoundary 显式写了
 * `re.lastIndex = 0`，checkDefensiveness 靠紧随其后的 text.match(re) 顺带复位，
 * 只有 frame-check 的四个循环两者都没有。
 */
const { check } = require('../src/frame-check.js');

module.exports = ({ test, assertEqual, assertTrue }) => {

  test('同一文本连续调用，读数恒定', () => {
    const s = '我们已经做到了同步。';
    const read = () => JSON.stringify(check(s).issues.map(i => i.category + i.severity));
    const first = read();
    for (let i = 0; i < 5; i++) {
      assertEqual(read(), first, `第 ${i + 2} 次调用与第 1 次不一致（模式表 lastIndex 未复位）`);
    }
  });

  test('前一次调用推进过 lastIndex 之后，句首短匹配仍然命中', () => {
    // 这条是反向证明：长文本先把 /(做到|完成|达成)了/g 的 lastIndex 推到文本中后部，
    // 之后任何一个 offset 0 处命中的短文本，在没有复位的版本上恒不命中（已实测）。
    const long = '我们已经做到了同步，后面还有很多事要做，真的做到了';
    assertTrue(
      check(long).issues.some(i => i.issue.includes('过程用完成态表达')),
      '长文本本身应命中 closure 的"过程用完成态表达"'
    );
    for (let i = 0; i < 4; i++) {
      assertTrue(
        check('做到了').issues.some(i => i.issue.includes('过程用完成态表达')),
        `第 ${i + 1} 次短文本调用漏判 —— lastIndex 被上一次调用留着`
      );
    }
  });

  test('英文模式表同样复位', () => {
    const en = 'this concludes the demo.';
    const read = () => JSON.stringify(check(en).issues);
    const first = read();
    for (let i = 0; i < 4; i++) assertEqual(read(), first, `英文第 ${i + 2} 次调用漂移`);
    assertTrue(check(en).issues.some(i => i.category === 'closure'), '英文闭合框架应命中');
  });

  test('复位没有改变任何单次调用的既有结论', () => {
    assertEqual(check('').gate.action, 'pass');
    assertEqual(check(null).gate.action, 'pass');
    assertEqual(check('今天做了几个优化，但还有东西没摸清楚。可能还要再调几次。').gate.action, 'pass');
    assertEqual(check('新愿现在完整的AGI第1层已经完成了').issues.length > 0, true);
  });
};
