/**
 * test/blackboard-add-contract.test.js — 一次 add(undefined) 曾让整个 Blackboard 永久抛错
 *
 * [test-coverage-gap·第一百七十轮] 新建。
 *
 * B 类"活着但没测"第一件是 src/consciousness/global-workspace.js(1061 行,
 * GlobalWorkspace + Blackboard 两个导出类, 零测试)。按 cycle 28/148/156/159/167
 * 的纪律 probing by calling 全景调用。
 *
 * ═══ 缺陷一: add(undefined) 持久腐蚀 ═══
 * `Blackboard.add` 原实现直接 `this.entries.push(entry)`，不校验类型。
 * 传入 undefined/null 后 entries 里混入非对象条目，之后:
 *
 *     getByType(t) → TypeError: Cannot read properties of undefined (reading 'type')
 *     getByAgent(a) → TypeError: Cannot read properties of undefined (reading 'agent')
 *
 * 而坏条目**留在 entries 里**，不清掉就一直抛 —— 一次 add(undefined)
 * 让整个 Blackboard 的读路径永久损坏。getAll() 则返回 `[{...}, null]`
 * (JSON 序列化把 undefined 显示成 null)，看起来只是多一个空位。
 *
 * 本仓库反复记录的形状: 调用成功、不抛错、结构合法、内容已死 —— 且这次
 * 是**持久腐蚀**而非一次性错误。
 *
 * ═══ 缺陷二: 小容量下上限永不生效 ═══
 * 淘汰逻辑 `trimCount = Math.floor(this.maxEntries * 0.1)` 在 maxEntries < 10
 * 时得 0，`slice(0)` 是空操作。实测 `new Blackboard(3)` 连加 5 条 size=5
 * (应 ≤3)。默认 GWT_LIMITS.MAX_BOARD_ENTRIES = 200 不受影响，故从未暴露；
 * 但 Blackboard 是导出类，调用方可自定容量。
 *
 * ═══ 修法 ═══
 * add 入口拒绝非对象(返回 false，不写入)，淘汰下限改为 Math.max(1, ...)。
 *
 * ═══ 实测 ═══
 *   修复前: add() → getAll() 得 [null]，getByType 抛 TypeError
 *   修复后: add() / add(null) / add(42) / add('x') 全部返回 false 且不写入，
 *           getByType / getByAgent 正常返回
 *   new Blackboard(3) 加 5 条 → size=3; new Blackboard(200) 加 205 条 → size=185
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const { Blackboard, GWT_LIMITS } = require(path.join(ROOT, 'src', 'consciousness', 'global-workspace.js'));

  // ── 一、非对象不得写入，且不得腐蚀读路径 ────────────────
  test('add(非对象) 必须返回 false 且不写入(不得腐蚀读路径)', () => {
    const bb = new Blackboard(3);
    assertEqual(bb.add({ type: 't', agent: 'a' }), true, '合法条目应写入并返回 true');
    const bad = [];
    for (const [label, v] of [['undefined', undefined], ['null', null], ['数字', 42], ['字符串', 'x'], ['布尔', true]]) {
      const r = bb.add(v);
      if (r !== false) bad.push(`${label} → 返回 ${r}(期望 false)`);
    }
    assertEqual(bad.join('\n'), '', '以下非对象输入未被拒绝:\n' + bad.join('\n'));
    // 关键: 读路径不得抛错
    let getAll, byType, byAgent;
    try { getAll = JSON.stringify(bb.getAll()); } catch (e) { bad.push('getAll 抛错: ' + e.message); }
    try { byType = JSON.stringify(bb.getByType('t')); } catch (e) { bad.push('getByType 抛错: ' + e.message); }
    try { byAgent = JSON.stringify(bb.getByAgent('a')); } catch (e) { bad.push('getByAgent 抛错: ' + e.message); }
    assertEqual(bad.join('\n'), '', '读路径被坏条目腐蚀:\n' + bad.join('\n'));
    assertEqual(bb.size(), 1, `size 应为 1(坏条目未写入), 实测 ${bb.size()}`);
    assertEqual(getAll, '[{"type":"t","agent":"a"}]', `getAll 应只含合法条目, 实测 ${getAll}`);
    assertEqual(byType, '[{"type":"t","agent":"a"}]', `getByType 应命中, 实测 ${byType}`);
  });

  // ── 二、上限必须真的生效(含小容量) ──────────────────────
  test('maxEntries 上限必须真的生效(小容量也不能空转)', () => {
    const bad = [];
    // 小容量: 原实现在 maxEntries < 10 时 trimCount = 0，淘汰空转
    const small = new Blackboard(3);
    for (let i = 0; i < 5; i++) small.add({ type: 't', i });
    if (small.size() > 3) bad.push(`new Blackboard(3) 加 5 条 → size=${small.size()}(应 ≤3)`);
    // 更小
    const tiny = new Blackboard(1);
    for (let i = 0; i < 4; i++) tiny.add({ type: 't', i });
    if (tiny.size() > 1) bad.push(`new Blackboard(1) 加 4 条 → size=${tiny.size()}(应 ≤1)`);
    // 默认容量(回归: 默认路径不得被改坏)
    const def = new Blackboard();
    for (let i = 0; i < GWT_LIMITS.MAX_BOARD_ENTRIES + 5; i++) def.add({ type: 't', i });
    if (def.size() > GWT_LIMITS.MAX_BOARD_ENTRIES) bad.push(`默认容量加超 → size=${def.size()}(应 ≤${GWT_LIMITS.MAX_BOARD_ENTRIES})`);
    assertEqual(bad.join('\n'), '', '上限淘汰失效:\n' + bad.join('\n'));
  });

  // ── 三、合法路径不得回归 ────────────────────────────────
  test('合法条目的 add / getAll / getByType / getByAgent / size / clear 必须正常', () => {
    const bb = new Blackboard(10);
    bb.add({ type: 'a', agent: 'x', v: 1 });
    bb.add({ type: 'b', agent: 'y', v: 2 });
    bb.add({ type: 'a', agent: 'z', v: 3 });
    assertEqual(bb.size(), 3, 'size 应为 3');
    assertEqual(bb.getAll().length, 3, 'getAll 应返回 3 条');
    assertEqual(bb.getByType('a').length, 2, 'getByType(a) 应 2 条');
    assertEqual(bb.getByType('a').map(e => e.v).join(','), '1,3', 'getByType 应保序');
    assertEqual(bb.getByAgent('z').length, 1, 'getByAgent(z) 应 1 条');
    assertEqual(bb.getByType('不存在').length, 0, '不存在的 type 应返回空数组');
    bb.clear();
    assertEqual(bb.size(), 0, 'clear 后 size 应为 0');
    assertEqual(bb.getAll().length, 0, 'clear 后 getAll 应为空');
    // getAll 必须返回副本(改返回值不得影响内部)
    const all = bb.getAll();
    bb.add({ type: 'c', agent: 'w' });
    assertEqual(all.length, 0, 'getAll 应返回副本，外部改动不得影响内部状态');
  });

  // ── 四、源级: add 必须有入口校验与淘汰下限 ──────────────
  test('源级: add 必须有非对象校验与淘汰下限', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'consciousness', 'global-workspace.js'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const i = src.indexOf('add(entry) {');
    assertTrue(i > 0, '前提失效: 找不到 add(entry)');
    const seg = src.slice(i, src.indexOf('\n  }', i));
    assertTrue(/typeof entry !== 'object'/.test(seg),
      'add 必须校验 entry 是对象 —— 否则 undefined/null 会写入并让读路径永久抛错');
    assertTrue(/Math\.max\(1,/.test(seg),
      '淘汰下限必须 >= 1 —— floor(maxEntries*0.1) 在 maxEntries<10 时得 0，上限空转');
    // 自证: 谓词必须能判"无校验"为缺陷
    const noGuard = 'this.entries.push(entry);';
    assertTrue(/typeof entry !== 'object'/.test(noGuard) === false,
      "自证失效: 谓词分不清有校验与无校验, 本条是恒真锁");
  });
};
