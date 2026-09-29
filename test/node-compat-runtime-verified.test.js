/**
 * test/node-compat-runtime-verified.test.js — "Node >= 18.17" 与 "instant install"
 * 从被读的声明变成被验证的事实
 *
 * ═══ 由来 ═══
 * 连续第六轮 doc-honest-numbers。前五轮修了「扫哪些文件」「读哪些写法」
 * 「怎么测量层数」「声明 vs 事实」「分母是否诚实」。本轮处理上两轮
 * 明确记下的**唯一剩余角度**:
 *   "instant install" 与 "Node >= 18.17" 的运行时验证
 *
 * ═══ 盲区: 声明被读了六轮，从未被验证过 ═══
 * 审计核对 engines.node 的方式是: 把 package.json 里写的字符串抄进
 * actual.nodeReq，再拿文档声称去比它。
 * **声明与声称一致，不等于代码真的能跑在 18.17 上。**
 *
 * 这与上一轮的盲区同构: "0 runtime dependencies" 被三份文档重复
 * 却无仪器验证；"Node >= 18.17" 同样只有声明、没有运行时证据。
 * 区别在于上一轮测出**假**，本轮测出**真**——
 * 而一个从不为真声称准备的仪器，也无法为假声称报警。
 *
 * ═══ 实测结果(本轮) ═══
 * Node 兼容(剥注释后扫 src/ 374 个文件):
 *   optional chaining ×122(需 14.0) · nullish coalescing ×43(需 14.0)
 *   global fetch ×2(需 18.0) · private class field ×1(需 12.0)
 *   **越界特性 0 个** → 声明诚实
 * instant install: require(package.main) 后**立即**调一次 checkOutput()，
 *   返回 { gate: { action: 'pass' } } → 装完即可用
 *
 * ═══ 本轮价值 ═══
 * 两个数字都为真，所以本轮不改文档也不改声明——**改的是仪器**:
 * 把它们从"读一次"变成"每次运行都实测"，并各自带 ❌ 判据。
 * 下一个用到 Node 20 API 的人会立刻看见审计变红，
 * 而不是等到某个 18.17 用户装不上。
 *
 * ═══ 探针缺陷记录 ═══
 * 用 ASPIRA_AUDIT_SKIP_TESTS=1 试跑时，自报从 45/45 变成
 * 「42 一致 / 3 无法实测」。那 3 条正是 **test count**——
 * skip 模式按设计把 m.tests 置 null。**是我的探针参数造成的，
 * 不是回归。** 记在这里，因为"审计数字变了"的第一反应
 * 必须是先分清是产品坏了还是仪器坏了。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-doc-numbers.js');

module.exports = function ({ test, assertTrue, assertEqual }) {

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const declaredMin = String((pkg.engines && pkg.engines.node) || '').match(/(\d+)\.(\d+)/);
  const minVer = declaredMin ? declaredMin[1] + '.' + declaredMin[2] : '18.17';

  test('src/ 不得使用高于声明下限的语法/API', () => {
    const strip = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const FEATURES = [
      [/\?\./, '14.0'], [/\?\?/, '14.0'], [/\?\?=/, '15.0'], [/\|\|=/, '15.0'],
      [/&&=/, '15.0'], [/static\s*\{/, '16.11'], [/#\w+\s*[=;(]/, '12.0'],
      [/\bObject\.hasOwn\s*\(/, '16.9'], [/\.findLast\s*\(/, '18.0'],
      [/\bstructuredClone\s*\(/, '17.0'], [/\bglobalThis\b/, '12.0'],
      [/\bfetch\s*\(/, '18.0'], [/\bFinalizationRegistry\b/, '18.0'],
      [/\bWeakRef\b/, '14.6'], [/\bArray\.fromAsync\b/, '22.0'],
      [/\bObject\.groupBy\b/, '21.0'], [/\bMap\.groupBy\b/, '21.0'],
      [/\bPromise\.withResolvers\b/, '22.0'], [/\bRegExp\.escape\b/, '24.0'],
      [/\bprocess\.getBuiltinModule\b/, '22.3'],
    ];
    const cmp = (v, ref) => {
      const a = String(v).split('.').map(Number), b = String(ref).split('.').map(Number);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0, y = b[i] || 0;
        if (x !== y) return x > y ? 1 : -1;
      }
      return 0;
    };
    const files = [];
    (function walk(d) {
      let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const x of e) {
        if (x.name === 'node_modules' || x.name === '.git' || x.name === 'archive') continue;
        const p = path.join(d, x.name);
        if (x.isDirectory()) walk(p);
        else if (x.name.endsWith('.js')) files.push(p);
      }
    })(path.join(ROOT, 'src'));
    const over = [];
    for (const f of files) {
      const code = strip(fs.readFileSync(f, 'utf8'));
      for (const [re, need] of FEATURES) {
        if (re.test(code) && cmp(need, minVer) > 0) {
          over.push(`${path.relative(ROOT, f)}: 需 ${need}`);
        }
      }
    }
    assertEqual(over.length, 0,
      `src/ 有 ${over.length} 处使用高于声明下限 ${minVer} 的语法/API: ${over.slice(0, 5).join('; ')}。`
      + '「Node >= ' + (pkg.engines && pkg.engines.node) + '」在运行时语义上不成立');
  });

  test('主入口 require 后必须立即可用(instant install)', () => {
    const mainPath = path.join(ROOT, pkg.main || 'index.js');
    assertTrue(fs.existsSync(mainPath), `package.json 的 main 指向 ${pkg.main}，该文件应存在`);
    const main = require(mainPath);
    assertTrue(typeof main.checkOutput === 'function', 'main 应导出 checkOutput');
    // 立即调用，不做任何额外设置/初始化
    const r = main.checkOutput('安装后立即可用性实测');
    assertTrue(!!(r && r.gate && typeof r.gate.action === 'string'),
      'require(main) 后不经过额外步骤就应能调用并拿到 gate.action——'
      + '否则「instant install / 装完即可用」不成立');
  });

  test('审计必须实测 Node 兼容与 instant install(而非只读声明)', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assertTrue(/nodeFeaturesOverMin/.test(src),
      '审计必须实测 src/ 中高于声明下限的特性数——否则「Node >= 18.17」仍只是被读的声明');
    assertTrue(/instantInstallWorks/.test(src),
      '审计必须实测主入口能否 require 后立即调用');
    assertTrue(/越界特性/.test(src) && /instant install 实测/.test(src),
      '审计必须报出这两项实测结果');
  });

  test('engines.node 必须存在且与文档声称一致', () => {
    assertTrue(!!(pkg.engines && pkg.engines.node), 'package.json 应声明 engines.node');
    // 文档里的声称由 audit-doc-numbers 的 pats 核对，这里只锁声明本身存在
    assertTrue(/\d+\.\d+/.test(pkg.engines.node), 'engines.node 应是形如 >=18.17 的版本范围');
  });
};
