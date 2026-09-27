/**
 * test/mcp-hollow-tool.test.js — 空洞 MCP 工具回归
 *
 * 背景: scripts/audit-mcp-param-contract.js 报 17 个"声明未读"疑似真问题。
 * 逐个复核后，多数是审计自身的误报(不认识 `const { formula, variables = {} } = args`
 * 解构惯用法、或 `checkOutbound(args || {})` 整体转发)，但 aspira_topic_scope 是**真缺陷**，
 * 且是三层缺陷叠加，合起来使该工具完全不可用:
 *
 *   (1) **声明未读**: schema 声明 action: ['current','push','pop'] 与 text，
 *       handler 却两者都不读。调用方传 action:'push' 被静默丢弃。
 *   (2) **调用不存在的方法**: handler 写 `ts.getCurrentTopic ? ts.getCurrentTopic() : {}`，
 *       而 TopicScope 的真实读接口是 **getter** `ts.current`(当前话题**名字符串**，
 *       未初始化时 null)与 `ts.stack`(数组)，根本没有 getCurrentTopic()。
 *       因表达式写成三元取方法，取不到就走 else，于是**任何 action 都恒返回空对象 {}**，
 *       且不报任何错——最坏的一种失效: 静默返回空。
 *   (3) **状态不跨调用**: 每次调用都 new TopicScope()，而该类纯内存、无持久化
 *       (构造器只建 Map/数组，无 readFile/writeFile)，push/pop 即便接上也会当场失效。
 *
 * 修法: 模块级单例(_topicScope)让状态跨调用存活 + 按 action 分发 + 用真实 getter。
 *
 * 本测试锁的是这三条不变量。尤其是第 (2) 条——**静默返回空**比抛错危险得多，
 * 因为调用方拿到 {} 会以为"当前没有话题"，而不是"这个工具坏了"。
 *
 * 遵循 aspira 约定 #4：位于 test/ 根目录、module.exports=函数 导出。
 */
module.exports = function ({ test, assertEqual, assertTrue }) {
  const path = require('path');
  const fs = require('fs');

  // require.main 守卫存在，require 不会启动 HTTP 服务
  const { HANDLERS, TOOLS } = require('../src/mcp-server.js');

  test('aspira_topic_scope 的 current/push/pop 三个动作都必须真的生效', () => {
    const h = HANDLERS.aspira_topic_scope;
    assertTrue(typeof h === 'function', 'aspira_topic_scope 应有 handler');

    // current: 单例可能已被前面的调用推过话题，故不断言具体值，只断言字段存在且为合法形态
    const cur = h({ action: 'current' });
    assertTrue(cur && !cur.error, `current 不应报错: ${JSON.stringify(cur)}`);
    assertTrue('topic' in cur, 'current 应返回 topic 字段');
    assertTrue(Array.isArray(cur.stack), 'current 应返回 stack 数组');
    assertTrue(cur.topic === null || typeof cur.topic === 'string',
      `topic 应为 null 或字符串(话题名)，实得 ${typeof cur.topic}`);

    // push: 必须真正改变状态
    const before = h({ action: 'current' });
    const p1 = h({ action: 'push', text: '回归测试话题甲' });
    assertTrue(p1 && !p1.error, `push 不应报错: ${JSON.stringify(p1)}`);
    assertEqual(p1.topic, '回归测试话题甲', 'push 后当前话题应变为所推话题');
    assertTrue(p1.stack[p1.stack.length - 1] === '回归测试话题甲', 'push 后栈顶应为所推话题');
    assertTrue(p1.stack.length > (before.stack ? before.stack.length : 0),
      'push 应使栈变长');

    // 再 push 一个，然后 pop 应回到上一个
    const p2 = h({ action: 'push', text: '回归测试话题乙' });
    assertEqual(p2.topic, '回归测试话题乙', '第二次 push 后当前话题应更新');
    const popped = h({ action: 'pop' });
    assertTrue(popped && !popped.error, `pop 不应报错: ${JSON.stringify(popped)}`);
    assertEqual(popped.previous, '回归测试话题乙', 'pop 应回报上一次的当前话题');
    assertEqual(popped.topic, '回归测试话题甲', 'pop 后应回到上一个话题');

    // 收尾: 把测试推出的话题清掉，避免污染其它测试(单例是进程级的)
    h({ action: 'pop' });
  });

  test('aspira_topic_scope 必须跨调用保持状态(单例，不是每次新建)', () => {
    const h = HANDLERS.aspira_topic_scope;
    const tag = '单例探针-' + Date.now();
    const a = h({ action: 'push', text: tag });
    const b = h({ action: 'current' });
    assertEqual(b.topic, tag,
      'push 之后再调 current 取不到同一话题——状态没有跨调用存活(又是每次 new TopicScope)');
    assertTrue(b.stack.includes(tag), 'current 的 stack 应包含刚推的话题');
    h({ action: 'pop' });
  });

  test('aspira_topic_scope 不得调用 TopicScope 上不存在的方法', () => {
    // 这是缺陷 (2) 的定向回归: getCurrentTopic 在类上不存在，
    // 而 `x ? x() : {}` 的写法会让它静默走 else 分支返回 {}。
    // 注意必须先剥离注释行——修复说明的注释里就写着 getCurrentTopic 的字样，
    // 否则测试会匹配到我自己的注释(上一轮已犯过同样的错)。
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assertTrue(!/getCurrentTopic/.test(code),
      'handler 不得调用不存在的 getCurrentTopic()——应用真实 getter ts.current');

    // 正面锁: 必须真的用到 ts.current / _topicScope.current 与 .stack
    assertTrue(/_topicScope\.current/.test(code), '应使用 _topicScope.current 读当前话题');
    assertTrue(/_topicScope\.stack/.test(code), '应使用 _topicScope.stack 读话题栈');
    assertTrue(/_topicScope\.push\(/.test(code), '应调用 _topicScope.push()');
    assertTrue(/_topicScope\.pop\(/.test(code), '应调用 _topicScope.pop()');
  });

  test('aspira_topic_scope 对非法 action 与缺失 text 必须报错而非静默返回空', () => {
    const h = HANDLERS.aspira_topic_scope;
    const bad = h({ action: 'bogus' });
    assertTrue(!!bad.error, `未知 action 应报错，实得 ${JSON.stringify(bad)}`);
    const noText = h({ action: 'push' });
    assertTrue(!!noText.error, 'push 缺 text 应报错');
    const emptyText = h({ action: 'push', text: '' });
    assertTrue(!!emptyText.error, 'push 传空 text 应报错');
    // 报错后状态不得被破坏
    const after = h({ action: 'current' });
    assertTrue(!after.error, '报错后的 current 调用不应出错');
  });

  test('handler 必须真的读取 schema 声明的参数(不得声明未读)', () => {
    // 缺陷 (1) 的定向回归。用行为证明: 同一个 action 传不同 text 必须产生不同结果，
    // 否则说明 text 根本没被读。
    const h = HANDLERS.aspira_topic_scope;
    const t1 = '参数读取探针甲';
    const t2 = '参数读取探针乙';
    const r1 = h({ action: 'push', text: t1 });
    const r2 = h({ action: 'push', text: t2 });
    assertEqual(r1.topic, t1, '传 t1 应推入 t1');
    assertEqual(r2.topic, t2, '传 t2 应推入 t2——否则 text 未被读取');
    h({ action: 'pop' });
    h({ action: 'pop' });
  });
};
