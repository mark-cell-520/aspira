/**
 * test/benchmark-external-anchor-wiring.test.js — 外部锚定必须真的接上
 *
 * ═══ 实测到的缺陷 ═══
 * src/cortex/self-benchmark.js:11 从第一版起就
 *     const { anchorSync } = require('./benchmark-external-anchor.js');
 * 而 benchmark-external-anchor.js 从来只导出
 *     getAnchor / setAnchor / clearAnchor / healthCheck / _setFile
 * —— `anchorSync` 是 undefined。
 *
 * 调用点 self-benchmark.js:74 又是
 *     try { external = anchorSync(this.hf); } catch (_) { external = null; }
 * 于是 TypeError 被 catch 吞掉，`external` 恒为 null。
 *
 * 后果不是崩溃，是整条外部锚定分支结构性不可达：
 *   · assess() 的 verified 永远 false、externalAnchor 永远 null；
 *   · `0.4*内部 + 0.6*外部*100` 这条加权永远走不到，只能走内部分打 0.7 折；
 *   · 而启动日志照报「外部锚定防自欺已启用」。
 * 方法存在、调用成功、不抛错、没有效果 —— 与本文件头记录的 stub 缺陷
 * （setAnchor 不存储）同族，只是那一次修好了存储层，没修消费层。
 *
 * 实测证据（修复前）：anchorSync 类型 undefined，调用抛
 *   TypeError: anchor.anchorSync is not a function
 * 无锚时 assess() → verified=false；有锚时（setAnchor({score:0.9})）
 *   assess() 仍然 verified=false —— 因为根本走不到那条分支。
 *
 * ═══ 修法 ═══
 * 在 benchmark-external-anchor.js 补上 anchorSync()：读外部经 setAnchor 写入的
 * 锚，返回 assess() 期望的形状。**没有外部锚时不得伪造分数** —— 防自欺护栏的
 * 全部意义就在于"无外部验证时明确标记未验证"，此处编一个分数出来等于让护栏
 * 给自己开通行证。所以无锚 → available:false、score:null，verified 仍为 false。
 *
 * ═══ 为什么反向证明要用配对副本 ═══
 * self-benchmark.js 用固定相对路径 require('./benchmark-external-anchor.js')，
 * 单独加载一个变异副本无法把 self-benchmark 的链路导向它（与 cycle 221 在
 * gate.js 上遇到的是同一件事）。所以把两个文件按原相对结构复制到临时目录，
 * 只变异副本里的锚模块，再 require 副本里的 self-benchmark。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'cortex');
const ANCHOR_FILE = path.join(SRC, 'benchmark-external-anchor.js');
const BENCH_FILE = path.join(SRC, 'self-benchmark.js');

/** 把锚模块 + self-benchmark 按原相对结构复制到临时目录，返回 { root, anchorPath, benchPath } */
function makePair(mutateAnchor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-anchor-pair-'));
  const cortex = path.join(root, 'cortex');
  const memory = path.join(root, 'memory');
  fs.mkdirSync(cortex, { recursive: true });
  fs.mkdirSync(memory, { recursive: true });
  // self-benchmark 还 require ../memory/memory-encrypt.js
  fs.copyFileSync(path.join(SRC, '..', 'memory', 'memory-encrypt.js'), path.join(memory, 'memory-encrypt.js'));

  let anchorSrc = fs.readFileSync(ANCHOR_FILE, 'utf8');
  if (mutateAnchor) anchorSrc = mutateAnchor(anchorSrc);
  const anchorPath = path.join(cortex, 'benchmark-external-anchor.js');
  fs.writeFileSync(anchorPath, anchorSrc, 'utf8');

  const benchPath = path.join(cortex, 'self-benchmark.js');
  fs.writeFileSync(benchPath, fs.readFileSync(BENCH_FILE, 'utf8'), 'utf8');
  return { root, anchorPath, benchPath };
}

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('anchorSync 必须被导出且是函数', () => {
    const anchor = require(ANCHOR_FILE);
    assertEqual(typeof anchor.anchorSync, 'function',
      'benchmark-external-anchor.js 必须导出 anchorSync —— 缺了它 self-benchmark.js:74 '
      + '会抛 TypeError 并被自己的 catch 吞掉，外部锚定整条分支静默失效');
    assertEqual(typeof anchor.getAnchor, 'function', '原有存取器不得被修丢');
    assertEqual(typeof anchor.setAnchor, 'function', '原有存取器不得被修丢');
  });

  test('无外部锚时不得伪造分数（防自欺护栏必须保住）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-anchor-'));
    const anchor = require(ANCHOR_FILE);
    anchor._setFile(path.join(root, 'anchor.json'));
    try {
      const r = anchor.anchorSync({});
      assertEqual(r.available, false, '无锚时必须 available:false');
      assertEqual(r.score, null, '无锚时 score 必须为 null —— 编一个分数等于让护栏给自己开通行证');
      assertEqual(r.logicAccuracy, null, '无锚时不得给出逻辑准确率');
      assertEqual(r.humanSatisfaction, null, '无锚时不得给出满意度');
    } finally {
      anchor._setFile(path.join(ROOT, 'data', 'benchmark', 'anchor.json'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('无锚时 assess() 仍必须标 UNVERIFIED 并对内部分打折', () => {
    const { root, benchPath } = makePair(null);
    try {
      const { SelfBenchmark } = require(benchPath);
      const r = new SelfBenchmark({}).assess();
      assertEqual(r.verified, false, '无外部锚时 verified 必须为 false');
      assertTrue(/UNVERIFIED/.test(String(r.guardNote)),
        'guardNote 必须明确标记未验证，防止拿自评分自我激励');
      assertEqual(r.externalAnchor.available, false, 'externalAnchor.available 必须为 false');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('有外部锚时加权必须真的接上（0.4*内部 + 0.6*外部*100）', () => {
    const { root, anchorPath, benchPath } = makePair(null);
    try {
      const anchor = require(anchorPath);
      anchor._setFile(path.join(root, 'anchor.json'));
      anchor.setAnchor({ score: 0.9, logicAccuracy: 0.95, humanSatisfaction: 0.85 });

      const r = anchor.anchorSync({});
      assertEqual(r.available, true, '有可用锚时必须 available:true');
      assertEqual(r.score, 0.9, 'score 必须原样读出');
      assertEqual(r.logicAccuracy, 0.95, 'logicAccuracy 必须原样读出');

      const { SelfBenchmark } = require(benchPath);
      const rep = new SelfBenchmark({}).assess();
      assertEqual(rep.verified, true,
        '有外部锚时 verified 必须为 true —— 修复前这里恒为 false，因为整条分支不可达');
      const expect = Number((0.4 * rep.internalScore + 0.6 * 0.9 * 100).toFixed(2));
      assertEqual(rep.score, expect,
        `加权公式必须精确成立：期望 ${expect}，实际 ${rep.score}`);
      assertEqual(rep.externalAnchor.score, 0.9, '报告必须带上外部锚读数');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('垃圾锚（无可用 score）不得被当成可用锚', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-anchor-'));
    const anchor = require(ANCHOR_FILE);
    anchor._setFile(path.join(root, 'anchor.json'));
    try {
      for (const bad of [{}, { logicAccuracy: 0.9 }, { score: 'high' }, { score: NaN }, null, 'x']) {
        anchor.setAnchor(bad);
        const r = anchor.anchorSync({});
        assertEqual(r.available, false,
          `锚 ${JSON.stringify(bad)} 没有可用 score，不得判为 available`);
        assertEqual(r.score, null, `锚 ${JSON.stringify(bad)} 的 score 必须为 null`);
      }
    } finally {
      anchor._setFile(path.join(ROOT, 'data', 'benchmark', 'anchor.json'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('反向证明：删掉 anchorSync 导出后，有锚时 verified 必须跌回 false', () => {
    // 变异：把 module.exports 里的 anchorSync 删掉，复现修复前的形态
    const { root, benchPath } = makePair((src) =>
      src.replace(/\n\s*getAnchor, setAnchor, clearAnchor, healthCheck, anchorSync,/, '\n      getAnchor, setAnchor, clearAnchor, healthCheck,')
    );
    try {
      const mutated = fs.readFileSync(path.join(root, 'cortex', 'benchmark-external-anchor.js'), 'utf8');
      assertTrue(!/anchorSync,/.test(mutated.split('module.exports')[1] || ''),
        '变异未生效 —— 副本的导出里仍有 anchorSync，本次反向证明无效');

      const { SelfBenchmark } = require(benchPath);
      const rep = new SelfBenchmark({}).assess();
      assertEqual(rep.verified, false,
        '删掉 anchorSync 后，即使有锚 verified 也必须跌回 false —— 否则说明这条锁'
        + '可以被别的东西满足，锚定并未真的经由 anchorSync');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
};
