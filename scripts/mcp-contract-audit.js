#!/usr/bin/env node
/**
 * scripts/mcp-contract-audit.js — 核对每个 aspira_* 工具的调用约定
 *
 * ═══ 这个脚本为什么存在 ═══
 * AGENTS.md 记着三例同形状缺陷，都是「MCP 处理器和模块对调用约定各说各话」:
 *   1. aspira_gate / aspira_gate_check / aspira_gate_pipeline 调 gate.gate/check/pipeline，
 *      而这三个只跑 discriminate()，整条 17 层管线是 runPipeline
 *      → 整个混淆类对 MCP 工具面不可见。
 *   2. aspira_wakeup_verify 声明 inputSchema: { properties: {} }(无参数)，
 *      却要 evaluateDream(dreamResult)，处理器却调私有 _loadHistory()
 *      → 名叫 verify 的工具什么都没验证。
 *   3. aspira_experience_replay 传 `new ExperienceReplay({rootPath, silent})`(对象)，
 *      而构造函数只接受字符串 → 每次调用都抛 Invalid projectRoot，
 *      **该工具完全不可用**(端到端实测确认)。
 *
 * 三例的共同点: 单元测试全绿，只有**端到端调用**能看见。
 * 本脚本静态核对「处理器怎么写 new X(...)」与「X 的构造函数签名」，
 * 在调用前就发现约定不一致。
 *
 * ═══ 方法与盲区 ═══
 * 对每个 `new SomeClass(...)` 调用点:
 *   · 解析出实参个数与形态(字面对象 / 字符串 / 无参)
 *   · 找到该类定义，解析形参
 *   · 实参数 > 形参数 → 多传了(可能被忽略，也可能正是缺陷)
 *   · 实参是对象字面量而形参名暗示标量(rootPath/silent 这类选项名) → 约定可疑
 *
 * **盲区一: 只认 `new X(...)` 形态。** 处理器若写 `X.create(...)` 或
 * 从缓存取实例，本脚本看不见。
 * **盲区二: 形参解析靠正则**，解构形参 `constructor({a, b})` 与
 * 默认参数 `constructor(opts = {})` 都按"单个 options 对象"处理，
 * 无法判断对象里该有哪些键。
 * **盲区三: 多传一个实参不一定是缺陷**(JS 允许多传，被忽略)。
 *   所以输出是「待查清单」，每个命中都要人工确认。
 *
 * ═══ 已记录的教训 ═══
 * dead-counter-audit 与 dimension-health-audit 都因为"把自己的局限说成引擎缺陷"
 * 而错过多轮。本脚本因此只报「约定不匹配」这一种可判定的形态，
 * 并在头部写清三个盲区。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MCP = path.join(ROOT, 'src', 'mcp-server.js');
const SRC = path.join(ROOT, 'src');

const mcpSrc = fs.readFileSync(MCP, 'utf8');
const mcpLines = mcpSrc.split('\n');

// ─── 1. 收集所有 new X(...) 调用点(带行号与实参文本) ────────────────────
// 内置类不在 src/ 里定义，本脚本核对不了，直接排除。
// 首版没排除，于是 new Map()/new Error(...)/new Date() 全被报成
// 「找不到类定义」——32 处命中里绝大多数是这种。仪器缺陷。
const BUILTIN = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError',
  'Date', 'Promise', 'RegExp', 'Array', 'Object', 'Number', 'String', 'Boolean', 'Symbol',
  'Buffer', 'URL', 'URLSearchParams', 'AbortController', 'TextEncoder', 'TextDecoder']);
// 只匹配真正的构造调用。两个约束:
//   ① 参数里不含括号 `[^;()]*` —— 否则 `new ToneAnalyzer().analyze(input, {})`
//      的惰性匹配会跨越到方法调用，把方法实参当成构造实参(首版正是如此)
//   ② new X(...) 后面不能紧跟 .method(
const callRe = /new\s+([A-Z][A-Za-z0-9_]*)\s*\(([^;()]*)\)(?!\s*\.)/g;
const calls = [];
for (let i = 0; i < mcpLines.length; i++) {
  const l = mcpLines[i];
  if (/^\s*\/\//.test(l)) continue;
  if (BUILTIN.has((l.match(/new\s+([A-Z][A-Za-z0-9_]*)/) || [])[1])) continue;
  let m;
  callRe.lastIndex = 0;
  while ((m = callRe.exec(l))) {
    if (BUILTIN.has(m[1])) continue;
    // 向上找最近的 require(...)，用它定位真正的模块。
    // 为什么需要: `DreamEngine` 在 src/dream/engine.js(签名 (memory, opts))
    // 和 src/dream/dream-engine.js(签名 (options)) **都**有声明，
    // 按遍历顺序取第一个会取错，把正确的调用报成缺陷。
    // require 路径才是权威来源。字面量与变量赋值都要能跟。
    let requirePath = null;
    for (let k = i; k >= 0 && k >= i - 20; k--) {
      const rm = mcpLines[k].match(/require\(\s*([^)'"]+)\s*\)/);
      if (!rm) continue;
      const arg = rm[1].trim();
      if (arg.startsWith("'") || arg.startsWith('"')) {
        requirePath = arg.slice(1, -1);
      } else {
        // require(变量) —— 再往上找 `const 变量 = '字面量'` 或 path.join(...)
        for (let j = k; j >= 0 && j >= k - 12; j--) {
          const am = mcpLines[j].match(new RegExp(`(?:const|let|var)\\s+${arg}\\s*=\\s*(.+)`));
          if (!am) continue;
          // 先找 .js 段: `path.join(HF_DIR, 'src', 'dream', 'engine.js')` 里
          // 第一个引号串是 'src'，直接取会得到错误的 'src'(首版正是如此)。
          const parts = [...am[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
          const jsPart = parts.find(p => p.endsWith('.js'));
          if (jsPart) {
            requirePath = jsPart;
          } else {
            const lit = am[1].match(/['"]([^'"]+)['"]/);
            if (lit) requirePath = lit[1];
          }
          break;
        }
      }
      if (requirePath) break;
    }
    calls.push({
      cls: m[1],
      argsText: m[2],
      line: i + 1,
      requirePath,
      snippet: l.trim().slice(0, 120),
    });
  }
}

// ─── 2. 为每个类找构造函数形参 ─────────────────────────────────────────
// 先全库收集真正的 `class X {` 声明，再回退到赋值形态。
// 首版的 findClassFile 用 `class X` 或 `X =` 二选一，而 `X =` 太松:
// src/shield/wake-up-verifier.js 里有 `DecisionVerifier = require(...)`，
// 它先被遍历到，于是真正的类(src/core/decision-verifier.js)被错过，
// 报出假的「未找到构造函数」。仪器缺陷。
function findClassDeclarations() {
  const decls = new Map();   // cls -> file
  const assigns = new Map();
  const stack = [SRC];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/class\s+([A-Z][A-Za-z0-9_]*)\b/g)) {
        if (!decls.has(m[1])) decls.set(m[1], p);
      }
      for (const m of s.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*=\s*(?:require|function|class)\b/g)) {
        if (!assigns.has(m[1])) assigns.set(m[1], p);
      }
    }
  }
  return { decls, assigns };
}
const { decls: CLASS_DECLS, assigns: CLASS_ASSIGNS } = findClassDeclarations();
/**
 * 定位类定义文件。优先用调用点上方的 require 字面量路径——
 * 同名类可能在多个文件里声明(DreamEngine 就是)，require 路径才是权威。
 */
function findClassFile(cls, requirePath) {
  if (requirePath) {
    // require('./x.js') 相对 src/；require('/abs/...') 可能是绝对路径
    const candidates = [];
    if (path.isAbsolute(requirePath)) candidates.push(requirePath);
    candidates.push(path.join(SRC, requirePath));
    candidates.push(path.join(ROOT, requirePath));
    for (const c of candidates) {
      try {
        if (!fs.existsSync(c)) continue;
        const s = fs.readFileSync(c, 'utf8');
        if (new RegExp(`class\\s+${cls}\\b`).test(s)) return c;
      } catch (e) { /* 继续下一个候选 */ }
    }
    // 直接拼不出来(如 'engine.js' 实际在 src/dream/ 下)，按文件名全库找，
    // 但**只在文件里确实声明了该类**时才采用。
    const base = path.basename(requirePath);
    const stack = [SRC];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        if (e.name !== base) continue;
        const s = fs.readFileSync(p, 'utf8');
        if (new RegExp(`class\\s+${cls}\\b`).test(s)) return p;
      }
    }
  }
  return CLASS_DECLS.get(cls) || CLASS_ASSIGNS.get(cls) || null;
}

function ctorParams(file, cls) {
  const s = fs.readFileSync(file, 'utf8');
  // 找 class X { ... constructor(...) 的第一个 constructor
  const classIdx = s.search(new RegExp(`class\\s+${cls}\\b`));
  if (classIdx < 0) return null;
  const rest = s.slice(classIdx);
  const cm = rest.match(/constructor\s*\(([^)]*)\)/);
  if (!cm) return null;
  const raw = cm[1].trim();
  // 无参构造必须返回带 form 的对象。首版这里 `return []`，
  // 于是 params.form 为 undefined、params.names 为 undefined，
  // 判定分支一进 else 就 `Cannot read properties of undefined`。
  // 仪器自己崩了，又轮到"先修仪器再看结果"。
  if (!raw) return { form: 'none', names: [], keys: [], raw, body: '' };

  // 取出构造函数体，用来判断形参被当成标量还是对象
  const ctorStart = classIdx + cm.index + cm[0].length;
  const after = s.slice(ctorStart);
  const openRel = after.indexOf('{');
  let body = '';
  if (openRel >= 0) {
    let depth = 0, i = openRel;
    for (; i < after.length; i++) {
      if (after[i] === '{') depth++;
      else if (after[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    body = after.slice(openRel, i);
  }

  // 解构对象形参: { rootPath, silent } 或 opts = {}
  const objMatch = raw.match(/^\{\s*([^}]*)\}/);
  if (objMatch) {
    const keys = objMatch[1].split(',').map(x => x.split('=')[0].trim()).filter(Boolean);
    return { form: 'object', keys, raw, body };
  }
  return { form: 'positional', names: raw.split(',').map(x => x.split('=')[0].trim()).filter(Boolean), raw, body };
}

/**
 * 判断构造体把形参当标量还是当对象。
 *
 * ═══ 为什么需要这个 ═══
 * 首版只按"形参是不是对象解构"分类，于是把 options 对象传给
 * `constructor(options)` 也报成"形参要标量却传对象"——143 个调用点里
 * 报了 94 处，几乎全是正常用法。**这是仪器把自己的局限说成缺陷的第四次。**
 *
 * experience_replay 那个真缺陷的形状不是"传了对象"，而是
 * **构造体把这个形参当字符串用**: `typeof projectRoot !== 'string'`。
 * 所以判定必须看函数体:
 *   · 出现 `typeof X === 'string'` / `!== 'string'` → 期望标量
 *   · 出现 `X.foo` / `X?.foo` / `const {a} = X` → 期望对象
 */
function paramExpectation(name, body) {
  if (!name || !body) return 'unknown';
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`typeof\\s+${esc}\\s*[=!]==?\\s*['"](?:string|number|boolean)['"]`).test(body)) return 'scalar';
  if (new RegExp(`typeof\\s+${esc}\\s*[=!]==?\\s*['"]object['"]`).test(body)) return 'object';
  if (new RegExp(`${esc}\\s*&&\\s*typeof\\s+${esc}\\s*[=!]==?\\s*['"](?:string|number)['"]`).test(body)) return 'scalar';
  if (new RegExp(`${esc}\\s*\\|\\|\\s*typeof\\s+${esc}\\s*[=!]==?\\s*['"](?:string|number)['"]`).test(body)) return 'scalar';
  if (new RegExp(`${esc}\\??\\.[A-Za-z_$]`).test(body)) return 'object';
  if (new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\}\\s*=\\s*${esc}\\b`).test(body)) return 'object';
  if (new RegExp(`${esc}\\s*\\[`).test(body)) return 'object';
  return 'unknown';
}

// ─── 3. 判定 ───────────────────────────────────────────────────────────
const findings = [];
for (const c of calls) {
  const file = findClassFile(c.cls, c.requirePath);
  if (!file) {
    findings.push({ ...c, kind: 'class-not-found', detail: `找不到类 ${c.cls} 的定义` });
    continue;
  }
  const params = ctorParams(file, c.cls);
  if (!params) {
    // 没有显式构造函数 = 用 JS 默认构造，接受任意实参，**没有契约可违反**。
    // 首版把这报成「未找到构造函数」，是仪器缺陷。
    continue;
  }
  const argsText = c.argsText.trim();

  // 实参形态
  const argIsObject = /^\{/.test(argsText);
  const argCount = argsText === '' ? 0 : argsText.split(',').length;

  if (params.form === 'object') {
    // 形参是 options 对象。实参也应是对象。
    if (!argIsObject && argCount > 0) {
      findings.push({
        ...c, kind: 'positional-into-object',
        detail: `构造函数形参是 options 对象 {${params.keys.join(', ')}}，实参却是位置参数: ${argsText}`,
      });
    } else if (argIsObject) {
      // 实参对象的键 vs 形参保留的键 —— 只提示形参完全没用到选项的形态
      const usedKeys = params.keys.filter(k => new RegExp(`\\b${k}\\b`).test(
        fs.readFileSync(file, 'utf8')));
      const passedKeys = (argsText.match(/([A-Za-z_$][\w$]*)\s*:/g) || [])
        .map(x => x.replace(/\s*:$/, ''));
      const ignored = passedKeys.filter(k => !usedKeys.includes(k));
      if (ignored.length > 0) {
        findings.push({
          ...c, kind: 'ignored-option',
          detail: `传入的选项 {${ignored.join(', ')}} 在构造函数里未被读取(形参声明 {${params.keys.join(', ')}})`,
        });
      }
    }
  } else {
    // 形参是位置参数。**只有构造体把它当标量用时，传对象才是缺陷。**
    // 首版在这里无条件报"形参要标量却传对象"，把 94 处正常的
    // `new X({silent:true})` 全算成缺陷 —— 仪器缺陷，不是代码缺陷。
    if (argIsObject) {
      const exp = paramExpectation(params.names[0], params.body);
      if (exp === 'scalar') {
        findings.push({
          ...c, kind: 'object-into-scalar',
          detail: `构造体把形参 ${params.names[0]} 当标量用(typeof 判断)，实参却是对象字面量: ${argsText}`,
        });
      }
      // exp === 'object' 或 'unknown' → 正常用法，不报
    } else if (argCount > params.names.length) {
      findings.push({
        ...c, kind: 'too-many-args',
        detail: `实参 ${argCount} 个 > 形参 ${params.names.length} 个 (${params.names.join(', ')})`,
      });
    }
  }
}

console.log('\n=== MCP 调用约定核对 ===\n');
console.log(`  mcp-server.js 中 new X(...) 调用点: ${calls.length} 个\n`);

const byKind = {};
for (const f of findings) {
  (byKind[f.kind] = byKind[f.kind] || []).push(f);
}

const ORDER = ['object-into-positional', 'positional-into-object', 'ignored-option', 'too-many-args', 'class-not-found', 'no-ctor'];
const LABEL = {
  'object-into-scalar': '构造体当标量用却传对象 ← experience_replay 缺陷的形状',
  'positional-into-object': '形参要对象却传标量',
  'ignored-option': '传了构造函数不读的选项',
  'too-many-args': '实参多于形参',
  'class-not-found': '找不到类定义',
};

let total = 0;
for (const k of ORDER) {
  const list = byKind[k];
  if (!list || !list.length) continue;
  console.log(`  ── ${LABEL[k] || k} (${list.length}) ──`);
  for (const f of list) {
    console.log(`    src/mcp-server.js:${f.line}  new ${f.cls}(${f.argsText})`);
    console.log(`        ${f.detail}`);
  }
  total += list.length;
  console.log('');
}

if (total === 0) {
  console.log('  ✓ 未发现约定不匹配\n');
} else {
  console.log(`  合计 ${total} 处待查(非缺陷清单，需人工确认)\n`);
}

console.log('  盲区: ① 只认 new X(...) 形态，X.create() 或缓存实例看不见');
console.log('        ② 形参解析靠正则，无法判断对象里该有哪些键');
console.log('        ③ 多传实参在 JS 里合法(被忽略)，不一定是缺陷');
console.log('        → 每个命中都要先复现再下结论。\n');

module.exports = { findings, calls };
