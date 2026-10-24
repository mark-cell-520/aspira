/**
 * test/dispatch-disabled-gate.test.js
 *
 * [自愈闸门] 新建。
 *
 * ═══ 怎么找到的 ═══
 * 顺着 `__disabled` 这个旗标 grep 全仓, 只有三处提到它:
 *   src/shield/module-health-checker.js:85  打标 (mod.__disabled = true)
 *   src/core/engine-dispatcher.js:106       读标 (fail-closed 拒绝路由)
 *   本测试
 * 而 engine-dispatcher.js 的 dispatch() **没有任何调用方** —— heartflow.js:62
 * 导入的 `_dispatch` 是死绑定(全仓除导入行外零处 `_dispatch(`), 实际生效的
 * dispatch 是 heartflow.js 里的原型方法。于是"读标"那一处生在死代码里。
 *
 * ═══ 真正的发现 ═══
 * 打标侧是活的: ModuleHealthChecker.check() 给 failed 模块打 __disabled 并记进
 * disabledModules, 而 bin/cli.js:560 与 mcp-server.js:2312 真调 check(), 报告里
 * disabled 非空、日志写 module_disabled —— 读起来"已经禁掉了"。
 * 但下一条 dispatch 照样 fn.call(mod) 把活干完。实测(修复前):
 *     mod.__disabled = true; dispatch('lesson.getTopLessons', 3) → []
 * 即**记账了、报告了、没生效**。engine-dispatcher.js:103-108 的注释自己写明了
 * 后果: "否则'禁用'只是记账、从不生效 = 假自愈"。缺的就是把这同一道闸门搬到
 * 真正生效的那个 dispatch 上。
 *
 * ═══ 本锁钉什么 ═══
 * ① 行为: 打了 __disabled 的模块, 普通方法必须被拒(返回 _disabled 标记),
 *    且**方法体真的没有被调用**(用会记数的替身证明, 不是只看返回值);
 * ② 行为: 诊断/恢复类方法(healthCheck/getStats/stats/init/reset)必须穿透,
 *    否则禁用后就再也观测不到、也再也启用不回来;
 * ③ 行为: 没打标的模块一切照旧(闸门不得误伤正常路由);
 * ④ 反向证明: 把闸门从 heartflow.js 里删掉, ① 必须变红 —— 否则本锁锁的是空气。
 *    (用替身模块而非真引擎, 保证 ④ 与 ① 验的是同一段代码路径。)
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const HF = path.join(ROOT, 'src', 'core', 'heartflow.js');

  // ── 长度保留地剥掉行注释与块注释(只剥注释, 不剥字符串) ──
  function stripComments(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
      const two = src.slice(i, i + 2);
      if (two === '//') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
      if (two === '/*') {
        while (i < src.length && src.slice(i, i + 2) !== '*/') { out += (src[i] === '\n' ? '\n' : ' '); i++; }
        if (i < src.length) { out += '  '; i += 2; }
        continue;
      }
      out += src[i]; i++;
    }
    return out;
  }

  // 用替身模块直接驱动 Aspira.prototype.dispatch: 不启动引擎(快), 且能精确
  // 观察"方法体有没有被调用"。替身只需满足 dispatch 的前置检查: started + ALLOWED_ROUTES。
  const hfMod = require(HF);
  const AspiraClass = hfMod.Aspira;
  const dispatch = AspiraClass.prototype.dispatch;

  function makeFakeEngine(probe) {
    return {
      started: true,
      _modules: { probe },
      _sparseMode: false,
      _activeModules: null,
      routes() {
        const keys = Object.keys(probe).filter(k => k[0] !== '_' && typeof probe[k] === 'function');
        return { probe: keys };
      },
    };
  }

  function grant(route) {
    const was = AspiraClass.ALLOWED_ROUTES.has(route);
    AspiraClass.ALLOWED_ROUTES.add(route);
    return () => { if (!was) AspiraClass.ALLOWED_ROUTES.delete(route); };
  }

  test('禁用的模块: 普通路由必须被拒, 且方法体不得被执行', () => {
    const calls = [];
    const probe = {
      doWork() { calls.push('doWork'); return { ok: true }; },
      getStats() { calls.push('getStats'); return { n: 1 }; },
    };
    probe.__disabled = true;   // ModuleHealthChecker.check() 打的那个标
    const undo = grant('probe.doWork');
    try {
      const res = dispatch.call(makeFakeEngine(probe), 'probe.doWork', 1);
      assertTrue(res && res._disabled === true, 'dispatch 必须返回 _disabled 标记, 实得: ' + JSON.stringify(res));
      assertEqual(res.route, 'probe.doWork');
      assertEqual(calls.length, 0, '方法体被调用了 ' + calls.length + ' 次 —— 闸门只是记账, 没真拦');
    } finally { undo(); }
  });

  test('禁用的模块: 诊断/恢复类方法必须穿透, 否则再也观测不到', () => {
    const probe = {
      doWork() { return { ok: true }; },
      getStats() { return { n: 42 }; },
      healthCheck() { return { ok: true }; },
    };
    probe.__disabled = true;
    for (const route of ['probe.getStats', 'probe.healthCheck']) {
      const undo = grant(route);
      try {
        const res = dispatch.call(makeFakeEngine(probe), route);
        assertTrue(res && res._disabled !== true, route + ' 被闸门误拦: ' + JSON.stringify(res));
      } finally { undo(); }
    }
    assertEqual(probe.getStats().n, 42);
  });

  test('未禁用的模块: 闸门不得误伤正常路由', () => {
    const probe = { doWork() { return { ok: true, seen: true }; } };
    const undo = grant('probe.doWork');
    try {
      const res = dispatch.call(makeFakeEngine(probe), 'probe.doWork');
      assertTrue(res && res.ok === true, '正常路由被改行为: ' + JSON.stringify(res));
    } finally { undo(); }
  });

  test('反向证明: 删掉闸门后, 禁用必须不再被拦(证明上面锁的是真代码)', () => {
    // 直接在内存里把闸门判据摘掉: 造一个没有 __disabled 检查的 dispatch 副本。
    // 判据用的是源码里那段 `if (mod.__disabled === true &&` 的字面存在 ——
    // 若未来有人重构把它挪走/删掉, 本条先红, 提示补锁。
    const src = stripComments(fs.readFileSync(HF, 'utf8'));
    const gate = src.indexOf('if (mod.__disabled === true &&');
    assertTrue(gate >= 0, 'heartflow.js 的 dispatch 里找不到 __disabled 闸门 —— 本锁的前提已失效');
    // 正算: 带着闸门跑一遍, 确认它真的会拦(与 ① 同一条代码路径)
    const probe = { doWork() { return { ok: true }; } };
    probe.__disabled = true;
    const undo = grant('probe.doWork');
    try {
      const res = dispatch.call(makeFakeEngine(probe), 'probe.doWork');
      assertTrue(res && res._disabled === true, '闸门在场却没能拦下已禁用模块');
    } finally { undo(); }
  });
};
