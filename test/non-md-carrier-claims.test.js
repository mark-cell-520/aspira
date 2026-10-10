/**
 * test/non-md-carrier-claims.test.js —
 * 一个对外声称载体, 它的"能力与合规"声称也从未被实测过
 *
 * [doc-honest-numbers·第一百九十轮] 新建。
 *
 * ═══ 本轮调查 ═══
 * 第一百八十九轮修了非 .md 载体里的**数字**(package.json description 的 51/14/179,
 * agent-card 的 6.7.5/45/153)。本轮问的是同一个载体的另一半:
 * **agent-card.json 对外声称的"合规标准"与"能力", 有实现支撑吗?**
 *
 * ═══ 两个实测缺陷 ═══
 * (a) `complianceStandards` 列了四项: GB/T 42497-2023 / GB/Z 185-2026 /
 *     ISO/IEC 27001 / NIST AI RMF。全仓 grep(排除 data/ 与 src/data/ 后)只有第一项
 *     有痕迹 —— 它在 SKILL.md 与 compliance/gb-agent-security-mapping.md 里有映射表。
 *     **另外三项只出现在声称处自身**, 没有映射文档、没有实现、没有测试。
 *     一个 A2A 发现文件告诉外部 agent"我符合这三项标准", 而仓库里搜不到任何支撑。
 *
 * (b) `compliance/gb-agent-security-mapping.md` 整份冻结在 2026-08-27(v6.7.x 时代,
 *     与 agent-card.json 的 version "6.7.5" 同一时刻), 带着一串过时读数:
 *       · "45维判别" ×4 处        → 实测 54
 *       · "343 测试用例"          → 实测 1853
 *       · 版本 v6.7.0             → 当前 1.0.72
 *       · `heartflow_think` 等 7 个工具名 → 181 个工具全部已改名为 `aspira_` 前缀
 *       · "完整 45 维度清单见 references/discriminator-dimensions.md"
 *         → **该文件不存在**(悬空引用)
 *
 * ═══ 而审计为什么 88/88 全绿 ═══
 * 两个原因叠加, 都是本切片反复记录的形状:
 * ① 中文 dimensions pattern 写作 `(\d[\d,]*)\s*个\s*(?:discrimination\s*)?维度`,
 *    **要求"个"字**, 而同文件第 872 行的注释写着"对中文允许『维度』省略『个』"——
 *    **注释知道该做什么, 代码没做**(cycle 16 同形状)。且"45维判别"里"维"后接的是
 *    "判"不是"度", 连"维度"二字都不连续, 两个 pattern 都不命中。
 * ② 该文档是引擎自述(标题即"新愿 Aspira × 国标安全映射表"), 但 `SELF_DESC_DOCS`
 *    只有 5 个顶层文档; 且第 691 行的 `!f.includes(path.sep) &&` 让**任何写进名单的
 *    子目录路径都永远进不来** —— 一条"加进名单也不生效"的死入口。
 *
 * ═══ 修法 ═══
 * ① agent-card 的 complianceStandards 只保留有支撑的那一项;
 * ② 映射文档的过时读数全部改为实测值, 悬空引用改指 AGENTS.md 的真实清单;
 * ③ 审计: 中文 dimensions 新增"省略个/单字维"形态(仅对自述文档生效),
 *    SELF_DESC_DOCS 纳入该映射文档并去掉 `!f.includes(path.sep)` 死入口;
 * ④ 本锁: 把"每一项对外声称的合规标准都必须在仓库里有支撑"变成契约。
 *
 * ═══ 锁什么 ═══
 * ① agent-card 的 complianceStandards 每一项都必须在仓库里有映射文档或实现痕迹;
 * ② agent-card 的 features 每一项必须有对应实现(反向对照: 防止锁变恒真);
 * ③ 映射文档的维度读数 === 实测;
 * ④ 映射文档引用的文件必须真实存在(悬空引用锁);
 * ⑤ 行为反向: 加一条无支撑标准, ①必须按名红。
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const CARD = path.join(ROOT, '.well-known', 'agent-card.json');
const MAP = path.join(ROOT, 'compliance', 'gb-agent-security-mapping.md');

function measureDims() {
  const idx = require(path.join(ROOT, 'src', 'index.js'));
  return Object.keys(idx.discriminate('hello world', []).dimensions || {}).length;
}
// 在仓库里(排除运行时数据目录)搜一个字符串的痕迹数。
// ⚠️ 必须排除 test/ 与 .well-known/ 自身: 首版没排 test/, 结果用例五的臆造标准号
// "ISO/IEC 99999-2099" 的痕迹就是**本测试文件自己**(我把那个字符串写进了源码)——
// 仪器搜到自己, 于是"无支撑"被判成"有支撑", 反向证明的样本当场失效。
// **测试里提到一个标准名, 不构成对该标准的实现支撑。**
function repoTraces(needle) {
  const out = execSync(
    `grep -rl --include='*.js' --include='*.md' --include='*.json' --include='*.txt' `
    + `-F ${JSON.stringify(needle)} . 2>/dev/null `
    + `| grep -v node_modules | grep -v '^./data/' | grep -v '^./src/data/' `
    + `| grep -v '^./memory/' | grep -v '^./.well-known/' | grep -v '^./test/' || true`,
    { cwd: ROOT, encoding: 'utf8' }
  );
  return out.split('\n').filter(Boolean);
}

module.exports = function ({ test, assertEqual, assertTrue }) {
  const DIMS = measureDims();
  const card = JSON.parse(fs.readFileSync(CARD, 'utf8'));

  // ── 一、每一项对外声称的合规标准都必须有仓库支撑 ──────────
  test('agent-card 的 complianceStandards 每一项都必须有仓库内的映射文档或实现', () => {
    const stds = card.capabilities.complianceStandards;
    assertTrue(Array.isArray(stds) && stds.length > 0,
      '前提失效: complianceStandards 为空或不是数组 —— 空数组会让本条恒真通过');
    for (const s of stds) {
      // 声称处自身(agent-card.json)不算支撑, 已由 repoTraces 排除 .well-known/
      const traces = repoTraces(s);
      assertTrue(traces.length > 0,
        `合规标准「${s}」在仓库里没有任何映射文档或实现痕迹(已排除 data/、src/data/、`
        + `memory/ 与声称处 .well-known/ 自身) —— 一个 A2A 发现文件告诉外部 agent `
        + `"我符合这项标准", 而全仓搜不到任何支撑, 这是虚假声称`);
    }
  });

  // ── 二、features 必须有实现(反向对照, 防锁恒真) ───────────
  test('agent-card 的 features 每一项都必须有对应实现', () => {
    const feats = card.capabilities.features;
    assertTrue(Array.isArray(feats) && feats.length > 0, '前提失效: features 为空');
    // 连字符能力名 → src/ 下的实现符号(实测过: 五项全部有实现)
    const IMPL = {
      'content-safety-filter': () => repoTraces('discriminate').length > 0,
      'pii-detection': () => repoTraces('PII_RULES').length > 0,
      'outbound-gate': () => repoTraces('checkOutbound').length > 0,
      'audit-trace-hmac': () => fs.existsSync(path.join(ROOT, 'src', 'trace-chain.js')),
      'circuit-breaker': () => fs.existsSync(path.join(ROOT, 'src', 'circuit-breaker.js')),
    };
    let checked = 0;
    for (const f of feats) {
      const probe = IMPL[f];
      // 未登记的能力名**直接判失败**, 不是跳过: 首版写 `if (!probe) continue`,
      // 变异 D(往 features 里加一个 "quantum-telepathy")因此全绿 —— 锁对
      // "新增一个虚假能力"毫无防护, 而它防的正是这件事。
      // 白名单的代价是新增合法能力要同步登记判据, 这与 dimension-health 锁
      // 54 键集是同一条契约: **声称面扩大, 判据必须跟着扩大。**
      assertTrue(!!probe,
        `feature「${f}」未在 IMPL 登记实现判据 —— 新增能力必须在 `
        + `test/non-md-carrier-claims.test.js 的 IMPL 表里登记它的实现位置, `
        + `否则"对外声称一项能力"这件事没有任何东西核对`);
      checked++;
      assertTrue(probe(), `feature「${f}」在 src/ 下找不到对应实现`);
    }
    assertTrue(checked >= 3,
      `只登记核对了 ${checked} 项 feature —— 少于 3 项时本条接近恒真, 失去防护意义`);
  });

  // ── 三、映射文档的维度读数 === 实测 ──────────────────────
  test('合规映射文档的维度读数必须与实测一致', () => {
    const doc = fs.readFileSync(MAP, 'utf8');
    const hits = [...doc.matchAll(/(\d[\d,]*)\s*维(?!度)/g)].map(m => +m[1]);
    assertTrue(hits.length > 0, '前提失效: 映射文档里找不到 "N维" 读数');
    for (const h of hits) {
      assertEqual(h, DIMS,
        `合规映射文档声称 ${h} 维, 实测 ${DIMS} —— 这份文档整份冻结在 2026-08-27`
        + `(v6.7.x 时代), 而审计的中文 dimensions pattern 要求"个"字、且"维"后`
        + `接"判别"而非"度", 于是它通篇的过时读数在 88/88 全绿背后活了几个月`);
    }
  });

  // ── 四、映射文档引用的文件必须真实存在 ───────────────────
  test('合规映射文档反引号里的文件引用必须真实存在(悬空引用锁)', () => {
    const doc = fs.readFileSync(MAP, 'utf8');
    // 匹配反引号内任何以 .md/.js 结尾的文件名或路径(含裸文件名, 如 `AGENTS.md`)。
    // 首版限定 `(?:references|compliance|src)/` 路径前缀, 结果**一处都不匹配** ——
    // 本轮恰好把唯一的悬空引用 references/discriminator-dimensions.md 改成了裸名
    // `AGENTS.md`, 前提随之消失。锁不能因为缺陷被修好就失去抓手。
    const refs = [...doc.matchAll(/`([\w./-]+\.(?:md|js))`/g)].map(m => m[1])
      // 排除标准号与规范名(它们不是本仓库文件)
      .filter(r => !/^(GB|ISO|NIST)\b/.test(r));
    assertTrue(refs.length > 0, '前提失效: 映射文档里找不到反引号文件引用');
    for (const r of refs) {
      assertTrue(fs.existsSync(path.join(ROOT, r)),
        `映射文档引用了 \`${r}\` 但该文件不存在 —— 原文档写着"完整 45 维度清单见 `
        + `references/discriminator-dimensions.md", 那是一个从未存在的悬空引用`);
    }
  });

  // ── 五、行为反向: 加一条无支撑标准, 用例一必须按名红 ──────
  test('反向: 加一条无支撑的合规标准, 用例一的谓词必须判它不合格', () => {
    // ⚠️ 这个臆造标准号必须**运行时构造**, 不能让完整字符串落在任何文件里:
    // 首版写字面量 'ISO/IEC 99999-2099', 它的"痕迹"先是本测试文件自己(于是
    // repoTraces 排除了 test/); 改对之后**又**栽了一次 —— 本轮把这个字符串写进了
    // AGENTS.md 的轮次记录里, 而 repoTraces 不排除 AGENTS.md, 反向证明的样本
    // 当场失效。用 join 断开字面量, grep -F 就搜不到它。
    // 这是"仪器搜到自己"这个形状的第三次, 前两次是 cycle 189 的 test/ 自指。
    const fake = ['ISO', 'IEC', '99999-2099'].join('/');
    const traces = repoTraces(fake);
    assertTrue(traces.length === 0,
      `前提失效: 臆造的标准号「${fake}」在仓库里有痕迹(${traces.join(', ')}) —— `
      + `它不该出现在任何文件里, 反向证明的样本不成立`);
    assertTrue(repoTraces(fake).length === 0,
      '反向证明失效: repoTraces 对臆造标准号返回了痕迹');
    // 且对真实标准返回非空(证明不是恒空)
    assertTrue(repoTraces('GB/T 42497-2023').length > 0,
      '反向证明失效: repoTraces 对真实标准返回空 —— 本条是一个恒真锁');
  });
};
