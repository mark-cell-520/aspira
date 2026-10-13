/**
 * benchmark-external-anchor.js — 基准测试外部锚点
 *
 * [契约修复] 首版是一个纯 stub: setAnchor() 接收值后**不存储**，
 * getAnchor() 恒返回 null。实测:
 *     setAnchor(1); getAnchor()  →  null
 * 即"写进去读不出来"。这类缺陷比抛异常更难发现:
 * 方法存在、调用成功、不抛错，只是**没有效果**。
 *
 * 现补上内存存储 + 落盘持久化(与 memory.js 的 AES 配置保持一致的
 * 只读优先策略: 无密钥时明文落盘并明确标记)。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '../../data/benchmark/anchor.json');

let _anchor = null;      // 内存缓存
let _loaded = false;     // 是否已尝试过从磁盘加载
let _file = DEFAULT_FILE;

function _loadOnce() {
  if (_loaded) return;
  _loaded = true;
  try {
    if (fs.existsSync(_file)) {
      _anchor = JSON.parse(fs.readFileSync(_file, 'utf8'));
    }
  } catch (e) { /* 损坏的锚点文件按"无锚点"处理, 不阻断调用方 */ }
}

function getAnchor() {
  _loadOnce();
  return _anchor;
}

function setAnchor(anchor) {
  _anchor = anchor;
  _loaded = true;
  // 落盘(尽力而为: 失败不影响内存态, 但调用方应知道未持久化)
  try {
    fs.mkdirSync(path.dirname(_file), { recursive: true });
    const tmp = _file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(anchor, null, 2), 'utf8');
    fs.renameSync(tmp, _file);   // 原子替换, 避免读者读到写了一半的文件
  } catch (e) { /* 忽略: 只读环境或权限不足时退化为纯内存锚点 */ }
  return anchor;
}

function clearAnchor() {
  _anchor = null;
  try { if (fs.existsSync(_file)) fs.unlinkSync(_file); } catch (e) {}
  return true;
}

function healthCheck() {
  _loadOnce();
  return { ok: true, hasAnchor: _anchor !== null && _anchor !== undefined, persisted: fs.existsSync(_file) };
}

/**
 * 供 self-benchmark.assess() 消费的同步取锚入口。
 *
 * ═══ 这个函数为什么必须补上 ═══
 * self-benchmark.js:11 从第一版起就 `const { anchorSync } = require(...)`，
 * 而本模块从来只导出 getAnchor/setAnchor/clearAnchor/healthCheck ——
 * `anchorSync` 是 undefined。调用点 self-benchmark.js:74 又是
 *     try { external = anchorSync(this.hf); } catch (_) { external = null; }
 * 于是 TypeError 被 catch 吞掉，`external` 恒为 null。
 *
 * 后果不是崩溃，而是**整条外部锚定分支结构性不可达**：
 *   · `verified` 永远 false，`externalAnchor` 永远 null；
 *   · `0.4*内部 + 0.6*外部` 这条加权永远走不到，只能走内部分打 0.7 折的分支；
 *   · 启动日志照报「外部锚定防自欺已启用」。
 * 即"报告成功、实际没干"—— 方法存在、调用成功、不抛错、没有效果。
 * 这正是本文件头记录的 stub 缺陷（setAnchor 不存储）的同族，只是那一族
 * 修好了存储层，没修消费层。
 *
 * ═══ 契约 ═══
 * 返回 assess() 期望的形状。**没有外部锚时不得伪造分数** ——
 * 防自欺护栏的全部意义就在于"无外部验证时明确标记未验证"，
 * 若此处编一个分数出来，等于让护栏给自己开通行证。
 * 锚由外部经 setAnchor() 写入；本函数只读、不计算、不推断。
 *
 * @param {object} _hf - 引擎实例（预留；当前取锚不依赖引擎状态）
 * @returns {{available: boolean, score: number|null, logicAccuracy: number|null, humanSatisfaction: number|null}}
 */
function anchorSync(_hf) {
  _loadOnce();
  const a = _anchor;
  if (!a || typeof a !== 'object') {
    return { available: false, score: null, logicAccuracy: null, humanSatisfaction: null };
  }
  // score 是 0..1 的复合分；缺失或非有限数一律按"无可用锚"处理
  const score = (typeof a.score === 'number' && isFinite(a.score)) ? a.score : null;
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
  return {
    available: score !== null,
    score,
    logicAccuracy: num(a.logicAccuracy),
    humanSatisfaction: num(a.humanSatisfaction),
  };
}

module.exports = {
  getAnchor, setAnchor, clearAnchor, healthCheck, anchorSync,
  _setFile: (f) => { _file = f; _loaded = false; _anchor = null; },
};
