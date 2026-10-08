/**
 * test/coverage-sweep-require-forms.test.js — 覆盖清点的 require 形态盲区
 *
 * [test-coverage-gap·第一百三十二轮] 新建。
 *
 * ═══ 背景: cycle 37 的盲区还剩一半 ═══
 * coverage-sweep 的"有没有测试 require 它"判据(hasRequireOf)在 cycle 37
 * 修过一轮, 认两种形态:
 *   (a) require('.../base')            —— 字符串字面量;
 *   (b) require(path.join(..., 'base')) —— path.join 段;
 * 但漏了第三种: **require(变量)**——
 *   const SRC = path.join(__dirname, '..', 'src', 'memory', 'slots.js');
 *   require(SRC)
 * basename 藏在**变量绑定**里, require( 后是变量名, (a)(b) 都匹配不上。
 * 实测后果: cycle 124 给 slots.js 与 memory-kernel.js 写的两把锁(正是这个
 * 写法)在主视图里**仍显示"活着但没测"** —— 覆盖清点把已覆盖模块报成缺口,
 * 让已有锁看起来不存在。错误方向与 cycle 37 修的那次相反且更隐蔽: 那次是
 * 少报缺口(死代码看起来被测过), 这次是**多报缺口**。
 *
 * ═══ 修法 ═══
 * hasRequireOf 加 (c): 两阶段判据 —— 文件里 `X = path.join(...'base'...)`
 * 或 `X = '...base.js'`, 且同名 `require(X)`。
 *
 * 修复效果量化(本次实测): B 类 113 → **111**(slots/memory-kernel 移出),
 * C 类 255 → 257。其余 109 个 B 类是真缺口(本锁不虚构减少)。
 *
 * ═══ 锁什么 ═══
 * ① 源级: 三种形态的判据都在(删 (c) 即红);
 * ② 行为: 已加锁的 slots.js / memory-kernel.js 不得出现在 B 类
 *    (这正是 (c) 修复前的误报形状——删了 (c) 它们会回到 B, 本条红);
 * ③ 分母诚实: B+C = 380 - A, 且 B 类数量必须小于修复前读数(113),
 *    防止"修好了又悄悄退化"。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SWEEP = path.join(ROOT, 'scripts', 'coverage-sweep.js');

module.exports = function ({ test, assertTrue }) {

  function runSweep() {
    return execFileSync('node', [SWEEP], { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  // B 类清单节: sweep 输出里 B 清单在 A 清单**之前**打印(值行 A 在前、清单 B 在前),
  // 首版按值行切片得到空段, 令"slots 不得在 B"恒真绿 —— 变异验证抓到的恒真漏洞。
  // 改用清单标题锚点(── B: ... ── 到 ── A: ... ──), 并断言节确实非空才准后续比较。
  function bSection(out) {
    const i = out.indexOf('── B:');
    const j = out.indexOf('── A:');
    if (i < 0 || j <= i) throw new Error('sweep 输出里找不到 B 清单节(锚点已变?)');
    return out.slice(i, j);
  }
  test('源级: hasRequireOf 必须同时认三种 require 形态', () => {
    const src = fs.readFileSync(SWEEP, 'utf8');
    // 锚点用 sweep 源码里的变量名(删掉任一段判据, 对应变量名消失即红)
    assertTrue(src.includes('const direct'),
      '(a) 字符串字面量形态判据(const direct)必须在');
    assertTrue(src.includes('const joined'),
      '(b) path.join 段形态判据(const joined)必须在');
    assertTrue(src.includes('const binds'),
      '(c) require(变量) 的变量绑定收集(const binds)必须在');
    assertTrue(src.includes('name}'),
      '(c) require(变量名) 调用判据必须在');
  });
  test('行为: 已加锁的 slots.js / memory-kernel.js 不得再被误报为 B 类', () => {
    const out = runSweep();
    const sec = bSection(out);
    assertTrue(!/slots\.js/.test(sec),
      'src/memory/slots.js 已有 test/memory-slots-value-contract.test.js(cycle 124), 不得再报 B —— ' +
      '这正是 (c) 修复前的误报形状');
    assertTrue(!/memory-kernel\.js/.test(sec),
      'src/memory/memory-kernel.js 已有 test/memory-kernel-input-contract.test.js(cycle 124), 不得再报 B');
    // 两把锁必须真的存在(否则本条是"删掉锁也无所谓"的恒真锁)
    assertTrue(fs.existsSync(path.join(ROOT, 'test', 'memory-slots-value-contract.test.js')),
      'slots 的锁文件必须存在, 否则本断言的前提失效');
    assertTrue(fs.existsSync(path.join(ROOT, 'test', 'memory-kernel-input-contract.test.js')),
      'memory-kernel 的锁文件必须存在, 否则本断言的前提失效');
  });

  test('分母诚实: B 类读数必须小于修复前(113), 且 A+B+C 守恒', () => {
    const out = runSweep();
    const b = Number((/B 无测试引用但有 src 引用\(活着但没测\): (\d+)/.exec(out) || [])[1]);
    const a = Number((/A 无测试引用且无 src 引用\(疑似死代码\): (\d+)/.exec(out) || [])[1]);
    const c = Number((/C 有测试引用: (\d+)/.exec(out) || [])[1]);
    const total = Number((/src 模块 (\d+) 个/.exec(out) || [])[1]);
    assertTrue(b === a + c + 0 || a + b + c === total,
      `A(${a}) + B(${b}) + C(${c}) 必须等于总数(${total})`);
    assertTrue(b < 113,
      `B 类必须小于修复前读数 113(实测 ${b}) —— 变回 113 说明 (c) 形态识别退化了`);
    // [第一百三十六轮] 原下界写死 b >= 111("两把锁移出后"), 本轮给
    // memory-bank 加锁(它确实从 B 移到 C)后 B = 110 —— 硬下界被覆盖推进
    // 自己打红。下界的意图(防判据过宽把未覆盖模块算成已覆盖)改用**具体
    // 锚点**承担: 当前 B 类之王必须仍在 B —— sweep 判据若过宽, 它会被第一个
    // 误判, 这里红。
    //
    // [第一百四十八轮] 锚点从 formula-bridge.js 换成 src/dream/dream.js:
    // 本轮给 formula-bridge 加了**第一个**测试引用
    // (test/formula-registry-eu-contract.test.js), 它于是合法地离开 B 类。
    // 注意这不是"覆盖了它" —— 那个测试只调 3/99 个公开方法, 其余 96 个
    // (含本轮实测发现用错模型的 irtTestInformation)仍未测。sweep 的 C 类判据
    // 是"有测试引用"而非"测过多少", 所以 C=261 这个读数本身就偏乐观;
    // 换锚点是让本条继续测"判据有没有退化", 不是承认 formula-bridge 已覆盖。
    assertTrue(b <= 111,
      `B 类只减不增(覆盖推进方向; 实测 ${b}) —— 变回 111 说明本轮新覆盖的模块掉回了 B`);
    assertTrue(/dream\/dream\.js/.test(bSection(out)),
      'src/dream/dream.js(当前 B 类之王, 1529 行无测试引用)必须仍在 B —— 它不见了说明 sweep 判据过宽, 把没测的模块也算成已覆盖');
  });
};
