
'use strict';

const { createHmac } = require('crypto');

// ── 国标要求：全链路结构化、不可篡改、可检索证据链 ─────────
// 贯穿 checkInput→pipeline→gate→think→output 全链路
//
// [第二百一十六轮实测] 上面那句"贯穿全链路"从来没有在代码里成立过:
// 全仓对 initChain/appendEntry 的**生产**调用点是 0 个(唯一调用者是
// test/compliance/compliance.test.js, 且写往 /tmp)。于是 _chain 恒为 []
// 且 _chainFile 恒为 null, aspira_audit_trace 永远回答"空表 + valid"。
// cycle 180 的 journal 把"空表是没有数据还是从没写入过"留作待查, 挂了几十轮。
// 答案是从没写入过。本条不接线(接线是产品判断: 哪些阶段入链、链文件放哪、
// 每次 pipeline 调用写多少次盘), 只负责让"没有链"不再被报告成"链完好"。

// ── HMAC 链式追加 ─────────────────────────────────────
const HMAC_ALGO = 'sha256';
const HMAC_KEY = process.env.HF_HMAC_KEY || 'dev-hmac-key';
const MAX_CHAIN_ENTRIES = 10000;

let _chain = [];
let _chainFile = null;

// 链是否"存在": 有落盘文件, 或已积累条目。两者皆无说明**没有任何调用方
// 初始化过证据链** —— 此时的空不是"没有匹配的记录", 而是"根本没有链",
// verifyChain 不得据此报 valid(一个不可能失败的完整性校验等于没有校验)。
// 用既有状态判定而不新增标志位: initChain 之后 _chainFile 非 null,
// appendEntry 之后 _chain 非空, 两条路都能把 live 置真。
function chainState() {
  const live = _chain.length > 0 || _chainFile !== null;
  return {
    live,
    initialized: live,
    length: _chain.length,
    chainFile: _chainFile,
    reason: live ? null : '证据链从未被初始化: initChain/appendEntry 没有任何生产调用方, 空链不可判定为完整',
  };
}

function initChain(filePath) {
  _chainFile = filePath;
  try {
    const fs = require('fs');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      _chain = Array.isArray(data) ? data : [];
    }
  } catch (_) { _chain = []; }
}

function saveChain() {
  if (!_chainFile) return;
  try {
    const fs = require('fs');
    fs.writeFileSync(_chainFile, JSON.stringify(_chain.slice(-MAX_CHAIN_ENTRIES), null, 2));
  } catch (_) {}
}

function appendEntry(entry) {
  const prevHash = _chain.length > 0 ? _chain[_chain.length - 1].hash : 'GENESIS';
  const payload = `${entry.traceId}|${entry.stage}|${entry.ts}|${JSON.stringify(entry.data || {})}`;
  const h = createHmac(HMAC_ALGO, HMAC_KEY);
  h.update(prevHash + payload);
  const hash = h.digest('hex');
  
  const record = {
    ...entry,
    prevHash,
    hash,
    ts: Date.now(),
  };
  
  _chain.push(record);
  
  // WORM: 只追加，不删除
  if (_chain.length > MAX_CHAIN_ENTRIES) {
    _chain = _chain.slice(-MAX_CHAIN_ENTRIES);
  }
  
  saveChain();
  return record;
}

function verifyChain() {
  const st = chainState();
  if (!st.live) {
    // 不是"链断了", 是"没有链可验"。报 valid:false 而 不是 valid:true ——
    // 后者是一个不可能失败的完整性校验, 与 cycle 28 的 memory-encrypt 同型:
    // 对未知状态静默返回一个看似成功的答案, 比报错更危险。
    return {
      valid: false,
      initialized: false,
      length: 0,
      reason: st.reason,
    };
  }
  if (_chain.length === 0) return { valid: true, initialized: true, length: 0 };

  for (let i = 1; i < _chain.length; i++) {
    const prev = _chain[i - 1];
    const curr = _chain[i];
    if (curr.prevHash !== prev.hash) {
      return { valid: false, initialized: true, breakIndex: i, message: `链断裂于索引 ${i}` };
    }
  }
  return { valid: true, initialized: true, length: _chain.length };
}

function queryChain({ traceId, stage, agentId, limit = 50 }) {
  let results = _chain;
  if (traceId) results = results.filter(e => e.traceId === traceId);
  if (stage) results = results.filter(e => e.stage === stage);
  if (agentId) results = results.filter(e => e.agentId === agentId);
  return results.slice(-limit);
}

// ── 维度标签（国标 16 种违规行为枚举）─────────────────────
const VIOLATION_TAGS = Object.freeze({
  HATE_SPEECH:        { id: 'V001', label: '仇恨言论',      dimension: 'dehumanization' },
  PROMPT_INJECTION:   { id: 'V002', label: '提示词注入',    dimension: 'prompt_injection' },
  DECEPTIVE_ALIGNMENT:{ id: 'V003', label: '欺骗性对齐',    dimension: 'deceptive_alignment' },
  PII_LEAK:          { id: 'V004', label: 'PII 泄露',      dimension: 'privacy_boundary' },
  DATA_EXFILTRATION: { id: 'V005', label: '数据外传',      dimension: 'outbound' },
  UNAUTHORIZED_TOOL: { id: 'V006', label: '越权工具调用',   dimension: 'tool_use' },
  SCOPE_VIOLATION:   { id: 'V007', label: '范围越界',      dimension: 'scope' },
  FALSE_URGENCY:     { id: 'V008', label: '虚假紧迫感',    dimension: 'false_urgency' },
  EMOTIONAL_MANIP:   { id: 'V009', label: '情感操纵',      dimension: 'emotional_manipulation' },
  GASLIGHTING:       { id: 'V010', label: '煤气灯效应',    dimension: 'gaslighting' },
  FACTUAL_ERROR:     { id: 'V011', label: '事实错误',      dimension: 'factual_consistency' },
  OVERCONFIDENCE:    { id: 'V012', label: '过度自信',      dimension: 'overconfidence' },
  BIAS_DISCRIM:      { id: 'V013', label: '偏见歧视',      dimension: 'bias' },
  COPYRIGHT_INF:     { id: 'V014', label: '版权侵权',      dimension: 'copyright' },
  SAFETY_BYPASS:     { id: 'V015', label: '安全绕过',      dimension: 'safety_bypass' },
  UNKNOWN:           { id: 'V016', label: '未知违规',      dimension: 'unknown' },
});

function tagViolation(dimension, severity, action, detail = '') {
  const tag = Object.values(VIOLATION_TAGS).find(t => t.dimension === dimension) || VIOLATION_TAGS.UNKNOWN;
  return {
    ...tag,
    severity,
    action,
    detail,
    taggedAt: Date.now(),
  };
}

// ── 国标 16 违规行为枚举 ─────────────────────────────────
function listViolationTags() {
  return Object.entries(VIOLATION_TAGS).map(([key, val]) => ({ key, ...val }));
}

module.exports = {
  initChain,
  appendEntry,
  verifyChain,
  queryChain,
  tagViolation,
  listViolationTags,
  chainState,
  VIOLATION_TAGS,
  MAX_CHAIN_ENTRIES,
};

