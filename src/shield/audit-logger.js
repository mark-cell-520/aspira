/**
 * AuditLogger — 决策审计日志引擎 v1.0.0
 *
 * 记录每次 gate 决策的完整证据链，支持事后合规审查。
 * 关键设计：记录"什么被拒绝过"（negative space），不是只记"什么执行了"
 *
 * 集成: require('./audit-logger.js')
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class AuditLogger {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(process.cwd(), 'data', 'audit');
    this.maxEntries = options.maxEntries || 10000;
    this.entries = [];
    // [v6.7.70] JSONL 追加式日志：logPath 显式指定单文件路径（审计基础设施诚信化改造）
    this.logPath = options.logPath || null;
    this.silent = options.silent !== false;
    this._lastHash = null;
    this._init();
  }

  _init() {
    try {
      if (this.logPath) {
        const dir = path.dirname(this.logPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // 恢复哈希链尾值，保证重启后续写仍能校验
        this._lastHash = this._tailHash();
      } else if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (e) { /* dir init silent */ }
  }

  /** 读取日志文件最后一条的哈希，作为新条目的链接前值 */
  _tailHash() {
    try {
      if (!this.logPath || !fs.existsSync(this.logPath)) return null;
      const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
      if (!lines.length) return null;
      const last = JSON.parse(lines[lines.length - 1]);
      return last && typeof last.h === 'string' ? last.h : null;
    } catch (e) { return null; }
  }

  /**
   * 追加一条审计事件到 JSONL 日志（带防篡改哈希链）
   * @param {string} event - 事件类型，如 security_event / engine_start / evolution_cycle
   * @param {Object} payload - 事件明细
   * @returns {string} 本条哈希
   */
  log(event, payload = {}) {
    const core = {
      ts: new Date().toISOString(),
      e: String(event),
      d: payload && typeof payload === 'object' ? payload : { value: payload },
    };
    // 哈希链：本条目哈希 = sha256(上一条哈希 + 本条明文)，任一条被改都会断链
    const h = crypto.createHash('sha256')
      .update((this._lastHash || 'genesis') + JSON.stringify(core))
      .digest('hex')
      .slice(0, 12);
    const line = { ...core, h };

    if (this.logPath) {
      try {
        fs.appendFileSync(this.logPath, JSON.stringify(line) + '\n');
        this._lastHash = h;
      } catch (e) { /* persist silent */ }
    }
    return h;
  }

  /** 从磁盘读取最近 n 条审计事件 */
  readRecent(n = 50) {
    try {
      if (!this.logPath || !fs.existsSync(this.logPath)) return [];
      const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, n)).map(l => {
        try { return JSON.parse(l); } catch (e) { return { e: 'parse_error', raw: l.slice(0, 80) }; }
      });
    } catch (e) { return []; }
  }

  /** 校验哈希链完整性，返回 { valid, brokenAt } */
  verifyChain() {
    const all = this.readRecent(Number.MAX_SAFE_INTEGER);
    let prev = 'genesis';
    for (let i = 0; i < all.length; i++) {
      const { h, ...core } = all[i];
      const expect = crypto.createHash('sha256')
        .update(prev + JSON.stringify(core))
        .digest('hex')
        .slice(0, 12);
      if (h !== expect) return { valid: false, brokenAt: i, total: all.length };
      prev = h;
    }
    return { valid: true, total: all.length };
  }

  /** 报告审计基础设施自身状态 */
  getStats() {
    return {
      persisted: !!(this.logPath && fs.existsSync(this.logPath)),
      logPath: this.logPath || null,
      logDir: this.logDir,
      memoryEntries: this.entries.length,
      totalEntries: this.entries.length,
      chain: this.verifyChain(),
    };
  }

  /** 同步写入无需 flush，保留 close 供调用方显式收尾 */
  close() { /* appendFileSync 已同步落盘，无需额外操作 */ }

  /**
   * 记录授权决策
   * @param {string} actionType - granted|denied|escalated|conditional
   * @param {Object} decision - 决策详情
   */
  record(actionType, decision) {
    const entry = {
      id: `audit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      ts: Date.now(),
      actionType,
      decision: {
        action: decision.action,
        riskScore: decision.risk_score || decision.riskScore || 0,
        reason: decision.reason || '',
        tool: decision.tool || '',
        agent: decision.agent || 'unknown',
        sessionId: decision.sessionId || '',
        conditions: decision.conditions || [],
        provenance: decision.provenance || [],
      },
      snapshot: {
        contextHash: crypto.createHash('sha256').update(JSON.stringify({
          tool: decision.tool, reason: decision.reason, riskScore: decision.risk_score
        })).digest('hex').slice(0, 12),
      },
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();

    // 落盘
    this._persist(entry);
    return entry.id;
  }

  /** 记录被拒绝的操作（negative space） */
  recordDenied(decision) {
    return this.record('denied', decision);
  }

  /** 记录被授权的操作 */
  recordGranted(decision) {
    return this.record('granted', decision);
  }

  /** 获取审计报告 */
  getReport(options = {}) {
    const entries = options.lastN ? this.entries.slice(-options.lastN) : this.entries;
    const denied = entries.filter(e => e.actionType === 'denied');
    const granted = entries.filter(e => e.actionType === 'granted');

    return {
      totalEntries: this.entries.length,
      granted: granted.length,
      denied: denied.length,
      escalated: entries.filter(e => e.actionType === 'escalated').length,
      conditional: entries.filter(e => e.actionType === 'conditional').length,
      recentDenied: denied.slice(-5).map(e => ({
        reason: e.decision.reason,
        tool: e.decision.tool,
        agent: e.decision.agent,
        ts: e.ts,
      })),
      recentGranted: granted.slice(-5).map(e => ({
        reason: e.decision.reason,
        tool: e.decision.tool,
        ts: e.ts,
      })),
    };
  }

  _persist(entry) {
    try {
      const logFile = path.join(this.logDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch (e) { /* persist silent */ }
  }

  reset() {
    this.entries = [];
  }
}

module.exports = { AuditLogger };
