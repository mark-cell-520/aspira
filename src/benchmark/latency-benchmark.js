/**
 * Aspira — LatencyBenchmark（公开延迟基准）
 *
 * ═══ 这个文件为什么会消失 ═══
 * 与同目录另两个模块同一根因：`.gitignore` 的无锚定规则 `benchmark/`
 * 把 `src/benchmark/` 整个源码目录忽略了，本文件从未进入 git，静默蒸发。
 * 下游症状是 CLI 的 `heartflow benchmark` 命令恒报
 * `Cannot find module '.../src/benchmark/latency-benchmark.js'`，
 * 以及 test/recovered-modules.test.js 整文件红。
 *
 * ═══ 对外契约（由 test/recovered-modules.test.js 逐字锁定）═══
 *   new LatencyBenchmark(fn, { warmup, samples })
 *   await report() → { avgMs: number, samples: number, ... }
 *
 * 设计：零外部依赖（README 的 capability 一节声称 "0 runtime
 * dependencies"），统计量自己算。
 */

'use strict';

/** 默认采样数。CLI 传 20，测试传 3。 */
const DEFAULT_SAMPLES = 10;
/** 默认预热次数。预热不计入统计 —— 第一次调用通常含 JIT/懒加载开销。 */
const DEFAULT_WARMUP = 2;

class LatencyBenchmark {
  /**
   * @param {() => Promise<any>|() => any} fn 被测函数，每次采样调用一次
   * @param {{ warmup?: number, samples?: number }} [opts]
   */
  constructor(fn, opts) {
    if (typeof fn !== 'function') {
      throw new Error('LatencyBenchmark 需要一个函数作为被测目标');
    }
    this.fn = fn;
    this.warmup = (opts && typeof opts.warmup === 'number') ? opts.warmup : DEFAULT_WARMUP;
    this.samples = (opts && typeof opts.samples === 'number') ? opts.samples : DEFAULT_SAMPLES;
    if (this.samples < 1) this.samples = 1;
    if (this.warmup < 0) this.warmup = 0;
    /** @type {number[]} 最近一次 report() 的原始样本（毫秒） */
    this.samplesMs = [];
  }

  /** 测一次，返回毫秒数。用 hrtime 而不是 Date.now() —— 毫秒精度下
   *  一次 think() 的耗时可能不足 1ms，Date.now() 会给出 0 或负数。 */
  async _measure() {
    const t0 = process.hrtime.bigint();
    await this.fn();
    const t1 = process.hrtime.bigint();
    return Number(t1 - t0) / 1e6;
  }

  /** 百分位数。样本已排序，index 线性插值。 */
  _percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /**
   * 跑预热 + 采样，返回统计报告。
   *
   * @returns {Promise<{avgMs:number, samples:number, minMs:number, maxMs:number, p50Ms:number, p95Ms:number, totalMs:number, warmup:number}>}
   */
  async report() {
    for (let i = 0; i < this.warmup; i++) {
      await this._measure();
    }

    const ms = [];
    for (let i = 0; i < this.samples; i++) {
      ms.push(await this._measure());
    }
    this.samplesMs = ms;

    const sorted = ms.slice().sort((a, b) => a - b);
    const total = ms.reduce((a, b) => a + b, 0);
    const avg = this.samples > 0 ? total / this.samples : 0;

    return {
      avgMs: avg,
      samples: this.samples,
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      p50Ms: this._percentile(sorted, 0.5),
      p95Ms: this._percentile(sorted, 0.95),
      totalMs: total,
      warmup: this.warmup,
    };
  }
}

module.exports = { LatencyBenchmark };
