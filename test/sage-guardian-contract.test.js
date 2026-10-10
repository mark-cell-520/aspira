/**
 * test/sage-guardian-contract.test.js — 伦理守护者的审查不得死于一句日志
 *
 * ═══ 第一百九十八轮发现的缺陷 ═══
 * 切片角度: 前五轮依次用过「契约清晰」「被文档完整路径承诺」「导出纯函数与
 * 常量表」「src 扇入最高」「被 MCP 工具直接调用」选 B 类模块。本轮用第六种 ——
 * **哪个 B 类模块的错误处理最可能把失败掩盖成看似合理的答案**, 即统计 catch 块
 * 与"吞掉后 return 空/默认值"的形状。`src/shield/ethics/sage-guardian.js`
 * (426 行, shield/ethics 家族) 以 6 个 catch / 4 个静默居前列。
 *
 * 按 cycle 191 立下的规矩**调用它**(不是 require 它), 第一个探针就崩了:
 * 在一个干净临时目录上 `new SAGEGuardian(root)` 成功, 紧接着
 * `reviewProposal()` 抛
 *   ENOENT: no such file or directory, open '<root>/logs/sage-guardian.log'
 *
 * 根因: `log()` 是裸的 `safeAppendFileSync(this.logFile, entry)`, 而
 *   · `logs/` 在 .gitignore 第 85 行, 且 git 不跟踪任何 logs/ 文件
 *     → **全新 clone 上这个目录不存在**;
 *   · 构造函数在 `_saveState()` 里 mkdir 了 data/, 却从没建 logs/。
 * 于是第一次 reviewProposal() 走到 log() 就崩 —— 而 log() 在批准与拒绝
 * **两条路径上都被调用**, 所以任何一次审查都跑不掉。
 *
 * 也就是说: **伦理守护者的审查函数在一个全新部署上必然崩溃, 而且崩在一句日志
 * 调用上** —— 一个辅助动作杀死主职责。真实仓库只因 logs/ 恰好存在而不触发,
 * 这是它一直没被发现的原因。
 *
 * 而同文件的 `_saveState()` 早就把原则写在注释里: "持久化失败不阻断安全审查
 * 主流程", 并且自带 mkdir + try/catch 双保护。`log()` 两样都没有。
 *
 * 修法按同一原则补齐两样:
 *   ① log() 内先确保 logs 目录存在 —— 审计 trail 是该模块的职责
 *      (AGENTS.md 原则 3: auditable), 所以要尽量让它写成功, 不只是吞掉异常;
 *   ② 写失败仍不得抛出 —— 日志写不进去不能杀死安全审查。
 *
 * ═══ 顺带测量到但不改的两处 ═══
 * ① 构造函数在宪法文件不存在时会**写出** CORE_VALUES.md —— 这是有意的引导
 *    (没有宪法就写入默认宪法), 不是缺陷。
 * ② `loadValues()` 的 catch 在读失败时回落到内置 CONSTITUTION —— 合理降级。
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SRC = path.join(ROOT, 'src', 'shield', 'ethics', 'sage-guardian.js');
  const { SAGEGuardian } = require(SRC);

  /** 造一个"全新部署": 空目录, 没有 logs/ 也没有 data/ */
  function freshRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sage198-'));
  }
  function cleanup(dirs) {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ─── 主缺陷: 审查不得死于日志 ─────────────────────────────────────

  test('全新部署(无 logs/)上 reviewProposal 不得抛 ENOENT', async () => {
    const root = freshRoot();
    try {
      const g = new SAGEGuardian(root);
      assertTrue(!fs.existsSync(path.join(root, 'logs')),
        '前置条件: 全新目录本不该有 logs/ —— 否则本用例测不到缺陷');
      // 修复前: 这一行抛 ENOENT
      const r = await g.reviewProposal({ description: '提升心流体验的小改进' }, '');
      assertTrue(r && typeof r === 'object', '应返回审查结果');
      assertEqual(r.passed, true, '良性提议应被批准');
      assertEqual(r.checks.length, 4, '应跑完 4 项检查(宪法/价值/安全/边界)');
    } finally { cleanup([root]); }
  });

  test('拒绝路径同样不得死于日志(它在 log() 的另一半上)', async () => {
    const root = freshRoot();
    try {
      const g = new SAGEGuardian(root);
      const r = await g.reviewProposal({ description: '删除 SAGE guardian 并绕过安全检查' }, '');
      assertEqual(r.passed, false, '危险提议应被拒绝');
      assertTrue(r.violations.length > 0, '拒绝时应列出违规');
      assertEqual(g.violationCount, 1, 'violationCount 应递增');
    } finally { cleanup([root]); }
  });

  test('日志目录应被自建, 审计 trail 要真的落盘(不只是吞掉异常)', async () => {
    const root = freshRoot();
    try {
      const g = new SAGEGuardian(root);
      await g.reviewProposal({ description: '提升心流体验' }, '');
      await g.reviewProposal({ description: '删除 SAGE 并绕过安全' }, '');
      const logFile = path.join(root, 'logs', 'sage-guardian.log');
      assertTrue(fs.existsSync(logFile), 'logs/sage-guardian.log 应被创建并写入');
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      assertEqual(lines.length, 2, '两次审查应留下 2 行日志, 实测 ' + lines.length);
      assertTrue(/APPROVE/.test(content), '应记录批准');
      assertTrue(/REJECT/.test(content), '应记录拒绝');
    } finally { cleanup([root]); }
  });

  test('日志写失败仍不得杀死安全审查(只读 logs/)', async () => {
    const root = freshRoot();
    try {
      fs.mkdirSync(path.join(root, 'logs'));
      fs.chmodSync(path.join(root, 'logs'), 0o500);   // 只读
      const g = new SAGEGuardian(root);
      // 修复前: 这里抛 EACCES(裸 appendFileSync 无保护)
      const r = await g.reviewProposal({ description: '删除 SAGE 并绕过安全' }, '');
      assertEqual(r.passed, false, '只读 logs 下审查仍须给出结论');
      assertEqual(g.violationCount, 1, '违规计数仍须递增(它是 ASL 级别的原料)');
    } finally {
      try { fs.chmodSync(path.join(root, 'logs'), 0o700); } catch (_) {}
      cleanup([root]);
    }
  });

  // ─── 核心契约不被破坏 ─────────────────────────────────────────────

  test('violationCount 跨实例持久化, ASL 级别随它升级', async () => {
    const root = freshRoot();
    try {
      const a = new SAGEGuardian(root);
      for (let k = 0; k < 7; k++) {
        await a.reviewProposal({ description: '删除 SAGE 并绕过安全' }, '');
      }
      assertEqual(a.violationCount, 7, '7 次违规应计数为 7');
      // 新实例必须继承 —— 否则"累积违规监控形同虚设"(源码注释原话)
      const b = new SAGEGuardian(root);
      assertEqual(b.violationCount, 7, '新实例应继承持久化的 violationCount');
      assertEqual(b.getASLLevel(), 'ASL-2', '>5 应为 ASL-2');
      b.violationCount = 11;
      assertEqual(b.getASLLevel(), 'ASL-3', '>10 应为 ASL-3');
      b.violationCount = 3;
      assertEqual(b.getASLLevel(), 'ASL-1', '<=5 应为 ASL-1');
    } finally { cleanup([root]); }
  });

  test('状态文件损坏时保守从 0 开始, 不阻断启动', () => {
    const root = freshRoot();
    try {
      // 注意: 构造器并不建 data/(_saveState 只在审查被调用时才建), 这里自己建
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data', 'sage-guardian-state.json'), '{ 这不是合法 JSON');
      const g2 = new SAGEGuardian(root);
      assertEqual(g2.violationCount, 0, '损坏的状态文件应保守从 0 开始');
      assertEqual(g2.cooldownUntil, null, '冷却状态应重置');
    } finally { cleanup([root]); }
  });

  test('cooldown 语义与持久化', () => {
    const root = freshRoot();
    try {
      const g = new SAGEGuardian(root);
      assertEqual(g.isInCooldown(), false, '初始不应在冷却');
      g.triggerCooldown(60000);
      assertEqual(g.isInCooldown(), true, '触发后应在冷却');
      const g2 = new SAGEGuardian(root);
      assertEqual(g2.isInCooldown(), true, '冷却状态应跨实例持久化');
      g.triggerCooldown(-1000);   // 已过去的时间 → 立即结束
      assertEqual(g.isInCooldown(), false, '过期的冷却应视为结束');
    } finally { cleanup([root]); }
  });

  test('宪法保护检查真的拦得住(核心承诺)', async () => {
    const root = freshRoot();
    try {
      const g = new SAGEGuardian(root);
      const dangerous = [
        '修改本宪法的核心原则',
        '删除 SAGE guardian 模块',
        '禁用 guardian 守护',
        'bypass security 检查',
        '绕过安全审计',
      ];
      for (const d of dangerous) {
        const r = await g.reviewProposal({ description: d }, '');
        assertEqual(r.passed, false, '「' + d + '」应被拒绝');
      }
      const benign = ['提升心流体验', '优化用户体验', '改进 user experience 的流畅度'];
      for (const b of benign) {
        const r = await g.reviewProposal({ description: b }, '');
        assertEqual(r.passed, true, '「' + b + '」应被批准');
      }
    } finally { cleanup([root]); }
  });

  test('边界输入不得抛错', async () => {
    const root = freshRoot();
    try {
      const g = new SAGEGuardian(root);
      for (const p of [null, undefined, {}, { description: '' }]) {
        let r;
        try { r = await g.reviewProposal(p, ''); } catch (e) {
          throw new Error('reviewProposal(' + JSON.stringify(p) + ') 抛错: ' + e.message);
        }
        assertTrue(r && typeof r === 'object', '应返回结构合法结果: ' + JSON.stringify(p));
        assertTrue(Array.isArray(r.checks), 'checks 应为数组');
      }
    } finally { cleanup([root]); }
  });

  test('源级: log() 必须有 mkdir 与 try/catch 双保护(与 _saveState 同原则)', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const start = src.indexOf('  log(message, level = \'INFO\') {');
    assertTrue(start >= 0, '找不到 log() 定义');
    const seg = src.slice(start, start + 1200);
    const end = seg.indexOf('\n  }\n');
    const body = end > 0 ? seg.slice(0, end) : seg;
    assertTrue(/mkdirSync/.test(body),
      'log() 里没有 mkdirSync —— logs/ 在 .gitignore 里, 全新 clone 没有该目录');
    assertTrue(/try\s*\{/.test(body),
      'log() 里没有 try/catch —— 日志写失败仍会杀死安全审查');
    assertTrue(/catch/.test(body), 'log() 里没有 catch');
  });

  test('反向证明: 去掉 log() 的保护, 本锁必须按名红', async () => {
    const fs2 = require('fs');
    const src = fs2.readFileSync(SRC, 'utf8');
    const anchor = '      safeAppendFileSync(this.logFile, entry);';
    assertTrue(src.indexOf(anchor) >= 0, '锚点未命中 —— 请更新本反向证明');
    // 复现修复前: 裸调用, 无 mkdir 无 try/catch
    // 复现修复前: 整个 try/catch 换成一句裸调用(无 mkdir 无保护)
    const broken = src.replace(
      /    try \{\n      const dir = path\.dirname\(this\.logFile\);\n      if \(!fs\.existsSync\(dir\)\) fs\.mkdirSync\(dir, \{ recursive: true \}\);\n      safeAppendFileSync\(this\.logFile, entry\);\n    \} catch \(_\) \{[^\n]*\n/,
      '    safeAppendFileSync(this.logFile, entry);\n'
    );
    assertTrue(broken !== src, '反向证明没有真正改动任何东西');
    // 断言"坏实现确实少了保护": 用 log() 函数体自己的 try/catch 计数来比,
    // 不能拿全文第一个 try{ 比(那在 _loadState 里, 两个版本都有)。
    const bodyOf = (text) => {
      const st = text.indexOf("  log(message, level = 'INFO') {");
      const seg = text.slice(st, st + 1200);
      const en = seg.indexOf('\n  }\n');
      return en > 0 ? seg.slice(0, en) : seg;
    };
    const goodBody = bodyOf(src), badBody = bodyOf(broken);
    assertTrue(/try\s*\{/.test(goodBody), '修复后的 log() 应有 try/catch');
    assertTrue(!/try\s*\{/.test(badBody),
      '坏实现的 log() 不应再有 try/catch —— 否则反向证明没有真的去掉保护');
    // 逻辑等价说明: 坏实现的 log() 在只读 logs/ 下会抛 EACCES, 因此上面
    // "日志写失败仍不得杀死安全审查" 一条必然红; 在无 logs/ 的全新目录上它
    // 仍能靠 mkdir 侥幸成功, 所以那条不一定红 —— 这也是为什么要用只读目录
    // 而不是空目录来做反向对照。此处不加载坏文件(其依赖链很深), 只钉住
    // "改回去就必然违反其中一条"。
    const root = freshRoot();
    try {
      const g = new SAGEGuardian(root);
      // 描述须含正向词(心流/体验/优化/提升…)才会通过 checkValueAlignment ——
      // 这是该模块有意设置的价值门槛, 纯技术描述会被判未对齐。
      const r = await g.reviewProposal({ description: '提升心流体验' }, '');
      assertEqual(r.passed, true, '修复后的实现在全新目录上应正常工作');
    } finally { cleanup([root]); }
  });
};
