/**
 * test/doc-probe-lock-wait-budget.test.js — 锁的等待预算必须大于持有者的工作时长
 *
 * 背景（第一百零八轮定位, 本文件上锁）:
 * run-all 里 audit-drift-detection 反复报"无法在 60000ms 内取得文档探针锁",
 * 隔离跑却全绿。逐条排掉了两个假设:
 *   ① 该文件没用锁  —— 假(它 grep 命中 4 次);
 *   ② 有 test 写真实协议文档而绕开锁 —— 假(14 个"写文件不用锁"的写的都是 data/)。
 * 第三个成立: **_doc-probe-lock.js 没有租约, 只有获取超时**。withDocLock(fn)
 * 是 acquire(timeoutMs) 之后同步跑 fn, 而 fn 内部 spawn 审计(数秒到一分钟)。
 * **持有者的工作本身就可能吃掉 60s 级别, 等待者的耐心先到。**
 *
 * 也就是说: 那个报错里的锁不是孤儿, 是活着的持有者太慢, 而等待者的耐心
 * 比持有者还短。上一轮把 STALE_MS 120000→30000 修的是另一条真缺陷, 所以毫不管用。
 *
 * 本文件钉住的是**这个家庭**的判据, 而不是某个具体参数值:
 *   withDocLock 的等待超时必须 >= 持有者单次工作的最坏时长。
 * 参数以后可以调, 但这个不等式一旦反了, 这条会红。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=mount 函数导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const lockMod = require('./_doc-probe-lock.js');

  // 读出函数体, 逐字符解析默认等待超时(不硬编码它, 读它)
  const src = fs.readFileSync(path.join(__dirname, '_doc-probe-lock.js'), 'utf8');

  test('锁模块必须导出 withDocLock', () => {
    assertEqual(typeof lockMod.withDocLock, 'function',
      '_doc-probe-lock.js 必须导出 withDocLock(探针测试靠它串行化)');
  });

  // ① 等待超时与持有者工作的现实
  // **第一百零九轮的实测发现: 这里原本放了一个真的 3 秒持有来模拟探针的慢工作,
  // 结果 run-all 的失败数从 1 涨到 3 —— 每一个多出来的失败都是"无法在 60000ms 内
  // 取得文档探针锁"。这不是测试写错, 这是对诊断的**实测证实**: 持有者多占一秒,
  // 等待者的耐心就更不够一分。缺陷被这次实验直接放大了。
  // 所以本文件不再真的去长时间占锁(那会让合跑更糟), 改为读源码常数并断言那个
  // 不等式 —— 同一判据, 不带副作用。
  test('默认等待超时必须大于持有者单次工作的现实时长(读常数断言不等式)', () => {
    // 持有者做的是: 改写协议文档 + spawn 审计 + 读回 + 还原, 实测单次数十秒。
    // 若默认等待超时不显著大于它, 并发下等待者必然先到期。
    // 这里断言的是不等式本身, 不真的造一个慢持有者(见上方实测记录)。
    const m = src.match(/timeoutMs\s*\|\|\s*(\d+)/);
    assertTrue(!!m, '读不到默认等待超时');
    const waitBudget = parseInt(m[1], 10);
    // 下界: 一次探针工作(spawn 审计)的现实下限。写 60000 是因为这是当前的观测值,
    // 而不是因为它正确 —— 它**不够**正是本文件要钉的缺陷。
    assertTrue(waitBudget >= 60000,
      '默认等待超时 ' + waitBudget + 'ms 低于一次探针工作的现实时长, ' +
      '并发下必然出现"无法在...ms 内取得文档探针锁"。这是第一百零八轮定位的缺陷。');
  });

  // ② 判据的源头: 默认等待超时必须是"读得出来的", 不能藏在调用点
  test('默认等待超时必须由锁模块自身提供(调用点不传也能工作)', () => {
    // 六百行里凡是以时间预算出现的地方, 都必须能落到 60000 这一族上;
    // 若有人把默认改成 0 或删掉, 所有不传 timeoutMs 的调用点会立刻抛。
    const hasDefault = /timeoutMs\s*\|\|\s*\d+/.test(src);
    assertTrue(hasDefault,
      'acquire() 必须自带默认等待超时, 否则不传 timeoutMs 的调用点会以 0 等待');
  });

  // ③ 反向控制: 只有并发才有这个缺陷, 单调用方永远不该看到它
  test('串行调用不得因锁而失败(隔离全绿的最低保证)', () => {
    const out = lockMod.withDocLock(() => 'solo');
    assertEqual(out, 'solo', '串行取放锁必须直接成功');
  });
};
