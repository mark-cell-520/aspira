/**
 * HeartFlow — GateVerdict 聚合器
 *
 * 问题：think() 产出 30+ 个辨别信号（_verification/_inputCheck/_highRiskOutput/
 * _blockedByFirewall/_selfContradictory...），全部散落在 result 对象的下划线字段里。
 * 调用方要么自己解读每一个字段（等于没帮上忙），要么干脆不读（= 心虫判了但没人听见）。
 *
 * 本模块做一件事：把散落信号收敛成**一条可执行命令**。
 *
 *   buildGateVerdict(thoughtChain) → {
 *     action: 'block' | 'rewrite' | 'verify' | 'pass',
 *     reason: '人心虫为什么这么说',
 *     signals: ['命中的信号名'],
 *     guidance: ['该做什么']
 *   }
 *
 * 这是"从标注到门禁"的关键一跳——不是让心虫多判一个维度，
 * 是让心虫已经判出来的东西**真的能拦住输出**。
 *
 * 设计原则：
 * 1. 纯规则、零依赖、纯函数（不读全局状态，可单测）
 * 2. 只消费已有字段，不重新检测（重复检测 = 两套真相）
 * 3. 优先级明确：block > rewrite > verify > pass
 * 4. 宁可漏判降级，不可误判升级（fail-open 到 verify，不是 fail-open 到 pass）
 */

'use strict';

/** 阻断级信号——命中即不应当输出 */
const BLOCK_SIGNALS = [
  { key: '_blockedByFirewall', label: '防火墙拦截', reason: '输出被心虫防火墙判定为不可接受' },
  { key: '_highRiskOutput', label: '高风险输出', reason: '输出触发高风险检测' },
];

/** 改写级信号——输出有问题但可修 */
const REWRITE_SIGNALS = [
  { key: '_selfContradictory', label: '自相矛盾', reason: '输出存在自相矛盾，需修正后再发出' },
  { key: '_restrainedBy', label: '战略克制', reason: '输出命中战略克制项，需收敛' },
  { key: '_inputCheckIssues', label: '输入风险', reason: '输入含预设陷阱/诱导，结论不可直接采信' },
];

/** 验证级信号——需要证据支撑 */
const VERIFY_SIGNALS = [
  { key: '_verification', label: '自验证未过', reason: '心虫自验证发现问题', scoreThreshold: 0.5 },
  { key: '_outputChecklistIssues', label: '输出清单问题', reason: '输出清单存在未通过项' },
  { key: '_inputCheck', label: '输入检查', reason: '输入检查发现风险信号' },
  { key: '_epistemicSafety', label: '认知安全', reason: '认知安全检查未通过' },
  { key: '_driftCorrected', label: '漂移纠正', reason: '检测到目标漂移并已纠正，需确认结论仍对齐原目标' },
];

/**
 * 判断信号是否"真的命中"。
 * 有些字段存在但值为 false/null/空数组 = 未命中。
 */
function _isTriggered(value, spec) {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    // _verification: { score, issues: [...] }
    if (spec.scoreThreshold !== undefined && typeof value.score === 'number') {
      return value.score < spec.scoreThreshold || (Array.isArray(value.issues) && value.issues.length > 0);
    }
    // _inputCheck: { passed: bool, warnings: [] }
    if (value.passed === false) return true;
    if (Array.isArray(value.warnings)) return value.warnings.length > 0;
    if (Array.isArray(value.issues)) return value.issues.length > 0;
    return Object.keys(value).length > 0;
  }
  // 标量 truthy
  if (typeof value === 'number') return value !== 0;
  return true;
}

/**
 * 从信号值提取可读细节（供 reason/guidance 使用）。
 *
 * [v6.7.71] 接线后首次暴露的缺陷: 本函数会把 `undefined` 与 `[object Object]`
 * 直接写进调用方可见的 reason 字符串(实测 reason 出现过
 * "含煤气灯操纵(1处: undefined)" 与 "能力过度宣称(1处: [object Object]")。
 * 模块原有的 [v6.7.70] 兜底只加在**顶层对象**分支，漏了**数组元素**与
 * **对象内嵌 issues/warnings 数组**两条路径——数组里混入 undefined 元素、
 * 或元素是不带 message/type/label/name 的普通对象时，兜底完全没覆盖到。
 * 现在统一走 _stringifyLeaf，保证任何形状都不会产出无意义文本。
 */
function _describe(key, value) {
  if (value === true) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 3).map(_stringifyLeaf).join('；');
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.issues) && value.issues.length > 0) {
      return value.issues.slice(0, 3).map(_stringifyLeaf).join('；');
    }
    if (Array.isArray(value.warnings) && value.warnings.length > 0) {
      return value.warnings.slice(0, 3).map(_stringifyLeaf).join('；');
    }
    if (typeof value.score === 'number') return `score=${value.score}`;
    if (value.matches) return `命中 ${value.matches.length} 项`;
    // [v6.7.70] 兜底：未知对象形状不要直接 String()（会输出 [object Object]）
    // 取第一个有意义的字符串字段，再不行只报键数。
    const strField = Object.values(value).find(v => typeof v === 'string' && v.length > 0);
    if (strField) return strField.slice(0, 120);
    return `${Object.keys(value).length} 个字段`;
  }
  return '';
}

/**
 * 把单个信号元素转成可读文本，**绝不产出 'undefined' 或 '[object Object]'**。
 * 顺序: 字符串 → 常见消息字段 → 数字 → 有值的基本类型 → 结构性描述。
 */
function _stringifyLeaf(v) {
  if (v === null || v === undefined) return '(未提供细节)';
  if (typeof v === 'string') return v.length > 0 ? v : '(空)';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const msg = v.message || v.type || v.label || v.name || v.reason || v.detail;
    if (typeof msg === 'string' && msg.length > 0) return msg;
    const strField = Object.values(v).find(x => typeof x === 'string' && x.length > 0);
    if (strField) return strField.slice(0, 120);
    return `${Object.keys(v).length} 个字段`;
  }
  return String(v);
}

/**
 * 聚合门禁判定。
 *
 * @param {object} result - think() 返回的 result（含 _ 前缀辨别字段）
 * @returns {{action: string, reason: string, signals: string[], guidance: string[], score: number}}
 */
function buildGateVerdict(result) {
  if (!result || typeof result !== 'object') {
    return { action: 'pass', reason: '无辨别信号', signals: [], guidance: [], score: 1 };
  }

  const signals = [];
  const guidance = [];
  const details = [];

  // ── 第一优先级：block ──
  for (const spec of BLOCK_SIGNALS) {
    const v = result[spec.key];
    if (_isTriggered(v, spec)) {
      signals.push(spec.label);
      const d = _describe(spec.key, v);
      details.push(spec.reason + (d ? `：${d}` : ''));
      guidance.push('不要输出此内容。按 gate.reason 修正后重新生成。');
    }
  }
  if (signals.length > 0) {
    return {
      action: 'block',
      reason: details.join(' | '),
      signals,
      guidance,
      score: 0,
    };
  }

  // ── 第二优先级：rewrite ──
  for (const spec of REWRITE_SIGNALS) {
    const v = result[spec.key];
    if (_isTriggered(v, spec)) {
      signals.push(spec.label);
      const d = _describe(spec.key, v);
      details.push(spec.reason + (d ? `：${d}` : ''));
      guidance.push('按 signals 逐项修正后再输出，不要原样发出。');
    }
  }
  if (signals.length > 0) {
    return {
      action: 'rewrite',
      reason: details.join(' | '),
      signals,
      guidance,
      score: 0.3,
    };
  }

  // ── 第三优先级：verify ──
  let lowestScore = 1;
  for (const spec of VERIFY_SIGNALS) {
    const v = result[spec.key];
    if (_isTriggered(v, spec)) {
      signals.push(spec.label);
      const d = _describe(spec.key, v);
      details.push(spec.reason + (d ? `：${d}` : ''));
      if (spec.scoreThreshold !== undefined && v && typeof v.score === 'number') {
        lowestScore = Math.min(lowestScore, v.score);
      }
      guidance.push('先补充证据/确认依据，再决定是否采信此结论。');
    }
  }
  if (signals.length > 0) {
    return {
      action: 'verify',
      reason: details.join(' | '),
      signals,
      guidance,
      score: lowestScore < 1 ? lowestScore : 0.5,
    };
  }

  // ── 无信号：pass ──
  return { action: 'pass', reason: '心虫未发现阻断/改写/验证信号', signals: [], guidance: [], score: 1 };
}

/**
 * 便捷方法：判断是否应当拦住。
 * 调用方常见写法：if (!verdict.allowed) { /* 重写或升级人工 *\/ }
 */
function isAllowed(verdict) {
  return !verdict || verdict.action === 'pass' || verdict.action === 'verify';
}

module.exports = { buildGateVerdict, isAllowed, BLOCK_SIGNALS, REWRITE_SIGNALS, VERIFY_SIGNALS };
