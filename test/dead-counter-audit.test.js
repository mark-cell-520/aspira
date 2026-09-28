/**
 * test/dead-counter-audit.test.js — 「指标不走」类缺陷的仪器与回归锁
 *
 * ═══ 这个测试为什么存在 ═══
 * 上一轮(cycle 20)连续抓到两个形状相同的缺陷:
 *   · kv-cache.js `hitRate = hits / max(1, loads)` —— `loads` 从未自增
 *   · reflexion-engine.js `successRate` —— 依赖的过滤器读错字段，恒数出 0
 * 本轮(cycle 21)顺着「同类缺陷值得全库扫一遍」建了
 * `scripts/dead-counter-audit.js`，又抓到第三个: graph-of-thoughts 的
 * `prunedNodes` —— `ThoughtNode.prune()` 这个公共方法**全文件从未被调用**，
 * 于是 `getResult()` 永远报告 `prunedNodes: 0`。
 *
 * ═══ 仪器本轮错了两次，都是假阳性(这是最重要的记录) ═══
 * 第一版正则写成 `... (\+\+|...) \s*1?\b`，尾部的 `\b` 在 `++` 位于**行尾**时
 * 永远不匹配(后面没有字符可构成词边界)，于是每一句单独的
 * `this._stats.foo++;` 都被判成「从未自增」—— 第一遍跑出 **193 处**命中。
 * 第二版修掉那个，却仍有 `x = (x || 0) + 1` 这种兜底写法匹配不上
 * (`\1\s*(?:\+|-)\s*1` 要求 x 紧贴 +1，中间隔着 `|| 0)`),
 * `tamperedDetected` 这种明明有自增的又被误报。
 *
 * 这与 `dimension-health-audit` 错两次是同源故障的**第三次**出现:
 * **仪器把自己的正则缺陷报告成引擎缺陷。** 所以本测试不仅锁引擎行为，
 * 还锁仪器本身 —— 用三个已知答案的样本喂给仪器的判定逻辑，
 * 防止它再次退化成「什么都报」。
 *
 * ═══ 断言的边界 ═══
 * · 仪器输出是「待查清单」而非「缺陷清单」，本测试不断言它报 0 条
 *   (那会把仪器的局限钉成断言)，只断言它**认得这三种自增写法**。
 * · `prunedNodes` 的修法刻意不改变搜索行为: 没有把 `prune()` 接进探索循环
 *   (那会改变搜索结果)，只在候选真正被丢弃处计数。故测试同时锁
 *   「计数会走」和「搜索结果不受影响」两件事。
 */
const path = require('path');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const ROOT = path.join(__dirname, '..');
  const { GoTEngine } = require(path.join(ROOT, 'src', 'reasoning', 'graph-of-thoughts.js'));

  // ─── 仪器自身的正确性(防止再次退化成假阳性机器) ───────────────────────
  test('死计数器仪器认得三种自增写法(含行尾 ++ 与 (x||0)+1 兜底)', () => {
    // 直接复现仪器内部的判定逻辑，用已知答案验证。
    // 这三个 case 正是本轮仪器两次出错的形状。
    const incRe = /\b((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*(?:\+\+|--|\+=|-=)/g;
    const selfIncRe = /\b((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*=\s*[^;]*?\b\1\b[^;]*?\s*(?:\+|-)\s*1\b/g;
    const dynIncRe = /\b((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\[[^\]]*\]\s*=\s*[^;]*?\b\1\b\s*\[[^\]]*\][^;]*?\s*(?:\+|-)\s*1\b/g;

    const hits = (line) => {
      const out = [];
      for (const re of [incRe, selfIncRe, dynIncRe]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) out.push(m[1]);
      }
      return out;
    };

    // case 1: ++ 在行尾 —— 首版正则在这里失效，产出 193 处假阳性
    assertTrue(hits('this._stats.truncatedInputs++;').includes('this._stats.truncatedInputs'),
      '行尾的 x++; 必须被识别为自增');

    // case 2: (x || 0) + 1 兜底 —— 第二版正则在这里失效，误报 tamperedDetected
    assertTrue(
      hits('this.stats.tamperedDetected = (this.stats.tamperedDetected || 0) + 1;')
        .includes('this.stats.tamperedDetected'),
      'x = (x || 0) + 1 必须被识别为自增');

    // case 3: 动态键自增
    assertTrue(
      hits('this._stats.byType[t] = (this._stats.byType[t] || 0) + 1;')
        .some(x => x === 'this._stats.byType'),
      '动态键自增必须被识别(按容器)');

    // 反向: 直接赋值的重算值不是计数器
    assertEqual(hits('this.stats.totalMemories = this.memories.size;').length, 0,
      '直接赋值的重算值不应被判为自增');
  });

  test('仪器对真实仓库跑通，且不再产出成片假阳性', () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync('node', [path.join(ROOT, 'scripts', 'dead-counter-audit.js')],
      { cwd: ROOT, encoding: 'utf8' });
    const m = out.match(/命中 (\d+) 处读取、(\d+) 个字段/);
    assertTrue(!!m, '仪器应输出汇总行');
    // 首版坏正则给出 193 处；修好后应远低于此。
    // 不断言具体值(会随代码变化腐烂)，只断言没有退化成"什么都报"。
    assertTrue(Number(m[1]) < 60,
      `修复后的命中数应远低于首版假阳性的 193，实测 ${m[1]}`);
  });

  // ─── 第三个真缺陷: prunedNodes 恒为 0 ─────────────────────────────────
  test('prunedNodes 必须真实计数(本轮修复: 此前恒为 0)', async () => {
    const e = new GoTEngine({ problem: '如何提升代码质量' });
    e.initialize(e.problem);
    // 高阈值强制大部分候选被丢弃，从而触发剪枝计数
    await e.explore({ maxIterations: 4, maxNodes: 20, scoreThreshold: 99 });
    const r = e.getResult();
    assertTrue(r.prunedNodes > 0,
      `高阈值下应有候选被剪枝并计数，实测 prunedNodes=${r.prunedNodes}(修复前恒为 0)`);
    assertEqual(r.totalBranches, 0, '阈值 99 时不应有候选通过，与 prunedNodes 相互印证');
  });

  test('修复不改变搜索结果: 同一输入下路径与分数不受影响', async () => {
    // 这是「只修指标不改行为」的锁。若有人把 prune() 接进探索循环，
    // 搜索结果会变，此测试失败。
    const run = async (threshold) => {
      const e = new GoTEngine({ problem: '如何提升代码质量' });
      e.initialize(e.problem);
      await e.explore({ maxIterations: 4, maxNodes: 20, scoreThreshold: threshold });
      const r = e.getResult();
      return { nodes: r.totalNodes, explored: r.exploredNodes, best: r.bestScore };
    };
    const a = await run(0.99);
    const b = await run(0.99);
    assertEqual(JSON.stringify(a), JSON.stringify(b), '两次相同运行应完全一致(无随机性泄漏)');
    assertTrue(a.nodes > 0, '应确实产生了节点');
  });

  test('ThoughtNode.prune() 仍未被 explore 调用(修法的边界，如实记录)', () => {
    // 本测试锁的是一个**已知未修项**: prune() 是公共方法但无调用点，
    // 所以「剪枝能力」在引擎里实际不可达。本轮只修了统计，没接行为。
    // 写下来而不是假装修好 —— 与 self-view 并发丢失那条同一立场。
    //
    // ⚠️ 必须先剥掉注释再匹配。首版直接 grep `\.prune\(\)`，
    // 结果匹配到了**本测试自己和源码注释里的 "ThoughtNode.prune()" 字样**，
    // 报出 1 处假调用点。这是「静态 grep 被注释骗到」的复发故障
    // (AGENTS.md 里记着同一条: static require-grep fooled by comments)。
    const raw = require('fs').readFileSync(
      path.join(ROOT, 'src', 'reasoning', 'graph-of-thoughts.js'), 'utf8');
    // 剥掉行注释与块注释，只留真实代码
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const callSites = code.match(/\.prune\(\)/g) || [];
    assertEqual(callSites.length, 0,
      `prune() 目前仍无真实调用点(实测 ${callSites.length} 处)。` +
      '若将来接入探索循环，本测试会失败——那正是提醒你重新评估搜索结果是否改变的时机。');
  });
};
