/**
 * core-smoke.test.js — 引擎 启动 → 推理 → 派发 → 关停 全链路冒烟
 *
 * ═══ 这个文件原来是什么 ═══
 * 原名 core-smoke-test.js，写在 v5.17.23，"覆盖 5 个最常改动的关键路径"。
 * 它测的是一套**已经不存在的 API**：
 *
 *     assert(typeof hf.stop === 'function')      ← 引擎只有 shutdown()，没有 stop()
 *     assert(r1.decision.type)                   ← decision 对象里从来没有 type 字段
 *     assert(hf._feedbackState.complexityBias)   ← _feedbackState 不是这个形状
 *
 * 而它叫 test-*.js 不是 *.test.js，run-all.js 的发现规则是
 * `endsWith('.test.js')` —— **它从来没进过门禁**。两条失效叠在一起：
 * 测试本身是死的，门禁也看不见它死。
 *
 * 更贵的一处：src/core/heartflow.js 有一条注释写着
 * 「已确认 core-smoke-test 覆盖启动链路(回归护栏存在)」——
 * 一条源码注释拿一个从未运行过的文件当证据，而真正在门禁里覆盖启动链路的
 * 是 test/core/heartflow.test.js（3 例：模块可加载 / 导出构造器 / 实例可启动并自报版本）。
 *
 * ═══ 现在锁什么 ═══
 * 用实测形状重写（探针取到的真实字段，不是猜的）：
 *   ① 启动链路: start() 后 version / started / sessionId / _modules 四个都在；
 *   ② think() 主路径: 返回体带 output.conclusion、decision.confidence、gateVerdict.action；
 *   ③ dispatch 路由: emotion.process 与 decision.decide 两条路由真的返回数据；
 *   ④ 关停: shutdown() 后 started 变 false。
 * 四件事串起来就是"引擎能起来、能想、能派发、能停下"——改名后它真的在门禁里跑了。
 *
 * 所有断言都用「字段存在且类型正确」这种稳的形状，不断言具体结论文本：
 * 结论内容随引擎演化，那是其他测试的事，冒烟测试只关心链路通不通。
 */
'use strict';

const assert = require('assert');
const { Aspira } = require('../src/core/heartflow.js');

module.exports = function ({ test }) {
  // dataDir 指到仓库 data/：与 test/heartflow-blindspot.test.js 同一惯用法。
  // 本文件只读引擎状态，不写任何文件；引擎自身的内存持久化由 shutdown() 收尾。
  const mk = () => new Aspira({ dataDir: process.cwd() + '/data', silent: true });

  // 每个用例自建自销，不共享实例。
  // 为什么不能共享：harness 的 test() 对 async 用例是**立即执行、把 promise 存进
  // pending**，四个用例的身体是并发跑的。共用一个实例时，④ 的 shutdown() 会在
  // ① 还在等启动的时候就已把 started 置 false —— 实测就是这么红的
  // （「started 应为 true / false !== true」，而三个后置用例全绿）。
  // heartflow-blindspot.test.js 同样是每例一实例，这是本仓的既定形状。
  const settle = () => new Promise(r => setTimeout(r, 3500));

  test('① 启动链路: start() 后 version / started / sessionId / _modules 四个都在', async () => {
    const e = mk();
    e.start();
    await settle();
    assert.ok(e.version, 'version 应可读');
    assert.strictEqual(e.started, true, 'started 应为 true');
    assert.ok(typeof e.sessionId === 'string' && e.sessionId.length > 0,
      `sessionId 应为非空串，实得 ${JSON.stringify(e.sessionId)}`);
    assert.ok(e._modules && typeof e._modules === 'object', '_modules 应为对象');
    const n = Object.keys(e._modules).length;
    assert.ok(n >= 40, `注册模块数应 >= 40，实得 ${n}`);
    e.shutdown();
  });

  test('② think() 主路径: 返回体带 output.conclusion / decision.confidence / gateVerdict.action', async () => {
    const e = mk();
    e.start();
    await settle();
    const r = await e.think('1+1等于几');
    assert.ok(r && typeof r === 'object', 'think() 应返回对象');

    assert.ok(r.output && typeof r.output === 'object', 'output 应为对象');
    assert.ok(typeof r.output.conclusion === 'string' && r.output.conclusion.length > 0,
      `output.conclusion 应为非空串，实得 ${JSON.stringify(r.output.conclusion)}`);

    assert.ok(r.decision && typeof r.decision === 'object', 'decision 应为对象');
    assert.strictEqual(typeof r.decision.confidence, 'number',
      `decision.confidence 应为 number，实得 ${typeof r.decision.confidence}`);
    assert.ok(Array.isArray(r.decision.reasoningChain), 'decision.reasoningChain 应为数组');

    assert.ok(r.gateVerdict && typeof r.gateVerdict === 'object', 'gateVerdict 应为对象');
    assert.strictEqual(typeof r.gateVerdict.action, 'string',
      `gateVerdict.action 应为 string，实得 ${typeof r.gateVerdict.action}`);
    e.shutdown();
  });

  test('③ dispatch 路由: emotion.process 与 decision.decide 都真的返回数据', async () => {
    const e = mk();
    e.start();
    await settle();

    const emo = e.dispatch('emotion.process', '我感到很开心');
    assert.ok(emo && typeof emo === 'object', 'emotion.process 应返回对象');
    assert.ok(emo.pad && typeof emo.pad === 'object', 'emotion.process 应带 pad');
    assert.strictEqual(typeof emo.pad.pleasure, 'number',
      `pad.pleasure 应为 number，实得 ${typeof emo.pad.pleasure}`);

    const dec = e.dispatch('decision.decide', { task: '选择', options: ['A', 'B'] });
    assert.ok(dec && typeof dec === 'object', 'decision.decide 应返回对象');
    assert.strictEqual(typeof dec.reasoning, 'string',
      `decision.reasoning 应为 string，实得 ${typeof dec.reasoning}`);
    e.shutdown();
  });

  test('④ 关停: shutdown() 后 started 变 false', async () => {
    const e = mk();
    e.start();
    await settle();
    e.shutdown();
    assert.strictEqual(e.started, false, 'shutdown() 后 started 应为 false');
  });
};
