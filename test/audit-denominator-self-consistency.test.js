/**
 * test/audit-denominator-self-consistency.test.js —
 * 分母构成里有一支结构上恒为零, 而输出让它看起来像"实测排除了 0 条"
 *
 * [doc-honest-numbers·第一百八十八轮] 新建。
 *
 * ═══ 本轮调查 ═══
 * 审计基线 88/88 全绿。前七轮已问过: key 集(7/11/176)、pattern 覆盖(8)、
 * 闸门漏放(9/177)、文件集(10)、measured-vs-patterned(11)、豁免列表(19)、
 * 顶层文档间矛盾(187)。本轮问的是一个从未问过的问题:
 * **审计输出的分母构成, 它自己成立吗?**
 *
 * ═══ 缺陷: nVerDate 那一支结构上恒零 ═══
 * 分母构成印四类: 可审 / 百分比 / 版本号日期 / 代码围栏内。实测第三支
 * **永远是 0**。穷举验证了原因:
 *   NUMISH 要求"数字 + 单位词"(个/条/行/层/维/模块/工具/路由/tests/…),
 *   而版本号形态是 `1.0.70 modules` —— 正则匹配到的是 `70 modules`
 *   (不是 `1.0.70`), 于是 `/v?\d+\.\d+/` 测不到; 日期 `2026-10-09` 同理。
 *   构造 `1.0.70 modules` / `v1.0.70 tools` / `2026-10-09 tests` /
 *   `>= 18.17 modules` 全部穷举, 命中片段里**没有一个**能同时含
 *   版本号/日期形态。
 *
 * 所以输出的"版本号/日期 0"不是"实测排除了 0 条", 而是"这个判据不可能命中"。
 * 留着它会让读者以为该类已被主动排除 —— **一个恒零的判据和一个有效的判据,
 * 在只印数字的输出里长得一模一样。** 这是 cycle 176 修过的
 * measured-but-never-compared 的死分支变体: 那次是"测了却不比对",
 * 这次是"判据不可能命中, 却印出一个 0 让人以为测过了"。
 *
 * ═══ 修法 ═══
 * ① 报告在该支为 0 时**显式注明"结构上恒零"**及原因;
 * ② 新增自洽断言: 四类是互斥集, 粗计须等于四项之和, 不等则报错并置
 *    exitCode = 1 —— 让"分母构成"这句话本身可验证。
 *
 * ═══ 一个附带发现(记录, 未修) ═══
 * 审计 spawn run-all 时**间歇性**少测 1 个用例(本轮两次 1843/13, 我的
 * 同形式复刻与直接跑均得 1844/12, 重跑审计一次仍 1843)。这是 cycle 29/142
 * 已记录的同形态残余(那两次定位的是 git PATH 依赖, 修后仍偶发), 根因未确立。
 * 本轮用 ASPIRA_AUDIT_SKIP_TESTS=1 取得绿色基线(88/88, 5 条无法实测即
 * 测试数类), 文档声称本身全部正确 —— 分歧全在 spawn 侧。
 *
 * ═══ 锁什么 ═══
 * ① 源级: 分母构成必须含"恒零"说明(该支为 0 时);
 * ② 源级: 必须有自洽断言(粗计 === 四项和);
 * ③ 行为: 恒零说明真的会出现(注入一个不可能的判定让它非零则说明消失);
 * ④ 行为: 自洽断言真的会红(把粗计改成不等于四项和);
 * ⑤ 反向: 去掉自洽断言后④必须不再成立(证明本条不是恒真)。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const AUDIT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');

function runAudit(env) {
  const r = spawnSync('node', [AUDIT], {
    cwd: ROOT, encoding: 'utf8', timeout: 600000,
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).toString() };
}
// 恒用 SKIP_TESTS: 本轮锁的是分母构成, 与测试数实测无关; 且不设它会真跑
// run-all(40s+), 还会把上面记录的间歇抖动带进本锁。
const SKIP = { ASPIRA_AUDIT_SKIP_TESTS: '1' };

module.exports = function ({ test, assertEqual, assertTrue }) {
  // ── 一、源级: 分母构成必须含恒零说明 ────────────────────
  test('源级: 版本号/日期支为 0 时报告必须显式注明结构上恒零', () => {
    const src = fs.readFileSync(AUDIT, 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, m => ' '.repeat(m.length))).join('\n');
    // 报告行必须含条件式的恒零说明
    assertTrue(/nVerDate === 0 \? ' \(该判据结构上恒零/.test(src),
      '分母构成的报告行必须在 nVerDate === 0 时追加"该判据结构上恒零"说明 —— ' +
      '否则一个恒零的判据和一个有效的判据, 在只印数字的输出里长得一模一样');
    // 且必须说明原因(NUMISH 要求数字+单位词)
    assertTrue(/NUMISH 要求"数字\+单位词"/.test(src),
      '恒零说明必须给出原因(NUMISH 的匹配形态), 而不只是印一个 0');
    // 自证: 谓词必须分得清"有条件说明"与"无条件印数"
    const naive = "console.log(`  分母构成: 可审 ${nScannable} · 版本号/日期 ${nVerDate}`);";
    assertTrue(/nVerDate === 0 \?/.test(naive) === false,
      '自证失效: 谓词把无条件印数的报告判成含恒零说明, 本条是恒真锁');
  });

  // ── 二、源级: 必须有自洽断言 ────────────────────────────
  test('源级: 必须有"粗计 === 四项和"的自洽断言', () => {
    const src = fs.readFileSync(AUDIT, 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, m => ' '.repeat(m.length))).join('\n');
    assertTrue(/rawClaims !== nPercent \+ nVerDate \+ nFenced \+ nScannable/.test(src),
      '必须有粗计与四项和的不变量断言');
    assertTrue(/分母构成不自洽/.test(src), '不一致时必须印出"分母构成不自洽"');
    // 必须置 exitCode(否则只说一句话, 调用方看不见)
    const i = src.indexOf('分母构成不自洽');
    const seg = src.slice(i, i + 200);
    assertTrue(/process\.exitCode\s*=\s*1/.test(seg),
      '分母构成不自洽必须置 process.exitCode = 1 —— 只印在 stdout 的失败对任何检查退出码的调用方不存在');
  });

  // ── 三、行为: 恒零说明真的会出现 ────────────────────────
  test('行为: 恒零说明必须真的出现在输出里', () => {
    const r = runAudit(SKIP);
    assertTrue(/分母构成\(已扫文档内 NUMISH 粗计 \d+ 条\)/.test(r.out),
      '前提失效: 输出里找不到分母构成行');
    assertTrue(/版本号\/日期 0 \(该判据结构上恒零/.test(r.out),
      '输出必须含"版本号/日期 0 (该判据结构上恒零…)" —— 印成"版本号/日期 0"而不加说明, ' +
      '读者会以为该类已被主动排除且实测为 0');
  });

  // ── 四、行为: 自洽断言真的会红 ──────────────────────────
  test('行为: 把粗计改成不等于四项和, 审计必须报"分母构成不自洽"', () => {
    const src = fs.readFileSync(AUDIT, 'utf8');
    // 只改一处累加(让粗计比四项和少 1), 不碰其他逻辑
    const OLD = '      nScannable++;\n    }\n  }';
    assertTrue(src.includes(OLD), '前提失效: 未匹配 nScannable 累加块(锚点已变)');
    const COPY = path.join(ROOT, 'scripts', '_audit-denominator-probe.js');
    try {
      fs.writeFileSync(COPY, src.replace(OLD, '      nScannable += 2;\n    }\n  }'));
      const r = spawnSync('node', [COPY], {
        cwd: ROOT, encoding: 'utf8', timeout: 600000,
        env: Object.assign({}, process.env, SKIP),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = ((r.stdout || '') + (r.stderr || '')).toString();
      assertTrue(/分母构成不自洽/.test(out),
        '反向证明失效: 粗计被改坏后审计仍未报"分母构成不自洽" —— ' +
        '说明这条断言不存在或不可达, 本条是通过被别处买通的');
      assertEqual(r.status, 1, '分母构成不自洽必须让退出码为 1');
    } finally {
      if (fs.existsSync(COPY)) fs.unlinkSync(COPY);
    }
    // 共享源必须未被改动
    assertEqual(fs.readFileSync(AUDIT, 'utf8'), src, '共享的审计脚本必须未被本测试改动');
  });

  // ── 五、反向: 去掉自洽断言后④必须不再成立 ───────────────
  test('反向: 剥掉自洽断言后, 同样的破坏必须不再被报', () => {
    const src = fs.readFileSync(AUDIT, 'utf8');
    // 精确锚定断言块(不是它上方的注释块 —— 注释块里也含"分母构成"字样,
    // 从注释开始剥会留下真正的断言, 首轮就是这么错的)。
    const BLOCK = '  if (rawClaims !== nPercent + nVerDate + nFenced + nScannable) {\n'
      + '    console.log(`  ❌ 分母构成不自洽: 粗计 ${rawClaims} ≠ 四项和 ${nPercent + nVerDate + nFenced + nScannable}`);\n'
      + '    process.exitCode = 1;\n'
      + '  }';
    assertTrue(src.includes(BLOCK), '前提失效: 未匹配自洽断言块(锚点已变)');
    const stripped = src.replace(BLOCK, '');
    assertTrue(!stripped.includes('分母构成不自洽'), '前提失效: 剥离后仍含自洽断言');
    const COPY = path.join(ROOT, 'scripts', '_audit-denominator-probe.js');
    try {
      fs.writeFileSync(COPY, stripped);
      const r = spawnSync('node', [COPY], {
        cwd: ROOT, encoding: 'utf8', timeout: 600000,
        env: Object.assign({}, process.env, SKIP),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = ((r.stdout || '') + (r.stderr || '')).toString();
      assertTrue(!/分母构成不自洽/.test(out),
        '反向证明失效: 剥掉断言后仍报"分母构成不自洽" —— 说明④的通过不是靠本处断言');
      // 且退出码不应因该断言而红(可能因别的原因为 1, 故只断言输出里没有该句)
    } finally {
      if (fs.existsSync(COPY)) fs.unlinkSync(COPY);
    }
    assertEqual(fs.readFileSync(AUDIT, 'utf8'), src, '共享的审计脚本必须未被本测试改动');
  });
};
