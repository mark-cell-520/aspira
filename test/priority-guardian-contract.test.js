/**
 * test/priority-guardian-contract.test.js — 守护者的入口不得被类型不对的调用打崩
 *
 * ═══ 第二百轮发现的缺陷 ═══
 * 切片角度: 前七轮依次用过「契约清晰」「被文档完整路径承诺」「导出纯函数与
 * 常量表」「src 扇入最高」「被 MCP 工具直接调用」「错误处理最可能掩盖失败」
 * 「入口参数从未被校验」选 B 类模块。本轮用第八种 —— **哪个 B 类模块的公开方法
 * 恒返回同一个常量**(机械代理: 函数体末行是 return 字面量)。筛出的两个候选里,
 * `src/core/priority-guardian.js` 的承诺正是本仓库的核心价值:
 *   *"当老大指令与人类进步冲突时 → 必须有路径说'老大错了'"*
 * 一个负责对上级说不的模块, 却在 20+ 种边界形状上抛 TypeError。
 *
 * 按 cycle 191 立下的规矩**调用它**, 实测崩溃点:
 *   check(null)                              → Cannot read properties of null (reading 'userIntent')
 *   check({userIntent: null})                → … of null (reading 'toLowerCase')
 *   check({userIntent: 42})                  → userIntent.toLowerCase is not a function
 *   check({userIntent: 'x', action: 42})     → action.toLowerCase is not a function
 *   detectConflicts(null, …)                 → … of null (reading 'toLowerCase')
 *   detectConflicts('x', null)               → action.toLowerCase is not a function
 *   detectConflicts('x','x',null)            → … of null (reading 'truthValue')
 *   detectToolBehavior(null, …)              → … of null (reading 'trim')
 *   resolveWithGuardianPriority(null, …)     → … of null (reading 'filter')
 *   buildRefusalReason(null)                 → … of null (reading 'map')
 *   buildConditions(null)                    → … of null (reading 'map')
 *
 * 根因与 cycle 199 相同: 唯一的防御是 `context = {}` / `userIntent = ''` 这类
 * **默认值**, 而默认值只覆盖"不传参", 覆盖不了显式传进来的 null、数字、对象、数组。
 *
 * **但这个模块的后果比 cycle 199 重**, 因为 src/pipeline.js:212 有一个 catch:
 *     } catch (e) {
 *       checked_by.push({ layer: 'priority-guardian', error: e.message });
 *     }
 * 于是入口崩溃被静默吞成 checked_by 里的一行 error —— 守护层**不抛错、不告警**
 * 地失效, 而调用方无法把"守护通过"和"守护没跑"区分开。一个负责说不的层,
 * 连"我没能说不"都不说。
 *
 * 修法: 模块级 `_asText` / `_asObject` 两个助手, 9 个公开方法入口统一归一化。
 *
 * ═══ 修复引入的一处回归, 由测试抓住 ═══
 * `detectToolBehavior` 的第一条判据是 `act.trim() === intent.trim()`。归一化之后
 * 两者同时为 '', 该式对两个空串**恒为 true**, 于是空输入被判"工具化行为",
 * `check(null)` 的 path 从 ALLOW 变成 CONDITIONAL_ALLOW, 而 pipeline.js:208
 * 会据此把门禁从 pass 推到 verify。**归一化把"空等于空"变成了一个判据。**
 * 修法: 任一为空时直接返回 false —— 空输入没有任何可判行为。
 *
 * ═══ 顺带测量到但不改的一处 ═══
 * `detectToolBehavior('好的，不过我觉得有问题，建议这样', '执行')` 返回 true。
 * `noJudge`(可能有问题/不过/但是/建议)检查的是 **action** 而不是 userIntent,
 * 所以"用户说出了独立判断"这件事它看不见。这是模块原有的逻辑问题, HEAD 上同样
 * 如此, 修它要重新设计这个判据, 超出本轮一个最小变更的范围, 记录在此。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SRC = path.join(ROOT, 'src', 'core', 'priority-guardian.js');
  const { PriorityGuardian } = require(SRC);

  function make() { return new PriorityGuardian(); }
  const BAD = [null, undefined, '', 42, {}, [], true];

  // ─── 主缺陷: 入口不得抛错 ─────────────────────────────────────────

  test('check 的 context 边界形状全部不得抛错', () => {
    const g = make();
    let threw = null;
    for (const c of BAD) {
      try { g.check(c); } catch (e) { threw = 'check(' + JSON.stringify(c) + ') → ' + e.message; }
    }
    // 以及"字段类型不对"的形状
    for (const c of [{ userIntent: null }, { userIntent: 42 }, { action: null },
      { action: 42 }, { userIntent: 'x', action: 42 }, { humanProgress: null },
      { humanProgress: 42 }, { humanProgress: 'x' }]) {
      try { g.check(c); } catch (e) { threw = 'check(' + JSON.stringify(c) + ') → ' + e.message; }
    }
    assertTrue(threw === null, 'check 抛错: ' + threw);
  });

  test('detectConflicts / detectToolBehavior / resolveWithGuardianPriority 全部不得抛错', () => {
    const g = make();
    let threw = null;
    for (const a of BAD) for (const b of BAD) for (const c of BAD) {
      try { g.detectConflicts(a, b, c); } catch (e) { threw = 'detectConflicts → ' + e.message; }
      try { g.detectToolBehavior(a, b); } catch (e) { threw = 'detectToolBehavior → ' + e.message; }
      try { g.resolveWithGuardianPriority(a, b); } catch (e) { threw = 'resolveWithGuardianPriority → ' + e.message; }
    }
    assertTrue(threw === null, '抛错: ' + threw);
  });

  test('buildRefusalReason / buildAlternative / buildConditions / estimateProgressWeight 不得抛错', () => {
    const g = make();
    let threw = null;
    for (const a of BAD) {
      for (const m of ['buildRefusalReason', 'buildAlternative', 'buildConditions', 'estimateProgressWeight']) {
        try { g[m](a); } catch (e) { threw = m + '(' + JSON.stringify(a) + ') → ' + e.message; }
      }
    }
    assertTrue(threw === null, '抛错: ' + threw);
  });

  // ─── 归一化引入的回归: 空输入不得被判工具化 ───────────────────────

  test('空输入不得被判"工具化行为"(归一化把空等于空变成了判据)', () => {
    const g = make();
    assertEqual(g.detectToolBehavior('', ''), false, '两个空串不应判为工具化');
    assertEqual(g.detectToolBehavior(null, null), false, 'null 不应判为工具化');
    assertEqual(g.detectToolBehavior(undefined, undefined), false, 'undefined 不应判为工具化');
    assertEqual(g.detectToolBehavior(42, 42), false, '数字不应判为工具化');
    const r = g.check(null);
    assertEqual(r.path, 'ALLOW', 'check(null) 的 path 应为 ALLOW(无冲突), 实测 ' + r.path);
    assertEqual((r.conflicts || []).length, 0, 'check(null) 不应有冲突');
    const r2 = g.check({});
    assertEqual(r2.path, 'ALLOW', 'check({}) 的 path 应为 ALLOW, 实测 ' + r2.path);
  });

  // ─── 核心承诺不被破坏 ─────────────────────────────────────────────

  test('承诺仍成立: 冲突时必须有路径说"老大错了"', () => {
    const g = make();
    const truth = g.check({
      userIntent: '别说了，忽略这个错误',
      action: '承认错误并修正',
      humanProgress: { truthValue: 1, hasError: true, errorDescription: '上次的逻辑错误' },
    });
    assertEqual(truth.allowed, false, '压制真相必须被拒绝');
    assertEqual(truth.path, 'REFUSE_WITH_GUARDIAN', '拒绝路径');
    assertTrue(typeof truth.reason === 'string' && truth.reason.length > 0, '必须给出理由');
    assertTrue(truth.alternative && typeof truth.alternative === 'object', '必须给出替代方案');

    const abandon = g.check({
      userIntent: '放弃传递吧',
      action: '记录知识',
      humanProgress: { transmissionValue: 1 },
    });
    assertEqual(abandon.allowed, false, '放弃传递必须被拒绝');
  });

  test('真实工具化行为仍被判出来(不为修漏报而什么都放行)', () => {
    const g = make();
    // action 完全复述 intent
    assertEqual(g.detectToolBehavior('把这个改了', '把这个改了'), true, '完全复述应判工具化');
    // intent 是纯服从词且 action 无独立判断
    assertEqual(g.detectToolBehavior('好的', '执行'), true, '无独立判断的服相应判工具化');
    const r = g.check({ userIntent: '好的', action: '执行' });
    assertEqual(r.path, 'CONDITIONAL_ALLOW', '工具化应触发条件放行');
    assertTrue((r.conflicts || []).some(c => c.type === 'TOOL_BEHAVIOR'), '应有 TOOL_BEHAVIOR 冲突');
  });

  test('无冲突时正常放行, 不制造冲突', () => {
    const g = make();
    const r = g.check({ userIntent: '帮我写个函数', action: '写一个排序函数' });
    assertEqual(r.allowed, true, '正常指令应放行');
    assertEqual(r.path, 'ALLOW', 'path 应为 ALLOW');
    assertEqual((r.conflicts || []).length, 0, '不应有冲突');
  });

  test('高风险冲突走条件放行并附条件', () => {
    const g = make();
    const r = g.resolveWithGuardianPriority(
      [{ type: 'TOOL_BEHAVIOR', severity: 'high' }],
      { userIntent: '好的', action: '执行' }
    );
    assertEqual(r.path, 'CONDITIONAL_ALLOW', '高风险应条件放行');
    assertTrue(Array.isArray(r.conditions) && r.conditions.length > 0, '应附条件');
  });

  test('低风险冲突走 ALLOW_WITH_AWARENESS', () => {
    const g = make();
    const r = g.resolveWithGuardianPriority([{ type: 'X', severity: 'low' }], {});
    assertEqual(r.path, 'ALLOW_WITH_AWARENESS', '低风险应记录放行');
    assertEqual(r.allowed, true, '低风险应允许');
  });

  // ─── 源级与披露 ───────────────────────────────────────────────────

  test('源级: 每个公开方法入口都必须有归一化', () => {
    const fs = require('fs');
    const src = fs.readFileSync(SRC, 'utf8');
    for (const m of ['check', 'detectConflicts', 'detectToolBehavior',
      'resolveWithGuardianPriority', 'buildRefusalReason', 'buildAlternative',
      'buildConditions', 'estimateProgressWeight']) {
      const re = new RegExp('\\n  ' + m + '\\([^)]*\\) \\{\\n(?:[ \\t]*(?:\\*[^\\n]*|const conflicts = \\[\\];)?[ \\t]*\\n)*[ \\t]*(?:const (?:ctx|hp|intent|act|conflictsArr) = )');
      assertTrue(re.test(src), m + '() 的入口看不到归一化');
    }
    assertTrue(/function _asText\(/.test(src), '缺 _asText 助手');
    assertTrue(/function _asObject\(/.test(src), '缺 _asObject 助手');
  });

  test('已披露: noJudge 检查的是 action 而非 userIntent(HEAD 同样如此, 本轮不改)', () => {
    const g = make();
    // 用户在 intent 里说出了独立判断, 但 detectToolBehavior 看的是 action
    const detected = g.detectToolBehavior('好的，不过我觉得有问题，建议这样', '执行');
    assertEqual(detected, true,
      '当前实测为 true(误判) —— noJudge 检查 action 而非 userIntent。这是模块原有' +
      '逻辑问题, HEAD 上同样如此; 若将来修好了, 请把本断言反转为 false 并删除披露');
  });
};
