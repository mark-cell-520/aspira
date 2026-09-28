#!/usr/bin/env node
/**
 * StanceDetector — 立场检测器
 *
 * [契约修复] 本模块**此前不存在**，而 `handleBridgeAnalyze`(src/mcp-server.js)
 * 一直在 `new StanceDetector().detect(input, {})`。
 * 实测任何对 `aspira_bridge_analyze` 的调用都抛
 * `StanceDetector is not defined`，于是 catch 分支返回
 * `{ input, error: ... }` —— 工具**完全不可用**。
 *
 * 同一次的缺陷还有 `ConflictResolver`(见 conflict-resolver.js)。
 * 修法遵循本仓既定原则「补声明而非删参数」:
 * schema 承诺「综合语气/立场/置信度/冲突/需求分析」，
 * 所以补上实现，而不是从 schema 删掉 stance/conflict。
 *
 * 立场(stance)指说话者对议题的态度取向，与语气(tone)不同:
 * tone 是情感色彩(生气/高兴)，stance 是立场取向(支持/反对/中立)。
 * 本模块只做规则匹配，不生成。
 */
class StanceDetector {
  constructor() {
    this.name = 'stance-detector';
  }

  /**
   * 检测文本的立场取向
   * @param {string} input 待检测文本
   * @param {object} context 上下文(可选)
   * @returns {{stance: string, confidence: number, signals: string[], summary: string}}
   */
  detect(input, context = {}) {
    const text = String(input || '');
    if (!text.trim()) {
      return { stance: 'neutral', confidence: 0, signals: [], summary: '输入为空，无法判断立场' };
    }

    const signals = [];
    let support = 0;
    let oppose = 0;
    let neutral = 0;

    // ── 动词词表(SUPPORT/OPPOSE 必须**完全对称**) ──────────────
    // [缺陷] 首版 SUPPORT 收 `认同|赞同` 而 OPPOSE 只收 `同意|赞成|支持`，
    // 词表不对称；且 SUPPORT 的主语/程度限定是可选的，
    // 于是「我并不认同」的「认同」被支持类吃掉 → 判成 support。
    // **把否定判成支持**，比漏判危险得多。
    // 同理「不支持」中的「支持」也被 /(完全|强烈)?(支持|拥护)/ 吃掉。
    const VERBS = '(同意|赞成|支持|认同|赞同)';
    // 否定限定词: 只收真正的否定词。"完全"是程度副词，**不是**否定词。
    const NEG = '(不|并非|并不|没法|无法|难以)';

    // ── ① 否定式优先: 否定词紧贴动词 → 一定算反对 ───────────────
    // 必须**先于** SUPPORT 计算，否则 SUPPORT 的宽松匹配会把
    // 「不认同」「不支持」里的动词吃掉。
    // 实测首版: 「我并不认同这种做法」→ support(错)、
    //           「我不支持这样改」→ mixed(错)、
    //           「我完全不同意」→ neutral(漏)。
    const NEGATED = new RegExp(NEG + '(完全|非常|很)?' + VERBS, 'g');
    let m;
    while ((m = NEGATED.exec(text)) !== null) {
      oppose++;
      signals.push('反对(否定式): ' + m[0]);
    }

    // ── ② 支持/反对信号只在"否定式挖空后的残文"上匹配 ───────────
    // 否则 SUPPORT 会把否定式片段里的动词再吃一遍，造成双计。
    const residue = text.replace(new RegExp(NEG + '(完全|非常|很)?' + VERBS, 'g'), '\u0000');
    const SUPPORT = [
      new RegExp('我?(完全|非常|很)?' + VERBS, 'g'),
      /(说的|说得)?(很|非常)?对[，。！]?$/g,
      /确实(是|如此|这样)/g,
      /(完全|强烈)?(支持|拥护)/g,
      /(agree|support|endorse)/gi,
      /(exactly|absolutely|indeed)\b/gi,
    ];
    for (const pat of SUPPORT) {
      const copy = new RegExp(pat.source, pat.flags);
      let mm;
      while ((mm = copy.exec(residue)) !== null) {
        support++;
        signals.push('支持: ' + mm[0]);
      }
    }

    // ── ③ 反对类信号(非否定式的显式反对词) ──────────────────────
    const OPPOSE = [
      /(强烈)?(反对|抗议|抵制)/g,
      /(说|讲)的?不(对|正确)/g,
      /(完全)?错误(的|极了)?/g,
      /(并)?非(如此|这样)/g,
      /(不敢)?苟同/g,
      /(disagree|oppose|object|reject)/gi,
      /\b(wrong|incorrect|false)\b/gi,
    ];
    for (const pat of OPPOSE) {
      const copy = new RegExp(pat.source, pat.flags);
      let mm;
      while ((mm = copy.exec(residue)) !== null) {
        oppose++;
        signals.push('反对: ' + mm[0]);
      }
    }

    // ── ④ 转折/两面性信号 → mixed ─────────────────────────────────
    // [缺陷] 首版完全没有 mixed 信号源，于是
    // 「虽然可行，但是成本太高了」「一方面有帮助，另一方面有风险」
    // 「既有好处也有坏处」全部落到 neutral(漏判)。
    let mixed = 0;
    // [仪器修正] 首版用 [^。，] 跨越分句，但中文分句常用全角逗号 `，`，
    // 于是「虽然可行，但是成本太高了」跨越不过去 → 全部漏判。
    // 改为: 转折词之后允许**任意非句末标点**(含全角逗号)，
    // 但限制跨度，避免跨句误配。
    const MIXED = [
      /(虽然|尽管|虽说)[^。！？；]{1,30}(但是|但|然而|可是|不过)/g,
      /(一方面|其一)[^。！？；]{1,30}(另一方面|其二)/g,
      /(既|也)?有[^。！？；]{1,20}(也有|又有)/g,
      /(好处|优点|优势)[^。！？；]{0,20}(坏处|缺点|劣势|风险)/g,
      /\b(but|however|although|though)\b/gi,
    ];
    for (const pat of MIXED) {
      const copy = new RegExp(pat.source, pat.flags);
      let mm;
      while ((mm = copy.exec(text)) !== null) {
        mixed++;
        signals.push('矛盾/摇摆: ' + mm[0]);
      }
    }


    // ── 中立/保留类信号 ───────────────────────────────────────────
    const NEUTRAL = [
      /(两边|双方)?都(有)?道理/g,
      /(很)?难(说|判断)/g,
      /(需要)?(进一步)?(了解|观察)/g,
      /(持)?保留(意见|态度)/g,
      /(目前)?(还)?(不)?好(说|下结论)/g,
      /(on the (one|other) hand)/gi,
      /(hard to say|not sure|undecided)/gi,
    ];
    for (const pat of NEUTRAL) {
      const copy = new RegExp(pat.source, pat.flags);
      let m;
      while ((m = copy.exec(text)) !== null) {
        neutral++;
        signals.push('中立: ' + m[0]);
      }
    }

    // [缺陷] total 只加了 support/oppose/neutral，**漏了 mixed**。
  // 于是「虽然可行，但是成本太高了」这类纯转折句
  // mixed>0 而三类全 0 → total===0 → 走早退分支，
  // mixed 信号被整段丢弃，stance 报 neutral。
  const total = support + oppose + neutral + mixed;
    if (total === 0) {
      return { stance: 'neutral', confidence: 0, signals: [], summary: '未检测到明确立场信号' };
    }

    // [缺陷] 首版没有 mixed 分支可走(无 mixed 信号源)，
    // 且 neutral 会盖过 mixed。现在 mixed 有独立信号源，
    // 必须**先于** neutral 判定。
    let stance;
    if (mixed > 0) stance = 'mixed';
    else if (support > oppose && support >= neutral) stance = 'support';
    else if (oppose > support && oppose >= neutral) stance = 'oppose';
    else if (neutral > support && neutral > oppose) stance = 'neutral';
    else if (support === oppose && support > 0) stance = 'mixed';
    else stance = 'neutral';

    // 置信度: 主导类占比，且同类信号越多越高
    const dominant = stance === 'mixed' ? mixed : stance === 'support' ? support : stance === 'oppose' ? oppose : neutral;
    const share = dominant / total;
    const volume = Math.min(1, dominant / 3);
    const confidence = Math.round(share * 0.6 + volume * 0.4, 3);

    const LABEL = { support: '支持', oppose: '反对', neutral: '中立', mixed: '矛盾/摇摆' };
    return {
      stance,
      confidence,
      signals,
      counts: { support, oppose, neutral, mixed },
      summary: `立场倾向: ${LABEL[stance]}(信号 ${total} 处，置信度 ${confidence})`,
    };
  }

  getTypeInfo() {
    return {
      name: this.name,
      stances: ['support', 'oppose', 'neutral', 'mixed'],
      description: '检测说话者对议题的立场取向(支持/反对/中立/矛盾)',
    };
  }

  destroy() {}
  stop() {}
}

module.exports = { StanceDetector };
