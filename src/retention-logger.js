#!/usr/bin/env node
/**
 * [v6.7.7] RetentionLogger — 关键日志 180 天留存策略
 * 
 * 国标要求：关键安全事件需留存 180 天以上
 * 实现：
 *   - JSON Lines 格式（.jsonl），每日一个文件
 *   - 自动轮转：超过 180 天的文件自动归档到 archive/ 并压缩
 *   - 分类：audit / security / compliance / circuit-breaker
 *   - 查询接口：按时间范围、分类、traceId 检索
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const ARCHIVE_DIR = path.join(LOG_DIR, 'archive');
const RETENTION_DAYS = 180;

class RetentionLogger {
  constructor(category = 'audit', opts = {}) {
    this.category = category;
    this.logDir = opts.logDir || LOG_DIR;
    this.archiveDir = opts.archiveDir || ARCHIVE_DIR;
    this.retentionDays = opts.retentionDays || RETENTION_DAYS;
    this._ensureDirs();
  }

  _ensureDirs() {
    [this.logDir, this.archiveDir].forEach(d => {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
  }

  _todayFile() {
    const d = new Date().toISOString().slice(0, 10);
    return path.join(this.logDir, `${this.category}-${d}.jsonl`);
  }

  /**
   * 写入一条日志（JSON Lines）
   */
  log(entry) {
    const line = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      category: this.category,
      traceId: entry.traceId || undefined,
      event: entry.event,
      severity: entry.severity || 'info',
      actor: entry.actor || 'system',
      details: entry.details || {},
    };
    const file = this._todayFile();
    fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf-8');
    this._rotateIfNeeded();
  }

  /**
   * 轮转：超过 retentionDays 的日志移动到 archive/ 并 gzip 压缩
   */
  _rotateIfNeeded() {
    const cutoff = Date.now() - this.retentionDays * 86400000;
    try {
      const files = fs.readdirSync(this.logDir).filter(f => f.startsWith(this.category + '-') && f.endsWith('.jsonl'));
      for (const f of files) {
        const fp = path.join(this.logDir, f);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          const arcName = f.replace('.jsonl', '.jsonl.gz');
          const arcPath = path.join(this.archiveDir, arcName);
          const gz = zlib.gzipSync(fs.readFileSync(fp));
          fs.writeFileSync(arcPath, gz);
          fs.unlinkSync(fp);
        }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * 查询：按时间范围（start/end ISO）返回日志条目
   */
  // [契约修复] log() 一直写入 severity / actor / details 三个字段，但 query()
  // 只按 start/end/traceId/event 过滤 —— severity 声明在
  // aspira_retention_log 的 inputSchema 里、调用方也真的在传，却在底层
  // 被完全忽略。实测传 severity:"critical" 与 severity:"info"
  // 返回**完全相同**的结果。这是"参数能到 handler、却在底层静默失效"
  // 的形态 —— 比未声明更隐蔽，因为调用方看不到任何错误。
  query(opts = {}) {
    const { start, end, traceId, event, severity, limit = 100 } = opts;
    const startMs = start ? new Date(start).getTime() : 0;
    const endMs = end ? new Date(end).getTime() : Date.now();
    const results = [];
    const files = fs.readdirSync(this.logDir).filter(f => f.startsWith(this.category + '-') && f.endsWith('.jsonl'));
    for (const f of files) {
      try {
        const lines = fs.readFileSync(path.join(this.logDir, f), 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.ts < startMs || obj.ts > endMs) continue;
            if (traceId && obj.traceId !== traceId) continue;
            if (event && obj.event !== event) continue;
            if (severity && obj.severity !== severity) continue;
            results.push(obj);
            if (results.length >= limit) return results;
          } catch (_) { /* skip corrupt line */ }
        }
      } catch (_) { /* skip unreadable file */ }
    }
    return results;
  }
}

module.exports = { RetentionLogger };
