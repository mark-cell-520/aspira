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

  // ── 六、_extractVariables：actions 恒为空 / entities 对中文恒空 ──
  // actions 在返回值里声明了，但修复前全函数没有任何一行给它赋值，
  // 它却随 variables 透出到 result.parse.variables.actions。
  // entities 的旧写法按 /\s+/ 切分再要求整段纯字母/CJK，中文无空格且必带标点，
  // 于是对所有中文输入恒为 []（本引擎的主要输入语言恰恰是中文）。
  const VAR_METHODS = ['_extractVariables'];

  test('variables.actions 不得恒为空数组（中文动作动词必须被提取）', () => {
    const tc = mk();
    const CASES = [
      '请帮我分析这份财报并给出投资建议。',
      '为了完成本次升级，我需要分析所有模块并修复发现的缺陷',
      '请评估这个方案的风险并生成改进建议。',
    ];
    const bad = [];
    for (const input of CASES) {
      const v = tc._extractVariables(input);
      if (!Array.isArray(v.actions)) { bad.push(`${input}: actions 不是数组`); continue; }
      if (v.actions.length === 0) bad.push(`${input}: actions 恒为 [] —— 声明了字段却从未赋值`);
    }
    assertEqual(bad.join('\n'), '', 'actions 仍是死字段:\n' + bad.join('\n'));
  });

  test('variables.actions 对英文动作动词同样不得恒空', () => {
    const tc = mk();
    const v = tc._extractVariables('Please analyze the dataset and generate a report.');
    assertTrue(v.actions.length > 0,
      `英文动作句的 actions 仍为 []: ${JSON.stringify(v.actions)}`);
    assertTrue(v.actions.some(a => /analyze/i.test(a)),
      `未提取到 analyze: ${JSON.stringify(v.actions)}`);
  });

  test('variables.entities 对中文输入不得恒为空数组', () => {
    const tc = mk();
    const CASES = [
      '今天天气很好，我想出去散步。',
      '请帮我分析这份财报并给出投资建议。',
      '必须提高效率，不能拖延。',
    ];
    const bad = [];
    for (const input of CASES) {
      const v = tc._extractVariables(input);
      if (!Array.isArray(v.entities) || v.entities.length === 0) {
        bad.push(`${input}: entities 恒为 []（旧实现按 /\\s+/ 切分，中文整句一个 token 且带标点，^[A-Za-z一-龥]+$ 恒不成立）`);
      }
    }
    assertEqual(bad.join('\n'), '', 'entities 对中文仍是死字段:\n' + bad.join('\n'));
  });

  test('entities 对英文输入的提取结果必须与旧实现逐项相同', () => {
    const tc = mk();
    // 旧实现: split(/\s+/).filter(len>2 && /^[A-Za-z一-龥]+$/).slice(0,5)
    const legacy = (input) => input.split(/\s+/)
      .filter(w => w.length > 2 && /^[A-Za-z一-龥]+$/.test(w)).slice(0, 5);
    const CASES = [
      'The company reported strong revenue growth in 2024 and plans to expand.',
      'We must verify every claim before we publish the final report.',
      'a bb ccc dddd eeeee ffffff ggggggg',
    ];
    const bad = [];
    for (const input of CASES) {
      const got = tc._extractVariables(input).entities;
      const want = legacy(input);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${input}\n  旧: ${JSON.stringify(want)}\n  新: ${JSON.stringify(got)}`);
      }
    }
    assertEqual(bad.join('\n'), '', 'entities 的英文路径被改坏了:\n' + bad.join('\n'));
  });

  test('numbers 仍被提取，且数字不得混进 entities', () => {
    const tc = mk();
    const v = tc._extractVariables('根据2024年财报，营收增长12.5%');
    assertEqual(JSON.stringify(v.numbers), '[2024,12.5]', 'numbers 提取结果变化');
    assertTrue(v.entities.every(e => !/\d/.test(e)),
      `数字混进了 entities: ${JSON.stringify(v.entities)}`);
  });

  test('entities/actions 每条都必须是输入的真实子串', () => {
    const tc = mk();
    const CASES = [
      '请帮我分析这份财报并给出投资建议。',
      '为了完成本次升级，我需要分析所有模块并修复发现的缺陷',
      'Please analyze the dataset and generate a report.',
      '今天天气很好，我想出去散步。',
      '必须提高效率，不能拖延。',
    ];
    const bad = [];
    for (const input of CASES) {
      const v = tc._extractVariables(input);
      for (const e of v.entities) if (!input.includes(e)) bad.push(`entities 的 ${JSON.stringify(e)} 不是 ${JSON.stringify(input)} 的子串`);
      for (const a of v.actions) if (!input.includes(a)) bad.push(`actions 的 ${JSON.stringify(a)} 不是 ${JSON.stringify(input)} 的子串`);
    }
    assertEqual(bad.join('\n'), '', '提取结果里有不是输入子串的值:\n' + bad.join('\n'));
  });

  test('提取结果必须随输入变化（不得是恒值）', () => {
    const tc = mk();
    const a = tc._extractVariables('请帮我分析这份财报。');
    const b = tc._extractVariables('请帮我检索相关文献。');
    assertTrue(JSON.stringify(a.actions) !== JSON.stringify(b.actions),
      `两个不同输入的 actions 完全相同(${JSON.stringify([a.actions, b.actions])}) —— 提取结果与输入无关`);
    assertTrue(JSON.stringify(a.entities) !== JSON.stringify(b.entities),
      `两个不同输入的 entities 完全相同(${JSON.stringify([a.entities, b.entities])})`);
  });

  test('空输入与非字符串输入不得抛错', () => {
    const tc = mk();
    for (const input of ['', undefined, null, 12345, {}]) {
      let v;
      try { v = tc._extractVariables(input); } catch (e) { throw new Error(`_extractVariables(${JSON.stringify(input)}) 抛错: ${e.message}`); }
      assertTrue(Array.isArray(v.numbers) && Array.isArray(v.entities) && Array.isArray(v.actions),
        `_extractVariables(${JSON.stringify(input)}) 返回值结构不完整`);
    }
  });

  test('源级: _extractVariables 必须真的给 variables.actions 赋值', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'workflow', 'thought-chain.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const seg = src.slice(src.indexOf('_extractVariables(input) {'), src.indexOf('_extractConstraints(input) {'));
    assertTrue(seg.length > 0, '没找到 _extractVariables 函数体，源级检查落空');
    // 只把 actions 初始化为 [] 不算赋值
    assertTrue(/variables\.actions\.push\(|variables\.actions\s*=/.test(seg),
      '_extractVariables 里没有任何一处给 variables.actions 赋值 —— 它仍是死字段');
    // 自证: 谓词必须能判"只初始化不赋值"为缺陷, 否则本条是恒真锁
    const dead = 'const variables = { numbers: [], entities: [], actions: [] }; return variables;';
    assertTrue(/variables\.actions\.push\(|variables\.actions\s*=/.test(dead) === false,
      '自证失效: 谓词分不清"只初始化"与"真的赋值", 本条是恒真锁');
    for (const m of VAR_METHODS) {
      assertTrue(src.includes(m), `源里找不到 ${m}`);
    }
  });
};
