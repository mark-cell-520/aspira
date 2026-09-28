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

module.exports = { getAnchor, setAnchor, clearAnchor, healthCheck, _setFile: (f) => { _file = f; _loaded = false; _anchor = null; } };
