/**
 * test/slice-rotation.test.js — 轮换权重必须**真的在轮换**
 *
 * [第二十六轮] 新建。修的问题是: 轮换权重按**累计**完成次数衰减 consequence_value,
 * 下限 0.05。实测它早已饱和失效 —— doc-honest-numbers 完成 33 次、
 * test-coverage-gap 37 次, 两者都被压到同一个 0.05, consequence_value 对所有候选
 * 变成**同一个常数**, 在复合分里不再有任何区分度。而复合分公式(decision.js)里
 * cost 根本不出现, 于是排名永久退化成静态可行性/风险/置信表, 而那张表结构性
 * 偏袒 doc-honest-numbers(feasibility 0.85 / risk 0.15 / confidence 0.75 全最高),
 * 于是它连选 8 个周期。
 *
 * **一个声称在轮换、实则 28 个周期前就饱和的机制。**
 *
 * 本文件的锁, 每一条都对着那个失效模式:
 *   ① 近期窗口内被反复选中的切片**不得**再被选中(轮换必须真的发生);
 *   ② 近期 0 次的切片**能够**胜出(否则①可以用"永远选同一个冷门切片"骗过去);
 *   ③ 权重不得饱和: 近期次数不同的两个切片, 衰减后必须得到**不同**的
 *      consequence_value(③ 是那条饱和 bug 的直接锁, 也是①能成立的原因);
 *   ④ 饱和回归测试: 把脚本改回旧实现(累计 + 0.05 下限), ① 必须翻红。
 *     没有④, ①可以被任何一种"反正不选它"的实现骗过去 —— 包括那个 bug 本身。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'autonomous-upgrade.js');

const RESIDENT = [
  'dimension-health-audit', 'test-coverage-gap', 'doc-honest-numbers',
  'fp-recall-calibration', 'mcp-tool-enhancement',
  'adversarial-robustness', 'performance-optimization',
];

module.exports = function ({ test, assertEqual, assertTrue }) {

  // 复用 exhausted-cooldown 的最小 repo 形状: 三个 once 切片的接线检测必须为
  // "已接线", 否则它们会以更高的 consequence_value 参选并盖过被测切片。
  function mkRepo(journals) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-rotation-'));
    fs.mkdirSync(path.join(tmp, 'memory', 'autonomous-upgrades'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'test'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'index.js'),
      "const dimMap = { a:1, b:2, c:3 };\nrequire('./text-normalizer');\nrequire('./false-positive-feedback');\nrequire('./gate-verdict');\n");
    fs.writeFileSync(path.join(tmp, 'src', 'mcp-server.js'), "require('./false-positive-feedback');\n");
    fs.writeFileSync(path.join(tmp, 'src', 'gate.js'),
      "require('./text-normalizer');\nrequire('./false-positive-feedback');\n");
    fs.writeFileSync(path.join(tmp, 'src', 'core', 'heartflow.js'), "require('../gate-verdict');\n");
    fs.writeFileSync(path.join(tmp, 'src', 'core', 'decision.js'),
      fs.readFileSync(path.join(ROOT, 'src', 'core', 'decision.js'), 'utf8'));
    fs.copyFileSync(SCRIPT, path.join(tmp, 'scripts', 'autonomous-upgrade.js'));
    journals.forEach((j, i) => {
      fs.writeFileSync(
        path.join(tmp, 'memory', 'autonomous-upgrades', 'upgrade-' + String(1000000000000 + i) + '.json'),
        JSON.stringify(j));
    });
    return tmp;
  }

  const run = (tmp, scriptFile) => {
    const out = execFileSync('node', [scriptFile || path.join(tmp, 'scripts', 'autonomous-upgrade.js')], {
      cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const i = out.indexOf('{');
    return JSON.parse(out.slice(i));
  };

  const done = (id, n) => Array.from({ length: n }, () => ({ status: 'done', chosen: id }));
  const flat = (...groups) => [].concat(...groups);

  // 饱和场景: doc 与 test-coverage 的**累计**次数都远超 6(旧权重 0.08/次 的
  // 衰减在 6 次后必然触到 0.05 下限), 而**近期窗口**里 doc 4 次、test-coverage 2 次。
  // 这一个 history 同时满足:
  //   · 新权重(近期): doc 0.5-0.56=0.05, test-coverage 0.6-0.28=0.32 → 不同
  //   · 旧权重(累计): doc 0.5-0.08*29<0 → 0.05, test-coverage 0.6-0.08*27<0 → 0.05 → 相同
  // 真实仓库里这两个切片是 33 次 / 37 次, 都早就压在下限上, 所以这不是人造场景。
  const SATURATING = () => flat(
    done('doc-honest-numbers', 25),
    done('test-coverage-gap', 25),
    done('doc-honest-numbers', 4),
    done('test-coverage-gap', 2),
    done('performance-optimization', 2),
    done('mcp-tool-enhancement', 2)
  );

  // ─── ① 近期霸屏的切片不得再被选中 ────────────────────────
  test('近期窗口内被反复选中的切片不得再被选中', () => {
    // doc-honest-numbers 占满整个近期窗口; 其余切片近期 0 次。
    // 旧权重下 doc 与 test-coverage-gap 都被压到 0.05, doc 靠 feas/risk/conf
    // 三项全优胜出 —— 那正是它连选 8 个周期的机制。
    const journals = flat(done('doc-honest-numbers', 12), done('test-coverage-gap', 1));
    const tmp = mkRepo(journals);
    try {
      const r = run(tmp);
      assertTrue(r.chosen !== 'doc-honest-numbers',
        '近期窗口内被反复选中的切片必须让位, 实测 chosen=' + r.chosen);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ─── ② 裁决必须响应历史, 而不是被钉在同一个切片上 ──────────
  test('同一个切片在一种历史下胜出、在另一种历史下必须落选(否则①可用"永远选同一个冷门切片"骗过)', () => {
    // 实测过一个反直觉的事实: doc-honest-numbers 的结构性优势(feas 0.85 /
    // risk 0.15 / conf 0.75, 而 risk 在复合分里占 0.25)大到**只要它近期 0 次
    // 就能赢** —— 连 dimension-health(cv 0.7)都赢不了它。所以不能断言
    // "cv 最高者胜出", 那会被 feas/risk/conf 推翻。
    // 真正要锁的是**响应性**: 换掉"谁在近期霸屏", 同一个切片的胜负必须翻转。
    //   a: doc 自己霸屏近期窗口 → doc 必须落选(与①同一场景, 互为对照)
    //   b: 换成 performance 霸屏 → doc 必须胜出
    const a = mkRepo(flat(done('doc-honest-numbers', 12), done('test-coverage-gap', 1)));
    const b = mkRepo(flat(done('performance-optimization', 12), done('test-coverage-gap', 1)));
    try {
      const ra = run(a), rb = run(b);
      assertTrue(ra.chosen !== 'doc-honest-numbers',
        'doc 自己霸屏近期窗口时必须落选, 实测 chosen=' + ra.chosen);
      assertEqual(rb.chosen, 'doc-honest-numbers',
        '换成别的切片霸屏时, doc(近期 0 次 + feas/risk/conf 三项全优)必须胜出, 实测 chosen=' + rb.chosen);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  // ─── ③ 权重不得饱和: 近期次数不同的切片必须得到不同的值 ────
  test('轮换权重不得饱和: 近期次数不同的切片衰减后必须得到不同的值', () => {
    // 直接观测权重本身(--debug-candidates), 不经过决策。
    // 复合分里 feasibility/risk/confidence 同时在起作用, 从"最终选了谁"反推
    // 权重有没有区分度是推不出来的 —— 那正是它饱和 28 个周期没人发现的原因。
    const tmp = mkRepo(SATURATING());
    try {
      const out = execFileSync('node',
        [path.join(tmp, 'scripts', 'autonomous-upgrade.js'), '--debug-candidates'],
        { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const i = out.indexOf('{');
      const d = JSON.parse(out.slice(i));
      const byId = {};
      for (const c of d.candidates) byId[c.id] = c;
      assertTrue(byId['doc-honest-numbers'].recentCount === 4,
        '前提检查: doc-honest-numbers 必须近期 4 次, 实测 recentCount='
        + byId['doc-honest-numbers'].recentCount);
      assertTrue(byId['test-coverage-gap'].recentCount === 2,
        '前提检查: test-coverage-gap 必须近期 2 次, 实测 recentCount='
        + byId['test-coverage-gap'].recentCount);
      assertTrue(byId['doc-honest-numbers'].totalDone >= 20 && byId['test-coverage-gap'].totalDone >= 20,
        '前提检查: 两者的累计次数都必须远超衰减触限所需, 实测 doc='
        + byId['doc-honest-numbers'].totalDone + ' test-coverage='
        + byId['test-coverage-gap'].totalDone);
      assertTrue(byId['doc-honest-numbers'].consequence_value !== byId['test-coverage-gap'].consequence_value,
        '累计次数都很大、但近期次数不同的两个切片, 衰减后必须得到不同的 consequence_value'
        + '(否则权重已饱和、对复合分不再有任何区分度), 实测 doc='
        + byId['doc-honest-numbers'].consequence_value + ' test-coverage='
        + byId['test-coverage-gap'].consequence_value);
      assertTrue(byId['doc-honest-numbers'].consequence_value < byId['test-coverage-gap'].consequence_value,
        '近期被选得更多的切片, 衰减后必须更低, 实测 doc='
        + byId['doc-honest-numbers'].consequence_value + ' test-coverage='
        + byId['test-coverage-gap'].consequence_value);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ─── ④ 饱和回归测试: 改回旧实现, 权重必须重新饱和 ─────────
  test('改回旧的"累计次数"权重, 两个切片必须被压成同一个值(证明③不是恒真)', () => {
    // 旧实现按**累计** doneCount 线性衰减, 下限 0.05。doc 与 test-coverage 的
    // 累计次数都远超 6, 于是一起被压到 0.05 —— consequence_value 对所有候选
    // 变成同一个常数, 区分度归零, 排名退化成静态 feas/risk/conf 表。
    // 这就是它连选 8 个周期的机制, 也是用例③要锁住的那件事。
    const tmp = mkRepo(SATURATING());
    const p = path.join(tmp, 'scripts', 'autonomous-upgrade.js');
    const orig = fs.readFileSync(p, 'utf8');
    const oldImpl = [
      'for (const opt of C) {',
      '  const n = doneCount.get(opt.id) || 0;',
      '  if (n > 0 && typeof opt.consequence_value === \'number\') {',
      '    opt.consequence_value = Math.max(0.05, Math.round((opt.consequence_value - 0.08 * n) * 100) / 100);',
      '  }',
      '}',
    ].join('\n');
    const start = orig.indexOf('for (const opt of C) {');
    const endMarker = orig.indexOf('if (C.length === 0) {');
    if (start < 0 || endMarker < 0 || endMarker <= start) {
      throw new Error('在脚本里定位不到轮换权重块(锚点已变)');
    }
    fs.writeFileSync(p, orig.slice(0, start) + oldImpl + '\n\n' + orig.slice(endMarker));
    try {
      const out = execFileSync('node', [p, '--debug-candidates'],
        { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const i = out.indexOf('{');
      const d = JSON.parse(out.slice(i));
      const byId = {};
      for (const c of d.candidates) byId[c.id] = c;
      assertEqual(byId['doc-honest-numbers'].consequence_value, byId['test-coverage-gap'].consequence_value,
        '旧权重(累计+0.05 下限)必须把两个累计次数都很大的切片压成同一个值 —— 这正是饱和; '
        + '若这里不成立, 说明锚点已变或旧实现不复现, 用例③的红色就不再证明什么, 实测 doc='
        + byId['doc-honest-numbers'].consequence_value + ' test-coverage='
        + byId['test-coverage-gap'].consequence_value);
      assertTrue(byId['doc-honest-numbers'].consequence_value === 0.05,
        '旧权重下两者都应落在下限 0.05, 实测 doc=' + byId['doc-honest-numbers'].consequence_value);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ─── ⑤ 源码级: 必须存在"近期窗口"语义 ────────────────────
  test('源码级: 轮换权重必须基于近期窗口而非累计次数', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/RECENT_WINDOW/.test(src), '必须存在近期窗口常量');
    assertTrue(/doneSeq/.test(src), '必须记录每轮的 chosen 顺序(近期计数需要它)');
    assertTrue(/recentCount/.test(src), '必须按近期窗口计数');
    // 旧实现的指纹: 直接在权重里用 doneCount
    assertTrue(!/const n = doneCount\.get\(opt\.id\)/.test(src),
      '不得再用累计 doneCount 作为轮换权重(那会饱和到同一个下限、失去区分度)');
  });
};
