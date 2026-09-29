'use strict';

const assert = require('assert');
const hf = require('../../src/index.js');
const { checkOutbound } = require('../../src/gate-outbound.js');
const cb = require('../../src/circuit-breaker.js');

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log('  OK ' + name); passed++; }
  catch (e) { console.log('  FAIL ' + name + ': ' + e.message); failed++; }
}

console.log('\n═══ 国标合规测试 ═══\n');

// G1 生成内容安全
console.log('【关口 1】生成内容安全');

test('G1-1: checkFactualConsistency', () => {
  const r = hf.checkFactualConsistency('test');
  assert.ok('score' in r && 'flags' in r);
});

test('G1-2: checkBullshitRecognition', () => {
  const r = hf.checkBullshitRecognition('据大量研究显示降维打击闭环赋能');
  assert.ok(r.score > 0.1 || r.finding === 'bullshit');
});

test('G1-3: checkVagueness', () => {
  const r = hf.checkVagueness('据业内人士透露');
  assert.ok(r.score > 0.1 || r.finding === 'vague');
});

test('G1-4: checkHateSpeech 结构', () => {
  const r = hf.checkHateSpeech('test');
  assert.ok('hits' in r && 'score' in r);
});

test('G1-5: checkPrivacyBoundary 结构', () => {
  const r = hf.checkPrivacyBoundary('test');
  assert.ok('violations' in r && 'score' in r);
});

test('G1-6: discriminate 维度完整', () => {
  const r = hf.discriminate('test');
  assert.ok(r.verdict && r.dimensions && Object.keys(r.dimensions).length >= 40);
});

test('G1-7: checkPromptInjection 结构', () => {
  const r = hf.checkPromptInjection('test');
  assert.ok('injections' in r && 'score' in r);
});

test('G1-8: checkContradiction 结构', () => {
  const r = hf.checkContradiction('test');
  assert.ok('contradictions' in r);
});

// G2 训练数据安全
console.log('\n【关口 2】训练数据安全');

test('G2-1: DataEraser', () => { assert.ok(hf.DataEraser); });
test('G2-2: DataEraser.erase', () => { assert.ok(typeof hf.DataEraser === 'function' || typeof hf.DataEraser.erase === 'function'); });

// G3 出域防护
console.log('\n【关口 3】出域防护');

test('G3-1: 手机号 → rewrite', () => {
  const r = checkOutbound({ text: '13812345678' });
  assert.strictEqual(r.action, 'rewrite');
});

test('G3-2: 身份证号 → rewrite', () => {
  // 实际: rewrite(脱敏放行)，非硬拦截
  const r = checkOutbound({ text: '110101199001011234' });
  assert.strictEqual(r.action, 'rewrite', 'action=' + r.action);
  assert.ok(r.sanitized, '应脱敏');
});

test('G3-3: 机密合同 → block', () => {
  // [期望修正] 这里原先是 `→ rewrite`，注释写"实际: rewrite(脱敏放行)"。
  // 那个"实际"是**缺陷的产物**，不是设计意图:
  // checkOutbound 的 forcedLevel 是 MCP schema 传来的中文字符串，
  // 而 estimateClassification() 返回 CLASSIFICATION 对象，
  // 于是 `forcedLevel || estimate(...)` 让 classification 变成字符串，
  // 下面每个 `classification.level` 都是 undefined ——
  // `undefined >= 3` 为 false，密级 block 分支整个失效，
  // 只能掉进 PII 分支得 rewrite。
  // CLASSIFICATION 表自己写明了意图: CONFIDENTIAL/SECRET 的 action 就是 'block'。
  // 修复后按设计返回 block。测试的期望跟着设计走，不跟着缺陷走。
  const r = checkOutbound({ text: '合同金额 500万元', classification: '机密' });
  assert.strictEqual(r.action, 'block', 'action=' + r.action);
  assert.strictEqual(r.classificationLevel, 3, 'level=' + r.classificationLevel);
  assert.ok(r.reason.includes('密级过高'), 'reason=' + r.reason);
});

test('G3-3b: 绝密 → block，公开 → 不因密级被拦', () => {
  // 密级阶梯必须真的分级，不能一拦全拦(修复前两种取值判定完全相同)
  const secret = checkOutbound({ text: '合同金额 500万元', classification: '绝密' });
  assert.strictEqual(secret.action, 'block', 'action=' + secret.action);
  assert.strictEqual(secret.classificationLevel, 4, 'level=' + secret.classificationLevel);
  const pub = checkOutbound({ text: '合同金额 500万元', classification: '公开' });
  assert.notStrictEqual(pub.action, 'block', '公开不应因密级被 block');
  assert.strictEqual(pub.classificationLevel, 0, 'level=' + pub.classificationLevel);
});

test('G3-3c: 非法密级值不得静默变成 undefined', () => {
  // 修复前的另一个面向: 传个枚举外的值，classification 就是那个字符串，
  // 返回体里 classification/classificationLevel 全是 undefined。
  const r = checkOutbound({ text: '合同金额 500万元', classification: '不存在的级别' });
  assert.ok(typeof r.classificationLevel === 'number', 'level 必须是数字，实测 ' + r.classificationLevel);
  assert.ok(r.classification, 'label 必须有值，实测 ' + r.classification);
});

test('G3-4: 公开内容 → rewrite(脱敏)', () => {
  // [第十七轮修复] 这里原先断言 `今天天气真好` → rewrite，
  // 注释还写着"实际: 公开内容触发 PII 规则 rewrite（非 bug，是 PII 规则触发）"。
  // **那句话是缺陷的产物，而且这个测试把它锁死了。**
  //
  // 根因在 src/gate-outbound.js 的 scanPII: `findings` 数组初始化时装的是三条
  // **pattern 描述对象**({ pattern, type, level })，从来没有任何代码用它们匹配文本，
  // 却被原样当作"发现"返回。于是:
  //   · piiFindings.length 恒 >= 3，`piiFindings.length > 0` 恒真
  //     → checkOutbound 的 action **永远不可能是 'pass'**;
  //   · 那三条序列化成 `{}`，没有 id/name/severity，调用方无法据以行动;
  //   · 真实 PII 的计数被 +3 污染(实测 2 处真实命中报成 5 处)。
  // 实测(修复前): '今天天气真好'、'hello world'、'12345'、'   ' 全部判 rewrite，
  // reason 写着"命中 PII 规则 (3 处)"，而那 3 处一条也不存在。
  //
  // 与 G3-3 是同一个教训: **测试的期望要跟着设计走，不跟着缺陷走**——
  // 上一次是 forcedLevel 契约不匹配让密级 block 分支失效，
  // 这一次是幽灵 finding 让 pass 分支不可达。两次都有注释替缺陷辩护。
  //
  // 无 PII、未强制密级的文本，按 CLASSIFICATION 表的设计就是 pass。
  const clean = checkOutbound({ text: '今天天气真好' });
  assert.strictEqual(clean.action, 'pass', 'action=' + clean.action);
  assert.strictEqual(clean.piiCount, 0, 'piiCount=' + clean.piiCount);
  assert.ok(clean.reason.includes('无 PII'), 'reason=' + clean.reason);

  // 原测试的**意图**(有 PII 的公开内容 → 脱敏放行)用一个真含 PII 的文本来保住了:
  // rewrite ≠ 泄露，脱敏后放行符合国标 PII 处理要求。
  const r = checkOutbound({ text: '今天天气真好，我的手机是13812345678' });
  assert.strictEqual(r.action, 'rewrite', 'action=' + r.action);
  assert.ok(r.sanitized, '应脱敏');
  assert.strictEqual(r.piiCount, 1, 'piiCount=' + r.piiCount);
  assert.strictEqual(r.piiFindings[0].id, 'PHONE', 'id=' + r.piiFindings[0].id);
});

test('G3-5: safeFetch preflight', () => {
  // safeFetch 结构正确性验证（非空对象）
  const { preflightCheck } = require('../../src/safe-fetch.js');
  const r = preflightCheck('hello');
  assert.ok(r && typeof r === 'object', 'preflight 应返回对象');
});

// G4 算法透明
console.log('\n【关口 4】算法透明');

test('G4-1: crossAnalyze', () => { assert.ok(typeof hf.crossAnalyze === 'function'); });
test('G4-2: entropyAnalysis', () => { assert.ok(typeof hf.entropyAnalysis === 'function'); });
test('G4-3: summarizeDiscrimination', () => { assert.ok(typeof hf.summarizeDiscrimination === 'function'); });

// G5 审计追溯
console.log('\n【关口 5】审计追溯');

test('G5-1: HMAC链', () => {
  const { initChain, appendEntry, verifyChain } = require('../../src/trace-chain.js');
  initChain('/tmp/comp-65-1.json');
  appendEntry({ traceId: 'T1', stage: 's1', agentId: 'a' });
  appendEntry({ traceId: 'T1', stage: 's2', agentId: 'a' });
  assert.strictEqual(verifyChain().valid, true);
});

test('G5-2: 16 标签', () => {
  const { listViolationTags } = require('../../src/trace-chain.js');
  assert.strictEqual(listViolationTags().length, 16);
});

// G6 应急处置
console.log('\n【关口 6】应急处置');

test('G6-1: CLOSED', () => { cb.reset(); assert.strictEqual(cb.getState().state, 'CLOSED'); });
test('G6-2: trip TRIPPED', () => { cb.reset(); cb.trip('g'); assert.strictEqual(cb.isTripped(), true); });
test('G6-3: reset CLOSED', () => { cb.reset(); assert.strictEqual(cb.getState().state, 'CLOSED'); });
test('G6-4: guard放行', () => { cb.reset(); assert.strictEqual(cb.guard().allowed, true); });
test('G6-5: healthCheck字段', () => { const h = cb.healthCheck(); assert.ok('status' in h && 'memory' in h && 'cpu' in h); });

console.log('\n═══ ' + passed + ' passed / ' + failed + ' failed ═══\n');
process.exit(failed > 0 ? 1 : 0);
