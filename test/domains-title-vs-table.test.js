/**
 * test/domains-title-vs-table.test.js —
 * 一个 measured 了二十轮、却从未进入任何比对的数字
 *
 * [doc-honest-numbers·第一百七十六轮] 新建。
 *
 * ═══ 缺陷: m.domainsTitle 是死测量 ═══
 * `scripts/audit-doc-numbers.js` 从第七轮起就测 `m.domainsTitle`(README 能力域
 * 小节标题里的 "N domains"), 注释写得很清楚为什么不测不行:
 *   「若不测: 标题 "7 domains" 与表格行数可以各自漂移而无人发现」
 * 但实测全文**只有一处赋值、零处读取** —— 它从未进入任何比对, 也从未被打印。
 *
 * 这是 cycle 11 记录的 "measured, displayed, never compared" 形状, 而且这次
 * 连 displayed 都没有: 一个数字被算出来, 然后没有任何代码看过它。
 *
 * ═══ 为什么 domains 那条 pattern 兜不住 ═══
 * pats 里 `{ re: /(\d+)\s+domains?/g, key: 'domains' }` 匹配**任何** "N domains"
 * 文本, 所以"标题写 9 而表格 8 行"确实会被报 —— 看着像覆盖了。但真正的漂移
 * 形状是反的: **表格加一行而标题忘了改**。此时 m.domains 读到的是新行数(9),
 * 与别处文档的旧值(8)比对, 于是报错指向**另一份文档**。
 *
 * 实测(修复前): 给 README 的能力域表格加一行, 审计报
 *   `IDENTITY.md 声称「capability domains (中文) = 8」实测 9`
 * —— 真正该改的 README 标题无人点名, 而按这条报错去改 IDENTITY.md 会把一份
 * 正确的文档改成错的。**一个指错文件的报告比没有报告更糟。**
 *
 * ═══ 修法 ═══
 * 审计尾部加一节自洽检查: 标题数字必须等于表格行数, 不等则**指名 README.md**
 * 并说明此时上一条 domains 报错可能指向别的文件。接入 exitCode(不等 → 1)。
 *
 * ═══ 锁什么 ═══
 * ① 源级: 审计必须读 domainsTitle(不得再是死测量);
 * ② 源级: 自洽检查必须接入 exitCode;
 * ③ 行为: 干净文档 → 退出码 0 且报"一致";
 * ④ 行为: 注入"标题改数字" → 退出码 1 且点名 README;
 * ⑤ 行为: 注入"表格加一行" → 退出码 1 且点名 README(此前报错指向 IDENTITY.md);
 * ⑥ 反向: 删掉整个自洽检查 → 注入方向必须不再被它抓住(证明本条不是恒真)。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
// [第一百七十六轮] 本锁要读写 README.md(探针目标文档), 按 test/doc-reader-lock-
// coverage.test.js 的机械不变量, 必须持锁 —— 第一版用裸 fs.readFileSync/
// writeFileSync, 该锁当场报 "这些测试文件读探针目标文档但不持锁, 会看见探针的
// 半成品: test/domains-title-vs-table.test.js → README.md"。
// 这条规则是对的: 不持锁的读者确实可能在并发 run-all 下看见别家探针的注入态,
// 于是本锁的断言会因**别人的探针**而红, 而失败消息指向一个无关的文件。
const { withDocLock } = require(path.join(__dirname, '_doc-probe-lock.js'));

const ROOT = path.join(__dirname, '..');
const AUDIT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const README = path.join(ROOT, 'README.md');

// 审计跑一次约 40s(内部 spawn run-all); 用 ASPIRA_AUDIT_SKIP_TESTS 跳过测试段
// 只保留文档比对(这正是被测逻辑所在)。
function runAudit() {
  const r = spawnSync('node', [AUDIT], {
    cwd: ROOT, encoding: 'utf8', timeout: 600000,
    env: Object.assign({}, process.env, { ASPIRA_AUDIT_SKIP_TESTS: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).toString() };
}

module.exports = function ({ test, assertEqual, assertTrue }) {
  // [第一百七十六轮] 整个文件在 doc lock 内运行: 本锁读+写 README.md(探针目标
  // 文档), 持锁保证并发 run-all 下别家探针不会在本锁读与写之间改它。
  // 锁持有整个文件而非单个用例 —— cycle 21 的教训: 一个在锁外构造的场景,
  // 断言时不能保证它还在。
  withDocLock(() => {
    const original = fs.readFileSync(README, 'utf8');
    const restore = () => fs.writeFileSync(README, original);

  // ── 一、源级: domainsTitle 不得再是死测量 ───────────────
  test('源级: 审计必须读 m.domainsTitle(不得再是死测量)', () => {
    const src = fs.readFileSync(AUDIT, 'utf8');
    // 出现次数 >= 2 才有"赋值之外的读取"(第一版缺陷: 只有 1 次)
    const n = (src.match(/domainsTitle/g) || []).length;
    assertTrue(n >= 2,
      `domainsTitle 必须至少出现 2 次(1 次赋值 + 1 处读取), 实测 ${n} 次 —— ` +
      '只有 1 次说明它仍是死测量');
    // 且必须有"标题 vs 表格"的比对分支
    assertTrue(/domainsTitle\s*!=|String\(m\.domains\)\s*!==\s*String\(m\.domainsTitle\)/.test(src),
      '必须有标题数字与表格行数的显式比对');
    // 自证: 谓词分得清"只赋值"与"赋值+读取"
    const assignOnly = "      m.domainsTitle = (sec[0].match(/\\((\\d+)\\s+domains?/) || [])[1] || null;";
    assertTrue((assignOnly.match(/domainsTitle/g) || []).length === 1,
      '自证失效: 谓词分不清只赋值与赋值加读取, 本条是恒真锁');
  });

  // ── 二、源级: 自洽检查必须接入 exitCode ─────────────────
  test('源级: 自洽检查必须接入 exitCode', () => {
    const src = fs.readFileSync(AUDIT, 'utf8');
    const i = src.indexOf('能力域标题与表格行数不一致');
    assertTrue(i > 0, '前提失效: 找不到自洽检查的输出文案');
    const seg = src.slice(i, i + 1400);
    assertTrue(/process\.exitCode\s*=\s*1/.test(seg),
      '自洽检查不一致时必须设 process.exitCode = 1 —— 不设则它只印在 stdout, ' +
      '任何检查退出码的调用方都看不见');
    // 自证: 谓词分得清"设了"与"没设"
    assertTrue(/process\.exitCode\s*=\s*1/.test('console.log("x");') === false,
      '自证失效: 谓词把不含 exitCode 的片段判成含');
  });

  // ── 三、干净文档 → 退出码 0 且报一致 ────────────────────
  test('行为: 干净文档必须退出码 0 且报"标题与表格一致"', () => {
    const r = runAudit();
    assertEqual(r.code, 0, `干净文档审计应退出码 0, 实测 ${r.code}`);
    assertTrue(/标题 \d+ domains 与表格 \d+ 行一致/.test(r.out),
      '必须报出"标题 N domains 与表格 M 行一致" —— 不报则这个检查存在与否不可观察');
  });

  // ── 四、注入方向一: 标题改数字 ──────────────────────────
  test('行为: 标题数字改错必须退出码 1 且点名 README.md', () => {
    try {
      fs.writeFileSync(README,
        original.replace('### Capability domains (8 domains, 132 modules)',
          '### Capability domains (9 domains, 132 modules)'));
      const r = runAudit();
      assertEqual(r.code, 1, `注入后审计应退出码 1, 实测 ${r.code}`);
      assertTrue(/能力域标题与表格行数不一致\(README\.md\)/.test(r.out),
        '报错必须点名 README.md');
      assertTrue(/标题声称 9 domains, 实际表格 8 行/.test(r.out),
        '必须给出两侧数字, 实测未找到该行');
    } finally { restore(); }
    // 还原后必须回到 0(证明注入是唯一原因)
    const after = runAudit();
    assertEqual(after.code, 0, `还原后审计应回到退出码 0, 实测 ${after.code}`);
  });

  // ── 五、注入方向二: 表格加一行(此前报错指向别处) ────────
  test('行为: 表格加一行而标题不改, 必须点名 README(此前报错指向 IDENTITY.md)', () => {
    try {
      fs.writeFileSync(README,
        original.replace('| Classical texts |', '| Classical texts |\n| New domain | x |'));
      const r = runAudit();
      assertEqual(r.code, 1, `注入后审计应退出码 1, 实测 ${r.code}`);
      assertTrue(/能力域标题与表格行数不一致\(README\.md\)/.test(r.out),
        '必须点名 README.md —— 修复前这个形状报的是 IDENTITY.md, ' +
        '按它去改会把一份正确的文档改成错的');
      assertTrue(/标题声称 8 domains, 实际表格 9 行/.test(r.out),
        '必须给出两侧数字, 实测未找到该行');
    } finally { restore(); }
    const after = runAudit();
    assertEqual(after.code, 0, `还原后审计应回到退出码 0, 实测 ${after.code}`);
  });

  // ── 六、反向: 删掉自洽检查后注入必须不再被它抓住 ────────
  test('反向: 去掉自洽检查后, 注入方向不得再报"标题与表格不一致"', () => {
    // [第一百七十六轮] 反向证明在**副本**上做, 不改共享的 scripts/audit-doc-numbers.js。
    // 第一版直接改写共享源, 在并发 run-all 下踩中 cycle 22 记录的形状: 别家探针
    // (audit-gate-scope 等)正持有 doc lock 跑审计, 读到的是被剥掉检查的半份脚本,
    // 于是报"实测 86/87 一致 1 不一致"而失败消息指向一个无关的文件。
    // 共享源只能读; 要证明"这段代码是抓住注入的原因", 就把脚本复制到临时目录
    // 再剥 —— 副本与共享源字节相同, 剥掉的部分也完全相同, 证明力不减。
    const src = fs.readFileSync(AUDIT, 'utf8');
    const start = src.indexOf('  // ── [doc-honest-numbers·第一百七十六轮]');
    assertTrue(start > 0, '前提失效: 找不到自洽检查块(锚点已变, 反向证明无效)');
    const end = src.indexOf('  if (unmeasurable.length) {', start);
    assertTrue(end > start, '前提失效: 找不到自洽检查块的结束边界');
    const stripped = src.slice(0, start) + src.slice(end);
    // 副本放 test/ 外的临时目录: audit 内部用 __dirname 定位 ROOT, 复制到别处会
    // 改它的 ROOT, 所以副本必须留在仓库内同一相对深度。
    const COPY = path.join(ROOT, 'scripts', '_audit-domains-reverse-probe.js');
    try {
      fs.writeFileSync(COPY, stripped);
      fs.writeFileSync(README,
        original.replace('### Capability domains (8 domains, 132 modules)',
          '### Capability domains (9 domains, 132 modules)'));
      const r = spawnSync('node', [COPY], {
        cwd: ROOT, encoding: 'utf8', timeout: 600000,
        env: Object.assign({}, process.env, { ASPIRA_AUDIT_SKIP_TESTS: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = ((r.stdout || '') + (r.stderr || '')).toString();
      assertTrue(!/能力域标题与表格行数不一致/.test(out),
        '反向证明失效: 删掉自洽检查后仍报"标题与表格不一致" —— ' +
        '说明抓住注入的不是本节, 本条的通过是被别处买通的');
    } finally {
      if (fs.existsSync(COPY)) fs.unlinkSync(COPY);
      restore();
    }
    const after = runAudit();
    assertEqual(after.code, 0, `还原后审计应回到退出码 0, 实测 ${after.code}`);
  });
  });   // withDocLock
};
