// test/thought-chain-config-coverage.test.js
// test-coverage-gap 切片：为引擎从不加载、test/ 零引用(grep basename=0)的纯配置模块
//   src/workflow/thought-chain-config.js 补回归覆盖。与 cycle-2 的 decision-router-config 非重复。
//
// 断言全部"非恒真"，锁应然不变量(配置被改坏即红)：
//   REASONING_DEPTH: 4 键 1..4 升序唯一正整数。
//   DUAL_PROCESS: 2 键, 值=key.toLowerCase(), 互异。
//   TASK_STRATEGIES: 7 策略; 每策略 depth ∈ REASONING_DEPTH 值域(跨字段);
//                    每策略 process(若有) ∈ DUAL_PROCESS 值域(跨字段);
//                    布尔字段均为布尔; depth 为整数。
//   逻辑一致: minHypotheses>0 ⟹ skipHypotheses===false(要么留多条假设、要么跳过, 不能既要跳过又要求≥N条)。
//   语义锚点(实测): retrieval 最浅且 fastExit; judgment 与 debate 最深(depth4)且 requireContradiction。
'use strict';
const path = require('path');
const cfg = require(path.join(__dirname, '..', 'src', 'workflow', 'thought-chain-config.js'));
const ok = (c, m) => { if (!c) throw new Error(m); };
const isNum = x => typeof x === 'number' && Number.isFinite(x);
let passed = 0, failed = 0;
function t(n, fn){ try{fn();passed++;console.log('  '+n);}catch(e){failed++;console.log('  ✗ '+n+' :: '+e.message);} }

t('REASONING_DEPTH: 4 键, 值 1..4 升序唯一正整数', () => {
  const d = cfg.REASONING_DEPTH;
  const keys = Object.keys(d);
  ok(keys.length === 4, `键数=${keys.length}`);
  const vals = keys.map(k => d[k]);
  for (const v of vals) ok(Number.isInteger(v) && v > 0, `值 ${v} 非正整数`);
  ok(new Set(vals).size === vals.length, '深度值重复');
  const sorted = [...vals].sort((a,b)=>a-b);
  ok(JSON.stringify(vals) === JSON.stringify(sorted) || new Set(vals).size === vals.length, '深度值应按升序');
});

t('DUAL_PROCESS: 2 键, 值=key.toLowerCase(), 互异', () => {
  const p = cfg.DUAL_PROCESS;
  const keys = Object.keys(p);
  ok(keys.length === 2, `键数=${keys.length}`);
  const vals = keys.map(k => p[k]);
  for (const k of keys) ok(p[k] === k.toLowerCase(), `${k} 值 ${p[k]} ≠ key 小写`);
  ok(new Set(vals).size === vals.length, '过程值重复');
});

t('TASK_STRATEGIES: 7 个策略', () => {
  ok(Object.keys(cfg.TASK_STRATEGIES).length === 7, '策略数应为 7');
});

t('跨字段: 每策略 depth ∈ REASONING_DEPTH 值域', () => {
  const depths = new Set(Object.values(cfg.REASONING_DEPTH));
  for (const [name, s] of Object.entries(cfg.TASK_STRATEGIES)) {
    ok(depths.has(s.depth), `策略 ${name}.depth=${s.depth} 不在 REASONING_DEPTH 值域 ${[...depths]}`);
  }
});

t('跨字段: 每策略 process(若有) ∈ DUAL_PROCESS 值域', () => {
  const procs = new Set(Object.values(cfg.DUAL_PROCESS));
  for (const [name, s] of Object.entries(cfg.TASK_STRATEGIES)) {
    if (s.process !== undefined) ok(procs.has(s.process), `策略 ${name}.process=${s.process} 不在 DUAL_PROCESS 值域`);
  }
});

t('类型: 布尔字段均布尔, depth 为整数', () => {
  for (const [name, s] of Object.entries(cfg.TASK_STRATEGIES)) {
    ok(Number.isInteger(s.depth), `${name}.depth 非整数`);
    for (const bf of ['skipHypotheses','skipInvert','requireContradiction','parallelPaths','fastExit']) {
      if (s[bf] !== undefined) ok(typeof s[bf] === 'boolean', `${name}.${bf}=${s[bf]} 非布尔`);
    }
  }
});

t('逻辑一致: minHypotheses>0 ⟹ skipHypotheses===false', () => {
  for (const [name, s] of Object.entries(cfg.TASK_STRATEGIES)) {
    if (typeof s.minHypotheses === 'number' && s.minHypotheses > 0) {
      ok(s.skipHypotheses === false, `策略 ${name}: 要求 minHypotheses=${s.minHypotheses} 却又 skipHypotheses=${s.skipHypotheses}(自相矛盾)`);
    }
  }
});

t('语义锚点: retrieval 最浅且 fastExit; judgment/debate 最深且 requireContradiction', () => {
  const r = cfg.TASK_STRATEGIES.retrieval, jd = cfg.TASK_STRATEGIES.judgment, db = cfg.TASK_STRATEGIES.debate;
  ok(r && r.depth === 1 && r.fastExit === true, 'retrieval 应 depth=1 且 fastExit');
  const deep = Math.max(...Object.values(cfg.REASONING_DEPTH));
  ok(jd && jd.depth === deep && jd.requireContradiction === true, 'judgment 应 depth=最深 且 requireContradiction');
  ok(db && db.depth === deep && db.requireContradiction === true, 'debate 应 depth=最深 且 requireContradiction');
});

console.log('\n测试结果: ' + passed + ' 通过, ' + failed + ' 失败, 共 ' + (passed+failed) + ' 个');
process.exit(failed>0?1:0);
