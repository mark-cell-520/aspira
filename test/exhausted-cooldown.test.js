/**
 * test/exhausted-cooldown.test.js — `exhausted` 必须是冷却期, 不是永久单向阀
 *
 * ═══ 缺陷(本轮实测发现) ═══
 * `scripts/autonomous-upgrade.js` 收集历史时:
 *
 *     if (j.once || j.exhausted) completed.add(j.chosen);
 *     ...
 *     const add = (opt) => { if (!completed.has(opt.id)) C.push(opt); };
 *
 * **`exhausted` 是永久单向阀**: 一旦某轮 journal 标了 exhausted: true，
 * 该切片从此退出候选空间，**再也不会回来**。
 *
 * 实测后果: `doc-honest-numbers` 在第 N 轮因"当时确已枯竭"被标 exhausted
 * (那轮的判断没错)，但**"枯竭"是可恢复的** ——
 * 文档数字会随代码增长再次出现偏差。而该切片已永久消失，
 * 候选空间从 7 个降到 6 个。
 *
 * 更糟的是**轮换能力被削弱**: 最能制衡 test-coverage-gap 的
 * 那个选项(feasibility 0.85 / risk 0.15 / cons 0.5，得分最高)不在了，
 * 于是 test-coverage-gap 连续 28 次被选中。
 * 一个为了让系统轮换而加的机制，最后**破坏了轮换**。
 *
 * ═══ 修法 ═══
 * 区分两种语义:
 *   `once`      → 永久移出。一次性工作(如"接线 text-normalizer")，
 *                 接线做完了就是做完了，不存在"再次需要接线"。
 *   `exhausted` → **冷却期** EXHAUST_COOLDOWN 个周期后自动恢复。
 *                 "枯竭"几乎总是暂时的。
 *
 * ═══ 本测试锁什么 ═══
 * ① once 仍是永久移出(不能把冷却期逻辑误用到 once 上)
 * ② exhausted 在冷却期内不参选
 * ③ exhausted 冷却期满后**恢复参选**
 * ④ 修复后 doc-honest-numbers 必须回到候选空间(实测回归)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'autonomous-upgrade.js');

module.exports = function ({ test, assertEqual, assertTrue }) {

  // 在临时目录里搭一个假 repo，只含脚本需要的 JOURNAL 与最小 src 树
  function mkRepo(journals) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-cooldown-'));
    fs.mkdirSync(path.join(tmp, 'memory', 'autonomous-upgrades'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'test'), { recursive: true });
    // 最小 src 树: 让 indexSrc/mcpSrc/gateSrc/hfSrc 读得到
    // 注意: 三个 once 切片的接线检测必须为"已接线"，
    // 否则它们会以 consequence_value 0.85/0.55/0.35 参选并盖过被测切片。
    fs.writeFileSync(path.join(tmp, 'src', 'index.js'),
      "const dimMap = { a:1, b:2, c:3 };\nrequire('./text-normalizer');\nrequire('./false-positive-feedback');\nrequire('./gate-verdict');\n");
    fs.writeFileSync(path.join(tmp, 'src', 'mcp-server.js'),
      "require('./false-positive-feedback');\n");
    fs.writeFileSync(path.join(tmp, 'src', 'gate.js'),
      "require('./text-normalizer');\nrequire('./false-positive-feedback');\n");
    fs.writeFileSync(path.join(tmp, 'src', 'core', 'heartflow.js'),
      "require('../gate-verdict');\n");
    fs.writeFileSync(path.join(tmp, 'src', 'core', 'decision.js'),
      fs.readFileSync(path.join(ROOT, 'src', 'core', 'decision.js'), 'utf8'));
    // decision.js 的依赖
    for (const dep of ['decision.js']) {
      // decision.js 只 require 本地兄弟模块; 尝试复制它 require 的
    }
    fs.copyFileSync(SCRIPT, path.join(tmp, 'scripts', 'autonomous-upgrade.js'));
    journals.forEach((j, i) => {
      fs.writeFileSync(
        path.join(tmp, 'memory', 'autonomous-upgrades', 'upgrade-' + String(1000000000000 + i) + '.json'),
        JSON.stringify(j)
      );
    });
    return tmp;
  }

  const run = (tmp) => {
    const out = execFileSync('node', [path.join(tmp, 'scripts', 'autonomous-upgrade.js')], {
      cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const i = out.indexOf('{');
    return JSON.parse(out.slice(i));
  };

  // ─── ① once 仍是永久移出 ───────────────────────────────────
  test('once 仍是永久移出(冷却期逻辑不得误用)', () => {
    const tmp = mkRepo([
      { status: 'done', chosen: 'wire-text-normalizer', once: true },
      ...Array.from({ length: 40 }, () => ({ status: 'done', chosen: 'test-coverage-gap' })),
    ]);
    try {
      const r = run(tmp);
      assertTrue(r.chosen !== 'wire-text-normalizer',
        'once 切片必须永久移出, 不得因冷却期满而复活');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ─── ② exhausted 冷却期内不参选 ────────────────────────────
  test('exhausted 在冷却期内不参选', () => {
    // doc-honest-numbers 刚被标 exhausted(最后一轮), 之后只跑了 2 轮
    const journals = [
      ...Array.from({ length: 3 }, () => ({ status: 'done', chosen: 'test-coverage-gap' })),
      { status: 'done', chosen: 'doc-honest-numbers', exhausted: true },
      { status: 'done', chosen: 'test-coverage-gap' },
      { status: 'done', chosen: 'test-coverage-gap' },
    ];
    const tmp = mkRepo(journals);
    try {
      const r = run(tmp);
      assertTrue(r.chosen !== 'doc-honest-numbers',
        '刚标 exhausted 的切片在冷却期内不得参选');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ─── ③ exhausted 冷却期满后恢复参选 ────────────────────────
  test('exhausted 冷却期满后必须恢复参选', () => {
    // doc-honest-numbers 很早就被标 exhausted, 之后跑了很多轮 → 应已恢复。
    // done 次数会递减 consequence_value, 所以给**所有**常驻切片相同的
    // done 次数, 使唯一差异只剩 feasibility/risk/confidence:
    //   doc-honest-numbers   feas 0.85 risk 0.15 conf 0.75  ← 三项全优
    //   test-coverage-gap    feas 0.75 risk 0.20 conf 0.70
    // 因此若冷却期修复生效, doc 必须胜出。
    const N = 8;
    const ids = [
      'dimension-health-audit', 'test-coverage-gap', 'doc-honest-numbers',
      'fp-recall-calibration', 'mcp-tool-enhancement',
      'adversarial-robustness', 'performance-optimization',
    ];
    const journals = [];
    ids.forEach(id => {
      for (let i = 0; i < N; i++) {
        journals.push(i === 0 && id === 'doc-honest-numbers'
          ? { status: 'done', chosen: id, exhausted: true }
          : { status: 'done', chosen: id });
      }
    });
    const tmp = mkRepo(journals);
    try {
      const r = run(tmp);
      assertEqual(r.chosen, 'doc-honest-numbers',
        '冷却期满后 exhausted 切片必须回到候选空间并被选中(feasibility/risk/confidence 三项全优)');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ─── ④ 源码级: exhausted 不得再进 completed ────────────────
  test('源码级: exhausted 不得再直接进 completed 集合', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(!/if \(j\.once \|\| j\.exhausted\) completed\.add/.test(src),
      '不得再把 once 和 exhausted 混为一谈(那正是永久单向阀的写法)');
    assertTrue(/once\)\s*\{?\s*completed\.add|if \(j\.once\)/.test(src),
      'once 应单独处理');
    assertTrue(/EXHAUST_COOLDOWN/.test(src),
      '应存在冷却期常量');
  });
};
