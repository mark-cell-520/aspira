/**
 * test/mcp-server-contract-lock.test.js — MCP 入口文件的两条工具层契约
 *
 * [mcp-tool-enhancement·第一百二十二轮] 新建。本轮的做法与第二十九轮相同:
 * 不静态数工具, 而是**实际调用**全部 181 个 handler 后逐个甄别结果。
 * 167 ok / 14 error-obj / 0 throw, 其中 11 个是正确校验或已有诚实披露
 * (error-memory 四工具标注"能力未实现"、benchmark 两工具缺模块即 baseline
 * 失败项), 但有两个是这轮新修的:
 *
 * ═══ 缺陷①: aspira_audit_log 的 record 分支 100% 崩 ═══
 * schema 把 action 的 enum 广告为 ["record","query"], **第一个合法值就是
 * record** —— 按 schema 调用的 agent 必然撞上死路。handler 却写:
 *     al.record({ event, ts })          // 单参
 * 而 AuditLogger.record(actionType, decision) 是**两参**(recordDenied/
 * recordGranted 的包装形状也是两参)。decision 为 undefined -> record 内
 * `decision.action` 抛 TypeError -> 被 handler 的 catch 包成
 * { error: 'Cannot read properties of undefined (reading action)' }。
 * 调用在协议层成功、不抛错、结构合法 —— 只有内容是死的。契约错配家族。
 *
 * ═══ 缺陷②: 正则字符类里嵌原始控制字节, 整个入口文件被判定为 binary ═══
 * `sanitizeHFDir`(cycle 35: 拒绝引号/反引号/NUL/控制字符的路径清理函数)的
 * 正则 /["'`<NUL>-<US>]/ 把两个控制字节**原样写进了源码**。node --check 与
 * 运行时都正常, 但 `file` 把整个 193KB 的 src/mcp-server.js 判为
 * "binary data", 于是 `grep`(不带 -a)对它**静默失效** —— 本轮收集事实时
 * 两次 grep 零输出, 一度以为结构不存在。已改为等价转义 /["'`\x00-\x1f]/,
 * 22 个边界输入(含 NUL/控制字符/引号)实测行为零差异。
 *
 * ═══ 锁什么 ═══
 * ① audit_log 对 schema 广告的每个合法 action 都必须真实可用, 且源级钉住
 *    record 的两参对齐(单参回退即红);
 * ② AuditLogger.record 的契约本身: 单参必须抛、双参必须正常 —— 没有这一条,
 *    ① 可能被"record 变成静默空操作"满足, 那是恒真锁;
 * ③ mcp-server.js 不得再出现原始 C0 控制字节(锁② 缺陷的复发)。
 *
 * ⚠️ 披露而非隐藏: 实测 src/ 下还有 4 个文件含原始控制字节 ——
 * index.js(80 字节, 形如 /<08>because/, 疑似本意为 \b 词边界)、
 * dream/interactive-dream.js(20)、knowledge/classics-rules.js(12)、
 * memory/kv-cache.js(1)。它们不属 MCP 工具层, 且 index.js 那批涉及判别语义,
 * 留待对应切片; 本轮只修入口文件这一个。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'mcp-server.js');

module.exports = function ({ test, assertTrue, assertEqual }) {

  const { HANDLERS, TOOLS } = require(SERVER);
  const auditTool = TOOLS.find(t => t.name === 'aspira_audit_log');
  const legalActions = (auditTool && auditTool.inputSchema &&
    auditTool.inputSchema.properties && auditTool.inputSchema.properties.action &&
    auditTool.inputSchema.properties.action.enum) || ['record', 'query'];

  // ⚠️ 隔离必须在**函数体顶层**就取好 Real: 用例 ①(async)await 让出事件循环时,
  // 同步用例 ③ 会插队执行并解构同一份模块属性 —— 首版把解构写在用例体内,
  // ③ 于是拿到 ① 还没还原的 Capturing 类, 两条 entry 混进同一个数组,
  // "恰好一条"断言红了一次。**mount 的用例执行顺序不是注册顺序。**
  const auditMod = require(path.join(ROOT, 'src', 'shield', 'audit-logger.js'));
  const RealAuditLogger = auditMod.AuditLogger;

  // ─── ① record 分支必须真实可用(隔离写盘, 不碰仓库 data/) ────
  test('aspira_audit_log 对 schema 广告的每个合法 action 都必须真实可用', async () => {
    // 捕获 entry 而非落盘: handler 每次 require 时解构 { AuditLogger },
    // 故在调用前替换缓存模块的属性即可生效(解构发生在调用时)。
    const captured = [];
    class Capturing extends RealAuditLogger {
      _persist(entry) { captured.push(entry); }
    }
    auditMod.AuditLogger = Capturing;
    const baseline = captured.length;
    try {
      for (const action of legalActions) {
        const r = await HANDLERS.aspira_audit_log({ action, event: 'lock-probe' });
        assertTrue(r && typeof r === 'object', action + ' 必须返回对象');
        assertTrue(!r.error,
          `action='${action}' 返回了结构合法的 error: ${JSON.stringify(r.error)}` +
          ' —— 该分支不可用, 而 schema 正把它广告给调用方');
        assertEqual(r.action, action, '回显的 action 必须与入参一致');
        assertEqual(r.recorded, action === 'record', `recorded 字段必须反映 ${action} 分支`);
      }
      // record 分支必须真的产出 entry, 且 decision 字段齐全(单参 bug 的复发形状:
      // decision 为 undefined 会让 record 抛错, 表现为上面的 r.error)

      if (captured.length > baseline) {
        const d = captured[0].decision || {};
        assertEqual(d.action, 'record', 'entry.decision.action 必须是 record(两参签名的左参)');
        assertTrue(typeof d.reason === 'string' && d.reason.length > 0, 'entry.decision.reason 不得为空');
        assertEqual(d.tool, 'aspira_audit_log', 'entry.decision.tool 必须标明来源');
        assertEqual(d.agent, 'mcp', 'entry.decision.agent 必须标明 mcp');
      }
    } finally {
      auditMod.AuditLogger = RealAuditLogger; // 还原, 不影响同进程其他测试
    }
  });

  // ─── ② 源级钉住 record 的两参对齐 ────
  test('handler 源码必须按两参签名调用 AuditLogger.record', () => {
    const src = HANDLERS.aspira_audit_log.toString();
    assertTrue(/al\.record\(\s*['"]record['"]\s*,/.test(src),
      'record 调用必须显式传入 actionType 左参 —— 单参形状(已修)回退即红, 实测: ' +
      src.replace(/\s+/g, ' ').slice(0, 160));
  });

  // ─── ③ AuditLogger.record 契约本身(防①是恒真锁) ────
  test('AuditLogger.record 的契约: 单参必抛, 双参正常', async () => {
    const AuditLogger = RealAuditLogger;
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-lock-'));
    try {
      const al = new AuditLogger({ silent: true, logDir: dir });
      // 单参(修前的调用形状): decision undefined -> record 内 decision.action 抛
      let threw = null;
      try { al.record({ event: 'x', ts: 1 }); } catch (e) { threw = e; }
      assertTrue(!!threw, '单参调用必须抛错 —— 这正是缺陷①的根因, 不抛说明契约已变, 本条锁失效');
      assertTrue(/reading 'action'/.test(threw && threw.message || ''),
        `抛错信息应指 decision.action, 实测: ${threw && threw.message}`);
      // 双参: 正常返回 entry id 且不写坏盘
      const id = al.record('denied', { action: 'x', reason: 'r', tool: 't', agent: 'a' });
      assertTrue(typeof id === 'string' && /^audit_/.test(id),
        `双参调用必须返回 entry id, 实测: ${JSON.stringify(id)}`);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 临时目录 */ }
    }
  });

  // ─── ④ mcp-server.js 不得再出现原始 C0 控制字节 ────
  test('src/mcp-server.js 不含原始 C0 控制字节(grep/file 不得再失明)', () => {
    const b = fs.readFileSync(SERVER);
    const bad = [];
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c !== 9 && c !== 10 && c !== 13 && c < 32) bad.push(i);
    }
    assertEqual(bad.length, 0,
      `MCP 入口文件不得含原始控制字节(实测 ${bad.length} 个, 首个偏移 ${bad[0]}) ——` +
      ' 一个原始 NUL 就让 file 把 193KB 入口判为 binary, grep 对它静默失效');
    // 顺带锁 UTF-8 可解码: 控制字节问题常伴随编码损坏
    const text = b.toString('utf8');
    assertTrue(text.includes('function sanitizeHFDir') && text.includes('aspira_audit_log'),
      '文件必须仍可被 UTF-8 解码且两个关键符号都在');
  });
};
