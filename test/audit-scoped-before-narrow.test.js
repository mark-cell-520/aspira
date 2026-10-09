/**
 * test/audit-scoped-before-narrow.test.js —
 * 五个限量副词把"only 181 MCP tools in total"整句挡在审计之外
 *
 * [doc-honest-numbers·第一百七十七轮] 新建。
 *
 * ═══ 缺陷: SCOPED_BEFORE 把限量副词当成局部计数标志 ═══
 * `notScoped` 这道闸门回答「这条声称在说 aspira 的**总量**吗」, 判据是数字前
 * 24 字符窗口里有没有 scoping 词。原词表:
 *   tier | across | only | each | within | between | per | several | some
 * 其中 `across` / `tier` / `within` / `between` 按构造就是在说子集
 * ("across 8 modules" / "tier 1 modules"), 排掉正确。
 *
 * 但 `only` / `each` / `per` / `several` / `some` 是**限量副词**, 不是局部标志:
 *   "the engine ships only 181 MCP tools in total" 说的正是总量。
 *
 * 实测(修复前, 注入验证):
 *   "The engine ships only 131 modules in total."  → 不一致 **0**(漏)
 *   "The engine ships 131 modules in total."       → 不一致 1(抓)
 *
 * ═══ 比漏报更糟的那一半: 部分覆盖 ═══
 * 同一句 "ships only 180 MCP tools in total, and only 131 modules are
 * registered" 里, tools 被抓住而 modules 没有 —— tools 的 pattern 命中点落在
 * `only` 的 24 字符窗口之外, modules 的落在窗口内。一句里有的抓有的漏, 而
 * 报表是**全绿的**。一个只覆盖半句的检查, 比完全不覆盖更难发现: 前者让人
 * 以为这一类已经在管了。
 *
 * ═══ 修法 ═══
 * SCOPED_BEFORE 收窄为 tier | across | within | between 四个。
 * 影响面已实测: 现有文档被旧闸门挡下的规模声称 9 处, 全部是 `across N modules`
 * 形态(真正的局部计数), 新闸门放行其中 **0** 处 —— 这次收窄不产生任何新警报,
 * 只是让"only + 总量"这一类将来进得来。
 *
 * ═══ 锁什么 ═══
 * ① 源级: 五个限量副词不得再出现在 SCOPED_BEFORE 里, 四个局部标志必须保留;
 * ② 源级: notScoped 的判据窗口仍是 24 字符(改窗口会静默改变全部行为);
 * ③ 行为: "only + 错误总量"必须被抓住(修复前是 0 不一致);
 * ④ 行为: 同一句里 tools 与 modules 都必须被抓住(部分覆盖的形状);
 * ⑤ 行为: 真正的局部计数(across 8 modules)仍必须被排除(不得为修漏报而误报);
 * ⑥ 反向: 把五个词加回去 → ③④必须不再成立(证明本条不是恒真)。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { withDocLock } = require(path.join(__dirname, '_doc-probe-lock.js'));

const ROOT = path.join(__dirname, '..');
const AUDIT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
const README = path.join(ROOT, 'README.md');

function runAudit() {
  const r = spawnSync('node', [AUDIT], {
    cwd: ROOT, encoding: 'utf8', timeout: 600000,
    env: Object.assign({}, process.env, { ASPIRA_AUDIT_SKIP_TESTS: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return ((r.stdout || '') + (r.stderr || '')).toString();
}
const inconsistent = (out) => {
  const m = /不一致: (\d+)/.exec(out);
  return m ? Number(m[1]) : -1;
};

module.exports = function ({ test, assertEqual, assertTrue }) {
  // 本锁读+写 README.md(探针目标文档), 按 doc-reader-lock-coverage 的机械不变量
  // 必须持锁 —— 整个文件在锁内, 避免锁外构造的场景断言时已不在(cycle 21)。
  withDocLock(() => {
    const original = fs.readFileSync(README, 'utf8');
    const restore = () => fs.writeFileSync(README, original);

    // ── 一、源级: 五个限量副词不得再是排除词 ──────────────
    test('源级: only/each/per/several/some 不得再是排除词, 四个局部标志必须保留', () => {
      const src = fs.readFileSync(AUDIT, 'utf8');
      const line = (src.split('\n').find(l => l.includes('const SCOPED_BEFORE')) || '');
      assertTrue(/const SCOPED_BEFORE/.test(line), '前提失效: 找不到 SCOPED_BEFORE 定义');
      for (const w of ['only', 'each', 'per', 'several', 'some']) {
        assertTrue(!new RegExp('\\b' + w + '\\b').test(line),
          `"${w}" 是限量副词而非局部计数标志, 不得再作为排除词 —— ` +
          `"the engine ships ${w} 181 MCP tools in total" 说的正是总量`);
      }
      for (const w of ['tier', 'across', 'within', 'between']) {
        assertTrue(new RegExp('\\b' + w + '\\b').test(line),
          `"${w}" 按构造就是说子集("across 8 modules"), 必须保留为排除词`);
      }
      // 自证: 谓词必须分得清两个词表
      const oldLine = 'const SCOPED_BEFORE = /(?:tier|across|only|each|within|between|per|several|some)\\s*[-–—:]?\\s*$/i;';
      assertTrue(/\bonly\b/.test(oldLine) === true, '自证失效: 谓词分不清含 only 与不含');
      assertTrue(/\bonly\b/.test(line) === false, '自证失效: 谓词把当前行判成仍含 only');
    });

    // ── 二、源级: 判据窗口仍是 24 字符 ─────────────────────
    test('源级: notScoped 的前瞻窗口必须仍是 24 字符', () => {
      const src = fs.readFileSync(AUDIT, 'utf8');
      const i = src.indexOf('function notScoped(');
      assertTrue(i > 0, '前提失效: 找不到 notScoped 函数');
      const body = src.slice(i, src.indexOf('\n}', i));
      assertTrue(/at\s*-\s*24/.test(body),
        '前瞻窗口必须是 at - 24 —— 改窗口会静默改变每一条模式的行为, ' +
        '而没有任何测试会因此红');
      // 自证: 谓词分得清 24 与其他数
      assertTrue(/at\s*-\s*24/.test('const before = text.slice(Math.max(0, at - 60), at);') === false,
        '自证失效: 谓词把别的窗口值判成 24');
    });

    // ── 三、"only + 错误总量"必须被抓住 ────────────────────
    test('行为: "only + 错误总量"必须被审计抓住(修复前是 0 不一致)', () => {
      try {
        fs.writeFileSync(README,
          original.replace('×  0 runtime dependencies',
            '×  0 runtime dependencies\n\nThe engine ships only 131 modules in total.'));
        const out = runAudit();
        assertTrue(inconsistent(out) >= 1,
          `"only 131 modules"(实测 132)必须被报, 实测不一致 ${inconsistent(out)} —— ` +
          '修复前这个形态不一致数为 0, 整句被 only 挡在审计外');
        assertTrue(/modules[^」]*」实测 132/.test(out),
          '报错必须点名 modules, 实测未找到');
      } finally { restore(); }
      const after = runAudit();
      assertEqual(inconsistent(after), 0, `还原后应回到 0 不一致, 实测 ${inconsistent(after)}`);
    });

    // ── 四、同一句里 tools 与 modules 都必须被抓住 ─────────
    test('行为: 同一句里 tools 与 modules 都必须被抓住(部分覆盖的形状)', () => {
      try {
        fs.writeFileSync(README,
          original.replace('×  0 runtime dependencies',
            '×  0 runtime dependencies\n\nThe engine ships only 180 MCP tools in total, and only 131 modules are registered.'));
        const out = runAudit();
        const n = inconsistent(out);
        assertTrue(n >= 2,
          `同一句里 tools(180)与 modules(131)都应被报, 实测不一致 ${n} —— ` +
          '修复前只报 tools 不报 modules, 一句里有的抓有的漏而报表全绿');
        assertTrue(/MCP tools[^」]*」实测 181/.test(out), 'tools 必须被报');
        assertTrue(/modules[^」]*」实测 132/.test(out), 'modules 必须被报');
      } finally { restore(); }
      const after = runAudit();
      assertEqual(inconsistent(after), 0, `还原后应回到 0 不一致, 实测 ${inconsistent(after)}`);
    });

    // ── 五、局部计数的既有真实行为(锁住, 不借本轮改宽) ─────
    test('行为: across 在数字前的局部计数必须被排除(在数字后是既有已知洞)', () => {
      try {
        // across 保留为排除词, 且窗口只看数字**前** 24 字符 —— 所以只有
        // "across 8 modules" 被排除, "8 modules across the pipeline" 不被。
        // 后者是既有行为(第一百六十四轮加 notScoped 时就只覆盖前者),
        // 本轮**不改宽**: 动共享闸门会影响全部模式, 需要单独一轮的完整回归。
        // 这里把两侧都锁住, 使这个已知洞是显式的而不是隐性的。
        fs.writeFileSync(README,
          original.replace('×  0 runtime dependencies',
            '×  0 runtime dependencies\n\nThe change touches across 8 modules in the pipeline.'));
        const before = runAudit();
        assertEqual(inconsistent(before), 0,
          `"across 8 modules"(across 在数字前)必须被排除, 实测不一致 ${inconsistent(before)}`);

        fs.writeFileSync(README,
          original.replace('×  0 runtime dependencies',
            '×  0 runtime dependencies\n\nThe change touches 8 modules across the pipeline.'));
        const after = runAudit();
        assertTrue(inconsistent(after) >= 1,
          `已知洞(显式记录): "8 modules across the pipeline" 里 across 在数字**后**, ` +
          `不在 24 字符前瞻窗口内, 所以会被报 —— 实测不一致 ${inconsistent(after)}。` +
          '这不是本轮引入的, 改它需要单独一轮(动共享闸门影响全部模式)');
      } finally { restore(); }
      const clean = runAudit();
      assertEqual(inconsistent(clean), 0, `还原后应回到 0 不一致, 实测 ${inconsistent(clean)}`);
    });

    // ── 六、反向: 把五个词加回去 → ③④必须不再成立 ──────────
    test('反向: 把五个限量副词加回排除词表后, 注入必须不再被抓住', () => {
      // 反向证明在副本上做: 共享源只能读(cycle 22), 否则并发 run-all 下别家
      // 探针会读到被改一半的审计脚本。
      const src = fs.readFileSync(AUDIT, 'utf8');
      const OLD = 'const SCOPED_BEFORE = /(?:tier|across|within|between)\\s*[-–—:]?\\s*$/i;';
      const NEW = 'const SCOPED_BEFORE = /(?:tier|across|only|each|within|between|per|several|some)\\s*[-–—:]?\\s*$/i;';
      assertTrue(src.includes(OLD), '前提失效: 找不到收窄后的 SCOPED_BEFORE(锚点已变)');
      const COPY = path.join(ROOT, 'scripts', '_audit-scoped-reverse-probe.js');
      try {
        fs.writeFileSync(COPY, src.replace(OLD, NEW));
        fs.writeFileSync(README,
          original.replace('×  0 runtime dependencies',
            '×  0 runtime dependencies\n\nThe engine ships only 131 modules in total.'));
        const r = spawnSync('node', [COPY], {
          cwd: ROOT, encoding: 'utf8', timeout: 600000,
          env: Object.assign({}, process.env, { ASPIRA_AUDIT_SKIP_TESTS: '1' }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const out = ((r.stdout || '') + (r.stderr || '')).toString();
        assertEqual(inconsistent(out), 0,
          '反向证明失效: 把五个词加回去后仍报不一致 —— 说明抓住注入的不是本词表, ' +
          '本条的通过是被别处买通的');
      } finally {
        if (fs.existsSync(COPY)) fs.unlinkSync(COPY);
        restore();
      }
      const after = runAudit();
      assertEqual(inconsistent(after), 0, `还原后应回到 0 不一致, 实测 ${inconsistent(after)}`);
    });
  });   // withDocLock
};
