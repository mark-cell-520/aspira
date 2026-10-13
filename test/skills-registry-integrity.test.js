/**
 * test/skills-registry-integrity.test.js — skills/ 注册表与路由表的一致性
 *
 * ═══ 由来 ═══
 * 这一轮审计 skills/ 时发现的问题，没有一个会被现有测试发现：
 *   test/ 下没有任何文件加载 skills/ 目录，也没有任何文件核对 ROUTES 与磁盘。
 * 于是下面每一处都可以无限期存在而不被打红。
 *
 * ═══ 实测到的缺陷（全部已修，本测试锁住）═══
 * 1. skills/index.js 用 `/^description:\s*\|?-?\s*(.+)$/m` 扫前置元数据。
 *    skills/ 里 description 普遍是 YAML 块标量：
 *      - `description: >` / `>-` → `\|` 匹配不到 `>`，`(.+)` 把块指示符本身
 *        当成描述，listSkills() 返回 ">" / ">-"。7 个技能中招。
 *      - `description: |` / `|-` → `\s*` 跨过换行只取到块内首行，丢掉其余内容。
 *        5 个技能中招（"成功"但是错的，比失败更难发现）。
 * 2. 更隐蔽的一处：`.` 不匹配 `\r`。skills/bug-fixing/SKILL.md 是 CRLF 行尾，
 *    逐行正则 `^key:\s*(.*)$` 会在 `\r` 前停下，而无 m 标志的 `$` 只认字符串
 *    真正结尾 —— 整行匹配失败。于是 bug-fixing 的 name 和 description 对
 *    整个注册表**隐身**，listSkills() 只能回落到目录名。
 *    （一个文件因为行尾风格不同就从列表里消失，且没有任何报错。）
 * 3. 4 个技能的 frontmatter name 与目录名不一致：
 *    bug-fixing→bug-fixing-openclaw、clean-code-review→clean-code、
 *    code-fix→code-error-fixer、cody→code-review-assistant。
 *    Claude Code 按目录名注册技能，name 对不上即不可调用。
 * 4. skills/debug-pro/SKILL.md 完全没有 frontmatter，name/description 皆无。
 * 5. skills/dispatch.js 的 ROUTES 有 25 条，19 条指向不存在的技能
 *    （heartflow-self-upgrade、heartflow-truthfulness、heartflow-knowledge-base…），
 *    而磁盘上 33 个技能里 26 个从未出现在任何路由上 —— 包括 bug-fixing、
 *    security-audit、log-analyzer、simplify。pickRoute() 在候选全不存在时
 *    返回 candidates[0]，输出 matched:false + 一个死名字：用户看到的是
 *    "新愿说没有这个技能"，而不是"路由表本身是坏的"。
 * 6. `__list__`（列出全部技能）被排在它前面的死路由抢先：
 *    `node skills/dispatch.js help upgrade` 返回 matched:false 而不是列表。
 *
 * ═══ 关于文档探针锁：初版判断错了一次，已改 ═══
 * 本测试是纯读者，读的是 skills/ 下的 SKILL.md。初版据此判断"探针不写
 *   skills/，加锁是净增风险"，文件头写明不持锁 —— 依据是实测：test/ 下四个
 *   提到 skills/ 的测试（agent-boundary-guard / audit-self-pollution /
 *   audit-gate-scope / security-audit）没有一个往 skills/ 写过东西，探针只改
 *   根目录的 README.md / SKILL.md / IDENTITY.md / CURRENT_STATE.md。
 *
 * 跑 run-all 后 doc-reader-lock-coverage.test.js 打红，理由正是本文件：
 * "每个读探针目标文档的测试文件都必须持锁读"。它的判据按字符串匹配
 * `'SKILL.md'` —— 本文件读的是 skills/ 下的 SKILL.md，不在探针目标里，属误伤。
 *
 * 但改法是持锁，不是绕判据：那条锁自己写明"静态检查会漏，改个变量名就绕过"，
 * 而绕过它恰是它要防的那类动作。读者持锁的代价是等一个探针的 ~0.65s，离等待
 * 上限极远；第一百零九轮"锁里多占 3 秒、失败数从 1 涨到 3"说的是**写者**持锁
 * 变长，不是读者。故整件测试包进 withDocLock，只获取一次。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const { withDocLock } = require('./_doc-probe-lock.js');

/** 技能目录里被 SKILL.md 引用、且必须真实存在的本地资源前缀 */
const LOCAL_PREFIXES = ['scripts/', 'references/', 'templates/', 'assets/'];

module.exports = function ({ test, assertEqual, assertTrue }) {
  return withDocLock(() => {

  /** 磁盘上真实存在的技能目录（有 SKILL.md 的） */
  function diskSkills() {
    return fs.readdirSync(SKILLS_DIR)
      .filter(d => fs.existsSync(path.join(SKILLS_DIR, d, 'SKILL.md')))
      .sort();
  }

  test('每个技能都有可解析的 frontmatter（name + description 均非空）', () => {
    const { listSkills } = require(path.join(SKILLS_DIR, 'index.js'));
    const skills = listSkills();
    const broken = [];
    for (const s of skills) {
      if (!s.hasFrontmatter) broken.push(s.name + '（无 frontmatter）');
      else if (!s.description) broken.push(s.name + '（description 为空）');
    }
    assertEqual(broken.length, 0,
      '以下技能的 frontmatter 不可用: ' + broken.join('、'));
  });

  test('frontmatter 的 name 必须等于目录名（否则 Claude Code 注册不到）', () => {
    const { listSkills } = require(path.join(SKILLS_DIR, 'index.js'));
    const byPath = new Map(listSkills().map(s => [path.basename(s.path), s]));
    const mismatch = [];
    for (const dir of diskSkills()) {
      const s = byPath.get(dir);
      if (!s) { mismatch.push(dir + '（未出现在 listSkills）'); continue; }
      if (s.name !== dir) mismatch.push(`${dir} → name 写着 "${s.name}"`);
    }
    assertEqual(mismatch.length, 0,
      'name 与目录名不一致: ' + mismatch.join('、'));
  });

  test('块标量 description 必须取到正文，不能取到 ">" 或只有首行', () => {
    const { parseFrontmatter } = require(path.join(SKILLS_DIR, 'index.js'));
    // 三种写法各测一次：折叠保序、折叠指示符、CRLF
    const cases = [
      ['literal', '---\nname: a\ndescription: |\n  第一行。\n  第二行。\n---\n正文', '第一行。\n第二行。'],
      ['folded', '---\nname: a\ndescription: >\n  第一行。\n  第二行。\n---\n正文', '第一行。 第二行。'],
      ['strip',   '---\nname: a\ndescription: >-\n  只有一行。\n---\n正文', '只有一行。'],
      ['crlf',    '---\r\nname: a\r\ndescription: |\r\n  第一行。\r\n  第二行。\r\n---\r\n正文', '第一行。\n第二行。'],
    ];
    for (const [label, content, expect] of cases) {
      const fm = parseFrontmatter(content);
      assertEqual(fm.name, 'a', `${label}: name 应解析出来`);
      assertEqual(fm.description, expect,
        `${label}: description 解析错 —— 拿到 ${JSON.stringify(fm.description)}`);
    }
    // 反向证明：旧的逐行正则在这些输入上确实失败
    const oldRe = /^description:\s*\|?-?\s*(.+)$/m;
    assertTrue(oldRe.test('---\nname: a\ndescription: >\n  x\n---\n'),
      '反向证明：旧正则匹配 description: > 时会返回块指示符本身');
    assertEqual((oldRe.exec('---\nname: a\ndescription: >\n  x\n---\n') || [])[1], '>',
      '反向证明：旧正则在 description: > 上取到的是 ">"，不是正文');
  });

  test('CRLF 行尾的 SKILL.md 也必须能解析（bug-fixing 曾是 CRLF）', () => {
    const { parseFrontmatter } = require(path.join(SKILLS_DIR, 'index.js'));
    const p = path.join(SKILLS_DIR, 'bug-fixing', 'SKILL.md');
    const raw = fs.readFileSync(p, 'utf8');
    const fm = parseFrontmatter(raw);
    assertEqual(fm.name, 'bug-fixing', 'CRLF 文件的 name 必须解析出来');
    assertTrue(fm.description.length > 40,
      `CRLF 文件的 description 必须取到正文（当前 ${fm.description.length} 字符）`);
    // 不变量：解析结果不得残留 \r（残留说明行尾没归一化）
    assertTrue(!/\r/.test(fm.name) && !/\r/.test(fm.description),
      '解析结果不得残留 \\r');
  });

  test('dispatch 的 ROUTES 与 DEFAULTS 不得指向不存在的技能', () => {
    const { verifyRoutes } = require(path.join(SKILLS_DIR, 'dispatch.js'));
    const v = verifyRoutes();
    assertEqual(v.dead.length, 0,
      '路由表里指向不存在技能的死路由: ' + v.dead.join('、'));
  });

  test('磁盘上每个技能都至少被一条路由覆盖', () => {
    const { ROUTES } = require(path.join(SKILLS_DIR, 'dispatch.js'));
    const routed = new Set(ROUTES.filter(r => r.skill !== '__list__').map(r => r.skill));
    const missing = diskSkills().filter(d => !routed.has(d));
    assertEqual(missing.length, 0,
      '从未被路由的技能: ' + missing.join('、'));
  });

  test('"列出全部技能" 意图不得被其它意图的死路由抢先', () => {
    const { pickRoute } = require(path.join(SKILLS_DIR, 'dispatch.js'));
    for (const q of ['help', 'help upgrade', '审计 列表', '有什么技能', 'list']) {
      const r = pickRoute(q);
      assertEqual(r && r.skill, '__list__',
        `"${q}" 应命中 __list__，实际命中 ${r ? r.skill : 'null'}`);
    }
    // 反向证明：不含 list 意图时不该命中 __list__
    const r2 = pickRoute('upgrade');
    assertTrue(r2 && r2.skill !== '__list__',
      '纯升级意图不应命中 __list__');
  });

  test('无匹配意图时必须诚实返回 null，不能返回死技能名', () => {
    const { pickRoute } = require(path.join(SKILLS_DIR, 'dispatch.js'));
    assertEqual(pickRoute('zzz完全不相关的词'), null,
      '无匹配时应返回 null，由 main() 报 matched:false');
  });

  test('SKILL.md 正文引用的本地资源必须存在，或被显式标注为不存在', () => {
    // 一条引用可以是活的（文件在），也可以是历史提及（文件已删除/从未落盘）。
    // 两者都允许，但不允许第三种：**不说明状态就指向一个不存在的文件** ——
    // 那会让照着技能执行的人静默失败。所以判据是"存在"或"同一行显式说不存在"。
    const GONE_MARKERS = [
      '已删除', '已不存在', '均已不存在', '未落盘', '从未落盘', '未随附',
      '已不在仓库', '现已删除', '不再作为', '仅作历史记录', '此处为历史记录',
    ];
    const dangling = [];
    for (const dir of diskSkills()) {
      const md = fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
      // 只扫正文：围栏代码块里是命令（rm scripts/xxx.js），不是资源指针。
      const prose = md.replace(/```[\s\S]*?```/g, '');
      const seen = new Map(); // rel -> 首次出现的行
      for (const m of prose.matchAll(/`((?:scripts|references|templates|assets)\/[^`]+)`/g)) {
        if (!seen.has(m[1])) seen.set(m[1], m[0]);
      }
      for (const m of prose.matchAll(/\]\(((?:scripts|references|templates|assets)\/[^)#]+)\)/g)) {
        if (!seen.has(m[1])) seen.set(m[1], m[0]);
      }
      for (const [rel] of seen) {
        if (fs.existsSync(path.join(SKILLS_DIR, dir, rel))) continue;
        // 取该引用所在的整行，看有没有"不存在"的显式标注
        const line = prose.split('\n').find(l => l.includes(rel)) || '';
        const marked = GONE_MARKERS.some(k => line.includes(k));
        if (!marked) dangling.push(`${dir}: ${rel}`);
      }
    }
    assertEqual(dangling.length, 0,
      '以下本地引用既不存在、也未标注不存在:\n  ' + dangling.join('\n  '));
  });

  test('index.js 的 listSkills 覆盖磁盘上全部技能目录', () => {
    const { listSkills } = require(path.join(SKILLS_DIR, 'index.js'));
    const listed = new Set(listSkills().map(s => path.basename(s.path)));
    const missing = diskSkills().filter(d => !listed.has(d));
    assertEqual(missing.length, 0, 'listSkills 漏掉: ' + missing.join('、'));
  });

  test('heartflow-architecture-tracing 的阶段表必须与 pipeline-config.js 一致', () => {
    // 实测到的缺陷：该技能通篇写"7 阶段声明式 Pipeline"并只给一张 7 行表，
    // 而 src/workflow/pipeline-config.js 里 DEFAULT_PIPELINE 是 12 阶段、
    // FAST_PIPELINE 是 7 阶段（v1.2.0 起的双过程模式）。7 阶段那张表被当成了
    // 整条管道，DEFAULT 独有的 5 个深层认知阶段全部缺失。
    const cfg = fs.readFileSync(path.join(ROOT, 'src', 'workflow', 'pipeline-config.js'), 'utf8');
    function stageIds(name) {
      const i = cfg.indexOf('const ' + name + ' = [');
      const seg = cfg.slice(i, cfg.indexOf('\n];', i));
      return [...seg.matchAll(/id:\s*'([A-Za-z]+)'/g)].map(m => m[1]);
    }
    const full = stageIds('DEFAULT_PIPELINE');
    const fast = stageIds('FAST_PIPELINE');
    assertEqual(full.length, 12, `DEFAULT_PIPELINE 实测 ${full.length} 阶段，期望 12`);
    assertEqual(fast.length, 7, `FAST_PIPELINE 实测 ${fast.length} 阶段，期望 7`);
    assertTrue(fast.every(s => full.includes(s)),
      'FAST_PIPELINE 必须是 DEFAULT_PIPELINE 的子集');

    const md = fs.readFileSync(path.join(SKILLS_DIR, 'heartflow-architecture-tracing', 'SKILL.md'), 'utf8');
    // 文档必须两个数都写，且必须说明它们是双过程而不是一个数
    assertTrue(/12\s*阶段/.test(md), '必须写明 DEFAULT_PIPELINE 是 12 阶段');
    assertTrue(/7\s*阶段/.test(md), '必须写明 FAST_PIPELINE 是 7 阶段');
    assertTrue(/双过程|Dual-Process/.test(md),
      '必须说明两个阶段数来自双过程模式，否则读者会以为其中一个写错了');
    // DEFAULT 独有的 5 个阶段必须出现在文档里
    const only = full.filter(s => !fast.includes(s));
    const absent = only.filter(s => !md.includes(s));
    assertEqual(absent.length, 0,
      'DEFAULT 独有阶段未写进文档: ' + absent.join('、'));
  });

  test('技能文档声称的版本同步目标必须与 sync-version.js 一致', () => {
    // 实测到的矛盾：三个技能对"版本号要同步几个文件、同步哪几个"给出三套答案 ——
    //   heartflow-audit-upgrade-push: VERSION + SKILL.md frontmatter + SKILL.md title
    //     + package.json（四处，漏了 src/core/version.js 与 agent-card.json）
    //   heartflow-bulk-upgrade: VERSION → package.json → SKILL.md → README.md
    //     → CHANGELOG.md（五处，多出两个不是目标的）
    //   heartflow-debug-workflow: VERSION + package.json + README.md（三处）
    // 权威是 scripts/sync-version.js：README 动态读取、CHANGELOG 是历史，都不是目标。
    const syncSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'sync-version.js'), 'utf8');
    assertTrue(!/README/.test(syncSrc.replace(/\/\/[^\n]*/g, '')),
      'sync-version.js 不应把 README 当同步目标（前提变了则本测试要改）');
    assertTrue(!/CHANGELOG/.test(syncSrc.replace(/\/\/[^\n]*/g, '')),
      'sync-version.js 不应把 CHANGELOG 当同步目标（前提变了则本测试要改）');

    // 任何技能文档都不得把 README.md / CHANGELOG.md 说成版本同步目标
    const offenders = [];
    for (const dir of diskSkills()) {
      const md = fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
      const prose = md.replace(/```[\s\S]*?```/g, '');
      for (const line of prose.split('\n')) {
        if (!/版本/.test(line)) continue;
        if (!/同步|统一/.test(line)) continue;
        // 该行若是在"更正/口径"语境下提到 README/CHANGELOG，是说明它们不是目标，放过
        if (/不是同步目标|不在同步目标|动态读取|是历史/.test(line)) continue;
        if (/README\.md|CHANGELOG\.md/.test(line)) {
          offenders.push(`${dir}: ${line.trim().slice(0, 70)}`);
        }
      }
    }
    assertEqual(offenders.length, 0,
      '以下行把 README/CHANGELOG 说成了版本同步目标:\n  ' + offenders.join('\n  '));
  });

  }); // withDocLock
};
