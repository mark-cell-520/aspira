/**
 * test/mcp-hollow-error-memory.test.js — 四个 error-memory 工具的空洞状态锁定
 *
 * 背景(第九十九轮量到, 第一百一十/一百一十一轮定位到根):
 * 第九十九轮全量实调 181 个 MCP 工具时, 四个工具恒返回结构良好的错误:
 *   aspira_error_store / error_query / error_fix / error_verify
 *     → {error: 'error memory not ready'}
 * 中间隔了一轮错修(第一百一十轮照搬 cycle-29 的 start() 修法, 零效果, 已撤回)。
 * 第一百一十一轮量到根因, 两层:
 *   ① heartflow 实例上 **_hfCore 从来没有人赋值** —— start() 前后都 undefined,
 *      新增的约 180 个键里也没有它。cycle-29 的 start() 修法对它无效。
 *   ② 顺着 heartflow._hfCore.errorMemory.store(...) 往下找,
 *      **src/core/error-memory.js 不存在** —— require 直接 MODULE_NOT_FOUND。
 *
 * 所以这四个工具不是"字段没接线", 是**它们要调用的模块不存在**,
 * 结构上永远不可能工作。同一个家族: 调用成功、不抛错、响应结构良好, 而内容是死的。
 *
 * **本文件钉住这个现状。** 与 test/evasion-known-gaps.test.js 同族 —— 现状被钉住,
 * 修好会红, 失败信息直接写下一步。这是"一个只存在于 journal 里的缺陷没有信号"的解法。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=mount 函数导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');

  const TOOLS = ['aspira_error_store', 'aspira_error_query', 'aspira_error_fix', 'aspira_error_verify'];

  test('四个工具必须如实报告能力缺失(不是可恢复的"未就绪")', () => {
    // 第一百二十一轮: 旧信息 'error memory not ready' 暗示"初始化即可恢复",
    // 而真相是 _hfCore 与 src/core/error-memory.js 都不存在 —— 从未实现。
    // 修好这个空洞(模块真的出现)时, 这条会红, 那时请把四个工具改成返回真实内容。
    const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
    // 第一百二十一轮实测: 源码扫描必须**先剥掉行注释**, 否则我自己写的注释
    // (说明"旧信息是 X")会被当成代码 —— 与第九十轮 source-scan 把注释读成代码同族。
    const src = raw.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    const n = (src.match(/error memory not ready/g) || []).length;
    assertEqual(n, 0,
      '仍有 ' + n + ' 处 "error memory not ready"。**若已实现 error memory 模块** → ' +
      '请把四个工具改成返回真实内容并删掉本章注释; **若这是回归** → 谁把虚假的' +
      '"可恢复"信息改回来了。');
    const honest = (src.match(/error-memory 能力未实现/g) || []).length;
    assertEqual(honest, 4,
      '属实说明的守卫数应为 4(每个工具一处), 实得 ' + honest);
  });

  test('根因层①: _hfCore 不在 heartflow 的 start() 接线清单里', () => {
    // 第一百一十一轮实测: start() 新增约 180 个键, 其中没有 _hfCore。
    // 这条钉住那个测量本身 —— 若哪天 start() 开始接线 _hfCore, 这条会红,
    // 那正是修好这个空洞的第一步。
    const hfSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'heartflow.js'), 'utf8');
    assertTrue(hfSrc.indexOf('_hfCore') < 0,
      'heartflow.js 现在出现了 _hfCore。**若这是修好了这个空洞** → 请把本文件从' +
      '"钉现状"改成"双向锁定"。**若这是误引入** → 查是谁加的、要 assign 什么。');
  });

  test('根因层②: src/core/error-memory.js 当前不存在', () => {
    const p = path.join(__dirname, '..', 'src', 'core', 'error-memory.js');
    assertTrue(!fs.existsSync(p),
      'src/core/error-memory.js 出现了。**若已实现 error memory 模块** → 请把本文件' +
      '"钉现状"改成"双向锁定", 并核对四个工具的调用点是否指向正确的字段路径。');
  });

  test('反向控制: 四个工具的处理器映射必须存在(不能假装修好了)', () => {
    // 修好这个空洞的唯一正当做法是让它们真的能工作,
    // 不是把处理器删掉让 tools/list 少四个。
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
    for (const t of TOOLS) {
      const short = t.replace(/^aspira_/, '');                                   // error_store
      const camel = 'handle' + short
        .replace(/_([a-z])/g, (m, c) => c.toUpperCase())
        .replace(/^[a-z]/, c => c.toUpperCase());   // 首字母也要大写: errorStore → ErrorStore
      assertTrue(src.indexOf(camel) >= 0,
        t + ' 的处理器 ' + camel + ' 在 mcp-server.js 里找不到。' +
        '修好空洞的做法是让工具工作, 不是把它删掉。');
    }
  });
};
