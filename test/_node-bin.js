/**
 * test/_node-bin.js — run-all 的子进程该用哪个 node, 显式解析, 不依赖调用方 PATH。
 *
 * [test-coverage-gap·第二百零七轮] 新建。
 *
 * ═══ 实测形状(第二百零六轮收尾时撞上) ═══
 * 那个会话的 shell 的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`, 而 node 在
 * `/usr/local/bin/node`。`test/run-all.js` 用字面量 node 起 397 个子进程, 于是
 * **每一个**都 Command failed, 全量测试读出 `0 通过 / 397 失败` ——
 * 一个完全健康的仓库, 在一次完全健康的调用下全军覆没。
 *
 * 这是 cycle 142 已定位并修复的 **git PATH 依赖的同族新实例**, 而且更烈:
 *   · cycle 142: 一个测试文件(security-audit 的 S2)依赖调用方环境,
 *     症状是 ~1/6 间歇红, 六轮没能定位;
 *   · 本轮: **整个测试运行器**依赖调用方环境, 症状是 100% 失败,
 *     但因为补一下 PATH 就全绿, 它极易被当成"我的环境问题"而滑过去。
 *
 * 修法照抄 cycle 142: 显式在若干标准位置找二进制并用绝对路径, 找不到才回退。
 * 对 node 而言最可靠的候选是 `process.execPath` —— run-all 自己就是被 node
 * 跑起来的, 它的子进程理应出自同一个解释器; 标准位置列表是它的兜底
 * (execPath 为空、或被剥离、或本进程是嵌入态时)。
 *
 * ⚠️ 回退值必须是裸 `'node'`: 那正是"真的哪儿都没有 node"时该有的样子 ——
 * 这时 ENOENT 是真实缺失, 而不是一个被静默吞掉的环境差异。
 *
 * 由 test/node-binary-path-independence.test.js 锁定(源级 + 收窄 PATH 行为 +
 * 反向证明), 与 test/git-binary-path-independence.test.js 同构。
 */
'use strict';

const fs = require('fs');

const NODE_CANDIDATES = [
  process.execPath,                  // 本进程自己的解释器 —— 首选
  '/usr/local/bin/node',             // Homebrew / nvm 默认落地处(本轮实测就在这里)
  '/opt/homebrew/bin/node',          // Apple Silicon Homebrew
  '/usr/bin/node',
  '/usr/local/node/bin/node',
];

function resolveNodeBin() {
  for (const c of NODE_CANDIDATES) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) { /* 候选路径不可判就试下一个 */ }
  }
  // 哪儿都没找到: 交回 PATH 查找。此时 ENOENT 是真实的 node 缺失。
  return 'node';
}

const NODE_BIN = resolveNodeBin();

module.exports = { NODE_BIN, resolveNodeBin, NODE_CANDIDATES };
