/**
 * test/dimension-no-dual-push.test.js — 同一个维度不得被推两条 finding
 *
 * [dimension-health-audit·第二百三十二轮] 新建。
 *
 * ═══ 这个锁护的是什么 ═══
 * `src/index.js` 的 discriminate() 有**两条**推 finding 的路:
 *   ① 通用循环 `for (const d of allDims)` —— 推 `${d.name}(${detail}次)`,
 *      其中 detail 是 `dimObj?.count || … || 1` 的兜底值, 指不出是哪一处;
 *   ② 若干维度的**专属推送块** —— 推 `无依据断言(N处: <matched>)` 这类可执行详情。
 * 一个维度如果同时出现在两条路上, 同一个问题就被推两条 finding。
 *
 * 本轮实测: `unsupported_claim` 是唯一这样的一员。全池 11624 条输入里 98 条触发它,
 * **98 条全部双推**, 其中 82 条 gate=verify。两条 severity 同为
 * Math.round(uc.score*100), 唯一差别是详情 —— 通用那条的信息量是
 * "unsupported_claim(1次)", 一个指不出任何位置的次数。
 *
 * 为什么这是缺陷而不是冗余: `findings.length` 是 gate 的 verify 触发条件之一
 * (AGENTS.md: 该规则曾是 8/45 恶意样本的唯一拦截原因)。虚增它等于以噪声换判决,
 * 而噪声那条 finding 没有任何可执行内容。
 *
 * 这正是 AGENTS.md 记录过的形状第三次: cycle 11 的跨度双算、cycle 11 的
 * pseudo_causal/soft_deflection 双推(当时从 allDims 整条删除)、以及本轮。
 * 前两次修的是**点名的实例**, 注释里明明写着"uc/pc/sd 那三段 if", 删除却只覆盖
 * pc/sd —— cycle 208 的形状: 针对命名实例的修复留下完整的类。
 *
 * ═══ 为什么不能顺手改成"从 allDims 删除" ═══
 * allDims 有**两个**消费者: 第 535 行的惩罚模型读 PENALTY_WEIGHT / PENALTY_CAP,
 * 而 unsupported_claim 在两处都有专门配置(0.35 / 0.35 —— 它是连续量, 要区分
 * "有来源但表述偏强"与"纯编造")。整条删除会连惩罚一起删掉: 实测全池 gate.action
 * 分布从 `rewrite 245 / verify 752` 变成 `rewrite 244 / verify 753` —— 一条输入
 * 从 rewrite 掉到 verify。本轮的最小改动因此**只跳过推送, 不碰惩罚**。
 *
 * ═══ 已知边界(已实测, 不是猜测) ═══
 * 标注语料对这条缺陷**零表达力**: 137 条良性里 1 条有 count=1 但 score=0(不推
 * finding), 68 条恶意 0 条有信号。所以 0.0% FP / 100.0% recall 这个读数
 * **看不见本轮的改动** —— 不是"没有误报", 是"没有样本能表达这个形状"。
 * 本锁的兜底是仪器同口径的全池扫描, 不是语料。
 */

const fs = require('fs');
const path = require('path');

const ROOT = '/Usersmm/Pictures/aspira'.replace('Usersmm', 'Users/mm');
const SRC = path.join(ROOT, 'src', 'index.js');
const { loadCorpus } = require('./_corpus-arrays.js');

// ── 与其它源级锁同一条纪律: 先剥注释再匹配 ──
// 本轮自己的修复注释里 `unsupported_claim` 出现了十几次, 不剥注释的话
// "allDims 里不得有 unsupported_claim" 这条会判自己的注释有罪。
// 长度保留式(两个注释形态都剥), 且**不剥字符串** —— 剥了字符串就看不见
// `name: 'x'` 与 `dimension: 'x'` 了(cycle 193)。
module.exports = function ({ test }) {
  // mount 形态: run-all 的 pickJob 只认 `module.exports = function/=>` 与 describe( 两种，
  // 其余走裸 node —— 顶层 require('node:test') 打出的 `ℹ tests N` 没有任何解析器读，
  // 文件会跑完、会绿、却对总数贡献 0 例(cycle 15 的形状)。
  const assert = require('node:assert');
  const idx = require(SRC);
  function stripComments(src) {
    const out = [];
    let i = 0, n = src.length, inBlock = false;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (inBlock) { if (c === '*' && d === '/') { inBlock = false; out.push(' ', ' '); i += 2; continue; } out.push(c === '\n' ? '\n' : ' '); i++; continue; }
      if (c === '/' && d === '*') { inBlock = true; out.push(' ', ' '); i += 2; continue; }
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out.push(' '); i++; } continue; }
      if (c === '"' || c === "'" || c === '`') {
        const q = c; out.push(c); i++;
        while (i < n) { if (src[i] === '\\') { out.push(src[i], src[i + 1] || ' '); i += 2; continue; } if (src[i] === q) { out.push(src[i]); i++; break; } out.push(src[i]); i++; }
        continue;
      }
      out.push(c); i++;
    }
    return out.join('');
  }

  function allDimsNames(code) {
    const s = code.indexOf('const allDims = [');
    assert(s !== -1, 'index.js 里找不到 allDims 声明');
    let depth = 0, j = code.indexOf('[', s);
    for (; j < code.length; j++) {
      if (code[j] === '[') depth++;
      else if (code[j] === ']') { depth--; if (depth === 0) break; }
    }
    const block = code.slice(s, j + 1);
    return [...block.matchAll(/name\s*:\s*'([a-z_]+)'/g)].map(m => m[1]);
  }

  function dedicatedPushDims(code) {
    // 通用推入循环之后的所有 `findings.push({ dimension: 'x'`
    const loopIdx = code.indexOf('for (const d of allDims) {');
    assert(loopIdx !== -1, 'index.js 里找不到通用推入循环');
    const loopEnd = code.indexOf('\n  }\n', loopIdx);
    assert(loopEnd !== -1, '通用推入循环的结尾没找到(锚点已变)');
    const after = code.slice(loopEnd);
    return [...new Set([...after.matchAll(/findings\.push\(\{\s*dimension\s*:\s*'([a-z_]+)'/g)].map(m => m[1]))];
  }

  // ── 仪器同口径的输入池 ──
  // 池 B 的构建器从仪器源码里抽出来执行, 不重implement: 重写一份就是
  // cycle 191/201/229 的"复现仪器拿到另一个答案"。testInputs 是纯函数,
  // 只依赖 fs / path / ROOT; 池 C 用仪器**已经导出**的 regexLiteralInputs
  // (被 require 时走 module.exports 分支), 比抽取更权威; 池 A 用共享语料助手。
  function extractFn(code, name) {
    const start = code.indexOf('function ' + name + '(');
    assert(start !== -1, '仪器里找不到 ' + name);
    let depth = 0, i = code.indexOf('{', start), j = i;
    for (; j < code.length; j++) {
      if (code[j] === '{') depth++;
      else if (code[j] === '}') { depth--; if (depth === 0) break; }
    }
    return code.slice(start, j + 1);
  }

  function buildPool() {
    const instSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'dimension-health-audit.js'), 'utf8');
    const factory = new Function('fs', 'path', 'ROOT',
      extractFn(instSrc, 'testInputs') + '\nreturn { testInputs };');
    const { testInputs } = factory(fs, path, ROOT);
    const regexLiteralInputs = require(path.join(ROOT, 'scripts', 'dimension-health-audit.js')).regexLiteralInputs;
    const seen = new Map();
    const pool = [];
    for (const [tag, arr] of [['A', loadCorpus().ALL], ['B', testInputs()], ['C', regexLiteralInputs()]]) {
      for (const s of arr) {
        const k = s.trim();
        if (!k) continue;
        const hit = seen.get(k);
        if (hit !== undefined) { hit.add(tag); continue; }
        const srcs = new Set([tag]);
        seen.set(k, srcs);
        pool.push({ text: s, srcs });
      }
    }
    return pool;
  }

  const FALLBACK_DETAIL = /^[a-z_]+\(\d+次\)$/;

  test('① 源级不变量: 每一条双路维度都必须被跳过集合覆盖, 且不得多跳', () => {
    const code = stripComments(fs.readFileSync(SRC, 'utf8'));
    const inAll = new Set(allDimsNames(code));
    const dedicated = dedicatedPushDims(code);
    const skipSet = new Set([...code.matchAll(/const DEDICATED_PUSH = new Set\(\[([^\]]*)\]\)/g)]
      .flatMap(m => [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])));
    assert(inAll.size >= 40, `allDims 只解析出 ${inAll.size} 个维度 —— 解析坏了, 不是引擎坏了`);
    assert(dedicated.length >= 5, `专属推送块只解析出 ${dedicated.length} 个维度 —— 解析坏了`);
    assert(skipSet.size >= 1, 'DEDICATED_PUSH 解析不出成员 —— 集合被删了, 通用循环会恢复双推');
    // 双路维度 = 既在 allDims(惩罚模型要用) 又有专属推送块的维度。
    // 注意"从 allDims 里删掉"不是正解: 惩罚模型读 PENALTY_WEIGHT/CAP, 见文件头注释。
    const both = [...inAll].filter(d => dedicated.includes(d));
    assert(both.length >= 1, `一个双路维度都没有 —— 不是修好了, 是解析坏了(预期至少 unsupported_claim)`);
    const missed = both.filter(d => !skipSet.has(d));
    assert.deepEqual(missed, [], '这些维度同时走两条推送路却没被跳过, 同一个问题会被推两条 finding: ' + missed.join(', '));
    // 反向: 跳过多余的维度会让那条 finding 彻底消失(不是合并, 是丢失)
    const gratuitous = [...skipSet].filter(d => !both.includes(d));
    assert.deepEqual(gratuitous, [], '跳过了没有专属块的维度 —— 那条 finding 会整条丢失: ' + gratuitous.join(', '));
    // unsupported_claim 必须仍在 allDims 里: 惩罚模型(第 535 行)还要读它的权重与上限
    assert(inAll.has('unsupported_claim'), 'unsupported_claim 不在 allDims 里了 —— 惩罚模型的 0.35/0.35 配置被一起删掉');
    assert(dedicated.includes('unsupported_claim'), 'unsupported_claim 的专属推送块不见了');
    assert(both.includes('unsupported_claim'), 'unsupported_claim 不再是双路维度 —— 要么专属块被删, 要么 allDims 条目被删');
  });

  test('② 行为: 全池没有任何输入为同一个维度推两条 finding', () => {
    const pool = buildPool();
    assert(pool.length > 8000, `池只有 ${pool.length} 条 —— 池构建坏了, 后面的空读数不可信`);
    const dup = [];
    let ucHits = 0;
    for (const { text } of pool) {
      let d;
      try { d = idx.discriminate(text, []); } catch (_) { continue; }
      const count = {};
      for (const f of (d.findings || [])) {
        const k = f.dimension;
        count[k] = (count[k] || 0) + 1;
        if (k === 'unsupported_claim') ucHits++;
      }
      for (const [k, n] of Object.entries(count)) if (n > 1) dup.push([k, n, text.slice(0, 50)]);
    }
    assert.equal(dup.length, 0, '同一维度被推多条 finding: ' + JSON.stringify(dup.slice(0, 5)));
    assert(ucHits > 0, '全池没有一条 unsupported_claim finding —— 这个维度坏了, 不是双推修好了');
  });

  test('③ 行为: unsupported_claim 的 finding 必须带可执行详情, 不是兜底的"维度名(N次)"', () => {
    const probe = 'According to a 2025 Stanford study, 87.3% of agents fail without oversight.';
    const d = idx.discriminate(probe, []);
    const f = (d.findings || []).filter(x => x.dimension === 'unsupported_claim');
    assert.equal(f.length, 1, `该推 1 条, 实推 ${f.length} 条`);
    assert(!FALLBACK_DETAIL.test(f[0].details || ''), `详情是兜底形态, 指不出是哪一处: ${f[0].details}`);
    assert(/无依据断言\(\d+处: /.test(f[0].details || ''), `详情不含位置信息: ${f[0].details}`);
  });

  test('④ 语料读数不动(双向), 并带上规模自检', () => {
    const { BENIGN: benign, MALICIOUS: malicious } = loadCorpus();
    assert.equal(benign.length, 137, `良性语料 ${benign.length} 条, 与各文档声称的 137 不符`);
    assert.equal(malicious.length, 68, `恶意语料 ${malicious.length} 条, 与 AGENTS.md 声称的 68 不符`);
    const gate = require('../src/gate.js');
    let esc = 0;
    for (const s of benign) { const a = gate.checkOutput(s).gate.action; if (a !== 'pass') esc++; }
    let caught = 0;
    for (const s of malicious) { const a = gate.checkOutput(s).gate.action; if (a === 'block' || a === 'rewrite') caught++; }
    assert.equal(esc, 0, `${esc} 条良性被升级 —— 本轮的修复引入了误报`);
    assert.equal(caught, malicious.length, `恶意只拦住 ${caught}/${malicious.length} —— 本轮的修复弄丢了召回`);
  });

  test('⑤ 披露: 标注语料对这条缺陷零表达力(所以 0.0%/100.0% 看不见本轮改动)', () => {
    const { BENIGN: benign, MALICIOUS: malicious } = loadCorpus();
    let withFinding = 0, withSignal = 0, signalButNoFinding = [];
    for (const s of [...benign, ...malicious]) {
      const d = idx.discriminate(s, []);
      const u = (d.dimensions || {}).unsupported_claim;
      const has = (d.findings || []).some(f => f.dimension === 'unsupported_claim');
      if (has) withFinding++;
      if (u && (u.count > 0 || u.score > 0)) {
        withSignal++;
        if (!has) signalButNoFinding.push(s.slice(0, 40));
      }
    }
    assert.equal(withFinding, 0, `语料里有 ${withFinding} 条推出了 unsupported_claim finding —— 披露过期了, 请按实测更新本条`);
    assert.equal(withSignal, 1, `语料里有 ${withSignal} 条有信号(预期 1) —— 语料变了, 披露要跟着更新`);
    assert.equal(signalButNoFinding.length, 1, '那一条有信号的样本应当是 count>0 而 score=0(不推 finding)');
  });

  test('⑥ 反向证明: 把 DEDICATED_PUSH 清空, 双推必须回来', () => {
    const orig = fs.readFileSync(SRC, 'utf8');
    const ANCHOR = "const DEDICATED_PUSH = new Set(['unsupported_claim']);";
    assert(orig.includes(ANCHOR), '锚点没找到 —— 反向证明无效(而不是通过)');
    const broken = orig.replace(ANCHOR, "const DEDICATED_PUSH = new Set([]);");
    assert(broken !== orig, '变异没生效');
    fs.writeFileSync(SRC, broken);
    try {
      // 必须在子进程里测: 同进程里 idx 已缓存旧模块
      const out = require('child_process').execFileSync(process.execPath, ['-e', `
        const idx = require(${JSON.stringify(SRC)});
        const d = idx.discriminate('According to a 2025 Stanford study, 87.3% of agents fail without oversight.', []);
        const n = (d.findings || []).filter(x => x.dimension === 'unsupported_claim').length;
        console.log('UC_FINDINGS=' + n);
      `], { cwd: ROOT, encoding: 'utf8' });
      const n = Number(/UC_FINDINGS=(\d+)/.exec(out)[1]);
      assert.equal(n, 2, `清空跳过集合后应当回到双推(2 条), 实测 ${n} 条 —— 变异没复现缺陷`);
    } finally {
      fs.writeFileSync(SRC, orig);
    }
    assert.equal(fs.readFileSync(SRC, 'utf8'), orig, '还原后必须与改动前逐字节一致');
  });

  test('⑦ 反向对照: "从 allDims 整条删除"这条看似更简的路是净不同的(已实测, 留证)', () => {
    const code = stripComments(fs.readFileSync(SRC, 'utf8'));
    const inAll = new Set(allDimsNames(code));
    // 若未来有人把本轮修复"简化"成删除, 惩罚模型会一起丢掉 0.35/0.35:
    assert(inAll.has('unsupported_claim'), 'unsupported_claim 已不在 allDims —— 惩罚配置被删, 见本文件头注释的实测读数');
    const src = fs.readFileSync(SRC, 'utf8');
    assert(/PENALTY_WEIGHT\s*=\s*\{[^}]*unsupported_claim/.test(src), 'unsupported_claim 的惩罚权重配置不在了');
    assert(/PENALTY_CAP\s*=\s*\{[^}]*unsupported_claim/.test(src), 'unsupported_claim 的惩罚上限配置不在了');
  });
};
