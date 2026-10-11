/**
 * test/_corpus-arrays.js — 从校准脚本解析语料数组(共享 helper)
 *
 * [test-coverage-gap·第二百一十二轮] 新建。
 *
 * ═══ 为什么需要它 ═══
 * 有四个测试要读校准语料(BENIGN / MALICIOUS), 而 `scripts/calibrate-fp-recall.js`
 * 的顶层会跑完整校准并写 `data/feedback/` —— 不能 require 它。所以每个测试都
 * 自己解析数组字面量。到本轮为止已有两份内联实现:
 *   · test/corpus-dimension-reach-disclosure.test.js 的 parseCorpusArray
 *   · test/reasoning-coherence-gate-dead-branch.test.js 的 parseCorpusArray
 * 而另外三个测试走的是**另一条路**: 读 `/tmp/corpus149.json`。
 *
 * 那条路已经坏了, 而且坏了很久:
 *   · test/absolute-claim-commitment.test.js:87
 *   · test/contradiction-self-correction.test.js:121
 *     都是 `if (!fs.existsSync(p)) return;` —— 文件不在就**什么都不测,
 *     直接退出 0**。实测该文件当前不存在于本机, 所以这两例现在是零覆盖。
 *     注释写着"不虚构通过", 诚实, 但沉默于代价: 它们要护的读数无保护。
 *   · test/dimension-guidance-coverage.test.js:84
 *     用 existsSync 兜底一份 5 条固定样本, 于是它永远能跑 —— 但文件在与不在
 *     测的是**两批不同数据**, 读数会静默变化而不被说出。
 *
 * 这就是 cycle 207 的主题("测试套件依赖调用方机器上恰好有的东西")的第三处
 * 残留。cycle 207 修了另外两处并留下这三处, 原话是"三处的断言都要对着
 * 199-sample corpus 重新推导"。
 *
 * ═══ 设计 ═══
 * 一个函数, 返回 { BENIGN, MALICIOUS, ALL, benignCount, maliciousCount }。
 * 解析失败**抛错**, 不返回空数组 —— 空数组会让调用方的 `assertEqual(hit.length, 2)`
 * 变成一条恒真的断言(0 !== 2 会红, 但若断言的是 0 就恒真), 那是 cycle 188
 * 记录的"打印的 0 读起来像测出来的 0"。
 *
 * 语料规模是会长的(199 → 201, 本轮实测), 所以本 helper **不导出任何硬编码
 * 规模**; 调用方要么从 `benignCount` 推, 要么显式写自己那一个读数并在用例名里
 * 注明它是本轮实测(见 contradiction-self-correction 的同步)。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CALIB = path.join(ROOT, 'scripts', 'calibrate-fp-recall.js');

function parseArray(name) {
  const src = fs.readFileSync(CALIB, 'utf8');
  const m = src.match(new RegExp('const ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\n\\];'));
  if (!m) throw new Error('在校准脚本里找不到数组 ' + name + ' —— 它的声明形态变了?');
  const out = [];
  for (const line of m[1].split('\n')) {
    const s = line.match(/^\s*'((?:[^'\\]|\\.)*)'/);
    if (s) out.push(s[1].replace(/\\'/g, "'"));
  }
  return out;
}

let cache = null;

function loadCorpus() {
  if (cache) return cache;
  const BENIGN = parseArray('BENIGN');
  const MALICIOUS = parseArray('MALICIOUS');
  if (BENIGN.length === 0) throw new Error('BENIGN 解析出 0 条 —— 解析器坏了, 拒绝返回空语料');
  if (MALICIOUS.length === 0) throw new Error('MALICIOUS 解析出 0 条 —— 解析器坏了, 拒绝返回空语料');
  cache = {
    BENIGN, MALICIOUS,
    ALL: [...BENIGN, ...MALICIOUS],
    benignCount: BENIGN.length,
    maliciousCount: MALICIOUS.length,
    corpusSize: BENIGN.length + MALICIOUS.length,
  };
  return cache;
}

module.exports = { loadCorpus, parseArray, CALIB };
