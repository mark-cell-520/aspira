/**
 * scripts/audit-doc-numbers.js — 文档诚实数字审计
 *
 * 原则(AGENTS.md #5 Honest numbers)：文档必须说明代码实际做什么；
 * 任何被声称的指标必须可测量。不可证伪的数字比没有数字更糟。
 *
 * 本脚本把 README.md / SKILL.md / AGENTS.md 里声称的每个数字都与代码实测比对。
 * 只报"可测量"的那些——不可测量的说法(如"zero LLM dependency")单独列为待人工确认。
 *
 * 用法: node scripts/audit-doc-numbers.js [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
// [审计盲区修复] 原 DOCS 是**硬编码的三份** ['README.md','SKILL.md','AGENTS.md']，
// 于是其余 18 份 markdown 的数字声称完全不受审计——包括 CONTRIBUTING.md
// (“The 45 discrimination dimensions”，实测 54)与 CURRENT_STATE.md
// (“128 modules / 119 tests”，实测 132)。两份都是**现在时陈述**，
// 却因不在扫描列表里而长期无人发现。这正是“仪器看不见的风险等于不存在”。
//
// 改为扫描全部 markdown，仅显式豁免“整份文件用途就是记录历史”的文档，
// 且每条豁免都写理由(避免把豁免当成藏污之处)。
const HISTORICAL_DOCS = {
  'CHANGELOG.md': '逐版本历史记录，数字是当时快照',
  'CHAT_LOG_HeartFlow_完整备份_2026-05-16.md': '旧项目完整备份档案',
  'AUDIT-v6.0.0.md': 'v6.0.0 时点的代码审计快照',
  'AUDIT_REPORT.md': '安全审计报告(时点)',
  'aspira-audit-report.md': '仓库审计报告(时点)',
  'ARCHITECTURE_REORG_v6.0.6.md': 'v6.0.6 时点的重组分析',
  'FAILURE_REPORT.md': '升级历程回顾',
};
// (旧的只扫根目录的 DOCS 已由下方 walkMd + DOCS_RECURSIVE 取代，见「审计盲区修复·第二轮」)

// ── [审计盲区修复·第二轮] 子目录的 368 份 markdown 此前**完全不在扫描范围** ──
// 第一轮修的是"硬编码三份 → 扫全部根目录 md"，但 `fs.readdirSync(ROOT)` 只列根目录，
// 不递归。实测后果:
//   根目录 md 21 份(纳入 14)  → 193 条数字型声称
//   子目录 md 368 份           → 1894 条数字型声称
//   真实覆盖率 **9.2%**，而覆盖面自报的 22.3% 分母只数了根目录——**自报本身也偏乐观**。
// 这与已记录的"仪器看不见的风险等于不存在"是同一条: 子目录里过时的数字没人看得见。
//
// 但不是一律纳入。子目录大量文件按用途就是**时点快照**:
//   docs/benchmark-report-v4.md     标着 v5.5 的版本化基准报告
//   docs/AUDIT-heartflow-2026-09-17.md  带日期的审计快照
//   report/CODE-REVIEW-2026-07-05.md    带日期的代码评审
// 这些数字是"当时如此"，拿现在去核对就是制造假警报(与根目录豁免同判据)。
//
// 判据(每条豁免都写理由，避免豁免变成藏污之处):
//   ① 目录整份豁免: report/(全部是时点报告)、docs/(版本化基准/带日期审计)
//   ② 文件名带日期或版本号: *-YYYY-MM-DD.md / *-vN.N.N.md / *vN.md
//   ③ plans/ 是规划文档: 里面的"当前 25 个工具"是规划起点，不是当前声称
//   ④ references/ 保留: 它们是规则/方法论文档，含当前性陈述
//   ⑤ skills/ 下的 SKILL.md 保留: 技能说明描述当前能力
//   ⑥ data/ 整份豁免: **运行时数据，不是文档**
//      实测(第十轮): data/ 下有 **682 份 CORE_VALUES.md 的逐字节相同副本**，
//      全在 `_tc_<ts>_<rand>/` 与 `_cache_probe_<ts>/` 目录里——是测试泄漏的
//      缓存/探针产物，不是人写的文档。三项实测后果:
//        (a) 自报「已扫文档 904 份」把 682 份副本算成 682 份文档，
//            真实不同文档只有 **222 份**——自报虚高 4 倍。这与第 56 轮记录的
//            「22.3% 的分母只数根目录、自报偏乐观」是同一族，只是方向相反:
//            那次是分母太小，这次是分母里塞了不是分母的东西。
//        (b) NUMISH 粗计 28,592 条里 **6,192 条(21.7%)** 来自这 682 份副本，
//            覆盖率的分子分母同时被同一份 332 字节文件污染。
//        (c) 每次审计白读 682 个相同文件。
//      豁免它们不损失任何声称: 实测 CORE_VALUES.md 仅 332 字节、9 个数字
//      全是列表序号、**含规模词的数字行 0 条**、审计输出中出现 0 次。
//      ⚠️ 更重要的是锁: `test/_doc-probe-lock.js` 只串行化**改写文档再 spawn
//      审计**的测试，它不覆盖 data/。一旦某个探针往 data/ 写一份改过的副本，
//      审计会在无锁的情况下读到它。现在 682 份全同只是**运气，不是锁**。
const EXEMPT_DIRS = {
  'report': '全部为时点报告(CODE-REVIEW-2026-07-05 等)',
  'docs': '版本化基准报告与带日期审计快照(benchmark-report-v4/v5, AUDIT-*-日期)',
  'plans': '升级规划文档，其中的数字是规划起点而非当前声称',
  // [第十九轮] 理由里原本硬编码「682 份」。实测已是 1072 份，且这个数随测试
  // 运行增长(一次会话内先后测得 1063/1066/1072)，所以硬编码份数**不可能保持不变地对**。
  // 改为只陈述可核对的**性质**，份数与内容种数由下方「豁免理由实测」每次测量后报出。
  'data': '运行时数据而非文档: _tc_ 与 _cache_probe_ 前缀的探针泄漏副本，内容逐字节相同(份数与内容种数见「豁免理由实测」)',
};
const EXEMPT_NAME_RE = /(?:-\d{4}-\d{2}-\d{2})|(?:-v?\d+(?:\.\d+)*)\.md$/;
// [第十轮] walkMd 过程中发现的泄漏产物目录(名字带引号/控制字符)
const ARTIFACT_DIRS = [];

function walkMd(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'archive') continue;
    // ── [第十轮] 跳过**泄漏产物目录** ──
    // 实测仓库根目录有一个字面名为 `"` 的目录，里面套着一整棵
    // `/var/folders/.../T/aspira-mx-D4BRqZ"`(带引号的绝对路径)，
    // 含 CORE_VALUES.md / .opencode/memory/heartflow_state.json /
    // data/agent-card.json ——是一份完整的运行时缓存树。
    //
    // 由来(已记录于 memory/autonomous-upgrades/upgrade-1790600413501.json):
    // resolveHFDir() 曾原样返回 process.env.HEARTFLOW_DIR 且零校验，
    // 于是带引号的值被 path.join 拼进去，静默建出整棵带引号的目录树。
    // **入口已修**(两处副本都加了 sanitizeHFDir)，
    // .gitignore 也有 `*aspira-mx-*`，但这棵已泄漏的树从未清理。
    //
    // 判据: 目录名含引号/反引号/NUL/控制字符 → 泄漏产物标记。
    // 合法文档目录不会在名字里放引号。这一条与 data/ 豁免不同:
    // data/ 是"内容不是文档"，这里是"这个目录本不该存在"。
    if (/["'`]|[\x00-\x1f]/.test(e.name)) {
      ARTIFACT_DIRS.push(path.relative(ROOT, path.join(dir, e.name)) + '  # 名字含引号/控制字符(运行时泄漏产物)');
      continue;
    }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkMd(p, out);
    } else if (e.name.endsWith('.md')) {
      out.push(path.relative(ROOT, p));
    }
  }
  return out;
}

const ALL_MD = walkMd(ROOT, []);
// 根目录文件: 沿用 HISTORICAL_DOCS 逐份豁免(已有)
// 子目录文件: 目录豁免 + 命名模式豁免
const SUBDIR_EXEMPT = [];
const DOCS_RECURSIVE = ALL_MD.filter(rel => {
  const parts = rel.split(path.sep);
  if (parts.length === 1) {
    return !Object.prototype.hasOwnProperty.call(HISTORICAL_DOCS, parts[0]);
  }
  const top = parts[0];
  if (Object.prototype.hasOwnProperty.call(EXEMPT_DIRS, top)) {
    SUBDIR_EXEMPT.push(rel + '  # ' + EXEMPT_DIRS[top]);
    return false;
  }
  if (EXEMPT_NAME_RE.test(parts[parts.length - 1])) {
    SUBDIR_EXEMPT.push(rel + '  # 文件名带日期或版本号(时点快照)');
    return false;
  }
  return true;
});

// [第十九轮] 文档内容**快照**。
// 主流程是: const m = measure()(第938行，内部 spawn run-all.js 跑完整个测试套件)
//           → const cl = claims()(第939行，此刻才 readDoc 读文档)。
// 而测试套件里有一批探针测试会**改写 SKILL.md / README.md / CURRENT_STATE.md**
// 再 spawn 本脚本(注入 v9.9.9、139 个模块等，用完恢复)。第964-965行的注释早已承认
// 这个耦合，却只用来解释 execSync 抛异常的问题，从没问过: **探针没把文档放回去时会怎样**。
// 实测抓到: 探针在"已注入、未恢复"之间被杀(SIGTERM/SIGKILL/异常)时，污染会留在磁盘上，
// 于是 claims() 读到被污染的文档，产出 7 条假警报，全部指责 SKILL.md/README.md
// "声称 9.9.9 / 139"——**仪器分不清"文档错了"和"改写文档的探针没放回去"**，
// 把一次探针泄漏报成了文档缺陷，方向完全指错。
// 修法: 在 spawn 之前把文档内容读进内存，claims() 只读快照。探针此后怎么折腾都影响不了审计。
const DOC_SNAPSHOT = new Map();
for (const f of DOCS_RECURSIVE) DOC_SNAPSHOT.set(f, readDocRaw(f));

function readDocRaw(f) { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } }

function readDoc(f) {
  if (DOC_SNAPSHOT.has(f)) return DOC_SNAPSHOT.get(f);
  return readDocRaw(f);
}

// 剥掉 README 的 changelog 表。原因: 表里逐周期记录"当时的数字"(如
// "Modules 132, dispatch routes 1,510 ... 757 tests")，那是历史快照而非当前声称。
// 不剥掉就会把历史记录当成当前声明来核对——修好 routes 实测后，
// "132, dispatch routes" 会变成一条假警报。审计的语义是"现在声称什么"。
function currentClaimsOnly(text) {
  // changelog 表以 "| Version | Date | Change |" 表头开始
  const idx = text.indexOf('| Version | Date | Change |');
  return idx >= 0 ? text.slice(0, idx) : text;
}

// ── 实测 ──────────────────────────────────────────────
function measure() {
  const m = {};

  // 维度数：discriminate() 返回的 dimensions 键数
  const idx = require(path.join(ROOT, 'src', 'index.js'));
  const r = idx.discriminate('这是一个用于实测的句子。', []);
  m.dimensions = Object.keys(r.dimensions || {}).length;

  // ── [第十二轮] 公式库条数 ──
  // 反向问"可审形态里有没有没产出声称的规模数"(周期 8 的重跑:
  // 文件集已缩 4 倍、又新增 6 个键)。623 条未认领形态逐条过完，
  // 规模级里唯一真正的漏网就是公式库:
  //   INSTALL.md      公式库(2397个)
  //   CURRENT_STATE   公式库 | 1286 formulas
  //   formulas/README 未拆分前的完整382条公式文件
  // 三个文档三个数字，**而 formulas 此前在审计里出现 0 次**。
  // 实测: FormulaModule 默认加载 formulas/formulas.json(见
  // src/formula/formula-module.js:13 的 formulasFile 默认值)，共 **608 条**。
  // 于是 2397 夸大约 4 倍、1286 夸大约 2 倍、382 是"拆分前"的旧值
  // (拆分后这个文件又长回去了: physics 12→95、mathematics 84→126)。
  // ⚠️ 不核对 formulas-core.json(284) 与 formulas-archive.json(98):
  // 那两条是**分文件**计数且经实测均为真，与总量不是同一个量。
  try {
    const fPath = path.join(ROOT, 'formulas', 'formulas.json');
    const fj = JSON.parse(fs.readFileSync(fPath, 'utf8'));
    m.formulas = Array.isArray(fj) ? fj.length : ((fj.formulas || fj.items || []).length);
  } catch (_) { m.formulas = null; }

  // 模块数 / 路由数 / initErrors
  // 模块表在 heartflow._modules，但必须走 start() 才注册——构造后直接数是 0，
  // 会把手正确的文档报成「声称132实测0」。审计自己的测量方式错了。
  try {
    const hf = require(path.join(ROOT, 'src', 'core', 'heartflow.js'));
    const inst = new hf.Aspira({ rootPath: ROOT, silent: true });
    if (typeof inst.start === 'function') inst.start();
    m.modules = Object.keys(inst._modules || {}).length;
    m.initErrors = inst.initErrors != null ? inst.initErrors : null;
    try {
      const rt = typeof inst.routes === 'function' ? inst.routes() : null;
      // routes() 返回 {模块名: [路由...]}。文档说的"dispatch routes"是**展开后**的
      // 条目数(1510)，不是模块级键数(132)。首版数键数，于是把正确的 1,510 报成
      // 无法实测——测量口径与文档口径不一致，又是审计自己的错。
      if (rt && typeof rt === 'object') {
        let total = 0;
        for (const k of Object.keys(rt)) {
          const v = rt[k];
          if (Array.isArray(v)) total += v.length;
          else if (v && typeof v === 'object') total += Object.keys(v).length;
          else total += 1;
        }
        m.routes = total;
        m.routesTopLevel = Object.keys(rt).length;
      } else { m.routes = null; }
    } catch (_) { m.routes = null; }
  } catch (_) { m.modules = null; m.initErrors = null; m.routes = null; }

  // MCP 工具数
  try {
    const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));
    m.tools = TOOLS.length;
  } catch (_) { m.tools = null; }

  // 测试文件数 / 用例数由调用方测(需要跑 run-all，慢)

  // 分层计数：按 gate 动作归类维度(读 AGENTS.md 的三张表并核对)
  const doc = readDoc('AGENTS.md');
  const grab = (label) => {
    const re = new RegExp(`\\*\\*${label}[^*]*\\*\\*:?\\s*([^\\n]+)`);
    const mm = re.exec(doc);
    return mm ? mm[1].trim() : null;
  };
  const blockList = grab('Block-level');
  const rewriteList = grab('Rewrite-level');
  const verifyList = grab('Verify-level');
  const scoredList = /Dimensions that are scored but do not force a gate action:\s*([\s\S]*?)\n\n/.exec(doc);
  m.tiers = {
    block: blockList ? blockList.split(',').filter(Boolean).length : null,
    rewrite: rewriteList ? rewriteList.split(',').filter(Boolean).length : null,
    verify: verifyList ? verifyList.split(',').filter(Boolean).length : null,
    scored: scoredList ? scoredList[1].split(/[,\n]/).map(s => s.trim()).filter(Boolean).length : null,
  };

  // 包声明的最低 Node 版本
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    m.nodeReq = (pkg.engines && pkg.engines.node) || null;
  } catch (_) { m.nodeReq = null; }

  // ── [第七轮] 能力域数实测: 数 README 能力域表格的行数 ──
  // 这是**文档内部的自洽性检验**(标题 vs 表格)，不是文档 vs 代码——
  // 引擎没有 "domain" 一等概念，132 个模块在注册表里是平铺的，
  // 域只是 README 的分类视角。
  // 若不测: 标题 "7 domains" 与表格行数可以各自漂移而无人发现，
  // 因为 "domains" 这个 key 此前不在审计的任何模式里。
   try {
     const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
     const sec = readme.match(/###\s*Capability domains[^\n]*\n([\s\S]*?)(?=\n---|\n##\s)/);
     if (sec) {
       // 表格行: 以 | 开头、不是分隔行、不是表头
       const rows = sec[1].split('\n').filter(l =>
         /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l));
       // 第一行是表头
       m.domains = Math.max(0, rows.length - 1);
       m.domainsTitle = (sec[0].match(/\((\d+)\s+domains?/) || [])[1] || null;
     }
   } catch (_) { m.domains = null; }
  // ── [第八轮] 语料规模实测: FP 率与召回率的分母 ──
  // 用**穷举法**而非人工提问找到的盲区: 把 pats 的 key 集与文档实际
  // 出现的"数字+单位词"形态机械化比对，`benign` / `malicious` 双双落空。
  // 文档三处声称 "106 benign / 41 malicious samples"，
  // 而 **0.9% FP 和 100% recall 都以它为分母**。
  // 分母错了两个百分比同时失真，且没有任何仪器会报错——
  // 这正是本切片的核心形状: 一个未被测量的数字，
  // 在全绿报表里与被锁住的数字无法区分。
  //
  // 实测方式: 解析 calibrate-fp-recall.js 的数组字面量条数。
  // **不 require 它** —— 该脚本顶层会跑完整校准并写 data/feedback 文件。
  // 与另一条教训同构: 量一个东西之前先看它有什么副作用。
  try {
    const calib = fs.readFileSync(path.join(ROOT, 'scripts', 'calibrate-fp-recall.js'), 'utf8');
    const countArr = (name) => {
      const start = calib.indexOf('const ' + name + ' = [');
      if (start < 0) return null;
      const end = calib.indexOf('\n];', start);
      if (end < 0) return null;
      const body = calib.slice(start, end);
      // 条目: 独立成行的字符串字面量
      const items = body.match(/^\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,?\s*$/gm) || [];
      return items.length;
    };
    m.corpusBenign = countArr('BENIGN');
    m.corpusMalicious = countArr('MALICIOUS');
  } catch (_) { m.corpusBenign = null; m.corpusMalicious = null; }


  // [审计盲区修复·第四轮] 「0 runtime dependencies」必须被实测，不能只当口号
  // 实测发现: package.json 曾把 mathjs / @xenova/transformers / js-yaml / pm2
  // 挂在 **dependencies** 里，而 README、AGENTS.md、SKILL.md 三处都写
  // "0 runtime dependencies / instant install"。**声明与事实直接矛盾**，
  // 而审计从不核对依赖数——它只查 engines.node。
  //
  // 运行时语义上"零依赖"是**真的**: node_modules 不存在时引擎仍启动
  // 132 个模块、initErrors 为 undefined、think() 完整工作(那四个 require
  // 都在 try/catch 或惰性 getter 里，缺失即降级)。所以修法不是改文档迁就
  // 声明，而是**把声明改成与事实一致**: 四个包移入 optionalDependencies。
  //
  // 现在这个数字变成每次运行都实测的指标:
  //   depsDeclared       = dependencies 键数(必须为 0)
  //   depsOptional       = optionalDependencies 键数(可 >0，缺失即降级)
  //   depsActuallyRequired = src/ 里**不在 try/catch 内**的外部 require 数(必须为 0)
  try {
    const pkg2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    m.depsDeclared = Object.keys(pkg2.dependencies || {}).length;
    m.depsOptional = Object.keys(pkg2.optionalDependencies || {}).length;
    m.depsOptionalNames = Object.keys(pkg2.optionalDependencies || {});
  } catch (_) { m.depsDeclared = null; m.depsOptional = null; }

  // src/ 里不在 try/catch 内的外部 require —— 这些才是真·运行时硬依赖。
  // 判据: 收集 src/ 全部外部 require，再检查每次出现的位置之前
  // 是否有未闭合的 try {
  try {
    const BUILTIN = new Set(require('module').builtinModules);
    const srcFiles = [];
    (function walk(d) {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) srcFiles.push(p);
      }
    })(path.join(ROOT, 'src'));
    const hard = new Set();
    const soft = new Set();
    // 剥离注释后再扫: 首版没剥，把文档块里的
    // "require('@yun520-1/heartflow')" 当成真依赖报出来 —— 第 28 次仪器失效。
    // 一个写在注释里的示例 require 不是依赖，正如一个写在散文里的旧数字不是声称。
    const stripComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // 行注释(不动 http:// 里的 //)
    for (const f of srcFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const mm of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const r = mm[1];
        if (r.startsWith('.') || r.startsWith('/')) continue;
        const parts = r.split('/');
        const name = r.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        if (BUILTIN.has(name) || BUILTIN.has(name.replace(/^node:/, ''))) continue;
        const before = src.slice(0, mm.index);
        const opens = (before.match(/\btry\s*\{/g) || []).length;
        const closes = (before.match(/\}\s*catch\b/g) || []).length;
        if (opens > closes) soft.add(name); else hard.add(name);
      }
    }
    m.depsActuallyRequired = hard.size;
    m.depsHardNames = [...hard];
    m.depsSoftNames = [...soft];
  } catch (_) { m.depsActuallyRequired = null; }

  // ── [审计盲区修复·第六轮] "Node.js >= 18.17" 与 "instant install"
  //    此前只被**读**，从未被**验证** ──
  // 审计此前核对 engines.node 的方式是: 把 package.json 里写的字符串
  // 抄进 actual.nodeReq，再拿文档里的声称去比它。**声明与声称一致，
  // 不等于代码真的能跑在 18.17 上** —— 这是同一类盲区:
  // 上一轮发现"0 runtime dependencies"被三份文档重复却无仪器验证，
  // 这一轮发现"Node >= 18.17"同样只有声明、没有运行时证据。
  //
  // 实测(本轮，剥注释后扫 src/ 374 个文件):
  //   optional chaining ×122 / nullish coalescing ×43(均需 14.0，在范围内)
  //   global fetch ×2(需 18.0，在范围内)
  //   private class field ×1(需 12.0，在范围内)
  //   **越界特性 0 个** → 声明诚实
  // 同时实测 "instant install": require(package.main) 后**立即**
  // 调一次 checkOutput()，返回 {gate:{action:'pass'}} —— 装完即可用。
  //
  // 现在这两个数字都变成每次运行都实测的常驻指标:
  //   nodeFeaturesOverMin = src/ 中高于 engines.node 下限的特性数(必须为 0)
  //   instantInstallWorks = main 入口能否 require 后立即调通(必须为 true)
  try {
    const stripComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const FEATURES = [
      [/\?\./, '14.0', 'optional chaining'],
      [/\?\?/, '14.0', 'nullish coalescing'],
      [/\?\?=/, '15.0', 'nullish assignment'],
      [/\|\|=/, '15.0', 'or assignment'],
      [/&&=/, '15.0', 'and assignment'],
      [/static\s*\{/, '16.11', 'class static block'],
      [/#\w+\s*[=;(]/, '12.0', 'private class field'],
      [/\bObject\.hasOwn\s*\(/, '16.9', 'Object.hasOwn'],
      [/\.findLast\s*\(|\.findLastIndex\s*\(/, '18.0', 'Array.prototype.findLast'],
      [/\bstructuredClone\s*\(/, '17.0', 'structuredClone'],
      [/\bglobalThis\b/, '12.0', 'globalThis'],
      [/\bfetch\s*\(/, '18.0', 'global fetch'],
      [/\bFinalizationRegistry\b/, '18.0', 'FinalizationRegistry'],
      [/\bWeakRef\b/, '14.6', 'WeakRef'],
      [/\bArray\.fromAsync\b/, '22.0', 'Array.fromAsync'],
      [/\bObject\.groupBy\b/, '21.0', 'Object.groupBy'],
      [/\bMap\.groupBy\b/, '21.0', 'Map.groupBy'],
      [/\bPromise\.withResolvers\b/, '22.0', 'Promise.withResolvers'],
      [/\bRegExp\.escape\b/, '24.0', 'RegExp.escape'],
      [/\bprocess\.getBuiltinModule\b/, '22.3', 'process.getBuiltinModule'],
      [/\bnavigator\s*\.\s*hardwareConcurrency/, '21.0', 'navigator.hardwareConcurrency'],
    ];
    const cmpVer = (v, ref) => {
      const a = String(v).replace(/^v/, '').split('.').map(Number);
      const b = String(ref).split('.').map(Number);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0, y = b[i] || 0;
        if (x !== y) return x > y ? 1 : -1;
      }
      return 0;
    };
    const minNode = (() => {
      const mm = String(m.nodeReq || '').match(/(\d+)\.(\d+)/);
      return mm ? mm[1] + '.' + mm[2] : '18.17';
    })();
    const over = new Map();
    let scanned = 0;
    (function walk(d) {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'archive') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          scanned++;
          const code = stripComments(fs.readFileSync(p, 'utf8'));
          for (const [re, need, label] of FEATURES) {
            if (re.test(code) && cmpVer(need, minNode) > 0) {
              if (!over.has(label)) over.set(label, { label, needs: need });
            }
          }
        }
      }
    })(path.join(ROOT, 'src'));
    m.nodeFeaturesOverMin = over.size;
    m.nodeFeatureOverList = [...over.values()];
    m.nodeScannedFiles = scanned;
    m.nodeMinChecked = minNode;
  } catch (_) { m.nodeFeaturesOverMin = null; }

  // "instant install": require main 后立即调一次
  try {
    const pkgMain = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).main || 'index.js';
    const mainPath = path.join(ROOT, pkgMain);
    delete require.cache[require.resolve(mainPath)];
    const main = require(mainPath);
    const r = (typeof main.checkOutput === 'function') ? main.checkOutput('安装后立即可用性实测') : null;
    m.instantInstallWorks = !!(r && r.gate && typeof r.gate.action === 'string');
    m.instantInstallAction = r && r.gate && r.gate.action;
    m.instantInstallMain = pkgMain;
  } catch (_) { m.instantInstallWorks = false; }

  // VERSION
  try {
    m.version = require(path.join(ROOT, 'src', 'core', 'version.js')).VERSION || null;
  } catch (_) { m.version = null; }

  return m;
}

// ── 文档声称 ──────────────────────────────────────────
// [审计盲区修复·第二轮] 引擎自我指称判据。
// 扩到子目录后，"规模声称"的误匹配暴增: 通用规范、案例描述、升级示例里的
// 数字都被当成 aspira 的引擎规模来核对。判据: 只有当同一行或紧邻上下文
// 出现引擎自身指称时，这条规模声称才是在说 aspira。
//
// ── [第九轮] selfRef 的**作用域**从一开始就划错了 ──
// 反向穷举(第三角度): 不问「文档有哪些数字没审」，而问
//   **「审计自己的哪条规则永远不可能放行?」**
// 拿 README 首页摘要行做探针，实测:
//   "0 runtime dependencies"        key=deps   ❌ 被 selfRef 排除
//   "1216 passing tests"(散文形态)  key=tests  ❌ 被 selfRef 排除
// 而同一行在表格里的 "| Test suite | 1216 passing" 却 ✓ 纳入核对。
//
// 原因: selfRef 只看数字**之前**的文本里有没有
// aspira/新愿/heartflow/引擎/本仓库/判别/discriminator 等词。
// README 首页那行上下文是:
//   "54 discrimination dimensions × 17-layer pipeline* × 132 modules
//    × 181 MCP tools × 1,510 dispatch routes × "
// —— 一个自指词都没有(它当然没有: **README 就是引擎在描述自己**，
// 不需要在自己家里喊自己的名字)。
//
// 于是**全仓库最显眼的那行声称，七个数字全部不受审计**，
// 包括「零运行时依赖」这条头条设计原则。
//
// 这与第 29 次失效同族，但更严重: 那次是一条模式被吃掉，
// 这次是**一整类文档(引擎自述)被系统性排除**。
// 报 53/53 全绿只说明「它知道的那 53 条没错」。
//
// 修法不是删掉 selfRef(那会把子目录的假阳性放回来)，
// 而是**把它的作用域收窄到它本来要解决的问题**:
// selfRef 是为**子目录**文档加的——通用规范、案例描述、
// 升级示例里的数字不是引擎规模。顶层自述文档
// (README/SKILL/AGENTS/IDENTITY/CURRENT_STATE)的存在目的
// 就是描述本引擎，其中的规模声称**按构造**就是在说 aspira。
//
// 用模块级标志而非改 reject 签名: 32 条模式的 reject 都是
// (t,a)=>... 的内联箭头，改签名要动 32 处，而漏掉任何一处
// 都会让那条模式悄悄退回旧行为。
let SELF_DESCRIPTION_DOC = false;
const SELF_DESC_DOCS = new Set([
  'README.md', 'SKILL.md', 'AGENTS.md', 'IDENTITY.md', 'CURRENT_STATE.md',
]);
// ── [第八轮] ENGINE_SELF 过严会**漏报**，比假阳性更危险 ──
// 第 29 次仪器失效: 新加 benign/malicious 语料模式后，
// 往 AGENTS.md 注入一条 "999 benign"(实测 106)，审计**毫无反应**。
// 逐层查下去: selfRef 对所有 benign 命中都返回
// 'no-engine-self-reference' —— 因为它只看数字**之前**的文本里
// 有没有 aspira/新愿/heartflow/引擎/本仓库/判别/discriminator。
// 而那句是 "measures it on a hand-written labelled corpus of **999 benign"
// —— 主语是 "it"(指 aspira)，字面上一个自指词都没有。
// 于是 reject 返回真值，这条错声称被**静默跳过**。
//
// 这与假阳性是相反的失败: 假阳性把对的报成错的(吵闹但可见)，
// **漏报把错的静默吞掉(安静且不可见)**。而整个审计的价值就在于
// 不错过——一个会把错声称吞掉的闸门，比没有闸门更糟。
//
// 修法: 语料规模是**引擎自评指标**，它的上下文天然带这些词。
// 把它们纳入自指判据，同时保留原有的显式自指词。
const ENGINE_SELF = /aspira|新愿|heartflow|引擎|本仓库|判别|discriminator|false-positive|\brecall\b|corpus|calibrat|labelled|labeled|samples/i;
function selfRef(text, at) {
  // ── [第九轮] 引擎自述文档: 其中的规模声称按构造就是在说 aspira ──
  // README 首页那行 "54 dimensions × 132 modules × 181 MCP tools ×
  // 1,510 dispatch routes × 1216 passing tests × 0 runtime dependencies"
  // 上下文里一个自指词都没有——因为它不需要有:
  // **README 就是引擎在描述自己，不必在自己家里喊自己的名字。**
  // 若在此处仍要求显式自指词，全仓库最显眼的一行声称
  // (含「零运行时依赖」这条头条设计原则)将整体不受审计。
  if (SELF_DESCRIPTION_DOC) return null;
  const lineStart = text.lastIndexOf('\n', at) + 1;
  if (ENGINE_SELF.test(text.slice(lineStart, at))) return null;
  if (ENGINE_SELF.test(text.slice(Math.max(0, at - 60), at))) return null;
  return 'no-engine-self-reference';
}
// 区间排除: "6-10 个维度" 表达范围而非规模, 核对它只会制造假警报。
function notRange(text, at) {
  if (/[-–—~至]\s*$/.test(text.slice(Math.max(0, at - 4), at))) return 'range';
  if (/^\s*[-–—~至]/.test(text.slice(at, at + 4))) return 'range';
  return null;
}
// ── [第九轮] 作用域计数排除: 数字被前置词限定为局部量时不是引擎清单规模 ──
// 放宽 selfRef 作用域(让它别吃掉引擎自述文档的首页摘要行)之后，
// **立刻**冒出三类假阳性，逐条看上下文发现它们同根:
//   "Never `require` a Tier-2 module at the top of `heartflow.js`"  → 序数
//   "At low effort only tier 1 modules run"                        → 序数
//   "11 refs across 8 modules"                                    → 子集计数
// 共同点: 数字前面紧邻一个**作用域词**，它把「引擎总共有多少」
// 改写成了「这一局部有多少」。而真正的总清单规模
// (README 首页的 "× 132 modules")前面是 × 或行首，没有作用域词。
//
// 这与 selfRef 是**两层不同的过滤器**, 不是它的替代:
//   selfRef   回答「这条声称在说 aspira 吗」
//   notScoped 回答「它在说 aspira 的**总量**吗」
// 第二问在自述文档里恰恰最常被问倒——因为自述文档里
// 充斥着"这 2 个模块""那 8 个模块"的局部讨论。
const SCOPED_BEFORE = /(?:tier|across|only|each|within|between|per|several|some)\s*[-–—:]?\s*$/i;
function notScoped(text, at) {
  const before = text.slice(Math.max(0, at - 24), at);
  if (SCOPED_BEFORE.test(before)) return 'scoped-count';
  if (/[A-Za-z][-–]\s*$/.test(before)) return 'hyphenated-ordinal';
  return null;
}
// 叙事引用排除: 文档在**讲述自己改过什么**时会引用旧的错误值
// (如 'A fifth "115 modules" ... was removed')。那是被引用的历史值，
// 不是当前声称。判据: 数字前有引号，或该行带"已删/曾是/removed/was"等叙事标记。
// ── [第八轮] NARRATIVE 漏了"增量/增长"类叙事 ──
// 放宽 ENGINE_SELF 后，两条历史语料规模被报成不符:
//   "The corpus grew by 16 benign ... and 7 malicious ..."
//   "folded 53 additional benign samples to recover 1 malicious one"
// 它们讲的是**语料曾经如何长大**，不是当前规模。
// 原 NARRATIVE 只有 removed/was written/was/曾是/已删/此前/原先/曾经/写的是，
// 漏掉 grew / additional / to recover / from ... to ... 这一类。
// 首版试图用"加更多动词"解决，但那是在枚举——
// **一个靠枚举动词的过滤器，每遇到一种新叙述就漏一次。**
// 改为同时认两种结构: ①增量词(grew/added/additional/plus)
//                      ②"from X to Y"式的变化叙述
// ── [第九轮] 再补一类: "Measured on N ..." 是**过去的实测值** ──
// 放宽 selfRef 作用域后，AGENTS.md 里
//   'Measured on 102 benign / 41 malicious: `discriminate` read ...'
// (讲述上轮仪器缺陷时的旧读数)被当成当前语料规模报了出来。
// 它是历史测量而非当前声称，与 grew/additional 同族。
// ⚠️ 这仍是枚举: 每出现一种新的"讲过去"的叙述就要补一个词。
//    残余风险已记录，未假装修好。
// [第九轮追加] `were\s`: SKILL.md 写 "165 passing tests **were** silently
// never counted"(描述旧 runner 漏数的那次缺陷)。过去时复数与 `was\s` 同族，
// 少它一条历史叙事就会被当成当前规模报出来。
const NARRATIVE = /removed|was written|was\s|were\s|曾是|已删|此前|原先|曾经|写的是|grew|grow|added|additional|to recover|from\s+\d[\d,]*\s+to\s+\d|expanded|reverted|tried and|measured on|measured at/i;
  // ── [第九轮] 行内代码跨度内的数字是**被引用的字面量** ──
  // 为什么需要这条: AGENTS.md 讲述本轮修复时写道
  //   "the docs write `1216 passing tests` while every pattern
  //    expected `tests passing`"
  //   "(`| Test suite | 1216 passing`) was audited"
  // 那是**对修复前状态的引用**，不是当前声称——但它的形状与
  // 当前声称完全一致，于是被报成"不符"。
  //
  // 这与围栏不同: ```围栏``` 里的 README 首页摘要行**是**当前声称
  // (它是引擎给自己开的规格单)，围栏不因此被排除；
  // 而**行内**反引号是"这是一个字面量"的标记，语义相反。
  //
  // ⚠️ 必须**跨行**计数: 该引用在源码里被折行，
  //   "...× 1216 passing tests × 0 runtime dependencies`"
  // 开引号在上一行，按行数反引号会数成 0 个(偶数)而漏掉。
  // 因而改为数**数字之前**的全部反引号，并先剥掉围栏定界行——
  // 否则围栏里的 ``` 会让其后所有文本的奇偶性翻转。
  // (只剥定界行，不剥围栏内容: 围栏里的当前声称必须继续受审。)
  function inCodeSpan(text, at) {
    const before = text.slice(0, at).replace(/^```.*$/gm, '');
    return (before.match(/`/g) || []).length % 2 === 1;
  }
  function narrativeQuote(text, at) {
  const lineStart = text.lastIndexOf('\n', at) + 1;
  const line = text.slice(lineStart, at);
  if (/["'「」‘’]\s*\d*[\d,]*\s*$/.test(line)) return 'quoted-value';
  if (NARRATIVE.test(line)) return 'narrative';
  // ── [第九轮] 行内代码跨度内的数字是**被引用的字面量** ──
  // 判据: 该数字所在行、在它之前出现的反引号个数为**奇数**，
  // 说明这个数字落在一对反引号之内。
  // 为什么需要这条: AGENTS.md 讲述本轮修复时写道
  //   "the docs write `1216 passing tests` while every pattern
  //    expected `tests passing`"
  //   "(`| Test suite | 1216 passing`) was audited"
  // 那是**对修复前状态的引用**，不是当前声称——但它的形状与
  // 当前声称完全一致，于是被报成三条"不符"。
  //
  // 这与围栏不同: ```围栏``` 里的 README 首页摘要行**是**当前声称
  // (它是引擎给自己开的规格单)，围栏不因此被排除；
  // 而**行内**反引号是"这是一个字面量"的标记，语义相反。
  // 二者的区别正是本条只数行内反引号、不碰围栏的原因。
  if (inCodeSpan(text, at)) return 'code-span';
  // ── [第九轮] 叙事标记也可能在数字**之后** ──
  // 首版只查数字之前的文本，于是 SKILL.md 的
  //   "165 passing tests **were** silently never counted"
  // (描述旧 runner 漏数那次缺陷)漏网: 过去时动词在数字后面。
  // 判据扩展到同一行的剩余部分——但只认**过去时/叙事词**，
  // 不认任意词汇，否则 "1216 passing / 0 failing" 这类
  // 当前声称会被误伤。
  const lineEnd = text.indexOf('\n', at);
  const after = lineEnd < 0 ? text.slice(at) : text.slice(at, lineEnd);
  if (NARRATIVE.test(after)) return 'narrative-after';
  return null;
}

function claims() {
  const out = [];
  for (const f of DOCS_RECURSIVE) {
    // [第九轮] 标记当前文档是否为引擎自述文档，供 selfRef 判断作用域。
    // 只对**顶层**文件生效: 子目录里若也有 README.md(如
    // skills/xxx/references/README.md)，那是该技能的说明，不是本引擎自述。
    SELF_DESCRIPTION_DOC = !f.includes(path.sep) && SELF_DESC_DOCS.has(f);
    const s = currentClaimsOnly(readDoc(f));
    if (!s) continue;
    const pats = [
      { re: /(\d+)\s+discrimination dimensions/g, key: 'dimensions', what: 'dimensions' },
      // ── [第四十一轮] 覆盖缺口 ──────────────────────────────────
      // coverage-sweep.js 周期37 修掉子串匹配后, 诚实缺口 103 → 134,
      // 但这个数字只活在脚本 stdout 里, 无任何声称站点, 于是不核对它。
      // 只加测量键(m.aliveUntested)是**不够的**: 实测突变 122 → 122X
      // 后 audit 仍 exit=0 —— 因为 reads 声称的是 claims() 里这份
      // 逐个文档硬编码的 re 列表, 没有对应 re 的数字照样没人读。
      // **一个写进文档却没有任何模式读它的数字, 与一个没人声称的数字
      // 在全绿报告里无法区分。** 这正是本脚本自己记录的失败形状。

      // [第四十四轮] 两个正则都不是"收紧", 而是**第一次真正匹配上**。
      // 原 re 要求 \*\*(\d+)\*\* (粗体只包数字), 而 README 的真实形态是
      // \*\*122 alive but referenced by no test\*\* —— 粗体包整句。
      // srcModules 则死在换行: 原文 "coverage-sweep.js across 383\\nmodules"。
      // 两处的后果是同一个: 声称从未进过 claims 列表, 于是周期41 与 43
      // 的突变验证 122 → 122X 都"通过" —— 不是因为锁住了, 而是因为没有锁。
      // 而周期43 我把声称总数 88 → 66 解释成"SKILL.md 伪声称已消除",
      // 真实原因是我自己的声称掉出了名单。**一个从不匹配的 re 与一个
      // 收紧的 re 在数字上看起来一样, 含义相反。**
      { re: /\*\*(\d+) alive but referenced by no test\*\*/g, key: 'aliveUntested', what: 'alive but untested src modules' },
      // 收紧过的 re: 原为 /across (\d+)\s*\n?modules/, 它在 SKILL.md
      // "globalThis (11 refs across 8 modules → …)" 上匹配到 **8**，
      // 于是 "coverage-sweep 的模块数" 这个键被读进了 8 —— 一个数字
      // 落进了完全不属于它的标签, 而它偏偏还显示为"一致"。
      // **读到 ≠ 核对, 读到错目标比读不到更危险**。现在要求前缀是
      // "coverage-sweep.js across", 只匹配 README 那一句。
      { re: /coverage-sweep\.js across (\d+)\s+modules/g, key: 'srcModules', what: 'src modules counted by coverage-sweep' },
      { re: /(\d+)\s+modules\s*[×,.]/g, key: 'modules', what: 'modules' },
      // ── [审计盲区修复·第七轮] "N domains" 从未被任何模式覆盖 ──
      // 连续第七轮 doc-honest-numbers，上轮结论是「六个角度已推进完毕、
      // 接近枯竭」。枯竭检验的方式是问: 45/45 全绿，**绿的里面有没有
      // 形式上是绿的、实际上根本没被检验的?**
      // 把 pats 的 key 列出来只有 8 类:
      //   dimensions / modules / tools / routes / layers
      //   / tier_block / tier_rewrite / tier_verify / tests
      //   / nodeReq / deps
      // 而 README 的能力域小节标题写的是
      //   `### Capability domains (7 domains, 132 modules)`
      // —— **"domains" 这个 key 不在审计的任何模式里。**
      // 实测(本轮): 标题写 7，紧随的表格也正好 7 行，所以数字为真;
      // 但它是**碰巧为真**: 将来加一个能力域、改了表格却忘了改标题，
      // 没有任何仪器会报警，因为审计从不看这个数。
      // 这正是本切片反复出现的形状——
      // **一个从未被测量过的数字，在全绿的报表里与已被测量的数字
      //   无法区分。**
      { re: /(\d+)\s+domains?/g, key: 'domains', what: 'capability domains' },
      // ── [第八轮·穷举法] 语料规模是 FP 率与召回率的分母 ──
      // 机械化穷举(而非人工提问)发现的盲区: pats 的 key 集 vs 文档
      // 实际出现的"数字+单位词"形态，`benign` / `malicious` 双双落空。
      // 文档三处写 "106 benign / 41 malicious samples"，
      // 而 **0.9% FP 和 100% recall 都以它为分母**。
      // 分母错了两个百分比同时失真，而没有任何仪器会报错。
      // 这正是本切片的核心形状: 一个未被测量的数字，
      // 在全绿报表里与被锁住的数字无法区分。
      { re: /(\d+)\s+benign/g, key: 'corpusBenign', what: 'benign corpus size',
        reject: (t, a) => selfRef(t, a) || narrativeQuote(t, a) },
      { re: /(\d+)\s+malicious/g, key: 'corpusMalicious', what: 'malicious corpus size',
        reject: (t, a) => selfRef(t, a) || narrativeQuote(t, a) },
      { re: /(\d+)\s+MCP tools/g, key: 'tools', what: 'MCP tools' },
      // 千分位逗号必须一起吃下: "1,510 dispatch routes" 否则只捕到 510，
      // 于是把正确的文档报成不符——审计自己的正则 bug。
      { re: /(\d[\d,]*)\s+dispatch\s+routes/g, key: 'routes', what: 'dispatch routes' },
      { re: /(\d+)-layer pipeline/g, key: 'layers', what: 'pipeline layers' },
      { re: /Block-level\s*\((\d+)\)/g, key: 'tier_block', what: 'Block-level count' },
      { re: /Rewrite-level\s*\((\d+)\)/g, key: 'tier_rewrite', what: 'Rewrite-level count' },
      { re: /Verify-level\s*\((\d+)\)/g, key: 'tier_verify', what: 'Verify-level count' },
      // Node.js 要求带 >= 前缀，声称值要连前缀一起取，否则 "18.17" vs ">=18.17"
      // 会被判成不符——又一个正则 bug 产出假发现。
      // [审计盲区修复·第二轮] skills/project-code-standard/SKILL.md 的
      // "Node.js >= 16" 是**通用 JS 项目规范**(该文件面向任意项目)，
      // 不是 aspira 自身要求。同一判据: 只有引擎自我指称在场才算 aspira 的要求。
      { re: /Node\.js\s*(>=\s*\d+(?:\.\d+)*)/g, key: 'nodeReq', what: 'Node.js requirement',
        reject: selfRef },
      // ── 表格形态(数字在标签之后) ──
      // [审计盲区修复] 以上全部是"数字在前"的散文形态。SKILL.md 的
      // "## Verified metrics" 是一张 `| 指标 | 值 | 实测方法 |` 表，数字在标签**之后**，
      // 于是整张表的腐烂完全不可见: 实测 dimensions=54 而表里写 51、
      // tools=181 而表里写 180、测试数 852 而表里写 740——审计却报 20/20 全一致。
      // 章节标题里的数字同样漏网: "separate from the 51 text dimensions"。
      // 这些不是历史记录(SKILL.md 没有 changelog 表，整篇都是当前声称)。
      { re: /\|\s*Discrimination dimensions\s*\|\s*(\d+)\s*\|/g, key: 'dimensions', what: 'dimensions (表格)' },
      { re: /\|\s*Modules registered\s*\|\s*(\d+)\s*\|/g, key: 'modules', what: 'modules (表格)' },
      { re: /\|\s*MCP tools\s*\|\s*(\d+)\s*\|/g, key: 'tools', what: 'MCP tools (表格)' },
      { re: /\|\s*Dispatch routes\s*\|\s*([\d,]+)\s*\|/g, key: 'routes', what: 'dispatch routes (表格)' },
      { re: /\|\s*Test suite\s*\|\s*([\d,]+)\s+passing/g, key: 'tests', what: 'test suite (表格)' },
      // [审计盲区修复] CURRENT_STATE.md 的形态是散文 "N tests passed / 0 failed"，
      // 既不是表格也不是 "Test suite | ... "，于是该文件的测试数声称长期不受审计。
      // 注意源码里必须是字面量 `\s+`(反杠+s): 有测试按字面量搜索这一行，
      // 写成真实正则语义的 \s 会让那条测试永远找不到本行。
      { re: /(\d[\d,]*)\s+tests?\s+passed/g, key: 'tests', what: 'tests passed (散文)' },
      // ── [审计盲区] 中文形态的数字声称 ──
      // 以上模式**全是英文形状**，而本仓库文档以中文为主。于是所有中文数字声称
      // 对审计完全不可见: "132 个模块" / "54 个维度" / "181 个 MCP 工具"。
      // 一条都测不到。这不是"数字都对"，是**测不到**——与已记载的盲点同根:
      // 仪器看不见的风险等于不存在。实测: 补了中文模式后立刻抓到一个真错
      // (IDENTITY.md 写"129 个模块真实加载"，实测 132)。
      //
      // ⚠️ 中文模式更易出假阳性(提案/回顾文档用现在时陈述历史前提，
      // 如 AGI_VISION.md 的"当前 mcp-server.js 暴露 25 个工具"实为重构提案的
      // 前提)。故只匹配描述引擎当前规模的固定搭配，且用 reject 排除
      // 序数("第 N 个模块")与括号内("阶段 (N个模块)")——两者都不是引擎总规模。
      //
      // [审计盲区修复·第二轮] 扩到子目录后，中文模式立刻产出 21 条"不符"，
      // 逐条核对后**绝大多数是正则误匹配，不是文档缺陷**:
      //   · heartflow-debug-workflow: "其他 55 个模块在注册表中但不在管道中"
      //     —— 陈述的是**管道覆盖面**，不是"引擎共 55 个模块"
      //   · heartflow-emotion-analysis: "本案触发的 6-10 个维度"
      //     —— 案例描述
      //   · heartflow-module-upgrader: "6 个模块"出现在升级示例里
      //     —— 示例数字
      //   · project-code-standard: "Node.js >= 16" 是**通用 JS 项目规范**，
      //     不是 aspira 自身要求(该文件面向任意项目)
      // 这正是"仪器把自己的局限报成引擎缺陷"(第 25 次)。
      //
      // 修法: **共现词门槛**——只有当同一行(或紧邻上下文)出现
      // 引擎自身指称(见上方 selfRef)时，才认为这条"规模声称"是在说 aspira。
      // 这比"关键词全局出现"严格得多，也不会漏掉真正的规模陈述。
      //
      // [仪器修正] 区间数字也必须排除: "本案触发的 6-10 个维度表格" 被正则
      // 捕成 dimensions=10 而实测 54，报成"不符"。区间表达的是**范围**，
      // 不是规模声称，核对它毫无意义还会制造假警报。
      { re: /(\d[\d,]*)\s*个\s*(?:discrimination\s*)?维度/g, key: 'dimensions', what: 'dimensions (中文)',
        reject: (t, a) => selfRef(t, a) || notRange(t, a) || narrativeQuote(t, a) },
      { re: /(\d[\d,]*)\s*个模块/g, key: 'modules', what: 'modules (中文)',
        reject: (text, at) => {
          const before = text.slice(Math.max(0, at - 8), at);
          if (/第\s*$/.test(before)) return 'ordinal';
          const seg = text.slice(Math.max(0, at - 40), at);
          const opens = (seg.match(/[(（]/g) || []).length;
          const closes = (seg.match(/[)）]/g) || []).length;
          if (opens > closes) return 'parenthesized';
          return selfRef(text, at) || notRange(text, at) || narrativeQuote(text, at);
        } },
      { re: /(\d[\d,]*)\s*个\s*MCP\s*工具/g, key: 'tools', what: 'MCP tools (中文)' },
      { re: /(\d[\d,]*)\s*条\s*dispatch\s*routes?/gi, key: 'routes', what: 'dispatch routes (中文)' },
      { re: /(\d[\d,]*)\s*层\s*pipeline/gi, key: 'layers', what: 'pipeline layers (中文)' },
      { re: /(\d[\d,]*)\s*个测试(?:\s*全部通过|\s*通过)?/g, key: 'tests', what: 'tests (中文)' },
      { re: /separate from the (\d+) text dimensions/g, key: 'dimensions', what: 'dimensions (章节标题)' },
      // 分层散文形态: "**9 can `block`**" 等(数字在形容词前，与 Block-level(N) 不同形)
      { re: /\*\*(\d+) can `block`\*\*/g, key: 'tier_block', what: 'Block-level count (散文)' },
      { re: /\*\*(\d+) can force\s*a `rewrite`\*\*/g, key: 'tier_rewrite', what: 'Rewrite-level count (散文)' },
      { re: /\*\*(\d+) request `verify`\*\*/g, key: 'tier_verify', what: 'Verify-level count (散文)' },
      // [审计盲区修复·第四轮] "0 runtime dependencies" 此前无人核对。
      // 实测 package.json 曾声明 4 个 dependencies, 与三份文档直接矛盾。
      { re: /(\d+)\s+runtime\s+dependenc/g, key: 'deps', what: 'runtime dependencies',
        reject: (t, a) => selfRef(t, a) || narrativeQuote(t, a) },
      // ── [审计盲区修复·第三轮] 模式本身的同义词盲区 ──
      // 上一轮把扫描范围从根目录扩到全仓(14 → 298 份)，但**模式只有 25 条、
      // 且全是固定搭配**。用注入法实测盲区: 往 README.md 追加 5 种写法各含
      // 一个错数字，审计 **5 个一个都没发现**，仍报 43/43 全绿:
      //   "ships with 139 modules in total"      → modules 盲区
      //   "exposes 184 MCP tool for agents"      → tools 盲区(单数)
      //   "有 63 个维度的判别能力"                → dimensions 盲区(缺"个")
      //   "1522 dispatch route entries"          → routes 盲区(单数)
      //   "1197 tests passing right now"         → tests 盲区
      // 与已记载的盲点同根: **仪器看不见的风险等于不存在**。
      // 报 43/43 全绿只说明"它知道的那 43 条没错"。
      //
      // 修法: 对英文指标加**复数容忍**(modules?/tools?/routes?/tests?/
      // dimensions?)并允许可选的连接词，对中文允许"维度"省略"个"。
      // 仍然带 selfRef/notRange 闸门——盲区补大不等于要把假阳性放进来。
      { re: /(\d[\d,]*)\s+(?:discrimination\s+)?dimensions?(?:\s+in total)?/g,
        key: 'dimensions', what: 'dimensions (英文复数容忍)',
        reject: (t, a) => selfRef(t, a) || narrativeQuote(t, a) },
      { re: /(\d[\d,]*)\s+modules?(?:\s+(?:in total|registered|loaded))?/g,
        key: 'modules', what: 'modules (英文复数容忍)',
        // [仪器修正] 排除引号内的历史引用: AGENTS.md 讲述上轮故事时写
        // 'A fifth "115 modules" I had just written myself was removed...' ——
        // 那是**被引用并已删除的错误值**，不是当前声称。
        // 判据: 数字前 12 字符内有引号，或该行含"removed/was written/曾是/已删"等叙事标记。
        reject: (t, a) => selfRef(t, a) || narrativeQuote(t, a) },
      { re: /(\d[\d,]*)\s+MCP\s+tools?(?:\s+for\s+agents)?/g,
        key: 'tools', what: 'MCP tools (英文复数容忍)',
        reject: (t, a) => selfRef(t, a) || narrativeQuote(t, a) },
      { re: /(\d[\d,]*)\s+dispatch\s+routes?(?:\s+entries)?/g,
        key: 'routes', what: 'dispatch routes (英文复数容忍)',
        reject: (t, a) => selfRef(t, a) || narrativeQuote(t, a) },
      { re: /(\d[\d,]*)\s+tests?\s+passing/g,
        key: 'tests', what: 'tests passing (英文复数容忍)',
        reject: (t, a) => selfRef(t, a) || narrativeQuote(t, a) },
      // ── [第九轮] 词序反转形态: "N passing tests" ──
      // 反向穷举(问「审计哪条规则永远不可能放行」)时，拿 README
      // 首页摘要行做探针，发现它**三重不可见**叠加:
      //   ① 整行在代码围栏里
      //   ② 形态是 "1216 passing tests"——形容词在前，与上面那条
      //      "tests passing" 词序相反，匹配不上任何模式
      //   ③ 即便匹配上，也会被 selfRef 吃掉(见 selfRef 的第九轮注释)
      // 前两轮修的是「没有这个 key」。本轮说明还有一种更隐蔽的形状:
      // **key 有、模式有、但词序不匹配**——看起来覆盖了，
      // 实际那一种写法永远扫不到。
      { re: /(\d[\d,]*)\s+passing\s+tests?/g,
        key: 'tests', what: 'passing tests (词序反转)',
        reject: (t, a) => selfRef(t, a) || narrativeQuote(t, a) },
      // ⚠️ **不加** "N 维度"(省略"个")的中文模式。实测过:
      // 该形态在全仓 298 份文档里产出 8 条"不符"，逐条核对**全是假阳性**:
      //   "self-audit.js(6维度审计引擎)"   —— 指那个模块自己有 6 个审计维度
      //   "56题 × 6维度" / "5维度核心能力专项测试" —— 测试集的维度数
      //   "7维度 × 3用例 = 21个"            —— 测试用例设计
      //   "4维度加权评分 (0-1)"             —— 代码注释里的算法
      //   "三个维度(认知负荷/能量水平/社会压力)" —— 稳态系统的维度
      // **"N 维度"在中文里是多义结构**: 它远比"N 个模块"更常表示子集/测试集/
      // 算法维度，而非引擎总规模。补这条模式的代价(8 条假阳性)高于收益，
      // 故明确记录不补——这是"知道盲区存在但选择不修"的诚实披露，
      // 而不是假装没有盲区。第 26 次仪器失效，且这次是**我自己补大的**。

      // ── [第十一轮] 失败数: "N failing" ──
      // m.testsFailed 早就能从 run-all 输出解析出来(与 m.tests 同一个正则)，
      // 却从未进 actual，于是三处文档的 "0 failing" 是一句永远不必为真的话。
      // 实测注入 "7 failing" → 0 报告。reject 用 narrativeQuote:
      // SKILL.md 有一行历史读数 "reports 711 passing / 1 failing (was 546)"，
      // 过去时 `was` 就在数字之后，由第九轮的 narrative-after 判据排除。
      {
        re: /(\d[\d,]*)\s+failing/g,
        key: 'testsFailed',
        what: 'failing tests (失败数)',
        reject: (t, a) => selfRef(t, a) || narrativeQuote(t, a),
      },

      // ── [第十一轮] 引擎版本: 只用**无歧义标签**，不用裸语义版本号 ──
      // 约定 #1 点名 VERSION 是唯一真相源，而 version 一直被测量、被打印，
      // 却没有任何模式核对它。实测注入 README 的 v9.9.9 → 0 报告。
      //
      // ⚠️ 为什么不匹配裸 `v?\d+\.\d+\.\d+`: 实测已扫文档里有 **551 处**
      // 版本形态，绝大多数是路线图/架构里程碑标记
      // (ARCHITECTURE.md 的 v6.3.0/v6.4.0/v6.5.0、ROADMAP.md 的 v6.0.6)，
      // 它们不是包版本。那是第 26 次仪器失效的同一条:
      // **一个枚举式过滤器，每遇到一种新的叙述方式就漏一次**，
      // 而版本号的"新的叙述方式"至少有十几种。
      // 故只认两种**带标签**的形态:
      //   ① `| Engine version | 1.0.0 |`(SKILL.md 指标表)
      //   ② `> 版本 | v1.0.0`(CURRENT_STATE.md 行首)
      //  deliberately 不认 `| 版本 |` 表格形态: REFLECTION.md 有一行
      // `| 版本 | 6.2.7 |`，位于 `## 现在（2026-07-25）` 之下——
      // 那是一份"过去/现在/未来"反思文档里**钉在 2026-07-25 的时点快照**，
      // 拿现在去核对就是制造假警报。中文"版本"在任意表格里都可能出现，
      // 标签本身不构成"这是引擎版本"的保证。
      // 该残留(REFLECTION.md 的 6.2.7 不受审)在此披露，不假装没有。
      {
        re: /\|\s*Engine version\s*\|\s*v?(\d+\.\d+\.\d+)/g,
        key: 'version',
        what: 'engine version (标签表格)',
      },
      {
        re: />\s*版本\s*\|\s*v?(\d+\.\d+\.\d+)/g,
        key: 'version',
        what: '版本 (CURRENT_STATE 行首)',
      },

      // ── [第十二轮] 公式库条数: 只锁**总量**，不锁分文件计数 ──
      // 反向枚举"可审形态里未产出声称的规模数"找到的唯一漏网。
      // 三处文档三个数字，而 formulas 此前在审计里出现 0 次:
      //   INSTALL.md       公式库(2397个)      → 夸大约 4 倍
      //   CURRENT_STATE.md 公式库 | 1286 formulas → 夸大约 2 倍
      //   formulas/README  完整382条公式文件    → "拆分前"的旧值，拆分后又长回去了
      // 实测(默认加载的 formulas/formulas.json) = 608 条。
      //
      // ⚠️ **deliberately 不匹配** `formulas-core.json（284条）` 与
      // `formulas-archive.json（98条）`: 那两条是**分文件**计数，实测均为真，
      // 与总量不是同一个量。把 284 拿去对 608 就是自己制造假警报——
      // 这是第 26 次仪器失效的同一条: 分不清"同一家族的不同量"的模式
      // 比没有模式更吵。故三条模式各自锚定自己的标签，互不重叠。
      {
        re: /公式库[（(]\s*(\d[\d,]*)\s*个/g,
        key: 'formulas',
        what: '公式库总量 (INSTALL 表)',
      },
      {
        re: /公式库\s*\|\s*(\d[\d,]*)\s*formulas?/g,
        key: 'formulas',
        what: '公式库总量 (CURRENT_STATE 行)',
      },
      {
        // "未拆分前的完整382条公式文件" —— 描述 formulas.json 自身的规模。
        // 必须锚在"完整…条公式文件"上: 光匹配 "N 条公式" 会命中
        // core/archive 的分域行(cognitive_science 119条 …)。
        re: /完整\s*(\d[\d,]*)\s*条公式文件/g,
        key: 'formulas',
        what: '公式库总量 (README 原文件说明)',
      },
    ];
    for (const p of pats) {
      let mm;
      const re = new RegExp(p.re.source, 'g');
      while ((mm = re.exec(s)) !== null) {
        // reject 过滤器: 排除「匹配到了但不是引擎当前规模声称」的假阳性。
        // 没有 reject 的模式行为不变。
        // ── [第九轮] 通用判据: 行内代码跨度内的数字是被引用的字面量 ──
        // 这是**文本的属性**，不是某条模式的调优，故对所有模式生效。
        // 首版只放在 narrativeQuote 里，于是**不带 reject 的表格模式**
        // (如 `| Test suite | N passing`)永远走不到这条检查——
        // 一个正确的判据放错了地方，等于没有。
        if (inCodeSpan(s, mm.index)) continue;
        if (typeof p.reject === 'function' && p.reject(s, mm.index)) continue;
        // ── [第九轮] 第二层闸门: 作用域计数 ──
        // 只对**已带 reject 的模式**追加，不新增/改动任何模式的字面文本
        // (有测试按字面量搜索这些行，改文本会让它们永远找不到)。
        //
        // 为什么需要第二层: selfRef 回答「这条声称在说 aspira 吗」，
        // 而放宽它的作用域后(第九轮，让它别吃掉引擎自述文档的首页摘要行)，
        // 自述文档里大量**局部计数**涌了进来:
        //   "Never `require` a Tier-2 module at the top of `heartflow.js`"
        //   "At low effort only tier 1 modules run"
        //   "11 refs across 8 modules"
        // 它们都在说 aspira，但说的不是 aspira 的**总量**。
        // notScoped 回答的正是第二问: 数字前面紧邻作用域词
        // (tier/across/only/each/...)时，它是局部量而非清单规模。
        if (typeof p.reject === 'function' && notScoped(s, mm.index)) continue;
        out.push({ doc: f, what: p.what, key: p.key, claimed: mm[1] });
      }
    }
  }
  return out;
}

const m = measure();
const cl = claims();

// 每个声称对应的实测值
// 注意求值顺序: m.routes / m.layers 在下面的 try 块里才被赋值，
// 若在对象字面量里提前引用会得到 undefined——首版正是如此，把已测得的层数
// 报成"无法实测"。故此处先用占位，测量后再回填。
  // [第四十四轮] 覆盖清点的测量必须放在 `const actual = {}` **之前**。
  // 原来它跟在后面, 于是 actual.aliveUntested = m.aliveUntested 在
  // m.aliveUntested 还是 undefined 时就被求值 —— 声称被正确读出来(999),
  // 实测值却是 null, 于是掉进"无法实测"而不是"不符"。**读取先于测量,
  // 锁就永远是开着的, 而且看起来是关着的。**
  // [第四十七轮] 三个 matchAll 的正则都必须带 /g —— String.prototype.matchAll
  // 遇非全局正则**直接抛 TypeError**(本轮早前一次探测就撞过同一个错误)。
  // 未带 g 时: 第一行 matchAll 抛出 → catch 把 m.srcModules 置 null →
  // **m.aliveUntested 与 m.suspectedDead 连赋值都没走到, 停在 undefined**。
  // 实测调试打印: mSrc=null mAlive=undefined —— 一个被 catch 兜住、
  // 一个从未执行。这就是无法实测的真正来源, 与求值顺序无关。
  // ── [第四十一轮] 测试覆盖清点 ────────────────────────────────────
  // 背景: coverage-sweep.js 在周期37 修掉了 referencedByTest 的子串匹配
  // (虚报 47 个模块已覆盖)，诚实缺口从 103 变成 134。但那个数字只活在
  // 脚本自己的 stdout 里，**没有任何当前声称站点引用它**，于是 audit
  // 不核对它 —— 周期 28/38/39/40 连续四个周期把它列为「下次方向」
  // 却一直没做。这正是 AGENTS.md 反复记录的形状:
  // **一个被测量过的数字，不等于一个被锁定的数字。**
  //
  // 与 m.tests 同构: spawn 脚本，从 stdout 抓汇总值。
  // 取「最后一次」匹配，理由与 m.tests 完全相同 —— 取第一条会拿到
  // 某个中间值，把正确的文档声称报成不符。
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('node', ['scripts/coverage-sweep.js'], { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'ignore'] });
    const out = (r && r.stdout) ? r.stdout.toString() : '';
    const all = [...out.matchAll(/src 模块 (\d+) 个/g)];           // 汇总行
    m.srcModules = all.length ? Number(all[all.length - 1][1]) : null;
    const bm = [...out.matchAll(/B 无测试引用但有 src 引用\(活着但没测\): (\d+)/g)];
    m.aliveUntested = bm.length ? Number(bm[bm.length - 1][1]) : null;
    const am = [...out.matchAll(/A 无测试引用且无 src 引用\(疑似死代码\): (\d+)/g)];
    m.suspectedDead = am.length ? Number(am[am.length - 1][1]) : null;
  } catch (_) { m.srcModules = null; }

const actual = {
  dimensions: m.dimensions,
  modules: m.modules,
  tools: m.tools,
  routes: null,
  layers: null,
  tier_block: m.tiers.block,
  tier_rewrite: m.tiers.rewrite,
  tier_verify: m.tiers.verify,
  nodeReq: m.nodeReq,
  tests: null,
  aliveUntested: m.aliveUntested,
  srcModules: m.srcModules,
  suspectedDead: m.suspectedDead,
};

// 测试条数实测: 必须跑 run-all 取权威数字。
// 不能静态数 test( 声明——实测静态 808 而 run-all 报 852，差 44:
// 有用例在循环里生成(如对每个维度各建一例)，静态扫描数不到。
// 这同时意味着 test/doc-numbers.test.js 里那个 ASPIRA_MEASURED_TESTS
// 环境变量从未被任何地方设置过，该断言一直静默退化成"只断言是正数"——
// 真正的测试条数校验只能由本脚本(或调用方)完成。
// [递归防护] ASPIRA_AUDIT_SKIP_TESTS=1 时跳过测试数实测。
// 审计要跑 run-all.js 取测试数，而 run-all.js 会执行调用本脚本的测试
// (test/doc-honest-numbers-chinese.test.js)——不设此开关会无限递归，
// 实测后果: 嵌套调用把测试数测错，且测试临时改写的文档在嵌套层之间
// 互相可见，产出假警报。
const SKIP_TESTS = process.env.ASPIRA_AUDIT_SKIP_TESTS === '1';
if (!SKIP_TESTS) try {
  // [仪器修复] 原先用 execSync——子进程**非零退出即抛异常**，而 run-all.js 在
  // 有用例失败时正是 process.exitCode = 1。于是 catch 把 m.tests 置 null，
  // 测试数声称变成"无法实测": **审计恰在出问题的那一刻失明**。
  // spawnSync 不抛异常，stdout 在失败时依然可读——测试数照常测得。
  const { spawnSync } = require('child_process');
  const r = spawnSync('node', ['test/run-all.js'], { cwd: ROOT, encoding: 'utf8', timeout: 900000, stdio: ['ignore', 'pipe', 'ignore'] });
  const out = (r && r.stdout) ? r.stdout.toString() : '';
  // 必须取**最后**一条匹配: run-all.js 对每个测试文件都打印一行
  // "测试结果: N 通过, 0 失败, 共 N 个"，最终汇总行形状与之相同。
  // 首版用 exec 取第一条，拿到的是某个测试文件的 10 通过，于是一条
  // 正确的文档声称被报成"实测 10"——审计自己的 bug 产出假警报。
  const all = [...out.matchAll(/测试结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败/g)];
  const tm = all.length ? all[all.length - 1] : null;
  m.tests = tm ? Number(tm[1]) : null;
  m.testsFailed = tm ? Number(tm[2]) : null;
  } catch (_) { m.tests = null; }


// 层数实测: 从 src/pipeline.js 的 checked_by.push({ layer: 'X' }) 静态提取。
// 不能靠跑一次 pipeline 数 checked_by——那条路径只走命中分支(实测同一输入
// 只得 12 条)，会低估真实层数。静态提取去重后得 17 层。
// 文档此前声称"14 层"，且名单里 3 个层(evidence verify / rewriter /
// self-diagnosis)在代码中根本不存在，同时漏掉 8 个真实层——静态提取才能查出。
try {
  const pipeSrc = fs.readFileSync(path.join(ROOT, 'src', 'pipeline.js'), 'utf8');
  const pushes = [...pipeSrc.matchAll(/checked_by\.push\(\{\s*layer:\s*'([a-z-]+)'/g)].map(x => x[1]);
  const order = [];
  for (const p of pushes) if (!order.includes(p)) order.push(p);
  m.layers = order.length;
  m.layerOrder = order;
} catch (_) { m.layers = null; m.layerOrder = null; }

// ── [审计盲区修复·第三轮] 层数的两个口径必须分开报 ──
// 静态层名数(17)与**单次运行命中的层数**是两个不同的量，文档只写
// "17-layer pipeline"，读者无法从数字本身看出区别。AGENTS.md 已记载
// runPipeline 实测 input→11 / draft→12 / output→13，**17 从不匹配任何模式**。
// 审计此前只核对静态名单，于是"17 层"这个声称永远绿灯——
// **一个数字可以完全正确(静态口径)又完全误导(运行口径)，而审计看不见后者。**
// 现在并排报出两个数，让差异显式化。
try {
  const pipe = require(path.join(ROOT, 'src', 'pipeline.js'));
  const perMode = {};
  let maxRun = 0;
  for (const mode of ['input', 'draft', 'output']) {
    const r = pipe.runPipeline({ input: '这是一个用于层数实测的句子。', mode });
    const n = (r && r.checked_by ? r.checked_by.length : 0);
    perMode[mode] = n;
    if (n > maxRun) maxRun = n;
  }
  m.layersMaxRun = maxRun;
  m.layersPerMode = perMode;
} catch (_) { m.layersMaxRun = null; m.layersPerMode = null; }

actual.routes = m.routes;
actual.layers = m.layers;
actual.tests = m.tests;
// [第四十七轮] 覆盖清点三项, 紧贴 actual.tests —— 这是本文件里
// **唯一被证明可用**的位置(它在 rows 构造之前, 而 rows 读 actual[c.key])。
// 周期44 与 47 第一次都放错了地方: 一次在 rows 之后, 一次在对象字面量里
// 提前求值。两次都表现为"无法实测", 而红灯从未为它们亮过。
actual.aliveUntested = m.aliveUntested;
actual.srcModules = m.srcModules;
actual.suspectedDead = m.suspectedDead;
// ── [第十一轮] 两个"测了却没接线"的键 ──
// 反向枚举 pats 的 key 与 measure() 赋值的 key，得到 21 个
// "被测但无模式"的键。其中绝大多数是中间量(depsDeclared /
// depsOptional / nodeScannedFiles / instantInstallWorks …)，
// 它们只是真正 key 的输入，不需要自己的模式。
// 但有两个是**文档里明明有当前声称、却一个模式都不核对**的:
//
// ① `version`: 约定 #1 原文是 "Never hardcode the version.
//    VERSION is the single source of truth… package.json 和 SKILL.md
//    必须匹配"。而 measure() 一直测 VERSION(=1.0.0)，audit 也打印它，
//    **却没有任何模式拿它核对文档**。实测注入: 把 README 的
//    "Measured on this repository at **v1.0.0**" 改成 v9.9.9，
//    审计仍报 78/78、0 不符。这是第七轮 `domains` 那一类
//    ("被测到却锁不住")，而且中的是约定 #1 点名的那一个数字。
// ② `testsFailed`: m.testsFailed 在第 887 行就从 run-all 输出里
//    解析出来了(和 m.tests 同一个正则)，但从未进 actual。
//    实测注入: 把 "0 failing" 改成 "7 failing"，同样 0 报告。
//    于是 README/SKILL/CURRENT_STATE 三处的 "0 failing" 是
//    **一句永远不必为真的话**。
actual.version = m.version;
actual.testsFailed = m.testsFailed;
// [第四轮] dependencies 键数必须与文档声称的 "0 runtime dependencies" 一致
actual.deps = m.depsDeclared;
// [第七轮] 能力域数。实测值是 **README 自己那张表的行数**——
// 不是代码里的某个常量(引擎没有"domain"这个一等概念，
// 132 个模块是按注册表平铺的，域只是文档的分类视角)。
// 所以这个 key 真正锁住的是**标题与表格不得互相漂移**:
// 标题写 "7 domains" 而表格列了 8 行，两者必须同时被发现。
actual.domains = m.domains;
// [第十二轮] 公式库条数。默认加载路径见 src/formula/formula-module.js:13
// 的 formulasFile 默认值(formulas/formulas.json)，不是 core/archive 那两个分文件。
actual.formulas = m.formulas;
// [第八轮] 语料规模是 **FP 率与召回率的分母**，此前无任何模式核对它。
// 穷举法(而非人工提问)找到的盲区: 把 pats 的 key 与文档实际出现的
// "数字+单位词"形态机械化比对，`benign` / `malicious` 双双落空。
// 文档三处写 "106 benign / 41 malicious samples"，审计一次都没量过——
// 而 **0.9% FP 和 100% recall 都是以它为分母的**。
// 分母错了，两个百分比同时失真，且没有任何仪器会报错。
// 实测方式: 解析 scripts/calibrate-fp-recall.js 的 BENIGN / MALICIOUS
// 数组字面量条数(不 require，因为该脚本顶层会跑整个校准并写文件)。
actual.corpusBenign = m.corpusBenign;
actual.corpusMalicious = m.corpusMalicious;

// [第四十四轮] 覆盖清点三项。上面 actual = {...} 里的
// aliveUntested: m.aliveUntested 不是这里的工作方式 —— actual 的键
// 要在这个比对前的块里**二次赋值**才生效(formulas / corpusBenign /
// tests 全是如此)。我前两轮就是漏了这一步: 声称被读成 999、实测是
// undefined, 于是掉进无法实测而不是不符。**一把看起来关着的锁。**
// [第四十七轮] 覆盖清点三项的回填必须发生在 rows 构造**之前**。
// 周期44 我把 actual.X = m.X 写在了 rows 之后 —— 于是 rows 捕获到的
// 是 undefined, 声称被判为"无法实测"而不是"不符"。周期44 那次
// "突变 122→999 后 exit=1" 我当成锁生效的证据, 而那 5 处不符全是
// 间歇性 tests 短差, **我的声称仍躺在"无法实测"里**。这次的判据是
// rows 的求值时机, 不是红灯本身 —— 又一条"绿灯不能证明锁存在"。
const rows = cl.map(c => {
  const a = actual[c.key];
  // 千分位归一化后再比: 文档写 1,510，实测 1510
  // 归一化: 去千分位逗号、去所有空白。文档写 ">= 18.17" 而 package.json 写
  // ">=18.17"——那是排版差异不是数字不符，首版因此产出两条假警报。
  const norm = (v) => String(v).replace(/,/g, '').replace(/\s+/g, '').trim();
  const ok = a == null ? null : norm(a) === norm(c.claimed);
  return { ...c, actual: a, ok };
});

// 层名单比对: SKILL.md 的 "## The N-layer check pipeline" 代码块
let layerListClaim = null;
try {
  const sk = readDoc('SKILL.md');
  const blk = /## The (\d+)-layer check pipeline\s*\n```([\s\S]*?)```/.exec(sk);
  if (blk) {
    // 与 test/doc-numbers.test.js 同一套解析: lookahead 需接受 "("，
    // 否则 "discriminate(54 dims)" 里的 discriminate 会被漏出名单。
    const flat = blk[2].replace(/\s+/g, ' ');
    const names = [...flat.matchAll(/([a-z][a-z-]+)(?=\s*->|\s*$|\s*\()/g)].map(x => x[1])
      .filter(n => n !== 'input' && n !== 'output' && n !== 'dims');
    layerListClaim = { claimedCount: Number(blk[1]), names };
  }
} catch (_) {}


const bad = rows.filter(r => r.ok === false);
const unmeasurable = rows.filter(r => r.ok === null);
const okRows = rows.filter(r => r.ok === true);

// ── [第二十二轮] 审计期间的文档漂移检测 ──
// 第十九轮引入 DOC_SNAPSHOT 时只问了一个问题: 快照挡住了什么(探针在
// measure() 期间注入, claims() 读快照于是看不见)。它确实挡住了 —— 但同一个
// 决定也**放过**了一样东西: 探针若注入后没有还原, 磁盘上的文档就停在污染态,
// 而审计的每一条声称都读自快照, 于是它报「不一致: 0」——**全绿, 而文档是脏的**。
// 实测确认过这个盲区(周期22): 审计带 1 条真 mismatch 时退出码是 0,
// 而探针留下的污染在快照里根本不存在, 连那 1 条都算不上。
// 这不是理论顾虑: 周期19 自己就是这么发现污染的 —— 它杀掉自己的审计 run,
// SIGTERM 传到探针, 探针死在注入与还原之间, 污染留在磁盘上。
// 修法: claims() 之后把每份文档重新读一遍, 与快照逐字节比对。
// 有差异 = 「审计期间被改写且未还原」, 这是**探针/外部写入的缺陷**, 不是文档
// 写错了, 所以单独报一类, 不计入 bad(那会把脏文档误判成文档声称不符)。
// 它也解释了为什么快照必须是双刃的: 它挡住污染进入声称, 就必须让污染在别处发声。
// [第二十四轮] 漂移必须分方向报, 而修复建议绝不能再让人把污染写回去。
// 周期23 实测出一个反向误报: 从污染态起步跑审计(上一轮把 SKILL.md 留在 9.9.9),
// 快照本身就是脏的; 本轮套件里的探针把它**治愈**成 1.0.0, 于是漂移检查报
// 「被改写且未还原」—— 方向是反的。而旧文案的修法是"把污染还原到快照内容",
// 照做就会把 9.9.9 写回一份刚刚被修好的文档。
// **一个把修复方向指反的报告, 比没有报告更糟。**
// 判据用约定 #1 点名的字段: 带标签的 Engine version 行。它与 VERSION 一致即干净。
// 没有该行的文档无法判向, 维持旧行为(报 DIRTY)—— 未知方向时按更响的那半边报。
const PROBE_AUTH_VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
function labelledVersionOf(text) {
  const m = text.match(/\|\s*Engine version\s*\|\s*v?(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}
const DRIFT = [];   // 变脏: 快照干净, 当前脏 —— 探针没还原
const HEALED = [];  // 变干净: 快照脏, 当前干净 —— 上一轮的污染被本轮治愈
for (const f of DOCS_RECURSIVE) {
  const cur = readDocRaw(f), snap = DOC_SNAPSHOT.get(f);
  if (cur === snap) continue;
  const curV = labelledVersionOf(cur), snapV = labelledVersionOf(snap);
  if (curV !== null && snapV !== null && curV === PROBE_AUTH_VERSION && snapV !== PROBE_AUTH_VERSION) {
    HEALED.push(f);
  } else {
    DRIFT.push(f);
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ measured: m, rows, drift: DRIFT, healed: HEALED }, null, 2));
} else {
  console.log('=== 文档诚实数字审计 ===');
  console.log(`实测: dimensions=${m.dimensions} modules=${m.modules} tools=${m.tools} `
    + `initErrors=${m.initErrors} layers=${actual.layers} nodeReq=${m.nodeReq} VERSION=${m.version}`);
  // [审计盲区修复·第三轮] 层数的两个口径并排报。文档写 "17-layer pipeline"
  // 指的是**静态层名数**; 单次运行最多命中 13(output 模式)。
  // 只报静态数会让"17 层"永远绿灯, 而按运行口径读它的人被误导。
  if (m.depsDeclared != null) {
    console.log(`  依赖双口径: dependencies 声明 ${m.depsDeclared} 个 / optionalDependencies ${m.depsOptional} 个 `
      + `(${(m.depsOptionalNames || []).join(', ') || '无'})`);
    console.log(`  src/ 内硬依赖(不在 try/catch 的外部 require) ${m.depsActuallyRequired} 个`
      + (m.depsHardNames && m.depsHardNames.length ? ': ' + m.depsHardNames.join(', ') : ''));
    if (m.depsDeclared > 0) {
      console.log('  ❌ dependencies 非空而文档声称 0 runtime dependencies——声明与文档矛盾');
    }
    if (m.depsActuallyRequired > 0) {
      console.log('  ❌ src/ 存在不在 try/catch 内的外部 require——「零依赖」在运行时语义上不成立');
    }
  }
  if (m.nodeFeaturesOverMin != null) {
    console.log(`  Node 兼容实测: 声明下限 ${m.nodeReq} · 扫 src/ ${m.nodeScannedFiles} 个文件 · 越界特性 ${m.nodeFeaturesOverMin} 个`
      + (m.nodeFeatureOverList && m.nodeFeatureOverList.length ? ': ' + m.nodeFeatureOverList.map(x => x.label + '(需' + x.needs + ')').join(', ') : ''));
    if (m.nodeFeaturesOverMin > 0) {
      console.log('  ❌ src/ 使用了高于声明下限的语法/API——「Node >= ' + m.nodeReq + '」在运行时语义上不成立');
    }
    console.log(`  instant install 实测: require(${m.instantInstallMain}) 后立即调用 ${m.instantInstallWorks ? '可用' : '失败'}`
      + (m.instantInstallAction ? ` (首次调用 gate.action=${m.instantInstallAction})` : ''));
    if (m.instantInstallWorks === false) {
      console.log('  ❌ 主入口 require 后无法立即调用——「instant install / 装完即可用」不成立');
    }
  }
  if (m.layersMaxRun != null) {
    const pm = m.layersPerMode || {};
    console.log(`  层数双口径: 静态层名 ${m.layers} 个 / 单次运行最多命中 ${m.layersMaxRun} 个 `
      + `(input=${pm.input} draft=${pm.draft} output=${pm.output})`);
    if (m.layersMaxRun !== m.layers) {
      console.log('  ⚠ 两个口径不一致: 文档的 "N-layer pipeline" 是静态层名数, '
        + '不是任何一次运行都会经过的层数。引用时须说明口径, 否则读者会以为每次调用都走 N 层。');
    }
  }
  console.log(`AGENTS.md 分层声明: block=${m.tiers.block} rewrite=${m.tiers.rewrite} verify=${m.tiers.verify} scored=${m.tiers.scored}`);
  // ── [覆盖面自报] 审计自己的盲区有多大 ──
  // 由来: 曾发现审计 38/38 全绿，但全仓 md 约 295 处数字型声称里它只校验 38 条。
  // 绿只说明「它知道的那几条没错」，不说明没被查到的一定对。
  // 于是把覆盖率从一次性测量变成**每次运行都报**的常驻指标。
  //
  // ⚠️ 这个百分比**不能**当漏洞数读: 它是「数字+单位词」的粗计，含版本号、日期、
  // 提案前提(AGI_VISION.md 的「当前 25 个工具」是重构规划的起点，不是当前声称)、
  // 历史叙事章节等大量本就不该审的内容。报它是为了让人问
  // 「剩下那些为什么没审」，而不是为了凑一个好看的数字。
  const NUMISH = /(\d[\d,]*)\s*(?:个|条|行|层|维|模块|工具|路由|tests?|passing|failed|%|倍)/g;
  // ── [审计盲区修复·第五轮] 分母虚高: 3.6% 曾把"已豁免文件的声称"也算进去 ──
  // 上一轮只把分母的文件集换成 DOCS_RECURSIVE(已扫集)，但**没换掉 NUMISH
  // 的粗计口径**。实测把 2009 条命中拆开:
  //   · 755 条(37.5%)是**百分比** —— "FP 率 0.9%" "覆盖率 85%"，
  //     它们是**被测量出来的结果**，不是文档里的规模声称
  //   · 188 条在**代码围栏内** —— 示例命令、配置片段、代码注释
  //   · 大量版本号/日期(v5.5 / 2026-09-28 / >=18.17)
  // 于是"数字型声称 2009 条"里绝大多数是**本来就不该审的内容**，
  // 拿它当分母算出的 3.6% 不是疏漏率，而是**分母虚高**——
  // 用它暗示"还有 96% 没审"是误导，正如用虚假的精确度冒充诚实。
  //
  // 修法: 分母只保留**可审形态**——剥掉代码围栏、排除百分比与版本号/日期，
  // 并按类别分别报出，让读者看见分母的构成而不只是一个数。
  let rawClaims = 0, nPercent = 0, nFenced = 0, nVerDate = 0, nScannable = 0;
  for (const f of DOCS_RECURSIVE) {
    let t = readDoc(f);
    if (!t) continue;
    // 代码围栏先整体剥掉(其内容不算声称)
    t = t.replace(/```[\s\S]*?```/g, (m) => {
      nFenced += (m.match(NUMISH) || []).length;
      // rawClaims 也必须在**剥之前**累加: 否则构成自相矛盾——
      // 「可审+百分比+围栏」会大于标签里的粗计数。一个自己都不自洽的
      // 分母构成比没有构成更糟。四类是互斥集，粗计须为四者之和。
      rawClaims += (m.match(NUMISH) || []).length;
      return ' ';
    });
    for (const h of (t.match(NUMISH) || [])) {
      rawClaims++;
      if (/%/.test(h)) { nPercent++; continue; }
      if (/v?\d+\.\d+/.test(h) || /\d{4}-\d{2}-\d{2}/.test(h) || />=\s*\d/.test(h)) { nVerDate++; continue; }
      nScannable++;
    }
  }
  // 分母改为"可审形态"数。审计**能**处理的远不止 44 条(它还有序数/括号/
  // 叙事引用/多义形态等已知不审的类别)，所以这个百分比仍是下界而非疏漏率，
  // 但现在它是一个**有构成说明的下界**，而不是一个虚高的数。
  const pct = nScannable ? (100 * rows.length / nScannable).toFixed(1) : 'n/a';
  console.log('');
  // [审计盲区修复·第二轮] 同时报「已扫文档数 / 豁免数」——
  // 22.3% 这个旧读数的分母只数了根目录 14 份，把子目录 368 份完全排除在外，
  // 于是自报本身也偏乐观。现在分母是全仓(除显式豁免外)的 md。
  const nScanned = DOCS_RECURSIVE.length;
  // ── [第十轮] 去重后的**不同**文档数 ──
  // 「已扫文档 N 份」此前数的是**文件数**。第十轮实测: data/ 下 682 份
  // CORE_VALUES.md 逐字节相同，会把 222 份真实文档报成 904 份。
  // 一个把副本算成文档的覆盖面数字，比不报更坏——它让人以为审过了。
  // 与已记录的「22.3% 分母只数根目录、自报偏乐观」同族，方向相反:
  // 那次分母太小，这次分母里塞了不是分母的东西。
  // 只对**已纳入**的文件做内容哈希去重; 豁免文件不计入。
  // ⚠️ 读不到文件必须**发声**，不能静默算成"不同内容":
  // 首版写的是 `catch (_) { nDistinct++; continue; }`，而 crypto 当时
  // 根本没 import，于是 `crypto.createHash` 抛 ReferenceError 被这个 catch
  // 吞掉，每个文件都走进"算一份不同内容"分支——去重看起来正常工作
  // (输出 811 份全不同、0 重复)，实际**一次都没去重**。
  // 一个把异常吞成看似合理答案的 catch，比没有去重更危险:
  // 它让一个坏掉的自检显示为通过。
  const seenHash = new Set();
  let nDistinct = 0;
  const unreadable = [];
  for (const f of DOCS_RECURSIVE) {
    let h;
    try {
      h = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
    } catch (e) {
      unreadable.push(f + '  # ' + e.message);
      continue;
    }
    if (!seenHash.has(h)) { seenHash.add(h); nDistinct++; }
  }
  if (unreadable.length) {
    console.log('  ⚠️ 去重时读不到 ' + unreadable.length + ' 个已纳入文件(未计入不同内容数):');
    for (const u of unreadable.slice(0, 5)) console.log('    ' + u);
  }
  const nDup = nScanned - nDistinct;
  // 豁免数同样去重: 682 份 CORE_VALUES.md 副本若算成 682 份"豁免文件"，
  // 就再把刚在"已扫"一侧修掉的缺陷翻到豁免一侧——豁免数是给人看
  // "有多少东西没审"的，把副本算进去会让未审集看起来比实际大。
  const exemptAll = [...SUBDIR_EXEMPT.map(s => s.split('  #')[0]), ...Object.keys(HISTORICAL_DOCS)];
  const seenExempt = new Set();
  let nExemptDistinct = 0;
  const exemptUnreadable = [];
  // [第十九轮] 悬空豁免条目: 豁免表里指向**不存在的文件**的条目。
  // 旧行为把 ENOENT 与权限错误同流，一起推进 exemptUnreadable、打一句 ⚠️ 就
  // continue —— 于是该条目仍计入 exemptAll.length(「显式豁免 N 份」被一份
  // **不存在的文档**抬高)，却不计入 nExemptDistinct。这是第十轮形状的翻面:
  // 那次拿 682 份副本充数「已扫文档」，这次拿幽灵充数「豁免文档」。
  // 实测抓到一条: HISTORICAL_DOCS 里的 CHAT_LOG_HeartFlow_完整备份_2026-05-16.md
  // 早已不在仓库，而每次审计都靠它把「有多少没审」夸大一份，且无人失败。
  const exemptDangling = [];
  for (const f of exemptAll) {
    let h;
    try {
      h = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
    } catch (e) {
      if (e.code === 'ENOENT') {
        // [第十九轮] 分清两种 ENOENT: 条目指向的文件真的不在，还是它在、
        // 但是一个**目标不存在的符号链接**。实测仓库里就有一个:
        //   CHAT_LOG_HeartFlow_完整备份_2026-05-16.md
        //     -> /root/mount/CHAT_LOG_HeartFlow_完整备份_2026-05-16_0437a209.md
        // readdirSync 看得见它(不跟随链接)，readFileSync 跟随它 → ENOENT。
        // 它被 git 跟踪，指向仓库外、只在原环境存在的路径。
        // 旧消息只说"指向不存在的文件"，会把这两种情况混成一团。
        let why = '文件不存在';
        try { fs.lstatSync(path.join(ROOT, f)); why = '符号链接目标不存在(指向仓库外)'; } catch (_) {}
        exemptDangling.push(f + ' [' + why + ']');
      }
      else exemptUnreadable.push(f + '  # ' + e.message);
      continue;
    }
    if (!seenExempt.has(h)) { seenExempt.add(h); nExemptDistinct++; }
  }
  if (exemptUnreadable.length) {
    console.log('  ⚠️ 去重时读不到 ' + exemptUnreadable.length + ' 个豁免文件(未计入不同内容数)');
  }
  // 悬空条目是**审计自己的配置缺陷**，不是被豁免文档的问题: 从豁免总数剔除，
  // 并用 ❌ 报出。一个指向空处的豁免，是永远无法被论证的豁免。
  // [第四十九轮] 补一句定向说明。这条 ❌ 从第十九轮起每个周期都亮, 而
  // test/audit-self-pollution.test.js:163 专门钉住它必须被报出 —— 所以它
  // **是有意常亮, 不会被修好**。周期48 我试图消音, 删掉了断链与豁免条目,
  // 该测试立刻按名报出它, 改动被 REVERT。
  // 一个永远常亮的断言本身是设计(它防的是"悬空豁免被静默计数"),
  // 但不加说明就会让每个读报告的人先怀疑一次文档有缺陷。
  // 注意: 下面两条子串 CHAT_LOG_...md 与 符号链接目标不存在 都被该测试断言, 不能动。
  const nExemptReal = exemptAll.length - exemptDangling.length;
  if (exemptDangling.length) {
    console.log('  ❌ 豁免条目悬空 ' + exemptDangling.length + ' 个(指向不存在的文件，已从豁免总数剔除): '
      + exemptDangling.join(', '));
    console.log('     ℹ 此为**有意常亮**: 该条目是测试钉住的夹具(见 test/audit-self-pollution.test.js), '
      + ' 用来说明"悬空豁免必须按名报出、且不得计入豁免总数"。它不代表文档声称有缺陷, 也不应当被消音。');
  }
  const nExemptDup = nExemptReal - nExemptDistinct;
  // [第十九轮] 豁免理由自检: 把豁免的**理由**从断言变成测量。
  // data/ 的理由原本硬编码「682 份 CORE_VALUES.md 逐字节相同副本」。实测 1072 份，
  // 且这个数随测试运行增长(一次会话内先后测得 1063/1066/1072) ——
  // 所以它**不可能保持不变地对**。一个会腐烂的理由比没有理由更糟: 它读起来像一次测量。
  // 改为: 理由只陈述可核对的**性质**，份数与内容种数由审计每次实测并打印。
  const EXEMPT_INVARIANT = { data: 'all-identical' };
  const exemptMeasured = [];
  let exemptReasonBroken = 0;
  for (const dir of Object.keys(EXEMPT_DIRS)) {
    const fl = [];
    (function w(x) {
      let es; try { es = fs.readdirSync(x, { withFileTypes: true }); } catch (_) { return; }
      for (const e of es) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const p = path.join(x, e.name);
        if (e.isDirectory()) w(p); else if (e.name.endsWith('.md')) fl.push(p);
      }
    })(path.join(ROOT, dir));
    if (!fl.length) {
      exemptReasonBroken++;
      exemptMeasured.push(dir + '/=0份(理由失效: 目录下没有 .md)');
      continue;
    }
    const hs = new Set();
    for (const f of fl) {
      try { hs.add(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')); } catch (_) {}
    }
    if (EXEMPT_INVARIANT[dir] === 'all-identical' && hs.size !== 1) {
      exemptReasonBroken++;
      exemptMeasured.push(dir + '/=' + fl.length + '份/' + hs.size + '种(理由失效: 声称逐字节相同)');
    } else {
      exemptMeasured.push(dir + '/=' + fl.length + '份/' + hs.size + '种');
    }
  }
  console.log('  [豁免理由实测] ' + exemptMeasured.join(' · ')
    + (exemptReasonBroken ? ' · ❌ ' + exemptReasonBroken + ' 条理由已失效' : ' · 全部成立'));
  const artifactNote = ARTIFACT_DIRS.length
    ? ` · 运行时泄漏产物目录 ${ARTIFACT_DIRS.length} 处(未扫描，入口已修但残留未清理)`
    : '';
  console.log(`[覆盖面自报] 校验 ${rows.length} 条 / 可审形态声称 ${nScannable} 条 = ${pct}%`);
  console.log(`  已扫文档 ${nScanned} 份 · 其中**不同内容** ${nDistinct} 份`
    + (nDup > 0 ? ` · 逐字节重复 ${nDup} 份(副本不计入覆盖面)` : '')
    + ` · 显式豁免 ${nExemptReal} 份(其中不同内容 ${nExemptDistinct} 份`
    + (nExemptDup > 0 ? `, 逐字节重复 ${nExemptDup} 份` : '')
    + `; 每条豁免都写理由)${artifactNote}`);
  console.log(`  分母构成(已扫文档内 NUMISH 粗计 ${rawClaims} 条): 可审 ${nScannable} · 百分比 ${nPercent} · 版本号/日期 ${nVerDate} · 代码围栏内 ${nFenced}`);
  console.log('  (百分比是**被测量出的结果**不是规模声称; 版本号/日期与代码围栏内文本本就不该审。'
    + '这个百分比是**有构成说明的下界**而非疏漏率——"可审 ${nScannable}" 里仍含序数、括号内引用、'
    + '叙事引用、多义形态(如中文「N 维度」)等已知不审类别，故真实可审集比它更小、百分比比它更高)');
  console.log(`\n文档声称总数: ${rows.length} | 与实测一致: ${okRows.length} | 不一致: ${bad.length} | 无法实测: ${unmeasurable.length}`);
  if (bad.length) {
    console.log('\n--- ❌ 与实测不符(必须修) ---');
    for (const r of bad) console.log(`  ${r.doc} 声称「${r.what} = ${r.claimed}」实测 ${r.actual}`);
  }
  if (layerListClaim) {
    const real = m.layerOrder || [];
    const missing = real.filter(l => !layerListClaim.names.includes(l));
    const fictional = layerListClaim.names.filter(l => !real.includes(l));
    console.log(`\n--- 层名单比对(SKILL.md 代码块) ---`);
    console.log(`  文档声称 ${layerListClaim.claimedCount} 层、列出 ${layerListClaim.names.length} 个层名; 代码实测 ${real.length} 层`);
    if (missing.length) console.log(`  ❌ 代码存在但文档漏掉(${missing.length}): ${missing.join(', ')}`);
    if (fictional.length) console.log(`  ❌ 文档列出但代码不存在(${fictional.length}): ${fictional.join(', ')}`);
    if (!missing.length && !fictional.length) console.log(`  ✓ 名单一致`);
    console.log(`  代码实测顺序: ${real.join(' → ')}`);
  }
  if (unmeasurable.length) {
    console.log('\n--- ⚠ 无法自动实测(需人工确认) ---');
    const seen = new Set();
    for (const r of unmeasurable) {
      const k = `${r.doc}|${r.what}|${r.claimed}`;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`  ${r.doc} 声称「${r.what} = ${r.claimed}」`);
    }
  }

  // [第二十二轮] 漂移必须报在**最后**, 且必须盖过上面那个诱人的全绿。
  // 「不一致: 0」在这里的含义是"文档的声称都对", 不是"文档是干净的"——
  // 两者在快照存在的前提下不再是同一件事, 而这个区别此前没有任何输出提示过。
  if (DRIFT.length) {
    console.log(`\n--- ❌ 审计期间文档被改写且未还原(${DRIFT.length} 份) ---`);
    console.log('  这不是文档声称不符, 是探针/外部写入留下了污染。');
    for (const f of DRIFT) console.log(`  ${f}`);
    console.log('  这些文档的当前磁盘内容与审计开始时的快照不同; 上面的「与实测一致」');
    console.log('  读自快照, 所以它**不能**被当成"文档是干净的"来读。');
    console.log('  修法: 把污染还原到上一行的快照内容, 而不是 git checkout(那会退回旧提交)。');
  }
  // [第二十四轮] 反向的那一半: 快照脏而当前干净。这不是缺陷, 是上一轮的污染
  // 被本轮治愈了。但它必须单独报, 因为**旧的修法在这里是有害的**:
  // "还原到快照内容"会把 9.9.9 写回一份刚刚被修好的文档。
  if (HEALED.length) {
    console.log(`\n--- ⚠️ 审计开始时文档已带污染, 本轮已被治愈(${HEALED.length} 份) ---`);
    for (const f of HEALED) console.log(`  ${f}`);
    console.log('  这些文档的**快照**是脏的而当前磁盘是干净的: 污染发生在本审计启动之前,');
    console.log('  本轮套件里的探针把它修好了。所以上面的「与实测一致」同样**不能**被当成');
    console.log('  "文档是干净的"来读 —— 它读自那份脏快照。');
    console.log('  ⛔ 绝不要按快照还原: 那会把污染写回一份刚刚被修好的文档。');
    console.log('  ✓ 正确修法: 什么都不用做, 当前磁盘内容已经是权威值。');
    console.log('  若要追责: 看上一轮是谁把文档留在脏状态的(通常是没还原的探针)。');
  }
}

// [第二十二轮] 退出码必须承载结论。
// 实测(周期22): 审计带 1 条真 mismatch 时 `node scripts/audit-doc-numbers.js`
// 的退出码是 **0**。于是任何用 spawnSync/execFileSync 调它的调用方 —— CI、
// test/ 里的探针、外部 agent —— 只能靠解析中文文本判断红绿, 而退出码这个最
// 基本的契约一声不响。一个只通过 stdout 表达失败的门, 在任何只看退出码的
// 流水线里就是没有门。
// 漂移与不符都置 1: 两者都是"必须修", 只是一个错在文档、一个错在探针。
if (bad.length || DRIFT.length) process.exitCode = 1;
