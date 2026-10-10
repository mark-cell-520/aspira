/**
 * Aspira — FailureCaseImporter（失败案例导入器）
 *
 * ═══ 这个文件为什么会消失，以及为什么它必须被锁住 ═══
 * `.gitignore` 里有一条无锚定规则 `benchmark/`。它匹配**任意层级**名为
 * benchmark 的目录，于是 `src/benchmark/` —— 一个源码目录 —— 被整条忽略。
 * 本文件与同目录的 benchmark-runner.js / latency-benchmark.js 因此从未进入
 * git：没有 `git status` 会显示它们，没有任何 diff 会显示它们消失，
 * 也没有任何一次 `git checkout` 能把它们找回来。它们工作过、被测试锁过、
 * 在某一轮里静默蒸发，而下游只剩三个红测试和两个永远报
 * `Cannot find module` 的 MCP 工具。
 * 根因不是"忘了写"，而是"写了但版本控制看不见"。
 *
 * ═══ 对外契约（由 test/benchmark-modules.test.js 与
 *      test/failure-importer-jsonl-contract.test.js 逐字锁定）═══
 *   - parseCases(text)            模块级导出；JSONL 与单行两条分支同口径
 *   - new FailureCaseImporter(hf) handler 解构的类名
 *   - importFromFile(path, opts)  绝不抛错，返回 report
 *
 * ═══ 第一百二十三轮修的那条：两条分支同族不同约 ═══
 * 同一个"合法 JSON 但不是用例对象"的输入（`42` / `"str"` / `null`），
 * JSONL 分支静默丢弃、单行分支报错。本模块的对外承诺是"永不抛错"，
 * 而 `report.errors` 是调用方唯一能看见"有东西没进来"的地方 ——
 * 一条分支静默、另一条报错，等于同一个用户错误一半会被告知、一半不会。
 * 现在两条分支共用同一个 `_classifyLine`，口径只存在一份。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 判断一个 JSON.parse 的结果是否真的是"用例对象"。
 * `typeof null === 'object'`，所以 null 必须显式排除；数组也不是用例对象。
 */
function _isCaseObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 对单行内容分类。返回 { kind: 'case'|'skip'|'error', value?, reason? }。
 *
 * JSONL 分支与单行分支都走这里 —— 这是本轮修"同族不同约"的方式：
 * 让口径只有一份实现，而不是在两处各自维护。
 */
function _classifyLine(rawLine) {
  const line = String(rawLine).trim();
  if (line === '') return { kind: 'skip' };
  // 注释行：JSONL 数据包里写说明是常见用法，静默跳过不算丢数据
  if (line.startsWith('//') || line.startsWith('#')) return { kind: 'skip' };

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return { kind: 'error', reason: '不是合法 JSON: ' + e.message };
  }
  if (!_isCaseObject(parsed)) {
    // 合法 JSON 但不是对象 —— 曾经的 JSONL 分支在这里静默丢弃
    return { kind: 'error', reason: '内容不是用例对象' };
  }
  return { kind: 'case', value: parsed };
}

/**
 * 解析用例文本。JSONL（含换行）与单行共用同一套分类逻辑。
 *
 * @param {string} text
 * @returns {{ cases: object[], errors: string[] }}
 */
function parseCases(text) {
  const cases = [];
  const errors = [];
  const src = text === undefined || text === null ? '' : String(text);

  if (src.indexOf('\n') >= 0) {
    // JSONL 分支：逐行分类，注释/空行跳过，坏行进 errors
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const r = _classifyLine(lines[i]);
      if (r.kind === 'case') cases.push(r.value);
      else if (r.kind === 'error') errors.push('第 ' + (i + 1) + ' 行: ' + r.reason);
    }
  } else {
    // 单行分支：整段就是一个用例。空串视为"没有输入"而非错误。
    const r = _classifyLine(src);
    if (r.kind === 'case') cases.push(r.value);
    else if (r.kind === 'error') errors.push(r.reason);
  }

  return { cases, errors };
}

/**
 * 从一条用例里取期望动作。两种字段名都认：
 *   expected_output —— MCP 工具 aspira_benchmark_run 的 description 用的名字
 *   expected        —— JSONL 数据包里更短的写法
 */
function expectedOf(c) {
  if (!c) return null;
  if (c.expected_output !== undefined) return c.expected_output;
  if (c.expected !== undefined) return c.expected;
  return null;
}

class FailureCaseImporter {
  /**
   * @param {object|null} hf 引擎实例（可为 null；RL 不可用时降级为 skipped）
   */
  constructor(hf) {
    this.hf = hf || null;
  }

  /**
   * 从文件导入失败案例。handler 无条件 await 它，所以**绝不抛错**：
   * 文件不存在、读不了、解析不出来，都变成 report 里的一个字段。
   *
   * @param {string} filePath
   * @param {{ autoRetrain?: boolean }} [opts]
   * @returns {Promise<object>} report
   */
  async importFromFile(filePath, opts) {
    const autoRetrain = !!(opts && opts.autoRetrain);
    const report = {
      filePath: filePath || null,
      status: 'ok',
      imported: 0,
      skipped: 0,
      errors: [],
      cases: [],
      retrained: false,
    };

    if (!filePath || typeof filePath !== 'string') {
      report.status = 'error';
      report.errors.push('filePath 是必填参数');
      return report;
    }

    let text;
    try {
      if (!fs.existsSync(filePath)) {
        report.status = 'error';
        report.errors.push('文件不存在: ' + filePath);
        return report;
      }
      text = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      report.status = 'error';
      report.errors.push('读取失败: ' + e.message);
      return report;
    }

    let parsed;
    try {
      parsed = parseCases(text);
    } catch (e) {
      // parseCases 自己不抛错，这里是双保险
      report.status = 'error';
      report.errors.push('解析失败: ' + e.message);
      return report;
    }

    report.cases = parsed.cases;
    report.errors = parsed.errors;
    report.imported = parsed.cases.length;
    report.skipped = parsed.errors.length;
    if (parsed.errors.length > 0) report.status = 'partial';

    if (autoRetrain) {
      report.retrained = await this._pushToRL(parsed.cases);
    }
    return report;
  }

  /**
   * 把案例推入自愈 RL。引擎没接或 RL 不可用时返回 false，不抛错 ——
   * 导入的主职责是"把案例读进来"，推 RL 是附加动作，附加动作失败
   * 不该让主职责的返回值变成异常。
   */
  async _pushToRL(cases) {
    if (!this.hf || !Array.isArray(cases) || cases.length === 0) return false;
    try {
      // 自愈 RL 挂在 heartflow 的 _hfCore 上；历史上这条路径从未被赋值，
      // 所以这里逐层探测，任何一层缺失都安静返回 false。
      const rl = this.hf.selfHealingRL
        || (this.hf._hfCore && this.hf._hfCore.selfHealingRL)
        || null;
      if (!rl || typeof rl.recordOutcome !== 'function') return false;
      for (const c of cases) {
        if (rl.recordOutcome.length >= 2) {
          await rl.recordOutcome('benchmark-failure', c);
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = { FailureCaseImporter, parseCases, expectedOf };
