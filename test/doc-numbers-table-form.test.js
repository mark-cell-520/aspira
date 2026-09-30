/**
 * test/doc-numbers-table-form.test.js — 文档诚实数字的"表格形态"盲区回归
 *
 * 背景(本会话 doc-honest-numbers 周期的实测发现):
 *
 * `scripts/audit-doc-numbers.js` 长期报"20 项声称全部一致、0 不一致"，
 * 而同一时间 SKILL.md 的 `## Verified metrics` 表里躺着三处腐烂:
 *
 *     | Discrimination dimensions | 51 |   实测 54
 *     | MCP tools | 180 |                 实测 181
 *     | Test suite | 740 passing |        实测 852
 *
 * README.md 的同款表同样写着 51 / 180。章节标题里还有一处:
 * `### Agent-facing checks (separate from the 51 text dimensions)`。
 * 表格下方的分层散文也是旧的: `**5 can block**`(实测 9)、
 * `**7 can force a rewrite**`(实测 8)、`**24 request verify**`(实测 26)。
 *
 * 根因是审计的提取正则**全是"数字在前"的散文形态**:
 *
 *     /(\d+)\s+discrimination dimensions/g      ← "54 discrimination dimensions"
 *     /(\d+)\s+MCP tools/g                      ← "181 MCP tools"
 *
 * 而表格是 `| 指标 | 值 | 实测方法 |`，数字在标签**之后**，于是一整张表不可见。
 * SKILL.md 没有 changelog 表(整篇都是当前声称)，所以这些数字本应被检查。
 *
 * 另一个独立缺口: 测试条数此前**根本未被审计**，而
 * `test/doc-numbers.test.js` 里那个 `ASPIRA_MEASURED_TESTS` 环境变量
 * **从未被任何地方设置过**——它静默退化成"只断言是正数"，
 * 等于那条校验从来没生效。本测试补齐两处。
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');
  const { readDoc } = require('./_doc-probe-lock.js'); // [周期21] 读者也要持锁读探针目标文档
  const ROOT = path.join(__dirname, '..');

  const read = (f) => readDoc(path.join(ROOT, f));
  const idx = require(path.join(ROOT, 'src', 'index.js'));
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');

  // 与 audit-doc-numbers.js 的 measure() 同源取实测值
  const measuredDims = Object.keys(idx.discriminate('这是一个用于实测的句子。', []).dimensions).length;
  // 工具数必须取 TOOLS.length —— 首版用正则数 mcp-server.js 里的 name: 'aspira_*'
  // 得到 0(该文件的工具定义不是这种形态)，于是把正确的文档报成"实测 0"。
  const { TOOLS } = require(path.join(ROOT, 'src', 'mcp-server.js'));
  const measuredTools = Array.isArray(TOOLS) ? TOOLS.length : 0;

  // ── 1. 审计脚本必须认识表格形态 ────────────────────
  test('审计脚本必须能提取表格形态的数字声称', () => {
    // 这一条锁的是"盲区本身"。若有人精简掉这些正则，本测试立刻失败，
    // 而不是等到下一次 SKILL.md 腐烂时才由人发现。
    const code = read('scripts/audit-doc-numbers.js')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    // 用子串判断而非再写一层正则——首版把 /(?<![a-zA-Z])/ 这类反向断言按
    // 普通字符串转义, 检查规则自己写错了, 把已修好的审计报成缺少覆盖。
    const mustHave = [
      '|\\s*Discrimination dimensions\\s*\\|\\s*(\\d+)',
      '|\\s*MCP tools\\s*\\|\\s*(\\d+)',
      '|\\s*Test suite\\s*\\|\\s*([\\d,]+)\\s+passing',
      'separate from the (\\d+) text dimensions',
      '|\\s*Dispatch routes\\s*\\|\\s*([\\d,]+)',
    ];
    for (const frag of mustHave) {
      assertTrue(code.includes(frag), `audit-doc-numbers.js 缺少表格形态正则: ${frag}`);
    }
  });

  // ── 2. 三份文档的表格值必须等于实测 ────────────────
  test('README 与 SKILL.md 的指标表必须与实测一致', () => {
    for (const f of ['README.md', 'SKILL.md']) {
      const s = read(f);
      const d = /\|\s*Discrimination dimensions\s*\|\s*(\d+)\s*\|/.exec(s);
      assertTrue(!!d, `${f} 应有 Discrimination dimensions 表行`);
      assertEqual(Number(d[1]), measuredDims,
        `${f} 表格声称 dimensions=${d[1]}，实测 ${measuredDims}`);

      const t = /\|\s*MCP tools\s*\|\s*(\d+)\s*\|/.exec(s);
      assertTrue(!!t, `${f} 应有 MCP tools 表行`);
      assertEqual(Number(t[1]), measuredTools,
        `${f} 表格声称 tools=${t[1]}，实测 ${measuredTools}`);
    }
  });

  test('SKILL.md 的 Test suite 表行必须存在具体数字', () => {
    const s = read('SKILL.md');
    const m = /\|\s*Test suite\s*\|\s*(\d+)\s+passing/.exec(s);
    assertTrue(!!m, 'SKILL.md 的 Test suite 行应形如 "| Test suite | N passing / 0 failing |"');
    assertTrue(Number(m[1]) > 0, 'SKILL.md 的测试通过数应为正数');
  });

  test('SKILL.md 章节标题里的维度数必须与实测一致', () => {
    // "separate from the 51 text dimensions" — 又一处数字在后的腐烂。
    const s = read('SKILL.md');
    const m = /separate from the (\d+) text dimensions/.exec(s);
    if (m) {
      assertEqual(Number(m[1]), measuredDims,
        `SKILL.md 章节标题声称 ${m[1]} text dimensions，实测 ${measuredDims}`);
    }
  });

  // ── 3. 分层散文数字必须与代码集合一致 ──────────────
  test('SKILL.md 的分层散文计数必须与代码集合一致', () => {
    const grab = (name) => {
      const mm = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(src);
      return mm ? mm[1].split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean) : [];
    };
    const codeCounts = {
      block: grab('BLOCK_DIMS').length,
      rewrite: grab('REWRITE_DIMS').length,
      verify: grab('VERIFY_DIMS').length,
    };
    const s = read('SKILL.md');
    // 文档声称的是"能触发该动作的维度"总数; tone_policing/sealioning 不在
    // VERIFY_DIMS 却能经 findings.length > 1 触发 verify, 故文档的 verify
    // 计数 = VERIFY_DIMS + 2。这里只锁 block/rewrite 的严格相等,
    // verify 锁"文档值 >= 代码值"(兜底路径只会让它更多, 不会更少)。
    const b = /\*\*(\d+) can `block`\*\*/.exec(s);
    assertTrue(!!b, 'SKILL.md 应有 "**N can `block`**"');
    assertEqual(Number(b[1]), codeCounts.block,
      `SKILL.md 声称 ${b && b[1]} can block，代码 BLOCK_DIMS=${codeCounts.block}`);

    const r = /\*\*(\d+) can force\s*a `rewrite`\*\*/.exec(s);
    assertTrue(!!r, 'SKILL.md 应有 "**N can force a `rewrite`**"');
    assertEqual(Number(r[1]), codeCounts.rewrite,
      `SKILL.md 声称 ${r && r[1]} can rewrite，代码 REWRITE_DIMS=${codeCounts.rewrite}`);

    const v = /\*\*(\d+) request `verify`\*\*/.exec(s);
    assertTrue(!!v, 'SKILL.md 应有 "**N request `verify`**"');
    assertTrue(Number(v[1]) >= codeCounts.verify,
      `SKILL.md 声称 ${v && v[1]} request verify，少于代码 VERIFY_DIMS=${codeCounts.verify}`);
  });

  // ── 4. 测试条数: 审计必须真的去测，而不是留个死环境变量 ──
  test('audit-doc-numbers.js 必须实测测试条数', () => {
    // 此前的实现是把 ASPIRA_MEASURED_TESTS 交给调用方注入, 而没有任何地方
    // 注入过它——测试条数这一项从来没被校验过。现在改为审计自己跑 run-all。
    const code = read('scripts/audit-doc-numbers.js')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assertTrue(/run-all\.js/.test(code), 'audit-doc-numbers.js 应运行 test/run-all.js 实测测试条数');
    // 必须取最后一条汇总, 不是第一条逐文件行(首版 bug: 拿到某个文件的 10 通过)
    assertTrue(/all\[all\.length\s*-\s*1\]|all\.at\(-1\)/.test(code),
      'audit-doc-numbers.js 应取最后一条"测试结果"汇总行');
  });

  test('ASPIRA_MEASURED_TESTS 死环境变量缺口已被记录在案', () => {
    // 不是断言它被设置(本测试不该反向依赖一个运行时状态), 而是断言源码里
    // 留有说明, 避免后人以为那个分支是活的。
    const t = read('test/doc-numbers.test.js');
    assertTrue(/ASPIRA_MEASURED_TESTS/.test(t),
      'test/doc-numbers.test.js 应保留 ASPIRA_MEASURED_TESTS 的读取与说明');
  });
};
