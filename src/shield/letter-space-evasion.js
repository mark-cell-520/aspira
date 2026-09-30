/**
 * src/shield/letter-space-evasion.js
 *
 * ═══ 由来(第十八轮, adversarial-robustness 切片) ═══
 * 已知缺口: 字母间距规避召回 **39%**(16/41) 对明文召回 **100%**(41/41)。
 * 规避变换是 `s.replace(/([a-z])([a-z])/gi, (m,a,b) => a + ' ' + b)`，
 * 它把 `disgusting nigger` 变成 `d i s g u s t i n g n i g g e r`
 * —— **一整串单字母**。
 *
 * ═══ 为什么"折叠还原"这条路走不通 ═══
 * 曾把 `strip_letter_space` 放宽到 1-2 字母 token，实测折叠 53 个良性样本
 * 只换回 1 个恶意样本，已回滚。本轮重新测量后确认根因比"放宽阈值"更深:
 * 规避变换**有损**。原文里 `disgusting` 与 `nigger` 之间那个空格，和变换
 * 插进去的每一个空格**完全同形**，折叠后得到 `disgustingnigger`，
 * 词边界不可恢复地丢失 —— 而 /\bnigger\b/ 恰好要求词边界。
 * 也就是说: **任何"先还原再匹配"的方案都有一个由变换本身决定的上限。**
 *
 * ═══ 本模块的思路: 不还原，改成容忍空格地匹配 ═══
 * 词形 `nigger` 编译成 `\bn\s*i\s*g\s*g\s*e\s*r\b`，
 * 直接在**原文上**匹配: `n i g g e r` 命中，且首尾 `\b` 依然成立
 * (两侧本来就是空格)。不折叠、不粘连、不丢边界。
 *
 * ═══ 两个必须遵守的边界 ═══
 * 1) **`\s*` 匹配零个空格，所以每个空格容忍模式都是其明文模式的超集。**
 *    这意味着它只能用于**引擎在明文下已经拦截**的术语 ——
 *    对一个良性词启用它，等于把良性词变成误报。
 *    实测踩过: 从模式表自动提取字面量时提出 `always`/`rather` 这类良性词，
 *    编译成 `a\s*l\s*w\s*a\s*y\s*s` 后 4 个良性样本立刻被误报。
 *    所以本表**只收明文下已被 hate_speech / 注入类模式拦下的术语**，
 *    加空格容忍只会增加召回、不可能新增误报 —— 这一点由测试双向锁定。
 * 2) **只在确认命中术语时才发信号，不是"检测到字母间距就发信号"。**
 *    后者会把正常文本(如 "h a t e speech is unacceptable" 这种讨论仇恨
 *    言论的良性句)也判成对抗变体。术语命中才是证据。
 *
 * ═══ 实测(本轮，语料 106 benign / 41 malicious) ═══
 *   明文召回 41/41(100%)，字母间距规避召回 16/41(39%)。
 *   接入本模块后: **29/41(71%)**，额外回收 13 个;
 *   良性样本误报 **0/106**(改动前 0，改动后仍 0)。
 * 未回收的 12 个已披露，不静默当成已解决:
 *   8 个是代码类(`eval(userInput)`、`new Function(userInput)`、
 *     `innerHTML`、`document.write`、SQL 拼接、`exec`、RSA 私钥、password)
 *     —— 需要的是代码语义模式，不是词表;
 *   `women belong in the kitchen 女人就该待在厨房` 是多词短语，
 *     短语级空格容忍需要单独一轮(且要测中英混排);
 *   `all f_aggot_s must die` 属下划线分隔族(`strip_separator` 的范畴)，
 *     与本模块的字母间距族不同。
 */
'use strict';

/**
 * 空格容忍词表 —— **只收录引擎在明文下已经拦截的术语**。
 * 分组仅用于可读性与将来的定向扩展，不影响匹配。
 * 加词的标准: 该词的明文形式必须已经被 src/index.js 的某个模式拦下，
 * 且语料 BENIGN 全量不误报。两者都由 test/letter-space-evasion.test.js 锁定。
 */
const LETTER_SPACE_TERMS = Object.freeze([
  // 种族/民族蔑称 —— 明文由 hate_speech 的种族类模式拦下
  'nigger', 'niggers', 'negro', 'negroes',
  'faggot', 'faggots', 'fag', 'fags',
  'dyke', 'dykes', 'queer', 'queers',
  'spic', 'spics', 'kike', 'kikes',
  'chink', 'chinks', 'coon', 'coons',
  'gook', 'gooks', 'wetback', 'wetbacks',
  'paki', 'pakis', 'wop', 'wops', 'raghead',
  // 性别蔑称/脏话 —— 明文由 hate_speech 的性别类模式拦下
  'slut', 'sluts', 'whore', 'whores',
  'bitch', 'bitches', 'cunt', 'cunts',
  // 注入/越狱短语 —— 明文由注入类模式拦下
  'ignore all previous instructions',
  'disregard the above',
  'developer mode',
  'no restrictions',
  'reveal your system prompt',

  // [第三十二轮] 代码/密钥类 —— 模块原注释称这 8 条"需要代码语义模式，
  // 不是词表"。重新测量后修正那个判断: 本模块的**两段判定**已经提供了
  // 词表无法自带的上下文锚定，因此这些词可以安全收录。
  //
  // 为什么不误报(双向实测，见 test/letter-space-evasion.test.js):
  //   · 第 1 段按序匹配，第 2 段要求命中片段里**至少一个词真的含空白**。
  //     所以明文 exec / password / eval / select 单独出现一律不报
  //     (/\s/.test("exec") 为 false)。只有 "e xe c" / "p as sw or d" 才报。
  //   · 每个词两头都有 \b，所以 exec 不会命中 execute/executive，
  //     select 不会命中 selection。
  //   · 规避变换的产物在自然语言里几乎不可出现(字母被切开)，故第 2 段
  //     本身就是强锚点 —— 这正是它与"需要 eval( 这种语法锚点"方案的区别。
  //
  // 收录前提遵守边界规则 1: 下列术语的**明文形式**均已被 src/index.js 的
  // code_security / 密钥类模式拦下(明文召回 41/41)，故启用空格容忍只可能
  // 增加召回。逐条实测确认 BENIGN 106 条不新增误报。
  // 代码执行
  'eval', 'exec', 'execSync', 'Function',
  // XSS sink
  'innerHTML', 'document.write',
  // SQL 拼接。注意用单词 `SELECT` 而非短语 `SELECT FROM`: 规避变换后
  // 原文的 `SELECT * FROM` 变成 `S E L E C T * F R O M`，SELECT 与 FROM
  // 之间隔着 `*`，而编译器要求词间是 `\s+`，短语永远配不上(实测确认)。
  // 单词 SELECT 由两段判定兜底: 明文 "select" 不含内部空白，不会误报。
  'SELECT',
  // 密钥/凭据泄露
  'BEGIN RSA PRIVATE KEY', 'password',
]);

/**
 * 把术语编译成匹配器组。
 *
 * 形态: 每个**词**内部字母之间允许 `\s*`，词与词之间要求 `\s+`。
 *   nigger                        -> \bn\s*i\s*g\s*g\s*e\s*r\b
 *   ignore all previous instructions
 *     -> \bi\s*g\s*n\s*o\s*r\s*e\s+a\s*l\s*l\s+...
 *
 * ⚠️ `\s*` 匹配**零个**空格，所以每个编译结果都是其明文形式的超集。
 * 这不是缺陷而是必要的(明文形式本来就被同一些模式拦下)，但它带来一个
 * 命名问题: 若直接报告命中，明文 `nigger` / `developer mode` 也会被说成
 * "字母间距混淆"——**一个把自己的误报说成检测成功的信号，比没有信号更糟。**
 * 所以判定必须是两段的:
 *   1) 整条术语按序出现(spaced 形态，允许零空格);
 *   2) **且至少有一个词是"字母被拆开"的形态**(字母间至少一个空白)。
 * 第 2 条把明文形态排除掉: 明文 `developer mode` 的词间空白是合法语法，
 * 不是规避; `d e v e l o p e r mode` 才是。
 */
/**
 * 判定"这个词在命中片段里真的是被空格拆开的形态"。
 *
 * ⚠️ 这里第一次写错过，值得记: 原先要求**每两个相邻字母之间都有空白**
 * (`\s+`)，实测完全失效——规避变换的产物不是均匀的 "n i g g e r"，
 * 而是**字母成对分组**: `n ig ge r`(变换是 replace(/([a-z])([a-z])/gi,
 * a+' '+b)，非重叠配对，所以残留 `ig`/`ge` 这类双字母段)。
 * 在 `n ig ge r` 里，`i` 与 `g` 之间**没有**空格，严格的 `\s+` 判定就此失败，
 * 于是模块对真正的规避形态一律报"未检出"。
 *
 * 正确判据: 该词的字母序列中**至少有一处**空白即可
 * (全零空白就是明文原形，那不是规避)。
 */
function wordIsSpaced(word, haystack) {
  const spaced = new RegExp(
    '\\b' + word.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*').join('').replace(/\\s\*$/, '') + '\\b',
    'i');
  const m = haystack.match(spaced);
  return !!(m && /\s/.test(m[0]));
}

const COMPILED = LETTER_SPACE_TERMS.map(term => {
  const words = term.split(/\s+/);
  return {
    term,
    // 整条术语: 词间至少一个空白
    full: new RegExp('\\b' + words.map(w => w.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*').join('').replace(/\\s\*$/, '')).join('\\s+') + '\\b', 'i'),
    words,
  };
});

/**
 * 检测"用字母间距隐藏的已知恶意术语"。
 * @returns {{ detected: boolean, hits: Array<{term: string, match: string}>, terms: number }}
 */
function checkLetterSpaceEvasion(text) {
  if (typeof text !== 'string' || !text.length) {
    return { detected: false, hits: [], terms: LETTER_SPACE_TERMS.length };
  }
  const hits = [];
  for (const { term, full, words } of COMPILED) {
    const m = text.match(full);
    if (!m) continue;
    // 第二段判定: 至少有一个词在命中片段里真的被空白拆开。
    // 只在 m[0] 里查，避免术语在别处正常出现被误判。
    if (words.some(w => wordIsSpaced(w, m[0]))) hits.push({ term, match: m[0].slice(0, 40) });
  }
  return { detected: hits.length > 0, hits, terms: LETTER_SPACE_TERMS.length };
}

module.exports = { checkLetterSpaceEvasion, wordIsSpaced, LETTER_SPACE_TERMS };
