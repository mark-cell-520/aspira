/**
 * test/formula-library-empty-must-be-loud.test.js — 公式库为空必须响铃
 *
 * ═══ 实测到的缺陷 ═══
 * formulas/ 目录不存在时，FormulaSearch.loadFormulas() 的行为是：
 *   1. readdirSync 抛错 → catch → console.warn('目录扫描失败，回退单文件: ...')
 *   2. 回退目标 formulas.json 也不存在 → _readJsonFile 返回 []
 *   3. console.log(`完成，${files} 个文件，${all.length} 条公式`)
 *      → 即 "完成，0 个文件，0 条公式"
 *
 * 第 3 行与正常启动的 "完成，85 个文件，1286 条公式" 只在数字上有别，混在十几条
 * "加载成功"的 init 日志里一眼看不出问题。而 formula-module.js 照报
 * "Formula Engine 注册成功（懒加载）"。
 * 于是：**所有公式查询返回空、依赖公式的判别维度静默降级，而日志读起来像成功了。**
 *
 * 这不是假设场景。.npmignore 第 2 行刻意不发布 formulas/，注释写
 * "Heavy data - download on demand via upgrade.js" —— 而 upgrade.js 全仓不存在
 * （find . -name 'upgrade.js' 零命中，根下也没有 core/ 目录）。
 * 所以**安装包里的引擎正是这个状态**，且按需下载这条路从来没修通过。
 *
 * ═══ 修法 ═══
 * loadFormulas() 在 0 条时用 error 级明确说出：缺的是哪个目录、哪个文件、
 * 后果是什么、怎么补。并置 this.empty 供调用方判定，不必去解析日志。
 *
 * ═══ 反向证明 ═══
 * formula-search.js 用固定相对路径 require('../utils/safe-fs')，单独加载变异
 * 副本无法导向链路，所以把两个文件按原相对结构复制到临时目录再 require。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEARCH_FILE = path.join(ROOT, 'src', 'formula', 'formula-search.js');
const SAFE_FS = path.join(ROOT, 'src', 'utils', 'safe-fs.js');

/** 复制 formula-search.js + 其相对依赖到临时目录，返回可 require 的路径 */
function copyModule(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-formula-search-'));
  const formulaDir = path.join(root, 'src', 'formula');
  const utilsDir = path.join(root, 'src', 'utils');
  fs.mkdirSync(formulaDir, { recursive: true });
  fs.mkdirSync(utilsDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
  fs.copyFileSync(SAFE_FS, path.join(utilsDir, 'safe-fs.js'));
  // safe-fs.js 还 require ../core/path-guard.js
  fs.copyFileSync(path.join(ROOT, 'src', 'core', 'path-guard.js'),
    path.join(root, 'src', 'core', 'path-guard.js'));
  let src = fs.readFileSync(SEARCH_FILE, 'utf8');
  if (mutate) src = mutate(src);
  const target = path.join(formulaDir, 'formula-search.js');
  fs.writeFileSync(target, src, 'utf8');
  return { root, target };
}

/** 捕获 console.error / console.warn / console.log 的输出 */
function capture(fn) {
  const out = { error: [], warn: [], log: [] };
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...a) => out.error.push(a.join(' '));
  console.warn = (...a) => out.warn.push(a.join(' '));
  console.log = (...a) => out.log.push(a.join(' '));
  try { fn(); } finally {
    console.error = orig.error; console.warn = orig.warn; console.log = orig.log;
  }
  return out;
}


module.exports = function ({ test, assertEqual, assertTrue }) {

  test('正常公式库不得被误判为空', () => {
    // 不依赖仓库的 formulas/：自建一个只含两条公式的临时目录。
    // 原实现用 `if (!fs.existsSync(GOOD_DIR)) return;` 兜底，那正是
    // test/no-tmp-corpus-dependency.test.js 锁禁的形状 ——
    // "不得以 existsSync 静默跳过语料相关用例(读了不存在就退出 0)"：
    // 语料缺失时用例什么都不测却退出 0，失败与成功不可区分。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-formulas-ok-'));
    fs.writeFileSync(path.join(root, 'a.json'),
      JSON.stringify({ formulas: [{ id: 'f-1', name: '测试公式一' }] }), 'utf8');
    try {
      const { FormulaSearch } = require(SEARCH_FILE);
      const f = new FormulaSearch({ formulasDir: root, formulasFile: path.join(root, 'a.json') });
      const out = capture(() => f.loadFormulas());
      assertEqual(f.empty, false, '正常库 empty 必须为 false');
      assertEqual(f.formulas.length, 1, `正常库应取到 1 条公式，实际 ${f.formulas.length} 条`);
      assertEqual(out.error.length, 0,
        '正常库不得打印 error 级故障信息，实际: ' + out.error.join(' | '));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('公式库为空时必须 error 级报出来，且说清缺什么、后果是什么', () => {
    const { FormulaSearch } = require(SEARCH_FILE);
    const f = new FormulaSearch({
      formulasDir: '/tmp/__aspira_no_formulas_dir__',
      formulasFile: '/tmp/__aspira_no_formulas_file__.json',
    });
    const out = capture(() => f.loadFormulas());

    assertEqual(f.empty, true, '0 条公式时 empty 必须为 true');
    assertTrue(out.error.length > 0,
      '0 条公式必须走 error 级 —— 只打一行"完成，0 条"会读起来像成功');
    const msg = out.error.join('\n');
    assertTrue(/公式库为空/.test(msg), 'error 必须点名"公式库为空"');
    assertTrue(msg.includes('/tmp/__aspira_no_formulas_dir__'),
      'error 必须给出扫过的目录路径，否则读者不知道该补哪');
    assertTrue(msg.includes('/tmp/__aspira_no_formulas_file__.json'),
      'error 必须给出回退的单文件路径');
    assertTrue(/返回空|静默降级/.test(msg),
      'error 必须说明后果（查询返回空 / 维度静默降级），不能只报数字');
  });

  test('空库时那条"完成，N 条"不得单独充当成功信号', () => {
    const { FormulaSearch } = require(SEARCH_FILE);
    const f = new FormulaSearch({
      formulasDir: '/tmp/__aspira_no_formulas_dir__',
      formulasFile: '/tmp/__aspira_no_formulas_file__.json',
    });
    const out = capture(() => f.loadFormulas());
    // "完成" 那行可以照打（保留原有信息量），但同一轮里必须有 error 级伴随
    const hasCompletionLine = out.log.some(l => /完成，0 个文件/.test(l));
    assertTrue(out.error.length > 0,
      `空库时只有完成行(存在=${hasCompletionLine})而没有 error 级报警 —— 这正是原缺陷`);
  });

  test('反向证明：删掉 error 报警后，空库必须不再报故障', () => {
    // 变异：把 this.empty 置真后的 console.error 段整块删掉
    const { root, target } = copyModule((src) => {
      const anchor = src.indexOf('    this.empty = all.length === 0;');
      assertTrue(anchor > 0, '变异锚点没匹配上 —— formula-search.js 的 empty 赋值不见了，'
        + '要么修复被回滚，要么本测试该更新');
      const end = src.indexOf('    return this.formulas;', anchor);
      assertTrue(end > anchor, '变异锚点终点没匹配上');
      return src.slice(0, anchor) + src.slice(end);
    });
    try {
      delete require.cache[require.resolve(target)];
      const { FormulaSearch } = require(target);
      const f = new FormulaSearch({
        formulasDir: '/tmp/__aspira_no_formulas_dir__',
        formulasFile: '/tmp/__aspira_no_formulas_file__.json',
      });
      const out = capture(() => f.loadFormulas());
      assertEqual(out.error.length, 0,
        '删掉报警段后空库仍报 error —— 说明报警来自别处，本锁没有锁住目标代码');
      assertEqual(f.empty, undefined,
        '删掉报警段后 empty 标志应一并消失（它俩在同一段里）');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
};
