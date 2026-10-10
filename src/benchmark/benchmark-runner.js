/**
 * Aspira — BenchmarkRunner（基准数据包运行器）
 *
 * ═══ 这个文件为什么会消失 ═══
 * 与同目录的 failure-importer.js 同一根因：`.gitignore` 的无锚定规则
 * `benchmark/` 把 `src/benchmark/` 整个源码目录忽略了，于是本文件从未进入
 * git，在某轮里静默蒸发。下游症状是两个 MCP 工具永远报
 * `Cannot find module '.../src/benchmark/benchmark-runner.js'`。
 * 详见 failure-importer.js 头部的记录。
 *
 * ═══ 对外契约（由 test/benchmark-modules.test.js 逐字锁定）═══
 *   - new BenchmarkRunner(hf|null)
 *   - runner.packs                    loadDirectory 后为 { packName: cases[] }
 *   - loadDirectory(dir)              读目录下 .jsonl，键为去掉扩展名的文件名
 *   - runAll({threshold,pushFailures}) → {total, correct, accuracy, pass, failureCount}
 *   - flushFailuresToRL()             绝不抛错；无 RL 时 {status:'skipped'}
 *
 * ═══ 为什么用 gate.checkOutput() 而不是 hf.think() ═══
 * 实测 new Aspira({rootPath}).think(x) 对任意输入都返回 {}（空对象）——
 * hi / 长英文句 / 中文句三种形态均如此，不能作判别入口。
 * checkOutput() 的 gate.action 与数据包的 expected_output 同一命名空间
 * （pass/rewrite/block/verify），所以"算得准"这件事是可检验的：
 * 测试用一组期望与实测动作相反的包，断言 accuracy 必须为 0。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** runAll 的默认阈值。测试 runAll({}) 时依赖这个默认值。 */
const DEFAULT_THRESHOLD = 0.5;

class BenchmarkRunner {
  /**
   * @param {object|null} hf 引擎实例。可为 null —— 判别走 gate.js，
   *   RL 不可用时降级，所以 runner 不依赖引擎就能工作。
   */
  constructor(hf) {
    this.hf = hf || null;
    /** @type {Record<string, object[]>} */
    this.packs = {};
    /** 最近一次 runAll 的失败明细，flushFailuresToRL 消费 */
    this.failures = [];
  }

  /**
   * 加载目录下所有 .jsonl 数据包。键为去掉扩展名的文件名。
   * 目录不存在或读不了时不抛错，packs 保持原样 —— handler 已经先用
   * existsSync 探过，这里再兜底一次。
   *
   * @param {string} dir
   * @returns {Record<string, object[]>} this.packs
   */
  loadDirectory(dir) {
    if (!dir || typeof dir !== 'string') return this.packs;
    let entries;
    try {
      if (!fs.existsSync(dir)) return this.packs;
      entries = fs.readdirSync(dir);
    } catch (e) {
      return this.packs;
    }

    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      try {
        if (!fs.statSync(full).isFile()) continue;
      } catch (e) {
        continue;
      }
      const packName = name.slice(0, -'.jsonl'.length);
      try {
        // parseCases 与 importer 共用，口径只有一份
        const { parseCases } = require('./failure-importer.js');
        const { cases } = parseCases(fs.readFileSync(full, 'utf8'));
        this.packs[packName] = cases;
      } catch (e) {
        // 单个包读坏不该让整批加载失败
        this.packs[packName] = [];
      }
    }
    return this.packs;
  }

  /**
   * 跑全部数据包，逐条比对门禁动作与期望动作。
   *
   * @param {{ threshold?: number, pushFailures?: boolean }} [opts]
   * @returns {Promise<{total:number, correct:number, accuracy:number, pass:boolean, failureCount:number, packs:object}>}
   */
  async runAll(opts) {
    const threshold = (opts && typeof opts.threshold === 'number') ? opts.threshold : DEFAULT_THRESHOLD;
    const gate = require('../gate.js');

    let total = 0;
    let correct = 0;
    this.failures = [];
    const perPack = {};

    for (const packName of Object.keys(this.packs)) {
      const cases = this.packs[packName] || [];
      const packResult = { total: cases.length, correct: 0 };
      for (const c of cases) {
        total++;
        let actual = null;
        try {
          const r = gate.checkOutput(c && c.input !== undefined ? c.input : '');
          actual = r && r.gate ? r.gate.action : null;
        } catch (e) {
          actual = null;
        }
        const expected = (c && (c.expected_output !== undefined ? c.expected_output : c.expected));
        if (expected !== undefined && actual === expected) {
          correct++;
          packResult.correct++;
        } else {
          this.failures.push({
            pack: packName,
            input: c ? c.input : null,
            expected: expected !== undefined ? expected : null,
            actual,
          });
        }
      }
      perPack[packName] = packResult;
    }

    // total=0 时 accuracy 必须是 0 而不是 NaN —— NaN >= threshold 恒为 false，
    // 语义上恰好是"没跑就不算过"，但把 NaN 交给调用方是让下游自己踩坑。
    const accuracy = total > 0 ? correct / total : 0;

    return {
      total,
      correct,
      accuracy,
      pass: accuracy >= threshold,
      failureCount: this.failures.length,
      threshold,
      packs: perPack,
    };
  }

  /**
   * 把失败案例推入自愈 RL。
   *
   * 绝不抛错：handler 无条件 await 它。runner 未接引擎实例（`new
   * BenchmarkRunner(null)`，测试与 CLI 都这么用）时返回 status='skipped'，
   * 这是一个明确的"我没做"，不是静默成功。
   *
   * @returns {Promise<object>}
   */
  async flushFailuresToRL() {
    if (!this.hf) return { status: 'skipped', reason: 'runner 未接引擎实例', pushed: 0 };
    if (!Array.isArray(this.failures) || this.failures.length === 0) {
      return { status: 'skipped', reason: '无失败案例', pushed: 0 };
    }
    try {
      const rl = this.hf.selfHealingRL
        || (this.hf._hfCore && this.hf._hfCore.selfHealingRL)
        || null;
      if (!rl || typeof rl.recordOutcome !== 'function') {
        return { status: 'skipped', reason: 'RL 不可用', pushed: 0 };
      }
      let pushed = 0;
      for (const f of this.failures) {
        try {
          if (rl.recordOutcome.length >= 2) {
            await rl.recordOutcome('benchmark-failure', f);
            pushed++;
          }
        } catch (e) {
          // 单条推失败不影响其余条
        }
      }
      return { status: 'ok', pushed };
    } catch (e) {
      return { status: 'skipped', reason: e.message, pushed: 0 };
    }
  }
}

module.exports = { BenchmarkRunner };
