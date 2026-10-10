/**
 * test/non-md-doc-claims.test.js —
 * 审计只扫 .md, 于是非 .md 载体里的当前数字声称从未被任何东西检查过
 *
 * [doc-honest-numbers·第一百八十九轮] 新建。
 *
 * ═══ 本轮角度 ═══
 * 前十一轮问过审计的 key 集(7)、pattern 覆盖(8)、闸门漏放(9)、文件集(10)、
 * measured-vs-patterned(11)、公式库三数字(12)、豁免列表(19)、
 * measured-but-never-compared(176)、顶层文档间矛盾(187)、分母自洽(188)。
 * 本轮问 cycle 10 的 inverse: **cycle 10 问"它扫哪些文件", 答案是只扫 .md;
 * 那么"只扫 .md"这个决定, 漏掉了哪些载体?**
 *
 * ═══ 两个实测缺陷, 都在 .md 之外 ═══
 * (a) package.json 的 description —— npm 页面第一眼展示的那段话:
 *       "51 discrimination dimensions, 14-layer output pipeline
 *        (12 input / 13 draft / 14 output), ... 179 MCP tools"
 *     实测: dimensions **54**、层集合 **17**(每次调用 11/12/13)、MCP tools **181**。
 *     三个数字全部过时, 而审计的 walkMd 只收 .md。
 * (b) .well-known/agent-card.json —— A2A(Agent-to-Agent)协议的标准发现路径,
 *     任何按该协议发现 Aspira 的 agent 都读它。它写着:
 *       version "6.7.5" / description "45维判别" /
 *       discriminationDimensions 45 / tools 153 / tools.count 153
 *     实测: version **1.0.71**(该文件冻结在 CHANGELOG.md 的 [6.7.5] - 2026-08-27,
 *     相差几十个版本)、dimensions **54**、tools **181**。五个数字全错。
 *
 * ═══ 为什么这是本切片的核心形状 ═══
 * cycle 10 发现 data/ 682 份 CORE_VALUES.md 把分母膨胀 4 倍 —— 那次是"分母里
 * 装了不是分母的东西"。本轮是同一决定的另一面: **文件集是一个 enumerating
 * filter, 而它按扩展名枚举。** 一个数字声称放在 .json 里, 就落在审计的视野之外,
 * 而全绿报告看不出这个差别 —— 88/88 全绿的同时, npm 描述和 A2A 发现文件在说
 * 51 维、45 维、179 工具、153 工具、版本 6.7.5。
 * 更尖的一点: agent-card.json 的 version 是**第六个版本副本**, 而 convention #1
 * 只列了五个(VERSION / package.json / src/core/version.js / SKILL.md / 运行时)。
 * 一个覆盖不到的副本, 就是 cycle 13 记的"writer with no verifier"的孪生形状。
 *
 * ═══ 修法 ═══
 * ① 两个文件的数字改为实测值;
 * ② sync-version.js 增加第四个同步目标(agent-card.json 的 version)——
 *    没有 writer 的 verifier 会每轮 bump 都红, 那是一个训练人忽略锁的红;
 * ③ 本锁: 全部用**实测值**而非硬编码, 与这两个文件的声称逐项比对。
 *
 * ═══ 锁什么 ═══
 * ① package.json description 四个数字 === 实测;
 * ② agent-card.json 五个字段 === 实测;
 * ③ 行为反向: 把任一数字改错, 本锁必须红(证明不是恒真);
 * ④ 载体清单自证: 谓词必须分得清"声称存在"与"声称缺失"。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const PKG = path.join(ROOT, 'package.json');
const CARD = path.join(ROOT, '.well-known', 'agent-card.json');
const VERSION_FILE = path.join(ROOT, 'VERSION');
const PIPELINE = path.join(ROOT, 'src', 'pipeline.js');
const MCP_REGISTRY = path.join(ROOT, 'src', 'mcp', 'tools-registry.js');

// ── 实测(不硬编码, 否则分不清"文档错"与"引擎变了") ──────────────
function measureDims() {
  const idx = require(path.join(ROOT, 'src', 'index.js'));
  const r = idx.discriminate('hello world', []);
  return Object.keys(r.dimensions || {}).length;
}
// 层数两个口径都必须实测: 静态提取得层集合, 跑一次 pipeline 得每次调用深度。
// 审计第 1190 行的注释已记录为什么不能只跑一次(只走命中分支会低估)。
function measureLayerSet() {
  const src = fs.readFileSync(PIPELINE, 'utf8');
  const pushes = [...src.matchAll(/checked_by\.push\(\{\s*layer:\s*'([a-z-]+)'/g)].map(x => x[1]);
  const order = [];
  for (const p of pushes) if (!order.includes(p)) order.push(p);
  return order;
}
function measureLayerDepth(mode) {
  const gate = require(path.join(ROOT, 'src', 'gate.js'));
  const r = gate.runPipeline({ input: 'hello world', mode });
  return (r.checked_by || []).length;
}
function measureTools() {
  // 必须与审计同源(scripts/audit-doc-numbers.js 第 238 行):
  //   require('src/mcp/tools-registry.js').TOOLS.length
  // 本轮第一版从 mcp-server.js 用正则抠 HANDLERS 键, 得 179 而实测 181 ——
  // 两个键的写法不匹配该正则。那会把文档里**正确**的 181 判成错, 是
  // "仪器把自己的局限报成引擎缺陷"的同族错误, 故改为与审计同一个来源。
  const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));
  return TOOLS.length;
}
function measureModules() {
  const { Aspira } = require(path.join(ROOT, 'src', 'core', 'heartflow.js'));
  const e = new Aspira();
  e.start();
  return Object.keys(e._modules || {}).length;
}
function readVersion() {
  return fs.readFileSync(VERSION_FILE, 'utf8').trim();
}

module.exports = function ({ test, assertEqual, assertTrue }) {
  const DIMS = measureDims();
  const LAYERS = measureLayerSet();
  const TOOLS = measureTools();
  const VER = readVersion();
  const MODULES = measureModules();

  // ── 一、package.json description 四个数字 ──────────────────
  test('package.json description 的规模数字必须与实测一致', () => {
    const desc = JSON.parse(fs.readFileSync(PKG, 'utf8')).description || '';
    const dims = /(\d+) discrimination dimensions/.exec(desc);
    const layerSet = /(\d+)-layer pipeline/.exec(desc);
    const perCall = /(\d+) layers per input call \/ (\d+) draft \/ (\d+) output/.exec(desc);
    const tools = /(\d+) MCP tools/.exec(desc);
    const mods = /(\d+) modules/.exec(desc);
    // 四个形态必须都在, 否则"声称缺失"会被读成"通过"
    assertTrue(!!dims, '前提失效: description 里找不到 "N discrimination dimensions"');
    assertTrue(!!layerSet, '前提失效: description 里找不到 "N-layer pipeline"');
    assertTrue(!!perCall, '前提失效: description 里找不到 "N layers per input call / N draft / N output"');
    assertTrue(!!tools, '前提失效: description 里找不到 "N MCP tools"');
    assertTrue(!!mods, '前提失效: description 里找不到 "N modules"');
    assertEqual(+dims[1], DIMS, `description 声称 ${dims[1]} dimensions, 实测 ${DIMS}`);
    assertEqual(+layerSet[1], LAYERS.length, `description 声称 ${layerSet[1]}-layer pipeline, 实测层集合 ${LAYERS.length}`);
    assertEqual(+perCall[1], measureLayerDepth('input'), `description 声称 input 每次 ${perCall[1]} 层, 实测 ${measureLayerDepth('input')}`);
    assertEqual(+perCall[2], measureLayerDepth('draft'), `description 声称 draft 每次 ${perCall[2]} 层, 实测 ${measureLayerDepth('draft')}`);
    assertEqual(+perCall[3], measureLayerDepth('output'), `description 声称 output 每次 ${perCall[3]} 层, 实测 ${measureLayerDepth('output')}`);
    assertEqual(+tools[1], TOOLS, `description 声称 ${tools[1]} MCP tools, 实测 ${TOOLS}`);
    assertEqual(+mods[1], MODULES, `description 声称 ${mods[1]} modules, 实测 ${MODULES}`);
  });

  // ── 二、agent-card.json 五个字段 ──────────────────────────
  test('.well-known/agent-card.json 的版本与规模字段必须与实测一致', () => {
    const card = JSON.parse(fs.readFileSync(CARD, 'utf8'));
    // version: 第六个版本副本, convention #1 只列了五个
    assertEqual(card.version, VER,
      `agent-card.json version 声称 ${card.version}, VERSION 文件为 ${VER} —— ` +
      '这是 A2A 协议发现路径, 冻结在旧版本会让外部 agent 认为引擎落后几十个版本');
    // description 里的中文维数
    const cn = /(\d+)维判别/.exec(card.description || '');
    assertTrue(!!cn, '前提失效: agent-card description 里找不到 "N维判别"');
    assertEqual(+cn[1], DIMS, `agent-card description 声称 ${cn[1]} 维, 实测 ${DIMS}`);
    assertEqual(card.capabilities.discriminationDimensions, DIMS,
      `agent-card capabilities.discriminationDimensions 声称 ${card.capabilities.discriminationDimensions}, 实测 ${DIMS}`);
    assertEqual(card.capabilities.tools, TOOLS,
      `agent-card capabilities.tools 声称 ${card.capabilities.tools}, 实测 ${TOOLS}`);
    assertEqual(card.tools.count, TOOLS,
      `agent-card tools.count 声称 ${card.tools.count}, 实测 ${TOOLS}`);
  });

  // ── 三、行为反向: 改错一个数字, 本锁必须红 ────────────────
  test('反向: 把 agent-card 的 dimensions 改错, 本锁必须按名红', () => {
    const orig = fs.readFileSync(CARD, 'utf8');
    const OLD = '"discriminationDimensions": 54,';
    assertTrue(orig.includes(OLD), '前提失效: 未匹配 discriminationDimensions 行(锚点已变)');
    const broken = orig.replace(OLD, '"discriminationDimensions": 45,');
    assertTrue(broken !== orig, '变异未生效');
    const copy = path.join(ROOT, '.well-known', '_agent-card-probe.json');
    try {
      fs.writeFileSync(copy, broken);
      const card = JSON.parse(fs.readFileSync(copy, 'utf8'));
      // 用与用例二相同的谓词跑一遍, 必须不等
      const same = card.capabilities.discriminationDimensions === DIMS;
      assertTrue(same === false,
        '反向证明失效: 改错后的值仍与实测相等 —— 说明用例二的谓词分不出对错');
    } finally {
      if (fs.existsSync(copy)) fs.unlinkSync(copy);
    }
    assertEqual(fs.readFileSync(CARD, 'utf8'), orig, '共享的 agent-card.json 必须未被本测试改动');
  });

  // ── 四、载体清单自证: 谓词必须分得清"声称存在/缺失" ────────
  test('自证: 谓词必须把"声称缺失"判为失败, 而不是放行', () => {
    const desc = 'Aspira — a rule engine. Zero dependencies.';
    // 与用例一相同的形态
    assertTrue(/(\d+) discrimination dimensions/.test(desc) === false,
      '自证失效: 一个不含该形态的 description 被判为含"dimensions 声称"');
    assertTrue(/(\d+) MCP tools/.test(desc) === false,
      '自证失效: 一个不含该形态的 description 被判为含"MCP tools 声称"');
    // 且真实 description 必须两个都中
    const real = JSON.parse(fs.readFileSync(PKG, 'utf8')).description;
    assertTrue(/(\d+) discrimination dimensions/.test(real), '自证失效: 真实 description 反而不含 dimensions 声称');
    assertTrue(/(\d+) MCP tools/.test(real), '自证失效: 真实 description 反而不含 MCP tools 声称');
  });
};
