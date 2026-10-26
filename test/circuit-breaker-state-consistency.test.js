'use strict';
/**
 * circuit-breaker 状态面与执行面一致性回归测试
 *
 * 钉住的缺陷: _evaluate() 的告警档(HALF_OPEN)与恢复档(CLOSED)只作为返回值
 * 给出, 从不写回 _state; 而 getState() 读 _state, guard() 读 _evaluate() 的
 * 返回值。于是一次失败率熔断后 _state 被钉在 OPEN, 之后即使滑动窗口翻页、
 * 失败率掉回 0, getState() 永远报 OPEN, 只有手动 reset() 能解 —— 而同一进程
 * 里 guard() 早就恢复放行了。
 *
 * 对外影响面: aspira_circuit_breaker 这个 MCP 工具的默认 action 是 'status',
 * 返回的就是 getState()。修前运维看到"熔断器永久 OPEN", 而每个请求都在
 * 正常放行, 状态面完全失去指示意义。
 *
 * 修前: 10 连败后 getState().state='OPEN'; 再记 40 次成功, guard() 已放行且
 *       state='CLOSED', getState().state 仍是 'OPEN'。
 * 修后: 三个档位(OPEN / HALF_OPEN / CLOSED)下 getState() 与 guard() 必然一致。
 */
const cb = require('../src/circuit-breaker.js');

module.exports = function ({ test, assertEqual, assertTrue, assertFalse }) {
  test('失败率熔断后状态随失败率回落, 不永久闩在 OPEN', () => {
    cb.reset();
    for (let i = 0; i < 10; i++) cb.recordOutcome(false);
    assertEqual(cb.getState().state, 'OPEN', '10 连败应判 OPEN');
    assertFalse(cb.guard().allowed, 'OPEN 时应拦截');

    // 失败率掉到告警档以下、熔断档以上 → HALF_OPEN
    for (let i = 0; i < 20; i++) cb.recordOutcome(true);
    assertEqual(cb.getState().state, 'HALF_OPEN', '失败率 1/3 应判 HALF_OPEN, got: ' + cb.getState().state);
    assertEqual(cb.guard().state, 'HALF_OPEN', 'guard() 与 getState() 应一致');

    // 失败率继续掉到告警档以下 → CLOSED, 且不得再回到 OPEN
    for (let i = 0; i < 30; i++) cb.recordOutcome(true);
    assertEqual(cb.getState().state, 'CLOSED', '失败率 0.2 应判 CLOSED, got: ' + cb.getState().state);
    assertEqual(cb.guard().state, 'CLOSED', 'guard() 与 getState() 应一致');
    assertTrue(cb.guard().allowed, '恢复后应放行');
  });

  test('getState() 与 guard() 在各档位必然一致', () => {
    const check = () => {
      const st = cb.getState();
      const gd = cb.guard();
      assertEqual(st.state, gd.state, `状态面 ${st.state} 与执行面 ${gd.state} 不一致`);
    };
    cb.reset();
    check();
    for (let i = 0; i < 12; i++) cb.recordOutcome(false);
    check();
    assertFalse(cb.guard().allowed, 'OPEN 档必须拦截');
  });

  test('trip/reset 不受本次改动影响', () => {
    cb.reset();
    assertEqual(cb.getState().state, 'CLOSED', 'reset 后应为 CLOSED');
    cb.trip('manual-test');
    assertEqual(cb.getState().state, 'TRIPPED', 'trip 后应为 TRIPPED');
    assertTrue(cb.isTripped(), 'trip 后 isTripped 应为 true');
    assertFalse(cb.guard().allowed, 'TRIPPED 时必须拦截');
    cb.reset();
    assertEqual(cb.getState().state, 'CLOSED', 'reset 后应回到 CLOSED');
    assertTrue(cb.guard().allowed, 'reset 后应放行');
  });
};
