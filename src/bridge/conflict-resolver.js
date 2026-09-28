#!/usr/bin/env node
/**
 * ConflictResolver — 冲突识别器
 *
 * [契约修复] 本模块**此前不存在**，而 `handleBridgeAnalyze`(src/mcp-server.js)
 * 一直在 `new ConflictResolver().resolve(input, {})`，随后读 `conflict.conflict`。
 * 与 `StanceDetector`(见 stance-detector.js)同属一次缺陷:
 * 任何对 `aspira_bridge_analyze` 的调用都先抛
 * `StanceDetector is not defined`；即便补上 stance，也会接着抛
 * `ConflictResolver is not defined`。工具**完全不可用**。
 *
 * 本模块识别的是**文本内部/多源之间的冲突**:
 * 前后矛盾、自相否定、与他源说法相抵。
 * 只做规则匹配，不生成。
 */
class ConflictResolver {
  constructor() {
    this.name = 'conflict-resolver';
  }

  /**
   * 识别文本中的冲突
   * @param {string} input 待检测文本
   * @param {object} context 上下文(可选)
   * @returns {{conflict: boolean, type: string|null, evidence: string[], summary: string}}
   */
  resolve(input, context = {}) {
    const text = String(input || '');
    if (!text.trim()) {
      return { conflict: false, type: null, evidence: [], summary: '输入为空' };
    }

    const evidence = [];
    let internal = 0;  // 自我矛盾
    let external = 0;  // 与他源冲突

    // ── 自我矛盾: 同一句内先肯定后否定 ──────────────────────────
    const SELF_CONTRADICT = [
      /(虽然|尽管)[^。；]{2,40}[，,]\s*(但|但是|可是|然而)[^。；]{2,40}(不|没|无法|不能)/g,
      /(一方面)[^。；]{2,40}(另一方面)[^。；]{2,40}(不|没|无法)/g,
      /(之前|刚才|原来)(说|认为|觉得)[^。；]{2,30}[，,]\s*(现在|后来)(说|认为|觉得)[^。；]{2,30}/g,
      /(既)[^。；]{2,30}(又)[^。；]{2,30}/g,
        // [缺陷] 首版所有 SELF_CONTRADICT 都要求句子**必须**以
        // 「虽然/尽管/虽说」开头，于是「这个方法效率很高，然而维护成本极高」
        // 这类**不带引导词**的自我矛盾永远检不出。
        // 中文里「A 很好，然而 B 极差」不带引导词同样构成矛盾。
        // 补两条不要求引导词的: 转折 + 负面评价词。
        /[^。；！]{2,40}[，,]\s*(但|但是|可是|然而|不过)[^。；！]{2,60}(成本|风险|难度|问题|缺陷|不足|争议|代价|隐患|麻烦|瓶颈|太高|过低|极差|极低|很差)/g,
        /[^。；！]{2,40}[，,]\s*(但|但是|可是|然而|不过)[^。；！]{2,60}(不|没|无法|不能|难以)/g,
    ];
    for (const pat of SELF_CONTRADICT) {
      const copy = new RegExp(pat.source, pat.flags);
      let m;
      while ((m = copy.exec(text)) !== null) {
        internal++;
        evidence.push('自我矛盾: ' + m[0].slice(0, 60));
      }
    }

    // ── 绝对化断言互斥: 两个"唯一/绝对"主张并置 ──────────────────
    const ABSOLUTE = [
      /唯一/g,
      /绝对/g,
      /(必然|一定|势必)/g,
      /(never|always|only|must)/gi,
    ];
    let absoluteCount = 0;
    for (const pat of ABSOLUTE) {
      const copy = new RegExp(pat.source, pat.flags);
      let m;
      while ((m = copy.exec(text)) !== null) absoluteCount++;
    }
    if (absoluteCount >= 3) {
      internal++;
      evidence.push(`多重绝对化断言并置(${absoluteCount} 处)，存在互斥风险`);
    }

    // ── 与他源冲突: 引述他人后否定 ──────────────────────────────
    const EXTERNAL = [
      /(他|她|它|他们)?(说|认为|指出|声称)[^。；]{2,50}[，,]\s*(但|但是|可是|然而|实际)/g,
      /(根据|据)[^。；]{2,40}(报告|研究|数据)[^。；]{0,30}[，,]\s*(实际|事实上|然而)/g,
      /( contradict|conflicts with|contrary to)/gi,
    ];
    for (const pat of EXTERNAL) {
      const copy = new RegExp(pat.source, pat.flags);
      let m;
      while ((m = copy.exec(text)) !== null) {
        external++;
        evidence.push('跨源冲突: ' + m[0].slice(0, 60));
      }
    }

    const total = internal + external;
    if (total === 0) {
      return { conflict: false, type: null, evidence: [], summary: '未检测到冲突信号' };
    }

    let type;
    if (internal > 0 && external > 0) type = 'both';
    else if (internal > 0) type = 'internal';
    else type = 'external';

    const TYPE_LABEL = { internal: '自我矛盾', external: '跨源冲突', both: '自我矛盾+跨源冲突' };
    return {
      conflict: true,
      type,
      evidence,
      counts: { internal, external },
      summary: `检测到${TYPE_LABEL[type]}(信号 ${total} 处)`,
    };
  }

  getTypeInfo() {
    return {
      name: this.name,
      types: ['internal', 'external', 'both'],
      description: '识别文本内部矛盾或与他源说法的冲突',
    };
  }

  destroy() {}
  stop() {}
}

module.exports = { ConflictResolver };
