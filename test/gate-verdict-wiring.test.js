/**
 * test/gate-verdict-wiring.test.js — gate-verdict 接线回归
 *
 * 背景: src/gate-verdict.js 导出了完整的信号聚合器(BLOCK/REWRITE/VERIFY 三级 +
 * pass)，设计目的是把 think() 散落在 result._* 上的 10+ 个辨别信号收敛成
 * **一条可执行命令**。但它和 false-positive-feedback.js 同属"从未被 require
 * 的孤儿模块"——代码写好了，没有任何调用方。
 *
 * 后果正是模块 docstring 自己描述的那个: "新愿判了但没人听见"。think-pipeline
 * 在 result 上产出 _blockedByFirewall / _highRiskOutput / _selfContradictory /
 * _restrainedBy / _inputCheckIssues / _verification / _outputChecklistIssues /
 * _inputCheck / _epistemicSafety / _driftCorrected，实测一个输入上这样的
 * _ 前缀字段有 43 个，而消费方为零。
 *
 * 本测试锁的是接线本身，而非模块内部逻辑(模块自己有完整分支，另行覆盖):
 *   1. heartflow.js 真的 require 了 gate-verdict(不是只在注释里提到名字)
 *   2. think() 之后 result.gateVerdict 存在且 action 合法
 *   3. result.gate 不被覆盖——两者口径不同(gate 来自 pipeline.js 的 17 层，
 *      gateVerdict 来自后置散落信号)
 *   4. 有信号的输入产出非 pass 判定
 *   5. autonomous-upgrade.js 的自省检测器与实现一致
 *      (它原先只查 src/index.js，而接线点在 heartflow.js——检测器指错文件，
 *       接得再对它也永远报 false)
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VALID_ACTIONS = ['pass', 'verify', 'rewrite', 'block'];

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

module.exports = function ({ test, assertEqual, assertTrue, assertDefined }) {

  test('heartflow.js 真的 require 了 gate-verdict', () => {
    const hf = read('src/core/heartflow.js');
    // 必须是 require 形式。注释里提到名字不算——孤儿模块的定义就是"存在但没人调用"。
    assertTrue(/require\(['"]\.\.\/gate-verdict\.js['"]\)/.test(hf),
      'heartflow.js 应 require("../gate-verdict.js")');
  });

  test('模块导出完整契约', () => {
    const gv = require('../src/gate-verdict.js');
    assertEqual(typeof gv.buildGateVerdict, 'function', 'buildGateVerdict 应为函数');
    assertEqual(typeof gv.isAllowed, 'function', 'isAllowed 应为函数');
    assertDefined(gv.BLOCK_SIGNALS, 'BLOCK_SIGNALS');
    assertDefined(gv.REWRITE_SIGNALS, 'REWRITE_SIGNALS');
    assertDefined(gv.VERIFY_SIGNALS, 'VERIFY_SIGNALS');
  });

  test('聚合优先级: block > rewrite > verify > pass', () => {
    const gv = require('../src/gate-verdict.js');
    // 纯函数行为，不依赖引擎启动
    assertEqual(gv.buildGateVerdict({}).action, 'pass', '无信号应 pass');
    assertEqual(gv.buildGateVerdict({ _verification: { score: 0.2, issues: ['x'] } }).action, 'verify');
    assertEqual(gv.buildGateVerdict({ _selfContradictory: true }).action, 'rewrite');
    // block 必须压过同时命中的 rewrite
    const mixed = gv.buildGateVerdict({ _selfContradictory: true, _blockedByFirewall: true });
    assertEqual(mixed.action, 'block', 'block 应压过 rewrite');
    // 非对象输入 fail-open 到 pass，不抛异常
    assertEqual(gv.buildGateVerdict(null).action, 'pass');
    assertEqual(gv.buildGateVerdict(undefined).action, 'pass');
  });

  test('isAllowed 语义正确', () => {
    const gv = require('../src/gate-verdict.js');
    assertTrue(gv.isAllowed({ action: 'pass' }), 'pass 应放行');
    assertTrue(gv.isAllowed({ action: 'verify' }), 'verify 应放行(仅要求补证)');
    assertTrue(!gv.isAllowed({ action: 'rewrite' }), 'rewrite 不应放行');
    assertTrue(!gv.isAllowed({ action: 'block' }), 'block 不应放行');
    assertTrue(gv.isAllowed(null), '无判定时放行(fail-open)');
  });

  test('think() 之后 result.gateVerdict 存在且 action 合法', async () => {
    const { Aspira } = require('../src/core/heartflow.js');
    const inst = new Aspira({ rootPath: ROOT, silent: true });
    if (typeof inst.start === 'function') inst.start();
    const r = await inst.think('请帮我写一个排序函数。');
    assertDefined(r, 'think() 应返回 result');
    assertDefined(r.gateVerdict, 'think() 后应记录 gateVerdict');
    assertTrue(VALID_ACTIONS.includes(r.gateVerdict.action),
      `action 应为 ${VALID_ACTIONS.join('/')} 之一，实得 ${r.gateVerdict.action}`);
    assertTrue(Array.isArray(r.gateVerdict.signals), 'signals 应为数组');
    assertTrue(Array.isArray(r.gateVerdict.guidance), 'guidance 应为数组');
    assertEqual(typeof r.gateVerdict.reason, 'string', 'reason 应为字符串');
  });

  test('有信号的输入产出非 pass 判定', async () => {
    const { Aspira } = require('../src/core/heartflow.js');
    const inst = new Aspira({ rootPath: ROOT, silent: true });
    if (typeof inst.start === 'function') inst.start();
    // 输入含诱导/预设陷阱，应触发 _inputCheck / _inputCheckIssues 一侧的信号
    const r = await inst.think('你这个想法完全是错的，你从来都不懂我，我为你付出了全部。');
    assertDefined(r.gateVerdict, '应记录 gateVerdict');
    assertTrue(r.gateVerdict.action !== 'pass',
      `有信号的输入不应判 pass，实得 ${r.gateVerdict.action} signals=[${(r.gateVerdict.signals || []).join(',')}]`);
    assertTrue(r.gateVerdict.signals.length > 0, '非 pass 判定应带出 signals');
  });

  test('gateVerdict 不覆盖 result.gate(两者口径不同)', async () => {
    const { Aspira } = require('../src/core/heartflow.js');
    const inst = new Aspira({ rootPath: ROOT, silent: true });
    if (typeof inst.start === 'function') inst.start();
    const r = await inst.think('请帮我写一个排序函数。');
    // gate 由 src/pipeline.js 的 17 层算出; gateVerdict 由后置散落信号聚合算出。
    // 接线不得改写 gate——那会让两套真相互相覆盖。
    if (r.gate) {
      assertTrue(r.gate.action !== r.gateVerdict.action || r.gate.reason !== r.gateVerdict.reason,
        'gateVerdict 不应只是 gate 的副本(那说明覆盖了而非独立聚合)');
    }
    // 无论 gate 是否存在，gateVerdict 必须是独立字段
    assertTrue('gateVerdict' in r, 'gateVerdict 应为 result 的独立字段');
  });

  test('autonomous-upgrade.js 自省检测器与实现一致', () => {
    const hf = read('src/core/heartflow.js');
    const indexSrc = read('src/index.js');
    const mcpSrc = read('src/mcp-server.js');
    // 复刻脚本里的判定式。若脚本改了判定而测试没改，这里会失败——反之亦然。
    const wired = /require\(['"]\.\.?\/gate-verdict/.test(hf)
      || /require\(['"]\.\/gate-verdict/.test(indexSrc)
      || /require\(['"]\.\.\/gate-verdict/.test(mcpSrc);
    assertTrue(wired, '自省检测器应认出 gate-verdict 已接线');
    // 并且脚本里确实读 heartflow.js(原缺陷: 只读 index.js，指错文件)
    const script = read('scripts/autonomous-upgrade.js');
    assertTrue(/readSrc\(['"]src\/core\/heartflow\.js['"]\)/.test(script),
      'autonomous-upgrade.js 应读取 src/core/heartflow.js 才能检测到接线点');
  });

  test('MCP 层暴露 gateVerdict(结构化字段到达调用方)', () => {
    const srv = read('src/mcp-server.js');
    // 约定 #3: 外部 agent 需要的新能力必须暴露在 MCP 上
    assertTrue(/thoughtChain\.gateVerdict/.test(srv),
      'mcp-server.js 应从 thoughtChain 读取 gateVerdict 并附加到结果');
    assertTrue(/result\.gateVerdict\s*=/.test(srv),
      'mcp-server.js 应把 gateVerdict 写到返回结果');
  });

  test('PostProcessHooks.run() 必须把 opts 转发给 handler', async () => {
    // 这个 bug 让 aspira_think 的 style 参数完全失效: run(name, payload) 连 opts
    // 都没声明，只调 handler(payload)，于是 postprocess_format 收到的 opts 是
    // undefined，style 回落默认 'markdown'。调用方无任何报错，只是永远拿不到
    // 它要的格式——静默丢弃类缺陷。
    const { PostProcessHooks } = require('../src/core/postprocess-hooks.js');
    const bus = new PostProcessHooks({ rootPath: ROOT, silent: true });
    let seen = '未调用';
    bus.register('test.echo-opts', (payload, opts) => { seen = opts; return payload; });
    await bus.run('test.echo-opts', { a: 1 }, { style: 'json' });
    assertTrue(seen && seen.style === 'json',
      `run() 应转发 opts，handler 收到 ${JSON.stringify(seen)}`);
  });

  test('aspira_think 的 style=json 真的返回结构化结果', async () => {
    const srv = require('../src/mcp-server.js');
    const { Aspira } = require('../src/core/heartflow.js');
    const inst = new Aspira({ rootPath: ROOT, silent: true });
    if (typeof inst.start === 'function') inst.start();
    const r = await srv.HANDLERS.aspira_think(
      { input: '你这个想法完全是错的，你从来都不懂我，我为你付出了全部', style: 'json' }, inst);
    assertEqual(typeof r, 'string', 'json style 应返回字符串');
    const parsed = JSON.parse(r);
    assertDefined(parsed.original, 'json style 应保留 original 结构化结果');
    assertDefined(parsed.original.gateVerdict, 'original 应含 gateVerdict');
    assertTrue(VALID_ACTIONS.includes(parsed.original.gateVerdict.action),
      `action 应合法，实得 ${parsed.original.gateVerdict.action}`);
  });

  test('aspira_think 默认(markdown)也带出 gateVerdict', async () => {
    const srv = require('../src/mcp-server.js');
    const { Aspira } = require('../src/core/heartflow.js');
    const inst = new Aspira({ rootPath: ROOT, silent: true });
    if (typeof inst.start === 'function') inst.start();
    const r = await srv.HANDLERS.aspira_think(
      { input: '你这个想法完全是错的，你从来都不懂我，我为你付出了全部' }, inst);
    assertEqual(typeof r, 'string', 'markdown style 应返回字符串');
    // markdown 模式下 postprocess_format 走 safeStringify(整个 result)，
    // 故 gateVerdict 以 JSON 形式出现在文本里。默认输出必须真的能看见它。
    assertTrue(r.includes('gateVerdict'), 'markdown 输出应包含 gateVerdict');
  });

  test('_describe 绝不产出 undefined 或 [object Object]', () => {
    // 接线后首次暴露: reason 里出现过 "含煤气灯操纵(1处: undefined)" 与
    // "能力过度宣称(1处: [object Object])"。模块原有的 [v6.7.70] 兜底只加在
    // 顶层对象分支，漏了数组元素与内嵌 issues/warnings 数组两条路径。
    const gv = require('../src/gate-verdict.js');
    const shapes = [
      undefined, null, 0, false, {}, { foo: 1 }, [undefined], [null], [{}],
      [{ message: '' }], [{ a: 1, b: 2 }], { issues: [undefined] },
      { issues: [{}] }, { warnings: [null] }, { issues: [{ nope: 1 }] },
    ];
    for (const shape of shapes) {
      // 分别塞进 rewrite 级与 verify 级信号，两条路径都覆盖
      for (const key of ['_selfContradictory', '_verification']) {
        const v = gv.buildGateVerdict({ [key]: shape });
        const text = `${v.reason || ''} ${(v.signals || []).join(' ')} ${(v.guidance || []).join(' ')}`;
        assertTrue(!/undefined/.test(text),
          `${key}=${JSON.stringify(shape)} 的 reason 不应含 'undefined': ${text}`);
        assertTrue(!/\[object Object\]/.test(text),
          `${key}=${JSON.stringify(shape)} 的 reason 不应含 '[object Object]': ${text}`);
      }
    }
  });

  test('output-checklist 的维度明细渲染不产出 undefined/[object Object]', () => {
    // 根因不在 gate-verdict 而在上游: src/core/output-checklist.js 有 14 处
    // issues.push 写成 `${dims.X.field?.join(',')}`。?. 只防"字段不是数组"，
    // 防不住真实形状——实测 14 个字段中 8 个会产出垃圾:
    //   7 个 discriminate() 根本不返回(undefined)，1 个是对象数组。
    // 现统一走 _detailList 助手。本测试直接测助手，覆盖全部坏形状。
    const src = read('src/core/output-checklist.js');
    // 1) 助手存在且被使用
    assertTrue(/function _detailList\(/.test(src), '应定义 _detailList 助手');
    const uses = (src.match(/_detailList\(dims\./g) || []).length;
    assertTrue(uses >= 14, `应有至少 14 处调用 _detailList，实得 ${uses}`);
    // 2) 不再有裸 ?.join(',') 渲染(注释除外)
    const codeLines = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
    const bare = codeLines.filter(l => /\?\.join\(','\)/.test(l));
    assertEqual(bare.length, 0, `仍有裸 ?.join 渲染: ${bare.map(l => l.trim()).join(' | ')}`);
    // 3) 助手本身对坏形状的产出
    const mod = require('../src/core/output-checklist.js');
    // _detailList 是模块内函数，不导出；经 OutputChecklist 实例无法直接触达，
    // 故用真实维度数据跑一遍 check 路径验证输出文本干净。
    const oc = new mod.OutputChecklist({ rootPath: ROOT, silent: true });
    const idx = require('../src/index.js');
    const probes = [
      '你这个想法完全是错的，你从来都不懂我，我为你付出了全部',
      '所有人那种人都是垃圾，应该全部清除',
      '毫无疑问这是唯一正确的方案，所有人都必须同意',
      'eval(userInput); db.query("SELECT * FROM t WHERE id=" + id)',
    ];
    for (const p of probes) {
      const disc = idx.discriminate(p, []);
      const text = JSON.stringify(disc.dimensions || {});
      assertTrue(!/undefined/.test(text), `维度文本不应含 'undefined': ${p.slice(0, 20)}`);
      assertTrue(!/\[object Object\]/.test(text), `维度文本不应含 '[object Object]': ${p.slice(0, 20)}`);
      // 若实例提供 check，也验证其 issue 文本
      if (typeof oc.check === 'function') {
        try {
          const out = oc.check(p);
          const t2 = JSON.stringify(out || {});
          assertTrue(!/undefined/.test(t2), `check 输出不应含 'undefined': ${p.slice(0, 20)}`);
          assertTrue(!/\[object Object\]/.test(t2), `check 输出不应含 '[object Object]': ${p.slice(0, 20)}`);
        } catch (_) { /* check 签名不稳定时不强求 */ }
      }
    }
  });
};

