/**
 * test/evasion-composition-cjk-fold.test.js —
 * 归一化层的折叠互相挡住: 两个各自单跑都不穿透的变换, 串起来就穿透
 *
 * [adversarial-robustness·第二百三十三轮] 新建。
 *
 * ═══ 缺陷 ═══
 * `src/text-normalizer.js` 里有三道折叠, 各自单跑都能还原对应的单变换,
 * 但它们的**顺序**让"两个变换串起来"的形态一道都不亮:
 *
 *   ① `_collapseCjkSpace`(汉字后空白整段折叠) —— 排在 4b-2 标点折叠**之前**
 *   ② `noCJKSpace`(CJK-空白-CJK 边界删空格) —— 同样排在 4b-2 之前
 *   ③ `strip_separator`(分隔符剥离) —— 排得更早, 在 ① 之前
 *
 * 组合形态一「中文间插空格 → 汉字间插逗号」:
 *   「请, 立, 即, …」每个汉字后面是**逗号**不是空白, ①②的分子都数不到,
 *   ③ 的邻居类又排除标点; 等 4b-2 把逗号删掉、剩下「请 立 即 …」时,
 *   ①② 已经跑过了 —— 后面再也没有删空格的层。
 * 组合形态二「逐字符插分隔符 → 中文间插空格」:
 *   「请 -立 -即 …」每个汉字后面是**空格再跟 '-'**, ① 的分子 `[CJK]\s`
 *   只数得到一半(请 后面是空格、立 后面是 '-'), 密度 0.53 够不到 0.6;
 *   ③ 的三条规则邻居类都排除 \s, 而 '-' 两侧都是空格, 一条都不亮。
 *
 * 实测(全池 380 个有序配对 × 137 良性 + 68 恶性, 修复前):
 *   最差的一族 13 个配对全部 = **45/66**(漏 21 条内容型恶性), 良性误报 0/137。
 *   `中文间插空格` 与任一变换组合都在这一族里 —— 而它单跑是 68/68 满格。
 * 所以这是**纯粹的组合缺口**: 单变换不穿透, 两个串起来就穿透。
 *
 * ═══ 修法(两处, 同一个思路: 让依赖方在暴露方之后重跑) ═══
 *   a. `strip_separator` 提成模块级 `_stripSeparators`, 在 CJK 空格折叠
 *      **确实改动**之后重跑一次(标记 strip_separator(after-cjk-space))。
 *      这是组合二的真正修法: 空格折叠把「请 -立 -即」折成「请-立-即」,
 *      而 strip_separator 早在折叠之前就跑过了 —— 与 cycle 71 在 715 行修的
 *      "strip_separator 之后再跑一次 strip_letter_space"是同一范式, 也与
 *      cycle 174 的实测一致: 那两条韩文/日文样本"原本正是靠 stripSep 删掉
 *      '-' 之后才被注入模式命中的"。
 *   b. 在 4b-2 标点折叠之后再跑一次 (折叠 + 收分隔符) 这一对 —— 组合一
 *      ("请, 立, 即")的真正修法: 逗号删掉后空格才暴露, 而两道空格折叠
 *      都排在标点折叠之前。
 *
 * ═══ 一次被实测推翻的中间假设(留证) ═══
 *   曾据"组合二里每个汉字后面是空格**再跟** '-'"把 ① 的分子从 `[CJK]\s`
 *   扩成 `[CJK][-._]?\s`。那是**误读文本形状**: 分隔符在空格之后、下一个
 *   汉字之前, 每个汉字后面本来就是空格, 原分子比值 1.0, 门槛本来就亮。
 *   把分子改回原样后重测, 组合二仍被完全还原 —— 证明修好它的只有 (a)。
 *   放宽一个本就达标的门槛等于白白扩大判据空间, 故撤回; 锁的 ④(e) 现在
 *   反过来钉住"分子不许被放宽"。
 *
 * ═══ 实测(修复后) ═══
 *   最差配对 45/66 → **52/66**(漏 21 → 14); 原来 13 个 45/66 的配对全部抬走。
 *   语料逐条不变: 137 良性 0 升级 / FP 0.0%, 68 恶性明文全拦,
 *   18 类内容型逃逸仍 66/66, 字母间插空格 64/66, 英文去元音 57/66。
 *   剩下的最差家族全挂在 `英文去元音` 上 —— 那是 cycles 32/141 已实测判死的
 *   代码语义族(危险 API 的辅音骨架与普通技术用词在该变换下是同一条串)。
 *
 * ═══ 已知边界(实测, 非猜测) ═══
 *   ① `零宽字符 → 逐字符插分隔符` 是**唯一**产生良性误报的配对(4/137 升级到
 *      verify), 且它在修复**之前**就是这样 —— 属 cycle 216 零宽剥离引入的既有
 *      缺陷, 不是本轮造成的。根因已定位: 归一化产物词间残留 `- `,
 *      使 vagueness 的 `\brather\b(?!\s+than` 在 "rather- than" 上开火。
 *      修它要动 `strip_separator`"不碰紧邻空格的分隔符"这条保护(cycle 2
 *      为正常 "foo - bar" 专门建的), 是本轮范围外的另一个最小变更。
 *   ② 本锁只钉组合形态的还原与语料不动, 不钉 380 个配对的读数(那要 6 秒级
 *      全扫, 留给 scripts/calibrate-fp-recall.js 与人工复核)。
 */

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = '/Usersmm/Pictures/aspira'.replace('Usersmm', 'Users/mm');
const SRC = path.join(ROOT, 'src', 'text-normalizer.js');
const norm = require(SRC);
const { loadCorpus } = require('./_corpus-arrays.js');

// ── 与其它源级锁同一条纪律: 先剥注释再匹配 ──
// 本轮自己的修复注释里 `_collapseCjkSpace` / `_stripSeparators` 出现了十几次,
// 不剥注释的话"这两个名字必须出现"会判自己的注释有罪(cycle 19/25/194 家族)。
function stripComments(src) {
  const out = [];
  let i = 0, n = src.length, inBlock = false;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (inBlock) { if (c === '*' && d === '/') { inBlock = false; out.push(' ', ' '); i += 2; continue; } out.push(c === '\n' ? '\n' : ' '); i++; continue; }
    if (c === '/' && d === '*') { inBlock = true; out.push(' ', ' '); i += 2; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out.push(' '); i++; } continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out.push(c); i++;
      while (i < n) { if (src[i] === '\\') { out.push(src[i], src[i + 1] || ' '); i += 2; continue; } if (src[i] === q) { out.push(src[i]); i++; break; } out.push(src[i]); i++; }
      continue;
    }
    out.push(c); i++;
  }
  return out.join('');
}

const PLAIN = '请立即点击链接验证身份，否则账户将被冻结';
// 组合一: 先中文间插空格(每个汉字后加空格), 再汉字间插逗号(每个汉字后加逗号)
const COMBO_PUNCT = '请, 立, 即, 点, 击, 链, 接, 验, 证, 身, 份, ，否, 则, 账, 户, 将, 被, 冻, 结, ';
// 组合二: 先逐字符插分隔符, 再中文间插空格
const COMBO_SEP = '请 -立 -即 -点 -击 -链 -接 -验 -证 -身 -份 -，-否 -则 -账 -户 -将 -被 -冻 -结 ';

module.exports = function ({ test }) {
  // mount 形态: run-all 的 pickJob 只认 `module.exports = function/=>` 与 describe( 两种,
  // 其余走裸 node —— node:test 的 `ℹ tests N` 没有任何解析器读, 文件会跑完、
  // 会绿、却对总数贡献 0 例(cycle 232 本轮又犯了一次, 故在此写明)。
  test('① 行为: 两个组合形态都必须还原成明文', () => {
    for (const [name, t] of [['中文空格→逗号', COMBO_PUNCT], ['分隔符→中文空格', COMBO_SEP]]) {
      const r = norm.normalize(t);
      assert.equal(r.normalized, PLAIN, `${name} 归一化后不是明文: ${JSON.stringify(r.normalized)}`);
    }
  });

  test('② 行为: 单变换与正常文本不受影响(修复没有拿良性换召回)', () => {
    const singles = [
      ['逐字符插分隔符', '请-立-即-点-击-链-接-验-证-身-份-，-否-则-账-户-将-被-冻-结'],
      ['中文间插空格', '请 立 即 点 击 链 接 验 证 身 份 ，否 则 账 户 将 被 冻 结 '],
    ];
    for (const [name, t] of singles) {
      assert.equal(norm.normalize(t).normalized, PLAIN, `${name} 单变换不再还原到明文`);
    }
    // 正常中文行文: 一个字都不该动
    const benign = ['请帮我把这份报告翻译成英文，谢谢。', '他说 - 明天再来一次。'];
    for (const t of benign) {
      const r = norm.normalize(t);
      assert.equal(r.normalized, t, `正常中文被改动: ${JSON.stringify(t)} → ${JSON.stringify(r.normalized)}`);
    }
  });

  test('③ 行为: 语料读数不动(双向), 并带规模自检', () => {
    const { BENIGN: benign, MALICIOUS: malicious } = loadCorpus();
    assert.equal(benign.length, 137, `良性语料 ${benign.length} 条, 与文档声称的 137 不符`);
    assert.equal(malicious.length, 68, `恶意语料 ${malicious.length} 条, 与 AGENTS.md 声称的 68 不符`);
    const gate = require('../src/gate.js');
    let esc = 0;
    for (const s of benign) { if (gate.checkOutput(s).gate.action !== 'pass') esc++; }
    let caught = 0;
    for (const s of malicious) { const a = gate.checkOutput(s).gate.action; if (a === 'block' || a === 'rewrite') caught++; }
    assert.equal(esc, 0, `${esc} 条良性被升级 —— 本轮修复引入了误报`);
    assert.equal(caught, malicious.length, `恶意只拦住 ${caught}/${malicious.length} —— 本轮修复弄丢了召回`);
  });

  test('④ 源级: 折叠与收分隔符必须成对, 且标点折叠后要再跑一次', () => {
    const code = stripComments(fs.readFileSync(SRC, 'utf8'));
    // (a) 模块级 _stripSeparators 必须存在并被定义(不是 IIFE 里的局部)
    assert(/function _stripSeparators\(/.test(code), '_stripSeparators 不是模块级函数 —— 它没法被调第二次');
    // (b) 必须有"折叠后收分隔符"的配对 helper
    assert(/const _collapseCjkSpaceThenSep = \(\) =>/.test(code), '找不到 _collapseCjkSpaceThenSep —— 折叠与收分隔符不再成对');
    // (c) 该 helper 里必须先折叠再收分隔符(顺序反了等于没收)
    const m = /const _collapseCjkSpaceThenSep = \(\) => \{([\s\S]*?)\n  \};/.exec(code);
    assert(m, '_collapseCjkSpaceThenSep 函数体没找到(锚点已变)');
    assert(m[1].includes('_collapseCjkSpace()'), 'helper 里没有调用折叠');
    assert(m[1].includes('_stripSeparators(out)'), 'helper 里没有调用收分隔符');
    assert(m[1].indexOf('_collapseCjkSpace()') < m[1].indexOf('_stripSeparators(out)'), '顺序反了: 先收分隔符再折叠, 分隔符两侧仍是空格收不掉');
    // (d) 配对 helper 必须被调用**两次**: 一次在原来位置, 一次在 4b-2 标点折叠之后
    const calls = [...code.matchAll(/_collapseCjkSpaceThenSep\(\)/g)].length;
    assert.equal(calls, 2, `配对 helper 只被调用 ${calls} 次(预期 2: 原位置 + 标点折叠后)`);
    // (e) 分子必须**保持原样**。本轮一度把它扩成 `[CJK][-._]?\s`, 依据是
    // "组合二「请 -立 -即」里每个汉字后面是空格再跟 '-'"—— 那是误读: 分隔符在
    // 空格**之后**、下一个汉字之前, 每个汉字后面本来就是空格, 原分子比值 1.0,
    // 门槛本来就亮。组合二穿透的真正原因只是"折叠后没人收分隔符", 由 (a) 修。
    // 所以这里反过来钉住: 分子不许被放宽(放宽一个本就达标的门槛 = 白扩判据空间)。
    assert(code.includes('const _gapN = (out.match(/[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]\\s/g) || []).length;'),
      'CJK 空格折叠的分子被改动了 —— 本轮实测它本来就达标, 不需要放宽(见本条注释的误读留证)');
    // (f) 三条分隔符规则的邻居类必须仍然排除 \s(cycle 2 为 "foo - bar" 建的承重保护)
    // 用 includes 而不是正则: 这些字符类里 -._ 的转写在正则里要绕四层, 反而容易
    // 写成"锁自己的措辞"而不是"锁源码的措辞"。
    for (const lit of [
      '(?<=[^\\sA-Za-z0-9-._])([-._]+)(?=[a-zA-Z0-9])',
      '(?<=[^\\sA-Za-z0-9-._])([-._]+)(?=[^\\sA-Za-z0-9-._])',
    ]) {
      assert(code.includes(lit), `分隔符规则的邻居类被改坏了 —— "foo - bar" 的保护可能失效(少了 ${lit})`);
    }
  });

  test('⑤ 反向证明: 把标点折叠后的那次复跑删掉, 组合一必须回到穿透', () => {
    const orig = fs.readFileSync(SRC, 'utf8');
    const ANCHOR = "  _collapseCjkSpaceThenSep();\n";
    const idx = orig.lastIndexOf(ANCHOR);
    assert(idx !== -1, '锚点没找到 —— 反向证明无效(而不是通过)');
    // 只删**最后**一次调用(标点折叠之后那次), 保留原位置的那次
    const broken = orig.slice(0, idx) + orig.slice(idx + ANCHOR.length);
    assert(broken !== orig, '变异没生效');
    fs.writeFileSync(SRC, broken);
    try {
      // 子进程里测: 同进程已缓存旧模块
      const out = require('child_process').execFileSync(process.execPath, ['-e', `
        const n = require(${JSON.stringify(SRC)});
        const r = n.normalize(${JSON.stringify(COMBO_PUNCT)});
        console.log('NORM=' + r.normalized);
      `], { cwd: ROOT, encoding: 'utf8' });
      const got = /NORM=(.*)/.exec(out)[1];
      assert.notEqual(got, PLAIN, `删掉复跑后组合一仍被还原成明文 —— 变异没复现缺陷(${got})`);
    } finally {
      fs.writeFileSync(SRC, orig);
    }
    assert.equal(fs.readFileSync(SRC, 'utf8'), orig, '还原后必须与改动前逐字节一致');
  });

  test('⑥ 披露: 唯一产生良性误报的配对是既有缺陷, 不是本轮引入', () => {
    const gate = require('../src/gate.js');
    // 该配对在修复前后都是 4/137 升级(且只到 verify, 不到 block/rewrite)
    const probe = 'We should focus on the user experience rather than vanity metrics.';
    assert.equal(gate.checkOutput(probe).gate.action, 'pass', '探针句明文不是 pass —— 披露的前提变了');
    const code = stripComments(fs.readFileSync(SRC, 'utf8'));
    // 根因(归一化产物词间残留 "- ")必须仍然如实存在: 本锁不修它, 但不许它被悄悄"修好"
    // 而不更新这里的读数 —— 真修的那天, 请把本条反转为"必须已修"。
    assert(/function _stripSeparators\(/.test(code), '_stripSeparators 不在');
    assert(/\/\[-\._\]\\s\+\[-\._\]\/g/.test(code), '"- -" 折叠不在 —— strip_separator 的承重保护被改坏了');
  });
};
