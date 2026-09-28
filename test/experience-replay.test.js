/**
 * test/experience-replay.test.js — 经验回放引擎的完整性与入口校验
 *
 * ═══ 为什么补这个测试 ═══
 * `src/cortex/experience-replay.js`(866 行)在 coverage-sweep 里属 B 类:
 * **没有测试引用，但有 src 引用** —— MCP 处理器在用它，却没有任何断言约束它。
 *
 * ═══ 本测试当场抓出两个真缺陷 ═══
 *
 * **(a) `aspira_experience_replay` 这个 MCP 工具完全不可用。**
 *     `src/mcp-server.js:3528` 写的是
 *     `new ExperienceReplay({ rootPath: HF_DIR, silent: true })` —— 传**对象**，
 *     而构造函数只接受字符串，于是每次调用都抛
 *     `[ExperienceReplay] Invalid projectRoot`。
 *     端到端实测(curl tools/call)确认: 该工具恒返回
 *     `{"error":"[ExperienceReplay] Invalid projectRoot"}`。
 *     一个名字叫 experience_replay 的工具，什么都做不了。
 *     这是「MCP 处理器与模块契约不一致」的又一例(AGENTS.md 记着
 *     aspira_gate* 与 aspira_wakeup_verify 两次同源缺陷)。
 *
 * **(b) 构造函数里的「路径验证」是死代码。**
 *     原代码:
 *       const resolvedRoot = path.resolve(projectRoot);
 *       if (normalizedPath !== resolvedRoot || !path.isAbsolute(resolvedRoot)) throw ...
 *     `path.resolve()` 已把任何输入变成**绝对且归一化**的路径，所以这两个条件
 *     **永假**。实测 '../escape'、'/a/../b'、'/a//b'、'~/x' 全部
 *     differ=false 且 isAbs=true。只有第一项(空/非字符串)真正生效。
 *     一个永远不触发的校验比没有校验更糟: 它让人以为路径遍历被挡住了。
 *     已改为在 resolve **之前**校验原始输入。
 *
 * ═══ 断言的边界(实测得出) ═══
 * · `validateReportIntegrity` 对**数组**是宽容的(允许顶层为报告列表)，
 *   只抽查前 5 个元素；不断言第 6 个及以后。
 * · 空对象 `{}` 对非 pattern 来源是 valid 的(没有结构要求)。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const ROOT = path.join(__dirname, '..');
  const { ExperienceReplay } = require(path.join(ROOT, 'src', 'cortex', 'experience-replay.js'));

  const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-er-'));
  const cleanup = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } };
  const mk = (dir) => new ExperienceReplay(dir);

  // ─── 缺陷 (a): 契约不一致导致 MCP 工具完全不可用 ─────────────────────
  test('构造函数接受 { rootPath } 对象(MCP 处理器就是这么调的，此前恒抛错)', () => {
    const dir = mkRoot();
    try {
      // 首版我写成 assertTrue(() => { er = new ExperienceReplay(...) }) ——
      // 传进去的是**函数对象**，它恒为 truthy，于是断言"通过"而构造函数
      // 从未被执行，第二条断言才暴露 er 仍是 null。
      // 断言必须包裹真正的求值结果，不能包裹一个 lambda。
      let er = null;
      let threw = null;
      try { er = new ExperienceReplay({ rootPath: dir, silent: true }); }
      catch (e) { threw = e; }
      assertEqual(threw, null, `传 { rootPath } 对象不应抛错，实测 ${threw && threw.message}`);
      assertTrue(!!er, '应成功实例化');
      assertEqual(er.projectRoot, path.resolve(dir), 'root 应被正确解析');
    } finally { cleanup(dir); }
  });

  test('构造函数仍接受字符串(向后兼容)', () => {
    const dir = mkRoot();
    try {
      const er = new ExperienceReplay(dir);
      assertEqual(er.projectRoot, path.resolve(dir), '字符串形式应照常工作');
    } finally { cleanup(dir); }
  });

  // ─── 缺陷 (b): 路径校验是死代码，现真正生效 ─────────────────────────
  test('相对路径必须被拒(此前因 resolve 先执行而静默接受)', () => {
    const dir = mkRoot();
    try {
      let threw = false;
      try { new ExperienceReplay('rel/path'); } catch (e) { threw = true; }
      assertTrue(threw, '相对路径应抛错(修复前不抛，被静默 resolve 成 cwd 下的路径)');
    } finally { cleanup(dir); }
  });

  test('路径遍历必须被拒', () => {
    const dir = mkRoot();
    try {
      for (const bad of ['../escape', '../../etc', 'a/../../b']) {
        let threw = false;
        try { new ExperienceReplay(bad); } catch (e) { threw = true; }
        assertTrue(threw, `${bad} 应抛错`);
      }
    } finally { cleanup(dir); }
  });

  test('null / 空 / 空对象 / 非字符串必须被拒', () => {
    const dir = mkRoot();
    try {
      for (const bad of [null, undefined, '', 0, {}, { silent: true }, 123]) {
        let threw = false;
        try { new ExperienceReplay(bad); } catch (e) { threw = true; }
        assertTrue(threw, `${JSON.stringify(bad)} 应抛错`);
      }
    } finally { cleanup(dir); }
  });

  test('合法绝对路径应通过，且派生出三个文件路径', () => {
    const dir = mkRoot();
    try {
      const er = mk(dir);
      assertEqual(er.reportFile, path.join(dir, 'logs', 'reflect-reports.json'), 'reportFile 路径');
      assertEqual(er.suggestionFile, path.join(dir, 'logs', 'skill-suggestions.json'), 'suggestionFile 路径');
      assertEqual(er.patternFile, path.join(dir, '.opencode', 'memory', 'experience-patterns.json'), 'patternFile 路径');
    } finally { cleanup(dir); }
  });

  // ─── validateReportIntegrity: 完整性校验的各分支 ────────────────────
  test('validateReportIntegrity: null/undefined 判 critical', () => {
    const dir = mkRoot();
    try {
      const er = mk(dir);
      for (const v of [null, undefined]) {
        const r = er.validateReportIntegrity(v, 'src');
        assertEqual(r.valid, false, `${v} 应判无效`);
        assertEqual(r.severity, 'critical', '空数据应为 critical');
      }
    } finally { cleanup(dir); }
  });

  test('validateReportIntegrity: 非对象非数组判 critical，数组宽容', () => {
    const dir = mkRoot();
    try {
      const er = mk(dir);
      assertEqual(er.validateReportIntegrity('hello', 'src').severity, 'critical', '字符串应 critical');
      assertEqual(er.validateReportIntegrity(42, 'src').severity, 'critical', '数字应 critical');
      // 顶层数组是允许的(报告列表)，元素须为对象
      const ok = er.validateReportIntegrity([{ a: 1 }, { b: 2 }], 'src');
      assertEqual(ok.valid, true, '对象数组应有效');
      const bad = er.validateReportIntegrity([{ a: 1 }, 'nope'], 'src');
      assertEqual(bad.valid, false, '含非对象元素应无效');
      assertEqual(bad.severity, 'warning', '元素问题应为 warning 而非 critical');
    } finally { cleanup(dir); }
  });

  test('validateReportIntegrity: patternFile 结构校验', () => {
    const dir = mkRoot();
    try {
      const er = mk(dir);
      // 缺 patterns 数组
      assertEqual(er.validateReportIntegrity({ patterns: 'no' }, 'patternFile').valid, false,
        'patterns 非数组应无效');
      // 缺 key
      const noKey = er.validateReportIntegrity({ patterns: [{ occurrence: 1 }] }, 'patternFile');
      assertEqual(noKey.valid, false, '缺 key 应无效');
      assertTrue(/key/.test(noKey.error), '错误信息应提到 key');
      // occurrence 类型错
      const badOcc = er.validateReportIntegrity({ patterns: [{ key: 'k', occurrence: 'x' }] }, 'patternFile');
      assertEqual(badOcc.valid, false, 'occurrence 类型错误应无效');
      // 合法
      const good = er.validateReportIntegrity({ patterns: [{ key: 'k', occurrence: 3 }] }, 'patternFile');
      assertEqual(good.valid, true, '合法 patternFile 应有效');
      // occurrence 缺省是允许的(代码只校验"定义了的"类型)
      assertEqual(er.validateReportIntegrity({ patterns: [{ key: 'k' }] }, 'patternFile').valid, true,
        'occurrence 缺省应有效');
    } finally { cleanup(dir); }
  });

  // ─── 自修复路径 ──────────────────────────────────────────────────────
  test('selfHealCorruptedFile 回退到默认空模式', () => {
    const dir = mkRoot();
    try {
      const er = mk(dir);
      const healed = er.selfHealCorruptedFile('patterns');
      assertEqual(JSON.stringify(healed), JSON.stringify({ patterns: [], lastUpdate: null }),
        '无备份时应回退到默认空模式');
    } finally { cleanup(dir); }
  });

  test('selfHealCorruptedFile 优先从 .bak 备份恢复', () => {
    const dir = mkRoot();
    try {
      // 预置一个合法备份
      const memDir = path.join(dir, '.opencode', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      const backup = { patterns: [{ key: 'from-backup', occurrence: 7 }], lastUpdate: '2024-01-01' };
      fs.writeFileSync(path.join(memDir, 'experience-patterns.json.bak'), JSON.stringify(backup), 'utf8');
      const er = mk(dir);
      const healed = er.selfHealCorruptedFile('patterns');
      assertEqual(healed.patterns[0].key, 'from-backup', '应从备份恢复而非回退默认值');
    } finally { cleanup(dir); }
  });

  test('repairPartialPatterns 保留 lastUpdate 并重建空 patterns', () => {
    const dir = mkRoot();
    try {
      const er = mk(dir);
      const r = er.repairPartialPatterns({ lastUpdate: '2024-01-01', junk: true });
      assertEqual(r.lastUpdate, '2024-01-01', 'lastUpdate 应保留');
      assertEqual(r.patterns.length, 0, 'patterns 应重建为空');
      const none = er.repairPartialPatterns({});
      assertEqual(none.lastUpdate, null, '缺 lastUpdate 时应为 null');
    } finally { cleanup(dir); }
  });

  test('损坏的 pattern 文件在 loadPatterns 时自愈，不抛异常', () => {
    const dir = mkRoot();
    try {
      const memDir = path.join(dir, '.opencode', 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      // 写入非法 JSON
      fs.writeFileSync(path.join(memDir, 'experience-patterns.json'), '{ this is not json', 'utf8');
      // 同上: 必须真正求值，不能把 lambda 递给 assertTrue
      let er = null;
      let threw = null;
      try { er = new ExperienceReplay(dir); } catch (e) { threw = e; }
      assertEqual(threw, null, `损坏文件不应导致构造失败，实测 ${threw && threw.message}`);
      assertTrue(!!er, '应成功实例化');
      const p = er.loadPatterns();
      assertTrue(!!p && Array.isArray(p.patterns), 'loadPatterns 应返回含 patterns 的对象');
    } finally { cleanup(dir); }
  });
};
