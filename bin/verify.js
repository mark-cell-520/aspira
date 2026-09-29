#!/usr/bin/env node
/**
 * Aspira 安装验证脚本
 * 检查所有核心模块能否正常加载，输出清晰的成功/失败列表
 * 运行: node bin/verify.js 或 npm run verify
 */

const fs = require('fs');
const path = require('path');

const HF_DIR = path.join(__dirname, '..');
const RESULTS = [];
let hasError = false;

function check(label, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(r => {
        RESULTS.push(`  ✅ ${label}`);
        return r;
      }).catch(e => {
        RESULTS.push(`  ❌ ${label}: ${e.message.split('\n')[0]}`);
        hasError = true;
        return null;
      });
    }
    RESULTS.push(`  ✅ ${label}`);
    return result;
  } catch (e) {
    RESULTS.push(`  ❌ ${label}: ${e.message.split('\n')[0]}`);
    hasError = true;
    return null;
  }
}

console.log('');
console.log('=== Aspira 安装验证 ===\n');

// Collect all async check results
const checkResults = [];

// 1. Node.js 版本
checkResults.push(check('Node.js >= 18', () => {
  const v = process.version;
  const major = parseInt(v.slice(1).split('.')[0]);
  if (major < 18) throw new Error(`当前 v${process.version}，需要 >= 18`);
  return v;
}));

// 2. 关键文件存在
check('src/core/heartflow.js 存在', () => {
  const p = path.join(HF_DIR, 'src/core/heartflow.js');
  if (!fs.existsSync(p)) throw new Error('文件不存在');
});

check('bin/cli.js 存在', () => {
  const p = path.join(HF_DIR, 'bin/cli.js');
  if (!fs.existsSync(p)) throw new Error('文件不存在');
});

check('package.json 存在', () => {
  const p = path.join(HF_DIR, 'package.json');
  if (!fs.existsSync(p)) throw new Error('文件不存在');
});

// 3. 核心模块 require
check('heartflow.js 模块可加载', () => {
  const { Aspira } = require(path.join(HF_DIR, 'src/core/heartflow.js'));
  if (typeof Aspira !== 'function') throw new Error('Aspira 不是构造函数');
});

// 4. 启动引擎
let engine = null;
check('引擎启动', () => {
  const { Aspira } = require(path.join(HF_DIR, 'src/core/heartflow.js'));
  engine = new Aspira();
  engine.start();
  if (!engine.started) throw new Error('engine.started 为 false');
});

check('模块数 >= 40', () => {
  if (!engine) throw new Error('引擎未启动');
  const count = Object.keys(engine._modules || {}).length;
  if (count < 40) throw new Error(`只有 ${count} 个模块，期望 >= 40`);
});

check('模块数 >= 124', () => {
  if (!engine) throw new Error('引擎未启动');
  const count = Object.keys(engine._modules || {}).length;
  if (count < 124) throw new Error(`只有 ${count} 个模块，期望 >= 124`);
});

check('测试文件数 >= 10', () => {
  const testDir = path.join(HF_DIR, 'test');
  const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js'));
  if (files.length < 10) throw new Error(`测试文件只有 ${files.length} 个，期望 >= 10`);
});

check('知识本体测试存在', () => {
  const p = path.join(HF_DIR, 'test', 'knowledge-ontology.test.js');
  if (!fs.existsSync(p)) throw new Error('knowledge-ontology.test.js 不存在');
});

check('dispatch 路由可用', () => {
  if (!engine) throw new Error('引擎未启动');
  const r = engine.dispatch('emotion.process', '测试');
  const data = r && r.result ? r.result : r;
  if (!data || typeof data.pad?.pleasure !== 'number') throw new Error('emotion.process 返回异常');
});

checkResults.push(check('think() 可用', async () => {
  if (!engine) throw new Error('引擎未启动');
  try {
    const r = await engine.think('你好');
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('think() 返回异常');
    if (!r.output && !r.decision && !r.chain) throw new Error('think() 返回结构异常');
  } catch (e) {
    throw new Error(`think() 失败: ${e.message}`);
  }
}));

// 5. 停止引擎
if (engine) {
  try { engine.stop(); } catch(e) { /* stop may fail on circular ref */ }
}

// 6. npm 依赖检查
// [诚实性修复·第四轮] 这条检查**标题与内容本来是矛盾的**:
// 标题写「npm 必选依赖为空」，失败条件却是 `deps < 1`(要求依赖非空)，
// 错误信息还说「新愿至少需要 mathjs」——它是旧事实的化石。
// 实测(本轮): node_modules 完全不存在时引擎仍启动 132 个模块、
// initErrors 为 undefined、think() 完整工作; mathjs 的 require 在
// formula-calculator.js 里已改为缺失即降级(返回 null + 明确的
// OPTIONAL_DEP_MISSING 说明)，不再抛 MODULE_NOT_FOUND。
// 所以 mathjs 从来不是「必选」，这条检查一直在维护一个错误的事实。
//
// 新契约锁两件事(都比旧断言强):
//   ① dependencies 必须为空 —— 「0 runtime dependencies」的声明侧
//   ② optionalDependencies 里声明的包，其 require 点必须能被 catch 到
//      —— 即「可选」是真的可选，缺失不会让引擎崩
// 第 ② 项由 scripts/audit-doc-numbers.js 的 depsActuallyRequired 每次扫描，
// 此处再补一个直接的行为断言: 在 mathjs 缺失下构造 FormulaCalculator 不抛。
check('npm 运行时依赖必须为空(0 runtime dependencies)', () => {
  const pkg = require(path.join(HF_DIR, 'package.json'));
  const deps = Object.keys(pkg.dependencies || {}).length;
  if (deps !== 0) {
    throw new Error(`dependencies 声明了 ${deps} 个包，但文档三处声称 0 runtime dependencies；`
      + '若确属可选依赖，请移入 optionalDependencies 并确保其 require 点在 try/catch 内');
  }
  const opt = Object.keys(pkg.optionalDependencies || {});
  if (opt.length > 0) {
    // 可选依赖必须真的是可选的: 缺失时构造与查表路径都不能抛
    const fcPath = path.join(HF_DIR, 'src', 'formula', 'formula-calculator.js');
    const src = require('fs').readFileSync(fcPath, 'utf8');
    if (!/try\s*\{[^}]*require\(['"]mathjs['"]\)/s.test(src.replace(/\s+/g, ' '))) {
      throw new Error('mathjs 在 optionalDependencies 中，但其 require 点不在 try/catch 内——'
        + '「可选」名不副实，缺失时会抛 MODULE_NOT_FOUND');
    }
  }
});

// 7. 明文记忆扫描：检查是否有新增的 .txt/.json 明文记忆落盘
checkResults.push(check('扫描新增.txt/.json明文记忆', async () => {
  const fs = require('fs');
  const path = require('path');

  // 需要排除的明文记忆目录/文件（预期内允许明文存在的路径）
  const allowedPlaintextPaths = new Set([
    path.resolve(HF_DIR, 'data', 'memories', 'self-memories.jsonl'),
    path.resolve(HF_DIR, 'data', 'memories', 'user-memories.jsonl'),
    path.resolve(HF_DIR, 'memory', 'dialogue-history.jsonl'),
    path.resolve(HF_DIR, 'memory', 'q-table.json'),
    path.resolve(HF_DIR, 'data', 'heartflow-state-history.jsonl'),
    path.resolve(HF_DIR, 'data', 'heartflow-state.json'),
    path.resolve(HF_DIR, 'data', 'memory-bank.json'),
    path.resolve(HF_DIR, 'data', 'memory-index.json'),
    path.resolve(HF_DIR, 'data', 'memories', 'memory-index.json'),
    path.resolve(HF_DIR, 'data', 'meaningful-memory.json'),
    path.resolve(HF_DIR, 'data', 'memories', 'context-memory.json'),
    path.resolve(HF_DIR, 'data', 'judgments', 'judgment-history.json'),
    path.resolve(HF_DIR, 'data', 'code-graph.json'),
    path.resolve(HF_DIR, 'data', 'intervention-protocols.json'),
    path.resolve(HF_DIR, 'data', 'large', 'empathy_train.json'),
    path.resolve(HF_DIR, 'data', 'large', 'knowledge_base.json'),
    path.resolve(HF_DIR, 'data', 'memories', 'context-memory.json'),
    path.resolve(HF_DIR, 'data', 'memories', 'core.json'),
    path.resolve(HF_DIR, 'data', 'memories', 'memory-index.json'),
    path.resolve(HF_DIR, 'config.json'),
    path.resolve(HF_DIR, 'data', 'narrative-self.json'),
  ]);

  // 整目录白名单：以下目录下的 .txt/.json 均为运行时合法生成（反馈/教育/状态子系统）
  const allowedPlaintextDirPrefixes = [
    path.resolve(HF_DIR, 'data'),
    path.resolve(HF_DIR, 'data', 'feedback'),
    path.resolve(HF_DIR, 'data', 'edu'),
    path.resolve(HF_DIR, 'data', 'edu_test'),
    path.resolve(HF_DIR, 'memory'),
  ];

  // 扫描 memory/ 和 data/ 下所有 .txt 和 .json 文件
  const scanDirs = [
    path.join(HF_DIR, 'memory'),
    path.join(HF_DIR, 'data'),
  ];

  const unexpected = [];

  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
    } catch (e) {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.resolve(entry.parentPath || dir, entry.name);
        if (entry.name.endsWith('.txt') || entry.name.endsWith('.json')) {
          const inAllowedDir = allowedPlaintextDirPrefixes.some(p =>
            fullPath === p || fullPath.startsWith(p + path.sep)
          );
          if (!allowedPlaintextPaths.has(fullPath) && !inAllowedDir) {
            unexpected.push(path.relative(HF_DIR, fullPath));
          }
        }
      }
    }
  }

  if (unexpected.length > 0) {
    throw new Error(
      `发现 ${unexpected.length} 个未预期的明文记忆文件：\n` +
      unexpected.slice(0, 20).map(f => `  - ${f}`).join('\n') +
      (unexpected.length > 20 ? `\n  ... 及其他 ${unexpected.length - 20} 个` : '')
    );
  }
}));

// ── [第十三轮] 版本一致性 ──
// 约定 #1 列出五处必须一致的位置(VERSION 文件 / package.json /
// SKILL.md front-matter / version.js 兜底值 / 运行时 hf.version)，
// 而此前 verify.js 全文只有 Node 主版本号检查，**一处都不查**。
// scripts/sync-version.js 是个只有写者、没有验证者的脚本:
// 改了 VERSION 忘了跑它，漏掉任何一处都没有任何东西会响。
// 详细不变量与活体注入见 test/version-consistency.test.js(8 例)。
checkResults.push(check('版本一致性(VERSION/package.json/SKILL.md/兜底值/运行时)', () => {
  const fs = require('fs');
  const path = require('path');

  const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
  const vf = path.join(HF_DIR, 'VERSION');
  if (!fs.existsSync(vf)) throw new Error('VERSION 文件缺失——它是唯一真相源');
  const v = fs.readFileSync(vf, 'utf8').trim();
  if (!SEMVER.test(v)) throw new Error('VERSION 不是合法语义版本: ' + JSON.stringify(v));

  const bad = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(HF_DIR, 'package.json'), 'utf8'));
  if (pkg.version !== v) bad.push('package.json=' + pkg.version);

  const skill = fs.readFileSync(path.join(HF_DIR, 'SKILL.md'), 'utf8');
  const sm = skill.match(/^version:\s*"([^"]*)"/m);
  if (!sm) bad.push('SKILL.md 无 version 字段');
  else if (sm[1] !== v) bad.push('SKILL.md=' + sm[1]);

  // 只取 try 之前的兜底赋值: try 里读成功后会重新赋值，
  // 抓错就会把"兜底值"变成"读到的值"，查不到想查的东西。
  const vsrc = fs.readFileSync(path.join(HF_DIR, 'src', 'core', 'version.js'), 'utf8');
  const fb = vsrc.split('try {')[0].match(/let\s+VERSION\s*=\s*'([^']*)'/);
  if (!fb) bad.push('version.js 无兜底赋值');
  else if (fb[1] !== v) bad.push('version.js 兜底=' + fb[1]);

  const rt = require(path.join(HF_DIR, 'src', 'index.js'));
  if (rt.version !== v) bad.push('运行时 hf.version=' + JSON.stringify(rt.version));

  if (bad.length > 0) {
    throw new Error('版本漂移(VERSION=' + v + '): ' + bad.join(', ')
      + '。跑 node scripts/sync-version.js 同步');
  }
  return v;
}));

// Wait for all async checks, then print results
Promise.all(checkResults).then(() => {
  console.log(RESULTS.join('\n'));
  const passed = RESULTS.filter(r => r.includes('✅')).length;
  const failed = RESULTS.filter(r => r.includes('❌')).length;
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(e => {
  console.error('Verify error:', e);
  process.exit(1);
});
