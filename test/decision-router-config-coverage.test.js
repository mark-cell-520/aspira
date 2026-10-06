// test/decision-router-config-coverage.test.js
// test-coverage-gap 切片：为引擎从不加载的纯配置模块 src/core/decision-router-config.js 补回归覆盖。
// 依据：全库有 164 个 src/ 模块引擎从不加载(AGENTS.md 周期28 实测)，本模块经 grep 全 test/ 零引用。
// 约 2026 单体拆分把 decision-router 的常量/规则抽到本 *-config 模块，却无任何测试钉其契约。
//
// 断言全部"非恒真"——锁的是应然不变量，配置被改坏即红：
//   · FIELD_WEIGHTS 是全局权重向量，三λ必须归一(=1)；任一越界或不归一即失败。
//   · SCENE_WEIGHTS 每场景三λ∈[0,1]；并显式钉住实测异常 emotional 和=0.8(其余5个=1)。
//   · FLIP_THRESHOLDS 16 项全有限数，且 aBoundaryLow<aBoundaryHigh(否则"下界>上界"逻辑颠倒)。
//   · DEFAULT_PROFILE 置信度四档单调递增(0.3<0.5<0.7<0.9)。
//   · DECISION↔DECISION_PRIORITY 两集合必须一致(每个决策都有优先级，反之亦然)，优先级唯一正整数。
//   · MODEL_PROFILES 4 画像均为对象。
//
// 覆盖前据实测量的异常(诚实数字，非本次修复——本切片只补覆盖不改逻辑)：
//   SCENE_WEIGHTS.emotional 三λ和=0.35+0.25+0.2=0.80，而 general/technical/analytical/creative/reflective
//   均为 1.0。是 bug(漏归一)还是有意(情感场景降权)未定；本测试用断言**钉住当前实测**(恰一个场景≠1 且
//   为 emotional 且≈0.8)，使其既不会静默"变好", 也不会静默扩散。若日后有意归一化 emotional, 需连同
//   更新本断言——"覆盖缺口的消失应是刻意决定, 不应悄无声息"(AGENTS.md)。
'use strict';
const path = require('path');
const cfg = require(path.join(__dirname, '..', 'src', 'core', 'decision-router-config.js'));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name} :: ${e.message}`); }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

t('VERSION 为 semver', () => ok(/^\d+\.\d+\.\d+$/.test(cfg.VERSION), `VERSION=${cfg.VERSION} 非 semver`));

t('FIELD_WEIGHTS 三λ齐备、各∈(0,1)、和恒为1', () => {
  const w = cfg.FIELD_WEIGHTS;
  ok(w && typeof w === 'object', 'FIELD_WEIGHTS 非对象');
  for (const k of ['lambdaU', 'lambdaD', 'lambdaA']) ok(isNum(w[k]), `FIELD_WEIGHTS.${k} 非有限数: ${w[k]}`);
  for (const k of Object.keys(w)) ok(w[k] > 0 && w[k] <= 1, `FIELD_WEIGHTS.${k}=${w[k]} 越界(应∈(0,1])`);
  const sum = w.lambdaU + w.lambdaD + w.lambdaA;
  ok(Math.abs(sum - 1) < 1e-6, `FIELD_WEIGHTS 三λ和=${sum} ≠ 1(未归一)`);
});

t('SCENE_WEIGHTS: 6 场景, 每场景三λ齐备且∈[0,1]', () => {
  const s = cfg.SCENE_WEIGHTS;
  ok(s && typeof s === 'object', 'SCENE_WEIGHTS 非对象');
  const scenes = Object.keys(s);
  ok(scenes.length === 6, `场景数=${scenes.length} ≠ 6`);
  for (const name of scenes) {
    for (const k of ['lambdaU', 'lambdaD', 'lambdaA']) {
      ok(isNum(s[name][k]) && s[name][k] >= 0 && s[name][k] <= 1,
        `SCENE_WEIGHTS.${name}.${k}=${s[name] && s[name][k]} 非[0,1]有限数`);
    }
  }
});

t('SCENE_WEIGHTS 归一性: 恰 emotional 一个场景和≠1 且≈0.8(钉住实测异常)', () => {
  const s = cfg.SCENE_WEIGHTS;
  const nonOne = [];
  for (const name of Object.keys(s)) {
    const sum = s[name].lambdaU + s[name].lambdaD + s[name].lambdaA;
    if (Math.abs(sum - 1) > 1e-6) nonOne.push({ name, sum });
  }
  ok(nonOne.length === 1, `非归一场景数=${nonOne.length}(${nonOne.map(n => n.name + ':' + n.sum.toFixed(2)).join(',')})，实测应恰为 1(emotional)`);
  ok(nonOne[0].name === 'emotional', `非归一场景是 ${nonOne[0].name}，实测应为 emotional`);
  ok(Math.abs(nonOne[0].sum - 0.8) < 1e-6, `emotional 和=${nonOne[0].sum}，实测应≈0.8`);
});

t('FLIP_THRESHOLDS: 16 项全有限数, 且 aBoundaryLow < aBoundaryHigh', () => {
  const f = cfg.FLIP_THRESHOLDS;
  ok(f && typeof f === 'object', 'FLIP_THRESHOLDS 非对象');
  const keys = Object.keys(f);
  ok(keys.length === 16, `FLIP_THRESHOLDS 项数=${keys.length} ≠ 16`);
  for (const k of keys) ok(isNum(f[k]), `FLIP_THRESHOLDS.${k}=${f[k]} 非有限数`);
  ok(f.aBoundaryLow < f.aBoundaryHigh, `aBoundaryLow(${f.aBoundaryLow}) 应 < aBoundaryHigh(${f.aBoundaryHigh})`);
});

t('DEFAULT_PROFILE: 置信度四档单调递增且∈(0,1]', () => {
  const d = cfg.DEFAULT_PROFILE;
  const seq = [d.confidenceFloor, d.confidenceStandard, d.confidenceHigh, d.confidenceMax];
  for (const v of seq) ok(isNum(v) && v > 0 && v <= 1, `置信度档 ${v} 越界(应∈(0,1])`);
  for (let i = 1; i < seq.length; i++) ok(seq[i - 1] < seq[i], `置信度非单调: ${seq.join(',')}`);
});

t('DECISION: 8 个决策, 值为唯一小写字符串', () => {
  const d = cfg.DECISION;
  const keys = Object.keys(d);
  ok(keys.length === 8, `DECISION 键数=${keys.length} ≠ 8`);
  const vals = Object.values(d);
  ok(new Set(vals).size === vals.length, 'DECISION 存在重复值');
  for (const v of vals) ok(typeof v === 'string' && /^[a-z]+$/.test(v), `DECISION 值 ${v} 非小写字母`);
});

t('DECISION ↔ DECISION_PRIORITY 集合一致, 优先级唯一正整数', () => {
  const dset = new Set(Object.values(cfg.DECISION));
  const pset = new Set(Object.keys(cfg.DECISION_PRIORITY));
  const miss = [...dset].filter(x => !pset.has(x));
  const extra = [...pset].filter(x => !dset.has(x));
  ok(miss.length === 0, `有决策缺优先级: ${miss.join(',')}`);
  ok(extra.length === 0, `有优先级无对应决策: ${extra.join(',')}`);
  const pv = Object.values(cfg.DECISION_PRIORITY);
  ok(new Set(pv).size === pv.length, 'DECISION_PRIORITY 存在重复优先级');
  for (const v of pv) ok(Number.isInteger(v) && v > 0, `优先级 ${v} 非正整数`);
});

t('MODEL_PROFILES: 4 个画像均为对象', () => {
  const m = cfg.MODEL_PROFILES;
  const keys = Object.keys(m);
  ok(keys.length === 4, `MODEL_PROFILES 画像数=${keys.length} ≠ 4`);
  for (const k of keys) ok(m[k] && typeof m === 'object' && typeof m[k] === 'object', `MODEL_PROFILES.${k} 非对象`);
});

console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
process.exit(failed > 0 ? 1 : 0);
