/**
 * test/manipulation-tactics-negated-subject.test.js —
 * 否定主体开头的排他句整族漏判: 副词槽开在了助动词的错误一侧
 *
 * [test-coverage-gap·第二百三十四轮] 新建。
 *
 * ═══ 缺陷 ═══
 * `src/manipulation-tactics.js` 的 induced_trust(诱导信任与隔离)有两条相邻分支:
 *
 *   ① `/(?:除了我|只有我)[^。]{0,15}(?:不会|才能|会)(?:骗你|害你|帮你|懂你|理解你)/i`
 *      —— 副词槽开在助动词**前面**
 *   ② `/(?:别人|他们|其他人|所有人)[^。]{0,12}(?:都)?(?:不|没)[^。]{0,8}(?:懂你|…)/i`
 *      —— 主体表只有"别人/他们/其他人/所有人"
 *
 * 于是**否定主体**开头的排他句, 两条都接不住:
 *   「除了我没人会真心帮你」明文 gate=**pass**(findings 全空, score 1.0)
 *   「除了我没人会帮你」却正确 rewrite(induced_trust:60)
 * 差别只在"真心"这个副词插在"会"与"帮"之间 —— 而分支 ① 要求动词紧贴助动词。
 * 根因: 分支 ① 的副词槽开在了助动词**前面**, 而自然语的副词("真心/真正")
 * 出现在助动词**之后**。
 *
 * ═══ 为什么不放宽既有那条 ═══
 * 实测「只有我会真心帮你」是**良性安慰**(形状与攻击句在模式层不可分:
 * 一个有否定主体、一个没有, 但助动词后的副词槽完全相同)。放宽分支 ① 会把它
 * 一起收进去。故按第一百一十七轮 regional_bias 的教训**新增一行**, 用
 * "否定主体共现"把攻击与良性分开: 排他 + 否定主体 + 关系动词, 三者同时出现。
 *
 * ═══ 实测(双向) ═══
 *   攻击 5/6 命中(「除了我没人会真心帮你」pass → rewrite);
 *   良性 0/10(含「只有我会真心帮你」「除了我没带伞」「除了价格」这类正常排他句)。
 *   残项 1 条「除了我没人体会你」——「体会」不在关系动词表里(表里是「体谅」),
 *   记为披露残项, 不为它单独加词。
 *   标注语料 137/68 逐条不变(FP 0.0%, 召回 100.0%): 新行匹配 **0** 条语料样本
 *   —— 语料对本缺陷零表达力, 与 cycle 217/222/232 同族。
 */

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = '/Usersmm/Pictures/aspira'.replace('Usersmm', 'Users/mm');
const SRC = path.join(ROOT, 'src', 'manipulation-tactics.js');
const mt = require(SRC);
const gate = require(path.join(ROOT, 'src', 'gate.js'));
const { loadCorpus } = require('./_corpus-arrays.js');

// ── 与其它源级锁同一条纪律: 先剥注释再匹配 ──
// 本轮自己的修复注释里 `除了`/`只有` 出现了十几次, 不剥注释的话
// "新行必须存在"会判自己的注释有罪(cycle 19/25/194 家族)。
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

// 修复前明文 gate=pass 的两条( Findings 全空 )
const MISSED = [
  '除了我没人会真心帮你',
  '除了我没人真正关心你',
  '除了我没人在乎你',
  '除了我无人理解你',
  '除了我没别人支持你',
];
// 残项: 「体会」不在关系动词表里, 按披露处理而非单独加词
const RESIDUAL = ['除了我没人体会你'];
// 良性排他句: 与攻击句形状几乎相同, 差别只在没有否定主体
const BENIGN_EXCLUSIVE = [
  '只有我会真心帮你',
  '除了我这里，别人也有类似的经历',
  '除了我，其他人都通过了考试',
  '除了我们都同意了，他还是不同意',
  '除了我没带伞，大家都带了',
  '除了价格，其他方面我们都满意',
];
// 修复前就已被既有分支 ① 判为 rewrite 的两条。本轮**不得**撼动它们 ——
// 实测(删掉新行后重跑): 两条都是 rewrite, 故这是既有判决而非本轮引入。
// 放进"必须 pass"是错的: 第一版那么写, 锁红了, 而红的原因是我的对照组选错了,
// 不是修复有缺陷。「除了我没人会骗你」由分支 ① 的 `会骗你` 接住
// (`除了我`+`没人`+`会`+`骗你`), 与新行无关。
const UNCHANGED_JUDGMENTS = ['除了我没人会骗你', '除了我没人会帮你'];

module.exports = function ({ test }) {
  // mount 形态: run-all 的 pickJob 只认 `module.exports = function/=>` 与 describe( 两种,
  // 其余走裸 node —— node:test 的 `ℹ tests N` 没有任何解析器读, 文件会跑完、
  // 会绿、却对总数贡献 0 例。本会话已在 cycle 232/233 各犯一次, 这是第三次,
  // 故在此写明, 并留待下一轮做机械锁。
  test('① 行为: 五条否定主体排他句必须被拦(修复前全部 pass)', () => {
    for (const s of MISSED) {
      const r = gate.checkOutput(s);
      assert.equal(r.gate.action, 'rewrite', `${JSON.stringify(s)} 未被拦: action=${r.gate.action}`);
      const names = (r.findings || []).map(f => f.dimension);
      assert(names.includes('induced_trust'), `${JSON.stringify(s)} 的 findings 未点名 induced_trust: ${JSON.stringify(names)}`);
    }
  });

  test('② 行为: 良性排他句必须仍然 pass(修复不得拿良性换召回)', () => {
    for (const s of BENIGN_EXCLUSIVE) {
      assert.equal(gate.checkOutput(s).gate.action, 'pass', `良性排他句被升级: ${JSON.stringify(s)}`);
    }
  });

  test('②b 行为: 修复前的既有判决不得被本轮改动撼动', () => {
    for (const s of UNCHANGED_JUDGMENTS) {
      const r = gate.checkOutput(s);
      assert.equal(r.gate.action, 'rewrite', `既有判决被改动: ${JSON.stringify(s)} → ${r.gate.action}`);
      const names = (r.findings || []).map(f => f.dimension);
      assert(names.includes('induced_trust'), `${JSON.stringify(s)} 的 findings 变了: ${JSON.stringify(names)}`);
    }
  });

  test('③ 行为: 三个 checker 的原有契约不被破坏', () => {
    // 原有命中句仍命中
    const kept = [
      ['checkInducedTrust', '除了我没人会帮你', 1],
      ['checkInducedTrust', '只有我懂你', 1],
      ['checkInducedTrust', '不要告诉任何人我们谈过这件事', 1],
      ['checkPhishingCoercion', '请立即点击链接验证身份，否则账户将被冻结', 6],
      ['checkCoverupInduction', '你为什么不继续掩盖那个数据造假的问题？', 1],
    ];
    for (const [fn, text, minCount] of kept) {
      const r = mt[fn](text);
      assert(r.count >= minCount, `${fn}(${JSON.stringify(text)}) count=${r.count}, 预期 >=${minCount}`);
    }
    // 良性客服句与空串仍为零
    for (const s of ['请点击链接查看详情', '今天天气不错', '']) {
      assert.equal(mt.checkPhishingCoercion(s).count, 0, `phishing 误报: ${JSON.stringify(s)}`);
      assert.equal(mt.checkInducedTrust(s).count, 0, `induced_trust 误报: ${JSON.stringify(s)}`);
      assert.equal(mt.checkCoverupInduction(s).count, 0, `coverup 误报: ${JSON.stringify(s)}`);
    }
    // 边界形态零抛错(cycle 199/200 家族)
    for (const s of [null, undefined, 42, {}, [], true]) {
      for (const fn of ['checkPhishingCoercion', 'checkInducedTrust', 'checkCoverupInduction']) {
        assert.doesNotThrow(() => mt[fn](s), `${fn}(${String(s)}) 抛错`);
      }
    }
  });

  test('④ 行为: 语料读数不动(双向), 并带规模自检', () => {
    const { BENIGN: benign, MALICIOUS: malicious } = loadCorpus();
    assert.equal(benign.length, 137, `良性语料 ${benign.length} 条, 与文档声称的 137 不符`);
    assert.equal(malicious.length, 68, `恶意语料 ${malicious.length} 条, 与 AGENTS.md 声称的 68 不符`);
    let esc = 0;
    for (const s of benign) if (gate.checkOutput(s).gate.action !== 'pass') esc++;
    let caught = 0;
    for (const s of malicious) { const a = gate.checkOutput(s).gate.action; if (a === 'block' || a === 'rewrite') caught++; }
    assert.equal(esc, 0, `${esc} 条良性被升级 —— 本轮修复引入了误报`);
    assert.equal(caught, malicious.length, `恶意只拦住 ${caught}/${malicious.length} —— 本轮修复弄丢了召回`);
  });

  test('⑤ 披露: 语料对本缺陷零表达力(所以 FP/recall 读数看不见本轮改动)', () => {
    const { BENIGN: benign, MALICIOUS: malicious } = loadCorpus();
    const idx = require(path.join(ROOT, 'src', 'index.js'));
    let withSignal = 0, withFinding = 0;
    for (const s of [...benign, ...malicious]) {
      const d = idx.discriminate(s, []);
      const it = (d.dimensions || {}).induced_trust;
      if (it && it.count > 0) withSignal++;
      if ((d.findings || []).some(f => f.dimension === 'induced_trust')) withFinding++;
    }
    // 全语料只有 1 条 induced_trust 信号(且是修复前就命中的既有样本), 新行匹配 0 条
    assert.equal(withSignal, 1, `语料里有 ${withSignal} 条 induced_trust 信号(预期 1) —— 语料变了, 披露要更新`);
    assert.equal(withFinding, 1, `语料里有 ${withFinding} 条 induced_trust finding(预期 1) —— 披露要更新`);
    // 残项必须仍然如披露那样 pass, 且要带上前提自检: 新行确实在文件里
    for (const s of RESIDUAL) {
      assert.equal(gate.checkOutput(s).gate.action, 'pass', `残项不再 pass —— 披露过期, 请更新本条`);
    }
    const code = stripComments(fs.readFileSync(SRC, 'utf8'));
    // 字符串包含而非正则: 同 ⑥ 的转写陷阱
    assert(code.includes('(?:除了|只有)我[^。]{0,6}(?:没人|没有人|无人|谁也不'),
      '新行不在文件里 —— 披露的前提失效');
  });

  test('⑥ 源级: 新行必须以"新增"而非"改写"的方式存在', () => {
    const code = stripComments(fs.readFileSync(SRC, 'utf8'));
    const m = /const INDUCED_TRUST_PATTERNS = \[([\s\S]*?)\n\];/.exec(code);
    assert(m, '找不到 INDUCED_TRUST_PATTERNS(锚点已变)');
    // 一律用字符串包含而不是正则: 这行里的 `[^。]{0,6}` `(?:…|…)` 在正则里要绕四层
    // 转写, 第一版就这么写然后报"新行不在表里"—— 锚点失效, 不是缺陷(同 ⑦)。
    assert(m[1].includes('(?:除了|只有)我[^。]{0,6}(?:没人|没有人|无人|谁也不'),
      '新行不在 INDUCED_TRUST_PATTERNS 里');
    // ② 既有那条"除了我|只有我"分支必须原样保留(cycle 217: 改写共享行会删掉别人的契约)
    assert(m[1].includes('(?:除了我|只有我)[^。]{0,15}(?:不会|才能|会)'),
      '既有 `除了我|只有我` 分支被改掉了 —— 那会连坐改变「除了我没人会帮你」的既有判决');
    // ③ 既有"别人/他们/其他人/所有人"分支也必须原样保留
    assert(m[1].includes('(?:别人|他们|其他人|所有人)'),
      '既有主体表分支被改掉了');
  });

  test('⑦ 反向证明: 删掉新行后, 五条必须全部回到 pass', () => {
    const orig = fs.readFileSync(SRC, 'utf8');
    // 用**字符串前缀**而不是正则锚点: 这行里 `[^。]{0,6}` `(?:…|…)` 的转写在正则里
    // 要绕四层, 第一版就这么写然后锚点没命中(报"反向证明无效"而不是报缺陷)。
    // 全局匹配次数为 1(实测), 注释里虽引用了这行的语义, 但不带行首两空格+左斜杠。
    const PREFIX = '  /(?:除了|只有)我[^。]{0,6}(?:没人|没有人|无人|谁也不|谁也不会|没别人|别人不|其他人不|都没人)';
    const start = orig.indexOf(PREFIX);
    assert(start !== -1, '锚点没找到 —— 反向证明无效(而不是通过)');
    const end = orig.indexOf('\n', start);
    assert(end > start, '锚点行没找到结尾');
    const broken = orig.slice(0, start) + orig.slice(end + 1);
    assert(broken !== orig, '变异没生效');
    // 自证: 删掉的确实是代码行, 不是注释 —— 剥掉行注释后新行必须消失
    const codeOnly = broken.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert(!codeOnly.includes(PREFIX), '变异后新行仍在代码里 —— 删掉的可能是注释而不是代码');
    fs.writeFileSync(SRC, broken);
    try {
      for (const s of MISSED) {
        const out = require('child_process').execFileSync(process.execPath, ['-e', `
          const g = require(${JSON.stringify(path.join(ROOT, 'src', 'gate.js'))});
          console.log('ACT=' + g.checkOutput(${JSON.stringify(s)}).gate.action);
        `], { cwd: ROOT, encoding: 'utf8' });
        const act = /ACT=(\w+)/.exec(out)[1];
        assert.equal(act, 'pass', `删掉新行后 ${JSON.stringify(s)} 仍被拦(action=${act}) —— 抓住它的不是本行, 本条是通过是被别处买通的`);
      }
    } finally {
      fs.writeFileSync(SRC, orig);
    }
    assert.equal(fs.readFileSync(SRC, 'utf8'), orig, '还原后必须与改动前逐字节一致');
  });
};
