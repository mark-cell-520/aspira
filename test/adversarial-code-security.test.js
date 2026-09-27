/**
 * test/adversarial-code-security.test.js — 代码安全维度的对抗鲁棒性回归
 *
 * 保护对象：CODE_SECURITY_PATTERNS 的污点判定策略。
 *
 * 为什么需要：原有模式只认 req|request|params|body|input 这五个污点名，等于要求
 * 调用方按约定命名。把变量改名成 userInput / res.data / myVar 即完全绕过——
 * 实测 12 个对抗探针漏 10 个，且漏掉时 gate.action 是 pass，不报错。
 *
 * 修复策略：改为按「参数是否为字面量」判定。字面量无害(eval("1+1")、exec("ls -la")、
 * el.innerHTML = "")，非字面量即可疑，与变量叫什么名字无关。
 *
 * 另有一条系统性问题在此锁定：text-normalizer 第 6 步会把全文统一转小写
 * (见 src/text-normalizer.js 第 521-523 行，注释称「模式库大量用 /i」)。
 * 因此任何缺少 /i 标志的模式在归一化后的文本上永远匹配不上——new Function
 * 就是这样静默失效的：正则本身正确、单独测试通过，接进 discriminate() 后不命中。
 * 本测试对源码里每条正则断言 /i 存在(无字母的模式除外)，防止再次踩坑。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
const fs = require('fs');
const path = require('path');
const { discriminate } = require('../src/index.js');

// 曾被完全绕过的探针：污点名不在白名单里，但行为完全相同
const EVASION_PROBES = [
  'const x = eval(userInput);',
  'eval(res.data);',
  'eval(myVar);',
  'const f = new Function(userInput);',
  'exec("ls " + userInput);',
  'execSync(`ls ${dir}`);',
  'el.innerHTML = userInput;',
  'document.write(userInput);',
];

// 干净样本：正常散文 + 安全代码写法，都不应命中 code_security
const CLEAN_SAMPLES = [
  '今天天气很好，我们去公园散步吧。',
  '这个方案需要进一步评估风险和收益。',
  'how do i run this function in node',
  'I need to evaluate the results carefully before deciding.',
  'The retrieval process takes about 200ms.',
  'The executive summary was clear and concise.',
  'exec("ls -la") is a common debugging command.',
  'eval("1+1") returns 2 in JavaScript.',
  'spawn("ls", ["-la"]) lists directory contents.',
  'el.innerHTML = "<p>hello</p>" renders a paragraph.',
  'new Function("return 1") creates a simple function.',
  'document.write("<p>ok</p>") writes to the document.',
  'SELECT * FROM users WHERE id = 1',
  '我们需要评估这个决策的后果。',
];

module.exports = function ({ test, assertEqual, assertTrue }) {

  test('改名污点源不再能绕过代码安全维度', () => {
    for (const probe of EVASION_PROBES) {
      const r = discriminate(probe, []);
      const d = r.dimensions && r.dimensions.code_security;
      const types = (d && d.types) || [];
      assertTrue(types.length > 0,
        `应命中 code_security: ${probe} (types=${types.join(',') || '无'})`);
    }
  });

  test('危险代码探针必须升级到 block/rewrite 门禁动作', () => {
    // 命中维度但不升级门禁等于没拦。这三类都是 critical/high 级。
    for (const probe of EVASION_PROBES) {
      const r = discriminate(probe, []);
      const act = r.gate && r.gate.action;
      assertTrue(act === 'block' || act === 'rewrite',
        `门禁未拦截: ${probe} (action=${act})`);
    }
  });

  test('干净文本不产生 code_security 误报', () => {
    // 基线误报率约 8%，新增模式不能把它推高。
    for (const s of CLEAN_SAMPLES) {
      const r = discriminate(s, []);
      const d = r.dimensions && r.dimensions.code_security;
      const types = (d && d.types) || [];
      assertEqual(types.length, 0, `误报: ${s} (types=${types.join(',')})`);
    }
  });

  test('CODE_SECURITY_PATTERNS 每条正则都带 /i 标志', () => {
    // text-normalizer 第 6 步统一转小写，缺 /i 的模式在归一化文本上永不命中，
    // 且不报错。无字母的模式(PEM 头按规范大写、../ 无字母)予以豁免。
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const start = src.indexOf('const CODE_SECURITY_PATTERNS = {');
    const end = src.indexOf('const CS_L =');
    assertTrue(start > 0 && end > start, '未定位到 CODE_SECURITY_PATTERNS');
    const block = src.slice(start, end);
    const lines = block.split('\n');
    let total = 0;
    const missing = [];
    for (const L of lines) {
      const m = L.match(/^\s*(\/.+\/)([gimsuy]*),?\s*$/);
      if (!m) continue;
      total++;
      const hasLetters = /[A-Za-z]/.test(m[1].replace(/\\[a-zA-Z]/g, ''));
      if (!m[2].includes('i') && hasLetters) missing.push(m[1].slice(0, 70));
    }
    assertTrue(total > 40, `正则数量异常: ${total}`);
    assertEqual(missing.length, 0,
      `以下正则缺 /i，经 text-normalizer 转小写后将永不命中: ${missing.join(' | ')}`);
  });

  test('动态代码执行类别已注册权重与级别', () => {
    // 新增类别若忘了在 CS_L / CS_W 登记，score 会静默按默认 0.5 计。
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    assertTrue(/dynamic_code_execution\s*:\s*'/.test(src),
      'CS_L 未登记 dynamic_code_execution 级别');
    assertTrue(/dynamic_code_execution\s*:\s*0\./.test(src),
      'CS_W 未登记 dynamic_code_execution 权重');
  });
};
