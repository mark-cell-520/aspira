/**
 * test/self-diagnostic-paths.test.js
 *
 * ═══ 由来(第十六轮, test-coverage-gap 切片) ═══
 * 本周期主线是约定 #6("每步编辑后 `node --check <file>`")零强制执行——
 * 见 `test/src-syntax-check.test.js`。顺着"门禁看不见的东西"往下量，
 * 量出第二处缺口，且是同一形状的又一实例:
 *
 * `src/core/self-diagnostic.js` 的 20 步自检里，**step 17 与 step 18 永远 fail**:
 *   · step17 的 6 个引擎条目，**5 个的 dir 指向不存在的目录**
 *     ( PsychologyEngine 写 src/core 实为 src/emotion;
 *       DreamEngine 写 src/core 实为 src/dream;
 *       SelfModel 写 src/core/consciousness 实为 src/identity;
 *       SelfHealingRL 写 src/core 实为 src/cortex;
 *       LessonBank 写 src/core 实为 src/cortex )
 *     → 实测 allFound = 1/6，而该步的通过门槛是 >= 4，**恒 fail**。
 *   · step18 在 `path.join(ROOT, 'src/core', f)` 里找
 *     dream-engine.js / dream.js / interactive-dream.js，
 *     而这三个文件全在 **src/dream/** → found 恒为空，**恒 fail**。
 *
 * 为什么没人发现: **整套 20 步自检从来没有被任何测试调用过。**
 * `grep -rln runDiagnostic test/` 结果为空。于是两个永远红的步骤
 * 躺在自检里，而门禁全绿。
 *
 * 而 step17 那段旧注释正是最刺眼的一点: 它标题写着
 * "引擎实际文件位置（已确认）"并列出 "DreamEngine: dream.js"，
 * **下一行的 dir 却仍旧是 src/core**——注释知道正确位置，代码用错的那个。
 *
 * ═══ 为什么这把锁是源码级而不是跑 runDiagnostic ═══
 * 因为 `step19_versionSync` 会**写文件**: 版本不一致时它自动改写
 * package.json / SKILL.md / README.md / heartflow.js。
 * 在测试里无条件跑 runDiagnostic，就等于让测试有机会改写仓库源码——
 * 并发下两个进程同时改写是灾难。故本锁只**静态核对表格与磁盘是否一致**，
 * 不执行自检。(这与本仓库"探测必须持 doc 锁"是同一条纪律:
 * **能写的东西不能随便跑**。)
 *
 * ═══ 为什么必须先剥注释 ═══
 * 修复时把真实位置写进了注释，而注释里含有 `src/core`、`src/dream` 等字样。
 * 不剥注释的源码锁会把**自己的说明**当成罪证——周期 14 的 run-all 锁
 * 与周期 15 的静默 SKIP 锁都踩过这一个坑，后者还是在 33 个文件的规模上。
 */
const fs = require('fs');
const path = require('path');

const SD = path.join(__dirname, '..', 'src', 'core', 'self-diagnostic.js');
const ROOT = path.join(__dirname, '..');

/** 剥掉块注释与行注释(周期 14/15 两次学费换来的必需步骤) */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 从 step17 的 engines 表里抽出条目 */
function extractEngines(code) {
  const start = code.search(/const engines\s*=\s*\[/);
  if (start < 0) return [];
  const end = code.indexOf('];', start);
  if (end < 0) return [];
  const body = code.slice(start, end);
  const out = [];
  const re = /\{\s*name:\s*'([^']+)'\s*,\s*file:\s*'([^']+)'\s*,\s*dir:\s*'([^']+)'\s*,\s*fns:\s*\[([^\]]*)\]\s*\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.push({
      name: m[1], file: m[2], dir: m[3],
      fns: m[4].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
    });
  }
  return out;
}

module.exports = function ({ test, assertEqual, assertTrue, log }) {

  test('step17 引擎表里的每个 dir/file 都必须真实存在', () => {
    const code = stripComments(fs.readFileSync(SD, 'utf8'));
    const engines = extractEngines(code);
    // 防"空过": 表必须被解析出来，且条目数与源码一致
    assertTrue(engines.length === 6,
      `应从源码解析出 6 个引擎条目，实际 ${engines.length} 个——若为 0，说明本锁的解析已失效(空过)`);

    const bad = [];
    let allFound = 0;
    for (const e of engines) {
      const p = path.join(ROOT, e.dir, e.file);
      if (!fs.existsSync(p)) { bad.push(`${e.name}: ${e.dir}/${e.file} 不存在`); continue; }
      if (fs.statSync(p).size === 0) { bad.push(`${e.name}: ${e.dir}/${e.file} 是空文件`); continue; }
      const content = fs.readFileSync(p, 'utf8');
      const fnsFound = e.fns.filter(f => content.includes(f));
      if (fnsFound.length === 0) { bad.push(`${e.name}: ${e.dir}/${e.file} 里找不到任何 ${JSON.stringify(e.fns)}`); continue; }
      allFound++;
    }
    if (log) log(`      step17 引擎表: ${allFound}/${engines.length} 可定位(该步通过门槛 >= 4)`);
    // 与 step17 自身的门槛对齐: 少于 4 个该步骤就会恒 fail
    assertTrue(allFound >= 4,
      `step17 只能定位 ${allFound}/${engines.length} 个引擎，低于它自己的通过门槛 4 → 该步将永远 fail:\n` + bad.join('\n'));
    assertEqual(bad.join('\n'), '', '以下引擎条目指向了错误的位置:\n' + bad.join('\n'));
  });

  test('step18 的 dream 目录必须指向 src/dream 且三个文件都在', () => {
    const code = stripComments(fs.readFileSync(SD, 'utf8'));
    const m = code.match(/const DREAM_DIR\s*=\s*'([^']+)'/);
    assertTrue(!!m, '应能解析出 step18 的 DREAM_DIR 常量');
    const dir = m ? m[1] : '';
    assertEqual(dir, 'src/dream',
      `step18 的 DREAM_DIR 应为 'src/dream'(那三个文件的真实位置)，实际 '${dir}'`);

    const files = ['dream-engine.js', 'dream.js', 'interactive-dream.js'];
    const bad = [];
    for (const f of files) {
      const p = path.join(ROOT, dir, f);
      if (!fs.existsSync(p)) bad.push(f + ': ' + dir + '/' + f + ' 不存在');
      else if (fs.statSync(p).size === 0) bad.push(f + ': ' + dir + '/' + f + ' 是空文件');
    }
    assertEqual(bad.join('\n'), '',
      'step18 的这些文件找不到——该步将永远报 fail:\n' + bad.join('\n'));
  });

  test('整套自检从未被测试调用过——这条缺口本身要被锁住', () => {
    // 上面两步修好了表，但**没有人跑过整套自检**才是它一直红着的原因。
    // 这里不断言"必须有测试调用 runDiagnostic"(那要求导出内部函数)，
    // 而是锁住一个更便宜的事实: 自检模块必须导出 runDiagnostic，
    // 且它的步骤表能被静态读到 20 步——即这套自检是**可被**门禁检查的，
    // 而不是一个谁都没法调用的黑盒。
    const code = stripComments(fs.readFileSync(SD, 'utf8'));
    assertTrue(/module\.exports\s*=\s*\{[^}]*runDiagnostic/.test(code),
      'self-diagnostic.js 应导出 runDiagnostic，否则整套自检无法被任何测试检查');
    const stepCount = (code.match(/result\.setStep\(\s*'(\d+)'/g) || []).length;
    assertTrue(stepCount >= 15,
      `应能静态读到至少 15 个 setStep 调用，实际 ${stepCount} 个——自检步骤似乎没被本锁覆盖`);
  });
};
