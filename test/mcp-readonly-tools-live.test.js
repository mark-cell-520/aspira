// test/mcp-readonly-tools-live.test.js
// mcp-tool-enhancement 切片: 把 cycle-29 "已广告工具必须真能跑"的活体检测扩展到更多只读工具。
// cycle-29 只实测了 decision/boundary 三兄弟(它们曾是"结构合法但内容死"的死工具); 
// 181 个工具里绝大多数从未被 live 调用过。本文件再取一批**纯读取**工具逐一 live 调用,
// 锁"不得退化成结构性合法 error"——协议层成功、不抛错, 只有内容是死(契约错配家族)。
//
// 选型守则: 只取返回统计/状态/历史的纯读取工具; 排除带 action/recorded 写副作用的
// 记录型工具(aspira_audit_log / aspira_memory_integrity 会写日志)。本测试不 spawn 审计、
// 不碰文档, 故不加剧上一族 doc 探针并发污染。
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

module.exports = function ({ test, assertTrue }) {
  const { HANDLERS, TOOLS } = require(path.join(ROOT, 'src', 'mcp-server.js'));

  const READONLY = [
    'aspira_status', 'aspira_modules_status', 'aspira_cache_stats', 'aspira_decision_history',
    'aspira_benchmark_status', 'aspira_check_drift', 'aspira_module_health',
    'aspira_memory_quality', 'aspira_wakeup_verify',
  ];

  test('这些只读工具均已广告且有实现(改名后不许静默跳过)', () => {
    const advertised = new Set(TOOLS.map((t) => t.name));
    for (const n of READONLY) {
      assertTrue(advertised.has(n), n + ' 未在 TOOLS 中广告');
      assertTrue(typeof HANDLERS[n] === 'function', n + ' 无 handler 实现');
    }
  });

  test('只读工具 live 调用须返回真实内容, 不得退化成结构性合法 error', async () => {
    for (const n of READONLY) {
      let r;
      try {
        r = await HANDLERS[n]({});
      } catch (e) {
        assertTrue(false, n + ' 调用抛错: ' + e.message);
        continue;
      }
      assertTrue(r && typeof r === 'object', n + ' 必须返回对象');
      assertTrue(!r.error,
        n + ' 返回结构性合法 error: ' + JSON.stringify(r.error) +
        ' —— 协议层成功、不抛错、只有内容死(cycle-29 契约错配家族)');
      assertTrue(Object.keys(r).length > 0, n + ' 返回空对象, 无实质内容');
    }
  });
};
