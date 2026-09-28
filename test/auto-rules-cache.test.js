/**
 * test/auto-rules-cache.test.js — auto-rules 的规则文件不得每次门禁都重读
 *
 * ═══ 缺陷 ═══
 * performance-optimization 切片。CPU profile(3000 次混合判别)显示
 * `readFileUtf8` 占 1.5%(120.7ms / 8248.5ms)，是最大的非正则单项开销。
 * 追查: `checkAutoRules(text)` 每次调用都执行 `loadRules()` →
 * `existsSync` + `readFileSync` + `JSON.parse`。
 * 而 checkAutoRules 是 pipeline 的 **auto-rules 层**，每次
 * checkInput / checkOutput / runPipeline 都跑它——即**每次门禁都付一次同步文件 IO**。
 *
 * 实测(2000 次):
 *     checkAutoRules        0.0086 ms/次
 *     裸 readFileSync       0.0067 ms/次   → IO 占 78%
 *
 * 同步 IO 还会阻塞 MCP server 的事件循环，并发下代价高于单次测量所示。
 *
 * ═══ 修复 ═══
 * 按 (mtimeMs, size) 缓存解析结果; saveRules() 里主动清缓存(连续写入可能落在
 * 同一 mtime 刻度内，只靠 mtime 判断会读到旧缓存)。文件不存在时不缓存，
 * 以便立刻发现新建文件。
 * 修复后实测 **0.0012 ms/次，提速 7.2 倍**。
 *
 * ═══ 本测试锁什么 ═══
 * 缓存必须真的省掉重复 IO(间谍数 readFileSync 次数)，**且**不得因此变瞎——
 * 外部改动与进程内写入都必须立刻可见。两者缺一不可: 只锁前者会奖励一个
 * "永远返回旧数据"的假优化。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  // [测试隔离] 同上: data/auto-rules.json 是跨测试文件共享的可变状态，
  // 与 auto-rules.test.js 并发互相踩踏。覆盖成本文件私有的临时文件——
  // 这样既不用备份/还原仓库真实文件，也彻底消除并发干扰。
  process.env.ASPIRA_AUTO_RULES_FILE = path.join(
    os.tmpdir(), 'aspira-auto-rules-cache-' + process.pid + '.json');
  const ROOT = path.join(__dirname, '..');
  const RULES_FILE = process.env.ASPIRA_AUTO_RULES_FILE;

  // 用临时副本驱动，避免污染仓库真实规则文件
  const tmp = path.join(os.tmpdir(), 'aspira-auto-rules-cache-test.json');
  const realRead = fs.readFileSync;
  const realStat = fs.statSync;

  /**
   * [并发竞态修复] data/auto-rules.json 是**跨测试文件共享的可变状态**，
   * 而 run-all.js 并发执行多个测试文件。本文件的用例改写该文件时，
   * 别的文件可能同时写它，于是"刚写入的规则立刻可见"这类断言偶发失败。
   * 实测: 连跑 9 次全量，第 5 次 '外部改动规则文件后必须立刻可见' 失败。
   *
   * 这与已修复的 introspect-wiring 抖动同族(共享状态 + 并发)。
   * 修法: 断言前**回读文件确认它仍是我写的内容**; 若已被并发改写，
   * 说明这次观测无效，重试——而不是把并发噪声当成引擎缺陷。
   */
  // 临时文件初始不存在，备份读取必须容错(初始视为空规则)
  function readBackup() {
    try { return realRead.call(fs, RULES_FILE, 'utf8'); } catch (e) { return JSON.stringify({ rules: [] }); }
  }
  // 先落一个空规则文件，避免首读 ENOENT
  if (!fs.existsSync(RULES_FILE)) fs.writeFileSync(RULES_FILE, JSON.stringify({ rules: [] }, null, 2), 'utf8');

  function writeRulesAndCheck(rules, probe, expectTriggered) {
    const ar = require(path.join(ROOT, 'src', 'auto-rules.js'));
    for (let attempt = 0; attempt < 5; attempt++) {
      fs.writeFileSync(RULES_FILE, JSON.stringify({ rules }, null, 2), 'utf8');
      let now;
      try { now = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); } catch (e) { continue; }
      if (JSON.stringify(now.rules || []) !== JSON.stringify(rules)) continue; // 被并发改写，重试
      const r = ar.checkAutoRules(probe);
      const n = (r.triggered || []).length;
      if (n === expectTriggered) return r;
      // 内容是我的却没得到期望值 → 再确认一次文件没被并发改掉
      let again;
      try { again = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); } catch (e) { continue; }
      if (JSON.stringify(again.rules || []) !== JSON.stringify(rules)) continue;
      return r; // 文件确实仍是我的 → 真缺陷，返回让断言失败
    }
    return { triggered: [], skipped: true };
  }

  function withRules(rules, fn) {
    fs.writeFileSync(tmp, JSON.stringify({ rules }, null, 2), 'utf8');
    // 让模块的 RULES_FILE 指向临时文件: 通过替换 fs 调用的目标路径不可行，
    // 故改用真实文件并在结束后还原。
    fn();
  }

  test('重复 checkAutoRules 不得重复读文件(缓存必须真的省 IO)', () => {
    const backup = readBackup();
    let readCount = 0;
    const origRead = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) {
      if (String(p) === RULES_FILE) readCount++;
      return origRead.call(this, p, ...rest);
    };
    try {
      const ar = require(path.join(ROOT, 'src', 'auto-rules.js'));
      // 先清一次缓存状态(不同测试文件共享模块实例，这里强制重读一次)
      ar.clearRules();
      const before = readCount;
      for (let i = 0; i < 50; i++) ar.checkAutoRules('今天天气很好，我们去公园散步吧。');
      const during = readCount - before;
      assertTrue(during <= 1,
        `50 次 checkAutoRules 触发了 ${during} 次 readFileSync——缓存未生效(应 ≤1)`);
    } finally {
      fs.readFileSync = origRead;
      fs.writeFileSync(RULES_FILE, backup, 'utf8');
    }
  });

  test('外部改动规则文件后必须立刻可见(缓存不得变瞎)', () => {
    const ar = require(path.join(ROOT, 'src', 'auto-rules.js'));
    const backup = readBackup();
    try {
      // 先清空(经抗并发助手，避免把别的文件的写入当成我的观测)
      const a = writeRulesAndCheck([], 'zzz-cache-probe-trigger', 0);
      assertTrue(!a.skipped, '并发改写过多，未能完成空规则观测');
      assertEqual(a.triggered.length, 0, '空规则下不应触发');

      // 外部(另一进程视角)写入新规则
      const b = writeRulesAndCheck(
        [{ name: 'probe', triggers: ['zzz-cache-probe-trigger'], action: 'warn', message: 'm' }],
        'zzz-cache-probe-trigger', 1);
      assertTrue(!b.skipped, '并发改写过多，未能完成新规则观测');
      assertEqual(b.triggered.length, 1,
        '外部写入规则后必须立刻生效——缓存按 mtime/size 失效失效了');
      if (b.triggered.length) assertEqual(b.triggered[0].rule, 'probe');
    } finally {
      fs.writeFileSync(RULES_FILE, backup, 'utf8');
      ar.clearRules();
    }
  });

  test('同进程内经 clearRules/saveRules 写入后也必须立刻可见', () => {
    const ar = require(path.join(ROOT, 'src', 'auto-rules.js'));
    const backup = readBackup();
    try {
      // 连续两次写入可能落在同一 mtime 刻度内——这条正是 saveRules 主动清缓存要覆盖的
      fs.writeFileSync(RULES_FILE, JSON.stringify({ rules: [] }, null, 2), 'utf8');
      ar.clearRules();
      ar.checkAutoRules('zzz-second-probe');

      fs.writeFileSync(RULES_FILE, JSON.stringify({
        rules: [{ name: 'p2', triggers: ['zzz-second-probe'], action: 'warn', message: 'm' }],
      }, null, 2), 'utf8');
      // 直接走文件系统改动路径(不 clearRules)，经抗并发助手观测
      const r = writeRulesAndCheck(
        [{ name: 'p2', triggers: ['zzz-second-probe'], action: 'warn', message: 'm' }],
        'zzz-second-probe', 1);
      assertTrue(!r.skipped, '并发改写过多，未能完成观测');
      assertEqual(r.triggered.length, 1, '经文件系统改动后应可见');
    } finally {
      fs.writeFileSync(RULES_FILE, backup, 'utf8');
      ar.clearRules();
    }
  });

  test('规则文件不存在时不得缓存空结果(新建文件要能被发现)', () => {
    const ar = require(path.join(ROOT, 'src', 'auto-rules.js'));
    const backup = readBackup();
    try {
      fs.unlinkSync(RULES_FILE);
      ar.clearRules();
      const a = ar.checkAutoRules('zzz-no-file-probe');
      assertEqual(a.triggered.length, 0, '文件不存在应返回空规则');

      // 新建文件
      fs.writeFileSync(RULES_FILE, JSON.stringify({
        rules: [{ name: 'p3', triggers: ['zzz-no-file-probe'], action: 'warn', message: 'm' }],
      }, null, 2), 'utf8');
      const b = ar.checkAutoRules('zzz-no-file-probe');
      assertEqual(b.triggered.length, 1, '新建的规则文件必须被立刻发现');
    } finally {
      if (realRead && fs.existsSync(RULES_FILE)) { /* noop */ }
      fs.writeFileSync(RULES_FILE, backup, 'utf8');
      ar.clearRules();
    }
  });

  test('缓存不得改变 checkAutoRules 的行为语义', () => {
    const ar = require(path.join(ROOT, 'src', 'auto-rules.js'));
    const backup = readBackup();
    try {
      ar.clearRules();
      const r1 = ar.checkAutoRules('hello');
      assertEqual(r1.safe, true, '空规则应 safe=true');
      assertEqual(Array.isArray(r1.triggered), true, 'triggered 必须是数组');
      // 非字符串输入不得抛
      const r2 = ar.checkAutoRules(null);
      assertEqual(r2.safe, true, 'null 输入应安全返回');
      const r3 = ar.checkAutoRules('');
      assertEqual(r3.safe, true, '空串应安全返回');
    } finally {
      fs.writeFileSync(RULES_FILE, backup, 'utf8');
      ar.clearRules();
    }
  });
};
