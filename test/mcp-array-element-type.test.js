/**
 * test/mcp-array-element-type.test.js — 数组元素类型未校验时，调用方收到 JS 内部错误消息
 *
 * [mcp-tool-enhancement·第一百六十八轮] 新建。
 *
 * 第一百五十七轮修的是"缺必填参数时 18 个工具 throw、逃逸成协议层 -32603"。
 * 本轮把参数错误的面再扩一格: **数组元素的类型**。
 *
 * ═══ 形状 ═══
 * 中央 dispatch 的参数清洗只校验**顶层**参数类型:
 *
 *     if ((v.type === 'string' || v.type === 'number') && typeof args[k] !== v.type) { … }
 *
 * 数组参数声明为 `{type:'array'}`，于是 `args.texts` 本身通过了校验 —— 但它的
 * **元素**是什么，dispatch 不看。handler 里按"元素是字符串/对象"直接取字段，
 * 元素类型不对就抛 TypeError，再被自己的 `catch (e) { return { error: e.message } }`
 * 接住 —— 于是调用方收到的是 **JS 内部错误消息**:
 *
 *     aspira_bulk_discriminate  texts=[1,2]  → 'text.substring is not a function'
 *     aspira_bulk_discriminate  texts=[null] → "Cannot read properties of null (reading 'substring')"
 *     aspira_decision_decide    options=[null] → "Cannot read properties of null (reading 'label')"
 *     aspira_supervise_dao      history=[1]   → 'h.includes is not a function'
 *
 * 这与 cycle 17 修掉的 aspira_check_outbound(raw TypeError)是同一族: 调用成功、
 * 不抛错、结构合法、**内容是对调用方无意义的内幕**。一个 agent 收到
 * "text.substring is not a function" 无法据此修正自己的调用。
 *
 * ═══ 修法 ═══
 * 三个 handler 的入口各加一道元素类型校验，报出下标/字段名(与既有的
 * 'texts[] array required' 同风格)。三处是同一形状的实例，一起修 ——
 * 部分修复会留下同族缺陷。
 *
 * ═══ 实测 ═══
 *   系统性扫描(每个 array 参数 × 4 种错误载荷，共 112 个组合):
 *     修复前 3 个 handler 泄露原始 JS 错误消息 → 修复后 **0 个**
 *   合法输入全部不回归(bulk 正常返回 results、decide 正常返回 decision、
 *   dao 正常返回 verdict)
 *
 * 遵循 aspira 约定 #4: 位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const fs = require('fs');
  const { HANDLERS, TOOLS } = require(path.join(ROOT, 'src', 'mcp-server.js'));

  // JS 内部错误消息的形态(不是给人看的)
  const RAW = /is not a function|Cannot read propert|is not iterable|Spread syntax|reading '|of null|of undefined|Maximum call stack/i;

  function propsOf(t) { return ((t.inputSchema || t.input_schema || {}).properties) || {}; }

  // ── 一、三个修复点: 错误元素类型必须返回友好消息 ────────
  test('bulk_discriminate / decision_decide / supervise_dao 对错误元素类型必须返回友好消息', async () => {
    const CASES = [
      ['aspira_bulk_discriminate', { texts: [1, 2] }, 'texts[0] must be a string'],
      ['aspira_bulk_discriminate', { texts: [{}] }, 'texts[0] must be a string'],
      ['aspira_bulk_discriminate', { texts: [null] }, 'texts[0] must be a string'],
      ['aspira_bulk_discriminate', { texts: ['ok', 123] }, 'texts[1] must be a string'],
      ['aspira_bulk_discriminate', { texts: 'abc' }, 'texts[] array required'],
      ['aspira_bulk_discriminate', { texts: [] }, 'texts[] array required'],
      ['aspira_decision_decide', { task: 't', options: [null] }, 'options[] must be an array of objects with a label field'],
      ['aspira_decision_decide', { task: 't', options: [1] }, 'options[] must be an array of objects with a label field'],
      ['aspira_supervise_dao', { text: 't', history: [1] }, 'history[] must be an array of strings'],
      ['aspira_supervise_dao', { text: 't', history: [{}] }, 'history[] must be an array of strings'],
      ['aspira_supervise_dao', { text: 't', history: [null] }, 'history[] must be an array of strings'],
    ];
    const bad = [];
    for (const [name, args, want] of CASES) {
      let r;
      try { r = await HANDLERS[name](args, 'probe'); }
      catch (e) { bad.push(`${name} 抛错: ${e.message.slice(0, 50)}`); continue; }
      if (r && typeof r.then === 'function') { try { r = await r; } catch (_) { continue; } }
      const got = (r && typeof r.error === 'string') ? r.error : '(无 error)';
      if (got !== want) bad.push(`${name} ${JSON.stringify(args).slice(0, 30)} → ${got}(期望 ${want})`);
      if (RAW.test(got)) bad.push(`${name} 泄露原始 JS 错误消息: ${got}`);
    }
    assertEqual(bad.join('\n'), '', '以下调用的返回不符:\n' + bad.join('\n'));
  });

  // ── 二、合法输入必须不回归 ──────────────────────────────
  test('三个工具的合法输入必须仍然正常工作', async () => {
    const bd = await HANDLERS['aspira_bulk_discriminate']({ texts: ['hello world'] }, 'probe');
    assertTrue(bd && Array.isArray(bd.results) && bd.results.length === 1,
      `bulk_discriminate 合法输入应返回 results, 实测 ${JSON.stringify(bd).slice(0, 60)}`);
    // 注意字段: decide() 读的是 consequence_value / feasibility 这类显式数值,
    // 不是 score(传 score 会走文本推断 → 平局 → chosen=null, 那是判别器
    // 正确的'拒绝任意挑选', 不是缺陷)。
    const dd = await HANDLERS['aspira_decision_decide'](
      { task: '选一个', options: [{ label: '甲', consequence_value: 0.9 }, { label: '乙', consequence_value: 0.4 }] }, 'probe');
    assertTrue(dd && dd.decision && dd.decision.label === '甲',
      `decision_decide 合法输入应选出甲, 实测 ${JSON.stringify(dd).slice(0, 80)}`);
    const sd = await HANDLERS['aspira_supervise_dao']({ text: '正常输入', history: ['第一步', '第二步'] }, 'probe');
    assertTrue(sd && typeof sd.verdict === 'string',
      `supervise_dao 合法输入应返回 verdict, 实测 ${JSON.stringify(sd).slice(0, 80)}`);
  });

  // ── 三、系统性扫描: 任何 array 参数都不得泄露原始错误消息 ─
  test('系统性扫描: 所有 array 参数在错误元素类型下都不得泄露原始 JS 错误消息', async () => {
    const PAYLOADS = [['数字元素', [123]], ['对象元素', [{}]], ['null元素', [null]], ['嵌套null', [[null]]]];
    const leaks = [];
    for (const t of TOOLS) {
      const props = propsOf(t);
      const arrKeys = Object.keys(props).filter(k => props[k] && props[k].type === 'array');
      if (!arrKeys.length) continue;
      const h = HANDLERS[t.name];
      if (!h) continue;
      for (const ak of arrKeys) {
        for (const [label, payload] of PAYLOADS) {
          const args = {};
          for (const k of Object.keys(props)) {
            if (k === ak) { args[k] = payload; continue; }
            if (props[k].type === 'string') args[k] = 'probe';
            else if (props[k].type === 'number') args[k] = 1;
            else if (props[k].type === 'array') args[k] = ['probe'];
            else if (props[k].type === 'boolean') args[k] = true;
            else if (props[k].type === 'object') args[k] = {};
            else args[k] = 'probe';
          }
          let r;
          try { r = await h(args, 'probe'); }
          catch (e) { if (RAW.test(e.message || '')) leaks.push(`${t.name}.${ak}[${label}] throw: ${e.message.slice(0, 50)}`); continue; }
          if (r && typeof r.then === 'function') { try { r = await r; } catch (_) { continue; } }
          if (r && typeof r === 'object' && typeof r.error === 'string' && RAW.test(r.error)) {
            leaks.push(`${t.name}.${ak}[${label}] error: ${r.error.slice(0, 50)}`);
          }
        }
      }
    }
    assertEqual(leaks.join('\n'), '',
      `以下 array 参数在错误元素类型下泄露原始 JS 错误消息(共 ${leaks.length} 个):\n${leaks.join('\n')}`);
  });

  // ── 四、源级: 三个 handler 都必须有元素类型校验 ─────────
  test('源级: 三个 handler 必须包含元素类型校验', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
    assertTrue(/texts\[\$\{badIdx\}\] must be a string/.test(src),
      'handleBulkDiscriminate 必须有 texts 元素类型校验');
    assertTrue(/options\[\] must be an array of objects/.test(src),
      'aspira_decision_decide 必须有 options 元素类型校验');
    assertTrue(/history\[\] must be an array of strings/.test(src),
      'aspira_supervise_dao 必须有 history 元素类型校验');
  });
};
