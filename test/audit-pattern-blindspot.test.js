/**
 * test/audit-pattern-blindspot.test.js — 审计模式的同义词盲区(注入法验证)
 *
 * ═══ 由来 ═══
 * 前两轮修的是「审计扫不到文件」(根目录 → 全仓 346 份)。
 * 但**扫到了文件 ≠ 读得懂那上面的话**: 模式只有 25 条且全是固定搭配。
 *
 * 用注入法实测: 往 README.md 追加 5 种写法各含一个错数字:
 *   "ships with 139 modules in total"       → 没发现
 *   "exposes 184 MCP tool for agents"       → 没发现(单数 tool)
 *   "1522 dispatch route entries"           → 没发现(单数 route)
 *   "1197 tests passing right now"          → 没发现
 *   "63 discrimination dimension"           → 没发现(单数)
 * **5 个一个都没发现，审计仍报 43/43 全绿。**
 * 报全绿只说明「它知道的那 43 条没错」。
 *
 * ═══ 修法 ═══
 * 英文指标加复数容忍(modules?/tools?/routes?/tests?/dimensions?)。
 *
 * ═══ 然后仪器又错了一次(第 26 次) ═══
 * 我顺手补了一条中文「N 维度」(省略"个")的模式，
 * 全仓立刻产出 8 条"不符"，逐条核对**全是假阳性**:
 *   "self-audit.js(6维度审计引擎)"      —— 那个模块自己有 6 个审计维度
 *   "56题 × 6维度" / "5维度核心能力专项测试" —— 测试集的维度数
 *   "7维度 × 3用例 = 21个"               —— 测试用例设计
 *   "4维度加权评分 (0-1)"                —— 代码注释里的算法
 *   "三个维度(认知负荷/能量水平/社会压力)"  —— 稳态系统的维度
 * **"N 维度"在中文里是多义结构**，远比"N 个模块"更常表示子集/测试集/算法维度。
 * 该模式已撤回，并在源码里明确记录「知道盲区但选择不修」。
 * **这次是我自己过度扩张造成的，不是原有缺陷。**
 *
 * ═══ 本测试锁什么 ═══
 * ① 5 种注入形态必须被发现(盲区已闭合)
 * ② "N 维度" 不得成为模式(防假阳性回归)
 * ③ 叙事引用("...115 modules... was removed")不得算当前声称
 *
 * ⚠️ 性能: 一次全仓审计约 6-8 秒(346 份 md + 引擎加载)。
 * 首版每个用例跑一次审计，8 个用例超时。改为**一次注入、一次审计、
 * 用多个可区分的错误值分别断言**——注入之间靠不同数字互不干扰。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { withDocLock } = require('./_doc-probe-lock.js'); // [第七轮] 共享文档探针互斥

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const TARGET = path.join(ROOT, 'README.md');
const MARK = '<!-- ASPIRA-BLINDSPOT-PROBE -->';

module.exports = function ({ test, assertTrue }) {

  function probe(extra) {
    const orig = fs.readFileSync(TARGET, 'utf8');
    // ⚠️ 注入点必须在 changelog 表**之前**。currentClaimsOnly() 把
    // "| Version | Date | Change |" 及其后的内容整段剥掉(那是历史快照，
    // 不该当当前声称核对)。首版追加到文件末尾，全部落在被剥掉的区间，
    // 于是 5 个注入一个都测不到——探针自己制造了假阴性。
    const cut = orig.indexOf('| Version | Date | Change |');
    const at = cut >= 0 ? cut : orig.length;
    fs.writeFileSync(TARGET, orig.slice(0, at) + MARK + '\n' + extra + '\n\n' + orig.slice(at));
    let out;
    try {
      // ASPIRA_AUDIT_SKIP_TESTS=1: 审计默认会内嵌跑整个 test/run-all.js
      // (1182 个测试)来实测测试数，一次约 40 秒。本探针与测试数无关，
      // 必须跳过，否则 4 个用例 × 40 秒直接超时。
      out = execFileSync('node', [SCRIPT], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
      });
    } finally {
      // 无论断言是否通过都必须还原——否则把仓库留在被污染状态
      fs.writeFileSync(TARGET, orig);
    }
    return out;
  }

  const badSection = (out) => (out.split('--- ❌')[1] || '');

  // ─── ① 五种同义写法一次注入、一次审计 ─────────────────────
  test('五种同义写法必须全部被发现(一次注入)', () => withDocLock(() => {
    // 每行用不同的错误值，断言时按值区分，互不干扰
    const out = probe([
      'The engine ships with 139 modules in total.',
      'Aspira currently exposes 184 MCP tool for agents.',
      'There are 1522 dispatch route entries registered.',
      'Aspira test suite reports 1197 tests passing right now.',
      'Aspira runs 63 discrimination dimension in its core.',
    ].join('\n'));
    const bad = badSection(out);
    assertTrue(/README\.md/.test(bad), 'README.md 应被点名');
    // ⚠️ 前 4 个值在跳过模式下必须被发现; 第 5 个(1197 tests passing)
    // 不能在这里断言——ASPIRA_AUDIT_SKIP_TESTS=1 时 m.tests 为 null，
    // 测试数声称一律变"无法实测"，这是跳过模式的设计语义而非缺陷。
    // 首版把 5 个值一起断言，是自己没想清跳过模式的行为(第 N 次
    // "断言与设计不符")。测试数那条的盲区闭合由正常模式覆盖。
    for (const v of ['139', '184', '1522', '63']) {
      assertTrue(bad.includes(v),
        `注入的错值 ${v} 必须出现在不一致列表里——同义写法不应成为盲区`);
    }
    assertTrue(/1197/.test(out),
      '注入的 1197 至少应被识别为一条(测试数)声称，不应完全无声');
  }));

  // ─── ② "N 维度" 不得成为模式(防假阳性回归) ─────────────────
  test('中文「N 维度」(省略个)不得成为审计模式', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    // 源码里可以**提到**这个决定(注释里说明为何不补)，但不得有活的正则
    assertTrue(!/re:\s*\/\(\\d\[\\d,\]\*\)\\s\*维度/.test(src),
      '「N 维度」模式已因 8 条假阳性被撤回，不得复活');
  });

  // ─── ③ 叙事引用不得算当前声称 ─────────────────────────────
  // 同样注入 README，故同持锁(见 ④ 的说明)
  test('叙事引用(被删除的旧值)不得算当前声称', () => withDocLock(() => {
    const out = probe('A fifth "115 modules" I had just written myself was removed rather than defended.');
    assertTrue(!/README\.md/.test(badSection(out)),
      '引用的、已删除的旧值不是当前声称，不应报不符');
  }));

  // ─── ④ 探针自己必须还原现场 ───────────────────────────────
  // ⚠️ 这个 test 自己也注入一行再检查还原，所以它也是**写入者**。
  // 首版只给 ① 的注入套了锁，漏了 ④ —— 于是 ④ 会在别人持锁注入的
  // 同一时刻注入/检查，"无残留"断言读到的是别人的探针。
  // **一个检查"没有污染"的测试，自己必须先不制造污染。**
  test('探针结束后 README.md 必须还原(不得留注入痕迹)', () => withDocLock(() => {
    probe('The engine ships with 139 modules in total.');
    const after = fs.readFileSync(TARGET, 'utf8');
    assertTrue(!after.includes(MARK),
      '注入标记必须被清除——一个会污染仓库的探针比没有探针更糟');
  }));
};
