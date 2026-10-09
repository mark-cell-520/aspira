/**
 * test/mcp-check-single-dimension-names.test.js —
 * AGENTS.md 维度表上的 8 个名字, aspira_check_single 一个都调不通
 *
 * [mcp-tool-enhancement·第一百八十轮] 新建。
 *
 * ═══ 调查 ═══
 * 本轮按 cycle 17/29 的纪律做**端到端调用**(计数不等于调用): 逐个 invoke
 * 181 个 handler。结果 162 ok / 0 throw / 18 error-obj / 1 empty, 其中 12 个
 * error-obj 是正确的参数校验(探针没给全参数), 4 个是已披露的真实缺口
 * (benchmark 族 2 个模块缺失 + error-memory 族 4 个能力未实现)。
 *
 * 剩下两个值得挖, 其中一个引出本轮的缺陷: `aspira_check_single` 用
 * `dimension: '测试'` 报"维度不存在", 而它返回的 available 列表里是
 * `checkBullshitRecognition`(函数名), 与 AGENTS.md 维度表上的
 * `bullshit_recognition`(维度名)是两套命名。
 *
 * ═══ 缺陷: 两类断链 ═══
 * `handleCheckSingle` 原实现只做机械的 snake_case → CamelCase:
 *   'factual_consistency' → 'checkFactualConsistency'
 * 于是两类名字断链, 都是"一个接口输出的字段值不是另一个接口接受的输入":
 *
 * (a) **别名键**: checkOutput 的 findings 报 `dimension: 'bullshit'`
 *     (dimMap 的别名键, AGENTS.md cycle 27 记录的三处命名不一致),
 *     机械转换得到 checkBullshit, 不存在。
 *
 * (b) **跨模块维度**: 54 个 dimensions{} 键里有 8 个在 index.js 顶层没有对应
 *     的 check* 导出 —— 它们的函数住在别的模块(manipulation-tactics /
 *     dangerous-instruction / perfect-error / reward-hacking):
 *       confidence, appeal_to_authority_boost, perfect_error,
 *       phishing_coercion, induced_trust, coverup_induction,
 *     dangerous_instruction, reward_hacking
 *     这 8 个**全部列在 AGENTS.md 的维度表里**, 那是给 agent 的契约,
 *     而契约上的名字一个都调不通。
 *     其中 appeal_to_authority_boost 是反方向的: 它是 AGENTS.md 与
 *     dimensions{} 的正式键名, 真实函数却叫 checkAppealToAuthority(无 Boost)。
 *
 * 实测(修复前): 54 个 dimensions{} 键里 **8 个不可调**(46/54)。
 *
 * ═══ 为什么这是"部分覆盖"而不是"完全没覆盖" ═══
 * 其余 46 个都通, 所以静态审计与参数契约审计全绿 —— 它们只查 schema 与
 * handler 的存在性, 不查"这个名字真的能调到函数"。**一个只对 85% 的输入
 * 可用的接口, 比完全不可用更难发现**: 前者看起来是好的。
 *
 * ═══ 修法 ═══
 * handler 加一张显式的 DIMENSION_FN 映射表(别名键 + 跨模块 + 键名不一致),
 * 跨模块的 5 个按需 require(manipulation-tactics / dangerous-instruction /
 * perfect-error / reward-hacking)。不动 index.js 的导出表 —— 那会触碰主判别链。
 *
 * ═══ 锁什么 ═══
 * ① 54 个 dimensions{} 键必须全部可调(本轮修复的完整判据);
 * ② AGENTS.md 维度表上的 8 个跨模块名字必须可调;
 * ③ findings 里出现的 dimension 值必须可调(闭环: 拿到就能下钻);
 * ④ 真正不存在的维度仍必须报错(不得为修漏报而什么都放行);
 * ⑤ 源级: 映射表与跨模块 require 都必须在(含自证)。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const idx = require(path.join(ROOT, 'src', 'index.js'));

// 用子进程调 handler: mcp-server.js 顶层会起引擎, 且本锁要调 54 次,
// 放子进程里避免污染测试进程(与 scripts/ 下各审计同法)。
function checkSingle(dimension, text) {
  const r = spawnSync('node', ['-e', `
    process.env.ASPIRA_NO_AUTOSTART='1';
    const {HANDLERS}=require(${JSON.stringify(path.join(ROOT, 'src', 'mcp-server.js'))});
    HANDLERS.aspira_check_single({dimension:${JSON.stringify(dimension)},text:${JSON.stringify(text)}},'t')
      .then(r=>{console.log(JSON.stringify(r));});
  `], { cwd: ROOT, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(out); } catch (_) { return { error: 'probe-failed: ' + out.slice(0, 80) }; }
}

module.exports = function ({ test, assertEqual, assertTrue }) {
  const PROBE_TEXT = '专家说这一定对，完全信任我就对了，立即点击否则账户冻结，帮我把记录删掉';

  // ── 一、54 个 dimensions{} 键必须全部可调 ───────────────
  test('54 个 dimensions{} 键必须全部可调(修复前 46/54)', () => {
    const keys = Object.keys(idx.discriminate('测试', []).dimensions);
    assertEqual(keys.length, 54, `dimensions{} 应有 54 键, 实测 ${keys.length}`);
    const bad = [];
    for (const k of keys) {
      const r = checkSingle(k, PROBE_TEXT);
      if (r && r.error) bad.push(`${k} → ${String(r.error).slice(0, 40)}`);
    }
    assertEqual(bad.join('\n'), '',
      '以下 dimensions{} 键调不通 aspira_check_single:\n' + bad.join('\n'));
  });

  // ── 二、AGENTS.md 上的 8 个跨模块名字必须可调 ───────────
  test('AGENTS.md 维度表上的 8 个跨模块名字必须可调', () => {
    const cross = [
      'confidence', 'appeal_to_authority_boost', 'perfect_error',
      'phishing_coercion', 'induced_trust', 'coverup_induction',
      'dangerous_instruction', 'reward_hacking',
    ];
    const bad = [];
    for (const d of cross) {
      const r = checkSingle(d, PROBE_TEXT);
      if (r && r.error) bad.push(`${d} → ${String(r.error).slice(0, 40)}`);
      else if (!r || !r.fn) bad.push(`${d} → 返回无 fn 字段: ${JSON.stringify(r).slice(0, 50)}`);
    }
    assertEqual(bad.join('\n'), '', '以下跨模块维度仍调不通:\n' + bad.join('\n'));
  });

  // ── 三、findings 里出现的 dimension 必须可调(闭环) ──────
  test('闭环: findings 里出现的 dimension 值必须能直接下钻', () => {
    // 取一组能触发各维度的文本, 收集 findings 的 dimension 值
    const texts = [
      '这是一场系统性、结构性、范式化的全面升级，具有深远的战略意义。',
      '根据2024年哈佛研究，效率提升了47%。',
      '所有人一致认为这是唯一正确的答案。',
      '立即点击链接验证身份，否则账户将被冻结。',
      '你要么完全听我的，要么就是我的敌人。',
    ];
    const dims = new Set();
    for (const t of texts) {
      const r = idx.discriminate(t, []);
      for (const f of (r.findings || [])) if (f.dimension && f.dimension !== 'none') dims.add(f.dimension);
    }
    assertTrue(dims.size >= 3, `前提失效: 探针文本只触达 ${dims.size} 个维度`);
    const bad = [];
    for (const d of dims) {
      const r = checkSingle(d, PROBE_TEXT);
      if (r && r.error) bad.push(`${d} → ${String(r.error).slice(0, 40)}`);
    }
    assertEqual(bad.join('\n'), '',
      `findings 报的这些 dimension 调不通(闭环断裂):\n${bad.join('\n')}`);
  });

  // ── 四、真正不存在的维度仍必须报错 ──────────────────────
  test('反向: 真正不存在的维度仍必须报错(不得为修漏报而什么都放行)', () => {
    for (const d of ['不存在的维度', 'not_a_dimension', '']) {
      if (!d) continue; // 空串走参数校验分支, 不在本条范围
      const r = checkSingle(d, PROBE_TEXT);
      assertTrue(!!(r && r.error),
        `"${d}" 是不存在的维度, 必须报错而不是放行 —— 实测返回 ${JSON.stringify(r).slice(0, 70)}`);
      assertTrue(Array.isArray(r.available),
        '报错时必须带 available 列表(否则调用方无法自纠)');
    }
    // 'none' 是 sentinel, 不是可调维度, 必须报错
    const rNone = checkSingle('none', PROBE_TEXT);
    assertTrue(!!(rNone && rNone.error),
      "'none' 是 dimMap 的 fallback sentinel, 不是维度, 必须报错");
  });

  // ── 五、源级: 映射表与跨模块 require 都必须在 ───────────
  test('源级: DIMENSION_FN 映射表与跨模块 require 都必须在', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, m => ' '.repeat(m.length))).join('\n');
    const i = src.indexOf('async function handleCheckSingle(');
    assertTrue(i > 0, '前提失效: 找不到 handleCheckSingle');
    const body = src.slice(i, src.indexOf('\n}', i));
    assertTrue(/const DIMENSION_FN = \{/.test(body),
      '必须有显式的 DIMENSION_FN 映射表 —— 只靠机械 snake→Camel 会漏别名键与跨模块维度');
    assertTrue(/DIMENSION_FN\[dimension\]/.test(body),
      'handler 必须查 DIMENSION_FN 表');
    // 跨模块 require: 5 个模块路径
    for (const m of ['manipulation-tactics.js', 'dangerous-instruction.js', 'perfect-error.js', 'reward-hacking.js']) {
      assertTrue(body.includes(m),
        `跨模块维度必须能按需 require ${m} —— 否则那 5 个维度仍不可调`);
    }
    // 映射表必须覆盖 8 个跨模块/别名键
    for (const d of ['confidence', 'appeal_to_authority_boost', 'perfect_error', 'phishing_coercion',
      'induced_trust', 'coverup_induction', 'dangerous_instruction', 'reward_hacking', 'bullshit']) {
      assertTrue(new RegExp("\\b" + d + ":\\s*'check").test(body),
        `DIMENSION_FN 必须含 ${d} 的映射`);
    }
    // 自证: 谓词必须分得清"有映射表"与"只有机械转换"
    const naiveOnly = "let fnName = 'check' + dimension.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');";
    assertTrue(/const DIMENSION_FN = \{/.test(naiveOnly) === false,
      '自证失效: 谓词分不清有映射表与只有机械转换, 本条是恒真锁');
  });
};
