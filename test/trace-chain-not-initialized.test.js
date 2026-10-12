/**
 * test/trace-chain-not-initialized.test.js — 空证据链不得被报告成"链完好"
 *
 * ═══ 背景: 一个挂了四十多轮的问题, 本轮才被回答 ═══
 * `src/trace-chain.js` 的头部注释写着"贯穿 checkInput→pipeline→gate→think→output
 * 全链路", 而 cycle 180 的 journal 留下待查: aspira_audit_trace 的空表是
 * "没有数据"还是"从没写入过"。
 *
 * 本轮实测答案: **从没写入过**。全仓对 initChain/appendEntry 的生产调用点是 0 个
 * (唯一调用者是 compliance 测试, 且写往 /tmp), 于是 _chain 恒为 []、
 * _chainFile 恒为 null, saveChain() 因无路径直接 return。
 *
 * 所以 `aspira_audit_trace` 这个被 agent-card 的 features、SKILL.md 的
 * "Audit traceability" 行、以及国标映射表"关口 5"共同对外声称的能力,
 * 永远只能回答两句话: 查询=空表, 校验={valid:true, length:0}。
 *
 * ═══ 值得整轮的那个形状 ═══
 * **一个不可能失败的完整性校验。** verifyChain() 在空链上返回 valid:true,
 * 于是一个问"我的证据链完好吗"的调用方, 得到的答案是"完好" ——
 * 而链里一条记录都没有。这与 cycle 28 的 memory-encrypt 同型:
 * 对未知状态静默返回一个看似成功的答案, 比报错更危险。
 *
 * ═══ 断言的边界 ═══
 * 本条**不接线**。哪些阶段入链、链文件放哪、每次 pipeline 调用写多少次盘,
 * 是产品判断(铁律 2 排除), 留给能做那件事的一轮。
 * 本条只锁一件事: "没有链"必须能被说出来, 且不得伪装成"链完好"。
 * 最后一例把"生产调用点仍为 0"这个结构性事实钉住, 并写明接线后该如何反转它。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TC = path.join(ROOT, 'src', 'trace-chain.js');
const SERVER = path.join(ROOT, 'src', 'mcp-server.js');

// 源码级 needle 一律用 indexOf 子串而非正则 —— cycle 223/224/225 三次转义地狱的教训。
const NOT_LIVE_REASON = '证据链从未被初始化';

// 行注释剥离(长度保持没有必要, 这里只需要"按行跳过注释行")。
// 之所以必须剥: 本轮自己的修复注释里写着 initChain 这个名字, 不剥就会把自己的
// 说明当成罪证 —— cycle-19/25/194/195/197/214/218/221 形状的第十二次。
function codeLines(src) {
  return src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

module.exports = function ({ test, assertEqual, assertTrue }) {

  // ─── ① 未初始化的链: verify 不得报 valid ────────────────────────
  test('未初始化的证据链: verifyChain 不得报 valid, 且必须说明为什么', () => {
    // 用**子进程**取"全新进程态": 模块级单例在本进程内一旦被 init 就永远是 live,
    // 同进程内测不出"从没初始化过"这个状态。cycle 215 的"一个状态一个子进程"纪律。
    const out = execFileSync(process.execPath, ['-e',
      'const tc=require(' + JSON.stringify(TC) + ');'
      + 'process.stdout.write(JSON.stringify({v:tc.verifyChain(),s:tc.chainState()}))'
    ], { encoding: 'utf8', cwd: ROOT });
    const { v, s } = JSON.parse(out.trim().split('\n').pop());

    assertTrue(v.valid === false,
      `未初始化的链不得判定为完整, 实测 valid=${v.valid} —— 这正是修复前的形状: 一个不可能失败的校验`);
    assertTrue(v.initialized === false, `未初始化时 initialized 必须为 false, 实测 ${v.initialized}`);
    assertTrue(String(v.reason || '').indexOf(NOT_LIVE_REASON) >= 0,
      `必须给出"从未被初始化"的理由, 实测 reason=${v.reason}`);
    assertTrue(s.live === false, `chainState().live 必须为 false, 实测 ${s.live}`);
    // 前提自证: 这条断言不是恒真的 —— 若模块真的被初始化过, 它必须红。
    assertTrue(s.length === 0 && s.chainFile === null,
      `前提: 新进程里确实没有任何条目与链文件, 实测 length=${s.length} chainFile=${s.chainFile}`);
  });

  // ─── ② 反向对照: 真链必须仍然被判为完好, 且断裂必须仍然被抓到 ───
  test('反向对照: init + append 之后 verifyChain 仍必须报 valid, 篡改必须仍报断裂', () => {
    // 每次运行一个**独立**临时目录。首版用了固定路径 /tmp/tc-lock226.json,
    // 于是第二次运行 initChain 会把上一次留下的记录整条读回来 —— 实测条数
    // 从 2 涨到 26, 而那是本机 /tmp 的残留, 不是引擎的状态。
    // cycle 207 记的就是这个形状: 一个测试的结果取决于调用方机器上恰好躺着什么。
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tc-lock226-'));
    const file = path.join(dir, 'chain.json');
    try {
      const ev = (code) => execFileSync(process.execPath, ['-e', code],
        { encoding: 'utf8', cwd: ROOT }).trim().split('\n').pop();
      const v = JSON.parse(ev(
        'const tc=require(' + JSON.stringify(TC) + ');'
        + 'tc.initChain(' + JSON.stringify(file) + ');'
        + 'tc.appendEntry({traceId:"T1",stage:"s1",agentId:"a"});'
        + 'tc.appendEntry({traceId:"T1",stage:"s2",agentId:"a"});'
        + 'process.stdout.write(JSON.stringify(tc.verifyChain()))'
      ));
      assertEqual(v.valid, true, `初始化并追加 2 条后必须判定为完好, 实测 ${JSON.stringify(v)}`);
      assertEqual(v.length, 2, `条数必须是 2, 实测 ${v.length}`);
      assertEqual(v.initialized, true, `初始化后 initialized 必须为 true, 实测 ${v.initialized}`);

      // 断裂仍必须被抓到: "完好"不是放行一切。
      // queryChain 返回的是 _chain 里**同一个记录对象**(slice 只复制数组),
      // 所以改它的 prevHash 就是改链本身。
      const vb = JSON.parse(ev(
        'const tc=require(' + JSON.stringify(TC) + ');'
        + 'tc.initChain(' + JSON.stringify(file) + ');'
        + 'tc.appendEntry({traceId:"T1",stage:"s1",agentId:"a"});'
        + 'tc.appendEntry({traceId:"T1",stage:"s2",agentId:"a"});'
        + 'tc.queryChain({})[1].prevHash="TAMPERED-BY-LOCK";'
        + 'process.stdout.write(JSON.stringify(tc.verifyChain()))'
      ));
      assertEqual(vb.valid, false,
        `篡改第 2 条的 prevHash 后必须报断裂(否则"校验"只是个摆设), 实测 ${JSON.stringify(vb)}`);
      assertEqual(vb.breakIndex, 1, `断裂点必须是索引 1, 实测 ${vb.breakIndex}`);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ─── ③ MCP 工具面: 空表必须与"没有链"可区分 ─────────────────────
  test('aspira_audit_trace: query 必须把"空结果"与"没有链"分开, tags 不得被修坏', () => {
    const { HANDLERS } = require(path.join(ROOT, 'src', 'mcp-server.js'));
    const q = HANDLERS.aspira_audit_trace({ action: 'query', limit: 5 }, 'sess-lock-226');
    assertTrue(q && typeof q === 'object' && !q.error,
      `query 不得报错, 实测 ${JSON.stringify(q).slice(0, 120)}`);
    assertTrue(Array.isArray(q.entries),
      `query 必须仍返回 entries 数组, 实测 ${JSON.stringify(q).slice(0, 120)}`);
    assertTrue(q.chain && q.chain.live === false,
      `query 必须随附 chain 状态且 live=false, 实测 ${JSON.stringify(q.chain)}`);
    assertTrue(String(q.chain.reason || '').indexOf(NOT_LIVE_REASON) >= 0,
      `chain.reason 必须说明链从未被初始化, 实测 ${q.chain && q.chain.reason}`);

    const v = HANDLERS.aspira_audit_trace({ action: 'verify' }, 'sess-lock-226');
    assertTrue(v.valid === false,
      `verify 不得对空链报 valid, 实测 ${JSON.stringify(v)}`);

    const t = HANDLERS.aspira_audit_trace({ action: 'tags' }, 'sess-lock-226');
    assertTrue(Array.isArray(t.tags) && t.tags.length === 16,
      `16 个违规标签不得被本轮改动影响, 实测 ${t.tags && t.tags.length}`);
  });

  // ─── ④ 源码级: 死解构与导出必须在位 ────────────────────────────
  test('源码级: handler 不得再解构从不调用的 initChain, 且 chainState 必须导出并被用', () => {
    const srv = codeLines(fs.readFileSync(SERVER, 'utf8'));
    // 取 handler 体: 从 aspira_audit_trace: (args) 到下一个顶层 key
    const start = srv.indexOf('aspira_audit_trace: (args)');
    assertTrue(start >= 0, '锚点失效: 找不到 aspira_audit_trace handler');
    const rest = srv.slice(start);
    const end = rest.indexOf('\n  aspira_circuit_breaker:');
    assertTrue(end > 0, '锚点失效: 找不到 handler 的结束边界');
    const body = rest.slice(0, end);

    assertTrue(body.indexOf('const { queryChain') >= 0,
      'handler 必须仍解构 queryChain');
    assertTrue(body.indexOf('initChain') === -1,
      'handler 不得再解构从未调用的 initChain —— cycle 195 的 LEVELS 形状: 名字被导入、被列出、从不执行');
    assertTrue(body.indexOf('chainState') >= 0,
      'handler 必须消费 chainState, 否则"没有链"仍然说不出口');

    const tc = codeLines(fs.readFileSync(TC, 'utf8'));
    assertTrue(tc.indexOf('chainState,') >= 0, 'trace-chain 必须导出 chainState');
    assertTrue(tc.indexOf('function chainState()') >= 0, 'trace-chain 必须定义 chainState');
    // 前提自证: 剥离注释没有把真代码剥掉
    assertTrue(tc.indexOf('function verifyChain()') >= 0 && tc.indexOf('function queryChain(') >= 0,
      '前提失效: 注释剥离把真代码剥掉了, 本条断言将恒真');
  });

  // ─── ⑤ 反向证明: 旧行为必须能被复现, 且复现用的副本没有坏 ──────
  test('反向证明: 还原旧 verifyChain 后, 未初始化的链必须重新报 valid:true', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tc-rp226-'));
    const broken = path.join(dir, 'tc-broken.js');
    const chainFile = path.join(dir, 'chain.json');
    const orig = fs.readFileSync(TC, 'utf8');
    // 旧行为: 空链直接 return { valid: true, length: 0 }
    const OLD = 'function verifyChain() {\n  const st = chainState();';
    const NEW = 'function verifyChain() {\n  if (_chain.length === 0) return { valid: true, length: 0 };\n  const st = chainState();';
    assertTrue(orig.indexOf(OLD) >= 0,
      '锚点失效: 找不到 verifyChain 的开头两行, 反向证明无法进行(而不是静默通过)');
    fs.writeFileSync(broken, orig.replace(OLD, NEW));
    const ev = (code) => execFileSync(process.execPath, ['-e', code],
      { encoding: 'utf8', cwd: ROOT }).trim().split('\n').pop();
    try {
      // trace-chain.js 只依赖 node 内置 crypto, 副本可独立加载 —— 不需要改 src/
      const v = JSON.parse(ev(
        'const tc=require(' + JSON.stringify(broken) + ');'
        + 'process.stdout.write(JSON.stringify(tc.verifyChain()))'
      ));
      assertTrue(v.valid === true && v.initialized === undefined,
        `还原旧行为后空链必须重新报 valid:true(否则本锁抓不到原缺陷), 实测 ${JSON.stringify(v)}`);

      // 反向对照: 同一个副本在 init 之后仍必须能验真链 —— 否则"报 valid:true"
      // 可能只是一个坏副本的恒真输出, 证明不了任何事。
      const v2 = JSON.parse(ev(
        'const tc=require(' + JSON.stringify(broken) + ');'
        + 'tc.initChain(' + JSON.stringify(chainFile) + ');'
        + 'tc.appendEntry({traceId:"T1",stage:"s1",agentId:"a"});'
        + 'process.stdout.write(JSON.stringify(tc.verifyChain()))'
      ));
      assertEqual(v2.valid, true, `反向对照: 副本在 init 后必须仍判真链完好, 实测 ${JSON.stringify(v2)}`);
      assertEqual(v2.length, 1, `反向对照: 副本必须真的数到 1 条, 实测 ${v2.length}`);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // ─── ⑥ 披露: 生产调用点仍为 0, 接线后请反转本例 ────────────────
  test('披露: initChain/appendEntry 的生产调用点仍为 0(接线后请反转本例, 不要删)', () => {
    // 只扫 src/: 测试与 memory/ 里的历史 journal 提到这些名字不算"生产写入方"。
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'archive') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const t = codeLines(fs.readFileSync(p, 'utf8'));
        for (const needle of ['initChain(', 'appendEntry(']) {
          const i = t.indexOf(needle);
          // trace-chain.js 自身是定义处; mcp-server.js 是工具面, 两侧都不算写入方
          if (i < 0) continue;
          if (p === TC) continue;
          if (p === SERVER && t.slice(Math.max(0, i - 400), i).indexOf('aspira_audit_trace') >= 0) continue;
          hits.push(path.relative(ROOT, p) + ' ' + needle);
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    assertEqual(hits.length, 0,
      '若这里变红, 说明**已经有生产代码给证据链写入数据了** —— 这是好消息: '
      + '请把本例反转为"链必须被写入"的断言, 并删掉 trace-chain.js 头部那段'
      + '"没有任何生产调用方"的注释。新写入方: ' + hits.join(' | '));
  });
};
