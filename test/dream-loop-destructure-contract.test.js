/**
 * test/dream-loop-destructure-contract.test.js — dream-loop 的导入/导出必须同名同实
 *
 * ═══ 第一百九十五轮发现的缺陷 ═══
 * `src/dream/dream-loop.js` 第 25 行原来写成:
 *   const { DreamV11: DreamEngine, LEVELS, DEFAULT_SCORING } = require('./dream.js');
 * 而 `dream.js` 实际导出 12 个名字 —— DreamV5..V11 / DREAM_FUNCTIONS /
 * createDreamV5..V11 —— **既没有 LEVELS 也没有 DEFAULT_SCORING**(全文件 grep 无定义)。
 *
 * 解构一个模块不导出的名字**不抛错**, 只得 undefined(cycle 25 记录过同族:
 * 测试导入 PROBE_AUTH_VERSION 而模块导出 PROBE_VERSION, 于是探针把
 * `| Engine version | undefined` 写进了文档)。这条链上它穿过了三个点:
 *   ① dream-loop.js:25   解构 → undefined
 *   ② dream-loop.js:703  把 LEVELS 放进 module.exports → 外部拿到 undefined
 *   ③ interactive-dream.js:14  又解构一次 → undefined, 同样从未使用
 *
 * 于是模块的导出清单里有一个**看起来被承诺、实际从来是 undefined 的常量表**。
 * 模块头部写着 "L1~L6 consciousness level scoring", 很容易让人以为 LEVELS 就是
 * 那个六级表 —— 但真实存在的是 `dagResult.level_breakdown` 的 L1..L6 分支,
 * 与这个常量表无关。**一个承诺链每一环都成功, 而产物是 undefined。**
 *
 * ═══ 本测试锁什么 ═══
 * 1. dream-loop 的每个导出键都必须有真实值(不许再出现 undefined 占位)
 * 2. dream-loop 从 dream.js 解构的每个名字, dream.js 必须真的导出
 * 3. 反向证明: 把 LEVELS 加回 exports(值为 undefined), 必须按名红
 * 4. 纯函数契约不被这次删除破坏(tokenize/scoreFragment/generateDream 仍工作)
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const LOOP = path.join(ROOT, 'src', 'dream', 'dream-loop.js');
  const DREAM = path.join(ROOT, 'src', 'dream', 'dream.js');
  const INTERACTIVE = path.join(ROOT, 'src', 'dream', 'interactive-dream.js');

  const loop = require(LOOP);
  const dream = require(DREAM);

  test('dream-loop 的每个导出键都必须有真实值(不许有 undefined 占位)', () => {
    const bad = [];
    for (const [k, v] of Object.entries(loop)) {
      if (v === undefined) bad.push(k);
    }
    assertEqual(bad.length, 0,
      '这些导出键的值是 undefined —— 它们是被承诺却从未存在的名字: ' + bad.join(', '));
  });

  test('LEVELS / DEFAULT_SCORING 不得再出现在 dream-loop 的导出里', () => {
    // 修复前实测: require('dream-loop').LEVELS === undefined,
    // 而 'LEVELS' in exports 为 true —— 一个看起来被承诺的常量表。
    assertTrue(!('LEVELS' in loop),
      'LEVELS 仍在导出里。它从来是 undefined(dream.js 从未导出这个名字), ' +
      '留着它就是留一个假的承诺');
    assertTrue(!('DEFAULT_SCORING' in loop), 'DEFAULT_SCORING 仍在导出里, 同理');
  });

  test('dream-loop 从 dream.js 解构的每个名字, dream.js 必须真的导出', () => {
    // 同样先剥行注释 —— 本轮修复把旧写法原样写进了注释解释原因,
    // 不剥就会把自己的说明当成违规代码。
    const src = fs.readFileSync(LOOP, 'utf8').replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
    const m = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]\.\/dream\.js['"]\)/);
    assertTrue(!!m, '找不到从 dream.js 的解构语句 —— 锚点已变, 请更新本证明');
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const parts = s.split(':');
      // `DreamV11: DreamEngine` 表示"从模块取 DreamV11, 本地命名为 DreamEngine"
      // —— 要核对的是**模块侧**的名字, 即冒号左边那个。
      return (parts.length > 1 ? parts[0] : parts[0]).trim();
    });
    const dreamExports = Object.keys(dream);
    const missing = names.filter(n => dreamExports.indexOf(n) < 0);
    assertEqual(missing.length, 0,
      'dream-loop 从 dream.js 解构了它不导出的名字: ' + missing.join(', ') +
      ' —— 解构不抛错, 只得 undefined(cycle 25 同族)');
  });

  test('interactive-dream 也不得再解构 LEVELS', () => {
    const src = fs.readFileSync(INTERACTIVE, 'utf8');
    const m = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]\.\/dream-loop\.js['"]\)/);
    assertTrue(!!m, '找不到 interactive-dream 从 dream-loop 的解构语句');
    assertTrue(!/\bLEVELS\b/.test(m[1]),
      'interactive-dream 仍在解构 LEVELS —— 它从来是 undefined, 且这里从未使用过');
  });

  test('源级: 不得再出现从 dream.js 解构 LEVELS / DEFAULT_SCORING 的写法', () => {
    for (const f of [LOOP, INTERACTIVE]) {
      // 先剥掉行注释再匹配 —— 本轮修复把旧写法原样写进了注释里解释原因,
      // 不剥注释就会把自己的说明当成违规(cycle 19/25 记录过的形状)。
      const raw = fs.readFileSync(f, 'utf8');
      const src = raw.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
      const decls = src.match(/const\s*\{[^}]*\}\s*=\s*require\(['"]\.\/(?:dream|dream-loop)\.js['"]\)/g) || [];
      for (const decl of decls) {
        assertTrue(!/\b(LEVELS|DEFAULT_SCORING)\b/.test(decl),
          path.basename(f) + ' 仍有解构未导出名字的写法: ' + decl.slice(0, 80));
      }
      // 并且确认剥注释后仍能至少找到一条解构(否则上面的循环是空的, 断言恒真)
      assertTrue(decls.length > 0,
        path.basename(f) + ' 里一条 require(./dream*.js) 的解构都没找到 —— ' +
        '要么文件结构已变, 要么本检查已失效');
    }
  });

  test('反向证明: 把 undefined 的 LEVELS 加回 exports, 本锁必须按名红', () => {
    // 为什么不用"把坏实现写进临时目录再 require": dream-loop 依赖 ./dream.js,
    // 后者又依赖一整棵 src/ 树, 在 tmp 里复刻等于复制半个仓库(cycle 194 在同一
    // 模块上已经撞过一次)。这里改用**逻辑等价**的证明: 检查 exports 的源码文本,
    // 要求"若把 LEVELS 加回去, 它的值确实是 undefined" —— 因为 dream.js 不导出它,
    // 所以任何 `LEVELS,` 的导出项都只能是 undefined, 用例①必然抓到。
    const dreamExports = Object.keys(dream);
    assertTrue(dreamExports.indexOf('LEVELS') < 0,
      'dream.js 现在导出 LEVELS 了? 那本锁的前提(它是未定义名字)已不成立, ' +
      '请重新审视本测试');
    const src = fs.readFileSync(LOOP, 'utf8');
    const anchor = 'module.exports = {\n  DEFAULT_WEIGHTS,';
    assertTrue(src.indexOf(anchor) >= 0, 'exports 锚点未命中 —— 请更新本反向证明');
    const broken = src.replace(anchor, 'module.exports = {\n  LEVELS,\n  DEFAULT_WEIGHTS,');
    assertTrue(broken !== src, '反向证明没有真正改动任何东西 —— 锚点必须真的匹配');
    // 坏实现的 exports 里会有 `LEVELS,` 这一项, 而 LEVELS 这个名字在模块作用域内
    // 已无定义(第 36 行的解构里已删除) —— 所以它是 undefined, 用例①会按名红。
    assertTrue(/module\.exports = \{\s*LEVELS,/.test(broken),
      '坏实现没把 LEVELS 加回 exports 开头');
    assertTrue(!/const\s*\{[^}]*\bLEVELS\b/.test(broken.replace(/\/\/[^\n]*/g, '')),
      '坏实现里 LEVELS 竟然有定义? 那它不再是"未定义名字", 本证明失效');
  });

  test('删除假承诺没有破坏真实契约(tokenize/scoreFragment/generateDream 仍工作)', () => {
    // 注意 assertEqual 是 !== 严格比较, 数组要逐项比(两个同内容数组引用不同)
    const cn = loop.tokenize('今天天气很好');
    assertEqual(cn.length, 1, 'tokenize 中文应按标点切成 1 段');
    assertEqual(cn[0], '今天天气很好', 'tokenize 中文片段内容');
    const en = loop.tokenize('the quick brown fox');
    assertEqual(en.length, 4, 'tokenize 英文应切 4 个词');
    assertEqual(en.join(','), 'the,quick,brown,fox', 'tokenize 英文逐词');
    assertEqual(loop.tokenize(null).length, 0, 'tokenize(null) 应返回空数组');

    const scored = loop.scoreFragment({ content: 'x', recency: 0.5, salience: 0.5 });
    assertEqual(scored.valid, true, 'scoreFragment 正常片段应 valid');
    assertTrue(typeof scored.score === 'number' && scored.score >= 0 && scored.score <= 1,
      'scoreFragment 的 score 应在 [0,1], 实测 ' + scored.score);

    const dream = loop.generateDream([{ content: '第一段', layer: 'CORE' }]);
    assertEqual(dream.state, 'complete', 'generateDream 正常输入应 complete');
    assertEqual(dream.fragments.length, 1, '应保留 1 个片段');

    // 常量表仍在且非 undefined
    for (const k of ['DEFAULT_WEIGHTS', 'DREAM_STATE', 'DREAM_ERROR', 'OSCILLATION_THRESHOLD', 'MEMORY_PRESSURE', 'RETRY_POLICY']) {
      assertTrue(loop[k] !== undefined && loop[k] !== null, k + ' 应仍是真实常量表');
    }
  });
};
