/**
 * test/self-diagnostic-module-coverage.test.js
 *
 * ═══ 缺陷形状 ═══
 * `src/core/self-diagnostic.js` 的 step 6-9 号称"动态扫描 src/core 下所有 JS 模块"，
 * 但四步各自写死了切片:
 *   slice(0,15) / slice(15,30) / slice(30,45) / slice(45,60)
 * 于是只有前 60 个模块会进自检。src/core 早已超过 60 个 .js 文件，
 * 60 号以后的模块**一次都没被扫过**——空文件、被截断的文件、语法坏掉的文件，
 * 全都静默通过，而 step 6-9 的 checked 加起来只报 60，看起来严丝合缝。
 *
 * 这正是本仓最高产的缺陷形状: 消费侧(四步的 checked/passed 计数)读到的
 * 永远是一个小于真实集合的数，不报错、不告警，只是**少看了一堆文件**。
 *
 * ═══ 修法 ═══
 * 抽出 moduleBatch(modules, i, 4)，按 modules.length 动态等分四批，
 * 四批合并恰好覆盖全表。step 6-9 改成调它，不再写死数字。
 *
 * ═══ 为什么这把锁不跑 runDiagnostic ═══
 * 与 test/self-diagnostic-paths.test.js 同一条纪律: step19_versionSync 会写文件
 * (改写 package.json / SKILL.md / README.md / heartflow.js)，
 * **能写的东西不能随便跑**。故这里只实测 moduleBatch 的覆盖性，不执行整套自检。
 *
 * ═══ 为什么必须有 real.length > 60 这条前置断言 ═══
 * 一把永远不可能失败的锁等于没有锁。若 src/core 只剩 60 个以内模块，
 * "写死 0-60" 与 "全覆盖" 结果相同，本测试会全绿——那正是原缺陷的隐身条件。
 * 所以前置条件写在这里: 模块数必须真的超过 60，否则本锁失去区分力，必须响。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SD_PATH = path.join(ROOT, 'src', 'core', 'self-diagnostic.js');
const CORE_DIR = path.join(ROOT, 'src', 'core');
const BATCH_COUNT = 4;

module.exports = ({ test, assertEqual, assertTrue }) => {

  const SD = require(SD_PATH);

  /** 与 getCoreModules() 同口径: src/core 下 .js，排除 self-diagnostic.js 自己 */
  function realCoreModules() {
    return fs.readdirSync(CORE_DIR)
      .filter(f => f.endsWith('.js') && f !== 'self-diagnostic.js')
      .sort();
  }

  /** 剥掉块注释与行注释（与 test/self-diagnostic-paths.test.js 同一套，勿再退回复制括号） */
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  test('step 6-9 的四批必须恰好覆盖 src/core 全部模块，无重叠无遗漏', () => {
    const real = realCoreModules();

    // 前置条件: 模块数必须真的超过 60，否则本锁区分不出"全覆盖"和"写死 0-60"
    assertTrue(real.length > 60,
      `前置条件不满足: src/core 只有 ${real.length} 个模块，"写死 slice(45,60)" 与` +
      ' "全覆盖"结果相同，本锁会失去区分力而变成永绿锁');

    const covered = [];
    for (let i = 0; i < BATCH_COUNT; i++) covered.push(...SD.moduleBatch(real, i));

    assertEqual(covered.length, real.length,
      `四批合并应有 ${real.length} 个模块，实际 ${covered.length} 个 —— 有模块漏扫或被重复扫`);
    assertEqual(new Set(covered).size, real.length,
      `四批合并出现重复条目（应 ${real.length} 个互异，实际 ${new Set(covered).size} 个）`);

    const missing = real.filter(m => !covered.includes(m));
    assertEqual(missing.join(', '), '',
      '这些 src/core 模块没有任何一批会扫到（step 6-9 对它们永久失明）:\n' + missing.join('\n'));
  });

  test('源码里不得再出现写死的模块切片边界', () => {
    // 必须先剥注释（周期 14/15 两次学费）: 修复说明里就写着旧的 slice(0,15) 等数字，
    // 不剥注释的源码锁会把**自己的说明**当成罪证。剥掉之后命中的只可能是真代码。
    const code = stripComments(fs.readFileSync(SD_PATH, 'utf8'));
    const bad = [];
    const re = /slice\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;
    let m;
    while ((m = re.exec(code))) {
      // moduleBatch 内部那一处是 slice(batchIndex*size, (batchIndex+1)*size)，
      // 两个参数都是表达式而非数字字面量，不会被这个正则命中。
      bad.push(`slice(${m[1]}, ${m[2]})`);
    }
    assertEqual(bad.join(', '), '',
      'self-diagnostic.js 代码里仍有写死的切片边界 —— 换掉切片数字就会重新制造漏扫:\n' +
      bad.join('\n'));
  });

  test('moduleBatch 对空表与超批序不越界', () => {
    // 边界条件: 批序越界必须返回空数组，而不是靠 slice 的宽容性蒙混
    assertEqual(SD.moduleBatch([], 0).length, 0, '空表第一批应为空');
    assertEqual(SD.moduleBatch([], 3).length, 0, '空表第四批应为空');
    assertEqual(SD.moduleBatch(['a', 'b', 'c'], 9).length, 0, '越界批序应返回空数组');
    assertEqual(SD.moduleBatch(['a', 'b', 'c'], -1).length, 0, '负批序应返回空数组');
    assertEqual(SD.moduleBatch(null, 0).length, 0, '非数组入参应返回空数组而不是抛异常');
  });
};
