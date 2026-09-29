/**
 * test/audit-doc-coverage.test.js — 诚实数字审计仪器的**覆盖范围**
 *
 * ═══ 背景: 审计全绿，是因为它看不见 ═══
 * doc-honest-numbers 周期实测发现: `scripts/audit-doc-numbers.js` 的 DOCS
 * 长期硬编码只有 3 个文件——
 *
 *     const DOCS = ['README.md', 'SKILL.md', 'AGENTS.md'];
 *
 * 而仓库有 21 个 markdown，**其余 18 个从未进入审计视野**。后果已实测发生:
 *
 *     CONTRIBUTING.md  "The 45 discrimination dimensions"   实测 54
 *     CURRENT_STATE.md "128 modules, 119 tests, v6.0.65"    实测 132 / 962 / v1.0.0
 *     CURRENT_STATE.md "382 formulas"                       实测 1286
 *
 * 两份都是**现在时陈述**，却因不在扫描列表里长期无人核对，而审计一直报 34/34 全绿。
 * 这与已记录的"逃逸召回盲点"同根: **仪器看不见的风险等于不存在**——
 * 绿不是没问题，是它看不见那 18 个文件。
 *
 * ═══ 修了什么 ═══
 * 1. DOCS 改为扫描全部 markdown，仅显式豁免"整份用途就是记录过去"的历史文档，
 *    且每条豁免写理由(避免豁免成为藏污之处)。
 * 2. 补 `(\d+) tests passed` 模式——CURRENT_STATE.md 的形态是
 *    "962 tests passed / 0 failed"，既不是表格也不是 "Test suite ... passing"，
 *    原有模式一条都匹配不上，该文件的测试数声称因此不受审计。
 * 3. 修掉三处陈旧 claim(公式数 382→1286 的依据: 引擎加载日志两次独立运行
 *    均报 "85 个文件，1286 条公式"，FormulaSearch 与 FormulaEngine 一致)。
 *
 * ═══ 负向控制(证明仪器真的能看见，而非又一次失明) ═══
 * 本周期手工做过: 把两个文件改回陈旧值 → 审计报 3 处不符并正确指名文件;
 * 恢复 → 回到 37/37。本测试用**只读**方式固化该能力: 直接从脚本源码取出
 * 正则，验证它能匹配 CURRENT_STATE.md 的真实claim文本。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const { withDocLock } = require('./_doc-probe-lock.js'); // [第七轮] 跑审计须持共享文档锁(见 test/_doc-probe-lock.js)
  return withDocLock(() => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const scriptSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-doc-numbers.js'), 'utf8');

  const allMd = fs.readdirSync(ROOT).filter(f => f.endsWith('.md'));

  // 从源码解析 HISTORICAL_DOCS 的豁免集合
  const histMatch = scriptSrc.match(/const HISTORICAL_DOCS = \{([\s\S]*?)\n\};/);
  assertTrue(!!histMatch, '审计脚本应定义 HISTORICAL_DOCS 豁免表');
  const historical = new Set();
  if (histMatch) {
    const re = /'([^']+)'\s*:/g;
    let m;
    while ((m = re.exec(histMatch[1]))) historical.add(m[1]);
  }

  test('审计范围不得硬编码文件列表(必须动态扫描)', () => {
    // 这是上一轮修复的核心: 曾经就是 const DOCS = ['README.md','SKILL.md','AGENTS.md']
    // 导致 18 个根目录 md 完全失明。
    // [本轮扩展] 之后又发现 readdirSync(ROOT) **只列根目录**，
    // 子目录 368 份 md(约 1894 条数字型声称)完全不在扫描范围，
    // 真实覆盖率只有 9.2%。于是 DOCS 被 walkMd + DOCS_RECURSIVE 取代。
    //
    // 这里锁的是**原则**而不是变量名: 不得硬编码，必须动态发现。
    // 上一版写成 /const DOCS = fs\.readdirSync\(ROOT\)/, 本轮改了结构它就失败——
    // 守卫该锁原则，锁具体实现会让"正确的前进"被当成"倒退"拦下。
    assertTrue(!/const (?:DOCS|DOCS_RECURSIVE)\s*=\s*\[/.test(scriptSrc),
      '审计范围不得硬编码文件列表——那正是 md 失明的原因');
    assertTrue(/walkMd\s*\(/.test(scriptSrc),
      '必须用 walkMd 递归扫描——只列根目录会让子目录全部失明');
    assertTrue(/DOCS_RECURSIVE/.test(scriptSrc),
      '应存在 DOCS_RECURSIVE 作为实际扫描范围');
  });

  test('全部非历史 markdown 都必须进入审计范围(含子目录)', () => {
    const expected = allMd.filter(f => !historical.has(f)).sort();
    // 至少覆盖原来的 3 个 + 本周期发现盲区的 2 个
    for (const f of ['README.md', 'SKILL.md', 'AGENTS.md', 'CURRENT_STATE.md', 'CONTRIBUTING.md']) {
      assertTrue(expected.includes(f), `${f} 应在审计范围内`);
    }
    assertTrue(expected.length >= 10,
      `审计范围应覆盖大部分 markdown(实测非历史文件 ${expected.length} 个)，` +
      `若过少说明又退回了硬编码列表`);
    // 历史文档必须被豁免且有理由(每条豁免值后应有注释说明)
    for (const h of historical) {
      assertTrue(allMd.includes(h), `豁免的 ${h} 应真实存在`);
    }
    // [本轮扩展] 子目录豁免也必须附理由
    assertTrue(/EXEMPT_DIRS\s*=/.test(scriptSrc),
      '子目录豁免必须成表且每条带理由');
    for (const reason of ['report', 'docs', 'plans']) {
      assertTrue(scriptSrc.includes(`'${reason}'`),
        `子目录 ${reason}/ 的豁免应有显式理由`);
    }
  });

  test('豁免表必须附理由(防止豁免成为藏污之处)', () => {
    if (!histMatch) return;
    // 格式是 '文件名': '理由' —— 理由在值里，比行尾注释更结构化
    const entries = histMatch[1].split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('//'));
    assertTrue(entries.length > 0, 'HISTORICAL_DOCS 不应为空');
    for (const e of entries) {
      const m = e.match(/^'([^']+)'\s*:\s*'([^']*)'/);
      assertTrue(!!m, `豁免条目应形如 '文件': '理由'，实际: ${e.slice(0, 60)}`);
      if (m) assertTrue(m[2].trim().length > 0,
        `豁免 ${m[1]} 缺少理由——没有理由的豁免就是藏污之处`);
    }
  });

  test('必须存在 "N tests passed" 散文模式(CURRENT_STATE.md 的形态)', () => {
    assertTrue(/\(\\\?d\[\\d,\]\*\)\\\\s\+tests\?\\\\s\+passed|\(\d\[[\d,]*\)\s+tests\?\s+passed/.test(scriptSrc)
      || scriptSrc.includes('tests?\\s+passed') || /tests\?\\\\s\+passed/.test(scriptSrc),
      '缺少 "(N) tests passed" 模式——CURRENT_STATE.md 的测试数声称将再次不受审计');
  });

  test('该模式必须真的能匹配 CURRENT_STATE.md 的 claim 文本(只读负向控制)', () => {
    // 注意: 源码里是字面量 `\s+`(反杠+s)，搜索时必须按字符串包含匹配，
    // 不能写成正则 \s+(那会被解释成空白符)——本测试第一版正踩此坑。
    const line = scriptSrc.split('\n').find(l =>
      l.includes('tests?\\s+passed') && l.includes("key: 'tests'"));
    assertTrue(!!line, '应能在脚本中定位到 tests passed 模式的定义行');
    if (!line) return;
    const pm = line.match(/re:\s*\/(.+?)\/[a-z]*\s*,\s*key/);
    assertTrue(!!pm, `无法从该行提取正则: ${line.trim().slice(0, 70)}`);
    if (!pm) return;
    const re = new RegExp(pm[1], 'g');
    const doc = fs.readFileSync(path.join(ROOT, 'CURRENT_STATE.md'), 'utf8');
    const hit = doc.match(re);
    assertTrue(!!hit, `模式 /${pm[1]}/ 未匹配到 CURRENT_STATE.md 的测试数声称——仪器对此处仍然失明`);
  });

  test('CURRENT_STATE.md 与 CONTRIBUTING.md 的维度/模块数必须等于实测', () => {
    // 实测(轻量，不跑 run-all)
    const gate = require(path.join(ROOT, 'src', 'gate.js'));
    const dims = Object.keys(gate.discriminate('x', []).dimensions || {}).length;
    const cs = fs.readFileSync(path.join(ROOT, 'CURRENT_STATE.md'), 'utf8');
    const ct = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');

    const mDims = ct.match(/(\d+)\s+discrimination dimensions/);
    assertTrue(!!mDims, 'CONTRIBUTING.md 应含 "N discrimination dimensions" 声称');
    if (mDims) assertEqual(Number(mDims[1]), dims,
      `CONTRIBUTING.md 声称 ${mDims[1]} 个维度，实测 ${dims}`);

    const mMod = cs.match(/(\d+)\s+modules/);
    assertTrue(!!mMod, 'CURRENT_STATE.md 应含 "N modules" 声称');
    if (mMod) assertEqual(Number(mMod[1]), 132,
      `CURRENT_STATE.md 声称 ${mMod[1]} 个模块，实测 132`);
  });

  test('CURRENT_STATE.md 的版本号必须等于 VERSION', () => {
    const V = require(path.join(ROOT, 'src', 'core', 'version.js'));
    const ver = V.VERSION || V.version;
    const cs = fs.readFileSync(path.join(ROOT, 'CURRENT_STATE.md'), 'utf8');
    const m = cs.match(/版本\s*\|\s*v([0-9.]+)/);
    assertTrue(!!m, 'CURRENT_STATE.md 应含版本声称');
    if (m) assertEqual(m[1], ver, `CURRENT_STATE.md 声称 v${m[1]}，实测 VERSION=${ver}`);
  });

  test('CURRENT_STATE.md 的测试数必须与 README 的 Test suite 表一致(跨文档一致性)', () => {
    const cs = fs.readFileSync(path.join(ROOT, 'CURRENT_STATE.md'), 'utf8');
    const rd = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const a = cs.match(/(\d[\d,]*)\s+tests?\s+passed/);
    const b = rd.match(/\|\s*Test suite\s*\|\s*([\d,]+)\s+passing/);
    assertTrue(!!a && !!b, '两处都应有测试数声称');
    if (a && b) assertEqual(a[1].replace(/,/g, ''), b[1].replace(/,/g, ''),
      `CURRENT_STATE.md 说 ${a[1]} 而 README 说 ${b[1]}，跨文档不一致`);
  });
  });
};
