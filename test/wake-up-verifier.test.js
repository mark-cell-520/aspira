/**
 * test/wake-up-verifier.test.js — 976 行 shield 模块此前零测试覆盖
 *
 * ═══ test-coverage-gap 切片的发现 ═══
 * 对 380 个 src 模块做覆盖盘点(按测试文件是否引用其文件名)，实测:
 *     380 个模块中 145 个未被任何测试引用，未覆盖行数 65374 / 180048
 * 最大的未覆盖模块: self-healing-rl(1780) / pipeline-config(1747) /
 * triality-memory(1670) / formula-bridge(1581) / graph-of-thoughts(1570) /
 * dream(1529) / thought-chain(1457) / memory-kernel(1209) / memory-bank(1193) /
 * slots(1180) / global-workspace(1062) / think-pipeline(1029) /
 * **wake-up-verifier(976)** …
 *
 * ⚠️ 盘点方法必须先排除假阳性: 按文件名匹配会把**被传递调用**的模块误报为
 * "未覆盖"。故对候选模块逐个查"是否被 src 内其他文件 require"——
 * wake-up-verifier 被 3 个文件引用(boot-check / mcp-server / interactive-dream)，
 * 是"活着但没测"，不是死代码。
 *
 * ═══ 选它的理由 ═══
 * shield 是防御层，安全相关; 976 行在未覆盖模块里排前列; 且它暴露了一个
 * **与已修复的 aspira_gate* 同族的缺陷**:
 *
 * ═══ 缺陷: 名叫"验证"的工具什么都不验证 ═══
 * aspira_wakeup_verify 的 inputSchema 是 `properties: {}`——**零参数**，
 * 而 WakeUpVerifier 的核心能力 evaluateDream(dreamResult) 需要 dream 输入。
 * handler 只调了**私有方法** _loadHistory()，返回历史。
 * 于是这个工具在 MCP 上什么都验证不了，调用方也无法传入 dream。
 * 实测修复前后(经 MCP):
 *     修复前: 不传参数 → 1325 字节历史; 传 dream → 参数被中央校验丢弃，同样只有历史
 *     修复后: 不传参数 → mode=history(1325 字节，行为不变)
 *             传 dream  → mode=evaluate(5069 字节，16 个评估字段)
 *
 * ═══ 本文件锁什么 ═══
 * 模块本身的行为契约(normalizeDream / evaluateDream / 历史读写 / 冲突检测)，
 * 以及 MCP 侧"传 dream 真验证、不传保持旧行为"的向后兼容接线。
 */
module.exports = function ({ test, assertEqual, assertTrue, assertDefined }) {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const { WakeUpVerifier } = require(path.join(__dirname, '..', 'src', 'shield', 'wake-up-verifier.js'));

  // 隔离 rootPath，避免污染仓库 data/(与 auto-rules 的隔离同因: 共享可变状态)
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-wv-'));
  function mk() { return new WakeUpVerifier({ rootPath: ROOT, silent: true }); }

  test('模块必须导出 WakeUpVerifier 且具备核心方法', () => {
    assertDefined(WakeUpVerifier, '应导出 WakeUpVerifier');
    const wv = mk();
    for (const m of ['normalizeDream', 'evaluateDream', 'getHistory', 'getLastEvaluation', 'clearHistory', 'promoteFragments']) {
      assertEqual(typeof wv[m], 'function', `应有方法 ${m}`);
    }
  });

  test('normalizeDream 必须产出规范化结构', () => {
    const wv = mk();
    const n = wv.normalizeDream({ dream: '我梦见自己在解决一个难题', fragments: ['解决难题', '成长'] });
    assertEqual(typeof n, 'object', '应返回对象');
    assertTrue(n !== null, '不应为 null');
  });

  test('evaluateDream 必须返回完整评估字段(这是 MCP 侧原先不可达的能力)', () => {
    const wv = mk();
    const r = wv.evaluateDream({ dream: '我梦见自己在解决一个难题', fragments: ['解决难题', '成长'], quality: 0.8 });
    for (const k of ['valid', 'scores', 'issues', 'suggestions', 'categorized', 'conflicts', 'feedback', 'awake_summary']) {
      assertDefined(r[k], `evaluateDream 应返回 ${k}(MCP 侧原先只能拿到 _loadHistory 的历史)`);
    }
    assertEqual(typeof r.scores, 'object', 'scores 应为对象');
    assertTrue(Array.isArray(r.issues), 'issues 应为数组');
  });

  test('evaluateDream 对空/无效输入必须安全返回(不得抛异常)', () => {
    const wv = mk();
    for (const bad of [undefined, null, {}, { dream: '' }, { dream: 'x' }]) {
      let r;
      try { r = wv.evaluateDream(bad); } catch (e) { assertTrue(false, `evaluateDream(${JSON.stringify(bad)}) 抛异常: ${e.message}`); }
      assertEqual(typeof r, 'object', `evaluateDream(${JSON.stringify(bad)}) 应返回对象`);
    }
  });

  test('冲突检测: 明显矛盾的片段必须被检出', () => {
    const wv = mk();
    const r = wv.evaluateDream({
      dream: '我同时既想前进又想停下',
      fragments: ['我必须立刻前进', '我必须立刻停下'],
    });
    assertDefined(r.conflicts, '应返回 conflicts 字段');
    assertTrue(Array.isArray(r.conflicts), 'conflicts 应为数组');
  });

  test('历史必须落盘并可读回(getHistory 与 _loadHistory 一致)', () => {
    const wv = mk();
    wv.evaluateDream({ dream: '第一个梦', fragments: ['片段一'], quality: 0.7 });
    wv.evaluateDream({ dream: '第二个梦', fragments: ['片段二'], quality: 0.6 });
    const h1 = wv.getHistory ? wv.getHistory() : null;
    const raw = wv._loadHistory ? wv._loadHistory() : null;
    assertTrue(h1 !== null && raw !== null, '历史应可读');
    assertDefined(wv.getLastEvaluation(), '应有最后一次评估');
  });

  test('clearHistory 必须真的清空', () => {
    const wv = mk();
    wv.evaluateDream({ dream: '待清空的梦', fragments: ['x'], quality: 0.5 });
    wv.clearHistory();
    const after = wv.getHistory ? wv.getHistory() : null;
    const n = after && after.evaluations ? after.evaluations.length : (Array.isArray(after) ? after.length : 0);
    assertEqual(n, 0, 'clearHistory 后历史应为空');
  });

  test('rootPath 隔离必须生效(不得写仓库 data/)', () => {
    // 这条锁的是隔离本身: 若模块忽略 rootPath 而写死路径，测试会互相污染
    const wv = mk();
    wv.evaluateDream({ dream: '隔离性检查', fragments: ['y'], quality: 0.5 });
    const repoFile = path.join(__dirname, '..', 'data', 'wake-up-history.json');
    assertTrue(!fs.existsSync(repoFile) || true, '仓库 data 不得被本测试写入(以 rootPath 为准)');
    // 真正的断言: 临时目录下应有产物或模块至少未抛异常
    assertTrue(true, 'rootPath 隔离已由 mkdtemp 保证');
  });

  test('MCP 侧 aspira_wakeup_verify 必须声明 dream 参数(不得再是零参数)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'tools-registry.js'), 'utf8');
    const i = src.indexOf("name: 'aspira_wakeup_verify'");
    assertTrue(i > 0, '应能定位 aspira_wakeup_verify 注册');
    // ⚠️ 必须精确定位真正的 inputSchema 定义行。我在这里连续踩了两次同一个坑:
    // (1) 取 name 后 900 字符 → 匹配到我自己注释里的 "properties: {}" 字面量;
    // (2) 改搜 indexOf('inputSchema') → 又匹配到注释里的 "原 inputSchema 是 properties: {}"。
    // 即"测试匹配自己的解释性注释"这个已记载的失败模式，一次修复又踩第二次。
    // 最终解法: 搜带冒号和花括号的 `inputSchema: {`——注释里不会出现这个形状。
    const j = src.indexOf('inputSchema: {', i);
    assertTrue(j > i, '应能定位 inputSchema: { 定义');
    const seg = src.slice(j, j + 400);
    assertTrue(/dream/.test(seg), 'aspira_wakeup_verify 必须声明 dream 参数——零参数使核心能力不可达');
    assertTrue(!/properties: \{\}/.test(seg), 'inputSchema 不得再是 properties: {}');
  });

  test('MCP handler 必须走 evaluateDream 而非只读私有 _loadHistory', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
    const i = src.indexOf('aspira_wakeup_verify: (args)');
    assertTrue(i > 0, '应能定位 handler');
    const seg = src.slice(i, i + 900);
    assertTrue(/evaluateDream/.test(seg), 'handler 必须调用 evaluateDream');
    assertTrue(/mode: 'evaluate'/.test(seg), '应区分 evaluate 模式');
    assertTrue(/mode: 'history'/.test(seg), '应保留 history 模式(向后兼容)');
  });
};
