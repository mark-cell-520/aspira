/**
 * test/git-binary-path-independence.test.js — git 不得依赖调用方 PATH
 *
 * [doc-honest-numbers·第一百四十二轮] 新建。
 *
 * ═══ 一个查了六轮的间歇红，根因是环境泄漏进测试 ═══
 * `test/security-audit.test.js` 的 S2 用例在 run-all 里间歇性失败，报
 * `spawnSync git ENOENT`，而单独跑同一文件全绿。AGENTS.md 从 cycle 29 起
 * 记了六轮"审计 ~1/6 红、实测 1637/13 而文档说 1638/12"，每次都归因为
 * "间歇性单例波动、根因未定位"。
 *
 * 本轮定位: **不是并发、不是 git 缺失、不是文档漂移**。git 在
 * `/usr/bin/git`，而测试进程的 PATH 只含 `/usr/local/bin` —— 由**调用方**
 * 环境决定。于是这个检查的可用性取决于谁调用它: 从 PATH 更全的入口跑就绿，
 * 从 run-all 跑就红。
 *
 * ⚠️ 它同时踩中本仓库两条最贵的教训:
 *   ① 铁律 3 警告的形状 —— 失败只出现在通道 b 的文件级汇总行
 *      ("安全审计回归: 15 通过, 1 失败")，而"失败的测试:"清单**从不收录**
 *      它，所以任何以清单 diff 为唯一依据的比对都会漏判。本轮就是这样:
 *      前六轮的清单 diff 全部显示"与基线一致"，而总数一直在抖。
 *   ② 一个数字 measured 但 never compared —— 文档的测试数读数(1638/12)
 *      是**以清单为准**同步的，于是它带着这个入口依赖性一起漂。
 *
 * ═══ 修法 ═══
 * S2 显式在若干标准位置找 git 二进制，找到即用绝对路径; 找不到才回退到
 * PATH 查找(那时 ENOENT 才是真实的 git 缺失)。修后三次 run-all 与三次审计
 * 全部稳定在 1638/12 与 87/87。
 *
 * ═══ 本锁钉住三件事 ═══
 *   ① 源级: S2 不得再用裸 'git' 字面量(那正是 PATH 依赖);
 *   ② 行为: 在**刻意收窄 PATH** 的子进程里跑 security-audit，必须全绿;
 *   ③ 反向: 若把修复删掉(回到裸 'git')，②必须红 —— 否则本锁恒真。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');

  const SA = path.join(__dirname, 'security-audit.test.js');
  const src = fs.readFileSync(SA, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  // ── 一、源级: S2 不得再用裸 'git' ────────────────────
  test('S2 不得依赖 PATH 查找 git(必须显式解析二进制路径)', () => {
    // S2 用例体内不得出现 execFileSync('git', ...) 形态
    const i = src.indexOf("t('S2: _verifyGitCommit");
    const j = src.indexOf('\n});', i);
    if (i < 0 || j <= i) throw new Error('找不到 S2 用例(锚点已变?)');
    const body = src.slice(i, j);
    assertTrue(!/execFileSync\(\s*'git'/.test(body),
      'S2 仍用裸 \'git\' 字面量 —— 它的可用性取决于调用方 PATH, ' +
      '从 run-all 跑会 ENOENT 而单独跑全绿(实测根因)');
    // 必须显式列候选路径并取绝对路径
    assertTrue(/GIT_CANDIDATES/.test(body),
      'S2 应显式列出 git 候选路径(GIT_CANDIDATES)');
    assertTrue(/gitBin/.test(body),
      'S2 应把解析出的 gitBin 传给 execFileSync');
  });

  // ── 二、行为: 收窄 PATH 的子进程里必须全绿 ────────────
  test('PATH 只含 /usr/local/bin 时 security-audit 必须全绿', () => {
    // 复现实测环境: 该目录下没有 git(git 在 /usr/bin)
    assertTrue(!fs.existsSync('/usr/local/bin/git'),
      '前提失效: /usr/local/bin/git 竟然存在, 本用例的收窄不再有区分力');
    const r = spawnSync('node', [SA], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 300000,
      env: Object.assign({}, process.env, { PATH: '/usr/local/bin', ASPIRA_TEST_RUNNER: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = ((r.stdout || '') + (r.stderr || '')).toString();
    assertTrue(/安全审计回归:\s*(\d+)\s*通过,\s*0\s*失败/.test(out),
      '收窄 PATH 后 security-audit 仍有失败 —— git 又在依赖 PATH:\n' +
      out.split('\n').filter(l => /❌|失败/.test(l)).slice(0, 4).join('\n'));
  });

  // ── 三、反向证明: 删掉修复必须红 ────────────────────
  test('本锁必须能红: 把 S2 退回裸 git 后行为用例必须失败', () => {
    // 这是"一把锁能不能失败"的自证。做法与变异验证一致: 改副本、跑、断言红。
    // ⚠️ 副本必须放回 test/ 下(不能放 tmp): S2 内部按 `path.resolve(__dirname,'..')`
    // 推 PROJECT_ROOT，放 tmp 会解析出一个没有 .git 的根，于是 S2 走"非 git 副本"
    // 的跳过分支 —— 那样退回裸 git 也"全绿"，本自证会恒真(实测踩过)。
    const tmp = path.join(__dirname, '_sa-regress-tmp.js');
    const orig = fs.readFileSync(SA, 'utf8');
    const reverted = orig.replace(/execFileSync\(gitBin,/g, "execFileSync('git',");
    if (reverted === orig) throw new Error('变异未生效(锚点已变?) —— 本锁的自证前提失效');
    fs.writeFileSync(tmp, reverted);
    try {
      const r = spawnSync('node', [tmp], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 300000,
        env: Object.assign({}, process.env, { PATH: '/usr/local/bin', ASPIRA_TEST_RUNNER: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = ((r.stdout || '') + (r.stderr || '')).toString();
      assertTrue(!/安全审计回归:\s*(\d+)\s*通过,\s*0\s*失败/.test(out),
        '退回裸 git 后竟然仍全绿 —— 本锁的行为用例失去区分力(恒真锁)');
      assertTrue(/ENOENT/.test(out),
        '退回裸 git 后的失败原因不是 ENOENT, 与实测根因不符, 需重新核对');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
};
