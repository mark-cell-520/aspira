/**
 * test/think-pipeline-formula-bridge-wiring.test.js —
 * 一段 90 行的公式计算, 因为一个从未导入的名字, 一次都没有执行过
 *
 * [test-coverage-gap·第一百七十一轮] 新建。
 *
 * B 类之王 src/core/think-pipeline.js(1028 行, 只导出 runThinkPipeline 一个
 * 函数, 零测试)。按 cycle 28/148/156/159/167/170 的纪律 probing by calling
 * 全景调用。
 *
 * ═══ 缺陷: getFormulaBridge 从未被定义 ═══
 * 公式计算段(约 90 行, 8 个主题分支, 20+ 个公式)的第一行是:
 *
 *     const bridge = getFormulaBridge();
 *
 * 而**整个 1028 行的文件里这个名字只出现一次, 就在调用处** —— 没有定义,
 * 没有 require, 没有 import。调用被包在 try 里, 于是每次 think() 都抛一次
 * ReferenceError 并被 catch 吞掉。
 *
 * 实测(修复前): 输入"认知失调与情绪动机" →
 *   result._formulaCalculations = undefined
 *   result._formulaEvidence    = undefined
 *   conclusion 不带 [公式验证]
 *   warnings = []
 * 调用成功、不抛错、返回结构完全合法 —— 内容已死。
 *
 * 这正是本仓库反复记录的形状, 且是它最纯粹的一次: 不是判错了, 是**这段代码
 * 从未运行过**, 而它外表与运行成功完全一致。
 *
 * 同一形状在 src/cortex/sustained-drift-detector.js:312 同样存在(那里也没有
 * import, 注释写着 formula unavailable —— 一个把"我的代码没接线"记录成
 * "公式不可用"的 catch)。本轮不越界, 只修 think-pipeline.js。
 *
 * ═══ 修法 ═══
 * 函数内懒加载(与本文件既有的 _FirewallCheck 惯例一致):
 *
 *     let _formulaBridge = null;
 *     const _getFormulaBridge = () => {
 *       if (_formulaBridge === null) {
 *         try { _formulaBridge = require('../formula/formula-bridge.js').getFormulaBridge(); }
 *         catch (_) { _formulaBridge = false; }
 *       }
 *       return _formulaBridge || null;
 *     };
 *
 * formula-bridge 零顶层依赖, 首次 require 实测 1ms, 二次走 require 缓存。
 * 失败时记住 false 而非反复重试。
 *
 * ═══ 实测(修复后) ═══
 *   认知类输入 → _formulaCalculations 6 键, _formulaEvidence {count:4,...},
 *               conclusion 追加 [公式验证]
 *   八个主题分支(熵/决策/记忆/物理/意识/考试/社会)各自的关键键全部出现
 *   fail-open 未被破坏: 非字符串 input / result=null 均不抛
 *
 * ═══ 锁什么 ═══
 * ① 行为: 认知类输入必须真的算出公式值(修复前是 undefined, 本条红);
 * ② 行为: 八个主题分支的关键键必须全部出现(防只接对一个分支);
 * ③ 行为: fail-open 必须保持(修好了但不能把主链路拖下水);
 * ④ 源级: 不得再出现未定义的 getFormulaBridge() 调用 + 必须有懒加载器
 *    (含自证: 谓词分得清"有懒加载"与"裸调用")。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const { runThinkPipeline } = require(path.join(ROOT, 'src', 'core', 'think-pipeline.js'));

  // ── 一、公式计算必须真的跑起来 ──────────────────────────
  test('认知类输入必须真的算出公式值(修复前整段静默死亡)', () => {
    const r = { confidence: 0.9, output: { conclusion: '认知失调与情绪动机的心理机制分析' } };
    return runThinkPipeline(r, '认知失调与情绪动机', {}).then(() => {
      const calc = r._formulaCalculations || {};
      assertTrue(Object.keys(calc).length >= 5,
        `认知类输入应算出 >=5 个公式值, 实测 ${Object.keys(calc).length} 个 —— ` +
        '0 个说明 getFormulaBridge 又没接上(整段被 try 吞掉)');
      assertEqual(typeof calc.cognitiveDissonance, 'number',
        'cognitiveDissonance 应是数字, 实测 ' + JSON.stringify(calc.cognitiveDissonance));
      assertEqual(typeof calc.flowChannel, 'number',
        'flowChannel 应是数字, 实测 ' + JSON.stringify(calc.flowChannel));
      assertEqual(r._formulaEvidence && r._formulaEvidence.strength, 'quantitative',
        '3+ 个数值公式结果应挂 _formulaEvidence, 实测 ' + JSON.stringify(r._formulaEvidence));
      assertTrue(r.output.conclusion.includes('[公式验证]'),
        '有定量支撑时 conclusion 应追加 [公式验证], 实测: ' + r.output.conclusion);
    });
  });

  // ── 二、八个主题分支都必须通 ────────────────────────────
  test('八个主题分支的关键公式键必须全部出现(防只接对一个分支)', () => {
    const branches = [
      ['熵/信息', '香农熵与KL散度的信息论分析', ['shannonEntropy', 'klDivergence', 'crossEntropy']],
      ['决策/效用', '风险与收益的决策博弈分析', ['prospectValue', 'subjectiveUtility', 'regretTheory', 'minimax', 'shapleyValue']],
      ['记忆/学习', '记忆遗忘与学习保持率', ['ebbinghaus1h', 'memoryStrength', 'actrBaseLevel']],
      ['物理', '量子力学与能量分析', ['precisionWeight', 'predictiveCodingFreeEnergy']],
      ['意识/注意', '意识与注意力的机制', ['iitPhi', 'gwtAccessibility', 'gwtWinner']],
      ['考试/测验', '教育测验与IRT信度效度', ['irtRasch', 'cronbachAlpha', 'semFitRMSEA']],
      ['社会/群体', '社会群体从众与旁观效应', ['bystanderEffect', 'homophily', 'softmaxPolicy']],
    ];
    const bad = [];
    for (const [name, input, keys] of branches) {
      const r = { confidence: 0.9, output: { conclusion: 'x' } };
      return runThinkPipeline(r, input, {}).then(() => {
        const calc = r._formulaCalculations || {};
        for (const k of keys) {
          if (calc[k] === undefined) bad.push(`${name} 缺 ${k}`);
        }
      });
    }
    return Promise.resolve().then(() => {
      assertEqual(bad.join('\n'), '', '以下主题分支的公式键缺失(该分支又静默死亡):\n' + bad.join('\n'));
    });
  });

  // ── 三、fail-open 必须保持 ──────────────────────────────
  test('修好公式段后 fail-open 不得被破坏(非字符串 input / result=null 均不抛)', () => {
    const bad = [];
    // 非字符串 input: 公式段入口要求 string, 应安静跳过而非抛
    const r1 = { confidence: 0.9, output: { conclusion: 'x' } };
    try { runThinkPipeline(r1, 42, {}); } catch (e) { bad.push('input=42 抛错: ' + e.message); }
    assertEqual(r1._formulaCalculations, undefined,
      '非字符串 input 不应触发公式计算(入口判据是有意的)');
    // result = null: 函数应原样返回 null
    let back;
    try { back = runThinkPipeline(null, '认知失调', {}); } catch (e) { bad.push('result=null 抛错: ' + e.message); }
    return Promise.resolve(back).then((b) => {
      assertEqual(b, null, 'result=null 应原样返回 null');
      // engine = null / undefined: 后置钩子全靠 engine.xxx, 必须全部静默
      const r2 = { confidence: 0.9, output: { conclusion: '认知失调情绪' } };
      try { runThinkPipeline(r2, '认知失调', null); } catch (e) { bad.push('engine=null 抛错: ' + e.message); }
      assertEqual(bad.join('\n'), '', 'fail-open 被破坏:\n' + bad.join('\n'));
    });
  });

  // ── 四、源级: 不得再有未定义的 getFormulaBridge 调用 ─────
  test('源级: 不得出现未定义的 getFormulaBridge() 调用, 必须有懒加载器', () => {
    const fs = require('fs');
    const raw = fs.readFileSync(path.join(ROOT, 'src', 'core', 'think-pipeline.js'), 'utf8');
    // [第一百七十一轮] 必须先剥行注释再匹配。本轮首版没剥, 结果把我自己写在
    // 注释里的"这段代码调用了 getFormulaBridge()"判成裸调用 —— 锁读自己的
    // 文档为罪, cycle 14/15/25/27 记录过四次, 这是第五次。长度保留式剥离,
    // 行号不错位。
    const src = raw.split('\n')
      .map(l => l.replace(/\/\/.*$/, m => ' '.repeat(m.length)))
      .join('\n');
    // 裸调用(既非 _getFormulaBridge 懒加载器, 也非 .getFormulaBridge 属性访问)
    // 即为缺陷形态。第二半必要: require('...').getFormulaBridge() 是**正确**写法,
    // 首版只排除了 _ 前缀, 于是把修复本身判成缺陷 —— 一个把修好坏锁的谓词。
    const BARE = /(?<![_.)])\bgetFormulaBridge\s*\(\s*\)/;
    assertTrue(!BARE.test(src),
      '不得再出现裸 getFormulaBridge() 调用 —— 本文件从未定义该名字, ' +
      '调用被 try 吞掉后整段公式计算静默死亡');
    assertTrue(/_getFormulaBridge\s*=\s*\(\)\s*=>/.test(src),
      '必须有 _getFormulaBridge 懒加载器');
    assertTrue(/require\(['"]\.\.\/formula\/formula-bridge\.js['"]\)/.test(src),
      '懒加载器必须 require ../formula/formula-bridge.js');
    assertTrue(/_formulaBridge\s*=\s*false/.test(src),
      '不可用时应记住 false, 不反复重试');
    // 自证: 谓词必须分得清三种形态
    assertTrue(BARE.test('      const bridge = getFormulaBridge();') === true,
      '自证失效: 谓词分不清裸调用与懒加载调用, 本条是恒真锁');
    assertTrue(BARE.test('      const bridge = _getFormulaBridge();') === false,
      '自证失效: 谓词把懒加载调用误判成裸调用');
    assertTrue(BARE.test("      _f = require('x').getFormulaBridge();") === false,
      '自证失效: 谓词把正确的属性访问形式误判成裸调用');
  });
};
