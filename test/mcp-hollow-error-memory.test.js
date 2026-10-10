/**
 * test/mcp-hollow-error-memory.test.js — 四个 error-memory 工具的**双向**锁定
 *
 * 背景(第九十九轮量到, 第一百一十/一百一十一轮定位到根因, **第一百九十二轮修好**):
 * 第九十九轮全量实调 181 个 MCP 工具时, 四个工具恒返回结构良好的错误:
 *   aspira_error_store / error_query / error_fix / error_verify
 *     → {error: 'error memory not ready'}
 * 第一百一十一轮定位到两层根因:
 *   ① heartflow 实例上 _hfCore 从来没有人赋值(start() 前后都 undefined);
 *   ② 顺着 heartflow._hfCore.errorMemory 往下找, src/core/error-memory.js 不存在。
 * 于是第一百二十一轮写下"这个能力从未被实现", 并**由本文件钉住那个现状**。
 *
 * **第一百九十二轮: 那个诊断只对了一半。** 行为普查(181 个 handler 全部真实调用)
 * 再次看到这四个工具报"能力未实现", 但顺着线索找下去发现:
 *   实现在 **src/error-memory.js**(src/ 根下, 不在 core/ 里)。
 * 它导出 12 个方法, logCorrection / querySimilar / logFix / logVerify 与四个 handler
 * 需要的一一对应, 实测全部可用。cycle 121 只在自己认定的那个路径上找不到模块,
 * 就断定"从未实现" —— 与 cycle 16 同族: **注释/诊断说"不存在", 而东西就在隔壁**
 * (那次是 self-diagnostic 的引擎表把 src/emotion 写成 src/core, 而同一行注释
 *  写着正确位置)。代价是这四个对外宣传的工具又死了十几轮。
 *
 * 修法: 四个 handler 改为直接 require src/error-memory.js, 不再走
 * `heartflow._hfCore.errorMemory` 这条从未被赋值的路径。
 * `problem` 是自由文本而 logCorrection 的 category 必须是 7 个枚举值之一,
 * 故用模块自带的 classifyError 推断。行为锁见 test/mcp-error-memory-tools.test.js。
 *
 * **本文件现在按 cycle 121 自己的指示改为"双向锁定"** —— 它原文写着:
 *   "修好这个空洞(模块真的出现)时, 这条会红, 那时请把四个工具改成返回真实内容。"
 * 所以第一条从"必须报告能力缺失"反转为"必须返回真实内容", 而根因层①②
 * 作为**仍然成立的陈述**保留(它们测的是 heartflow.js 与 src/core/ 的状态,
 * 与本轮修法无关 —— 本轮没有接线 _hfCore, 也没有建 src/core/ 那个文件)。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const path = require('path');

  const TOOLS = ['aspira_error_store', 'aspira_error_query', 'aspira_error_fix', 'aspira_error_verify'];

  test('四个工具必须返回真实内容, 不得再报"能力未实现"', () => {
    // 第一百九十二轮反转: 原断言是"error-memory 能力未实现"必须出现 4 次。
    // 实测推翻了它的前提(实现就在 src/error-memory.js), 故反转为:
    // 这句文案一次都不该出现, 而真实模块路径必须出现 4 次。
    const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
    // 第一百二十一轮实测: 源码扫描必须**先剥掉行注释**, 否则我自己写的注释
    // (说明"旧信息是 X")会被当成代码 —— 与第九十轮 source-scan 把注释读成代码同族。
    const src = raw.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    const stale = (src.match(/error memory not ready/g) || []).length;
    assertEqual(stale, 0,
      '仍有 ' + stale + ' 处 "error memory not ready" —— 那句暗示"初始化即可恢复", ' +
      '是虚假的可恢复信息。');
    const hollow = (src.match(/error-memory 能力未实现/g) || []).length;
    assertEqual(hollow, 0,
      '仍有 ' + hollow + ' 处 "error-memory 能力未实现"。实现就在 src/error-memory.js' +
      '(src/ 根下, 不在 cycle 121 找的 src/core/), 四个工具必须接到它上面。');
    const wired = (src.match(/require\(HF_DIR \+ '\/src\/error-memory\.js'\)/g) || []).length;
    assertEqual(wired, 4,
      '应有 4 处 require(HF_DIR + \'/src/error-memory.js\'), 实得 ' + wired +
      ' —— 四个 handler 必须都接到真实模块上。');
  });

  test('根因层①: _hfCore 仍不在 heartflow 的 start() 接线清单里', () => {
    // 第一百一十一轮实测: start() 新增约 180 个键, 其中没有 _hfCore。
    // 第一百九十二轮复核: 这条**仍然成立**, 且与本轮修法无关 —— 本轮没有接线
    // _hfCore, 而是让四个 handler 绕开那条从未被赋值的路径、直接 require 真实模块。
    // 它继续钉住那个测量本身: 若哪天 start() 开始接线 _hfCore, 这条会红,
    // 那时应重新评估四个 handler 是否该改走 _hfCore。
    const hfSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'heartflow.js'), 'utf8');
    assertTrue(hfSrc.indexOf('_hfCore') < 0,
      'heartflow.js 现在出现了 _hfCore。若这是有人接线了它 → 请评估四个 handler 是否' +
      '该改走 _hfCore.errorMemory; 若这是误引入 → 查是谁加的、要 assign 什么。');
  });

  test('根因层②: src/core/error-memory.js 仍不存在(修法不需要它)', () => {
    // 第一百九十二轮复核: 仍然不存在, 且**修法不要求它存在** ——
    // 真实模块在 src/error-memory.js。这条保留是为了钉住"cycle 121 的诊断错在哪":
    // 它只在自己认定的路径上找不到模块就断定"从未实现"。
    const p = path.join(__dirname, '..', 'src', 'core', 'error-memory.js');
    assertTrue(!fs.existsSync(p),
      'src/core/error-memory.js 出现了。若有人按 cycle 121 的诊断去建了这个文件 → ' +
      '请注意真实实现早在 src/error-memory.js, 先核对是否在造第二份实现。');
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
