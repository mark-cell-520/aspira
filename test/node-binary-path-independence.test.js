/**
 * test/node-binary-path-independence.test.js — run-all 不得依赖调用方 PATH 找 node
 *
 * [test-coverage-gap·第二百零七轮] 新建。与 test/git-binary-path-independence.test.js
 * (cycle 142) 同构 —— 那次修的是"一个测试文件依赖调用方环境", 这次修的是
 * "**整个测试运行器**依赖调用方环境"。
 *
 * ═══ 实测形状(第二百零六轮收尾时撞上, 已复现) ═══
 * 调用方 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` 而 node 在 `/usr/local/bin/node`
 * 时, run-all 用字面量 node 起 397 个子进程, **全部** Command failed,
 * 全量测试读出 `0 通过 / 397 失败`。
 *
 * ⚠️ 它比 cycle 142 更难被发现, 原因有三:
 *   ① 症状是 100% 而非 1/6 —— 但补一下 PATH 就全绿, 于是它极易被记成
 *      "我这边的环境问题", 而它实际是**运行器自身的入口依赖**;
 *   ② 铁律 3 的双通道在这件事上完全失效: 397 个文件的失败全部落在
 *      "Command failed" 汇总行上, 而"失败的测试:"清单**一条都不收** ——
 *      正是 cycle 142 踩过的同一个坑, 只是这次规模放大了 397 倍;
 *   ③ 文档的测试数读数以清单为准同步, 于是它带着这个入口依赖性一起漂。
 *
 * ═══ 本锁钉住四件事 ═══
 *   ① 源级: run-all 三个 job 构造函数必须用 NODE_BIN, 不得再用裸 node 字面量;
 *   ② 行为: 在**刻意收窄 PATH**(其内确实找不到 node) 的环境里, 解析出的二进制
 *      必须是绝对路径, 且真的能跑完一个测试文件并给出汇总行;
 *   ③ 反向: 把解析换成裸 node 后, 同一收窄环境必须 ENOENT —— 否则②恒真;
 *   ④ 前提自证: 收窄后的 PATH 里必须真的找不到 node, 否则②没有区分力。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');

  const ROOT = path.join(__dirname, '..');
  const RUNNER = path.join(__dirname, 'run-all.js');
  const HELPER = path.join(__dirname, '_node-bin.js');
  const PROBE = path.join(__dirname, 'child-summary-parse.test.js');

  // 刻意收窄: 这两个目录下没有 node(node 在 /usr/local/bin), 与第二百零六轮实测一致
  const NARROW_PATH = '/usr/bin:/bin';
  const narrowEnv = Object.assign({}, process.env, { PATH: NARROW_PATH, ASPIRA_TEST_RUNNER: '1' });

  // 行注释剥掉再匹配(源码里 `node <file>` 之类字样出现在说明注释中, 不剥会自伤)
  const src = fs.readFileSync(RUNNER, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  // ── 一、源级: 三个 job 构造函数必须用 NODE_BIN ────────────
  test('run-all 起子进程必须用解析出的 NODE_BIN, 不得用裸 node 字面量', () => {
    assertTrue(/const\s*\{\s*NODE_BIN\s*\}\s*=\s*require\(['"]\.\/_node-bin\.js['"]\)/.test(src),
      'run-all 没有从 _node-bin.js 取 NODE_BIN —— 修复没接上');
    // 三处 cmd 构造: plain / mount / jest, 一处都不能漏
    const withBin = (src.match(/cmd:\s*`\$\{JSON\.stringify\(NODE_BIN\)\}/g) || []).length;
    assertEqual(withBin, 3,
      '应有 3 处 cmd 用 NODE_BIN 构造(plain/mount/jest), 实测 ' + withBin + ' 处');
    const bare = (src.match(/cmd:\s*`node /g) || []).length;
    assertEqual(bare, 0,
      '仍有 ' + bare + ' 处 cmd 用裸 node 字面量 —— 它的可用性取决于调用方 PATH');
  });

  // ── 二、前提自证: 收窄后的 PATH 里必须真的找不到 node ────
  test('前提自证: 收窄 PATH 后裸 node 必须不可用(否则本锁失去区分力)', () => {
    const r = spawnSync('/bin/sh', ['-c', 'command -v node'], {
      encoding: 'utf8', env: narrowEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assertEqual((r.stdout || '').toString().trim(), '',
      '收窄 PATH 后竟然还能找到 node —— 行为用例的收窄不再有区分力, 需换目录');
  });

  // ── 三、行为: 收窄 PATH 下解析出的二进制必须真的能跑 ──────
  test('PATH 收窄到没有 node 时, NODE_BIN 必须能跑完一个测试文件', () => {
    const { NODE_BIN } = require(HELPER);
    assertTrue(path.isAbsolute(NODE_BIN),
      'NODE_BIN 不是绝对路径(' + NODE_BIN + ') —— 那它仍要靠 PATH 查找');
    assertTrue(fs.existsSync(NODE_BIN), 'NODE_BIN 指向的文件不存在: ' + NODE_BIN);
    const r = spawnSync(NODE_BIN, [path.join(__dirname, '_mount.js'), PROBE], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300000,
      env: narrowEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = ((r.stdout || '') + (r.stderr || '')).toString();
    assertTrue(/测试结果:\s*\d+\s*通过,\s*0\s*失败/.test(out),
      '收窄 PATH 下子进程仍有失败 —— node 又在依赖 PATH:\n' +
      out.split('\n').filter(l => /失败|❌|Error/.test(l)).slice(0, 4).join('\n'));
  });

  // ── 四、反向证明: 换成裸 node 后, 同一环境必须 ENOENT ─────
  test('本锁必须能红: 解析退回裸 node 时, 收窄 PATH 下必须 ENOENT', () => {
    // 不改仓库文件: 直接验证"裸 node 在收窄 PATH 下确实起不来"这一事实本身。
    // 它正是修复所针对的形状, 也是行为用例若被削弱(比如把 NODE_BIN 换成 'node')
    // 时会遇到的结果 —— 没有这一条, 行为用例可能被一个恒真实现满足。
    const r = spawnSync('node', [path.join(__dirname, '_mount.js'), PROBE], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300000,
      env: narrowEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = ((r.stdout || '') + (r.stderr || '')).toString();
    assertTrue(r.error != null || /ENOENT/.test(out),
      '裸 node 在收窄 PATH 下竟然跑起来了 —— 本锁的行为用例失去区分力(恒真锁)');
    // 再补一份源级反向: 把 helper 的解析改成恒返 'node', 行为用例的谓词必须失败
    const tmp = path.join(__dirname, '_nb-regress-tmp.js');
    const orig = fs.readFileSync(HELPER, 'utf8');
    const reverted = orig.replace('const NODE_BIN = resolveNodeBin();', "const NODE_BIN = 'node';");
    if (reverted === orig) throw new Error('变异未生效(锚点已变?) —— 本锁的自证前提失效');
    fs.writeFileSync(tmp, reverted);
    try {
      const m = require(tmp);
      assertEqual(path.isAbsolute(m.NODE_BIN), false,
        '变异版 NODE_BIN 竟是绝对路径 —— 行为用例的第一条断言抓不到这个变异');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
};
