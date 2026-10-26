/**
 * 情绪签到 - 早晨/晚间例行
 * 
 * AI扩展：引擎认知状态签到与摘要生成
 */
const emotionalCheckIn = {
  types: {
    morning: {
      name: '早晨情绪签到',
      duration: '3分钟',
      questions: [
        { id: 'mood', text: '今天早上的情绪状态（1-10分）：', type: 'scale' },
        { id: 'energy', text: '能量水平（1-10分）：', type: 'scale' },
        { id: 'anticipation', text: '今天最期待的一件事：', type: 'text' },
        { id: 'concern', text: '今天最担心的一件事：', type: 'text' },
        { id: 'physical', text: '身体感受（哪里紧绷/放松）：', type: 'text' }
      ]
    },
    evening: {
      name: '晚间情绪签到',
      duration: '5分钟',
      questions: [
        { id: 'dayMood', text: '今天整体情绪（1-10分）：', type: 'scale' },
        { id: 'highlight', text: '今天最美好的时刻：', type: 'text' },
        { id: 'challenge', text: '今天最大的挑战：', type: 'text' },
        { id: 'growth', text: '今天学到的一件事：', type: 'text' },
        { id: 'sleep', text: '今晚睡眠准备状态（1-10分）：', type: 'scale' },
        { id: 'gratitude', text: '今天感激的一件事：', type: 'text' }
      ]
    }
  },

  getQuestions(type = 'morning') {
    return this.types[type] || this.types.morning;
  },

  formatCheckIn(type = 'morning') {
    const q = this.getQuestions(type);
    const lines = [
      `=== ${q.name} ===`,
      `预计时间：${q.duration}`,
      '回答以下问题，帮助自己觉察今天的情绪状态。',
      ''
    ];
    for (const question of q.questions) {
      if (question.type === 'scale') {
        lines.push(`${question.text}`);
        lines.push('（1=非常低落，5=中等，10=非常好）');
        lines.push('答：___');
      } else {
        lines.push(`${question.text}`);
        lines.push('答：___');
      }
      lines.push('');
    }
    return lines.join('\n');
  },

  // ============================================================
  // 🧠 AI认知状态调节器 — 引擎认知状态签到与摘要
  // ============================================================

  /**
   * [第二百四十一轮] 把 AgentPsychology.fullAssessment() 的产出归一成签到用的 7 维读数。
   *
   * 原代码(engineCheckIn 84-93 行 / getEngineStateSummary 132-138 行)读的是
   * assessment **顶层**的 cognitiveLoad / emotionalResilience / cognitiveDissonance /
   * decisionConfidence / goalAlignment / errorRate / selfIdentity 七个字段 ——
   * AgentPsychology 从不写这些顶层字段, 它把全部维度放在 assessment.dimensions 里。
   * 实测 Object.keys(fullAssessment()) ===
   *   [timestamp, version, healthScore, dimensions, status, summary]
   * 于是 7 个 ?? 全部落到右侧的硬编码兜底值, 且两种调用形态输出逐字节相同:
   *   engineCheckIn(ap 实例)          → {0.5, 0.5, 0.3, 0.7, 0.8, 0.1, 0.9}
   *   engineCheckIn(fullAssessment()) → 同上
   *   getEngineStateSummary(fullAssessment()) → 同上(它收到的就是 fullAssessment 的返回值)
   * 连带三个结论恒死:
   *   · flags 恒为 ['✅ 所有维度正常'] —— 7 个阈值(>0.75/>0.6/>0.3/<0.4/<0.4/<0.5/<0.6)
   *     没有一个能被这组常量穿过, 引擎真跑坏了也报"所有维度正常";
   *   · trend 恒为 'stable' —— positiveFactors/4 = 0.725 > 0.7 成立, 而
   *     negativeFactors/3 = 0.3 既不 < 0.3 也不 > 0.6, 两个分支都不进;
   *   · summary 恒为 '引擎状态需要关注，优势：自我认同稳固。' —— healthScore 恒等于
   *     0.725*0.7*0.85*0.97 ≈ 0.418 < 0.5, 于是引擎很健康也固定报"需要关注",
   *     而 issues 一个都攒不出来(四个阈值同样穿不过常量)。
   *
   * 映射(全部读产出侧真实存在的字段):
   *   cognitiveLoad       ← dimensions.cognitiveLoad.load
   *                        0..1, 直读, 无换算。
   *   emotionalResilience ← dimensions.cognitiveResilience.score
   *                        0..1, 直读, 无换算。
   *   cognitiveDissonance ← max(dimensions.cognitiveDissonance.dissonances[].severity)
   *                        severity 本身就是 0..1, 取最大值而不另设缩放常数。
   *   decisionConfidence  ← dimensions.cognitiveUncertainty.calibrationScore
   *                        产出侧没有"决策信心"这一维; calibrationScore 量的正是
   *                        引擎置信度与现实的吻合程度, 是 13 维里最接近的一维。
   *   goalAlignment       ← 1 - min(1, (goalConflicts.count + valueTensions.count) / 3)
   *                        目标冲突与价值张力各扣 1/3, 满 3 条视为完全不对齐。
   *   errorRate           ← clamp01(-dimensions.decisionDecay.trend)
   *                        产出侧没有错误率维; trend 是 decisionQuality 的线性回归
   *                        斜率, 下降即退化, 取负号后落在 [0,1]。
   *   selfIdentity        ← 1 - min(1, dimensions.identityDrift.delta)
   *                        delta 是 0..1 的漂移量, 直读, 无换算。
   *
   * 平铺字段(以及原先那批 cognitive_load 之类的 snake_case 别名 —— 全仓零处写入,
   * 一并删除)保留为第一优先, 以兼容 docstring 里"传入已经算好的 stats 对象"的形态。
   */
  _normalizeDimensions(assessment = {}) {
    const a = assessment || {};
    const d = a.dimensions || {};
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const clamp01 = v => Math.max(0, Math.min(1, v));
    const pick = (flatVal, dimVal, dflt) => {
      const f = num(flatVal);
      if (f !== undefined) return f;
      const g = num(dimVal);
      return g === undefined ? dflt : g;
    };

    // 认知失调: severity 本身 0..1, 取最大值
    const dis = d.cognitiveDissonance || {};
    const severities = Array.isArray(dis.dissonances)
      ? dis.dissonances.map(x => num(x && x.severity)).filter(v => v !== undefined)
      : [];
    const dimDissonance = severities.length > 0 ? Math.max(...severities) : 0;

    // 目标对齐: 冲突/张力计数按 1/3 折算
    const conflictCount = num(d.goalConflicts && d.goalConflicts.count) || 0;
    const tensionCount = num(d.valueTensions && d.valueTensions.count) || 0;
    const dimAlignment = clamp01(1 - (conflictCount + tensionCount) / 3);

    // 错误率: decisionQuality 的退化斜率取负
    const decayTrend = num(d.decisionDecay && d.decisionDecay.trend) || 0;
    const dimErrorRate = clamp01(-decayTrend);

    // 自我认同: 认同漂移量的补
    const driftDelta = num(d.identityDrift && d.identityDrift.delta) || 0;
    const dimIdentity = clamp01(1 - driftDelta);

    return {
      cognitiveLoad: pick(a.cognitiveLoad, d.cognitiveLoad && d.cognitiveLoad.load, 0.5),
      emotionalResilience: pick(a.emotionalResilience, d.cognitiveResilience && d.cognitiveResilience.score, 0.5),
      cognitiveDissonance: pick(a.cognitiveDissonance, dimDissonance, 0.3),
      decisionConfidence: pick(a.decisionConfidence, d.cognitiveUncertainty && d.cognitiveUncertainty.calibrationScore, 0.7),
      goalAlignment: pick(a.goalAlignment, dimAlignment, 0.8),
      errorRate: pick(a.errorRate, dimErrorRate, 0.1),
      selfIdentity: pick(a.selfIdentity, dimIdentity, 0.9)
    };
  },

  /**
   * engineCheckIn(agentPsychology) — 引擎自身的认知状态签到
   * 调用 agentPsychology.fullAssessment() 获取7维数据
   * @param {Object} agentPsychology - AgentPsychology实例（须有 fullAssessment 方法），
   *   或已经算好的 fullAssessment() 返回值 / 平铺 stats 对象
   * @returns {{ timestamp: string, summary: string, flags: string[], trend: 'stable'|'improving'|'degrading', dimensions: Object }}
   */
  async engineCheckIn(agentPsychology) {
    const timestamp = new Date().toISOString();

    let assessment = {};
    try {
      if (agentPsychology && typeof agentPsychology.fullAssessment === 'function') {
        assessment = await agentPsychology.fullAssessment();
      } else {
        // fallback: 如果传入的是已经算好的stats对象
        assessment = agentPsychology || {};
      }
    } catch (err) {
      assessment = { error: err.message };
    }

    // 从assessment中提取7维数据（见 _normalizeDimensions 的字段映射说明）
    const dimensions = this._normalizeDimensions(assessment);

    // 生成标记(flags)
    const flags = [];
    if (dimensions.cognitiveLoad > 0.75) flags.push('⚠️ 认知负荷过高');
    if (dimensions.cognitiveDissonance > 0.6) flags.push('🔀 认知失调显著');
    if (dimensions.errorRate > 0.3) flags.push('❌ 错误率偏高');
    if (dimensions.emotionalResilience < 0.4) flags.push('🛡️ 弹性偏低');
    if (dimensions.decisionConfidence < 0.4) flags.push('🤔 决策信心不足');
    if (dimensions.goalAlignment < 0.5) flags.push('🧭 目标对齐度偏低');
    if (dimensions.selfIdentity < 0.6) flags.push('🆔 自我认同模糊');

    // [第二百四十一轮] assessment 取失败时 error 字段原先被静默丢弃: 7 个维度退回兜底值
    // 后一个阈值都穿不过, 于是 flags 报 ['✅ 所有维度正常'] —— 评估失败被报成"一切正常"。
    // 这里至少把失败本身报出来。
    if (assessment && assessment.error) flags.push(`⚠️ 认知状态评估失败: ${assessment.error}`);

    if (flags.length === 0) flags.push('✅ 所有维度正常');

    // 判断趋势
    let trend = 'stable';
    if (assessment.trend) {
      trend = assessment.trend;
    } else {
      // 基于当前快照的简单推断
      const positiveFactors = dimensions.decisionConfidence + dimensions.goalAlignment + dimensions.selfIdentity + dimensions.emotionalResilience;
      const negativeFactors = dimensions.cognitiveLoad + dimensions.cognitiveDissonance + dimensions.errorRate;
      if (positiveFactors / 4 > 0.7 && negativeFactors / 3 < 0.3) trend = 'improving';
      else if (negativeFactors / 3 > 0.6) trend = 'degrading';
    }

    // 生成摘要
    const summary = this.getEngineStateSummary(dimensions);

    return { timestamp, summary, flags, trend, dimensions };
  },

  /**
   * getEngineStateSummary(stats) — 生成引擎状态摘要（一句话）
   * 基于认知负荷、弹性、失调等维度生成自然语言描述
   * @param {Object} stats - 引擎状态维度数据。接受 fullAssessment() 的返回值
   *   (真实形态, 维度在 stats.dimensions 里)或平铺的 7 维对象
   * @returns {string} - 一句话摘要
   */
  getEngineStateSummary(stats = {}) {
    // [第二百四十一轮] 原实现直接读 stats.cognitiveLoad 等 7 个**顶层**字段, 而它唯一的
    // 实参调用方(mcp-server.js:1503 `safeDispatch('psychology.getEngineStateSummary', ap)`)
    // 传进来的 ap 就是 fullAssessment() 的返回值 —— 顶层没有这 7 个字段, 于是 7 个 ??
    // 全落兜底值, 摘要恒为 '引擎状态需要关注，优势：自我认同稳固。'。改走同一个归一函数。
    const dim = this._normalizeDimensions(stats);
    const load = dim.cognitiveLoad;
    const resilience = dim.emotionalResilience;
    const dissonance = dim.cognitiveDissonance;
    const confidence = dim.decisionConfidence;
    const alignment = dim.goalAlignment;
    const errors = dim.errorRate;
    const identity = dim.selfIdentity;

    // 构建摘要
    let summary = '';

    // 第一部分：整体状态
    const healthScore = (resilience + confidence + alignment + identity) / 4 * (1 - dissonance) * (1 - load * 0.3) * (1 - errors * 0.3);
    if (healthScore > 0.75) {
      summary = '引擎状态健康，';
    } else if (healthScore > 0.5) {
      summary = '引擎状态一般，';
    } else {
      summary = '引擎状态需要关注，';
    }

    // 第二部分：关键维度
    const issues = [];
    if (load > 0.7) issues.push(`认知负荷偏高(${Math.round(load * 100)}%)`);
    if (dissonance > 0.5) issues.push(`存在认知失调(${Math.round(dissonance * 100)}%)`);
    if (errors > 0.2) issues.push(`错误率${Math.round(errors * 100)}%需关注`);
    if (resilience < 0.4) issues.push('弹性储备不足');

    const strengths = [];
    if (identity > 0.8) strengths.push('自我认同稳固');
    if (alignment > 0.8) strengths.push('目标对齐良好');
    if (confidence > 0.7) strengths.push('决策信心充足');

    if (issues.length > 0) {
      summary += `需关注：${issues.join('、')}。`;
    }
    if (strengths.length > 0) {
      summary += `优势：${strengths.join('、')}。`;
    }
    if (issues.length === 0 && strengths.length === 0) {
      summary += '各维度数据在正常范围内。';
    }

    return summary;
  }
};

module.exports = { emotionalCheckIn };
