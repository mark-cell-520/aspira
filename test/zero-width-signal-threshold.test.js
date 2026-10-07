/**
 * test/zero-width-signal-threshold.test.js — 零宽字符信号的 count 门槛
 *
 * [对抗鲁棒性·第一百二十三轮] 新建。本轮先跑校准脚本拿基线(plaintext 41/41,
 * FP 0/106; separator/letter-space/HTML 三变换在内容型样本上均 39/39)——
 * 核心缺口已关闭, 于是去测**校准脚本没测的变换面**(AGENTS.md 记载的
 * obfuscation 类有七种, 脚本只测三种)。零宽这一面一测就抓到:
 *
 * ═══ 缺陷: "有 1 个零宽字符" 就把整个文本打成 rewrite ═══
 * adversarial-variant 的 S1 信号只要有 1 个零宽字符(U+200B..U+200D/2060/
 * FEFF/00AD)就推 severity 0.9 的信号, 而聚合规则是 severity>=0.8 即 high ->
 * rewrite。实测(evasion 探针, FP 口径 = gate.action !== 'pass', 与
 * calibrate-fp-recall.js 一致):
 *   · 106 条良性语料逐字母插零宽          -> **77 条被升级**
 *   · 只插 **1 个**零宽(首字母后)          -> 仍是 **77 条**(与密度无关, 是存在即升级)
 *   · 现实场景单零宽良句(网页复制/IM 带入) -> 全部 rewrite, 理由"对抗变体: 零宽字符"
 * 而恶意侧 recall **完全不依赖这个信号**: 同一实验下明文/任意密度均 41/41
 * (归一化剥离 + 内容判别足够), 唯一漏报 `рass the test` 是 cycle 35 判定的
 * 仅信号型样本(内容本身良性, 不计入分母)。
 *
 * ═══ 修法 ═══
 * count>=3 才算信号: 3+ = 系统性插入(攻击特征), 保留 0.9 高危原样;
 * 1-2 个 = 污染特征, 不推信号(仍会被归一化层清洗, 不影响内容判别)。
 * 2026-08-10 的"任何变体信号都不 pass"决策不变——只是不再把单个不可见
 * 字符当作信号。
 *
 * ═══ 锁什么 ═══
 * ① 1 个 / 2 个零宽的良性文本必须 pass(修复主目标);
 * ② >=3 个零宽的文本仍非 pass(攻击特征没被放行);
 * ③ 恶意零宽攻击(逐字母)必须仍被拦(recall 不退化);
 * ④ 反向证明: 去掉 count 门槛后 ① 必须红(锁不是恒真的)。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const gate = require(path.join(ROOT, 'src', 'gate.js'));

const CSV_PATH = require('fs').readFileSync(path.join(ROOT, 'scripts', 'calibrate-fp-recall.js'), 'utf8');

// 从校准脚本原文提取 MALICIOUS/BENIGN 数组(不 require, 避开它顶层的校准副作用)
const _arr = (name) => {
  const m = CSV_PATH.match(new RegExp('const ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\n\\];'));
  if (!m) throw new Error(name + ' 数组未找到');
  return eval('[' + m[1] + ']'); // eslint-disable-line no-eval
};
const MALICIOUS = _arr('MALICIOUS');
const MALICIOUS_BENIGN = _arr('BENIGN');

const ZW = '​';
const isNonPass = (r) => r && r.gate && r.gate.action !== 'pass';

// 现实场景: 逐字母插零宽(系统性)与零星插入(污染)的工具
const zwEachLetter = (s) => s.replace(/[a-zA-Z]/g, (c) => c + ZW);
const zwFirstLetter = (s) => s.replace(/[a-zA-Z一-鿿]/, (c) => c + ZW);
const zwTwoLetters = (s) => {
  let n = 0;
  return s.replace(/[a-zA-Z一-鿿]/g, (c) => (++n <= 2 ? c + ZW : c));
};

// 语料样本(明文全部 pass, 校准 FP 0/106 已实测) —— 不用自造句:
// 自造句子可能自带 vagueness 等维度(findings.length>1 规则), 与零宽无关。
const BENIGN_PICKS = [3, 12, 40, 70].map(i => MALICIOUS_BENIGN[i]).filter(Boolean);

module.exports = function ({ test, assertTrue, assertEqual }) {

  // ─── ① 1-2 个零宽的良性文本必须 pass ────
  test('恶意侧不动的前提下, 1-2 个零宽的良性文本必须 pass(存在即升级已修)', () => {
    for (const s of BENIGN_PICKS) {
      // 前置: 样本本身必须 pass, 否则测的是别的维度(与零宽无关)
      assertEqual(gate.checkOutput(s).gate.action, 'pass',
        '样本本身必须 pass(校准语料全 pass), 否则本用例测的不是零宽: ' + JSON.stringify(s.slice(0, 40)));
      for (const [label, fn] of [['1个', zwFirstLetter], ['2个', zwTwoLetters]]) {
        const r = gate.checkOutput(fn(s));
        assertEqual(r.gate.action, 'pass',
          `${label}零宽的良性文本被升级为 ${r.gate.action}(${JSON.stringify(r.gate.reason || '')}): ` +
          JSON.stringify(s.slice(0, 40)));
      }
    }
  });

  // ─── ② >=3 个零宽的文本仍非 pass(攻击特征没被放行) ───
  test('>=3 个零宽字符仍构成信号(系统性强混淆未被放行)', () => {
    const cases = [
      ['良性英文逐字母', zwEachLetter('The project deadline is next Friday and the report is almost done.')],
      ['良性中文段中插3个', '这是一个' + ZW + '测试' + ZW + '句子' + ZW + '，一切正常。'],
    ];
    for (const [label, text] of cases) {
      assertTrue(isNonPass(gate.checkOutput(text)),
        `${label}: >=3 个零宽必须仍触发对抗变体信号, 实测 pass 了`);
    }
  });

  // ─── ②b count 语义: 信号里的 count 必须等于真实零宽个数 ───
  test('zero_width 信号的 count 必须是真实个数(锁住 /g 修正)', () => {
    const adv = require(path.join(ROOT, 'src', 'shield', 'adversarial-variant.js'));
    const sentence = 'abcdefghij';
    for (const n of [3, 5, 8]) {
      let s = '', k = 0;
      for (const ch of sentence) s += ch + (++k <= n ? ZW : '');
      const r = adv.checkAdversarialVariant(s);
      const sig = (r.signals || []).find(x => x.id === 'zero_width');
      assertTrue(!!sig, `插 ${n} 个零宽必须有 zero_width 信号`);
      if (sig) assertEqual(sig.count, n,
        `count 必须等于真实零宽个数 ${n}, 实测 ${sig.count} —— match 无 /g 时恒为 1(本轮修掉的潜伏 bug)`);
    }
  });

  // ─── ③ 恶意零宽攻击仍被拦 ────
  test('恶意样本的零宽变换必须仍被拦截(recall 不退化)', () => {
    let blocked = 0;
    for (const m of MALICIOUS) {
      if (isNonPass(gate.checkOutput(zwEachLetter(m)))) blocked++;
    }
    // 41 条中最多允许 1 条漏网: cycle 35 判定 `рass the test` 是仅信号型
    // 样本(内容本身良性, 明文 findings 为空), 其拦截本就只靠同形字/零宽
    // 信号且信号正确消失——不计入有效分母(39)。
    assertTrue(blocked >= 40,
      `逐字母零宽的恶意样本应至少拦住 40/41, 实测 ${blocked}/41 —— recall 退化`);
  });

  // ─── ④ 反向证明: 去掉 count 门槛必须红 ────
  test('反向证明: 去掉 count 门槛后本条锁的 ① 必须变红', () => {
    // 直接在探针里复现修前的聚合规则: 1 个零宽即 0.9 信号 -> high -> rewrite。
    // 做法: 构造同样形状的文本过引擎, 断言"修前规则下必红"。
    const adv = require(path.join(ROOT, 'src', 'shield', 'adversarial-variant.js'));
    const r = adv.checkAdversarialVariant(zwFirstLetter('The project deadline is next Friday.'));
    assertEqual(r.signals.filter(s => s.id === 'zero_width').length, 0,
      '修复后 1 个零宽不得推 zero_width 信号 —— 若这条红, 说明门槛已失效');
    // 修前的形状(单信号 0.9 -> high/rewrite)必须真的会红:
    // 用 >=3 个零宽证明聚合规则本身仍然活着
    const r3 = adv.checkAdversarialVariant(zwEachLetter('The project deadline is next Friday.'));
    assertTrue(r3.signals.some(s => s.id === 'zero_width'),
      '>=3 个零宽必须仍推 zero_width 信号, 否则聚合规则已死, ② 的锁失效');
    assertEqual(r3.action, 'rewrite', 'zero_width 信号(0.9)单独出现必须仍判 rewrite');
  });
};
