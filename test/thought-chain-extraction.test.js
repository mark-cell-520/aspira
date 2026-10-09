/**
 * test/thought-chain-extraction.test.js — 提取方法曾返回正则源码而非提取结果
 *
 * [test-coverage-gap·第一百五十九轮] 新建。
 *
 * B 类"活着但没测"第一件是 src/workflow/thought-chain.js(1466 行, 20 个方法,
 * 零测试)。按 cycle 28/148/156 的纪律"probing by calling"全景调用它。
 *
 * ═══ 缺陷: 同一形状在两处重复 ═══
 * `_extractConstraints` 与 `_extractGoal` 都写成了:
 *
 *     if (pattern.test(input)) { …push/return pattern.toString()); }
 *
 * `pattern.toString()` 是**正则的字面量源码**，不是提取结果。实测:
 *
 *     _extractConstraints('必须提高效率')   → ['/必须|一定|不要/']
 *     _extractConstraints('如果不能按时完成') → ['/如果|假如|假设/','/不能|不可以|不允许/']
 *     _extractGoal('为什么要测试')          → '/想|要|希望/'
 *     _extractGoal('需要更多时间')          → '/想|要|希望/'
 *
 * 两个后果叠在一起: (a) 调用方拿到的是正则本身; (b) **同一个 pattern 命中的任何
 * 输入都返回同一个值**，提取结果与具体输入无关 —— 上面两个完全不同的输入返回
 * 一模一样的 '/想|要|希望/'。
 *
 * `goal` 会经 PARSE 阶段透出到 `result.parse.goal`，`constraints` 进
 * `result.parse.constraints`，都是调用方直接读的字段。
 *
 * 这是本仓库反复记录的契约错配家族: 调用成功、不抛错、结构合法、内容已死。
 *
 * ═══ 修法 ═══
 * `pattern.test(input)` 改成 `input.match(pattern)`，把匹配到的**片段** `m[0]`
 * push/return。两处同形状一起改。
 *
 * ═══ 实测 ═══
 *   _extractConstraints('必须提高效率')    → ['必须']
 *   _extractConstraints('如果不能按时完成') → ['如果','不能']
 *   _extractGoal('为什么要测试')           → '要'
 *   _extractGoal('需要更多时间')           → '要'
 *   _extractGoal('今天天气很好')           → '理解'(无目标词时的兜底不变)
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const { ThoughtChain } = require(path.join(ROOT, 'src', 'workflow', 'thought-chain.js'));

  const mk = () => new ThoughtChain({ dispatch: () => { throw new Error('stub'); } });

  // ── 一、不得返回正则源码 ────────────────────────────────
  test('提取结果不得是正则字面量源码', () => {
    const tc = mk();
    const CASES = [
      ['_extractConstraints', '必须提高效率'],
      ['_extractConstraints', '如果不能按时完成'],
      ['_extractConstraints', '只能选一个方案'],
      ['_extractGoal', '为什么要测试'],
      ['_extractGoal', '需要更多时间'],
      ['_extractGoal', '我想提高开发效率'],
      ['_extractGoal', '希望尽快上线'],
      ['_extractGoal', '怎样才能降低成本'],
    ];
    const bad = [];
    for (const [m, input] of CASES) {
      const r = tc[m](input);
      const arr = Array.isArray(r) ? r : [r];
      for (const v of arr) {
        if (typeof v !== 'string') { bad.push(`${m}(${input}) 返回非字符串: ${typeof v}`); continue; }
        // 正则字面量的形状: 以 / 开头和结尾, 或含 | 交替符
        if (/^\/.*\/$/.test(v)) bad.push(`${m}(${input}) 返回正则源码: ${v}`);
        if (/\|/.test(v) && !/需要|目的在于|为什么|如何|怎么/.test(v)) {
          bad.push(`${m}(${input}) 的返回值含交替符 |，疑似正则源码: ${v}`);
        }
      }
    }
    assertEqual(bad.join('\n'), '', '以下提取结果不是真实片段:\n' + bad.join('\n'));
  });

  // ── 二、不同输入必须产生不同结果(不是恒值) ──────────────
  test('提取结果必须随输入变化(同一 pattern 不得对任何输入返回同值)', () => {
    const tc = mk();
    // 修复前: 这三个输入全部返回 '/想|要|希望/'
    const a = tc._extractGoal('为什么要测试');
    const b = tc._extractGoal('需要更多时间');
    const c = tc._extractGoal('希望尽快上线');
    assertTrue(!(a === b && b === c),
      `三个不同输入的 goal 完全相同(${JSON.stringify([a, b, c])}) —— ` +
      '提取结果与输入无关，这是 pattern.toString() 的形状');
    // 约束同理
    const x = tc._extractConstraints('必须提高效率');
    const y = tc._extractConstraints('只能选一个');
    assertTrue(JSON.stringify(x) !== JSON.stringify(y),
      `两个不同输入的 constraints 完全相同(${JSON.stringify([x, y])})`);
  });

  // ── 三、提取结果必须是输入里真实出现的片段 ──────────────
  test('提取结果必须是输入文本中真实出现的片段', () => {
    const tc = mk();
    const CASES = [
      ['_extractConstraints', '必须提高效率', '必须'],
      ['_extractConstraints', '如果不能按时完成', '如果'],
      ['_extractConstraints', '只能选一个', '只能'],
      ['_extractGoal', '为什么要测试', '要'],
      ['_extractGoal', '需要更多时间', '要'],
      ['_extractGoal', '我想提高开发效率', '想'],
      ['_extractGoal', '怎么降低成本', '怎么'],
    ];
    const bad = [];
    for (const [m, input, want] of CASES) {
      const r = tc[m](input);
      const arr = Array.isArray(r) ? r : [r];
      // 每个返回值都必须是 input 的子串
      for (const v of arr) {
        if (!input.includes(v)) bad.push(`${m}(${input}) 返回的 ${JSON.stringify(v)} 不是输入的子串`);
      }
      if (arr[0] !== want) bad.push(`${m}(${input}) 首个值 ${JSON.stringify(arr[0])}，期望 ${JSON.stringify(want)}`);
    }
    assertEqual(bad.join('\n'), '', '以下提取结果不是输入的真实片段:\n' + bad.join('\n'));
  });

  // ── 四、无命中时的兜底行为不变 ──────────────────────────
  test('无目标词/约束词时的兜底行为必须保持', () => {
    const tc = mk();
    assertEqual(tc._extractGoal('今天天气很好'), '理解', '无目标词时应返回兜底 理解');
    const noConstraint = tc._extractConstraints('今天天气很好');
    assertTrue(Array.isArray(noConstraint) && noConstraint.length === 0,
      `无约束词时应返回空数组, 实测 ${JSON.stringify(noConstraint)}`);
    const emptyConstraint = tc._extractConstraints('');
    assertTrue(Array.isArray(emptyConstraint) && emptyConstraint.length === 0,
      `空输入应返回空数组, 实测 ${JSON.stringify(emptyConstraint)}`);
  });

  // ── 五、源级: 两处都不得再用 pattern.toString() ─────────
  test('源级: 两处提取都不得再用 pattern.toString()', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'workflow', 'thought-chain.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const cSeg = src.slice(src.indexOf('_extractConstraints(input) {'), src.indexOf('_extractGoal(input) {'));
    const gSeg = src.slice(src.indexOf('_extractGoal(input) {'), src.indexOf('_generateHypotheses(input, count) {'));
    assertTrue(!/pattern\.toString\(\)/.test(cSeg),
      '_extractConstraints 里还有 pattern.toString() —— 它返回正则源码而非提取结果');
    assertTrue(!/pattern\.toString\(\)/.test(gSeg),
      '_extractGoal 里还有 pattern.toString() —— 同上');
    assertTrue(/input\.match\(pattern\)/.test(cSeg), '_extractConstraints 应改用 input.match(pattern)');
    assertTrue(/input\.match\(pattern\)/.test(gSeg), '_extractGoal 应改用 input.match(pattern)');
    // 自证: 谓词必须能判"退回 toString"为缺陷, 否则本条是恒真锁
    const fake = 'if (pattern.test(input)) { constraints.push(pattern.toString()); }';
    assertTrue(/pattern\.toString\(\)/.test(fake) === true && /input\.match\(pattern\)/.test(fake) === false,
      '自证失效: 谓词分不清两种写法, 本条是恒真锁');
  });
};
