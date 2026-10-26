'use strict';
/**
 * ContinuousLearner 接线回归测试
 *
 * 钉住的缺陷: heartflow.js 里 `_ContinuousLearner` 这个标识符在整个仓库从未被
 * 定义过（没有 _lazy 注册、没有 require），而 start() 里
 * `new (_ContinuousLearner().ContinuousLearner)()` 照样写在那里。于是一执行就抛
 * ReferenceError，被同一行的 catch 吞掉，this.continuousLearner 从写下起就是那个
 * 三方法桩 { learn, healthCheck, getStats }。
 *
 * 后果是四个消费点全部静默失效，且都不进任何报错路径：
 *   · think-pipeline.js:63/105 每次 think 都调 reflect()，桩没这方法 → TypeError
 *     → 被 catch 吞，日志零痕迹
 *   · think-pipeline.js:113/274 读 clStats.thinkCount 才触发的两个反馈回路
 *     （提升探索优先级 / 给 decisionRouter 降权）从写下起不可达
 *   · self-diagnosis.js:86-91 的 thinkCount / lowConfidenceRate / autoLessons /
 *     totalReflections 恒 0 或 null
 *   · heartflow.js 里 LearningOrchestrator.status() 的 detect 恒 0
 *
 * 修前（实测）: hf.continuousLearner.constructor.name === 'Object'，
 *              Object.keys() === ['learn','healthCheck','getStats']，
 *              连跑 3 次 think() 后 getStats() 仍返回 {}。
 * 修后: constructor.name === 'ContinuousLearner'，reflect() 真记账，
 *       getStats() 的读数随 think 次数变化。
 *
 * 附带钉住第二件事：_readSignals 里每条信号都必须在 reflect() 的调用点
 * （think-pipeline.js:63）当时已经落定的字段上取值。第一版加了
 * _verification.issues / _missionCheck.aligned 两个信号，但那两点拿到的是
 * engine-reasoner 的中间结果（实测 13 个键），这两个字段还没写上去，
 * 信号从写下起一次都不触发而测试全绿。见下面那条"每条信号都能触发"用例。
 */
function run({ test, assertEqual, assertTrue, assertFalse }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  function makeEngine() {
    const { Aspira } = require('../src/core/heartflow.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-continuous-learner-'));
    const engine = new Aspira({ dataDir: path.join(root, 'data'), silent: true });
    engine.start();
    return engine;
  }

  // 复刻 reflect() 真实调用点（think-pipeline.js:63）当时拿到的结果形状：
  // engine-reasoner 的中间结果，实测 13 个键。_verification / gateVerdict /
  // _missionCheck 在那之后才补上，放进这个 fixture 就等于测一条不会走的路。
  function thinkResultAtReflectPoint(conf) {
    return {
      calibration: {
        originalConfidence: conf,
        calibratedConfidence: conf,
        needsUncertaintyMarker: true,
        uncertaintyPhrase: '以下为初步分析（证据尚不充分）：',
      },
      output: { meta: { confidence: conf } },
      decision: { confidence: conf, suppressed: false, conclusion: '...' },
      metaCalibration: { level: 'low', gaps: [{ what: '整体结论' }] },
      _daoInputCheck: { verdict: 'PASS', daoScore: 1 },
    };
  }

  // 同一形状但全部达标：置信度高、无缺口、道法自然 PASS、未抑制
  function healthyResult() {
    return {
      calibration: { calibratedConfidence: 0.82, needsUncertaintyMarker: false },
      output: { meta: { confidence: 0.82 } },
      decision: { confidence: 0.82, suppressed: false },
      metaCalibration: { level: 'high', gaps: [] },
      _daoInputCheck: { verdict: 'PASS', daoScore: 1 },
    };
  }

  test('continuousLearner 是真 ContinuousLearner, 不是三方法降级桩', () => {
    const engine = makeEngine();
    const cl = engine.continuousLearner;
    assertEqual(cl && cl.constructor && cl.constructor.name, 'ContinuousLearner',
      '修前这里是普通对象字面量(构造器名 Object)，reflect/_cumulativeSummary 都不存在');
    assertEqual(typeof cl.reflect, 'function', '桩没有 reflect()，think-pipeline 的调用每次都 TypeError');
    assertEqual(typeof cl._cumulativeSummary, 'function', 'think-pipeline 的假设驱动链路读这个方法');
    assertEqual(typeof cl.getStats, 'function');
    engine.shutdown();
  });

  test('reflect() 真记账: thinkCount / 低置信命中 / 反思数随调用增长', () => {
    const engine = makeEngine();
    const cl = engine.continuousLearner;

    const before = cl.getStats();
    assertEqual(before.thinkCount, 0, '初始应为 0');
    assertEqual(before.lowConfidenceRate, 0);

    for (let i = 0; i < 4; i++) cl.reflect(thinkResultAtReflectPoint(0.4), `低置信输入 ${i}`, null);
    const after = cl.getStats();
    assertEqual(after.thinkCount, 4, '修前恒为 undefined（桩返回 {}）');
    assertEqual(after.lowConfidenceHits, 4, '4 次都是 0.4 < 0.5 阈值，应全部计入低置信');
    assertEqual(after.totalReflections, 4);
    assertEqual(after.lowConfidenceRate, 1, 'lowConfidenceRate 应可算出来，修前恒 0');
    assertTrue(after.recentReflections.length === 4, 'recentReflections 应有内容');
    assertFalse(after.thinkCount === before.thinkCount, '读数必须随调用变化，不能恒定');
    engine.shutdown();
  });

  test('置信度达标不计入低置信命中', () => {
    const engine = makeEngine();
    const cl = engine.continuousLearner;
    cl.reflect(thinkResultAtReflectPoint(0.4), 'a', null);
    cl.reflect(healthyResult(), 'b', null);
    const s = cl.getStats();
    assertEqual(s.thinkCount, 2);
    assertEqual(s.lowConfidenceHits, 1, '0.82 不应计入低置信');
    assertEqual(s.lowConfidenceRate, 0.5);
    engine.shutdown();
  });

  test('每条信号都能在真实 think() 结果上触发（防"写下起就不触发的信号"）', () => {
    // 这条用例钉的是我自己第一版犯的错：给 _readSignals 加了
    // _verification.issues 和 _missionCheck.aligned 两个信号，但 reflect() 的调用点
    // （think-pipeline.js:63）当时拿到的是 engine-reasoner 的中间结果，这两个字段
    // 还没写上去 —— 信号从写下起一次都不会触发，而测试全绿。所以这里直接用真
    // think() 的结果喂 reflect()，要求信号集合非空。
    const engine = makeEngine();
    const cl = engine.continuousLearner;
    const r = cl.reflect(thinkResultAtReflectPoint(0.4), '真实输入', null);
    assertTrue(r.reflected);
    assertTrue(Array.isArray(r.signals) && r.signals.length > 0,
      'reflect() 返回的 signals 不应为空 —— 空意味着所有信号分支都不可达');
    assertTrue(r.signals.includes('low_confidence'),
      '低置信结果必须产出 low_confidence，实际: ' + JSON.stringify(r.signals));

    // 全部达标的结果应一个信号都不产
    const r2 = cl.reflect(healthyResult(), '健康输入', null);
    assertEqual(r2.signals.length, 0, '健康结果不应产信号，实际: ' + JSON.stringify(r2.signals));

    // 道法自然不 PASS / 响应被抑制 也要能触发
    const penalized = thinkResultAtReflectPoint(0.82);
    penalized._daoInputCheck = { verdict: 'PENALTY', daoScore: 0.4 };
    const r3 = cl.reflect(penalized, '道法被罚', null);
    assertTrue(r3.signals.includes('dao_input_penalty'),
      'dao_input_penalty 应可触发，实际: ' + JSON.stringify(r3.signals));

    const suppressed = healthyResult();
    suppressed.decision = { confidence: 0.82, suppressed: true };
    const r4 = cl.reflect(suppressed, '被抑制', null);
    assertTrue(r4.signals.includes('response_suppressed'),
      'response_suppressed 应可触发，实际: ' + JSON.stringify(r4.signals));
    engine.shutdown();
  });

  test('信号复发到阈值才提炼教训, _cumulativeSummary 给出复发模式', () => {
    const engine = makeEngine();
    const cl = engine.continuousLearner;

    const empty = cl._cumulativeSummary();
    assertEqual(empty.recurringPatterns.length, 0, '还没有反思时不应有复发模式');
    assertEqual(empty.thinkCount, 0);

    for (let i = 0; i < 3; i++) cl.reflect(thinkResultAtReflectPoint(0.4), `输入 ${i}`, null);
    const summary = cl._cumulativeSummary();
    assertEqual(summary.thinkCount, 3);
    assertTrue(summary.recurringPatterns.length > 0,
      '同一信号出现 3 次（等于 patternRecurrenceForLesson）后必须有复发模式，修前这里恒空');
    assertTrue(summary.recurringPatterns.some(p => p.startsWith('low_confidence(')),
      '复发模式里应含 low_confidence，实际: ' + JSON.stringify(summary.recurringPatterns));
    assertEqual(cl.getStats().autoLessons, summary.recurringPatterns.length,
      'autoLessons 应等于提炼出的教训条数');
    engine.shutdown();
  });

  test('getStats() 覆盖 self-diagnosis 读的全部字段', () => {
    const engine = makeEngine();
    const cl = engine.continuousLearner;
    cl.reflect(thinkResultAtReflectPoint(0.4), 'x', null);
    const s = cl.getStats();
    // test/self-diagnosis.test.js 里 mock 的契约就是这个键集合
    for (const key of ['thinkCount', 'lowConfidenceHits', 'autoLessons', 'totalReflections', 'recentReflections', 'config']) {
      assertTrue(key in s, 'getStats() 缺字段 ' + key + ' —— self-diagnosis 会读到 undefined');
    }
    engine.shutdown();
  });

  test('空结果 / 坏结果不抛异常，返回 reflected:false', () => {
    const engine = makeEngine();
    const cl = engine.continuousLearner;
    const r1 = cl.reflect(null, 'x', null);
    assertFalse(r1.reflected, 'null 结果应被拒绝');
    const r2 = cl.reflect(undefined, 'x', null);
    assertFalse(r2.reflected);
    const r3 = cl.reflect('not an object', 'x', null);
    assertFalse(r3.reflected);
    assertEqual(cl.getStats().thinkCount, 0, '被拒绝的调用不应记账');
    engine.shutdown();
  });

  test('lessonBank 只读: reflect 不写教训库，缺失 getRelevant 也不抛', () => {
    const engine = makeEngine();
    const cl = engine.continuousLearner;
    let writes = 0;
    const fakeBank = {
      getRelevant: () => { reads++; return [{ id: 'l1' }]; },
      add: () => { writes++; return { id: 'new' }; },
    };
    let reads = 0;
    for (let i = 0; i < 5; i++) cl.reflect(thinkResultAtReflectPoint(0.4), 'input ' + i, fakeBank);
    assertTrue(reads > 0, '应通过 getRelevant 查既有教训');
    assertEqual(writes, 0, 'reflect 不得写入教训库（避免每次 think 都落盘 data/）');

    // 没有 getRelevant 的 lessonBank 也不能让 reflect 抛异常
    const r = cl.reflect(thinkResultAtReflectPoint(0.4), 'x', { add: () => ({}) });
    assertTrue(r.reflected);
    engine.shutdown();
  });
}

module.exports = run;
