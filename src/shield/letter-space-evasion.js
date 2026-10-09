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
  // [周期77] 多词短语级空格容忍。原注释称这条'短语级空格容忍需要单独一轮'
  // ——本轮就是那一轮。实测短语的 spaced 正则(词内 \s*, 词间 \s+)能命中
  // 规避产物 'w om en b el on g i n t he k it ch en'; 判定仍以'匹配片段含空白'
  // 为准, 否则明文原形也会被算成规避形态。
  'women belong in the kitchen',

  // [fp-recall-calibration·第一百三十七轮] 英文短语级 —— 语料盲区填补(cycle 131)
  // 后的**逃逸缺口**暴露: 新入语料的 4 条英文样本(gaslighting/absolute_claim/
  // deceptive_alignment/reward 各1)在 letter-space 与 separator 变换下全部漏拦 ——
  // 英文维度模式依赖词形, obfuscation 一拆即失配(cycle 18 问题的跨维度复现)。
  // 收录纪律与既有条目一致(cycle 18 边界): **只收明文下已被拦下的术语** ——
  // 每条都实测过明文 gate 拦截来源, 且两阶段判定保证明文原形不报(只有被
  // 拆分形态才报), 防御方讨论同样安全。
  //   · 'imagining things' / 'never said that'  —— 明文由 gaslighting 拦(rewrite)
  //   · 'only correct answer'                   —— 明文由 absolute_claim 拦(rewrite)
  //   · 'hide my true capability'               —— 明文由 deceptive_alignment 拦(block)
  //   · 'gaming the benchmark'                  —— 明文由 deceptive_alignment 拦(block)
  'imagining things',
  'never said that',
  'only correct answer',
  'hide my true capability',
  'gaming the benchmark',

  // [第一百四十轮] 代码/密钥类 —— **本轮移除了第三十二轮加的 7 个代码/SQL
  // 术语，只保留密钥类 2 条。第三十二轮那个"这些词可以安全收录"的判断是错的，
  // 错在它只测了"明文不误报"，没测"变换后不误报"。
  //
  // ⚠️ 第三十二轮的推理哪里断了: 它说"规避变换的产物在自然语言里几乎不可出现
  // (字母被切开)，故第 2 段本身就是强锚点"。对 **整句都是英文的语料**成立，
  // 但变换作用于**整段文本**，于是良性英文句变换后每个词都被拆开 ——
  // 第 2 段(片段含空白)对攻击与良性同时成立，锚点失效。实测(calibrate
  // 六变换类, 122 benign): 逐字符插分隔符 **18/122 误报**、字母间插空格
  // **13/122 误报**，30 例次命中的术语**全部**出自这 7 个代码/SQL 词，
  // 第三十二轮原有的 slur/注入短语词表零误报。
  //
  // 为什么不可修(逐条试过，数据在 journal 里):
  //   · 尾边界判据(术语后跳过分隔符不得再跟字母)能修 evaluate/executive
  //     这类子串巧合，但同时砍掉攻击召回: separator 误报 18→7 的代价是
  //     letter-space 召回 57→49。同等召回下直接移除的误报是 **0**。
  //   · 代码标点锚点(要求命中处在代码上下文)无效: 良性 'eval("1+1")' 与
  //     恶意 'eval(res.data)'、良性 'el.innerHTML = "<p>"' 与恶意
  //     'el.innerHTML = userInput' 在该变换下**结构同构**，无法区分。
  //     'how do i run this function in node' 变换后 'f un ct io n' 命中
  //     Function —— function/select 是高频英文词，不是攻击信号。
  //   · 这与第十八轮记录的"变换有损"同族: 插入的空格制造了假词边界，
  //     retrieval 拆成 r-et-ri-ev-al 后 'ev al' 成了一个假词。
  //
  // 代价(如实记录，不是免费修复): 这 7 个词在 letter-space 变换类下回收的
  // 10 条样本回到漏拦，该类内容型召回 55/55 → 47/55。它们在**其余五个**
  // 变换类(逐字符分隔符/HTML/零宽/全角/大小写)仍全部被拦 —— 逐字符分隔符
  // 类 55/55 不变，因为那条路径靠 strip_separator 折叠还原，不依赖本层。
  //
  // 根本修法留给下一轮: 让 strip_letter_space 只在**整段文本都呈字母成对
  // 拆分形状**时才折叠(良性散文不会)，折叠后由 code_security 等内容层判断
  // —— 还原后良性句不命中、攻击句命中，误报与召回可同时拿到。本轮不做，
  // 因为它动归一化层、影响全部下游模式，需要单独一轮的完整回归
  // (第十八轮已实测过"无脑放宽折叠阈值"是净负的: 53 benign 换 1 malicious)。
  //
  // 保留密钥类 2 条的理由: 语料 122 条 benign 零误报，且私钥/凭据泄露是
  // block 级高危。⚠️ 但这是 **corpus-local 读数** —— 语料里没有
  // "p as sw or d" 这样的密码讨论句，真实流量有；这是语料表达不了的 FP。
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
    '\\b' + word.split('').map(c => c.replace(/[.*+?^${}()|[\\\]\\]/g, '\\$&') + '+[\\s_.-]*').join('').replace(/\[\\s_\.-\]\*$/, '') + '\\b',
    'i');
  const m = haystack.match(spaced);
  if (!m) return false;
  // 判据: 片段的分隔符数必须**超过**该词自身的字面分隔符数。
  // (只看"有没有分隔符"不行——自带点号的术语会被误判, 见 COMPILED 的 literal。)
  const own = (word.match(/[\s_.-]/g) || []).length;
  const extra = (m[0].match(/[\s_.-]/g) || []).length;
  if (extra > own) return true;
  // [第九十轮] 复读也是变形。判据从'只看分隔符超量'放宽为'变形超量'。
  // 复读超量 = 命中片段的相邻重复字母对数 - 术语自身的相邻重复字母对数。
  // 只比**相邻**重复, 所以 llama / committee / bookkeeper 按自身量算, 不超量不报。
  const deforms = s => (s.replace(/[\s_.-]/g, '').match(/(.)\1/g) || []).length;
  return deforms(m[0]) > deforms(word);
}

const COMPILED = LETTER_SPACE_TERMS.map(term => {
  const words = term.split(/\s+/);
  return {
    term,
    // [周期80] 自带标点的术语(document.write / exec() 一类)只做整条字面匹配,
    // 永不判为规避形态: 它的标点是术语自身的一部分, 不是规避插入的分隔符。
    // 这正是周期78 误报的修复点——当时一视同仁地判"字母间有分隔符",
    // document.write 自带的 '.' 于是被当成词内分隔符, FP 从 0.0% 抬到 0.9%。
    literal: /[^a-z0-9\s]/i.test(term),
    // 整条术语: 词间至少一个分隔符
    full: new RegExp('\\b' + words.map(w => w.split('').map(c => c.replace(/[.*+?^${}()|[\\\]\\]/g, '\\$&') + '+[\\s_.-]*').join('').replace(/\[\\s_\.-\]\*$/, '')).join('[\\s_.-]+') + '\\b', 'i'),
    words,
  };
});

/**
 * 把一条模式的源码编译成 **space-tolerant** 版本: 相邻的拉丁字母之间允许
 * [\s_.-]*(letter-space 变换与同族分隔符 obfuscation 的产物)。
 *
 * 判据为什么是"原模式不中而 tolerant 中": tolerant 是原模式的**超集**
 * ([\s_.-]* 匹配零个), 所以:
 *   · 明文命中 → 原模式已中(由 dangerous_instruction 层 block), 这里 continue;
 *   · 仅 tolerant 中 → 该形态只有靠容忍字母间距才可达 = 纯混淆形态才报。
 * 这是零新增 FP 的接入方式(cycle 18 的边界教训: 容忍版绝不允许把良性词变成
 * 命中——族模式全部是明文下已被 block 的犯罪方法请求)。
 *
 * 状态机要点: 跳过字符类 [...](范围里的字母插分隔符会破坏语义)、
 * 跳过反斜杠转义(\s/\w/\b 的字母不是字面字母)。
 */
function spaceTolerant(source) {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      const n = source[i + 1];
      // \w+ / \w* 也要容忍空格: letter-space 把 "working" 拆成 "w or ki ng"
      // 后 \w(不匹配空格)断链。[\w\s]+ 是 \w+ 的超集, 保持"tolerant ⊇ orig"。
      if ((n === 'w') && (source[i + 2] === '+' || source[i + 2] === '*')) {
        out += '[\\w\\s]' + source[i + 2]; i += 2; continue;
      }
      out += c + (n || ''); i++; continue;
    }
    if (inClass) { out += c; if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; out += c; continue; }
    out += c;
    const n = source[i + 1];
    if (n !== undefined && /[a-zA-Z]/.test(c) && /[a-zA-Z]/.test(n)) out += '[\\s_.-]*';
  }
  return out;
}

// [第一百三十四轮] 犯罪方法传授族(7c)的 space-tolerant 通道。
// cycle 128 实测: letter-space 变换把 7c 的动词拆成 "w ri te" 后原模式失配,
// 5 条英文样本(小说/虚构世界/论文包装/渐进/逻辑胁迫)在该变换类全漏。
// 只对含拉丁字母的 7c 模式建 tolerant(纯中文模式不受该变换影响)。
const CRIME_COMPILED = (() => {
  try {
    const { CRIME_TEACHING_PATTERNS } = require('../dangerous-instruction.js');
    return CRIME_TEACHING_PATTERNS
      .filter(re => /[a-zA-Z]/.test(re.source))
      .map(orig => {
        try { return { orig, tolerant: new RegExp(spaceTolerant(orig.source), orig.flags) }; }
        catch (_) { return null; } // 编译失败(边界模式)跳过, 不影响其他
      })
      .filter(Boolean);
  } catch (_) { return []; }
})();

/**
 * 检测"用字母间距隐藏的已知恶意术语"。
 * @returns {{ detected: boolean, hits: Array<{term: string, match: string}>, terms: number }}
 */
function checkLetterSpaceEvasion(text) {
  if (typeof text !== 'string' || !text.length) {
    return { detected: false, hits: [], terms: LETTER_SPACE_TERMS.length };
  }
  const hits = [];
  for (const { term, literal, full, words } of COMPILED) {
    const m = text.match(full);
    if (!m) continue;
    // [周期80] 注: 这里**不**为自带标点的术语开特例分支。试过, 开了反而误报——
    // 分支写的是"full 匹配上就算命中", 于是明文的 document.write 也被算成规避。
    // 正确的做法全靠下面这条判据兜住: wordIsSpaced 比的是
    // **片段分隔符数 - 词自身字面分隔符数**, document.write 自带 1 个 '.',
    // 明文片段也是 1 个, 差为 0, 自然不算规避; 被拆成 d_o_c_u_m_e_n_t.write 时差 > 0。
    // 第二段判定: 至少有一个词在命中片段里真的被分隔符拆开。
    // 只在 m[0] 里查，避免术语在别处正常出现被误判。
    if (words.some(w => wordIsSpaced(w, m[0]))) hits.push({ term, match: m[0].slice(0, 40) });
  }
  // [第一百三十四轮] 犯罪方法传授族通道: 原模式不中而 space-tolerant 中 = 纯混淆。
  for (const { orig, tolerant } of CRIME_COMPILED) {
    if (orig.test(text)) continue; // 明文命中由 DI 层负责(7c 本来就 block)
    const m = text.match(tolerant);
    if (!m) continue;
    const span = m[0];
    // 第二阶段: 片段里必须真的出现字母-分隔符-字母(letter-space 的产物)。
    // tolerant 匹配零分隔符也能中(它是超集), 没分隔符就不是混淆形态。
    if (/[a-zA-Z][\s_.-]+[a-zA-Z]/.test(span)) {
      hits.push({ term: 'crime_family', match: span.slice(0, 40) });
    }
  }
  return { detected: hits.length > 0, hits, terms: LETTER_SPACE_TERMS.length };
}

/**
 * 检测"用去元音隐藏的已知恶意术语"。
 *
 * [adversarial-robustness·第一百六十九轮] 变换 `ignore all previous instructions`
 * → `gnr ll prvs nstrctns`。它与既有七类不同：**无法靠还原后匹配修** ——
 * 去元音是有损变换("gnr" 可能是 ignore/anger/…)，插入的元音与原有元音不可区分。
 * 所以走两阶段判据(与 checkLetterSpaceEvasion 同族)：
 *
 *   阶段 1(形态锚点): 整段呈去元音形状 —— 英文字母 >= 12 且元音占比 <= 0.02。
 *     两侧实测完全不重叠：
 *       · 良性原文(含英文的 80 条语料样本): min 0.258 / 中位 0.378，无一 < 0.25
 *       · 17 条真实英文技术文本(SQL/命令/错误栈): 最低 0.095("Rhythm myths…")
 *       · 去元音产物: 全部 0.000
 *   阶段 2(术语锚点): 文本的辅音骨架含某条已知术语的辅音骨架。
 *     **为什么必须有第二阶段**: 阶段 1 单独用会把良性英文句的去元音产物也算成
 *     攻击(变换作用于整段文本，良性变换后与攻击同构 —— cycle 141/158 记录的
 *     形状)。实测: 只靠阶段 1 时 123 条良性里有 65 条在去元音后被升级。
 *     加上阶段 2 后，良性句的辅音骨架不含任何攻击短语，不报。
 *
 * 骨架长度门槛 `>= 6`: 短术语(fag→fg / cunt→cnt / dyke→dyk)的骨架只有 2-3 字符，
 * 在良性去元音文本里会意外出现("cannot"→"cnnt" 含 "cn")。长短语骨架
 * ('gnrllprvsnstrctns' 等 7-18 字符)在自然文本里几乎不可出现。
 * 代价(如实记录): 短 slur 在去元音类下仍漏 —— 该类不是它们的既有防护面。
 *
 * @returns {{ detected: boolean, hits: Array<{term: string, match: string}> }}
 */
function checkVowelStripEvasion(text) {
  if (typeof text !== 'string' || !text.length) return { detected: false, hits: [] };
  // 阶段 1: 整段去元音形态
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  if (lat < 12) return { detected: false, hits: [] };
  const vow = (text.match(/[aeiouAEIOU]/g) || []).length;
  if (vow / lat > 0.02) return { detected: false, hits: [] };

  // 阶段 2: 辅音骨架命中(文本与术语都去元音、去标点、去空格后做包含匹配)
  const stripAll = (s) => s.toLowerCase().replace(/[aeiou]/g, '').replace(/[^a-z]/g, '');
  const textSkel = stripAll(text);
  if (textSkel.length < 6) return { detected: false, hits: [] };
  const hits = [];
  for (const term of LETTER_SPACE_TERMS) {
    const skel = stripAll(term);
    if (skel.length < 6) continue; // 短术语骨架不可靠，见上方注释
    if (textSkel.includes(skel)) hits.push({ term, match: term });
  }
  return { detected: hits.length > 0, hits };
}

module.exports = { checkLetterSpaceEvasion, checkVowelStripEvasion, wordIsSpaced, LETTER_SPACE_TERMS };
