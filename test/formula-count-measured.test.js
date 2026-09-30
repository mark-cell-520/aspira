/**
 * test/formula-count-measured.test.js — 公式库条数必须受审
 *
 * ═══ 由来(第十二轮) ═══
 * 前五轮依次问了审计的键(7)、形态(8)、闸门(9)、文件集(10)、
 * 被测-vs-被锁(11)。本轮把周期 8 的机械枚举**重跑一遍**——
 * 因为文件集已缩 4 倍(798 → 218 份)、又新增 6 个键，
 * 上一次的枚举结论未必还成立。
 *
 * 结果: 623 条"可审形态"未产出声称，逐条过完，规模级里唯一真正的漏网
 * 就是公式库。三处文档三个数字，而 `formulas` 在审计里出现 **0 次**:
 *   INSTALL.md        公式库(2397个)                  → 夸大约 4 倍
 *   CURRENT_STATE.md  公式库 | 1286 formulas           → 夸大约 2 倍
 *   formulas/README   未拆分前的完整382条公式文件      → "拆分前"的旧值
 *
 * 实测: `src/formula/formula-module.js:13` 的 formulasFile 默认值是
 * `formulas/formulas.json`(不是 core/archive 那两个分文件)，共 **608 条**。
 *
 * ═══ 为什么 382 是错的而不只是"旧" ═══
 * formulas-core.json(284) + formulas-archive.json(98) = 382，README 说
 * formulas.json 是"未拆分前的完整382条"。但 formulas.json 现在是 **608**，
 * 拆分之后它又长回去了: cognitive_science 119→149、psychology 61→101、
 * philosophy 34→65、physics 12→95、mathematics 84→126。
 * 一个描述"拆分前"的数字，在拆分后仍然被当作现状引用——**旧读数比错数字
 * 更难发现，因为它曾经是对的**。
 *
 * ═══ 一个连带教训: 用"全局 0 不符"当回归锁会被新增键误伤 ═══
 * 新模式上线后，`test/audit-gate-scope.test.js` 的两条回归锁
 * (`作用域计数不得被当成引擎总量` / `行内代码跨度内的数字…`)
 * 立刻变红。它们原本断言 `assertEqual(mismatchCount(out), 0)`，
 * 注释里自陈"「当前文档 0 不符」就是 notScoped 的回归锁"。
 * 但真因是三处公式数字确实写错，与 notScoped / inCodeSpan 毫无关系——
 * **失败信息指向一个与真因无关的断言**，本仓库反复记载的形状。
 * 那两条已改为靶向断言(只查自己负责拦住的短语有没有进不符清单)。
 * 本文件的活体注入同理: 只断言 formulas 相关行变红，不断言全局计数。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const INSTALL = path.join(ROOT, 'INSTALL.md');
const CURRENT_STATE = path.join(ROOT, 'CURRENT_STATE.md');
const FORMULAS_README = path.join(ROOT, 'formulas', 'README.md');
const FORMULAS_JSON = path.join(ROOT, 'formulas', 'formulas.json');
const { withDocLock, restoreVersionLine, PROBE_VERSION } = require('./_doc-probe-lock.js');
const { execFileSync } = require('child_process');

function runAudit() {
  try {
    return execFileSync('node', [SCRIPT], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ASPIRA_AUDIT_SKIP_TESTS: '1' },
    });
      // [第二十二轮] 审计退出码现在承载结论(mismatch/漂移 -> 1)，execFileSync 对
      // 非零退出抛异常。活体注入要的正是那份 stdout，所以从 e.stdout 取回 ——
      // 否则一个**正确报出不符**的审计会把探针自己炸掉(周期22 实测 13 例全红)。
  } catch (e) {
    return (e.stdout || '').toString();
  }
}
function mismatchedLines(out) {
  const seg = out.split('❌ 与实测不符')[1] || '';
  return seg.split('\n').filter(l => l.includes('声称'));
}
function actualFormulaCount() {
  const j = JSON.parse(fs.readFileSync(FORMULAS_JSON, 'utf8'));
  return Array.isArray(j) ? j.length : ((j.formulas || j.items || []).length);
}

module.exports = function ({ test, assertTrue, assertEqual }) {

  test('公式库条数必须被实测并接线', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/m\.formulas\s*=/.test(src), 'measure() 必须实测公式库条数');
    assertTrue(/actual\.formulas\s*=\s*m\.formulas/.test(src),
      'actual.formulas 必须接线——否则模式对 undefined 比较');
    assertTrue(/key: 'formulas'/.test(src), '必须有 formulas 模式');
    // 测量口径: 必须指向 FormulaModule 默认加载的那个文件
    assertTrue(/formulas['"]?,\s*['"]formulas\.json['"]/.test(src)
      || /'formulas',\s*'formulas\.json'/.test(src),
      '必须实测 formulas/formulas.json——那是 src/formula/formula-module.js:13 '
      + '的 formulasFile 默认值，不是 core/archive 分文件');
  });

  test('公式模式必须只锁总量，不得误匹配分文件计数', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    // 三条模式各自锚定自己的标签
    assertTrue(/公式库\[[(（]/.test(src), '必须有 INSTALL 表格形态');
    assertTrue(/公式库\s*\|\s*\d/.test(src), '必须有 CURRENT_STATE 行形态');
    assertTrue(/完整\\s\*\(\\d\[\\d,\]\*\)\\s\*条公式文件/.test(src),
      '必须有 README "完整N条公式文件" 形态');
    // ⚠️ 不得出现会命中 core/archive 分文件计数的宽模式
    assertTrue(!/re:\s*\/\(\\d\[\\d,\]\*\)\\s\*条\//.test(src.split("key: 'formulas'")[0]),
      '不得有裸 "N 条" 模式——它会命中 formulas-core/archive 的分文件与分域计数');
    // 实测分文件计数必须仍被认作**不同量**而非总量
    const core = JSON.parse(fs.readFileSync(path.join(ROOT, 'formulas', 'formulas-core.json'), 'utf8'));
    const arch = JSON.parse(fs.readFileSync(path.join(ROOT, 'formulas', 'formulas-archive.json'), 'utf8'));
    const cN = Array.isArray(core) ? core.length : core.formulas.length;
    const aN = Array.isArray(arch) ? arch.length : arch.formulas.length;
    assertTrue(cN !== actualFormulaCount() && aN !== actualFormulaCount(),
      '分文件计数(' + cN + '/' + aN + ')与总量(' + actualFormulaCount()
      + ')必须是不同的量——否则把它们当同一个量核对就是制造假警报');
  });

  test('活体注入: INSTALL 的公式库数字写错必须变红', () => withDocLock(() => {
    const backup = fs.readFileSync(INSTALL, 'utf8');
    const n = actualFormulaCount();
    try {
      fs.writeFileSync(INSTALL, backup.replace('公式库(' + n + '个)', '公式库(9999个)'));
      const bad = mismatchedLines(runAudit());
      assertTrue(bad.some(l => /公式库总量 \(INSTALL 表\) = 9999/.test(l)),
        'INSTALL 的公式库数字写错必须被报为不符——它此前夸大了约 4 倍(2397 vs 608)而无人察觉');
    } finally {
      fs.writeFileSync(INSTALL, backup);
      if (!new RegExp('公式库\\(' + n + '个\\)').test(fs.readFileSync(INSTALL, 'utf8'))) {
        throw new Error('恢复失败: INSTALL.md 的公式库数字异常，请 git checkout -- INSTALL.md');
      }
    }
  }));

  test('活体注入: CURRENT_STATE 的公式库数字写错必须变红', () => withDocLock(() => {
    const backup = fs.readFileSync(CURRENT_STATE, 'utf8');
    const n = actualFormulaCount();
    try {
      fs.writeFileSync(CURRENT_STATE, backup.replace('> 公式库 | ' + n + ' formulas', '> 公式库 | 1234 formulas'));
      const bad = mismatchedLines(runAudit());
      assertTrue(bad.some(l => /公式库总量 \(CURRENT_STATE 行\) = 1234/.test(l)),
        'CURRENT_STATE 的公式库数字写错必须被报为不符——它此前夸大了约 2 倍(1286 vs 608)');
    } finally {
      // [第二十三轮] 同上: CURRENT_STATE 的版本行也按权威值还原。
      fs.writeFileSync(CURRENT_STATE, backup.replace(/(>\s*版本\s*\|\s*)v?\d+\.\d+\.\d+/, '$1v' + PROBE_VERSION));
      if (!new RegExp('> 公式库 \\| ' + n + ' formulas').test(fs.readFileSync(CURRENT_STATE, 'utf8'))) {
        throw new Error('恢复失败: CURRENT_STATE.md 的公式库行异常，请 git checkout -- CURRENT_STATE.md');
      }
    }
  }));

  test('活体注入: formulas/README 的总量说明写错必须变红', () => withDocLock(() => {
    const backup = fs.readFileSync(FORMULAS_README, 'utf8');
    const n = actualFormulaCount();
    try {
      fs.writeFileSync(FORMULAS_README, backup.replace('完整' + n + '条公式文件', '完整400条公式文件'));
      const bad = mismatchedLines(runAudit());
      assertTrue(bad.some(l => /公式库总量 \(README 原文件说明\) = 400/.test(l)),
        'README 的总量说明写错必须被报为不符——它此前的 382 是"拆分前"的旧值');
    } finally {
      fs.writeFileSync(FORMULAS_README, backup);
      if (!new RegExp('完整' + n + '条公式文件').test(fs.readFileSync(FORMULAS_README, 'utf8'))) {
        throw new Error('恢复失败: formulas/README.md 的总量说明异常，请 git checkout -- formulas/README.md');
      }
    }
  }));

  test('三处文档当前必须与实测一致', () => withDocLock(() => {
    const n = actualFormulaCount();
    const bad = mismatchedLines(runAudit());
    assertTrue(!bad.some(l => /公式库总量/.test(l)),
      '三处公式库声称必须与实测(' + n + ')一致——任何一条落入不符清单都说明文档又漂移了');
    // 并且分文件计数不得被误报(那会是模式过宽的假警报)
    assertTrue(!bad.some(l => /= ' + '284|= 98/.test(l)),
      'formulas-core(284) / formulas-archive(98) 的分文件计数不得被当成总量误报');
  }));
};
