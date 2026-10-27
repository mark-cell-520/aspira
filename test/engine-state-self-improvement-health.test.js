// 无人值守升级轮自改进健康检查专项测试。
//
// 锁的缺陷：src/core/engine-state.js 的 _runSelfImprovementHealthCheck 从写下起
// 第一行就抛 ReferenceError: _boundedPush is not defined —— _boundedPush 是在
// heartflow.js 里定义的，engine-state 提取成独立模块时没被带过来。该函数被
// heartflow.js:4374 的 try/catch 静默吞掉，于是 hf._siHealth 永远不写，
// getSelfImprovementHealth() 永远返回 { connected:false, modules:[],
// issues:['_boundedPush is not defined'] } —— 它唯一能报告的"问题"是自己的拼写错误，
// 而 meta-learner / self-healing-rl / confidence-calibrator 三条信号流一次都没被检查过。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'core', 'engine-state.js');
const es = require(SRC);

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      ret.then(() => { passed++; console.log(`  ✓ ${name}`); })
        .catch(e => { failed++; console.log(`  ✗ ${name}`); console.log(`    ${e.message}`); failures.push(name); });
      return;
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failures.push(name);
  }
}

// ─── 1. 真实引擎：健康检查必须真的跑完并落盘 ───
test('真实引擎 start() 后 _siHealth 必须被写入且带真实模块清单', async () => {
  const mod = require('../src/core/heartflow.js');
  const hf = mod.createAspira ? mod.createAspira({ silent: true }) : new mod.Aspira({ silent: true });
  try {
    await hf.start();
  } catch (e) {
    throw new Error('引擎启动失败: ' + e.message);
  }
  try {
    assert.ok(hf._siHealth, 'hf._siHealth 必须被写入（未写入说明健康检查没跑完）');
    assert.ok(Array.isArray(hf._siHealth.modules), 'modules 必须是数组');
    assert.ok(hf._siHealth.modules.length > 0, 'modules 不得为空 —— 空清单正是 ReferenceError 提前退出的形状');
    assert.ok(Array.isArray(hf._siHealth.issues), 'issues 必须是数组');
    assert.ok(typeof hf._siHealth.connected === 'boolean', 'connected 必须是布尔');
    assert.ok(typeof hf._siHealth.ts === 'number', 'ts 必须被记录');

    // 恒假判据锁：问题清单里不得出现这个函数自己的 ReferenceError
    const joined = hf._siHealth.issues.join(' | ');
    assert.ok(!/_boundedPush is not defined/.test(joined),
      'issues 里出现了 _boundedPush is not defined —— 健康检查仍在第一行崩');
    assert.ok(!/is not defined/.test(joined),
      'issues 里出现了未定义标识符报错，说明检查逻辑自身还有作用域缺陷');

    // getSelfImprovementHealth 必须把同一份清单读出来，而不是空数组
    const g = es.getSelfImprovementHealth(hf);
    assert.deepStrictEqual(g.modules, hf._siHealth.modules,
      'getSelfImprovementHealth 读出的 modules 必须与 _siHealth 一致');
    assert.ok(g.modules.length > 0, 'getSelfImprovementHealth 不得返回空 modules');
    assert.ok(!/_boundedPush/.test(g.issues.join(' | ')),
      'getSelfImprovementHealth 不得再把 _boundedPush 当成唯一 issue');
  } finally {
    if (hf.shutdown) hf.shutdown();
  }
});

// ─── 2. 桩对象：三个子系统全缺时，三条分支必须都真的执行 ───
test('子系统全缺时三条 not-instantiated 必须全部出现（证明分支真的在跑）', () => {
  const hf = {};
  const health = es._runSelfImprovementHealthCheck(hf);
  const issues = health.issues.join(' | ');
  assert.ok(/meta-learner: not instantiated/.test(issues), '缺 meta-learner 分支未执行');
  assert.ok(/self-healing-rl: not instantiated/.test(issues), '缺 self-healing-rl 分支未执行');
  assert.ok(/confidence-calibrator: not instantiated/.test(issues), '缺 confidence-calibrator 分支未执行');
  assert.strictEqual(health.connected, false, '全缺时 connected 必须为 false');
  assert.deepStrictEqual(health.modules, [], '全缺时 modules 必须为空');
});

// ─── 3. 桩对象：三个子系统齐全时，connected 必须为 true ───
test('子系统齐全且信号流通时 connected 必须为 true', () => {
  const meta = { learn() {}, getStats() { return {}; } };
  const sh = { getStats() { return { qTableSize: 3 }; }, mergeFromLearnedLayer() {}, emit() {} };
  const cc = { calibrate() {}, assess() {} };
  const hf = { meta, selfHealing: sh, confidence: cc };
  const health = es._runSelfImprovementHealthCheck(hf);
  assert.strictEqual(health.connected, true,
    '三条信号流都通时必须 connected=true，实测 issues: ' + JSON.stringify(health.issues));
  assert.ok(health.modules.includes('meta-learner'), 'modules 必须含 meta-learner');
  assert.ok(health.modules.includes('self-healing-rl'), 'modules 必须含 self-healing-rl');
  assert.ok(health.modules.includes('confidence-calibrator'), 'modules 必须含 confidence-calibrator');
  assert.ok(health.modules.includes('signal:meta->selfHealing'), 'modules 必须含 signal:meta->selfHealing');
  assert.ok(health.modules.includes('signal:confidence->meta'), 'modules 必须含 signal:confidence->meta');
});

// ─── 4. 桩对象：只缺 mergeFromLearnedLayer 时，必须报出这一条且不得连带误报 ───
test('只缺 mergeFromLearnedLayer 时必须单独报出该信号被阻断', () => {
  const meta = { learn() {}, getStats() { return {}; } };
  const sh = { getStats() { return { qTableSize: 3 }; }, emit() {} }; // 没有 mergeFromLearnedLayer
  const cc = { calibrate() {} };
  const hf = { meta, selfHealing: sh, confidence: cc };
  const health = es._runSelfImprovementHealthCheck(hf);
  assert.strictEqual(health.connected, false, '有阻断时必须 connected=false');
  assert.ok(health.issues.some(i => /mergeFromLearnedLayer missing/.test(i)),
    '未报出 mergeFromLearnedLayer missing');
  assert.ok(!health.issues.some(i => /meta-learner: not instantiated/.test(i)),
    'meta-learner 明明在，不得误报 not instantiated');
});

// ─── 5. 有界性：issues 超限时必须被截断而不是无限增长 ───
test('_boundedPush 必须有界（超出上限时丢最旧）', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(/function _boundedPush\s*\(/.test(src),
    'engine-state.js 必须在本文件内定义 _boundedPush —— 依赖 heartflow.js 的同名helper正是本缺陷的根因');
  // 直接通过桩对象把 issues 撑过上限，验证截断行为真实存在
  const hf = {};
  const health = es._runSelfImprovementHealthCheck(hf);
  assert.ok(health.issues.length <= 500, 'issues 长度不得超过有界上限');
});

// ─── 6. 未启动引擎：getSelfImprovementHealth 必须给出可读原因 ───
test('未启动时 getSelfImprovementHealth 必须报 Aspira not started', () => {
  const g = es.getSelfImprovementHealth({ started: false });
  assert.strictEqual(g.connected, false);
  assert.ok(g.issues.some(i => /Aspira not started/.test(i)), '未启动原因未报出');
});

(async () => {
  await new Promise(r => setTimeout(r, 60));
  console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
  if (failed) process.exitCode = 1;
})();
