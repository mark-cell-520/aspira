/**
 * test/layer-count-two-readings.test.js — "17 层"的静态口径与运行口径必须分开
 *
 * ═══ 由来 ═══
 * 前三轮 doc-honest-numbers 修的是「扫不到文件」和「读不懂写法」。
 * 本轮验证第三件事: **审计的"实测值"本身是否可信，以及数字的口径是否唯一**。
 *
 * 先排除了一个自己的错误(第 27 次仪器失效): 用静态正则数 handler 映射，
 * 正则要求 `['"]name['"]:`，而 mcp-server.js 用的是无引号键名
 * `aspira_think: handleThink,`，于是 **181 个工具全被判成"没有 handler"**。
 * 改用运行时口径(起 socket server 逐个 tools/call)后实测 **181/181 全部可调用**
 * (177 ok + 4 个写工具因未带写权限而 isError，符合设计)。
 * **静态检测的结论与运行时事实相反，而前者看起来完全合理。**
 *
 * 然后发现一个真问题: 文档写 "17-layer pipeline"，而
 * runPipeline 实测 input→11 / draft→12 / output→13。
 * **17 从不匹配任何一次运行。** 这不是错数字——17 是**静态层名数**，
 * 13 是**单次运行最大命中数**，两个都是真的。
 *
 * 但审计此前只核对静态名单，于是 "17 层" 永远绿灯:
 * **一个数字可以在一种读法下完全正确、在另一种读法下完全误导，
 *   而只测一种读法的审计看不见这个区别。**
 *
 * ═══ 修法 ═══
 * 审计每次运行都并排报两个口径，README 加脚注、SKILL.md 加说明块。
 * 本测试锁住三个事实，防止任何一侧单独腐烂。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

module.exports = function ({ test, assertEqual, assertTrue }) {
  const { withDocLock } = require('./_doc-probe-lock.js'); // [第七轮] 跑审计须持共享文档锁(见 test/_doc-probe-lock.js)
  return withDocLock(() => {

  test('静态层名数与运行层数是两个不同的量(双口径)', () => {
    const pipe = require(path.join(ROOT, 'src', 'pipeline.js'));
    // 静态口径: 从 pipeline.js 提取 checked_by.push({ layer: 'X' })
    const pipeSrc = fs.readFileSync(path.join(ROOT, 'src', 'pipeline.js'), 'utf8');
    const pushes = [...pipeSrc.matchAll(/checked_by\.push\(\{\s*layer:\s*'([a-z-]+)'/g)].map(x => x[1]);
    const order = [];
    for (const p of pushes) if (!order.includes(p)) order.push(p);

    // 运行口径: 三种模式各跑一次
    const per = {};
    let maxRun = 0;
    for (const mode of ['input', 'draft', 'output']) {
      const r = pipe.runPipeline({ input: '这是一个用于层数实测的句子。', mode });
      const n = (r && r.checked_by ? r.checked_by.length : 0);
      per[mode] = n;
      if (n > maxRun) maxRun = n;
    }

    assertEqual(order.length, 17, '静态层名数应为 17');
    assertTrue(maxRun < order.length,
      `单次运行命中数(${maxRun})必须小于静态层名数(${order.length})——`
      + '若相等说明每个分支都必走，那"17 层"就确实是每次调用的深度，本文档口径说明需改');
    assertTrue(per.input <= per.draft && per.draft <= per.output,
      `模式深度应递增: ${JSON.stringify(per)}`);
  });

  test('审计脚本必须同时报两个口径(不能只报静态数)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-doc-numbers.js'), 'utf8');
    assertTrue(/layersMaxRun/.test(src),
      '审计必须实测运行层数——只报静态层名数会让"17 层"永远绿灯');
    assertTrue(/层数双口径/.test(src),
      '审计输出必须显式标注"双口径"，让读者知道两个数不是一回事');
  });

  test('README 的 "17-layer" 必须带口径脚注', () => {
    const rd = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assertTrue(/17-layer pipeline\*/.test(rd),
      'README 的 17-layer 须带 * 脚注标记');
    // 脚注必须出现在同一文件里，且说明每次调用不等于 17
    assertTrue(/layer \*set\*|layer set/.test(rd),
      'README 须说明 17 是层集合而非单次调用深度');
    assertTrue(/11/.test(rd) && /13/.test(rd),
      'README 脚注须给出 input/output 两个实测层数');
  });

  test('SKILL.md 的 17 层一节必须解释两个口径', () => {
    const sk = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
    const i = sk.indexOf('## The 17-layer check pipeline');
    assertTrue(i > 0, 'SKILL.md 应有 17 层一节');
    const seg = sk.slice(i, i + 1400);
    assertTrue(/static|静态/.test(seg), '须说明 17 是静态层名数');
    assertTrue(/11/.test(seg) && /13/.test(seg),
      '须给出实测的 input/output 层数');
  });
  });
};
