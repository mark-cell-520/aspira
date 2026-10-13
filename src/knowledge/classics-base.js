/**
 * classics-base.js — 儒藏/道藏/佛藏语料库（daizhigev20）路径解析
 *
 * [FIX 2026-09-19] 原来 classics-rules.js / classics-feedback.js 都用
 *   path.join(__dirname, '..', '..', '..', '..', 'daizhigev20')
 * 硬推四级目录。当技能被安装到别的用户的 skills 目录下（例如引擎跑在
 * claude-bot 下，而语料库装在 root 的 ~/.hermes/skills/daizhigev20），
 * 解析结果就指向一个不存在的路径，古典检索整条链路静默失效。
 *
 * 现在按优先级找第一个真实存在的目录，并允许用环境变量显式指定。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function _exists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function _candidates() {
  const list = [];

  // 1. 显式环境变量优先
  if (process.env.DAIZHIGEV20_PATH) list.push(process.env.DAIZHIGEV20_PATH);
  if (process.env.CLASSICS_BASE) list.push(process.env.CLASSICS_BASE);

  // 2. 与本技能同级（原来的行为，保留兼容）
  list.push(path.join(__dirname, '..', '..', '..', '..', 'daizhigev20'));

  // 3. 常见的 hermes skills 安装位置
  const homes = [os.homedir(), '/root', '/home/claude-bot'];
  for (const home of homes) {
    list.push(path.join(home, '.hermes', 'skills', 'daizhigev20'));
  }

  // 4. 全局位置
  list.push('/usr/local/share/hermes/skills/daizhigev20');
  list.push('/opt/hermes/skills/daizhigev20');

  return [...new Set(list)];
}

let _resolved;

function resolveClassicsBase() {
  if (_resolved !== undefined) return _resolved;
  for (const candidate of _candidates()) {
    if (_exists(candidate)) {
      _resolved = candidate;
      return _resolved;
    }
  }
  _resolved = null;
  return null;
}

const CLASSICS_BASE = resolveClassicsBase();
const SCRIPT = CLASSICS_BASE ? path.join(CLASSICS_BASE, 'scripts', 'search_guji.sh') : null;

module.exports = {
  CLASSICS_BASE,
  SCRIPT,
  resolveClassicsBase,
  isAvailable: () => resolveClassicsBase() !== null,
};
