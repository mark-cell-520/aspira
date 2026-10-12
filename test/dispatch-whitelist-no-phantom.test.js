/**
 * test/dispatch-whitelist-no-phantom.test.js
 *
 * [test-coverage-gap·第二百二十三轮] 新建。
 *
 * ═══ 怎么找到的 ═══
 * 本切片的前十一个选模问题(契约脆 / 文档按全路径承诺 / 导出纯函数与常量表 /
 * src 扇入最高 / MCP 工具直接调用 / 错误处理最会把失败扮成答案 / 入口不校验 /
 * 公开方法全返回同一常量 / 从最多已测模块可达 / 运行时哪些真加载)都已用过。
 * 本轮问第十二个: **哪个 B 模块的不确定性来源在决定结果** —— 顺着 Math.random
 * 摸到 6 个 B 模块, 但三个是 ID 生成、两个是设计意图(GA / 梦境)、一个的 seed
 * 选项无人消费, 没有能推动判定的缺陷。
 *
 * 换问法后落到 `src/workflow/workflow-switch.js`(749 行)与 `src/memory/graph.js`
 * (577 行): 两者都被 heartflow.js 构造, 在 src 里零内部调用, 但 `routes()` 把它们
 * 列为对外命名空间(workflow 11 条 / graph 14 条), 计入对外宣称的 1,023 条 dispatch
 * 路由。直接调用全部 25 条路由 —— 都活着。**但白名单对不上。**
 *
 * ═══ 真正的发现 ═══
 * `Aspira.ALLOWED_ROUTES` 是 dispatch 的**权限门**。实测静态白名单 35 条里
 * 有 14 条经 dispatch 逐条抛出:
 *     "<route> is not a function on <subsystem>"
 * 即: 门先说"这条被允许", 然后调用失败。这 14 个名字在全仓**只存在于白名单** ——
 * routes() 一条都不广告它们, src/ 与 test/ 除白名单外零引用, 也没有任何测试
 * 钉住白名单内容。涉及 8 个命名空间: memory / lesson / dream / verify /
 * psychology / confidence / graph / slots。
 *
 * 这是 cycle 190 的 complianceStandards(声称符合四个标准、三个背后什么都没有)、
 * cycle 204 的 getOrCreateInstance(两处调用、零处定义)、cycle 195 的 LEVELS
 * (导出了但值是 undefined) 的同族: **一份清单承诺了不存在的能力**。
 *
 * ═══ 修法 ═══
 * 删掉这 14 条, 不实现。实现它们该有什么语义是产品判断, 本轮不做。删后 dispatch
 * 对它们返回诚实的 "route not allowed. Use routes() to see available routes."
 * —— 调用方在门口就知道没有这条路, 而不是先被允许再失败。
 *
 * ═══ 本锁钉什么 ═══
 * ① 不变量(不是数字): 白名单每一条都必须真的可调用。未来新增一条有实现的路由
 *    不会弄红它, 新增一条幽灵路由会;
 * ② 14 个幽灵名必须不在白名单里(源码级, 先剥注释);
 * ③ 修法的**方向**: 被删的路由必须得到 "not allowed", 不得得到 "is not a
 *    function" —— 后者正是"先承诺后失败"的字面特征;
 * ④ 反向证明 + 反向对照: 判据本身必须能红(往清单里注入一条幽灵必须被它抓到),
 *    同时它在真实清单上必须全绿;
 * ⑤ 披露: 今天白名单 21 条, 本锁钉的是不变量而非这个数, 并附前提自证。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const HF = path.join(ROOT, 'src', 'core', 'heartflow.js');

  // ── 长度保留地剥掉行注释与块注释(cycle 193: 剥了字符串就看不见 require 什么;
  //    这里两种都不剥字符串, 只剥注释, 且保持行长不变) ──
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

  // 从源码里取出静态 ALLOWED_ROUTES 字面量的条目(按方括号配对, 不假设 ']);' 首次出现)
  function parseWhitelist() {
    const raw = fs.readFileSync(HF, 'utf8');
    const noC = stripComments(raw);
    const start = noC.indexOf('static ALLOWED_ROUTES = new Set([');
    if (start < 0) throw new Error('heartflow.js 里找不到 static ALLOWED_ROUTES');
    const open = noC.indexOf('[', start);
    let depth = 0, end = -1;
    for (let i = open; i < noC.length; i++) {
      if (noC[i] === '[') depth++;
      else if (noC[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) throw new Error('ALLOWED_ROUTES 的方括号没有配对');
    const block = noC.slice(open, end);
    return [...block.matchAll(/'([a-zA-Z0-9_]+\.[a-zA-Z0-9_]+)'/g)].map(m => m[1]);
  }

  const entries = parseWhitelist();

  // 全文件共享一个引擎实例: 五个用例都只需要 dispatch 的权限门行为, 重复构造
  // 会把本锁耗时放大五倍, 并发跑全套件时还可能把子进程拖过 240s 超时。
  const hfMod = require(path.join(ROOT, 'src', 'core', 'heartflow.js'));
  const hf = new hfMod.Aspira({ rootPath: ROOT, silent: true });
  hf.start();

  // ── 幽灵判据: dispatch 抛出的正是 "<route> is not a function on <ns>" ──
  // 只用这一个签名。带实现的路由若因缺参数报错, 消息不同, 不算幽灵 —— 那是另一类问题。
  //
  // 注意: 必须在内存里**先把该路由加进 ALLOWED_ROUTES** 再 dispatch。否则门就把它
  // 挡在 "not allowed", 根本走不到实现层, 也就测不到"白名单里有、实现里没有"这个
  // 形状本身。修复后这 14 条在门口被挡下是**正确行为**, 所以判据要自己模拟"它在
  // 白名单里"才能验它仍然没有实现。用完即还原, 不污染同进程其他用例。
  function phantomsIn(list, hf, hfMod) {
    const out = [];
    const granted = [];
    for (const route of list) {
      const dot = route.indexOf('.');
      const ns = route.slice(0, dot);
      const wasThere = hfMod.Aspira.ALLOWED_ROUTES.has(route);
      if (!wasThere) { hfMod.Aspira.ALLOWED_ROUTES.add(route); granted.push(route); }
      try { hf.dispatch(route); } catch (e) {
        if (e && e.message === `${route} is not a function on ${ns}`) out.push(route);
      } finally {
        if (!wasThere) hfMod.Aspira.ALLOWED_ROUTES.delete(route);
      }
    }
    if (granted.length) {
      // 自证: 授予过的都还了
      for (const r of granted) {
        if (hfMod.Aspira.ALLOWED_ROUTES.has(r)) throw new Error('判据泄漏了白名单授权: ' + r);
      }
    }
    return out;
  }

  // ── ① 不变量: 白名单每一条都必须真的可调用 ───────────────────
  test('dispatch 白名单每条都必须真的可调用(不变量, 不是数字)', () => {
    assertTrue(entries.length >= 20,
      `白名单只解析出 ${entries.length} 条, 解析器可能坏了 —— 前提自证失败, 本用例无意义`);
    const dead = phantomsIn(entries, hf, hfMod);
    assertEqual(dead.length, 0,
      `白名单里有 ${dead.length} 条路由没有实现: ${dead.join(', ')} —— ` +
      '权限门先承诺"被允许", 调用再失败; 这些名字只存在于白名单, routes() 一条都不广告它们');
  });

  // ── ② 14 个幽灵名必须不在白名单里 ───────────────────────────
  test('被删掉的 14 条幽灵路由不得回到白名单', () => {
    const PHANTOMS = [
      'memory.remove', 'memory.getLayers',
      'lesson.addLesson', 'lesson.getRecent',
      'dream.dreamNow', 'dream.analyzeDream',
      'verify.checkConsistency',
      'psychology.analyze', 'psychology.detectCrisis',
      'confidence.admit',
      'graph.search',
      'slots.get', 'slots.set', 'slots.delete',
    ];
    const back = PHANTOMS.filter(p => entries.includes(p));
    assertEqual(back.length, 0,
      `这些路由的实现不存在, 却被重新加回了权限门: ${back.join(', ')}`);
    // 反向自证: 这 14 条必须真的是幽灵(否则"不在白名单"是被一个已实现的名字满足的)
    assertEqual(phantomsIn(PHANTOMS, hf, hfMod).length, PHANTOMS.length,
      '这 14 条里有的已经真的有实现了 —— 应当把它们加回白名单, 并更新本用例, 而不是继续禁用它');
  });

  // ── ③ 修法的方向: 必须是 "not allowed", 不能是 "is not a function" ──
  test('不存在的路由必须得到诚实的 "not allowed", 而不是先允许后失败', () => {
    for (const route of ['graph.search', 'slots.get', 'psychology.analyze']) {
      let msg = '';
      try { hf.dispatch(route, 'x'); } catch (e) { msg = e.message; }
      assertTrue(/not allowed/.test(msg),
        `dispatch('${route}') 的消息是 "${msg}" —— 不含 "not allowed", ` +
        '说明它仍穿过权限门, 只是没有实现(正是"先承诺后失败")');
      assertTrue(!/is not a function on/.test(msg),
        `dispatch('${route}') 的消息是 "${msg}" —— 这正是修复前的字面特征`);
    }
  });

  // ── ④ 反向证明 + 反向对照: 判据必须能红, 且在真实清单上必须全绿 ──
  test('反向证明: 往白名单注入一条幽灵, 判据必须抓到它', () => {
    // 反向对照: 真实清单全绿
    assertEqual(phantomsIn(entries, hf, hfMod).length, 0, '反向对照失败: 真实清单上就有幽灵');
    // 反向证明: 注入一条已知幽灵, 必须被抓到
    const injected = entries.concat(['graph.search']);
    const caught = phantomsIn(injected, hf, hfMod);
    assertEqual(caught.length, 1,
      `注入 graph.search 后判据只抓到 ${caught.length} 条 —— 判据抓不到幽灵, ① 因此是空的`);
    assertEqual(caught[0], 'graph.search', '抓到的不是注入的那一条');
  });

  // ── ⑤ 披露: 钉的是不变量, 不是今天的数字 ────────────────────
  test('披露: 今天白名单 21 条; 本锁钉不变量而非这个数', () => {
    assertEqual(entries.length, 21,
      `白名单今天是 21 条, 实测 ${entries.length} 条。若这是**有意**的增减, 更新这个数; ` +
      '若只是有人加了路由, ① 会验它有没有实现 —— 那个用例才是真正的门');
    assertTrue(entries.includes('graph.addNode'), 'graph.addNode 是活的, 不该被删');
    assertTrue(entries.includes('memory.search'), 'memory.search 是活的, 不该被删');
    assertTrue(entries.includes('heartflow.introspect'), 'heartflow.introspect 是活的, 不该被删');
  });
};
