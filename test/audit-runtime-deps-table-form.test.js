/**
 * test/audit-runtime-deps-table-form.test.js
 *
 * [doc-honest-numbers·第二百二十四轮] 新建。
 *
 * ═══ 怎么找到的 ═══
 * 本轮审计读数全绿(100 项 / 94 一致 / 0 不符)，所以不能问"哪个数字错了"，
 * 只能问 cycle 208 那个方向的新问题: **绿报告里，有哪些 key 有实测值、有
 * pattern，却从来没有任何文档声称落进那个 pattern。**
 *
 * 机械枚举 pats 的 51 条 pattern 对全部 218 份文档的命中数，再用同样的判据
 * 逐行核对 SKILL.md/README.md 指标表的 21 个标签，得到 4 个无 pattern 覆盖的
 * 标签: Pipeline layers / Capability guard / Security regression / Runtime
 * dependencies。逐个核实后只有 Runtime dependencies 是**真缺陷**:
 *   · Capability guard 的 18 项是 cycle 130 注释里**已披露的刻意排除**;
 *   · Security regression 无 key 也无实测值，属于"没人测量"而非"测了不锁";
 *   · Pipeline layers 的 pattern 只认 `17-layer pipeline` 与中文形态，
 *     表格行写 `11 input / 12 draft / 13 output`，而 cycle 219 已就
 *     "两个口径"单独披露过;
 *   · Runtime dependencies: m.depsActuallyRequired **每轮都实测**(不在 try
 *     内的外部 require 数)，README 头条那行也已被审，但**表格行没有**。
 *
 * ═══ 根因 ═══
 * SKILL.md:164 与 README.md:143 写的是
 *     | Runtime dependencies | 0 required by the core |
 *     | Runtime dependencies | 0 |
 * 数字在标签**之后**，而 cycle 4 那条 pattern 是 `(\d+)\s+runtime\s+dependenc`
 * —— 要求数字在前。所以这两行从 cycle 4 起从未受过审，报告一直全绿。
 *
 * 这是 cycle 219(CURRENT_STATE 的 `0 failed` 因为写在 passed 之后就没人审)、
 * cycle 164(IDENTITY.md 的中文形态)的同族第三次: **同一个数字换个词序、
 * 加个后缀，就成了仪器的盲区，而报告照旧全绿。**
 *
 * ═══ 修法 ═══
 * 给 deps 加一条锚定在 `Runtime dependencies` 标签上的 pattern，只吃表格行，
 * 不碰头条散文(那条归旧 pattern 管，不会双重计数)。实测值不变。
 *
 * ═══ 本锁钉什么 ═══
 * ① 两行表格声称必须被审计接到，且值必须等于实测 0；
 * ② 注入错值必须让审计报不符(防"接到但接到的是错的")；
 * ③ 反向证明删掉新 pattern 后表格声称必须消失，且反向对照头条声称仍在；
 * ④ 披露: 这两种形态互不重叠(旧 pattern 管不到表格行 —— 盲区的定义本身)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const cp = require('child_process');
  const ROOT = path.join(__dirname, '..');
  const AUDIT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');
  const SRC = fs.readFileSync(AUDIT, 'utf8');

  const TABLE_RE = /Runtime\s+dependencies\s*\|\s*(\d+)/gi;
  const HEADLINE_RE = /(\d+)\s+runtime\s+dependenc/gi;
  // 新 pattern 在源码里的字面量片段。用 indexOf 而非正则, 避开多层转义:
  // 源码里是 \s(正则元字符), JS 源码里要写 \\s 才是它, 再套一层 shell 就是四层。
  const NEW_PAT_SRC = 'Runtime\\s+dependencies\\s*\\|\\s*(\\d+)';

  const { withDocLock, readDoc } = require(path.join(__dirname, '_doc-probe-lock.js'));

  // 持锁读: 读者必须持锁, 否则会看见探针写入 SKILL.md/README.md 的半成品
  // (cycle 21 的教训, 由 test/doc-reader-lock-coverage.test.js 机械执行)
  const readDocFile = (f) => readDoc(path.join(ROOT, f));

  // ── 崩溃自愈 ──────────────────────────────────────────────────
  // 探针在"注入 3 → spawn 审计"之间被 run-all 的 CHILD_TIMEOUT(240s)杀掉时,
  // ② 的 finally 不会执行, SKILL.md 永久停在 3。之后每次跑本文件:
  //   · ① 恒红(读到 3, 而它断言必须是 0);
  //   · ② 的 orig 本身就是污染副本, 注入退化成恒等替换, 真正的错误
  //     "注入应改变文件内容"被 finally 那句"恢复失败"盖掉 —— 报出来的
  //     原因和真正的原因不是同一件事。
  // 实测(本轮): node test/run-all.js 全程门禁里本文件 Command failed,
  // 跑完 git status 多出一个脏 SKILL.md, 单独重跑 2 过 2 失败, 且审计
  // 对表格形态报"不一致: 3", 一条本该全绿的核对从此常红, 只能手工还原。
  // _doc-probe-lock.js 只修了并发互斥那一半(探针互相踩), 没修崩溃这一半。
  // 修法: 正确值 0 本来就是本锁钉住的地面真相, 注入前先按它归位,
  // 恢复时写归位后的内容, 不写可能已污染的原始备份。
  const TABLE_CANON = 'Runtime dependencies | 0';
  const repairTable = (f) => {
    const p = path.join(ROOT, f);
    const txt = fs.readFileSync(p, 'utf8');
    TABLE_RE.lastIndex = 0;
    const fixed = txt.replace(TABLE_RE, TABLE_CANON);
    if (fixed !== txt) fs.writeFileSync(p, fixed);
    return fixed;
  };

  const runAudit = () => {
    const r = cp.spawnSync('node', [AUDIT], {
      cwd: ROOT, encoding: 'utf8', timeout: 240000,
      env: Object.assign({}, process.env, { ASPIRA_AUDIT_SKIP_TESTS: '1' }),
    });
    return (r.stdout || '') + (r.stderr || '');
  };

  // ── ① 两行表格声称必须被接到，且值为实测 0 ──────────────────
  test('Runtime dependencies 的表格形态必须受审，且值为 0', () => withDocLock(() => {
    // 先归位再断言: 上一次探针若被超时杀掉, SKILL.md 会停在注入值,
    // 不归位的话这条用例永远在为别人的崩溃红。
    repairTable('SKILL.md');
    for (const f of ['SKILL.md', 'README.md']) {
      const txt = readDocFile(f);
      TABLE_RE.lastIndex = 0;
      const hits = txt.match(TABLE_RE) || [];
      assertTrue(hits.length >= 1, f + ' 里找不到表格形态行 —— 本用例前提不成立');
      for (const h of hits) {
        const v = Number(h.match(/(\d+)\s*$/)[1]);
        assertEqual(v, 0, f + ' 的表格行读作 ' + v + '，实测是 0');
      }
    }
    const out = runAudit();
    // 正常态下不该有表格形态的不符(它读到的是正确的 0)
    assertTrue(!/表格形态\) = [1-9]/.test(out),
      '审计对表格形态报出了不符: ' + (out.match(/表格形态\) = \d+/) || [''])[0]);
    // 且该 pattern 不能落在审计的死 pattern 清单里(那意味着全文档零命中)
    const deadSeg = out.split('死 pattern')[1] || '';
    assertTrue(!deadSeg.includes('表格形态'),
      '新 pattern 出现在审计的死 pattern 清单里 —— 它在全部文档上零命中');
  }));

  // ── ② 注入非 0 必须让审计报不符 ───────────────────────────
  test('把表格行改成非 0，审计必须报不符', () => withDocLock(() => {
    const p = path.join(ROOT, 'SKILL.md');
    const orig = readDocFile('SKILL.md');
    const injected = orig.replace(TABLE_RE, 'Runtime dependencies | 3');
    try {
      assertTrue(injected !== orig, '注入应改变文件内容');
      fs.writeFileSync(p, injected);
      const out = runAudit();
      assertTrue(/不一致: [1-9]/.test(out), '表格行被改成 3，审计却没有报不符');
      assertTrue(/表格形态/.test(out), '审计应把该行按表格形态报出');
    } finally {
      // 写回归位后的内容而非原始备份: 备份可能本身就是上一次崩溃留下的
      // 污染副本(那时 orig 已是 3, 注入是恒等替换), 照抄会把污染传下去。
      fs.writeFileSync(p, orig.replace(TABLE_RE, TABLE_CANON));
      const back = readDocFile('SKILL.md');
      if (!/Runtime dependencies \| 0/.test(back)) {
        throw new Error('恢复失败: SKILL.md 的 Runtime dependencies 表格行异常');
      }
    }
  }));

  // ── ③ 反向证明 + 反向对照 ─────────────────────────────────
  test('反向证明: 删掉新 pattern 后表格形态必须消失，头条形态必须仍在', () => {
    assertTrue(SRC.includes(NEW_PAT_SRC), '源码里找不到新 pattern 的表格形态');
    const anchor = NEW_PAT_SRC;
    assertTrue(SRC.includes(anchor), '删除用的锚点在源码里找不到 —— 锚点已变，本证明无效');
    // 只删新 pattern 那一条(按它独有的 what 字段定位)
    const stripped = SRC.replace(
      /\{\s*re:\s*\/Runtime\\s\+dependencies[\s\S]*?narrativeQuote\(t, a\) \},\s*\n/,
      ''
    );
    assertTrue(stripped !== SRC, '删除新 pattern 的替换未生效');
    assertTrue(!stripped.includes(NEW_PAT_SRC), '删除后源码里仍能找到新 pattern');
    // 反向对照: 旧 pattern 必须还在，否则"消失"可能是整个 deps 核对被删了
    assertTrue(/runtime\\s\+dependenc/.test(stripped) || /runtime\s+dependenc/.test(stripped),
      '反向对照失败: 旧 pattern 也不在了');
  });

  // ── ④ 披露: 两种形态互不重叠 ──────────────────────────────
  test('披露: 表格形态与头条散文互不重叠(旧 pattern 管不到表格行)', () => withDocLock(() => {
    const readme = readDocFile('README.md');
    TABLE_RE.lastIndex = 0;
    const tableHits = readme.match(TABLE_RE) || [];
    HEADLINE_RE.lastIndex = 0;
    const headlineHits = readme.match(HEADLINE_RE) || [];
    assertTrue(tableHits.length >= 1, 'README 里应至少有一行表格形态');
    assertTrue(headlineHits.length >= 1, 'README 里应至少有一条头条散文形态');
    for (const t of tableHits) {
      HEADLINE_RE.lastIndex = 0;
      assertTrue(!HEADLINE_RE.test(t),
        '旧 pattern 竟能匹配表格行「' + t + '」—— 那它就不曾是盲区，本用例前提不成立');
    }
    for (const h of headlineHits) {
      TABLE_RE.lastIndex = 0;
      assertTrue(!TABLE_RE.test(h), '新 pattern 竟能匹配头条「' + h + '」—— 会双重计数');
    }
  }));
};
