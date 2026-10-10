/**
 * test/gitignore-src-anchor.test.js — src/ 下的源码不得被 .gitignore 规则吃掉
 *
 * ═══ 本轮(第一百九十三轮)发现的缺陷 ═══
 * `.gitignore` 第 39 行有一条无锚定规则 `benchmark/`。git 的目录模式
 * **匹配任意层级**，所以它把 `src/benchmark/` —— 一个源码目录 —— 整条忽略。
 *
 * 后果不是"文件没提交"这么轻。`src/benchmark/` 下三个模块
 * (benchmark-runner.js / failure-importer.js / latency-benchmark.js)
 * 曾在那里实现、被测试逐字锁定、实测工作(某一轮 journal 记录
 * "aspira_benchmark_run 在线返回 accuracy=1 total=2")，然后静默蒸发。
 *
 * 为什么十几轮都没发现: 文件从未进入 git，于是
 *   · `git status`       不显示它们(untracked 且被忽略 = 不可见)
 *   · `git diff`         不显示它们消失
 *   · `git checkout`     找不回它们(版本控制里从来没有过)
 * 每一轮 journal 都只记下症状("benchmark 族 4 个测试文件因缺失而红(既有)")，
 * 没有一轮问过"它们为什么不见了"。症状被当成静态背景记录了十几轮。
 *
 * 这是本仓库记录过的形状里最贵的一种: 不是"写错了"，而是
 * **"写对了但版本控制看不见，于是它随时可以不存在而不产生任何信号"**。
 *
 * ═══ 本测试锁什么 ═══
 * 1. .gitignore 里每一条无锚定目录规则，都不得匹配 src/ 下已存在的目录
 * 2. src/ 下每个已存在的目录都必须真的在 git 里(git ls-files 或未被忽略)
 * 3. 反向证明: 注入一条无锚定规则必须让用例 1 变红(锁本身可证伪)
 */

module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const ROOT = path.join(__dirname, '..');
  const GITIGNORE = path.join(ROOT, '.gitignore');

  function readIgnore() {
    return fs.readFileSync(GITIGNORE, 'utf8');
  }

  /**
   * 提取 .gitignore 里所有**无锚定**的目录规则(不以 / 开头、不以 / 结尾的裸名)。
   * 只认 `<name>/` 这一种目录模式; 带 `*` 的通配模式另行处理(见用例 3)。
   */
  function unanchoredDirRules(text) {
    const out = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      if (line.startsWith('!')) continue;              // 取反规则不管
      if (line.includes('*')) continue;                 // 通配模式单独处理
      if (!line.endsWith('/')) continue;                // 只看目录模式
      const name = line.slice(0, -1);
      if (name.startsWith('/')) continue;               // 已锚定, 不管
      if (name.includes('/')) continue;                 // 带路径的已限定层级
      out.push(name);
    }
    return out;
  }

  /** src/ 下真实存在的目录名 */
  function srcDirs() {
    const base = path.join(ROOT, 'src');
    return fs.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  }

  test('无锚定目录规则不得匹配 src/ 下任何目录', () => {
    const rules = unanchoredDirRules(readIgnore());
    const dirs = srcDirs();
    for (const r of rules) {
      assertTrue(dirs.indexOf(r) < 0,
        `.gitignore 的 "${r}/" 是无锚定规则, 匹配任意层级, 因此把 src/${r}/ ` +
        '这个源码目录也忽略了 —— 该目录下的模块将从未进入 git, 静默蒸发后 ' +
        'git status/diff/checkout 全都看不见。应改为 "/' + r + '/" 锚定到仓库根。');
    }
  });

  test('src/ 下每个目录都必须真的在 git 里(不被忽略)', () => {
    const dirs = srcDirs();
    let invisible = [];
    for (const d of dirs) {
      const probe = path.join('src', d, '.gitkeep-probe');
      let ignored = false;
      try {
        execFileSync('git', ['check-ignore', '-q', probe], { cwd: ROOT, stdio: 'ignore' });
        ignored = true;
      } catch (e) {
        ignored = false;   // exit 1 = 未被忽略
      }
      if (ignored) invisible.push('src/' + d);
    }
    assertEqual(invisible.length, 0,
      '这些 src/ 子目录被 .gitignore 忽略: ' + invisible.join(', '));
  });

  test('src/benchmark 三个模块必须存在且被 git 跟踪(本轮恢复的对象)', () => {
    const files = [
      'src/benchmark/benchmark-runner.js',
      'src/benchmark/failure-importer.js',
      'src/benchmark/latency-benchmark.js',
    ];
    for (const f of files) {
      assertTrue(fs.existsSync(path.join(ROOT, f)), `缺少 ${f}`);
      let ignored = false;
      try {
        execFileSync('git', ['check-ignore', '-q', f], { cwd: ROOT, stdio: 'ignore' });
        ignored = true;
      } catch (e) { ignored = false; }
      assertTrue(!ignored, `${f} 仍被 .gitignore 忽略 —— 它会重演静默蒸发`);
    }
  });

  test('反向证明: 注入一条无锚定规则必须让本锁变红(否则它恒真)', () => {
    // 不改真实 .gitignore —— 用同一个检测函数喂合成文本。
    // 若改成"改真文件再跑", 用例自身会污染仓库, 而 run-all 是并发运行的。
    const clean = readIgnore();
    const poisoned = clean + '\nshield/\n';   // src/shield/ 真实存在
    const before = unanchoredDirRules(clean).filter(r => srcDirs().indexOf(r) >= 0);
    const after = unanchoredDirRules(poisoned).filter(r => srcDirs().indexOf(r) >= 0);
    assertEqual(before.length, 0, '注入前应无冲突规则');
    assertTrue(after.indexOf('shield') >= 0,
      '注入 shield/ 后必须被检出 —— 否则用例 1 的判据看不见无锚定规则, ' +
      '那把锁就是一把不能打开的锁');
    // 并且确认 src/shield 真实存在(否则上面的断言是空的)
    assertTrue(srcDirs().indexOf('shield') >= 0, 'src/shield 应存在');
  });
};
