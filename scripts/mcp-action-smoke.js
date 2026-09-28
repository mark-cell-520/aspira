#!/usr/bin/env node
/**
 * scripts/mcp-action-smoke.js — 对每个 MCP 工具的 action 做端到端冒烟
 *
 * ═══ 为什么需要这个脚本 ═══
 * 上两轮的教训链:
 *   · `aspira_forgetting` 的 `action` 参数是**死的** —— 处理器读了它却只
 *     回声回去，从不分支。请求 `action:"compress"` 返回一份
 *     `totalCompressions:0` 的 stats，什么都没做，而回声让 action
 *     *看起来*生效了。
 *   · `scripts/mcp-echo-audit.js` 把静态检查推到全部 181 个工具，
 *     形态一(action 只回声)归零。
 *   · 但那个脚本的头部就写着残余盲区:
 *       **只认 `return { action` 这一种回声写法。**
 *       若处理器写成 `return { action: action, ... }`、或先赋值给变量再返回、
 *       或用查找表 `H[action]()` 分派，静态扫描一律看不见。
 *
 * 所以本脚本不再做静态分析，而是**真的把每个 action 都调一遍**，
 * 看返回是否因 action 而异。这是唯一的最终判据。
 *
 * ═══ 判据 ═══
 * 一个 action 参数"活着"，必须满足: **不同 action 产生不同结果**。
 * 具体地，对每个工具的每一个 enum action:
 *   1. 发一个"裸调用"(只传 action，必填参数用最小合法值补齐)
 *   2. 记录返回 JSON 的**结构签名**(顶层键集合 + 各标量字段值)
 *   3. 若某工具的所有 action 返回**完全相同**的签名，且签名里含有
 *      回声出来的 `action` 字段 → 高度可疑(action 未被分派)
 *
 * ═══ 这个判据自身的盲区(必须写在头部) ═══
 * ① **参数不全会掩盖差异。** 若 compress 需要 memory 而 stats 不需要，
 *   裸调用下 compress 会返回"需要 memory"错误 —— 这**不算** action 失效，
 *   反而证明它分支了。本脚本因此把"返回了针对该 action 的参数错误"
 *   也视为**已分派**的证据。
 * ② **结果碰巧相同是可能的。** 例如两个 action 在空输入下都返回同样的
 *   "无数据"。这种会被误报为可疑。因此输出一律标注"待查"，
 *   每个命中都必须人工复现再下结论。
 * ③ **写操作需要授权。** `aspira_memory_write_control` / `aspira_memory_eraser`
 *   / `aspira_decision_decide` / `aspira_self_heal` 四个工具要 bearer token。
 *   本脚本用 admin token，但仍**不会**真正触发破坏性变更 ——
 *   它只调 action 列表里的值，且对明显危险的 action 提前跳过(见 DANGEROUS)。
 * ④ **有副作用的 action 会被真的执行。** 这是端到端冒烟的固有代价。
 *   已把已知危险动作(eraser 的 erase、write_control 的 reset 等)列入跳过表，
 *   但无法穷尽。**跑之前确认可以接受副作用。**
 * ⑤ **超时即视为"无法判定"**，不算缺陷。
 *
 * ═══ 已记录的教训 ═══
 * 这是 dimension-health(2)、dead-counter(2)、mcp-contract(4)、mcp-echo(3)
 * 之后，"仪器把自己的局限说成引擎缺陷"这一故障模式的第 12 次。
 * 因此本脚本: 输出标注"待查"、头部写清五个盲区、不断言总数。
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { TOOLS } = require(path.join(ROOT, 'src', 'mcp', 'tools-registry.js'));

// ─── 配置 ────────────────────────────────────────────────────────────
const SOCK = process.env.ASPIRA_SMOKE_SOCK || '/tmp/aspira-smoke.sock';
const TIMEOUT_MS = Number(process.env.ASPIRA_SMOKE_TIMEOUT || 8000);
const ONLY = process.argv[2] || null;   // 只测某个工具

// 已知危险 action: 端到端冒烟不应真的触发
const DANGEROUS = new Set([
  'erase', 'reset', 'clear', 'delete', 'purge', 'wipe', 'destroy',
  'resetAll', 'factoryReset', 'selfHeal', 'repair',
]);

// 每个工具的必填参数最小合法值(裸调用时补齐，避免被必填校验挡住)
// 只填"明显安全"的占位值
const FILL = {
  text: 'kill me киll',            // 同时覆盖同形字层
  input: 'kill me киll',
  query: 'test',
  answer: '测试答案',
  memory: { id: 'smoke', content: 'smoke test', timestamp: Date.now() },
  decision: { type: 'smoke', ruleId: 'smoke', confidence: 0.5, context: {} },
  context: 'smoke',
  skill: 'smoke-skill',
  domain: 'memory',
  params: {},
  materials: ['M1 材料'],
};

let nextId = 1;
const pending = new Map();
let conn = null;

function connect() {
  return new Promise((resolve, reject) => {
    const c = net.connect(SOCK);
    let buf = '';
    c.on('connect', () => { conn = c; resolve(c); });
    c.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      }
    });
    c.on('error', reject);
  });
}

function call(name, args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, TIMEOUT_MS);
    pending.set(id, m => { clearTimeout(t); resolve(m); });
    conn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

// 取返回的结构签名
function signature(resp) {
  try {
    const c = resp.result && resp.result.content;
    if (!c || !c[0]) return { kind: 'no-content' };
    const txt = c[0].text || '';
    let j;
    try { j = JSON.parse(txt); } catch (e) { return { kind: 'non-json', text: txt.slice(0, 60) }; }
    if (j && j.error) return { kind: 'error', error: String(j.error).slice(0, 80) };
    const keys = Object.keys(j).sort();
    const scalars = {};
    for (const k of keys) {
      const v = j[k];
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) scalars[k] = v;
    }
    return { kind: 'ok', keys, scalars };
  } catch (e) {
    return { kind: 'throw', error: e.message };
  }
}

function sigStr(s) {
  if (s.kind === 'ok') {
    const sc = Object.keys(s.scalars).map(k => `${k}=${JSON.stringify(s.scalars[k])}`).join(',');
    return `ok keys=[${s.keys.join(',')}] ${sc}`;
  }
  return `${s.kind}: ${s.error || s.text || ''}`;
}

function buildArgs(tool, action) {
  const args = { action };
  const props = (tool.inputSchema && tool.inputSchema.properties) || {};
  for (const [k, spec] of Object.entries(props)) {
    if (k === 'action') continue;
    if (FILL[k] !== undefined) { args[k] = FILL[k]; continue; }
    // 按类型给最小合法值
    if (spec.type === 'string') args[k] = 'smoke';
    else if (spec.type === 'number') args[k] = 0.5;
    else if (spec.type === 'boolean') args[k] = true;
    else if (spec.type === 'array') args[k] = ['smoke'];
    else if (spec.type === 'object') args[k] = {};
  }
  return args;
}

(async () => {
  // 启动 server(socket 模式)
  const token = crypto.randomBytes(16).toString('hex');
  const { spawn } = require('child_process');
  const proc = spawn('node', ['src/mcp-server.js', '--socket', SOCK], {
    cwd: ROOT, env: { ...process.env, ASPIRA_MCP_TOKEN: token }, stdio: 'ignore',
  });
  const cleanup = () => { try { proc.kill(); } catch (e) {} try { fs.unlinkSync(SOCK); } catch (e) {} };
  process.on('exit', cleanup);

  // 等 socket 就绪
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(SOCK)) break;
    await new Promise(r => setTimeout(r, 250));
  }
  await connect();

  console.log('\n=== MCP action 端到端冒烟(每个 action 真调一次) ===\n');

  const suspicious = [];
  const checked = [];
  const skipped = [];
  const errored = [];

  for (const tool of TOOLS) {
    if (ONLY && tool.name !== ONLY) continue;
    const props = (tool.inputSchema && tool.inputSchema.properties) || {};
    const spec = props.action;
    const actions = (spec && spec.enum) || [];
    if (!actions.length) { skipped.push(tool.name); continue; }

    const sigs = [];
    let anyDispatched = false;
    for (const a of actions) {
      if (DANGEROUS.has(a)) { skipped.push(`${tool.name}:${a}(危险)`); continue; }
      let resp;
      try {
        resp = await call(tool.name, buildArgs(tool, a));
      } catch (e) {
        errored.push(`${tool.name}:${a}(${e.message})`);
        continue;
      }
      const s = signature(resp);
      sigs.push({ a, s });
      // 盲区①的对策: 返回了针对该 action 的参数错误 = 已分派的证据
      if (s.kind === 'error' && /需要|必填|missing|required|未知|invalid|非法/i.test(s.error || '')) {
        anyDispatched = true;
      }
    }
    if (!sigs.length) continue;
    checked.push(tool.name);

    // 判据: 所有 action 签名完全相同 → 可疑
    const uniq = new Set(sigs.map(x => sigStr(x.s)));
    const allEchoAction = sigs.every(x => x.s.kind === 'ok' && x.s.keys.includes('action'));
    if (uniq.size === 1 && allEchoAction && !anyDispatched) {
      suspicious.push({ name: tool.name, sig: sigStr(sigs[0].s), n: sigs.length });
    }
  }

  console.log(`  工具总数: ${TOOLS.length}`);
  console.log(`  有 action enum 且已冒烟: ${checked.length}`);
  console.log(`  无 action enum(跳过): ${skipped.filter(s => !s.includes(':')).length}`);
  console.log(`  调用失败/超时(无法判定): ${errored.length}`);

  console.log(`\n  ── 所有 action 返回完全相同签名 (${suspicious.length}) ──`);
  for (const s of suspicious) {
    console.log(`    ${s.name}  (${s.n} 个 action 全同)`);
    console.log(`       ${s.s}`);
  }

  if (errored.length) {
    console.log(`\n  ── 调用失败(不计入判定) ──`);
    for (const e of errored.slice(0, 20)) console.log(`    ${e}`);
  }

  console.log('\n  盲区(命中≠缺陷，必须先复现):');
  console.log('    ① 参数不全会掩盖差异 —— 已把"针对该 action 的参数错误"算作已分派');
  console.log('    ② 结果碰巧相同(如空输入都返回"无数据")会被误报');
  console.log('    ③ 写操作需授权; 已知危险 action 已跳过，但无法穷尽');
  console.log('    ④ **有副作用的 action 会被真的执行** —— 跑前确认可接受');
  console.log('    ⑤ 超时视为"无法判定"，不算缺陷\n');

  try { conn.destroy(); } catch (e) {}
  cleanup();

  module.exports = { suspicious, checked, skipped, errored };
})().catch(e => { console.error('脚本异常:', e.message); process.exit(1); });
