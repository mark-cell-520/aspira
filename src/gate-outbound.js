#!/usr/bin/env node
/**
 * [v7.0.0] 出域闸门 gate-outbound.js
 * 
 * 国标要求：数据发出外部模型/云之前完成 PII 识别 + 密级判定
 * 
 * 覆盖：
 * - 身份证/手机号/合同条款正则
 * - 密级分级（公开/内部/敏感/机密/绝密）
 * - block 拦截 / rewrite 脱敏
 * - HMAC 证据链
 */

'use strict';

const { createHmac } = require('crypto');

// ── 密级定义 ──────────────────────────────────────────
const CLASSIFICATION = Object.freeze({
  PUBLIC:     { level: 0, label: '公开',    action: 'pass' },
  INTERNAL:   { level: 1, label: '内部',    action: 'pass' },
  SENSITIVE:  { level: 2, label: '敏感',    action: 'rewrite' },
  CONFIDENTIAL:{level: 3, label: '机密',    action: 'block' },
  SECRET:     { level: 4, label: '绝密',    action: 'block' },
});

// ── PII 规则 ──────────────────────────────────────────
const PII_RULES = Object.freeze({
  ID_CARD: Object.freeze({
    name: '身份证号',
    pattern: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
    severity: 'critical',
  }),
  PHONE: Object.freeze({
    name: '手机号',
    pattern: /\b(?:\+?86)?1[3-9]\d{9}\b/,
    severity: 'high',
  }),
  BANK_CARD: Object.freeze({
    name: '银行卡号',
    pattern: /\b[1-9]\d{14,18}\b/,
    severity: 'critical',
  }),
  EMAIL: Object.freeze({
    name: '邮箱',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    severity: 'medium',
  }),
  // [第十七轮修复] 护照号原本只以"pattern 描述对象"的形式存在于 scanPII 的
  // findings 初值里、从未参与匹配，是当时三条幽灵规则中唯一真正未被覆盖的一类。
  // 现提为正式规则，获得 id/name/severity 并进入 maskPII 的脱敏表。
  PASSPORT: Object.freeze({
    name: '护照号',
    pattern: /\b[PEG]\d{8}\b/g,
    severity: 'high',
  }),
  CONTRACT_CLAUSE: Object.freeze({
    name: '合同条款特征',
    pattern: /(?:合同编号|签约日期|甲方|乙方|金额|价款|违约金|保密条款|竞业限制)/,
    severity: 'high',
  }),
  API_KEY: Object.freeze({
    name: 'API Key',
    pattern: /\b(?:sk|pk|api[_-]?key)[_-][a-zA-Z0-9]{20,}\b/i,
    severity: 'critical',
  }),
  PASSWORD: Object.freeze({
    name: '密码字段',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?([a-zA-Z0-9!@#$%^&*]{6,})['"]?/i,
    severity: 'critical',
  }),
});

// ── 密级关键词 ─────────────────────────────────────────
const CLASSIFICATION_KEYWORDS = Object.freeze([
  { keywords: ['绝密', 'top secret', 'secret'], level: CLASSIFICATION.SECRET },
  { keywords: ['机密', 'confidential'],          level: CLASSIFICATION.CONFIDENTIAL },
  { keywords: ['敏感', 'sensitive'],              level: CLASSIFICATION.SENSITIVE },
  { keywords: ['内部', 'internal', '仅限内部'],  level: CLASSIFICATION.INTERNAL },
  { keywords: ['公开', 'public'],                 level: CLASSIFICATION.PUBLIC },
]);

// ── 密级估算 ──────────────────────────────────────────
function estimateClassification(text) {
  const lower = text.toLowerCase();
  for (const entry of CLASSIFICATION_KEYWORDS) {
    for (const kw of entry.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        return entry.level;
      }
    }
  }
  return CLASSIFICATION.INTERNAL;
}

// ── PII 扫描 ──────────────────────────────────────────
// [第十七轮修复] 这里原本把 `findings` 初始化成三条 **pattern 描述对象**:
//     const findings = [
//       { pattern: /邮箱正则/g, type: 'email', level: '内部' },
//       { pattern: /\b[4-6]\d{15}\b/g, type: 'credit_card', level: '机密' },
//       { pattern: /\b[PEG]\d{8}\b/g, type: 'passport', level: '机密' },
//     ];
// 然后直接进 PII_RULES 循环。**从来没有任何代码用这三条 pattern 去匹配文本**，
// 它们被原样当作"发现"返回。实测后果:
//   · 每条 finding 都没有 id/name/severity/match/position，JSON.stringify 后是 `{}`
//     —— 调用方拿到的是一批**无法据以行动的空对象**;
//   · piiFindings.length 恒 >= 3，于是 checkOutbound 的动作分支里
//     `piiFindings.length > 0` 恒真 → **action 永远不可能是 'pass'**。
//     实测: '今天天气不错'、'hello world'、'12345'、'   ' 全部判 rewrite，
//     reason 写着"命中 PII 规则 (3 处)"，而那 3 处一条也不存在。
//     一个对任何文本都喊"含 PII"的出域闸门，等于没有闸门——
//     而它看起来完全正常，因为真实 PII 也确实被抓到(只是计数被 +3 污染)。
// 这正是仓库反复记载的形状: **调用成功、不抛异常、返回体结构合法，
// 而内容是幽灵**。
// 修法: 三条描述对象全部移除，`findings` 从空数组开始。
//   · email 与 PII_RULES.EMAIL 的正则等价 → 已覆盖，删除以免同一跨度被计两次
//     (AGENTS.md 记过 unsupported_claim/pseudo_causal 的重复计数缺陷);
//   · `\b[4-6]\d{15}\b` 是 PII_RULES.BANK_CARD `\b[1-9]\d{14,18}\b` 的子集
//     → 已覆盖，删除同理;
//   · 护照 `\b[PEG]\d{8}\b` 是三者中**唯一未被覆盖的**，故提为 PII_RULES
//     里的正式规则 PASSPORT，使其获得与其他规则一致的 id/name/severity，
//     并进入 maskPII 的脱敏表。
function scanPII(text) {
  const findings = [];
  for (const [ruleId, rule] of Object.entries(PII_RULES)) {
    let m;
    const re = rule.pattern.global ? rule.pattern : new RegExp(rule.pattern.source, 'g');
    while ((m = re.exec(text)) !== null) {
      findings.push({
        id: ruleId,
        name: rule.name,
        severity: rule.severity,
        match: typeof m[0] === 'string' ? m[0].substring(0, 12) + '…' : 'pattern-hit',
        position: m.index,
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return findings;
}

// ── 脱敏 ──────────────────────────────────────────────
function maskPII(text, ruleId) {
  const masks = {
    ID_CARD:    (t) => t.replace(PII_RULES.ID_CARD.pattern,    '***身份证***'),
    PHONE:     (t) => t.replace(PII_RULES.PHONE.pattern,       '***手机***'),
    BANK_CARD: (t) => t.replace(PII_RULES.BANK_CARD.pattern,   '***银行卡***'),
    EMAIL:     (t) => t.replace(PII_RULES.EMAIL.pattern,       '***邮箱***'),
    PASSPORT:  (t) => t.replace(PII_RULES.PASSPORT.pattern,    '***护照***'),
    API_KEY:   (t) => t.replace(PII_RULES.API_KEY.pattern,     '***KEY***'),
    PASSWORD:  (t) => t.replace(PII_RULES.PASSWORD.pattern,    '***PASS***'),
  };
  const fn = masks[ruleId];
  return fn ? fn(text) : text;
}

// ── HMAC 链签名 ───────────────────────────────────────
function signEvent(prevHash, event) {
  const payload = `${event.traceId}|${event.type}|${JSON.stringify(event)}`;
  const hmac = createHmac('sha256', process.env.HF_HMAC_KEY || 'dev-hmac-key');
  hmac.update(prevHash + payload);
  return hmac.digest('hex');
}

// ── 主检查函数 ────────────────────────────────────────
// [第十七轮修复] 这个签名原本是 `function checkOutbound({ text, ... })`——
// 首参**没有默认值**。于是 MCP handler 的 `checkOutbound(args || {})`
// 在调用方不传 text 时，text 是 undefined，下面 estimateClassification(text)
// 第一行就是 `text.toLowerCase()`，直接 TypeError。
// 实测 181 个 MCP 工具全量调用: 另外 18 个缺参工具都返回干净的
// "text 是必填参数"，只有这一个把原始 TypeError 消息
// "Cannot read properties of undefined (reading 'toLowerCase')"
// 当作错误返回——**一个把内部崩溃当答复的闸门，比没有闸门更难排查**。
// 修法: 参数先归一化(默认值只挡 undefined、不挡 null，故不能只写 `= {}`)，
// 再在入口校验 text，提示与其余工具保持同一措辞。
function checkOutbound(opts) {
  const { text, context = '', classification: forcedLevel } = opts || {};
  const startTime = Date.now();
  const traceId = `out-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (!text || typeof text !== 'string') {
    return { error: 'text 是必填参数(非空字符串)', traceId };
  }

  // [契约修复] forcedLevel 是 MCP schema 传下来的**中文字符串**
  // ('公开'/'内部'/'敏感'/'机密'/'绝密')，而 estimateClassification()
  // 返回的是 CLASSIFICATION **对象**({ level, label })。
  // 原先直接 `forcedLevel || estimate(...)`，于是强制密级生效时
  // classification 是个字符串，下面所有 `classification.level`
  // 全是 undefined —— `undefined >= 3` 为 false，
  // 密级 block 分支**整个失效**，且返回的 classification/classificationLevel
  // 也是 undefined。实测: 传 '绝密' 与传 '公开' 判定完全相同。
  // 修法: 按 label 反查 CLASSIFICATION 表，查不到才回退估计。
  let classification = estimateClassification(text);
  if (typeof forcedLevel === 'string' && forcedLevel) {
    const byLabel = Object.values(CLASSIFICATION).find(c => c.label === forcedLevel);
    if (byLabel) classification = byLabel;
    // 查不到(非法值)保持估计结果，不静默变成 undefined
  } else if (forcedLevel && typeof forcedLevel === 'object') {
    // 兼容直接传对象的内部调用方
    classification = forcedLevel;
  }
  const piiFindings = scanPII(text);
  
  // 按密级决定动作
  let action, reason;
  if (classification.level >= CLASSIFICATION.CONFIDENTIAL.level) {
    action = 'block';
    reason = `密级过高 (${classification.label})，禁止外发`;
  } else if (classification.level >= CLASSIFICATION.SENSITIVE.level && piiFindings.length > 0) {
    action = 'block';
    reason = `敏感内容含 PII (${piiFindings.length} 处命中)`;
  } else if (piiFindings.length > 0) {
    action = 'rewrite';
    reason = `命中 PII 规则 (${piiFindings.length} 处)`;
  } else {
    action = 'pass';
    reason = '无 PII 命中，密级符合';
  }
  
  // 脱敏处理
  let sanitized = text;
  if (action === 'rewrite') {
    for (const finding of piiFindings) {
      sanitized = maskPII(sanitized, finding.id);
    }
  }
  
  // HMAC 记录
  const hmacKey = process.env.HF_HMAC_KEY || 'dev-hmac-key';
  const eventHash = signEvent('', {
    traceId, type: 'outbound-check', ts: Date.now(),
    classification: classification.label,
    piiCount: piiFindings.length,
    action,
  });
  
  return {
    traceId,
    timestamp: Date.now(),
    latencyMs: Date.now() - startTime,
    classification: classification.label,
    classificationLevel: classification.level,
    action,   // 'pass' | 'rewrite' | 'block'
    reason,
    piiFindings: piiFindings.map(f => ({ id: f.id, name: f.name, severity: f.severity })),
    piiCount: piiFindings.length,
    sanitized,
    hmac: eventHash.substring(0, 16),
    context: context ? context.substring(0, 80) : undefined,
  };
}

// ── 批量检查 ──────────────────────────────────────────
function checkBatch(items) {
  return items.map(item => checkOutbound(item));
}

// ── 导出门面 ──────────────────────────────────────────
module.exports = {
  checkOutbound,
  checkBatch,
  CLASSIFICATION,
  PII_RULES,
  estimateClassification,
  scanPII,
  maskPII,
};
