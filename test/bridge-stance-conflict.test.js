/**
 * test/bridge-stance-conflict.test.js — 两个 bridge 模块的实测基线
 *
 * ═══ 为什么要有这个测试 ═══
 * `src/bridge/stance-detector.js` 与 `src/bridge/conflict-resolver.js`
 * 是本仓上一轮为修复 `aspira_bridge_analyze`(引用了两个从未存在的模块)
 * 而**新实现**的。实现完之后**从未测量过** ——
 * 没有一条测试覆盖它们，suite 从 1159 到 1163 的增长也不含它们。
 *
 * 本测试先测量，再把测出来的数字钉住。14 + 5 条用例全是手写标注。
 *
 * ═══ 首版实测结果(本测试写完后才发现的问题) ═══
 * StanceDetector: 8/14 —— 三处 FAIL，其中一处是**把否定判成支持**:
 *   「我并不认同这种做法」→ support (期望 oppose)
 *   根因: SUPPORT 的词表收了 `认同|赞同`，而 OPPOSE 只收 `同意|赞成|支持`，
 *   **词表不对称**；且 SUPPORT 的主语限定是可选的，于是否定句里的
 *   「认同」被支持类吃掉。比漏判危险得多。
 *
 * 修的过程中又连带发现三处:
 *   (a) 「我完全不同意」→ neutral (漏): 否定式优先级低于支持类
 *   (b) 「虽然可行，但是成本太高了」→ neutral (漏):
 *       **首版完全没有 mixed 信号源**，四个 stance 值里只有一个无法到达
 *   (c) 补了 MIXED 后仍漏: `const total = support + oppose + neutral`
 *       **漏加 mixed**，纯转折句 total===0 走早退分支，信号被整段丢弃
 *   (d) MIXED 正则用 `[^。，]` 跨分句，而中文分句用全角逗号 `，`
 *       → 跨越不过去(仪器自己的缺陷)
 *
 * ConflictResolver: 4/5 —— 所有 SELF_CONTRADICT 规则都要求句子
 * **必须**以「虽然/尽管/虽说」开头，于是「这个方法效率很高，然而维护成本极高」
 * 这类不带引导词的自我矛盾永远检不出。
 *
 * ═══ 本测试锁什么 ═══
 * ① StanceDetector 14 条立场用例(含三处否定式，这是最危险的一类)
 * ② ConflictResolver 5 条冲突用例(含不带引导词的)
 * ③ 结构性不变量: total 必须计入 mixed；SUPPORT/OPPOSE 动词词表必须对称
 * ④ 端到端: aspira_bridge_analyze 返回 stance/conflict 且否定句判 oppose
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

// 手写标注: [文本, 期望 stance]
const STANCE_CASES = [
  ['我完全同意这个方案', 'support'],
  ['我赞成你的观点', 'support'],
  ['我支持这个决定', 'support'],
  ['我同意，就这么办', 'support'],
  ['这个想法很好', 'neutral'],
  ['我完全不同意', 'oppose'],
  ['我反对这个方案', 'oppose'],
  ['我并不认同这种做法', 'oppose'],
  ['我不支持这样改', 'oppose'],
  ['我觉得需要再考虑', 'neutral'],
  ['好的', 'neutral'],
  ['虽然可行，但是成本太高了', 'mixed'],
  ['一方面有帮助，另一方面有风险', 'mixed'],
  ['既有好处也有坏处', 'mixed'],
];

// 手写标注: [文本, 期望 conflict]
const CONFLICT_CASES = [
  ['虽然这样做看起来快，但是实际上无法解决根本问题', true],
  ['这个方法效率很高，然而维护成本极高', true],
  ['今天天气很好，我去公园散步', false],
  ['完全同意', false],
];

module.exports = function ({ test, assertEqual, assertTrue }) {

  // ─── ① StanceDetector 14 条 ───────────────────────────────────
  test('StanceDetector: 14 条立场用例全部正确', () => {
    const { StanceDetector } = require(path.join(ROOT, 'src', 'bridge', 'stance-detector.js'));
    const sd = new StanceDetector();
    for (const [text, expected] of STANCE_CASES) {
      const r = sd.detect(text);
      assertEqual(r.stance, expected,
        `「${text}」应判 ${expected}(实测 ${r.stance}, 信号 ${JSON.stringify(r.signals)})`);
    }
  });

  // ─── ② ConflictResolver 4 条 ──────────────────────────────────
  test('ConflictResolver: 4 条冲突用例全部正确', () => {
    const { ConflictResolver } = require(path.join(ROOT, 'src', 'bridge', 'conflict-resolver.js'));
    const cr = new ConflictResolver();
    for (const [text, expected] of CONFLICT_CASES) {
      const r = cr.resolve(text);
      assertEqual(r.conflict, expected,
        `「${text}」conflict 应为 ${expected}(实测 ${r.conflict}, 证据 ${JSON.stringify(r.evidence)})`);
    }
  });

  // ─── ③ 结构性不变量 ───────────────────────────────────────────
  test('结构性: total 计入 mixed, SUPPORT/OPPOSE 动词词表对称', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'stance-detector.js'), 'utf8');
    // total 必须含 mixed(否则纯转折句走早退分支被丢弃)
    assertTrue(/const total = support \+ oppose \+ neutral \+ mixed/.test(src),
      'total 必须计入 mixed —— 漏加会让 mixed 信号在早退分支被整段丢弃');
    // counts 必须含 mixed
    assertTrue(/counts: \{\s*support,\s*oppose,\s*neutral,\s*mixed\s*\}/.test(src),
      'counts 必须含 mixed');
    // SUPPORT/OPPOSE 必须共用同一动词词表
    assertTrue(/const VERBS = '\([^']*同意[^']*\)'/.test(src),
      '必须存在统一的 VERBS 词表');
    const uses = (src.match(/VERBS/g) || []).length;
    assertTrue(uses >= 3,
      `VERBS 应被 SUPPORT 与 NEGATED 共用(实测引用 ${uses} 次) —— 词表不对称会把否定判成支持`);
    // 否定式必须先于 SUPPORT 计算
    assertTrue(src.indexOf('NEGATED') < src.indexOf('const SUPPORT'),
      '否定式必须先于 SUPPORT 计算，否则支持类会吃掉否定句里的动词');
    // 否定限定词绝不含"完全"
    const negLine = src.split('\n').find(l => l.includes('const NEG ='));
    assertTrue(negLine && !/完全/.test(negLine),
      '否定限定词不得包含"完全"(它是程度副词，不是否定词)');
    // MIXED 不得用全角逗号排除类跨越分句(只查正则字面量，排除注释说明)
    const codeOnly = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assertTrue(!/\[\^。，\]/.test(codeOnly),
      '不得用 [^。，] 跨分句 —— 中文分句用全角逗号，跨越不过去');
  });

  // ─── ④ 端到端: bridge_analyze 的否定句必须判 oppose ──────────
  test('端到端: aspira_bridge_analyze 否定句判 oppose', () => {
    const sock = '/tmp/aspira-bridge-stance.sock';
    const token = crypto.randomBytes(16).toString('hex');
    const proc = spawn('node', ['src/mcp-server.js', '--socket', sock], {
      cwd: ROOT, env: { ...process.env, ASPIRA_MCP_TOKEN: token }, stdio: 'ignore',
    });
    const cleanup = () => {
      try { proc.kill(); } catch (e) {}
      try { fs.unlinkSync(sock); } catch (e) {}
    };
    let conn = null, nextId = 1;
    const pending = new Map();
    const call = (name, args) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 12000);
        pending.set(id, m => { clearTimeout(t); resolve(m); });
        conn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      });
    };
    return (async () => {
      for (let i = 0; i < 60 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 250));
      await new Promise((resolve, reject) => {
        const c = net.connect(sock);
        let buf = '';
        c.on('connect', () => { conn = c; resolve(); });
        c.on('data', d => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
            const p = pending.get(msg.id);
            if (p) { pending.delete(msg.id); p(msg); }
          }
        });
        c.on('error', reject);
      });
      const r = await call('aspira_bridge_analyze', { input: '我并不认同这种做法' });
      const c = r.result && r.result.content;
      const j = JSON.parse(c && c[0] ? c[0].text : '{}');
      assertTrue(!j.error, `不得返回 error(实测 ${JSON.stringify(j.error)})`);
      assertTrue(!!j.stance, '应返回 stance');
      assertEqual(j.stance.stance, 'oppose',
        '「我并不认同这种做法」端到端必须判 oppose —— 曾判成 support(把否定当支持)');
    })().catch(e => { cleanup(); if (conn) conn.destroy(); throw e; })
      .then(() => { cleanup(); if (conn) conn.destroy(); });
  });
};
