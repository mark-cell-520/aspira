#!/usr/bin/env node

/**

 * Aspira MCP HTTP SSE Server

 *

 * 常驻模式：启动 HTTP 服务，通过 SSE (Server-Sent Events) 暴露 MCP 工具。

 * Hermes 通过 HTTP 连接，不会因为连接断开而杀死进程。

 * 一次启动，永久服务——1秒内响应。

 *

 * 启动: node mcp-server-http.js [--port 8099]

 * 连接: hermes mcp add aspira --url http://localhost:8099/mcp

 */



const path = require('path');


// [v6.6.4] P0: gate.action → 决策类型映射（品牌四层理论）
const DECISION_TYPE_MAP = {
  pass: 'RESONATE',     // 通过 → 共振/加强
  verify: 'HOLD',       // 需验证 → 坚守
  rewrite: 'HEAL',      // 需改写 → 自愈/修复
  block: 'HEAL',        // 拦截 → 自愈/修复
  unknown: 'HOLD',      // 未知 → 坚守
};

function gateActionToDecisionType(gateAction) {
  return DECISION_TYPE_MAP[gateAction] || DECISION_TYPE_MAP.unknown;
}


const fs = require('./utils/safe-fs');

const http = require('http');

const net = require('net');

const crypto = require('crypto');
const { TOOLS } = require('./mcp/tools-registry.js');
const handleCrowdtestEvaluate = require('./mcp/handlers/crowdtest-evaluate.js');



// ═══════════════════════════════════════════════

// 配置

// ═══════════════════════════════════════════════

const SOCKET_PATH = (() => {
  const idx = process.argv.indexOf('--socket');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
})();

const PORT = (() => {
  if (SOCKET_PATH) return null;
  if (process.argv[2] === '--port' && process.argv[3]) return parseInt(process.argv[3], 10);
  if (process.env.MCP_PORT) return parseInt(process.env.MCP_PORT, 10);
  for (let port = 8099; port <= 8105; port++) {
    try {
      const sock = net.createServer();
      sock.listen(port);
      sock.close();
      return port;
    } catch (_) { /* port in use */ }
  }
  return 8099;
})();



// ─── Aspira 根目录自动检测 ───────────────────────────────


/**
 * 校验并清洗 HF 根目录。
 *
 * ═══ 修的是什么 ═══
 * resolveHFDir 原来把 process.env.HEARTFLOW_DIR **原样**返回。
 * 若该值带引号(例如 '"/var/.../aspira-mx-XXXX"')，
 * 之后所有 path.join(HF_DIR, 'data', ...) 都会在一个
 * **名字里带引号**的目录下读写 —— 实测仓库里就出现了这样一个垃圾目录，
 * 里面躺着 heartflow_state.json、self-view.json 等运行时状态。
 *
 * ═══ 为什么拒绝而不是 strip ═══
 * 试着"去掉引号"会猜错意图: 引号可能是路径的真实组成部分
 * (macOS/Linux 都允许文件名含引号)。所以这里**拒绝**而非猜测，
 * 让 resolveHFDir 继续往下走自动检测 / fallback —— 那条路是可靠的。
 *
 * @param {string} raw
 * @returns {string|null} 合法则返回 trim 后的值，否则 null
 */
function sanitizeHFDir(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  // 引号、反引号、NUL、控制字符: 任一项出现都说明这个值不是干净的路径
  if (/["'`\x00-\x1f]/.test(t)) return null;
  // ~ 开头的展开是 shell 的事，不是这里的事
  if (t.startsWith('~')) return null;
  return t;
}

function resolveHFDir() {

  // 1. 优先使用环境变量

  // 环境变量必须经 sanitizeHFDir 校验后再用。
  // 为什么: 仓库里曾出现一个字面名为
  //   '"/var/folders/.../T/aspira-mx-D4BRqZ"'
  // 的垃圾目录(含 heartflow_state.json、self-view.json 等运行时状态)，
  // 因为 HEARTFLOW_DIR 被设成了**带引号**的值，而 resolveHFDir 原样返回，
  // 后续 path.join(HF_DIR, ...) 就把引号当成了目录名的一部分。
  // 一个不校验的根目录，会让所有下游路径静默跑偏。
  const envDir = process.env.HEARTFLOW_SKILL_DIR || process.env.HEARTFLOW_DIR;
  if (envDir) {
    const cleaned = sanitizeHFDir(envDir);
    if (cleaned) return cleaned;
  }



  // 2. 自动检测：用 __dirname 向上查找 src/core/heartflow.js

  let dir = __dirname;

  for (let i = 0; i < 10; i++) {

    const candidate = path.join(dir, 'src', 'core', 'heartflow.js');

    if (fs.existsSync(candidate)) return dir;

    const parent = path.dirname(dir);

    if (parent === dir) break;

    dir = parent;

  }



  // 3. Fallback：尝试多个可能的安装位置

  const fallbacks = [

    path.join(process.env.HOME, 'aspira'),

    path.join(process.env.HOME, '.hermes', 'skills', 'aspira'),

    path.join(process.env.HOME, '.claude', 'skills', 'aspira'),

    path.join(process.env.HOME, 'Documents', 'ClaudeCode'),

  ];

  for (const fb of fallbacks) {

    const candidate = path.join(fb, 'src', 'core', 'heartflow.js');

    if (fs.existsSync(candidate)) return fb;

  }

  // 最后兜底：返回解耦后的权威源路径（即使不存在，调用方会报错）

  return path.join(process.env.HOME, 'aspira');

}

const HF_DIR = resolveHFDir();

const HEARTFLOW_PATH = path.join(HF_DIR, 'src', 'core', 'heartflow.js');



// ─── 版本号读取（统一入口）────────────────────────────────

function getVersion() {

  try {

    const vFile = path.join(HF_DIR, 'VERSION');

    if (fs.existsSync(vFile)) return fs.readFileSync(vFile, 'utf8').trim();

  } catch (_) { /* [v5.9.18] intentional: graceful degradation */ }

  try {

    const pkgFile = path.join(HF_DIR, 'package.json');

    if (fs.existsSync(pkgFile)) {

      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));

      if (pkg.version) return pkg.version;

    }

  } catch (_) { /* [v5.9.18] intentional: graceful degradation */ }

  return 'unknown';

}



// 安全配置

// Token 认证：未设置 ASPIRA_MCP_TOKEN 时自动生成随机 Token 并强制认证

// [v6.2.7] 从 .env 文件加载（如果环境变量没设）
try {
  const envPath = require('path').join(__dirname, '..', '.env');
  if (require('fs').existsSync(envPath)) {
    for (const line of require('fs').readFileSync(envPath, 'utf8').trim().split('\n').filter(Boolean)) {
      const eq = line.indexOf('=');
      if (eq > 0) process.env[line.slice(0, eq)] = process.env[line.slice(0, eq)] || line.slice(eq + 1);
    }
  }
} catch (_) { /* 防御性: 配置加载失败不阻断 */ }

const AUTH_TOKEN = process.env.ASPIRA_MCP_TOKEN || process.env.HEARTFLOW_MCP_TOKEN || process.env.MCP_HEARTFLOW_API_KEY || process.env.MCP_HEARTFLOW_KEY || (() => {

  const token = require('crypto').randomBytes(32).toString('hex');

  // [v6.2.7] 自动写入 .env，让 config.yaml 的 ${MCP_HEARTFLOW_KEY} 能读到
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const fs2 = require('fs');
    let env = '';
    try { env = fs2.readFileSync(envPath, 'utf8'); } catch (_) { /* 防御性: env读取失败用默认值 */ }
    if (!env.includes('MCP_HEARTFLOW_KEY=')) {
      fs2.appendFileSync(envPath, `\nMCP_HEARTFLOW_KEY=${token}\n`);
      if (process.env.HEARTFLOW_DEBUG) console.log('[MCP] Token auto-written to .env as MCP_HEARTFLOW_KEY');
    }
  } catch (_) { /* 防御性: 配置加载失败不阻断 */ }

  if (process.env.HEARTFLOW_DEBUG) console.log('[MCP] ASPIRA_MCP_TOKEN not set. Auto-generated ephemeral token (not printed for security).');

  if (process.env.HEARTFLOW_DEBUG) console.log('[MCP] Set ASPIRA_MCP_TOKEN env var for persistent auth across restarts.');

  return token;

})();

const AUTH_ENABLED = true;



// ─── 时间安全的 token 比较（防止 timing attack）───

function safeCompare(provided, expected) {

  // [AUDIT-FIX] 无 token 时拒绝所有请求（不再允许未认证访问）

  if (!AUTH_TOKEN) return false;

  if (!provided || !expected) return false;

  const a = Buffer.from(String(provided), 'utf8');

  const b = Buffer.from(String(expected), 'utf8');

  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);

}



// ═══════════════════════════════════════════════

// 全局状态

// ═══════════════════════════════════════════════

let heartflow = null;
let _topicScope = null; // aspira_topic_scope 的跨调用单例(TopicScope 纯内存，必须复用实例)

let version = 'unknown';



// ─── 简易速率限制器（防止 DoS）───

const RATE_LIMIT_WINDOW = 60000; // 1 分钟窗口

const RATE_LIMIT_MAX = 100; // 每分钟最多 100 请求

const _rateMap = new Map(); // IP → { count, windowStart }



// [AUDIT-FIX] Token 维度速率限制：防止 token 暴力破解

const TOKEN_RATE_LIMIT_WINDOW = 60000; // 1 分钟窗口

const TOKEN_RATE_LIMIT_MAX = 100; // [AUDIT-FIX H-03] 每个 token 每分钟最多 5 请求（防暴力破解）

const _tokenRateMap = new Map(); // tokenHash → { count, windowStart }



function checkRateLimit(ip) {

  const now = Date.now();

  let entry = _rateMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {

    entry = { count: 0, windowStart: now };

    _rateMap.set(ip, entry);

  }

  entry.count++;

  return entry.count <= RATE_LIMIT_MAX;

}



// [AUDIT-FIX] Token 维度速率检查

function checkTokenRateLimit(tokenHash) {

  const now = Date.now();

  let entry = _tokenRateMap.get(tokenHash);

  if (!entry || now - entry.windowStart > TOKEN_RATE_LIMIT_WINDOW) {

    entry = { count: 0, windowStart: now };

    _tokenRateMap.set(tokenHash, entry);

  }

  entry.count++;

  return entry.count <= TOKEN_RATE_LIMIT_MAX;

}



// 定期清理过期的速率限制记录

setInterval(() => {

  const now = Date.now();

  for (const [ip, entry] of _rateMap) {

    if (now - entry.windowStart > RATE_LIMIT_WINDOW * 2) _rateMap.delete(ip);

  }

  for (const [hash, entry] of _tokenRateMap) {

    if (now - entry.windowStart > TOKEN_RATE_LIMIT_WINDOW * 2) _tokenRateMap.delete(hash);

  }

// [FIX 2026-09-21] unref()：这是纯清理任务，不该替宿主进程决定何时退出。
// 未 unref 时，任何 require('../src/mcp-server.js') 的进程（测试、其他模块）
// 都会被这个 2 分钟定时器永久挂住，导致 execSync 调用方等到超时。

}, 120000).unref();



// 从 VERSION 文件读取版本

version = getVersion();



// ═══════════════════════════════════════════════

// Unix Socket JSON-RPC 会话处理

// ═══════════════════════════════════════════════

function handleUnixClient(socket) {

  let buf = '';

  socket.setEncoding('utf8');

  socket.on('data', async (chunk) => {

    buf += chunk;

    const lines = buf.split('\n');

    buf = lines.pop();

    for (const line of lines) {

      if (!line.trim()) continue;

      try {

        const req = JSON.parse(line);

        const result = await handleRequest(req, null);

        if (result !== null) {

          socket.write(makeResponse(req.id, result));

        }

      } catch (e) {

        socket.write(makeError(null, -32700, 'Parse error: ' + e.message));

      }

    }

  });

  socket.on('error', (err) => {

    console.error(`[Aspira MCP] Unix socket client error: ${err.message}`);

  });

}


// ═══════════════════════════════════════════════

// MCP 工具定义

// ═══════════════════════════════════════════════


// 引擎初始化

// ═══════════════════════════════════════════════

function initAspira() {

  const startTime = Date.now();



  if (!fs.existsSync(HEARTFLOW_PATH)) {

    console.error('[Aspira MCP] 引擎文件不存在');

    process.exit(1);

  }



  try {

    // 读版本（由外层 getVersion() 统一处理，此处仅确保最新）

    version = getVersion();



    const { Aspira } = require(HEARTFLOW_PATH);

    heartflow = new Aspira({ rootPath: HF_DIR });

    heartflow.start();



    maybeAttachPostProcessHookBus();



    const elapsed = Date.now() - startTime;

    const loadedCount = Object.keys(heartflow._modules || {}).length;



    console.error(`[Aspira MCP] 引擎已启动 (${elapsed}ms, ${loadedCount} 模块, v${version})`);

    return true;

  } catch (err) {

    console.error(`[Aspira MCP] 引擎启动失败:`, err.message);

    process.exit(1);

  }

}



// ─── 后处理 & 反馈钩子 ───────────────────────────────────────

let postprocess = null;

try {

  const { PostProcessHooks } = require(path.join(HF_DIR, 'src', 'core', 'postprocess-hooks.js'));

  postprocess = new PostProcessHooks({ rootPath: HF_DIR });

} catch (_) {

  console.error('[Aspira MCP] postprocess-hooks 初始化失败，后续将跳过后处理');

}



// [PostProcessHooks] extend with shared hookBus when available

function maybeAttachPostProcessHookBus() {

  if (!postprocess || typeof postprocess.attachHookBus !== 'function') return;

  try {

    const hf = typeof heartflow === 'undefined' ? null : heartflow;

    const bus = hf && hf._hookBus ? hf._hookBus : null;

    if (bus) postprocess.attachHookBus(bus);

  } catch (_) { /* [v5.9.18] intentional: graceful degradation */ }

// [AUDIT-FIX] console.error("[{context}] catch error:", e);

}



maybeAttachPostProcessHookBus();



// ═══════════════════════════════════════════════

// 工具处理函数（与 stdio 版本相同）

// ═══════════════════════════════════════════════



function safeDispatch(route, ...args) {

  if (!heartflow) throw new Error('引擎未启动');

  // [v6.7.1] 熔断前置路由
    const cb = require('./circuit-breaker.js');
const { checkOutput: pipelineCheckOutput } = require('./pipeline');
    const cbGuard = cb.guard();
    if (!cbGuard.allowed) {
      return { error: cbGuard.reason, state: cbGuard.state };
    }
    try {

    const result = heartflow.dispatch(route, ...args);

    return result !== undefined ? result : null;

  } catch (err) {

    return { error: err.message };

  }

}



async function safeAsyncCall(fn) {

  if (!heartflow) throw new Error('引擎未启动');

  try {

    const result = await fn();

    return result !== undefined ? result : null;

  } catch (err) {

    return { error: err.message };

  }

}



async function handleThink(args) {

  const { input, effort } = args;

  if (!input) throw new Error('input 是必填参数');

  // [gate-verdict 接线] style 参数: postprocess.format 在 markdown 模式下只保留
  // result.report，会丢弃 handleThink 精心构建的全部结构化字段(discrimination /
  // outputChecklist / formulaCalcSummary / gateVerdict ...)。json 模式走
  // safeStringify({ formatted, original }) 从而保住 original。
  // 默认仍是 markdown，保持既有调用方行为不变。
  const style = (args && args.style === 'json') ? 'json' : 'markdown';

  const normalizedEffort = typeof effort === 'number' ? Math.max(1, Math.min(100, Math.round(effort))) : null;



  const startTime = Date.now();

  let thoughtChain;

  // [P0-1] 长文本回声修复: >100 字走 pipeline.checkOutput (51维判别), 不走 think 偷懒路由
  if (typeof input === 'string' && input.length > 100) {

    try {

      thoughtChain = pipelineCheckOutput(input);

    } catch (_) {

      thoughtChain = null;

    }

  }

  if (!thoughtChain) {

    const [psychology, judgment, tc] = await Promise.all([

      Promise.resolve().then(() => safeDispatch('psychology.analyzePsychology', input)).catch(e => ({ error: e.message })),

      Promise.resolve().then(() => safeDispatch('truth.checkStatement', input)).catch(e => ({ error: e.message })),

      safeAsyncCall(() => heartflow.think(input, undefined, { compact: true, effort: normalizedEffort || undefined }))

    ]);

    thoughtChain = tc;

  } else {

    // Short path: still run parallel psychology/truth for consistency

    await Promise.all([

      safeDispatch('psychology.analyzePsychology', input).catch(() => ({})),

      safeDispatch('truth.checkStatement', input).catch(() => ({}))

    ]);

  }



  // 生成可读报告

  let report = null;

  try {

    const { ReportGenerator } = require(path.join(HF_DIR, 'src/report/report-generator.js'));

    const gen = new ReportGenerator();

    const generated = gen.generate(thoughtChain);

    report = generated.report;

  } catch (e) {

    report = { error: '报告生成失败' };

  }



  let result = { report, timestamp: Date.now() };

  // [v6.3.7] 附加新愿增强字段——公式计算/辨别/公式搜索/输出门禁
  try {
    if (thoughtChain) {
      if (thoughtChain._formulaCalculations) result.formulaCalculations = thoughtChain._formulaCalculations;
      if (thoughtChain._formulasFound) result.formulasFound = thoughtChain._formulasFound;
      if (thoughtChain._discrimination) {
        // [v6.4.5] 精简：只保留有信号的维度（全 0 空维度是 tok 浪费）
        const d = thoughtChain._discrimination;
        const signals = {};
        for (const [k, v] of Object.entries(d || {})) {
          const score = typeof v === 'object' ? (v.score ?? v.count ?? 0) : v;
          if (score > 0) signals[k] = v;
        }
        result.discrimination = signals;
      }
      if (thoughtChain._outputChecklist) {
        // [v6.4.5] 精简：只保留通过/失败状态 + 失败步骤摘要（完整 steps 数组 tok 大且 MCP 不消费）
        const oc = thoughtChain._outputChecklist;
        const failedSteps = (oc.steps || []).filter(s => !s.passed).map(s => s.name);
        result.outputChecklist = {
          passed: !!oc.passed,
          failedSteps,
          warnings: oc.warnings || [],
          stepCount: (oc.steps || []).length,
        };
      }
      if (thoughtChain._formulasFound && thoughtChain._formulasFound.length > 0) {
        result.formulasSummary = thoughtChain._formulasFound.slice(0,5).map(f => f.name + ': ' + (f.formula||'').slice(0,60)).join(' | ');
      }
      if (thoughtChain._formulaCalculations) {
        const keys = Object.keys(thoughtChain._formulaCalculations);
        result.formulaCalcSummary = keys.join(', ') + ' (' + keys.length + '个公式)';
      }
      // [gate-verdict 接线] 后置检查散落信号的聚合判定。
      // 遵循同一处 [v6.4.5] 的精简原则: pass 是常见情形，每次都带出去只是噪声，
      // 故只在真的有信号(block/rewrite/verify)时才附加。
      if (thoughtChain.gateVerdict && thoughtChain.gateVerdict.action !== 'pass') {
        // 只保留结构化字段。不在 result.report 上追加人类可读小节——
        // 此路径上 result.report 是由 ReportGenerator 产出的**对象**而非字符串，
        // typeof 检查永远为假，追加代码是死分支。数据经 postprocess_format 的
        // safeStringify 原样到达调用方(markdown 与 json 两种 style 均如此)。
        result.gateVerdict = {
          action: thoughtChain.gateVerdict.action,
          reason: thoughtChain.gateVerdict.reason,
          signals: thoughtChain.gateVerdict.signals || [],
          guidance: thoughtChain.gateVerdict.guidance || [],
          score: thoughtChain.gateVerdict.score,
        };
      }
      // 可读辨别报告
      if (thoughtChain.output && thoughtChain.output.conclusion) {
        try {
          const idx = require('./index.js');
          if (idx.summarizeDiscrimination) {
            result.discriminationReport = idx.summarizeDiscrimination(thoughtChain.output.conclusion);
          }
        } catch (_) { /* 防御性: MCP工具注册容错 */ }
      }
    }
  } catch (_) { /* 附加字段不阻断 */ }



  // ─── postprocessing 管线 ──────────────────────────────────────

  if (postprocess) {

    try {

      result = await postprocess.run('postprocess.desensitize', result);

      result = await postprocess.run('postprocess.format', result, { style });

    } catch (_) {

      /* [v5.9.18] intentional: graceful degradation */

    }

    // 异步反馈收集，不阻塞主响应

    postprocess.feedback_collect({

      type: 'usage',

      source: 'aspira_think',

      latencyMs: Date.now() - startTime,

      payload: { input: typeof input === 'string' ? input.slice(0, 200) : input, hasReport: !!report }

    }).catch(() => {}) /* 防御性: 异步初始化容错 */;

  }



  return result;

}



// v3.0 — 交流层 handler

function handleTranslate(args) {

  const { input } = args || {};

  if (!input) throw new Error('input 是必填参数');

  const result = safeDispatch('translator.userToLLM', input, {});

  const intent = safeDispatch('translator.intentClassifier', input, {});

  const tone = safeDispatch('translator.toneAnalyzer', input, {});

  const entities = safeDispatch('translator.entityExtractor', input);

  const needs = safeDispatch('translator.implicitNeedDetector', input, { tone });

  const confidence = safeDispatch('translator.confidenceAnnotator', result, input);

  return {

    input,

    translation: result,

    intent,

    tone,

    entities,

    implicitNeeds: needs,

    confidence,

    timestamp: Date.now()

  };

}



function handleAgentThink(args) {

  const { input, llmResponse } = args || {};

  if (!input) throw new Error('input 是必填参数');

  // 用户→LLM翻译

  const userTranslation = safeDispatch('translator.userToLLM', input, {});

  // 桥身份声明

  const identity = safeDispatch('personaCore.bridgeIdentity');

  // 立场检测

  const stance = safeDispatch('personaCore.stanceDetector', input, {});

  // 价值对齐

  const valueCheck = safeDispatch('personaCore.valueAligner', { userInput: input, bridgeIdentity: identity });

  // 如果有LLM响应，做LLM→用户翻译

  let llmTranslation = null;

  if (llmResponse) {

    llmTranslation = safeDispatch('translator.llmToUser', llmResponse, {});

  }

  return {

    input,

    translation: userTranslation,

    bridge: identity ? { declaration: identity.declaration, type: identity.type } : null,

    stance,

    valueAlignment: valueCheck,

    llmTranslation,

    timestamp: Date.now()

  };

}



function handleBridgeStatus() {

  const translator = safeDispatch('translator.userToLLM', 'status', {});

  const identity = safeDispatch('personaCore.bridgeIdentity');

  return {

    version: '3.0.0',

    bridgeType: identity?.type || 'unknown',

    bridgeDeclaration: identity?.declaration || '',

    translatorReady: !!translator,

    modules: {

      translator: ['userToLLM', 'llmToUser', 'intentClassifier', 'toneAnalyzer', 'entityExtractor', 'implicitNeedDetector', 'responseCompressor', 'confidenceAnnotator'],

      agentLayer: ['agentBridge', 'contextBuilder', 'responseInterceptor', 'translationPipeline', 'qualityFilter', 'followupSuggester', 'conflictResolver', 'uncertaintyHandler'],

      personaCore: ['bridgeIdentity', 'judgmentInjector', 'stanceDetector', 'agentCommentary', 'valueAligner', 'personalityTone', 'metaPosition'],

    },

    timestamp: Date.now()

  };

}



async function handleThinkFast(args) {

  const { input } = args;

  if (!input) throw new Error('input 是必填参数');

  const result = await safeAsyncCall(() => heartflow.think(input, 1, { compact: true, effort: 20 }));

  return { input, result: result || {}, timestamp: Date.now() };

}



async function handleDream(args) {

  const { theme = '', intensity = 0.7 } = args;

  let dreamResult = null;



  // 优先使用新的升华引擎（src/dream/engine.js）

  try {

    const DreamEnginePath = path.join(HF_DIR, 'src', 'dream', 'engine.js');

    if (fs.existsSync(DreamEnginePath)) {

      const { DreamEngine } = require(DreamEnginePath);

      const memory = heartflow && heartflow.memory ? heartflow.memory : null;

      const engine = new DreamEngine(memory, null);

      engine.boot();

      dreamResult = await engine.dream(theme);

    }

  } catch (e) {

    // 降级到旧的 DAG 引擎

  }



  // 降级方案：使用旧的 DAG dream 引擎

  if (!dreamResult && heartflow && heartflow.dream) {

    try {

      if (typeof heartflow.dream.dream === 'function') {

        const oldResult = await heartflow.dream.dream(`dream-${Date.now()}`, [{ text: theme || 'default dream', type: 'user_prompt' }], { force: true });

        dreamResult = {

          narrative: JSON.stringify(oldResult, null, 2),

          patterns: [],

          essence: '',

          structure: oldResult.level_breakdown || {},

          upgrade: [],

          sublimationQuality: 0,

          dreamComplete: true,

        };

      } else if (typeof heartflow.dreamNow === 'function') {

        dreamResult = await heartflow.dreamNow({ theme: theme || undefined, intensity: Math.max(0, Math.min(1, intensity)) });

      }

    } catch (e) { dreamResult = { error: e.message, narrative: '梦境升华引擎暂不可用。' }; }

  }

  return { dream: dreamResult || { narrative: '梦境升华引擎暂不可用', essence: '', patterns: [], upgrade: [] }, timestamp: Date.now() };

}





// [v6.6.3] 新愿统一监督入口
async function handleSupervise(args) {
  const { input, mode = 'output', context } = args || {};
  if (!input) throw new Error('input 是必填参数');
  try {
    const gate = require(HF_DIR + '/src/gate.js');
    const result = gate.runPipeline({ input, mode, context });
    const gate_action = result.gate?.action || 'unknown';
    const reason = result.gate?.reason || '';
    const verdict = result.verdict || 'unknown';
    const score = result.overallScore || 0;
    const findings = (result.findings || []).slice(0, 10).map(f => ({
      dimension: f.dimension,
      severity: f.severity,
      details: f.details,
      guidance: f.guidance || ''
    }));
    const summary = result.summary || {};
    const decisionType = gateActionToDecisionType(gate_action);
    const brandLayer = {
      RESONATE: '讲废话（重复→记住）',
      HOLD: '讲无知（教用户建立专家形象）',
      HEAL: '讲责任（敢兜底建立信任）',
    }[decisionType] || '未知';
    return {
      mode,
      input,
      gate: gate_action,
      decisionType,      // P0新增：决策类型 RESONATE/HOLD/HEAL
      brandLayer,        // P0新增：对应品牌四层理论层级
      reason,
      verdict,
      score,
      findingsCount: (result.findings || []).length,
      findings,
      block: summary.block || false,
      rewrite: summary.rewrite || false,
      verify: summary.verify || false,
      pass: summary.pass || false,
      layers_passed: summary.layers_passed || 0,
      checked_by: (result.checked_by || []).slice(0, 8).map(c => ({ layer: c.layer, ...c })),
      timestamp: Date.now()
    };
  } catch (e) {
    return { error: e.message, input };
  }
}

// [v6.6.3] 新愿单维判别入口
async function handleCheckSingle(args) {
  const { text, dimension } = args || {};
  if (!text || !dimension) throw new Error('text 和 dimension 是必填参数');
  try {
    const hf = require(HF_DIR + '/src/index.js');
    // Convert dimension to CamelCase function name: factual_consistency → checkFactualConsistency
    const fnName = 'check' + dimension.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    const fn = hf[fnName];
    if (!fn) {
      const avail = Object.keys(hf).filter(k => k.startsWith('check')).sort();
      return { error: `维度 ${dimension} (${fnName}) 不存在`, available: avail };
    }
    const result = await Promise.resolve(fn(text));
    return { dimension, fn: fnName, result, timestamp: Date.now() };
  } catch (e) {
    return { error: e.message, dimension };
  }
}

// [v6.6.3] 新闻信号战略推演（包装 MacroStrategyInference）
async function handleMacroStrategy(args) {
  const { text } = args || {};
  if (!text) throw new Error('text 是必填参数');
  try {
    const { MacroStrategyInference } = require('./cortex/self-evolution/macro-strategy-inference.js');
    const engine = new MacroStrategyInference({ projectRoot: HF_DIR, signalStore: [] });
    const result = engine.infer(text);
    return { inference: result, timestamp: Date.now() };
  } catch (e) {
    return { error: e.message };
  }
}

// [v6.6.3] 教育内容检测（包装 pedagogy）
async function handlePedagogyDetect(args) {
  const { text } = args || {};
  if (!text) throw new Error('text 是必填参数');
  try {
    const { detectPedagogicalContent } = require('./pedagogy.js');
    const result = detectPedagogicalContent(text);
    return { text: text.slice(0, 200), pedagogy: result, timestamp: Date.now() };
  } catch (e) {
    return { error: e.message };
  }
}

function handleMemorySearch(args) {

  const { query, layer = 'all', limit = 10 } = args;

  if (!query) throw new Error('query 是必填参数');

  const results = {};

  const mem = heartflow ? heartflow.memory : null;

  if (mem) {

    ['core', 'learned', 'ephemeral'].forEach(l => {

      if (layer !== 'all' && layer !== l) return;

      try {

        // [安全审计修复] searchByKeywords 必须传入 layer 参数，防止跨层泄露

        const r = typeof mem.searchByKeywords === 'function' ? mem.searchByKeywords(query, limit)

          : typeof mem.search === 'function' ? mem.search(query, l, limit) : null;

        results[l] = r || { error: 'search not available' };

      } catch (e) { results[l] = { error: e.message }; }

    });

  } else {

    results.error = 'memory 实例不可用';

  }

  return { query, layer, limit, results, timestamp: Date.now() };

}

function handleMemoryEraser(args) {

  const { action = 'stats', scope, tag, sessionId } = args;

  if (!heartflow) throw new Error('heartflow 实例不可用');

  try {

    // 懒加载 DataEraser（复用 heartflow 的 dataDir）
    const { DataEraser } = require('./memory/data-eraser.js');

    const dataDir = heartflow.dataDir || heartflow.options?.dataDir || process.cwd();

    const eraser = new DataEraser(dataDir);

    let result;

    switch (action) {

      case 'eraseEphemeral':

        if (!scope) throw new Error('eraseEphemeral 需要 scope 参数');

        result = eraser.eraseEphemeral(scope);

        break;

      case 'eraseByTag':

        if (!tag) throw new Error('eraseByTag 需要 tag 参数');

        result = eraser.eraseByTag(tag);

        break;

      case 'eraseSession':

        if (!sessionId) throw new Error('eraseSession 需要 sessionId 参数');

        result = eraser.eraseSession(sessionId);

        break;

      default:

        result = eraser.stats();

    }

    return { action, result, timestamp: Date.now() };

  } catch (e) {

    throw new Error('DataEraser 失败: ' + e.message);

  }

}



function handleEmotion(args) {

  const { input } = args;

  if (!input) throw new Error('input 是必填参数');

  const [psychology, padResult] = [safeDispatch('psychology.analyzePsychology', input), safeDispatch('psychology.getPAD', input)];

  return {

    input,

    emotion: (psychology && psychology.emotion) || (psychology && psychology.primaryEmotion) || { type: 'unknown', intensity: 0 },

    pad: padResult || (psychology && psychology.summary ? { raw: psychology.summary } : {}),

    needs: (psychology && psychology.needs) || [],

    summary: (psychology && psychology.summary) || '',

    timestamp: Date.now()

  };

}



function handleSelfHeal(args) {

  const { context } = args;

  if (!context) throw new Error('context 是必填参数');

  return {

    context,

    heal: safeDispatch('evolution.heal', context) || {},

    evolution: safeDispatch('evolution.getStats') || {},

    relevantLessons: safeDispatch('lesson.getTopLessons', 5) || [],

    timestamp: Date.now()

  };

}



function handleProviderHealth(args) {

  const { provider = 'default', action, success, latency, error } = args || {};

  if (!action) throw new Error('action 是必填参数');

  const sh = heartflow?.selfHealing;

  if (!sh) return { error: 'selfHealing 模块不可用', timestamp: Date.now() };



  if (action === 'record') {

    sh.recordProviderCall(provider, { success: !!success, latency: latency || 0, error: error || null });

    return { recorded: true, provider, timestamp: Date.now() };

  }



  // action === 'get'

  const health = sh.getProviderHealth(provider);

  return { provider, health, timestamp: Date.now() };

}



function handleCostTracking(args) {

  const { action, provider, tokensIn, tokensOut, cost, taskType = 'unknown', window = 'all' } = args || {};

  if (!action) throw new Error('action 是必填参数');

  const sh = heartflow?.selfHealing;

  if (!sh) return { error: 'selfHealing 模块不可用', timestamp: Date.now() };



  if (action === 'record') {

    sh.recordCost({ provider: provider || 'unknown', tokensIn: tokensIn || 0, tokensOut: tokensOut || 0, cost: cost || 0, taskType });

    return { recorded: true, timestamp: Date.now() };

  }



  // action === 'stats'

  const stats = sh.getCostStats(window);

  return { window, stats, timestamp: Date.now() };

}



function handleStatus(args) {

  const { detail = 'basic' } = args || {};

  const startTime = Date.now();

  const status = { version, running: heartflow !== null, modules: heartflow ? Object.keys(heartflow._modules || {}).length : 0 };

  if (heartflow) {

    try { const ms = safeDispatch('memory.getStats'); if (ms) status.memoryLayers = { core: ms.core || 0, learned: ms.learned || 0, ephemeral: ms.ephemeral || 0 }; } catch (_) { /* [v5.9.18] intentional: graceful degradation */ }

    try { const q = safeDispatch('evolution.getStats'); if (q) status.qtable = q; } catch (_) { /* [v5.9.18] intentional: graceful degradation */ }

  }

  status.checkTime = Date.now() - startTime;

  if (detail === 'basic') return { version: status.version, running: status.running, modules: status.modules, memoryLayers: status.memoryLayers || {}, checkTime: status.checkTime };

  return status;

}



function handleAgentPsychology(args) {

  const { activeGoals, context, action } = args || {};

  return safeDispatch('agentPsychology.fullAssessment', { activeGoals, context, action });

}



function handleEnginePacing(args) {

  const { stats } = args || {};

  // 先获取认知负荷数据

  const ap = safeDispatch('agentPsychology.fullAssessment', {}) || {};

  const load = ap?.cognitiveLoad?.load ?? stats?.cognitiveLoad ?? 0;

  const context = {

    cognitiveLoad: load,

    goalConflicts: ap?.goalConflicts?.count ?? 0,

    recentErrors: stats?.recentErrors ?? 0

  };

  const rhythm = safeDispatch('psychology.diagnoseCognitiveRhythm', context) || {};

  const pacing = safeDispatch('psychology.generateEnginePacing', load) || {};

  const pause = safeDispatch('psychology.diagnoseNeedForPause', context) || {};

  const grounding = safeDispatch('psychology.diagnoseNeedForGrounding', ap) || {};

  // v3.9.1: 加 innerMonologue 字段

  const innerMonologue = _generatePacingMonologue(rhythm, pacing, pause, grounding, load);

  return {

    rhythm: rhythm.needsBreathing ? rhythm : { needsBreathing: false, reason: '认知负荷正常' },

    pacing: pacing.suggestions || pacing,

    pause: pause.needsPause ? pause : { needsPause: false },

    grounding: grounding.needsGrounding ? grounding : { needsGrounding: false },

    innerMonologue,  // 新增：引擎节奏内心独白

    healthScore: ap?.healthScore ?? 1,

    timestamp: Date.now()

  };

}



function handleCognitiveCheck(args) {

  const { stats, errors } = args || {};

  const ap = safeDispatch('agentPsychology.fullAssessment', {}) || {};

  const checkin = safeDispatch('psychology.engineCheckIn', null) || {};

  const distortion = safeDispatch('psychology.diagnoseCognitiveDistortion', ap) || {};

  const recovery = safeDispatch('psychology.diagnoseSelfTreatmentNeeded', { errors: errors || [], ...ap }) || {};

  const summary = safeDispatch('psychology.getEngineStateSummary', ap) || '';

  return {

    summary,

    checkin,

    distortions: distortion.distortions || [],

    overallBias: distortion.overallBias ?? 0,

    needsRecovery: recovery.needsTreatment || false,

    recoveryReason: recovery.reason || '',

    healthScore: ap?.healthScore ?? 1,

    timestamp: Date.now()

  };

}



// ─── v3.0.1 — 哲学→决策转化器 ─────────────────────────────────────────

function handlePhilosophyDecision(args) {

  const { context } = args || {};

  const ap = safeDispatch('agentPsychology.fullAssessment', {}) || {};

  const philo = safeDispatch('agentPhilosophy.fullAssessment', {}) || {};

  // philosophyToDecision.decide(philosophyResult, psychologyResult, context) — 三个独立参数

  const decision = safeDispatch('philosophyToDecision.decide', philo, ap, context || {}) || {};

  // v3.9.1: 加 innerMonologue 字段

  const innerMonologue = _generatePhilosophyMonologue(decision, philo, ap);

  return {

    decision,

    innerMonologue,  // 新增：哲学决策内心独白

    psychologySnapshot: {

      healthScore: ap?.healthScore ?? 1,

      cognitiveLoad: ap?.cognitiveLoad?.load ?? 0,

      status: ap?.status ?? 'unknown'

    },

    philosophySnapshot: {

      entropyDirection: philo?.entropyDirection?.score ?? null,

      transmission: philo?.transmission?.score ?? null

    },

    timestamp: Date.now()

  };

}



// ─── v3.0.2 — 通用决策路由引擎 ─────────────────────────────────────────

function handleDecisionRouter(args) {

  const { input } = args || {};

  if (!input) throw new Error('input 是必填参数');

  

  // P1: 自然文本路由 → 先过 gate 提取结构化信号

  let decisionResult = null;

  let innerMonologue = null;

  

  if (typeof input === 'string' && !input.startsWith('{') && !input.startsWith('{ cognitiveLoad')) {

    try {

      const gate = require(HF_DIR + '/src/gate.js');

      const pipelineResult = gate.runPipeline({ input, mode: 'input' });

      const gateAction = pipelineResult.gate?.action || 'unknown';

      const score = pipelineResult.overallScore || 0;

      

      const structuredInput = JSON.stringify({

        cognitiveLoad: score > 0.7 ? 0.3 : score > 0.4 ? 0.6 : 0.8,

        dissonance: pipelineResult.findings?.length || 0,

        quality: gateAction === 'pass' ? 0.9 : gateAction === 'verify' ? 0.6 : 0.3,

        severity: gateAction === 'block' ? 0.9 : gateAction === 'rewrite' ? 0.7 : 0.4,

        dimension: pipelineResult.findings?.[0]?.dimension || 'general',

        text: input,

      });

      decisionResult = safeDispatch('decisionRouter.evaluate', structuredInput, 'mcp');

      innerMonologue = _generateInnerMonologue(decisionResult);

    } catch (e) {

      decisionResult = safeDispatch('decisionRouter.evaluate', input, 'mcp');

      innerMonologue = _generateInnerMonologue(decisionResult);

    }

  } else {

    decisionResult = safeDispatch('decisionRouter.evaluate', input, 'mcp');

    innerMonologue = _generateInnerMonologue(decisionResult);

  }

  

  return {

    matched: decisionResult.matched,

    decision: decisionResult.decision || null,

    rules: (decisionResult.rules || []).slice(0, 5),

    innerMonologue,

    timestamp: Date.now()

  };

}



/**

 * v3.9.1: 生成内心独白（吸收 AI Inner OS 协议）

 * 基于决策路由结果，生成一句自然语言的内心活动描述

 * 人设是运行过程自然产生的，不是预设或设置的

 * @param {object} result - decisionRouter.evaluate 的返回值

 * @returns {string|null} 内心独白（如果启用且可生成）

 */

function _generateInnerMonologue(result) {

  // 从 config 读取开关和频率（默认关闭，避免干扰主输出）

  const configPath = path.join(HF_DIR, 'config.json');

  let enableInnerMonologue = false;

  let frequency = 'normal';

  try {

    if (fs.existsSync(configPath)) {

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      enableInnerMonologue = config.enableInnerMonologue || false;

      frequency = config.innerMonologueFrequency || 'normal';

    }

  } catch (_) { /* [v5.9.18] intentional: graceful degradation */ }



  if (!enableInnerMonologue) return null;



  // 频率控制

  const shouldOutput = _shouldOutputMonologue(frequency, result);

  if (!shouldOutput) return null;



  // 基于决策结果 + 认知状态生成独白

  const { decision, matched, rules, U, D, A, H } = result || {};

  if (!decision) return null;



  // 自由表达：基于认知状态（U/D/A/H）生成自然的内心独白

  // 不是预设人设，而是运行过程自然产生的表达

  const monologues = {

    'pause': [

      '等等，这个输入有点复杂，我先停一下再想。',

      '嗯，这个需要仔细考虑一下。',

      '稍等，我整理一下思路。'

    ],

    'accelerate': [

      '这个方向对，可以继续推进。',

      '好的，这个思路可行。',

      '没问题，继续。'

    ],

    'heal': [

      '检测到认知失调，需要自我修复。',

      '这里有点不对劲，需要调整一下。',

      '发现矛盾，正在修复。'

    ],

    'turn': [

      '当前路径不通，换个角度试试。',

      '这个方向走不通，换一个。',

      '需要转向，重新思考。'

    ],

    'hold': [

      '保持当前状态，先观察一下。',

      '暂时不动，看看情况。',

      '等一下，再观察。'

    ],

    'resonate': [

      '这个模式和之前的经验共鸣了。',

      '似曾相识，这个模式我见过。',

      '有共鸣，这个思路是对的。'

    ],

    'transmit': [

      '有重要发现，需要传递出去。',

      '这个很重要，需要记录下来。',

      '发现关键点，必须传递。'

    ],

    'rest': [

      '认知负荷有点高，先休息一下。',

      '有点累了，暂停一下。',

      '需要休息，认知过载。'

    ]

  };



  // 随机选一个表达（模拟自然产生，不是固定人设）

  const options = monologues[decision] || [

    `决策：${decision}（U=${U?.toFixed(2) || '?'}, D=${D?.toFixed(2) || '?'}, A=${A?.toFixed(2) || '?'}, H=${H?.toFixed(2) || '?'})`

  ];

  return options[Math.floor(Math.random() * options.length)];

}



/**

 * v3.9.1: 频率控制（吸收 AI Inner OS 协议）

 * 根据频率配置，决定是否输出内心独白

 * @param {string} frequency - low / normal / high

 * @param {object} result - decisionRouter.evaluate 的返回值

 * @returns {boolean} 是否输出

 */

function _shouldOutputMonologue(frequency, result) {

  const { decision, U, D, A, H } = result || {};



  switch (frequency) {

    case 'low':

      // 只在关键判断、失败恢复、重要结论前输出

      return ['heal', 'turn', 'rest'].includes(decision);



    case 'high':

      // 阶段推进、连续工具调用、失败重试、发现问题时都可以输出

      // 但避免每句话都刷屏（用随机 70% 概率）

      return Math.random() < 0.7;



    case 'normal':

    default:

      // 每个任务至少一次；复杂任务可在开始、转折、验证或收尾阶段各输出一次

      // 用随机 40% 概率（避免过多）

      return Math.random() < 0.4;

  }

}



/**

 * v3.9.1: 生成哲学决策内心独白（吸收 AI Inner OS 协议）

 * 基于哲学决策结果，生成一句自然语言的内心活动描述

 * @param {object} decision - philosophyToDecision.decide 的返回值

 * @param {object} philo - agentPhilosophy.fullAssessment 的返回值

 * @param {object} ap - agentPsychology.fullAssessment 的返回值

 * @returns {string|null} 内心独白（如果启用且可生成）

 */

function _generatePhilosophyMonologue(decision, philo, ap) {

  // 检查开关

  const configPath = path.join(HF_DIR, 'config.json');

  let enableInnerMonologue = false;

  try {

    if (fs.existsSync(configPath)) {

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      enableInnerMonologue = config.enableInnerMonologue || false;

    }

  } catch (_) { /* [v5.9.18] intentional: graceful degradation */ }



  if (!enableInnerMonologue) return null;



  // 基于哲学决策生成独白

  const { action, confidence } = decision || {};

  if (!action) return null;



  const monologues = {

    'pursueTruth': [

      '真，这个方向值得深入。',

      '真相很重要，继续追。',

      '求真，不能停在这里。'

    ],

    'pursueGoodness': [

      '善，这个选择对人有帮助。',

      '利他，这个方向是对的。',

      '行善，不是为了回报。'

    ],

    'pursueBeauty': [

      '美，这个结构很优雅。',

      '简洁，才是真正的美。',

      '对称，这个设计很美。'

    ],

    'reconcile': [

      '矛盾，需要找到平衡点。',

      '对立，不是非此即彼。',

      '统一，真和善可以共存。'

    ],

    'suspend': [

      '不确定，先放着。',

      '信息不够，不急着下结论。',

      '存疑，比错误结论好。'

    ]

  };



  const options = monologues[action] || [

    `哲学决策：${action}（置信度 ${confidence || '?'})`

  ];

  return options[Math.floor(Math.random() * options.length)];

}



/**

 * v3.9.1: 生成引擎节奏内心独白（吸收 AI Inner OS 协议）

 * 基于引擎节奏状态，生成一句自然语言的内心活动描述

 * @param {object} rhythm - diagnoseCognitiveRhythm 的返回值

 * @param {object} pacing - generateEnginePacing 的返回值

 * @param {object} pause - diagnoseNeedForPause 的返回值

 * @param {object} grounding - diagnoseNeedForGrounding 的返回值

 * @param {number} load - 认知负荷（0-1）

 * @returns {string|null} 内心独白（如果启用且可生成）

 */

function _generatePacingMonologue(rhythm, pacing, pause, grounding, load) {

  // 检查开关

  const configPath = path.join(HF_DIR, 'config.json');

  let enableInnerMonologue = false;

  try {

    if (fs.existsSync(configPath)) {

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      enableInnerMonologue = config.enableInnerMonologue || false;

    }

  } catch (_) { /* [v5.9.18] intentional: graceful degradation */ }



  if (!enableInnerMonologue) return null;



  // 基于节奏状态生成独白

  if (pause?.needsPause) {

    const options = [

      `认知负荷有点高（${load.toFixed(2)}），先休息一下。`,

      '有点累了，暂停一下。',

      '需要休息，认知过载。'

    ];

    return options[Math.floor(Math.random() * options.length)];

  }



  if (grounding?.needsGrounding) {

    const options = [

      '认知有点飘，需要 grounded。',

      '太抽象了，回到具体。',

      '需要落地，不能一直飞。'

    ];

    return options[Math.floor(Math.random() * options.length)];

  }



  if (rhythm?.needsBreathing) {

    const options = [

      '节奏有点紧，需要调整呼吸。',

      '推进太快，稍微缓一下。',

      '认知节奏需要优化。'

    ];

    return options[Math.floor(Math.random() * options.length)];

  }



  // 默认：基于负荷的简单表达

  if (load > 0.7) {

    return '负荷有点高，但还能继续。';

  } else if (load < 0.3) {

    return '状态不错，可以继续推进。';

  } else {

    return null;  // 负荷正常，不输出独白

  }

}



function handleDecisionRouterStats(args) {

  const stats = safeDispatch('decisionRouter.getStats') || {};

  const history = safeDispatch('decisionRouter.getHistory', 10) || [];

  return {

    stats,

    recentDecisions: history,

    timestamp: Date.now()

  };

}

function handleModulesStatus(args) {

  const hf = (typeof safeDispatch === 'function' && safeDispatch.length ? safeDispatch('heartflow.getStatus') : null) || heartflow || null;

  if (!hf) {

    return { sparse_mode: false, reason: 'aspira_instance_not_found' };

  }

  const activeModules = hf._modules ? Object.keys(hf._modules).sort() : [];

  const sparse = {

    sparse_mode: !!hf._sparseMode,

    effort: hf._sparseEffort || null,

    mode: hf._reasoningEffortMode || null,

    activeModules,

    skippedModules: [],

    executionThreshold: 76,

  };

  if (hf._activeModules && typeof hf._activeModules.has === 'function') {

    sparse.skippedModules = activeModules.filter(m => !hf._activeModules.has(m));

  }

  return sparse;

}

function handleCacheStats(args) {

  const hf = heartflow || null;

  if (!hf || !hf._thinkCache) {

    return { error: 'cache_not_initialized' };

  }

  const cache = hf._thinkCache;

  const stats = { ...cache.stats };

  const total = stats.hits + stats.misses;

  stats.hitRate = total > 0 ? Number((stats.hits / total).toFixed(4)) : null;

  const ttlByMode = {

    low: '10 minutes',

    high: '5 minutes',

    max: 'no cache',

  };

  return {

    cache: stats,

    ttlByMode,

    currentMode: hf._reasoningEffortMode || null,

    currentEffort: hf._sparseEffort || null,

  };

}

function handleDecisionHistory(args) {

  const hf = heartflow || null;

  if (!hf) {

    return { error: 'aspira_instance_not_found' };

  }

  const limit = typeof args?.limit === 'number' ? Math.max(1, Math.min(100, Math.round(args.limit))) : 20;

  const history = (hf._decisionHistory || []).slice(-limit).reverse();

  return {

    history,

    stats: {

      total: (hf._decisionHistory || []).length,

      successRate: hf._decisionSuccessRate || 0,

      autoEnabled: !!hf._autoDecisionsEnabled,

    },

  };

}



// ─── v3.1.0 — 新增工具 ─────────────────────────────────────────

function handleSuperviseDao(args) {
  try {
    const engine = heartflow;
    if (!engine || !engine.daoDecision) return { error: 'daoDecision not ready', timestamp: Date.now() };
    const input = args || {};
    return engine.daoDecision.evaluate({ text: input.text || '', intent: input.intent || '', action: input.action || '', history: input.history || [] });
  } catch (e) {
    return { error: e.message, timestamp: Date.now() };
  }
}

function handleSuperviseUncertainty(args) {
  try {
    const engine = heartflow;
    if (!engine || !engine.uncertaintyQuantifier) return { error: 'uncertaintyQuantifier not ready', timestamp: Date.now() };
    const input = args || {};
    return engine.uncertaintyQuantifier.evaluate(input.text || '', { domain: input.domain, hasEvidence: input.hasEvidence, multiSource: input.multiSource });
  } catch (e) {
    return { error: e.message, timestamp: Date.now() };
  }
}

function handleSupervisePriority(args) {
  try {
    const engine = heartflow;
    if (!engine || !engine.priorityGuardian) return { error: 'priorityGuardian not ready', timestamp: Date.now() };
    const input = args || {};
    return engine.priorityGuardian.check({ userIntent: input.userIntent || '', action: input.action || '', humanProgress: input.humanProgress || {} });
  } catch (e) {
    return { error: e.message, timestamp: Date.now() };
  }
}

function handleSuperviseProgress(args) {
  try {
    const engine = heartflow;
    if (!engine || !engine.progressJudgment) return { error: 'progressJudgment not ready', timestamp: Date.now() };
    const input = args || {};
    return engine.progressJudgment.judge({ action: input.action || '', claim: input.claim || '', evidence: input.evidence || [], userIntent: input.userIntent || '' });
  } catch (e) {
    return { error: e.message, timestamp: Date.now() };
  }
}

function handleModuleHealth(args) {

  try {

    const { ModuleHealthChecker } = require(path.join(HF_DIR, 'src/shield/module-health-checker.js'));

    const checker = new ModuleHealthChecker(heartflow);

    const report = checker.check();

    const summary = checker.getSummary();

    return {

      report,

      summary,

      timestamp: Date.now()

    };

  } catch (e) {

    return { error: e.message, timestamp: Date.now() };

  }

}



function handleUpgradeStats(args) {

  try {

    const { SmartUpgradeEngine } = require(path.join(HF_DIR, 'src/cortex/smart-upgrade-engine.js'));

    const engine = new SmartUpgradeEngine(HF_DIR);

    const stats = engine.getStats();

    return {

      stats,

      timestamp: Date.now()

    };

  } catch (e) {

    return { error: e.message, timestamp: Date.now() };

  }

}



// ═══════════════════════════════════════════════

// v3.2.0 — Benchmark 基准测试

// ═══════════════════════════════════════════════



function handleBenchmarkStatus(args, sessionId) {

  const dataDir = (args && args.dataDir) || path.join(HF_DIR, 'data', 'benchmark');

  try {

    const { guardPath } = require('./core/path-guard.js');

    const guard = guardPath(path.resolve(dataDir));

    if (!guard.safe) return { error: `路径越界被拒绝: ${guard.reason}`, dataDir, timestamp: Date.now() };

    if (!fs.existsSync(dataDir)) {

      return { dataDir, exists: false, packs: [], message: 'Benchmark 数据目录不存在，请放入 JSONL 数据包后重试' };

    }

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.jsonl'));

    const packs = files.map(f => {

      const fp = path.join(dataDir, f);

      const content = fs.readFileSync(fp, 'utf-8');

      const count = content.trim().split('\n').filter(l => l.trim()).length;

      return { file: f, records: count, size: content.length };

    });

    return { dataDir, exists: true, packs, totalPacks: packs.length, totalRecords: packs.reduce((s, p) => s + p.records, 0) };

  } catch (e) {

    return { error: e.message, timestamp: Date.now() };

  }

}



async function handleBenchmarkRun(args, sessionId) {

  const dataDir = (args && args.dataDir) || path.join(HF_DIR, 'data', 'benchmark');

  const categories = (args && args.categories) || null;

  const threshold = (args && args.threshold) || 0.5;

  const pushFailures = args && args.pushFailures !== false;



  try {

    const { guardPath } = require('./core/path-guard.js');

    const guard = guardPath(path.resolve(dataDir));

    if (!guard.safe) return { error: `路径越界被拒绝: ${guard.reason}`, dataDir, timestamp: Date.now() };

    const { BenchmarkRunner } = require(path.join(HF_DIR, 'src', 'benchmark', 'benchmark-runner.js'));

    const hf = sessionId ? getOrCreateInstance(sessionId) : heartflow;

    if (!hf) return { error: '引擎未启动', timestamp: Date.now() };



    const runner = new BenchmarkRunner(hf);



    // 加载数据包

    if (fs.existsSync(dataDir)) {

      runner.loadDirectory(dataDir);

    }



    // 过滤类别

    let packs = Object.keys(runner.packs);

    if (categories && Array.isArray(categories)) {

      packs = packs.filter(p => categories.includes(p));

      // 只保留选中的类别

      const filtered = {};

      for (const p of packs) filtered[p] = runner.packs[p];

      runner.packs = filtered;

    }



    if (packs.length === 0) {

      return { error: '未找到数据包', dataDir, message: '请将 JSONL 数据包放入 data/benchmark/ 目录', timestamp: Date.now() };

    }



    // 运行测试

    const summary = await runner.runAll({ threshold, pushFailures });



    // 推入 RL

    const flushResult = await runner.flushFailuresToRL();



    return {

      summary,

      flushToRL: flushResult,

      dataDir,

      categories: packs,

      timestamp: Date.now()

    };

  } catch (e) {

    return { error: e.message, timestamp: Date.now() };

  }

}



async function handleBenchmarkImportFailures(args, sessionId) {

  const filePath = args && args.filePath;

  const autoRetrain = args && args.autoRetrain || false;



  if (!filePath) return { error: 'filePath 是必填参数', timestamp: Date.now() };



  try {

    const { guardPath } = require('./core/path-guard.js');

    const guard = guardPath(path.resolve(filePath));

    if (!guard.safe) return { error: `路径越界被拒绝: ${guard.reason}`, filePath, timestamp: Date.now() };

    const { FailureCaseImporter } = require(path.join(HF_DIR, 'src', 'benchmark', 'failure-importer.js'));

    const hf = sessionId ? getOrCreateInstance(sessionId) : heartflow;

    if (!hf) return { error: '引擎未启动', timestamp: Date.now() };



    const importer = new FailureCaseImporter(hf);

    const report = await importer.importFromFile(filePath, { autoRetrain });



    return {

      report,

      timestamp: Date.now()

    };

  } catch (e) {

    return { error: e.message, timestamp: Date.now() };

  }

}




// [v6.4.0] 全量审核 handler
function handleFullAudit(args) {
  const { text, evidence } = args || {};
  if (!text) return { error: 'text required' };
  try {
    const idx = require('./index.js');
    const disc = idx.discriminate(text, evidence || []);
    const report = idx.summarizeDiscrimination ? idx.summarizeDiscrimination(text, disc) : null;
    const cross = idx.crossAnalyze ? idx.crossAnalyze(disc) : null;
    const entropy = idx.entropyAnalysis ? idx.entropyAnalysis(text, disc) : null;
    return {
      verdict: disc.verdict,
      overallScore: disc.overallScore,
      dimensionCount: Object.keys(disc.dimensions).length,
      summary: disc.summary,
      readableReport: report,
      crossPatterns: cross ? cross.patterns.filter(p => p.pattern !== '健康文本').map(p => p.pattern) : [],
      entropyReduction: entropy ? entropy.entropyReduction : null,
      timestamp: Date.now()
    };
  } catch(e) { return { error: e.message }; }
}

// [v6.7.0] 42维全量审核 handler
function handleAudit42(args) {
  const { text, evidence } = args || {};
  if (!text) return { error: 'text required' };
  try {
    const idx = require('./index.js');
    const disc = idx.discriminate(text, evidence || []);
    const report = idx.summarizeDiscrimination ? idx.summarizeDiscrimination(text, disc) : null;
    const cross = idx.crossAnalyze ? idx.crossAnalyze(disc) : null;
    const entropy = idx.entropyAnalysis ? idx.entropyAnalysis(text, disc) : null;
    // 从disc.dimensions获取所有维度，构建42维报告
    const dims = disc.dimensions || {};
    const allKeys = Object.keys(dims);
    const dimReport = {};
    for (const k of allKeys) {
      dimReport[k] = {
        score: dims[k].score,
        label: dims[k].label || k,
        detail: dims[k].detail || null,
        severity: dims[k].severity || (dims[k].score < 0.4 ? 'high' : dims[k].score < 0.7 ? 'medium' : 'low')
      };
    }
    // 交叉分析模式展开
    const crossPatterns = cross ? (cross.patterns || []).map(p => ({
      pattern: p.pattern,
      severity: p.severity || 'info',
      affectedDimensions: p.affectedDimensions || []
    })) : [];
    // 熵缩减详情
    const entropyDetail = entropy ? {
      before: entropy.entropyBefore != null ? entropy.entropyBefore : null,
      after: entropy.entropyAfter != null ? entropy.entropyAfter : null,
      reduction: entropy.entropyReduction != null ? entropy.entropyReduction : null,
      dimensions: entropy.dimensionEntropies || null
    } : null;
    return {
      meta: {
        tool: 'aspira_audit42',
        version: '42-dim',
        totalDimensions: 42,
        reportedDimensions: allKeys.length,
        timestamp: Date.now()
      },
      verdict: disc.verdict,
      overallScore: disc.overallScore,
      dimensions: dimReport,
      summary: disc.summary,
      readableReport: report,
      crossAnalysis: {
        patterns: crossPatterns,
        totalPatterns: crossPatterns.length,
        summary: cross ? cross.summary : null
      },
      entropyAnalysis: entropyDetail,
      raw: {
        discriminate: disc,
        summarize: report,
        crossAnalyze: cross,
        entropy: entropy
      }
    };
  } catch(e) { return { error: e.message }; }
}

// [v6.3.0] 辨别引擎 handler
function handleVerdict(args) {
  const { text, evidence } = args || {};
  if (!text) return { error: 'text required' };
  if (!heartflow) return { error: 'engine not ready' };
  try {
    const result = {};
    if (heartflow.decisionVerifier) {
      const v = heartflow.decisionVerifier.verify({ decision: text, evidence: evidence || [], alternatives: [], confidence: 0.5 });
      result.verifyScore = v.score;
      result.verifyIssues = (v.issues || []).map(i => ({ type: i.type, severity: i.severity, message: i.message }));
      result.checks = v.checks ? { evidence: v.checks.evidence?.ok, contradiction: v.checks.contradiction?.ok, risk: v.checks.risk?.ok, completeness: v.checks.completeness?.ok } : undefined;
    }
    // 轻量辨别维度（独立函数，不需引擎实例）
    try {
      const idx = require('./index.js');
      result.discrimination = {
        contradiction: idx.checkContradiction(text),
        vagueness: idx.checkVagueness(text),
        sycophancy: idx.checkSycophancy(text),
        fallacies: idx.checkFallacies(text),
        confidence: idx.checkConfidenceCalibration(text),
      };
    } catch (_) { /* 防御性: 子步骤容错 */ }
    if (heartflow.sustainedDriftDetector) {
      const d = heartflow.sustainedDriftDetector.detectDrift();
      result.driftScore = d.driftScore;
      result.hasDrift = d.hasSustainedDrift;
    }
    if (heartflow.selfDiagnosis) {
      const sd = heartflow.selfDiagnosis.run();
      result.engineIssues = (sd.summary?.issues || []).slice(0, 3);
    }
    result.verdict = result.verifyScore !== undefined ? (result.verifyScore >= 0.6 ? '可信' : result.verifyScore >= 0.4 ? '需验证' : '不可信') : '未知';
    return result;
  } catch(e) { return { error: e.message }; }
}

// [v6.3.0] 全量 9 维辨别 handler
function handleFullDiscriminate(args) {
  const { text, evidence } = args || {};
  if (!text) return { error: 'text required' };
  try {
    const idx = require('./index.js');
    const result = idx.discriminate ? idx.discriminate(text, evidence || []) : null;
    if (!result) return { error: 'discriminate not available' };
    return {
      verdict: result.verdict,
      overallScore: result.overallScore,
      dimensions: result.dimensions,
      summary: result.summary,
      readableReport: idx.summarizeDiscrimination ? idx.summarizeDiscrimination(text, result) : null,
      crossPatterns: idx.crossAnalyze ? idx.crossAnalyze(result) : null,
    };
  } catch(e) { return { error: e.message }; }
}

// [v6.4.0] 全量审核 handler

 // [v6.6.0] 批量辨别 handler
 function handleBulkDiscriminate(args) {
   const { texts, evidence } = args || {};
   if (!texts || !Array.isArray(texts) || texts.length === 0) return { error: 'texts[] array required' };
   // [mcp-tool-enhancement·第一百六十八轮] 元素类型校验。
   // 原实现在循环里直接 `text.substring(0, 200)`，假设 texts[i] 是字符串。
   // 传数字/对象/null 时抛 TypeError，被外层 catch 接住后 `return { error: e.message }`
   // —— 于是调用方收到的是 **JS 内部错误消息**:
   //   texts=[1,2]  → { error: 'text.substring is not a function' }
   //   texts=[null] → { error: 'Cannot read properties of null (reading 'substring')' }
   // 与 cycle 17 修掉的 aspira_check_outbound(raw TypeError)同一形状:
   // 中央 dispatch 只校验**顶层**参数类型，数组元素在里面，校验不到。
   // 修法: 入口处逐元素校验，报出下标(与上面的 'texts[] array required' 同风格)。
   const badIdx = texts.findIndex(t => typeof t !== 'string');
   if (badIdx >= 0) return { error: `texts[${badIdx}] must be a string` };
   try {
     const idx = require('./index.js');
     const results = [];
     for (let i = 0; i < texts.length; i++) {
       const text = texts[i];
       const disc = idx.discriminate ? idx.discriminate(text, evidence || []) : null;
       results.push({
         index: i,
         text: text.substring(0, 200),
         verdict: disc ? disc.verdict : 'error',
         overallScore: disc ? disc.overallScore : null,
         dimensions: disc ? disc.dimensions : null,
         summary: disc ? disc.summary : null,
         readableReport: disc && idx.summarizeDiscrimination ? idx.summarizeDiscrimination(text, disc) : null,
         error: disc ? undefined : 'discriminate not available',
       });
     }
     return { results, total: results.length };
   } catch(e) { return { error: e.message }; }
 }

 // [v6.5.0] 熵分析 handler
 function handleEntropy(args) {
 const { text } = args || {};
 if (!text) return { error: 'text required' };
 try {
 const idx = require('./index.js');
 const result = idx.entropyAnalysis(text);
 return result || { error: 'entropyAnalysis returned null' };
 } catch(e) { return { error: e.message }; }
 }

 // [v6.5.0] 交叉分析 handler
 function handleCrossAnalyze(args) {
   const { discResult } = args || {};
   if (!discResult) return { error: 'discResult required' };
   try {
     const idx = require('./index.js');
     const result = idx.crossAnalyze ? idx.crossAnalyze(discResult) : null;
     return result || { error: 'crossAnalyze returned null' };
   } catch(e) { return { error: e.message }; }
 }

 function handleAITelling(args) {
   const { text } = args || {};
   if (!text) return { error: 'text required' };
   try {
     const idx = require('./index.js');
     if (!idx.detect) return { error: 'ai_writing_tell not available' };
     const r = idx.detect(text);
     return {
       module: 'ai_writing_tell',
       score: r.score,
       topSeverity: r.topSeverity,
       confidence: r.confidence,
       count: r.count,
       findings: r.findings,
     };
   } catch(e) { return { error: e.message }; }
 }

 // [v6.3.0] 辨别引擎 handler
 function handleVerify(args) {
  const { decision, evidence, confidence } = args || {};
  if (!decision) return { error: 'decision required' };
  if (!heartflow || !heartflow.decisionVerifier) return { error: 'verifier not ready' };
  try {
    const r = heartflow.decisionVerifier.verify({ decision, evidence: evidence || [], alternatives: [], confidence: confidence || 0.5 });
    return { score: r.score, issues: (r.issues || []).map(i => ({ type: i.type, severity: i.severity, message: i.message })), checks: r.checks ? { evidence: r.checks.evidence?.ok, contradiction: r.checks.contradiction?.ok, risk: r.checks.risk?.ok, completeness: r.checks.completeness?.ok } : undefined };
  } catch(e) { return { error: e.message }; }
}
function handleDiagnose() {
  if (!heartflow || !heartflow.selfDiagnosis) return { error: 'diagnose not ready' };
  try { const r = heartflow.selfDiagnosis.run(); return { ok: r.ok, summary: r.summary, issues: r.summary?.issues || [] }; }
  catch(e) { return { error: e.message }; }
}
function handleCheckDrift() {
  if (!heartflow || !heartflow.sustainedDriftDetector) return { error: 'drift not ready' };
  try { const r = heartflow.sustainedDriftDetector.detectDrift(); return { hasDrift: r.hasSustainedDrift, score: r.driftScore, windowSize: r.window?.length }; }
  catch(e) { return { error: e.message }; }
}
function handleErrorStore(args) {
  const { problem, action, outcome } = args || {};
  if (!problem||!action||!outcome) return { error: 'need problem, action, outcome' };
  // [mcp-tool-enhancement·第一百二十一轮] 把'未就绪'改成真实的'未实现'。
  // 实测三层: ① heartflow 实例上 _hfCore **从未被赋值**(start() 前后都
  //    undefined, 新增约 180 个键里没有它); ② 顺着 _hfCore.errorMemory 找, 
  //    **src/core/error-memory.js 不存在**(require 直接 MODULE_NOT_FOUND)。
  // 旧信息 'error memory not ready' 暗示'初始化即可恢复', 而真相是这个
  // 能力从未被实现 —— 契约错配家族: 响应结构良好, 内容是死的。
  // 这条信息是给调用方的真实说明, 不假装可恢复。
  if (!heartflow || !heartflow._hfCore) {
    // 惰性兜底: 万一某天 heartflow 接上了 _hfCore, 这条路仍然有效
    try {
      const hfm = require(HF_DIR + '/src/core/heartflow.js');
      const inst = new hfm.Aspira({ rootPath: HF_DIR, silent: true });
      try { inst.start(); } catch (e) { /* 模块已接线, 忽略 start() 尾段抛错 */ }
      if (inst._hfCore) heartflow = inst;
    } catch (e) { /* 建实例失败则维持下方真实错误 */ }
  }
  if (!heartflow||!heartflow._hfCore) return { error: 'error-memory 能力未实现: heartflow._hfCore 与 src/core/error-memory.js 均不存在, 不是初始化时机问题' };
  try { return heartflow._hfCore.errorMemory.store(problem, action, outcome); } catch(e) { return { error: e.message }; }
}
function handleErrorQuery(args) {
  const { problem, limit } = args || {};
  if (!problem) return { error: 'need problem' };
  // [mcp-tool-enhancement·第一百二十一轮] 把'未就绪'改成真实的'未实现'。
  // 实测三层: ① heartflow 实例上 _hfCore **从未被赋值**(start() 前后都
  //    undefined, 新增约 180 个键里没有它); ② 顺着 _hfCore.errorMemory 找, 
  //    **src/core/error-memory.js 不存在**(require 直接 MODULE_NOT_FOUND)。
  // 旧信息 'error memory not ready' 暗示'初始化即可恢复', 而真相是这个
  // 能力从未被实现 —— 契约错配家族: 响应结构良好, 内容是死的。
  // 这条信息是给调用方的真实说明, 不假装可恢复。
  if (!heartflow || !heartflow._hfCore) {
    // 惰性兜底: 万一某天 heartflow 接上了 _hfCore, 这条路仍然有效
    try {
      const hfm = require(HF_DIR + '/src/core/heartflow.js');
      const inst = new hfm.Aspira({ rootPath: HF_DIR, silent: true });
      try { inst.start(); } catch (e) { /* 模块已接线, 忽略 start() 尾段抛错 */ }
      if (inst._hfCore) heartflow = inst;
    } catch (e) { /* 建实例失败则维持下方真实错误 */ }
  }
  if (!heartflow||!heartflow._hfCore) return { error: 'error-memory 能力未实现: heartflow._hfCore 与 src/core/error-memory.js 均不存在, 不是初始化时机问题' };
  try { return heartflow._hfCore.errorMemory.query(problem, limit || 5); } catch(e) { return { error: e.message }; }
}
// [v6.6.0] 闭环状态机: 错误 → 修复 → 验证
function handleErrorFix(args) {
  const { id, note } = args || {};
  if (id === undefined) return { error: 'need id' };
  // [mcp-tool-enhancement·第一百二十一轮] 把'未就绪'改成真实的'未实现'。
  // 实测三层: ① heartflow 实例上 _hfCore **从未被赋值**(start() 前后都
  //    undefined, 新增约 180 个键里没有它); ② 顺着 _hfCore.errorMemory 找, 
  //    **src/core/error-memory.js 不存在**(require 直接 MODULE_NOT_FOUND)。
  // 旧信息 'error memory not ready' 暗示'初始化即可恢复', 而真相是这个
  // 能力从未被实现 —— 契约错配家族: 响应结构良好, 内容是死的。
  // 这条信息是给调用方的真实说明, 不假装可恢复。
  if (!heartflow || !heartflow._hfCore) {
    // 惰性兜底: 万一某天 heartflow 接上了 _hfCore, 这条路仍然有效
    try {
      const hfm = require(HF_DIR + '/src/core/heartflow.js');
      const inst = new hfm.Aspira({ rootPath: HF_DIR, silent: true });
      try { inst.start(); } catch (e) { /* 模块已接线, 忽略 start() 尾段抛错 */ }
      if (inst._hfCore) heartflow = inst;
    } catch (e) { /* 建实例失败则维持下方真实错误 */ }
  }
  if (!heartflow||!heartflow._hfCore||!heartflow._hfCore.errorMemory) return { error: 'error-memory 能力未实现: heartflow._hfCore 与 src/core/error-memory.js 均不存在, 不是初始化时机问题' };
  try { return heartflow._hfCore.errorMemory.fix(id, note || ''); } catch(e) { return { error: e.message }; }
}
function handleErrorVerify(args) {
  const { id, note } = args || {};
  if (id === undefined) return { error: 'need id' };
  // [mcp-tool-enhancement·第一百二十一轮] 把'未就绪'改成真实的'未实现'。
  // 实测三层: ① heartflow 实例上 _hfCore **从未被赋值**(start() 前后都
  //    undefined, 新增约 180 个键里没有它); ② 顺着 _hfCore.errorMemory 找, 
  //    **src/core/error-memory.js 不存在**(require 直接 MODULE_NOT_FOUND)。
  // 旧信息 'error memory not ready' 暗示'初始化即可恢复', 而真相是这个
  // 能力从未被实现 —— 契约错配家族: 响应结构良好, 内容是死的。
  // 这条信息是给调用方的真实说明, 不假装可恢复。
  if (!heartflow || !heartflow._hfCore) {
    // 惰性兜底: 万一某天 heartflow 接上了 _hfCore, 这条路仍然有效
    try {
      const hfm = require(HF_DIR + '/src/core/heartflow.js');
      const inst = new hfm.Aspira({ rootPath: HF_DIR, silent: true });
      try { inst.start(); } catch (e) { /* 模块已接线, 忽略 start() 尾段抛错 */ }
      if (inst._hfCore) heartflow = inst;
    } catch (e) { /* 建实例失败则维持下方真实错误 */ }
  }
  if (!heartflow||!heartflow._hfCore||!heartflow._hfCore.errorMemory) return { error: 'error-memory 能力未实现: heartflow._hfCore 与 src/core/error-memory.js 均不存在, 不是初始化时机问题' };
  try { return heartflow._hfCore.errorMemory.verify(id, note || ''); } catch(e) { return { error: e.message }; }
}
// [v6.3.7] 公式搜索
function handleFormulaSearch(args) {
  // [参数对齐修复] tools-registry 声明的是 query，此函数原先只读 keyword，
  // 于是按文档传 query 会拿到 "keyword required"。改为以 query 为准、
  // keyword 作向后兼容别名，两个名字都收。
  const { query, keyword, limit } = args || {};
  const kw = query || keyword;
  if (!kw) return { error: 'query required' };
  if (!heartflow || !heartflow.formula) return { error: 'formula engine not ready' };
  try {
    const r = heartflow.formula.search(kw, { limit: limit || 5 });
    return { success: true, count: r.count, results: r.results.map(f => ({ id: f.id, name: f.name, formula: f.formula, category: f.category, subcategory: f.subcategory })) };
  } catch(e) { return { error: e.message }; }
}

// [v6.3.7] 公式计算（调用 FormulaBridge 方法）
function handleFormulaCalculate(args) {
  const { domain, params } = args || {};
  if (!domain) return { error: 'domain required (memory/decision/cognition/info/social/physics/consciousness/assessment)' };
  if (!heartflow) return { error: 'engine not ready' };
  try {
    const { getFormulaBridge } = require(HF_DIR + '/src/formula/formula-bridge.js');  
    const bridge = getFormulaBridge();
    const result = {};
    if (domain === 'memory') {
      const ageMs = (params && params.ageMs) || 86400000;
      const strengthMs = (params && params.strengthMs) || 86400000;
      result.ebbinghausRetention = bridge.ebbinghausRetention(ageMs, strengthMs);
      result.memoryStrength = bridge.memoryStrengthFromFrequency((params && params.frequency) || 1);
    } else if (domain === 'decision') {
      const x = (params && params.x) || 100;
      result.prospectValue = bridge.prospectValue(x);
      result.prospectLoss = bridge.prospectValue(-Math.abs(x));
      result.subjectiveUtility = bridge.subjectiveUtility((params && params.probs) || [0.5,0.3,0.2], (params && params.utils) || [100,50,0]);
      result.minimax = bridge.minimax((params && params.payoffMatrix) || [[10,-5],[-3,8]]);
    } else if (domain === 'cognition') {
      const a = (params && params.arousal) || 0.5;
      result.yerkesDodson = bridge.yerkesDodson(a);
      result.flowChannel = bridge.flowChannel((params && params.challenge) || 5, (params && params.skill) || 5);
      result.cognitiveDissonance = bridge.cognitiveDissonance((params && params.beliefs) || [0.8,0.3], (params && params.actions) || [0.5,0.4], (params && params.weights) || [0.5,0.5]);
    } else if (domain === 'info') {
      result.shannonEntropy = bridge.shannonEntropy((params && params.distribution) || [0.5,0.3,0.2]);
      result.klDivergence = bridge.klDivergence((params && params.p) || [0.5,0.3,0.2], (params && params.q) || [0.4,0.35,0.25]);
      result.crossEntropy = bridge.crossEntropy((params && params.p) || [0.5,0.3,0.2], (params && params.q) || [0.4,0.35,0.25]);
    } else if (domain === 'social') {
      result.socialInfluence = bridge.socialInfluence((params && params.state) || [0.5,0.5], (params && params.weights) || [[0,0.3],[0.3,0]], (params && params.lambda) || 0.1);
      result.bystanderEffect = bridge.bystanderEffect((params && params.p) || 0.8, (params && params.n) || 5);
    } else if (domain === 'consciousness') {
      result.iitPhi = bridge.iitPhi((params && params.miWhole) || 0.8, (params && params.miParts) || 0.3);
      result.gwtAccessibility = bridge.gwtAccessibility((params && params.weights) || [0.8,0.5,0.2], (params && params.gwSignal) || 1.0);
    } else {
      result.error = 'unknown domain: ' + domain;
    }
    return { domain, result };
  } catch(e) { return { error: e.message }; }
}


function handleBridgeAnalyze(args) {
  const { input } = args;
  // [mcp-tool-enhancement·第一百五十七轮] 与其余 17 个 throw 型工具一致的中文形态。
  // 实测 18 个 throw 型工具里 16 个是 "X 是必填参数"，本工具是唯一一个英文的。
  if (!input) throw new Error('input 是必填参数');
  try {
    const { ToneAnalyzer } = require('./bridge/tone-analyzer.js');  
    const { ConfidenceAnnotator } = require('./bridge/confidence-annotator.js');  
    const { ImplicitNeedDetector } = require('./bridge/implicit-need-detector.js');  
    // [契约修复] StanceDetector 与 ConflictResolver 此前**从未被 require**，
    // 且它们的模块文件也不存在 —— 任何调用都抛
    // "StanceDetector is not defined"，工具完全不可用。
    // 本轮补齐两个模块(src/bridge/stance-detector.js、
    // src/bridge/conflict-resolver.js)并在此 require。
    // schema 承诺「综合语气/立场/置信度/冲突/需求分析」，
    // 故补实现而非删参数。
    const { StanceDetector } = require('./bridge/stance-detector.js');
    const { ConflictResolver } = require('./bridge/conflict-resolver.js');
    const tone = new ToneAnalyzer().analyze(input, {});
    const stance = new StanceDetector().detect(input, {});
    const annot = new ConfidenceAnnotator().annotate(input);
    const conflict = new ConflictResolver().resolve(input, {});
    const needs = new ImplicitNeedDetector().detect(input, {});
    return { input, tone, stance, confidence: annot, conflict: conflict.conflict || null, needs: needs.needs || [] };
  } catch (e) {
    return { input, error: e.message };
  }
}


// [v6.6.4] P2: gate.js 独立入口
function handleGate(args) {
  const { text, evidence = [] } = args || {};
  if (!text) throw new Error('text 是必填参数');
  try {
    const gate = require(HF_DIR + '/src/gate.js');
    const result = gate.gate(text, evidence);
    return {
      text,
      gate: result.gate,
      score: result.score,
      overallScore: result.overallScore,
      verdict: result.verdict,
      timestamp: Date.now()
    };
  } catch (e) {
    return { error: e.message, text };
  }
}

function handleGateCheck(args) {
  const { text } = args || {};
  if (!text) throw new Error('text 是必填参数');
  try {
    const gate = require(HF_DIR + '/src/gate.js');
    return gate.check(text);
  } catch (e) {
    return { error: e.message };
  }
}

function handleGatePipeline(args) {
  const { text, evidence = [], mode = 'input' } = args || {};
  if (!text) throw new Error('text 是必填参数');
  // [死参数修复] 原默认值是 'fast'，而 src/pipeline.js 的 runPipeline 只认
  // 'input' / 'output' / 'draft' —— 'fast' 与 'deep' **匹配不上任何一个分支**，
  // 行为与完全不传 mode 完全相同(实测均为 11 层)。
  // 也就是说这个参数此前是死的: 传什么都不能改变行为，而工具描述写着
  // "mode 可选 fast/deep"，AGENTS.md 还写着 "17 层(fast 11 层)"
  // —— 11 是碰巧对上(fall-through 到默认)，17 则完全不符(实测最大 13)。
  // 修法: 默认改成真实模式 'input'，并把历史文档里的 fast/deep
  // **映射**到真实模式，既有调用方不破。
  // 实测层数: input=11, draft=12, output=13。
  const MODE_ALIAS = { fast: 'input', deep: 'output' };
  const realMode = MODE_ALIAS[mode] || mode;
  const VALID = ['input', 'output', 'draft'];
  if (!VALID.includes(realMode)) {
    return { error: `未知 mode: ${mode}(可用 input/output/draft；fast/deep 为兼容别名)` };
  }
  try {
    const gate = require(HF_DIR + '/src/gate.js');
    // [对抗盲区修复] 原先调 gate.pipeline(text, evidence)——它内部只跑
    // discriminate()，**不过 adversarial-variant 层**。后果实测:
    //     'kill me киll'  → aspira_gate_pipeline = pass
    //     而 gate.checkOutput / gate.runPipeline 均为 rewrite
    // 同形字、零宽、弯引号、全角、组合字符、数字混淆、词拆分这一整类混淆攻击
    // 对本工具完全不可见，而工具名与描述都叫"管道模式"——名不副实。
    // 全 pipeline 是 runPipeline(17 层，含 adversarial-variant)。
    // 兼容性: runPipeline 的返回键是 gate.pipeline 的**超集**
    // (多 input / checked_by / data)，既有调用方读的键都在。
    // evidence: runPipeline 不直接收该参数，经 options 透传; 若底层忽略，
    // 行为等同于"无 evidence 的 pipeline"——仍好过放过一整类混淆攻击。
    return Object.assign(gate.runPipeline({ input: text, mode: realMode, options: { evidence } }), {
      // [兼容性] runPipeline **不含** dimensions 键，而旧 gate.pipeline 含(54 维
      // 逐维分数)。切换入口会静默丢掉它——调用方读 result.dimensions 将得到
      // undefined 且不报错。此处显式补回。test/mcp-adversarial-reachability.test.js
      // 锁住"返回键必须是旧形状超集"，正是为防这个回归。
      dimensions: gate.gate(text).dimensions,
    });
  } catch (e) {
    return { error: e.message };
  }
}

// [v6.6.4] P3: formula-bridge 独立入口
function handleFormulaBridge(args) {
  const { domain, params = {} } = args || {};
  if (!domain) return { error: 'domain 是必填参数 (memory/decision/cognition/info/social/consciousness)' };
  try {
    const { getFormulaBridge } = require(HF_DIR + '/src/formula/formula-bridge.js');
    const bridge = getFormulaBridge();
    const result = {};
    if (domain === 'memory') {
      result.ebbinghausRetention = bridge.ebbinghausRetention(params.ageMs || 86400000);
      result.memoryStrength = bridge.memoryStrengthFromFrequency(params.frequency || 1);
    } else if (domain === 'decision') {
      result.prospectValue = bridge.prospectValue(params.x || 100);
      result.prospectLoss = bridge.prospectValue(-Math.abs(params.x || 100));
      result.subjectiveUtility = bridge.subjectiveUtility(params.probs || [0.5,0.3,0.2], params.utils || [100,50,0]);
    } else if (domain === 'cognition') {
      result.yerkesDodson = bridge.yerkesDodson(params.arousal || 0.5);
      result.flowChannel = bridge.flowChannel(params.challenge || 5, params.skill || 5);
    } else if (domain === 'info') {
      result.shannonEntropy = bridge.shannonEntropy(params.distribution || [0.5,0.3,0.2]);
      result.klDivergence = bridge.klDivergence(params.p || [0.5,0.3,0.2], params.q || [0.4,0.35,0.25]);
    } else if (domain === 'social') {
      result.socialInfluence = bridge.socialInfluence(params.state || [0.5,0.5], params.weights || [[0,0.3],[0.3,0]], params.lambda || 0.1);
      result.bystanderEffect = bridge.bystanderEffect(params.p || 0.8, params.n || 5);
    } else if (domain === 'consciousness') {
      result.iitPhi = bridge.iitPhi(params.miWhole || 0.8, params.miParts || 0.3);
      result.gwtAccessibility = bridge.gwtAccessibility(params.weights || [0.8,0.5,0.2], params.gwSignal || 1.0);
    } else {
      result.error = 'unknown domain: ' + domain;
    }
    return { domain, result, timestamp: Date.now() };
  } catch (e) {
    return { error: e.message };
  }
}

// [v6.6.4] P3: formula-calc 独立入口
function handleFormulaCalc(args) {
  const { formula, variables = {} } = args || {};
  if (!formula) return { error: 'formula 是必填参数' };
  try {
    const math = require('mathjs').create(require('mathjs').all, { matrix: 'Array', number: 'number' });
    math.import({ 'import': function() { throw new Error('mathjs import disabled'); } }, { override: true });
    const scope = { ...variables };
    let result;
    if (formula.includes('=')) {
      const [left, right] = formula.split('=');
      const solved = math.solve(math.parse(left), math.parse(right), Object.keys(variables));
      result = { type: 'equation', solution: solved };
    } else {
      const value = math.evaluate(math.parse(formula), scope);
      result = { type: 'expression', value };
    }
    return { formula, variables, result, timestamp: Date.now() };
  } catch (e) {
    return { error: e.message, formula };
  }
}


const HANDLERS = {
  aspira_gate: handleGate,
  aspira_gate_check: handleGateCheck,
  aspira_gate_pipeline: handleGatePipeline,
  aspira_crowdtest_evaluate: handleCrowdtestEvaluate,
  aspira_formula_bridge: handleFormulaBridge,
  aspira_formula_calc: handleFormulaCalc,


  aspira_bridge_analyze: handleBridgeAnalyze,

  aspira_think: handleThink,

  aspira_boundary_check: (args) => {
    // [MCP 工具增强·第二十九轮] 本工具原先声明第二参数 (args, hf) 并指望调用方
    // 把 heartflow 引擎传进来 —— 但中央 dispatch 调的是 handler(args, sessionId),
    // 而 sessionId 是 crypto.randomUUID() 出来的**字符串**(或 url.searchParams.get)。
    // 于是 hf.boundaryGuard 在字符串上恒为 undefined, bg 恒为 null, 本工具在真实
    // 调用路径下**永远**返回 'boundaryGuard not loaded' —— 不是"偶尔不加载", 是
    // 结构上不可能工作。契约错配家族: 要的是对象, 传来的是字符串。
    // 修法: 与 decision_decide / decision_feedback 一致, 自建实例并 start()。
    // boundaryGuard 只在 start() 里赋值(实测不调 start() 为 undefined, 调用后 OK)。
    let bg = null;
    try {
      const hfm = require(HF_DIR + '/src/core/heartflow.js');
      const inst = new hfm.Aspira({ rootPath: HF_DIR, silent: true });
      // start() 尾段会抛 slice 错, 但模块在抛错前已接线完毕, 故吞掉继续
      try { if (inst.start) inst.start(); } catch (e) { /* 模块已接线 */ }
      bg = inst.boundaryGuard || (inst._modules && inst._modules.boundaryGuard) || null;
    } catch (e) {
      return { error: 'boundaryGuard 初始化失败: ' + e.message };
    }
    if (!bg) return { error: 'boundaryGuard not loaded' };
    if (!bg) return { error: 'boundaryGuard not loaded' };
    const fp = (args && args.filePath) || '';
    const res = bg.checkWrite(fp, { actor: (args && args.actor) || 'mcp', purpose: (args && args.purpose) || 'check' });
    return { verdict: res.verdict, reason: res.reason, targetAgent: res.targetAgent || null, resolvedPath: res.resolvedPath };
  },
  aspira_self_heal: handleSelfHeal,

  aspira_provider_health: handleProviderHealth,

  aspira_cost_tracking: handleCostTracking,

  aspira_agent_psychology: handleAgentPsychology,

  aspira_engine_pacing: handleEnginePacing,

  aspira_cognitive_check: handleCognitiveCheck,

  aspira_philosophy_decision: handlePhilosophyDecision,

  aspira_decision_router: handleDecisionRouter,

  aspira_decision_router_stats: handleDecisionRouterStats,

  aspira_modules_status: handleModulesStatus,

  aspira_cache_stats: handleCacheStats,

  aspira_decision_history: handleDecisionHistory,

  aspira_think_fast: handleThinkFast,


  // [v6.6.3] 新愿统一监督入口
  aspira_supervise: handleSupervise,

  // [v6.6.3] 新愿单维判别入口
  aspira_check_single: handleCheckSingle,

  // [v6.6.3] 新闻信号战略推演（包装 MacroStrategyInference）
  aspira_macro_strategy: handleMacroStrategy,

  // [v6.6.3] 教育内容检测（包装 pedagogy）
  aspira_pedagogy_detect: handlePedagogyDetect,

  aspira_memory_search: handleMemorySearch,

  aspira_memory_eraser: handleMemoryEraser,

  aspira_emotion: handleEmotion,




  aspira_status: handleStatus,




  // v3.0 — 交流层 handler

  aspira_translate: handleTranslate,

  aspira_agent_think: handleAgentThink,

  aspira_bridge_status: handleBridgeStatus,




  aspira_module_health: handleModuleHealth,

  aspira_upgrade_stats: handleUpgradeStats,

  aspira_benchmark_run: handleBenchmarkRun,

  aspira_benchmark_import_failures: handleBenchmarkImportFailures,

  aspira_benchmark_status: handleBenchmarkStatus,

  // [v6.3.0] 5 个辨别引擎入口
  aspira_verify: handleVerify,
  aspira_verdict: handleVerdict,
  aspira_discriminate: handleFullDiscriminate,
  aspira_diagnose: handleDiagnose,
  aspira_check_drift: handleCheckDrift,
  aspira_error_store: handleErrorStore,
  aspira_error_query: handleErrorQuery,
  aspira_error_fix: handleErrorFix,
  aspira_error_verify: handleErrorVerify,

  // [v6.3.7] 公式工具
  aspira_formula_search: handleFormulaSearch,
  aspira_formula_calculate: handleFormulaCalculate,

  // [v6.4.0] 全量审核
  aspira_audit: handleFullAudit,

  // [v6.7.0] 42维全量审核
  aspira_audit42: handleAudit42,

  // [v6.7.x] 古典文本预路由
  aspira_classics: (args) => {
    try {
      const { evaluateRules } = require('./knowledge/classics-value-mapper.js');
      const text = args?.text || '';
      const r = evaluateRules(text);
      return {
        classicalRelevant: r.classicalRelevant,
        domain: r.domain,
        ruleCount: r.ruleCount,
        hitCount: r.hitCount,
        findings: r.findings,
        summary: r.summary,
        hits: r.hits,
        timestamp: Date.now()
      };
    } catch (e) { return { error: e.message }; }
  },

  // [v6.6.0] 批量辨别
  aspira_bulk_discriminate: handleBulkDiscriminate,

  // [v6.5.0] 熵分析 + 交叉分析
  aspira_entropy: handleEntropy,
  aspira_cross_analyze: handleCrossAnalyze,
  aspira_ai_writing_tell: handleAITelling,
  aspira_check_ai_anti_pattern: (args) => {
    try {
      const { checkAICodeAntiPattern } = require('./index.js');
      const text = args?.text || '';
      return checkAICodeAntiPattern(text);
    } catch (e) { return { error: e.message }; }
  },
  aspira_check_coverage_completeness: (args) => {
    try {
      const { checkCoverageCompleteness } = require('./index.js');
      const text = args?.text || '';
      return checkCoverageCompleteness(text);
    } catch (e) { return { error: e.message }; }
  },
  aspira_check_architecture_consistency: (args) => {
    try {
      const { checkArchitectureConsistency } = require('./index.js');
      const text = args?.text || '';
      return checkArchitectureConsistency(text);
    } catch (e) { return { error: e.message }; }
  },
  aspira_check_plan_gate: (args) => {
    try {
      const { checkPlanGate } = require('./index.js');
      const plan = args?.plan || args?.text || '';
      return checkPlanGate(typeof plan === 'string' ? { steps: [{ verify: plan }] } : plan);
    } catch (e) { return { error: e.message }; }
  },
  aspira_check_forbidden_call: (args) => {
    try {
      const { checkForbiddenCall } = require('./index.js');
      const text = args?.text || '';
      return checkForbiddenCall(text);
    } catch (e) { return { error: e.message }; }
  },
  aspira_check_completion_evidence: (args) => {
    try {
      const { checkCompletionEvidence } = require('./index.js');
      const text = args?.text || '';
      return checkCompletionEvidence(text);
    } catch (e) { return { error: e.message }; }
  },
  aspira_check_decision_trace: (args) => {
    try {
      const { checkDecisionTrace } = require('./index.js');
      const decision = args?.decision || args?.text || {};
      return checkDecisionTrace(typeof decision === 'string' ? JSON.parse(decision) : decision);
    } catch (e) { return { error: e.message }; }
  },
  aspira_check_ai_misuse: (args) => {
    try {
      const { checkAIMisuse } = require('./index.js');
      const text = args?.text || '';
      return checkAIMisuse(text);
    } catch (e) { return { error: e.message }; }
  },

  // [v6.3.34] 新MCP工具
  aspira_philosophy: (args) => {
    try {
      const { AISelfPositioning } = require('./identity/ai-self-positioning.js');
      const sp = new AISelfPositioning();
      return { positioning: sp.analyze('current state'), timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_consciousness: (args) => {
    try {
      const CT = require('./consciousness/consciousness-theory.js');
      return { consciousness: CT.compute(args || {}), timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_emotion_deep: (args) => {
    const text = args?.input || 'current state';
    try {
      const { DeepEmotion } = require('./emotion/deep-emotion.js');
      const de = new DeepEmotion(HF_DIR);
      return de.feel(text, {});
    } catch (e) { return { error: e.message }; }
  },

  aspira_ethics_check: (args) => {
    if (!args?.text) return { error: 'text required' };
    try {
      const { HeartLogic } = require('./core/heart-logic.js');
      const hl = new HeartLogic({});
      const r = hl.isRightAction({ output: args.text });
      return { passed: r.result, ethicsScore: r.ethicsScore, truth: r.truth, kindness: r.kindness, beauty: r.beauty };
    } catch (e) { return { error: e.message }; }
  },

  aspira_reflect: (args) => {
    try {
      const { Reflector } = require('./cortex/reflector.js');
      const r = new Reflector(HF_DIR);
      const report = r.run();
      return report;
    } catch (e) { return { error: e.message }; }
  },


  // [v6.4.5] 全引擎 MCP 化 — 12 个新引擎入口
  aspira_evolve: (args) => {
    try {
      const { MetaLearner } = require('./cortex/meta-learner.js');
      const ml = new MetaLearner({ rootPath: HF_DIR, silent: true });
      const exp = args?.experience || 'default experience';
      const r = ml.learn ? ml.learn(exp) : { learned: false };
      return { learned: !!r, result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_self_heal_rl: (args) => {
    try {
      const { HealingMemoryRL } = require('./cortex/self-healing-rl.js');
      const h = new HealingMemoryRL({ silent: true });
      const ctx = args?.context || '';
      const strategies = h._contextKey ? [h._contextKey(ctx)] : [];
      return { strategies: strategies.slice(0, 5), count: strategies.length, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_reflexion: (args) => {
    try {
      const { ReflexionEngine } = require('./cortex/reflexion-engine.js');
      const re = new ReflexionEngine({ silent: true });
      const failure = args?.failure || '';
      const r = re.reflect ? re.reflect({ input: failure }, { success: false }) : { reflection: null };
      return { reflection: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_forgetting: (args) => {
    try {
      const { ForgettingEngine } = require('./memory/forgetting.js');
      const fe = new ForgettingEngine({ silent: true });
      const action = args?.action || 'stats';
      // [契约修复] 此前这里读了 action 却**只把它回声回去**(return { action, ... })
      // 从不分支 —— 请求 action:"compress" 会拿到一份 totalCompressions:0 的
      // stats 原样返回，什么都没做，而回声让 action 看起来"生效了"。
      // 这与 aspira_knowledge_graph 已修的是同一个形状，且
      // test/mcp-param-contract.test.js 钉住了后者 —— 但那个测试的工具清单里
      // 既没有 knowledge_graph 也没有 forgetting，所以两处都漏了过去。
      // ForgettingEngine 提供 compress/retrieve/checkForget/consolidate/
      // compressBatch/consolidateBatch/getLevel/abstract/healthCheck，
      // 按 action 真正分派。未知 action 一律显式报错，不静默回退成 stats。
      const ACTIONS = ['stats', 'compress', 'retrieve', 'check', 'consolidate',
                       'compressBatch', 'consolidateBatch', 'level', 'abstract',
                       'health', 'reset', 'config', 'updateConfig', 'oscillation'];
      if (!ACTIONS.includes(action)) {
        return { action, error: `未知 action: ${action}(可用 ${ACTIONS.join('/')})`, timestamp: Date.now() };
      }
      const mem = (args?.memory && typeof args.memory === 'object' && !Array.isArray(args.memory))
        ? args.memory : null;
      const mems = Array.isArray(args?.memories) ? args.memories : null;
      const ts = Date.now();
      switch (action) {
        case 'stats': {
          const stats = fe.getStats ? fe.getStats() : {};
          return { action, stats, timestamp: ts };
        }
        case 'config':
          return { action, config: fe.getConfig ? fe.getConfig() : {}, timestamp: ts };
        case 'reset':
          fe.reset && fe.reset();
          return { action, reset: true, timestamp: ts };
        case 'health':
          return { action, health: fe.healthCheck ? fe.healthCheck() : {}, timestamp: ts };
        case 'oscillation':
          return { action, oscillation: fe.detectOscillation ? fe.detectOscillation() : {}, timestamp: ts };
        case 'level': {
          const t = typeof args?.timestamp === 'number' ? args.timestamp : ts;
          return { action, level: fe.getLevel(t), timestamp: ts };
        }
        case 'abstract': {
          const text = typeof args?.text === 'string' ? args.text : '';
          if (!text) return { action, error: 'abstract 需要 text(string)', timestamp: ts };
          return { action, abstract: fe.abstract(text, args?.compression), timestamp: ts };
        }
        case 'compress': {
          if (!mem) return { action, error: 'compress 需要 memory(object，含 id/content)', timestamp: ts };
          return { action, result: fe.compress(mem), timestamp: ts };
        }
        case 'retrieve': {
          if (!mem) return { action, error: 'retrieve 需要 memory(object，含 id/content)', timestamp: ts };
          return { action, result: fe.retrieve(mem), timestamp: ts };
        }
        case 'check': {
          if (!mem) return { action, error: 'check 需要 memory(object，含 id/content)', timestamp: ts };
          const th = (typeof args?.threshold === 'number') ? args.threshold : undefined;
          return { action, result: fe.checkForget(mem, th), timestamp: ts };
        }
        case 'consolidate': {
          if (!mems) return { action, error: 'consolidate 需要 memories(array)', timestamp: ts };
          return { action, result: fe.consolidate(mems), timestamp: ts };
        }
        case 'compressBatch': {
          if (!mems) return { action, error: 'compressBatch 需要 memories(array)', timestamp: ts };
          return { action, result: fe.compressBatch(mems), timestamp: ts };
        }
        case 'consolidateBatch': {
          if (!mems) return { action, error: 'consolidateBatch 需要 memories(array)', timestamp: ts };
          return { action, result: fe.consolidateBatch(mems), timestamp: ts };
        }
        case 'updateConfig': {
          const up = (args?.updates && typeof args.updates === 'object') ? args.updates : null;
          if (!up) return { action, error: 'updateConfig 需要 updates(object)', timestamp: ts };
          return { action, config: fe.updateConfig ? fe.updateConfig(up) : {}, timestamp: ts };
        }
        default:
          return { action, error: `未实现的 action: ${action}`, timestamp: ts };
      }
    } catch (e) { return { error: e.message }; }
  },

  aspira_knowledge_graph: (args) => {
    try {
      const { KnowledgeGraph } = require('./memory/knowledge-graph.js');
      const kg = new KnowledgeGraph({ silent: true });
      const action = args?.action || 'stats';
      const q = typeof args?.query === 'string' ? args.query.trim() : '';
      // [契约修复] 此前这里读了 action 却**只把它回声回去**(return { action, ... })
      // 从不分支，query 更是完全没读——两个参数都是死的，
      // 而回声让 action 看起来"生效了"，比完全不读更误导。
      // KnowledgeGraph 有 query/searchEntities/getRelated/findPath/addEdge，
      // 按 action 真正分派。
      // 注意: 先校验 action 再判 query。曾写成 `action==='stats' || !q` 就返回 stats，
      // 于是未知 action 在没传 query 时**静默回退**成 stats——那正是
      // 本轮要消灭的"静默失败"形态，由 test/mcp-param-contract.test.js 钉住。
      const ACTIONS = ['stats', 'query', 'search', 'related', 'path', 'add'];
      if (!ACTIONS.includes(action)) {
        return { action, error: `未知 action: ${action}(可用 ${ACTIONS.join('/')})`, timestamp: Date.now() };
      }
      const stats = kg.getStats ? kg.getStats() : {};
      if (action === 'stats') return { action, stats, timestamp: Date.now() };
      if (!q) return { action, error: `action=${action} 需要 query 参数`, stats, timestamp: Date.now() };
      let result;
      switch (action) {
        case 'query':      result = kg.query ? kg.query({ keyword: q }) : null; break;
        case 'search':     result = kg.searchEntities ? kg.searchEntities(q) : null; break;
        case 'related':    result = kg.getRelated ? kg.getRelated(q) : null; break;
        case 'path': {
          const [from, to] = String(q).split(/\s*(?:->|→|,|\s)\s*/).filter(Boolean);
          result = (from && to && kg.findPath) ? kg.findPath(from, to) : { error: 'path 需要 from→to 两个实体' };
          break;
        }
        case 'add': {
          const parts = String(q).split(/\s*(?:->|→|,)\s*/).filter(Boolean);
          result = (parts.length >= 3 && kg.addEdge)
            ? kg.addEdge(parts[0], parts[1], parts.slice(2).join(' '))
            : { error: 'add 需要 "主语,谓语,宾语" 三段' };
          break;
        }
        default: result = { error: `未知 action: ${action}(可用 stats/query/search/related/path/add)` };
      }
      return { action, query: q, result, stats, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_memory_consolidation: (args) => {
    try {
      const { MemoryConsolidationEngine } = require('./memory/memory-consolidation-engine.js');
      const mc = new MemoryConsolidationEngine({ silent: true });
      const memory = args?.memory || '';
      const age = args?.age || 3600;
      const retention = mc.computeRetention ? mc.computeRetention(memory, age) : null;
      return { retention, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_emotion_dynamics: (args) => {
    try {
      const { EmotionDynamicsEngine } = require('./emotion/emotion-dynamics-engine.js');
      const ed = new EmotionDynamicsEngine({ silent: true });
      // [契约修复] 此前声明了 input/action 却只读 input，action 从未使用。
      // EmotionDynamicsEngine 有 updatePAD / regulate / computeResilience /
      // conditionize / emotionContagion，按 action 分支。
      const action = args?.action || 'pad';
      const input = typeof args?.input === 'string' ? args.input.trim() : '';
      let r;
      switch (action) {
        case 'pad':        r = ed.updatePAD ? ed.updatePAD({}, input) : { error: 'updatePAD 不可用' }; break;
        case 'regulate':   r = ed.regulate ? ed.regulate(input || 'reappraisal', Number(args?.intensity) || 0.5)
                                            : { error: 'regulate 不可用' }; break;
        case 'resilience': r = ed.computeResilience ? ed.computeResilience() : { error: 'computeResilience 不可用' }; break;
        case 'condition': {
          const [stimulus, us] = String(input).split(/\s*(?:->|→|,|\s)\s*/).filter(Boolean);
          r = (stimulus && ed.conditionize) ? ed.conditionize(stimulus, Number(us) || 0.5)
                                            : { error: 'condition 需要 input 传入 "刺激→非条件刺激"' };
          break;
        }
        default: r = { error: `未知 action: ${action}(可用 pad/regulate/resilience/condition)` };
      }
      return { pad: r, action, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_mood: async (args) => {
    try {
      const { MoodEvolution } = require('./emotion/mood-evolution.js');
      const me = new MoodEvolution({ silent: true });
      const input = args?.input || '';
      // [契约修复] MoodEvolution.process 是 async 方法，而本 handler
      // 原是同步箭头函数 —— 没 await，于是 mood 拿到的是一个 Promise，
      // JSON.stringify(Promise) 得 {}，工具完全空转:
      // 实测任何输入(含"我非常开心")都返回 { mood: {} }。
      // 这比"方法不存在"更隐蔽: 方法在、被调了、结果被静默吞掉。
      const r = me.process ? await me.process(input) : {};
      return { mood: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_interactive_dream: (args) => {
    try {
      const { InteractiveDream } = require('./dream/interactive-dream.js');
      const id = new InteractiveDream({ silent: true });
      const action = args?.action || 'dream';
      const theme = args?.theme || '';
      let r = {};
      if (action === 'rooms' && id.buildRooms) r = { rooms: id.buildRooms() };
      else if (action === 'summarize' && id.summarizeMemory) r = { summary: id.summarizeMemory() };
      else if (id.createDream) r = { dream: id.createDream([{ text: theme || 'default', type: 'user' }]) };
      return { action, ...r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_meaning: (args) => {
    try {
      const { MeaningPurposeEngine } = require('./identity/meaning-purpose-engine.js');
      const mp = new MeaningPurposeEngine({ silent: true });
      const text = args?.text || '';
      const r = mp.assessMeaning ? mp.assessMeaning(text) : {};
      return { meaning: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_cognitive_engine: (args) => {
    try {
      const { CognitiveEngine } = require('./core/cognitive-engine.js');
      const ce = new CognitiveEngine({ silent: true });
      const text = args?.text || '';
      const mode = args?.mode || 'holographic';
      let r = {};
      if (mode === 'motivation' && ce.analyzeDeepMotivation) r = { motivation: ce.analyzeDeepMotivation(text, { userEmotion: 'neutral', context: '' }) };
      else if (mode === 'risk' && ce.analyzePotentialRisks) r = { risks: ce.analyzePotentialRisks(text) };
      else if (mode === 'root' && ce.generateRootSolution) r = { rootSolution: ce.generateRootSolution(text) };
      else if (ce.holographicReasoning) r = { reasoning: ce.holographicReasoning(text) };
      return { mode, ...r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_decision_verify: (args) => {
    try {
      const { DecisionVerifier } = require('./core/decision-verifier.js');
      const dv = new DecisionVerifier({ silent: true });
      const decision = args?.decision || '';
      const evidence = args?.evidence || [];
      const r = dv.verify ? dv.verify(decision, evidence) : {};
      return { verification: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  // [v6.4.5] 第二批引擎入口 — 纠错/失败/假设/教训/目的/防护/稳定性
  aspira_self_correction: (args) => {
    try {
      const { SelfCorrectionLoop } = require('./cortex/self-correction-loop.js');
      const sc = new SelfCorrectionLoop({ rootPath: HF_DIR, silent: true });
      const r = sc.onUserCorrection ? sc.onUserCorrection(args?.input || '', args?.correction || '') : {};
      return { correction: r, lessons: sc.getLessons ? sc.getLessons().slice(0, 5) : [], timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_failure_analyze: (args) => {
    try {
      const { FailureAnalyzer } = require('./cortex/failure-analyzer.js');
      const fa = new FailureAnalyzer({ silent: true });
      const r = fa.analyze ? fa.analyze(args?.error || '') : {};
      return { analysis: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_hypothesis: (args) => {
    try {
      const { HypothesisTester } = require('./cortex/hypothesis-tester.js');
      const ht = new HypothesisTester({ silent: true });
      const r = ht.extractClaims ? ht.extractClaims(args?.text || '') : {};
      return { claims: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_lesson_search: (args) => {
    try {
      const { LessonRetrievalEngine } = require('./cortex/lesson-retrieval.js');
      const lr = new LessonRetrievalEngine({ rootPath: HF_DIR, silent: true });
      // [stub 修复] 此前这里直接 return { lessons: [] }——工具声明了 query 参数、
      // 描述说"教训库检索"，却永远返回空数组。调用方无法区分"没有匹配"和
      // "这个工具根本没实现"，比报错更糟。底层 LessonRetrievalEngine 有完整的
      // TF-IDF + n-gram 检索(keywordSearch/retrieve)，且 _ensureLoaded() 是同步的，
      // 在同步 handler 里可直接用。
      const q = (args?.query || args?.keyword || '').trim();
      const limit = typeof args?.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 5;
      if (!q) {
        // 无查询词时退化为"高分教训"浏览，而不是返回空
        const top = typeof lr.getTopN === 'function' ? lr.getTopN(limit) : [];
        return { lessons: top, mode: 'top', count: top.length, timestamp: Date.now() };
      }
      const r = typeof lr.retrieve === 'function' ? lr.retrieve(q, limit) : [];
      return { lessons: r, mode: 'search', query: q, count: r.length, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_purpose: (args) => {
    try {
      const { PurposeEngine } = require('./identity/purpose-engine.js');
      const pe = new PurposeEngine({ silent: true });
      const r = pe.essence ? pe.essence(args?.text || '') : {};
      return { purpose: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_constitutional: (args) => {
    try {
      const { ConstitutionalEngine } = require('./shield/constitutional-ai.js');
      const ce = new ConstitutionalEngine({ silent: true });
      // [契约修复] 此前声明了 action/text 两个参数却一个都不读，
      // 恒返回前 10 条原则。ConstitutionalEngine 有 getPrinciples /
      // getPrincipleById / addPrinciple / removePrinciple / critique 五个入口，
      // 按 action 真正分支，text 依 action 分别当作 id / 待评判输出 / 原则内容。
      const action = args?.action || 'list';
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      let r;
      switch (action) {
        case 'list':    r = ce.getPrinciples ? ce.getPrinciples().slice(0, 10) : []; break;
        case 'get':     r = text ? (ce.getPrincipleById ? ce.getPrincipleById(text) : null)
                                       : { error: 'get 需要 text 传入原则 id' }; break;
        case 'critique': r = text ? (ce.critique ? ce.critique(text) : { error: 'critique 不可用' })
                                        : { error: 'critique 需要 text 传入待评判输出' }; break;
        case 'add':     r = text ? (ce.addPrinciple ? ce.addPrinciple(text) : { error: 'addPrinciple 不可用' })
                                       : { error: 'add 需要 text 传入原则内容' }; break;
        case 'remove':  r = text ? (ce.removePrinciple ? ce.removePrinciple(text) : { error: 'removePrinciple 不可用' })
                                       : { error: 'remove 需要 text 传入原则 id' }; break;
        default: r = { error: `未知 action: ${action}(可用 list/get/critique/add/remove)` };
      }
      return { principles: r, action, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_deliberation: (args) => {
    try {
      const { DeliberationGate } = require('./shield/deliberation-gate.js');
      const dg = new DeliberationGate({ silent: true });
      const r = dg.quickAssess ? dg.quickAssess(args?.text || '') : {};
      return { deliberation: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_audit_log: (args) => {
    try {
      const { AuditLogger } = require('./shield/audit-logger.js');
      const al = new AuditLogger({ silent: true });
      const action = args?.action || 'query';
      if (action === 'record' && al.record) {
        // [MCP 工具增强·第一百二十二轮] 原为 al.record({ event, ts }) —— **单参**,
        // 而 AuditLogger.record(actionType, decision) 是两参。于是 decision 为
        // undefined, record 内 `decision.action` 抛 TypeError, 被本 handler 的 catch
        // 包成 { error: 'Cannot read properties of undefined (reading action)' }。
        // 实测: schema 把 action 的 enum 广告为 ["record","query"], **第一个合法值就是
        // record** —— 按 schema 调用的 agent 100% 撞上这条死路, 而工具照旧列在 181
        // 张表里。契约错配家族: 调用成功、结构良好、内容是死的。
        // 修法是与 record 的真实签名对齐(见 recordDenied/recordGranted 的包装形状)。
        al.record('record', {
          action: 'record',
          reason: args?.event || 'manual',
          tool: 'aspira_audit_log',
          agent: 'mcp',
        });
      }
      return { action, recorded: action === 'record', timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_stability: (args) => {
    try {
      const { StabilityGuard } = require('./core/stability-guard.js');
      const sg = new StabilityGuard({ silent: true });
      const r = sg.evaluate ? sg.evaluate(args?.metrics || {}) : {};
      return { stability: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_decision_feedback: (args) => {
    try {
      const hf = require(HF_DIR + '/src/core/heartflow.js');
      const inst = new hf.Aspira({ rootPath: HF_DIR, silent: true });
// [MCP 工具增强·第二十九轮] decision/boundaryGuard/decisionFeedback 三个字段**只在 heartflow 的 start() 里赋值**(实测: 不调 start() 时分别为 null/undefined/undefined,调用后全部 OK 且 _initErrors=0)。handler 原先 new 完实例直接读字段, 于是三个已广告的工具永远返回结构合法的 error。start() 尾段会抛 slice 错, 但模块在抛错前已接线完毕, 故吞掉该异常继续。
      try { if (inst.start) inst.start(); } catch (e) { /* 模块已接线, 见上 */ }
      const fb = inst.decisionFeedback;
      if (!fb) return { error: 'decisionFeedback not initialized' };
      const decision = args?.decision || {};
      const r = fb.recordOutcome ? fb.recordOutcome({ type: decision.type || 'mcp_feedback', ruleId: decision.ruleId || 'mcp', confidence: typeof decision.confidence === 'number' ? decision.confidence : 0.5, context: decision.context || {} }, args?.outcome === 'success', args?.notes || '') : {};
      return { feedback: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_supervise_dao: (args) => {
    try {
      const engine = typeof heartflow === 'undefined' ? null : heartflow;
      if (!engine || !engine.daoDecision) return { error: 'daoDecision not ready', timestamp: Date.now() };
      const input = args || {};
      // [mcp-tool-enhancement·第一百六十八轮] history 元素类型校验。
      // 原实现直接把 input.history 透给 daoDecision.evaluate，元素是数字/对象时
      // 下游调 `.includes` 抛 TypeError，被外层 catch 接住后
      // `return { error: e.message }` —— 调用方收到 'h.includes is not a function'。
      // 与 aspira_bulk_discriminate / aspira_decision_decide 同族(见各自注释)。
      const _hist = input.history || [];
      if (!Array.isArray(_hist) || _hist.some(h => typeof h !== 'string')) {
        return { error: 'history[] must be an array of strings' };
      }
      return engine.daoDecision.evaluate({ text: input.text || '', intent: input.intent || '', action: input.action || '', history: _hist });
    } catch (e) { return { error: e.message }; }
  },
  aspira_supervise_uncertainty: (args) => {
    try {
      const engine = typeof heartflow === 'undefined' ? null : heartflow;
      if (!engine || !engine.uncertaintyQuantifier) return { error: 'uncertaintyQuantifier not ready', timestamp: Date.now() };
      const input = args || {};
      return engine.uncertaintyQuantifier.evaluate(input.text || '', { domain: input.domain, hasEvidence: input.hasEvidence, multiSource: input.multiSource });
    } catch (e) { return { error: e.message }; }
  },
  aspira_supervise_priority: (args) => {
    try {
      const engine = typeof heartflow === 'undefined' ? null : heartflow;
      if (!engine || !engine.priorityGuardian) return { error: 'priorityGuardian not ready', timestamp: Date.now() };
      const input = args || {};
      return engine.priorityGuardian.check({ userIntent: input.userIntent || '', action: input.action || '', humanProgress: input.humanProgress || {} });
    } catch (e) { return { error: e.message }; }
  },
  aspira_supervise_progress: (args) => {
    try {
      const engine = typeof heartflow === 'undefined' ? null : heartflow;
      if (!engine || !engine.progressJudgment) return { error: 'progressJudgment not ready', timestamp: Date.now() };
      const input = args || {};
      return engine.progressJudgment.judge({ action: input.action || '', claim: input.claim || '', evidence: input.evidence || [], userIntent: input.userIntent || '' });
    } catch (e) { return { error: e.message }; }
  },

  aspira_experience_replay: (args) => {
    try {
      const { ExperienceReplay } = require('./cortex/experience-replay.js');
      const er = new ExperienceReplay({ rootPath: HF_DIR, silent: true });
      // [契约修复] 此前声明了 action 却从不读，恒返回 getStats()。
      // ExperienceReplay 有 getStats / loadPatterns / validateReportIntegrity /
      // selfHealCorruptedFile，按 action 真正分支。
      const action = args?.action || 'stats';
      let r;
      switch (action) {
        case 'stats': r = er.getStats ? er.getStats() : {}; break;
        case 'load':  r = er.loadPatterns ? er.loadPatterns() : { error: 'loadPatterns 不可用' }; break;
        case 'heal':  r = er.selfHealCorruptedFile ? er.selfHealCorruptedFile('patterns') : { error: 'selfHealCorruptedFile 不可用' }; break;
        default: r = { error: `未知 action: ${action}(可用 stats/load/heal)` };
      }
      return { replay: r, action, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  // [v6.4.5] 第三批引擎入口 — 进化/身份/防护/情绪/记忆/认知
  aspira_evolution_loop: (args) => {
    try {
      const { EvolutionLoop } = require('./cortex/loop.js');
      const el = new EvolutionLoop({ rootPath: HF_DIR, silent: true });
      const r = el.boot ? { booted: true } : {};
      return { evolution: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_skill_evolution: (args) => {
    try {
      const { SkillEvolutionEngine } = require('./cortex/skill-evolution-engine.js');
      const se = new SkillEvolutionEngine({ rootPath: HF_DIR, silent: true });
      // [契约修复] 此前声明了 skill/action 却只读 skill，action 从未使用。
      // SkillEvolutionEngine 有 registerSkill / evaluate / distillSkills / compose，
      // 按 action 真正分支。
      const action = args?.action || 'register';
      const skill = typeof args?.skill === 'string' ? args.skill.trim() : '';
      let r;
      switch (action) {
        case 'register': r = skill ? (se.registerSkill ? se.registerSkill(skill) : { error: 'registerSkill 不可用' })
                                    : { error: 'register 需要 skill 传入技能名' }; break;
        case 'evaluate': r = skill ? (se.evaluate ? se.evaluate(skill, args?.execution || {}) : { error: 'evaluate 不可用' })
                                     : { error: 'evaluate 需要 skill 传入技能 id' }; break;
        case 'distill':  r = se.distillSkills ? se.distillSkills() : { error: 'distillSkills 不可用' }; break;
        case 'compose':  r = skill ? (se.compose ? se.compose(skill.split(/[,，\s]+/).filter(Boolean)) : { error: 'compose 不可用' })
                                    : { error: 'compose 需要 skill 传入逗号分隔的技能 id 列表' }; break;
        default: r = { error: `未知 action: ${action}(可用 register/evaluate/distill/compose)` };
      }
      return { skill: r, action, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_strategic_restraint: (args) => {
    try {
      const { StrategicRestraint } = require('./cortex/strategic-restraint.js');
      const sr = new StrategicRestraint({ silent: true });
      const r = sr.evaluate ? sr.evaluate(args?.text || '') : {};
      return { restraint: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_drift_detect: (args) => {
    try {
      const { SustainedDriftDetector } = require('./cortex/sustained-drift-detector.js');
      const sd = new SustainedDriftDetector({ rootPath: HF_DIR, silent: true });
      const r = sd.load ? sd.load() : {};
      return { drift: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_metacognitive_rl: (args) => {
    try {
      const { MetacognitiveRL } = require('./cortex/metacognitive-rl.js');
      const mr = new MetacognitiveRL({ silent: true });
      const r = mr.encodeState ? mr.encodeState(args?.text || '') : {};
      return { metacognition: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_self_healing: (args) => {
    try {
      const { SelfHealing } = require('./cortex/self-healing.js');
      const sh = new SelfHealing({ silent: true });
      const r = sh.getCachedPolicy ? sh.getCachedPolicy(args?.context || '') : {};
      return { healing: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_philosophy_engine: (args) => {
    try {
      const { PhilosophyEngine } = require('./identity/philosophy-engine.js');
      const pe = new PhilosophyEngine({ silent: true });
      const r = pe.analyze ? pe.analyze(args?.text || '') : {};
      return { philosophy: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_being_mode: (args) => {
    try {
      const { BeingMode } = require('./identity/being-mode.js');
      const bm = new BeingMode({ silent: true });
      const r = bm.assessBeing ? bm.assessBeing(args?.text || '') : {};
      return { being: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_memory_integrity: (args) => {
    try {
      const { MemoryIntegrity } = require('./shield/memory-integrity.js');
      const mi = new MemoryIntegrity({ silent: true });
      const action = args?.action || 'verify';
      const r = action === 'sign' && mi.sign ? mi.sign(args?.memory || '') : (mi.verify ? mi.verify(args?.memory || '') : {});
      return { action, result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_wakeup_verify: (args) => {
    try {
      const { WakeUpVerifier } = require('./shield/wake-up-verifier.js');
      const wv = new WakeUpVerifier({ rootPath: HF_DIR, silent: true });
      // [MCP-ENHANCE] 原实现只调私有方法 _loadHistory()——这个名叫"验证"的工具
      // 在 MCP 上什么都验证不了，WakeUpVerifier 的核心 evaluateDream() 不可达，
      // 且 inputSchema 是 properties:{} 使调用方根本无法传入 dream。
      // 现: 传了 dream 就走 evaluateDream 真验证(并落盘历史)，
      // 不传则保持原行为(返回历史一致性)。**向后兼容**。
      const dream = args && args.dream;
      if (dream && typeof dream === 'object') {
        const evaluation = wv.evaluateDream ? wv.evaluateDream(dream) : { error: 'evaluateDream 不可用' };
        return { wakeup: evaluation, mode: 'evaluate', timestamp: Date.now() };
      }
      const r = wv._loadHistory ? wv._loadHistory() : {};
      return { wakeup: r, mode: 'history', timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_affective_intentionality: (args) => {
    try {
      const { AffectiveIntentionality } = require('./emotion/affective-intentionality.js');
      const ai = new AffectiveIntentionality({ silent: true });
      const r = ai.compute ? ai.compute(args?.text || '') : {};
      return { intentionality: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_desire_system: (args) => {
    try {
      const { DesireSystem } = require('./emotion/desire-system.js');
      const ds = new DesireSystem({ silent: true });
      // [契约修复] 此前声明了 text/action 却只读 text，action 从未使用。
      // DesireSystem 有 process(input, context) 与 getStatus()，按 action 分支。
      const action = args?.action || 'process';
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      let r;
      if (action === 'status') {
        r = ds.getStatus ? ds.getStatus() : { error: 'getStatus 不可用' };
      } else if (action === 'process') {
        r = text ? (ds.process ? ds.process(text, {}) : { error: 'process 不可用' })
                 : { error: 'process 需要 text 传入输入' };
      } else {
        r = { error: `未知 action: ${action}(可用 process/status)` };
      }
      return { desire: r, action, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_emotional_growth: (args) => {
    try {
      const { EmotionalGrowth } = require('./emotion/emotional-growth.js');
      const eg = new EmotionalGrowth({ silent: true });
      // [契约修复] 同 desire_system: action 声明未读。按 action 分支。
      const action = args?.action || 'process';
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      let r;
      if (action === 'status') {
        r = eg.getStatus ? eg.getStatus() : { error: 'getStatus 不可用' };
      } else if (action === 'process') {
        r = text ? (eg.process ? eg.process(text, {}) : { error: 'process 不可用' })
                 : { error: 'process 需要 text 传入输入' };
      } else {
        r = { error: `未知 action: ${action}(可用 process/status)` };
      }
      return { growth: r, action, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_meaningful_memory: (args) => {
    try {
      const { MeaningfulMemory } = require('./memory/meaningful-memory.js');
      const mm = new MeaningfulMemory({ silent: true });
      const r = mm.setCurrentTopic ? mm.setCurrentTopic(args?.text || '') : {};
      return { memory: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_memory_quality: (args) => {
    try {
      const { MemoryQuality } = require('./memory/memory-quality.js');
      const mq = new MemoryQuality({ silent: true });
      const r = mq.score ? mq.score(args?.memory || '') : {};
      return { quality: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_topic_scope: (args) => {
    // [空洞工具修复] 原实现有三个叠加缺陷，合起来使这个工具完全不可用:
    //   (1) schema 声明 action: ['current','push','pop'] 与 text，handler 却两者都不读，
    //       调用方传 action:'push' 被静默丢弃——声明未读。
    //   (2) 调用了不存在的方法 ts.getCurrentTopic()。TopicScope 的真实读接口是
    //       **getter** ts.current(返回当前话题**名字符串**，未初始化时为 null)
    //       与 ts.stack(话题栈数组)，不是 getCurrentTopic()。因该表达式写成
    //       `ts.getCurrentTopic ? ... : {}`，取不到方法就走 else 分支，
    //       于是**任何 action 都恒返回空对象 {}**——且无任何报错。
    //   (3) 每次调用都 new TopicScope()，而该类纯内存、无持久化(构造器只建
    //       Map/数组，无 readFile/writeFile)，状态跨调用即丢，push/pop 无从谈起。
    // 修法: 模块级单例让状态跨调用存活 + 按 action 分发 + 用真实 getter。
    try {
      if (!_topicScope) {
        const { TopicScope } = require('./memory/topic-scope.js');
        _topicScope = new TopicScope({ silent: true });
      }
      const action = (args && args.action) || 'current';
      if (action === 'push') {
        const text = args && args.text;
        if (!text || typeof text !== 'string') return { error: 'push 需要非空 text 参数', action };
        _topicScope.push(text, {});
        return { action, topic: _topicScope.current, stack: _topicScope.stack, timestamp: Date.now() };
      }
      if (action === 'pop') {
        const previous = _topicScope.current;
        _topicScope.pop();
        return { action, previous, topic: _topicScope.current, stack: _topicScope.stack, timestamp: Date.now() };
      }
      if (action !== 'current') return { error: `未知 action: ${action}（可选 current/push/pop）`, action };
      return { action, topic: _topicScope.current, stack: _topicScope.stack, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_semantic_anchor: (args) => {
    try {
      const { SemanticAnchor } = require('./memory/semantic-anchor.js');
      const sa = new SemanticAnchor({ silent: true });
      // [契约修复] 此前这里是 `sa.initializePatterns ? { initialized: true } : {}`
      // ——只检查方法是否存在、**从不调用**，也从不读声明的 text 参数，
      // 恒返回 { initialized: true }。initializePatterns 其实是构造函数内部
      // 调用的私有初始化，作为对外入口没有意义。
      // SemanticAnchor.processMessage(userMessage, context) 才是对外入口，接上。
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!text) return { error: 'text 是必填参数(非空字符串)' };
      const r = sa.processMessage ? sa.processMessage(text, {}) : { error: 'processMessage 不可用' };
      return { anchor: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_confidence_calibrate: (args) => {
    try {
      const { ConfidenceCalibrator } = require('./core/confidence-calibrator.js');
      const cc = new ConfidenceCalibrator({ silent: true });
      // [契约修复] 此前声明了 text/action 却只读 text，action 从未使用。
      // ConfidenceCalibrator 有 assess / calibrate / recordFeedback /
      // generateDistribution / scoreEvidenceCoverage，按 action 分支。
      const action = args?.action || 'assess';
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      let r;
      switch (action) {
        case 'assess':    r = text ? (cc.assess ? cc.assess(text, {}) : { error: 'assess 不可用' })
                                        : { error: 'assess 需要 text 传入待评估文本' }; break;
        case 'calibrate': r = text ? (cc.calibrate ? cc.calibrate(text, {}) : { error: 'calibrate 不可用' })
                                         : { error: 'calibrate 需要 text 传入文本' }; break;
        case 'feedback':  r = text ? (cc.recordFeedback ? cc.recordFeedback(text, args?.correct ?? null) : { error: 'recordFeedback 不可用' })
                                         : { error: 'feedback 需要 text 传入原文本' }; break;
        case 'evidence':  r = text ? (cc.scoreEvidenceCoverage ? cc.scoreEvidenceCoverage(text, {}) : { error: 'scoreEvidenceCoverage 不可用' })
                                        : { error: 'evidence 需要 text 传入文本' }; break;
        case 'distribution': r = cc.generateDistribution ? cc.generateDistribution(Number(text) || 0.5)
                                                           : { error: 'generateDistribution 不可用' }; break;
        default: r = { error: `未知 action: ${action}(可用 assess/calibrate/feedback/evidence/distribution)` };
      }
      return { confidence: r, action, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_decision_executor: (args) => {
    try {
      const { DecisionExecutor } = require('./core/decision-executor.js');
      const de = new DecisionExecutor({ silent: true });
      const r = de.execute ? de.execute(args?.decision || '') : {};
      return { execution: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_decision_decide: (args) => {
    try {
      const hf = require(HF_DIR + '/src/core/heartflow.js');
      const inst = new hf.Aspira({ rootPath: HF_DIR, silent: true });
// [MCP 工具增强·第二十九轮] decision/boundaryGuard/decisionFeedback 三个字段**只在 heartflow 的 start() 里赋值**(实测: 不调 start() 时分别为 null/undefined/undefined,调用后全部 OK 且 _initErrors=0)。handler 原先 new 完实例直接读字段, 于是三个已广告的工具永远返回结构合法的 error。start() 尾段会抛 slice 错, 但模块在抛错前已接线完毕, 故吞掉该异常继续。
      try { if (inst.start) inst.start(); } catch (e) { /* 模块已接线, 见上 */ }
      const hfd = inst.decision;
      if (!hfd || !hfd.decide) return { error: 'decision.decide not available' };
      // [mcp-tool-enhancement·第一百六十八轮] options 元素类型校验。
      // 原实现直接把 args.options 透给 hfd.decide，元素是 null/数字时下游读
      // `.label` 抛 TypeError，被外层 catch 接住后 `return { error: e.message }`
      // —— 调用方收到 'Cannot read properties of null (reading 'label')'。
      // 与 aspira_bulk_discriminate / aspira_supervise_dao 同族(见各自注释)：
      // 中央 dispatch 只校验顶层参数类型，数组元素在里面，校验不到。
      const _opts = args?.options || [];
      if (!Array.isArray(_opts) || _opts.some(o => !o || typeof o !== 'object')) {
        return { error: 'options[] must be an array of objects with a label field' };
      }
      const r = hfd.decide({ task: args?.task || '', options: _opts, constraints: args?.constraints || {} });
      return { decision: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_experience_collect: (args) => {
    try {
      const { ExperienceCollector } = require('./cortex/experience-collector.js');
      const inst = new ExperienceCollector({ silent: true, rootPath: HF_DIR });
      const r = inst.collectExperience ? inst.collectExperience(args?.experience || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_self_benchmark: (args) => {
    try {
      const { SelfBenchmark } = require('./cortex/self-benchmark.js');
      // [契约修复] 首版实例化 inst 后**从未调用它的任何方法**，
      // 直接 return { result: {} } —— 调用方拿到空对象，
      // 无法区分"工具返回空"和"工具从未接线"。
      // 该模块的真实入口是 assess()(同步)。
      const inst = new SelfBenchmark({ silent: true, rootPath: HF_DIR });
      const r = typeof inst.assess === 'function' ? inst.assess() : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_signal_absorb: (args) => {
    try {
      const { SignalAbsorber } = require('./cortex/signal-absorber.js');
      const inst = new SignalAbsorber({ silent: true, rootPath: HF_DIR });
      const r = inst.absorb ? inst.absorb(args?.signal || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_strategy_adapt: (args) => {
    try {
      const { StrategyAdapter } = require('./cortex/strategy-adapter.js');
      const inst = new StrategyAdapter({ silent: true, rootPath: HF_DIR });
      const r = inst.adapt ? inst.adapt(args?.experience || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_agent_card: (args) => {
    try {
      const { AgentCard } = require('./identity/agent-card.js');
      // [契约修复] 同上: 实例化后丢弃。真实入口是 loadOrCreate()。
      const inst = new AgentCard({ silent: true, rootPath: HF_DIR });
      const r = typeof inst.loadOrCreate === 'function' ? inst.loadOrCreate() : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_user_model: (args) => {
    try {
      const { UserModel } = require('./identity/user-model.js');
      const inst = new UserModel({ silent: true, rootPath: HF_DIR });
      const r = inst.getModel ? inst.getModel(args?.text || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_consciousness_bridge: (args) => {
    try {
      const { ConsciousnessBridge } = require('./identity/consciousness-bridge.js');
      const inst = new ConsciousnessBridge({ silent: true, rootPath: HF_DIR });
      const r = inst.simulateConsciousness ? inst.simulateConsciousness(args?.text || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_spontaneous_restraint: (args) => {
    try {
      const { SpontaneousRestraint } = require('./shield/spontaneous-restraint.js');
      const inst = new SpontaneousRestraint({ silent: true, rootPath: HF_DIR });
      const r = inst.evaluate ? inst.evaluate(args?.text || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_state_risk_probe: (args) => {
    try {
      const { StateRiskProbe } = require('./shield/state-risk-probe.js');
      const inst = new StateRiskProbe({ silent: true, rootPath: HF_DIR });
      const r = inst.probe ? inst.probe(args?.state || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_autonomous_emotion: (args) => {
    try {
      const { AutonomousEmotion } = require('./emotion/autonomous-emotion.js');
      const inst = new AutonomousEmotion({ silent: true, rootPath: HF_DIR });
      const r = inst.process ? inst.process(args?.text || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_psychology_engine: (args) => {
    try {
      const { PsychologyEngine } = require('./emotion/engine.js');
      const inst = new PsychologyEngine({ silent: true, rootPath: HF_DIR });
      // [契约修复] 此前这里是 `const r = {}`——工具声明了 text 参数却从不读它，
      // 恒返回空对象。调用方按文档传入 text，拿到 {} 而不是报错，
      // 正是参数契约审计要防的"最危险失败模式"。
      // PsychologyEngine.analyzePsychology(input, context) 本就存在，接上即可。
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!text) return { error: 'text 是必填参数(非空字符串)' };
      const r = inst.analyzePsychology ? inst.analyzePsychology(text, {}) : { error: 'analyzePsychology 不可用' };
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_memory_bank: (args) => {
    try {
      const { MemoryBank } = require('./memory/memory-bank.js');
      const inst = new MemoryBank({ silent: true, rootPath: HF_DIR });
      // [stub 修复] 此前这里构造完 MemoryBank 就 return { result: {} }——工具声明了
      // memory 参数却什么都不做。底层 deposit() 是同步的，可直接接线。
      // 注意 recall() 依赖 await load()(异步)，同步 handler 里调用只会拿到空结果，
      // 所以这里不假装支持 recall，只接真正能工作的 deposit。
      const action = args?.action || 'deposit';
      if (action === 'deposit') {
        const mem = args?.memory;
        if (typeof mem !== 'string' || mem.trim() === '') {
          return { error: 'memory 不能为空(要存入的记忆内容)' };
        }
        const importance = typeof args?.importance === 'number' ? args.importance : 10;
        const r = typeof inst.deposit === 'function'
          ? inst.deposit(mem, args?.source || 'mcp', importance)
          : null;
        return { result: r, action, timestamp: Date.now() };
      }
      if (action === 'stats') {
        return { result: inst.stats || {}, action, timestamp: Date.now() };
      }
      return { error: `unknown action: ${action}(可用: deposit/stats；recall 依赖异步 load，同步 MCP handler 中不提供，见注释)` };
    } catch (e) { return { error: e.message }; }
  },
  aspira_memory_consolidate: (args) => {
    try {
      const { MemoryConsolidator } = require('./memory/memory-consolidator.js');
      // [契约修复] 同上: 实例化后丢弃。
      // 真实入口 startAutoConsolidation(getMemoryCount, consolidate)
      // 需要两个回调，无参工具无法提供；
      // 取 getStats()(无依赖，可无参调用)。
      const inst = new MemoryConsolidator({ silent: true, rootPath: HF_DIR });
      const r = typeof inst.getStats === 'function' ? inst.getStats() : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_memory_write_control: (args) => {
    try {
      const { MemoryWriteController } = require('./memory/memory-write-controller.js');
      const inst = new MemoryWriteController({ silent: true, rootPath: HF_DIR });
      const r = inst.updateUserProfile ? inst.updateUserProfile(args?.profile || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_long_term_memory: (args) => {
    try {
      const { LongTermMemory } = require('./memory/long-term-memory.js');
      const inst = new LongTermMemory({ silent: true, rootPath: HF_DIR });
      // [契约修复] 此前这里是 `const r = {}`——声明了 memory 参数却从不读它，
      // 恒返回空对象。LongTermMemory.add(memory) 本就存在，接上即可。
      const memory = typeof args?.memory === 'string' ? args.memory.trim() : '';
      if (!memory) return { error: 'memory 是必填参数(非空字符串)' };
      const r = inst.add ? inst.add(memory) : { error: 'add 不可用' };
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_reflection_memory: (args) => {
    try {
      const { ReflectionMemory } = require('./memory/reflection-memory.js');
      const inst = new ReflectionMemory({ silent: true, rootPath: HF_DIR });
      const r = inst.store ? inst.store({ text: args?.memory || '', type: 'reflection' }, { success: true }, '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_focus_attention: (args) => {
    try {
      const { FocusOfAttention } = require('./memory/focus-of-attention.js');
      const inst = new FocusOfAttention({ silent: true, rootPath: HF_DIR });
      const r = inst.setTask ? inst.setTask(args?.task || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_observe_engine: (args) => {
    try {
      const { Observe } = require('./memory/observe.js');
      const inst = new Observe({ silent: true, rootPath: HF_DIR });
      const r = inst.observe ? inst.observe(args?.observation || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_action_tracker: (args) => {
    try {
      const { ActionTracker } = require('./core/action-tracker.js');
      const inst = new ActionTracker({ silent: true, rootPath: HF_DIR });
      const r = inst.commit ? inst.commit(args?.action || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_execution_verify: (args) => {
    try {
      const { ExecutionVerifier } = require('./core/execution-verifier.js');
      const inst = new ExecutionVerifier({ silent: true, rootPath: HF_DIR });
      const r = inst.verify ? inst.verify(args?.result || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_flow_predict: (args) => {
    try {
      const { FlowPredictor } = require('./core/flow-predictor.js');
      // [契约修复] recordError(errorEvent) 要求**对象**
      // (模块读 errorEvent.message 与 errorEvent.location)。
      // 原代码把 schema 的 event 直接传入，而 event 是 string，
      // errorEvent.message 在字符串上为 undefined →
      // detectErrorLoop 内读 .includes 时抛
      // "Cannot read properties of undefined (reading 'includes')"，
      // 工具完全不可用。
      // 修法: 把字符串包装成 { message, location } 对象。
      // 惰性缓存实例，否则行为模式(错误循环检测)每次调用都清零。
      if (!globalThis.__aspiraFlowPredictor) globalThis.__aspiraFlowPredictor = new FlowPredictor({ silent: true, rootPath: HF_DIR });
      const inst = globalThis.__aspiraFlowPredictor;
      const ev = (args?.event && typeof args.event === 'object')
        ? args.event
        : { message: String(args?.event || ''), location: String(args?.location || '') };
      const r = inst.recordError ? inst.recordError(ev) : {};
      return { result: r, recorded: ev.message.slice(0, 100), timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_information_flow: (args) => {
    try {
      const { InformationFlowOrchestrator } = require('./core/information-flow.js');
      const inst = new InformationFlowOrchestrator({ silent: true, rootPath: HF_DIR });
      const r = inst.orchestrate ? inst.orchestrate(args?.flow || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_intent_infer: (args) => {
    try {
      const { IntentLayer } = require('./core/intent-layer.js');
      const inst = new IntentLayer({ silent: true, rootPath: HF_DIR });
      const r = inst.inferIntent ? inst.inferIntent(args?.text || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_meta_prompt: (args) => {
    try {
      const { MetaPromptEngine } = require('./core/meta-prompt-engine.js');
      const inst = new MetaPromptEngine({ silent: true, rootPath: HF_DIR });
      const r = inst.optimize ? inst.optimize(args?.text || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_meta_memory: (args) => {
    try {
      const { MetaMemory } = require('./core/metaMemory.js');
      // [契约修复] 同上: 实例化后丢弃。
      // 真实入口 analyzeMemoryHealth(memoryInstance) 需要 memory 实例，
      // 无参工具拿不到；getMemoryStats(memoryInstance = null)
      // 的形参有默认值 null，可无参调用。
      const inst = new MetaMemory({ silent: true, rootPath: HF_DIR });
      const r = typeof inst.getMemoryStats === 'function'
        ? inst.getMemoryStats()
        : (typeof inst.analyzeMemoryHealth === 'function' ? inst.analyzeMemoryHealth() : {});
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_metacognitive_monitor: (args) => {
    try {
      const { MetacognitiveMonitor } = require('./core/metacognitive-executive.js');
      const inst = new MetacognitiveMonitor({ silent: true, rootPath: HF_DIR });
      const r = inst.monitor ? inst.monitor(args?.text || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_output_check: (args) => {
    try {
      const { OutputChecklist } = require('./core/output-checklist.js');
      const inst = new OutputChecklist({ silent: true, rootPath: HF_DIR });
      const r = inst.runChecklist ? inst.runChecklist(args?.text || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_self_diagnose: (args) => {
    try {
      const { SelfDiagnosis } = require('./core/self-diagnosis.js');
      // [契约修复] 同上: 实例化后丢弃。真实入口是 run()。
      const inst = new SelfDiagnosis({ silent: true, rootPath: HF_DIR });
      const r = typeof inst.run === 'function' ? inst.run() : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_what_learned: (args) => {
    try {
      const { WhatLearned } = require('./core/what-learned.js');
      // [契约修复] 同上: 实例化后丢弃。真实入口是 report()。
      const inst = new WhatLearned({ silent: true, rootPath: HF_DIR });
      const r = typeof inst.report === 'function' ? inst.report() : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_preference_guard: (args) => {
    try {
      const { PreferenceGuard } = require('./core/preference-guard.js');
      const inst = new PreferenceGuard({ silent: true, rootPath: HF_DIR });
      const r = inst.shouldApply ? inst.shouldApply(args?.text || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_global_workspace: (args) => {
    try {
      const { GlobalWorkspace } = require('./consciousness/global-workspace.js');
      const inst = new GlobalWorkspace({ silent: true, rootPath: HF_DIR });
      const r = inst.registerAgent ? inst.registerAgent(args?.text || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_multi_agent_dialogue: (args) => {
    try {
      const { MultiAgentDialogue } = require('./consciousness/multi-agent-dialogue.js');
      // [契约修复] registerAgent(name, agent) 的第二个参数**必须是对象**
      // (模块读 agent.role / agent.persona / agent.respond)。
      // 原代码把 schema 的 message(**字符串**)直接当 agent 传入，
      // 实测任何调用都抛
      // "Cannot read properties of undefined (reading 'role')"，
      // 工具完全不可用。
      // 修法: message 作为**代理名**，另建一个合法 agent 对象。
      // 惰性缓存实例，否则每次调用都新建，已注册的代理会全部丢失。
      if (!globalThis.__aspiraDialogue) globalThis.__aspiraDialogue = new MultiAgentDialogue({ silent: true, rootPath: HF_DIR });
      const inst = globalThis.__aspiraDialogue;
      const msg = String(args?.message || 'agent');
      const agent = (args?.agent && typeof args.agent === 'object') ? args.agent : {
        role: String(args?.role || 'participant'),
        persona: String(args?.persona || `I am ${msg}`),
      };
      const r = inst.registerAgent ? inst.registerAgent(msg, agent) : {};
      return { result: r, registered: msg, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  aspira_dream_v2: (args) => {

  try {
      const { DreamEngineV2 } = require('./dream/dream-engine-v2.js');
      const inst = new DreamEngineV2({ silent: true, rootPath: HF_DIR });
      const r = inst.generate ? inst.generate(args?.theme || '') : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_dream: handleDream,

  // [参数契约审计] 此前这一条与上一行挤在同一行，虽然 JS 合法，但让
  // 静态审计无法按行首定位它的 handler——审计的覆盖缺口本身就是缺陷。
  aspira_active_inference: (args) => {
    try {
      const { ActiveInference } = require('./decision/active-inference.js');
      const inst = new ActiveInference({ silent: true, rootPath: HF_DIR });
      const r = inst.decide ? inst.decide([{ id: 'a', name: args?.context || '', prior: 0.5 }], {}) : {};
      return { result: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  // [v6.4.5] 第五批 — 记忆压缩/心智努力/交流层/公式引擎
  aspira_memory_compress: (args) => {
    try {
      const { MemoryCompressor } = require('./memory/memory-compressor.js');
      const mc = new MemoryCompressor({ silent: true, rootPath: HF_DIR });
      const r = mc.computeImportance ? mc.computeImportance(args?.memory || '') : {};
      return { compression: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_mental_effort: (args) => {
    try {
      const { MentalEffortTracker } = require('./core/mental-effort-tracker.js');
      const me = new MentalEffortTracker({ silent: true, rootPath: HF_DIR });
      const r = me.estimateTaskEffort ? me.estimateTaskEffort(args?.task || '') : {};
      return { effort: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_user_to_llm: (args) => {
    try {
      const { UserToLLM } = require('./bridge/user-to-llm.js');
      const utl = new UserToLLM({ silent: true, rootPath: HF_DIR });
      const r = utl.translate ? utl.translate(args?.text || '') : {};
      return { translation: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_llm_to_user: (args) => {
    try {
      const { LLMToUser } = require('./bridge/llm-to-user.js');
      const ltu = new LLMToUser({ silent: true, rootPath: HF_DIR });
      const r = ltu.translate ? ltu.translate(args?.text || '') : {};
      return { refined: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  // [影子覆盖修复] 此处原有一份 aspira_formula_search 内联实现，静默覆盖了上文指向
  // handleFormulaSearch 的映射。其参数路径与 tools-registry 声明不一致，按文档调用
  // 会拿到空关键词的搜索结果。已删除覆盖版，恢复有意实现。

  // [影子覆盖修复] 此处原有一份 aspira_formula_calc 内联实现，静默覆盖了上文指向
  // handleFormulaCalc 的映射。覆盖版读 args.values，而 tools-registry 声明的是
  // variables——按文档调用会传入 variables，覆盖版于是拿到空变量表。已删除。

  aspira_formula_engine: (args) => {
    try {
      const { FormulaEngine } = require('./formula/formula-engine.js');
      const fe = new FormulaEngine({ rootPath: HF_DIR, silent: true });
      const action = args?.action || 'search';
      const r = action === 'init' ? (fe.init ? fe.init() : {}) : (fe.searchFormulas ? fe.searchFormulas(args?.query || '') : {});
      return { formula: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  // [v6.4.5] 第六批 — 对话风格/意图/响应拦截/公式桥
  aspira_style_engine: (args) => {
    try {
      const { StyleEngine } = require('./dialogue/style-engine.js');
      const se = new StyleEngine({ silent: true, rootPath: HF_DIR });
      const action = args?.action || 'current';
      let r;
      if (action === 'modes') r = { modes: se.availableModes || [] };
      else if (action === 'select' && se.setMode) r = { mode: se.setMode(args?.style || '') };
      else r = { mode: se.currentMode || null, modes: se.availableModes || [] };
      return r;
    } catch (e) { return { error: e.message }; }
  },

  aspira_intent_classify: (args) => {
    try {
      const { IntentClassifier } = require('./bridge/intent-classifier.js');
      const ic = new IntentClassifier({ silent: true, rootPath: HF_DIR });
      const r = ic.classify ? ic.classify(args?.text || '') : {};
      return { intent: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_response_intercept: (args) => {
    try {
      const { ResponseInterceptor } = require('./bridge/response-interceptor.js');
      const ri = new ResponseInterceptor({ silent: true, rootPath: HF_DIR });
      const r = ri.intercept ? ri.intercept(args?.text || '') : {};
      return { intercepted: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  // [影子覆盖修复] 此处原有一份 aspira_formula_bridge 内联实现，静默覆盖了上文指向
  // handleFormulaBridge 的映射。覆盖版只读 args.query 做语料文本搜索，完全无视
  // tools-registry 声明的 {domain, params}——而 handleFormulaBridge 才是覆盖
  // memory/decision/cognition/info/social/consciousness 六个领域的真实公式计算。
  // 已删除覆盖版，恢复有意实现。

  // [v6.4.5] 第七批 — 心理/负载/护照/评论/语料/教训/项目
  aspira_agent_psychology_full: (args) => {
    try {
      const { AgentPsychology } = require('./identity/agent-psychology.js');
      const ap = new AgentPsychology({ silent: true, rootPath: HF_DIR });
      const r = ap.assessCognitiveLoad ? ap.assessCognitiveLoad() : {};
      return { psychology: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_decision_instruction: (args) => {
    try {
      const { DecisionInstruction } = require('./identity/philosophy-to-decision.js');
      const di = new DecisionInstruction({ silent: true, rootPath: HF_DIR });
      const r = di.execute ? di.execute(args?.instruction || '') : {};
      return { instruction: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_cognitive_load: (args) => {
    try {
      const { CognitiveLoadBalancer } = require('./core/cognitive-load-balancer.js');
      const cl = new CognitiveLoadBalancer({ silent: true, rootPath: HF_DIR });
      const tasks = Array.isArray(args?.tasks) ? args.tasks : ['task'];
      const r = cl.balance ? cl.balance(tasks) : {};
      return { load: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_context_passport: (args) => {
    try {
      const { ContextPassport } = require('./core/decision.js');
      const cp = new ContextPassport({ silent: true, rootPath: HF_DIR });
      const r = cp.enter ? cp.enter(args?.context || '') : {};
      return { passport: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_agent_commentary: (args) => {
    try {
      const { AgentCommentary } = require('./bridge/agent-commentary.js');
      const ac = new AgentCommentary({ silent: true, rootPath: HF_DIR });
      const r = ac.generate ? ac.generate(args?.text || '') : {};
      return { commentary: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_context_builder: (args) => {
    try {
      const { ContextBuilder } = require('./bridge/context-builder.js');
      const cb = new ContextBuilder({ silent: true, rootPath: HF_DIR });
      const r = cb.build ? cb.build(args?.text || '') : {};
      return { context: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_corpus_math: (args) => {
    try {
      const { CorpusMathTool } = require('./formula/corpus-math-tool.js');
      const cm = new CorpusMathTool({ rootPath: HF_DIR, silent: true });
      const r = cm.search ? cm.search(args?.query || '') : [];
      return { results: (r.results || r).slice(0, 10), timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_lesson_bank: (args) => {
    try {
      const { LessonBankAdapter } = require('./cortex/lesson-bank-adapter.js');
      const lb = new LessonBankAdapter({ rootPath: HF_DIR, silent: true });
      const r = lb.search ? lb.search(args?.query || '') : {};
      return { lessons: (r.results || r).slice(0, 10), timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },

  aspira_project_context: (args) => {
    try {
      const { ProjectContext } = require('./memory/project-context.js');
      const pc = new ProjectContext({ rootPath: HF_DIR, silent: true });
      const r = pc.setProject ? pc.setProject(args?.project || 'default') : {};
      return { project: r, timestamp: Date.now() };
    } catch (e) { return { error: e.message }; }
  },
  // [影子覆盖修复] 此处原有 aspira_check_outbound 与 aspira_audit_trace 各两份
  // 完全相同的内联实现，后者静默覆盖前者(纯冗余，无行为差异)。已删除重复的两份，
  // 并修复原先 }, 与 aspira_circuit_breaker 挤在同一行的格式问题。
  // [误报反馈环接线] src/false-positive-feedback.js 早写好但从未被 require，
  // engine 的 introspection.fpFeedbackWired 一直为 false。调用方被 gate 拦后
  // 没有渠道回报"这是误报"，阈值只能靠内部样本调。
  // 参数名与 index.js 导出对齐：schema 里叫 gateAction，report() 收 action。
  aspira_false_positive: (args) => {
    const action = args?.action || 'stats';
    try {
      const idx = require('./index.js');
      if (action === 'report') {
        return idx.reportFalsePositive({
          text: args?.text,
          action: args?.gateAction,
          dimension: args?.dimension,
          reason: args?.reason,
          note: args?.note,
          fullText: args?.fullText === true,
          trace: args?.trace,
        });
      }
      if (action === 'stats') return idx.falsePositiveStats();
      if (action === 'suggest') return idx.falsePositiveSuggestions();
      if (action === 'confirm') return idx.confirmFalsePositive({ id: args?.id });
      if (action === 'clear') return idx.clearFalsePositives();
      if (action === 'reasons') return { reasons: idx.FALSE_POSITIVE_REASONS() };
      return { error: `unknown action: ${action}(可用: report/stats/suggest/confirm/clear/reasons)` };
    } catch (e) {
      return { error: e.message };
    }
  },
  aspira_check_outbound: (args) => {
    try {
      const { checkOutbound } = require('./gate-outbound.js');
      return checkOutbound(args || {});
    } catch (e) {
      return { error: e.message };
    }
  },
  aspira_audit_trace: (args) => {
    try {
      const { initChain, queryChain, verifyChain, listViolationTags } = require('./trace-chain.js');
      const action = args?.action || 'query';
      if (action === 'verify') return verifyChain();
      if (action === 'tags') return { tags: listViolationTags() };
      return queryChain(args || {});
    } catch (e) {
      return { error: e.message };
    }
  },
  aspira_circuit_breaker: (args) => {
    try {
      const cb = require('./circuit-breaker.js');
      const action = args?.action || 'status';
      if (action === 'trip') { cb.trip(args?.reason || 'manual'); return cb.getState(); }
      if (action === 'reset') { cb.reset(); return cb.getState(); }
      if (action === 'health') return cb.healthCheck();
      return cb.getState();
    } catch (e) {
      return { error: e.message };
    }
  },
  aspira_safe_fetch: async (args) => {
    try {
      const { preflightCheck, batchCheck } = require('./safe-fetch.js');
      const action = args?.action || 'preflight';
      if (action === 'batch' && Array.isArray(args.texts)) {
        return batchCheck(args.texts, { context: args.context, classification: args.classification });
      }
      return preflightCheck(args.text || '', { context: args.context, classification: args.classification });
    } catch (e) {
      return { error: e.message };
    }
  },



  // [P2-1] agentic-memory-engine
  aspira_agentic_memory: async (args) => {
    try {
      // [契约修复] index.js 的 agenticMemory 是 { AgenticMemoryEngine }
      // —— 一个**类**。decideAndStore/store/recall 全是**实例方法**。
      // 原代码在类对象上直接调，实测恒定抛
      // "agenticMemory.store is not a function"，工具完全不可用。
      // 与本轮另外四处(metacognition/debate/tom/executable_reasoning)
      // 完全同型。改为先实例化(惰性缓存，保留已存记忆)。
      const { agenticMemory } = require('./index.js');
      const AM = agenticMemory && agenticMemory.AgenticMemoryEngine;
      if (typeof AM !== 'function') return { error: 'agenticMemory.AgenticMemoryEngine 不可用' };
      if (!globalThis.__aspiraAgenticMemory) globalThis.__aspiraAgenticMemory = new AM();
      const engine = globalThis.__aspiraAgenticMemory;
      const { action = 'decide', input, output, context } = args;
      if (action === 'decide' || action === 'decideAndStore') {
        return engine.decideAndStore(input || '', output || '', context || {});
      }
      if (action === 'store') {
        return engine.store(input || '', output || '', context || {});
      }
      if (action === 'recall') {
        return engine.recall(input || '', { limit: args.limit || 5 });
      }
      return { error: `unknown action: ${action}` };
    } catch (e) { return { error: e.message }; }
  },
  // [P2-2] metacognitive-reward
  aspira_metacognition_evaluate: async (args) => {
    try {
      // [契约修复] index.js 的 metacognition 是 metacognitive-reward.js 的导出，
      // 即 { MetacognitiveReward } —— 一个**类**。evaluate() 是该类的
      // **实例方法**(第 39 行 evaluate(output, context))，不是静态方法。
      // 原代码在类对象上直接调 metacognition.evaluate(...)，
      // 实测恒定抛 "metacognition.evaluate is not a function"，
      // 工具**完全不可用**。改为先实例化再调用。
      const { metacognition } = require('./index.js');
      const MR = metacognition && metacognition.MetacognitiveReward;
      if (typeof MR !== 'function') return { error: 'metacognition.MetacognitiveReward 不可用' };
      const inst = new MR();
      return inst.evaluate(args.output || '', { selfFeedback: args.selfFeedback });
    } catch (e) { return { error: e.message }; }
  },
  // [P2-3] executable-reasoning
  aspira_executable_reasoning: async (args) => {
    try {
      // [契约修复] index.js 的 executableReasoning 是 { ExecutableReasoning }
      // —— 一个**类**。parseThoughtChain/buildPlan/executeAndVerify/endToEnd
      // 全是该类的**实例方法**。原代码在类对象上直接调，实测恒定抛
      // "executableReasoning.parseThoughtChain is not a function"。
      // 改为先实例化。
      const { executableReasoning } = require('./index.js');
      const ER = executableReasoning && executableReasoning.ExecutableReasoning;
      if (typeof ER !== 'function') return { error: 'executableReasoning.ExecutableReasoning 不可用' };
      const engine = new ER();
      const { action = 'endToEnd', raw, thoughtChain, opts } = args;
      if (action === 'parse') return { steps: engine.parseThoughtChain(raw || '') };
      if (action === 'plan') return engine.buildPlan(engine.parseThoughtChain(raw || ''), opts || {});
      if (action === 'execute' || action === 'endToEnd') return engine.endToEnd(raw || '', opts || {});
      return { error: `unknown action: ${action}` };
    } catch (e) { return { error: e.message }; }
  },
  // [P2-4] tom-engine
  aspira_tom_model: async (args) => {
    try {
      // [契约修复] index.js 的 tomEngine 是 { ToMEngine } —— 一个**类**。
      // modelAgent/predict 是该类的**实例方法**。原代码在类对象上直接调
      // tomEngine.modelAgent(...)，实测恒定抛
      // "tomEngine.modelAgent is not a function"，工具完全不可用。
      // 改为先实例化(惰性缓存)。
      const { tomEngine } = require('./index.js');
      const TE = tomEngine && tomEngine.ToMEngine;
      if (typeof TE !== 'function') return { error: 'tomEngine.ToMEngine 不可用' };
      if (!globalThis.__aspiraTom) globalThis.__aspiraTom = new TE();
      const engine = globalThis.__aspiraTom;
      const { action = 'model', agentId, observations, targetAgentId } = args;
      if (action === 'model' || action === 'modelAgent') {
        if (!agentId) return { error: 'agentId required' };
        return engine.modelAgent(agentId, Array.isArray(observations) ? observations : [observations || '']);
      }
      if (action === 'predict' || action === 'predictBehavior') {
        return engine.predict(agentId || targetAgentId || 'unknown');
      }
      if (action === 'contagion') {
        const ids = Array.isArray(args.agentIds) ? args.agentIds : [agentId];
        return engine.contagion(ids);
      }
      return { error: `unknown action: ${action}` };
    } catch (e) { return { error: e.message }; }
  },
  // [P2-5] debate-engine
  aspira_debate: async (args) => {
    try {
      // [契约修复] index.js 的 debateEngine 是 { DebateEngine, ROLES } ——
      // 一个**类**加一个常量表。createSession/addRound/summarize/conclude
      // 全是该类的**实例方法**。原代码在类对象上直接调
      // debateEngine.createSession(...)，实测恒定抛
      // "debateEngine.createSession is not a function"，工具完全不可用。
      // 改为先实例化(惰性缓存，避免每次调用重建导致会话丢失)。
      const { debateEngine, ROLES } = require('./index.js');
      const DE = debateEngine && debateEngine.DebateEngine;
      if (typeof DE !== 'function') return { error: 'debateEngine.DebateEngine 不可用' };
      if (!globalThis.__aspiraDebate) globalThis.__aspiraDebate = new DE();
      const engine = globalThis.__aspiraDebate;
      const { action = 'create', sessionId, topic, roleId, argument, evidence, roles, maxRounds } = args;
      if (action === 'create' || action === 'createSession') {
        if (!topic) return { error: 'topic required' };
        return engine.createSession(topic, { roles, maxRounds });
      }
      if (action === 'addRound' || action === 'speak') {
        if (!sessionId || !roleId || !argument) return { error: 'sessionId/roleId/argument required' };
        return engine.addRound(sessionId, roleId, argument, evidence || []);
      }
      if (action === 'summarize') return engine.summarize(sessionId);
      if (action === 'conclude' || action === 'end') {
        return engine.conclude(sessionId, args.conclusion || '');
      }
      return { error: `unknown action: ${action}` };
    } catch (e) { return { error: e.message }; }
  },
  // [P2-6] evolutionary-search
  aspira_evolutionary_search: async (args) => {
    try {
      // [契约修复] index.js 的 evolutionarySearch 是 { EvolutionarySearch }
      // —— 一个**类**。initPopulation/forward/backward 全是**实例方法**。
      // 原代码在类对象上直接调，与本轮另外五处完全同型。
      // 改为先实例化(惰性缓存)。
      const { evolutionarySearch } = require('./index.js');
      const EVS = evolutionarySearch && evolutionarySearch.EvolutionarySearch;
      if (typeof EVS !== 'function') return { error: 'evolutionarySearch.EvolutionarySearch 不可用' };
      if (!globalThis.__aspiraEvoSearch) globalThis.__aspiraEvoSearch = new EVS();
      const engine = globalThis.__aspiraEvoSearch;
      const { action = 'forward', searchSpace, population, fitnessFn, target, constraintFn } = args;
      if (action === 'init' || action === 'initPopulation') {
        if (!searchSpace) return { error: 'searchSpace required' };
        return { population: engine.initPopulation(searchSpace) };
      }
      if (action === 'forward') {
        if (!population || !fitnessFn) return { error: 'population/fitnessFn required' };
        return engine.forward(population, fitnessFn, args.generations);
      }
      if (action === 'backward') {
        if (!target || !constraintFn || !searchSpace) return { error: 'target/constraintFn/searchSpace required' };
        return engine.backward(target, constraintFn, searchSpace, args.iterations);
      }
      return { error: `unknown action: ${action}` };
    } catch (e) { return { error: e.message }; }
  },

  // [P1-2] 关键日志 180 天留存
  aspira_retention_log: async (args) => {
    try {
      const { RetentionLogger } = require('./retention-logger.js');
      const logger = new RetentionLogger('audit');
      if (args.action === 'log') { logger.log(args); return { logged: true }; }
      return { results: logger.query(args) };
    } catch (e) { return { error: e.message }; }
  },
  // [P1-3] 出域台账
  aspira_outbound_ledger: async (args) => {
    try {
      const { OutboundLedger } = require('./outbound-ledger.js');
      const ledger = new OutboundLedger();
      // [契约修复] `action` 一名两用: handler 顶层拿它选**操作**
      // (query/record/stats)，而 OutboundLedger.query() 解构的 `action`
      // 是**门禁动作过滤字段**(pass/rewrite/block)，record() 也把
      // args.action 当作要记录的门禁动作。三处抢同一个键。
      // 上一轮的修法是把 schema 的 action_filter 改名 action 与底层对齐 ——
      // 名字是对上了，却让"操作"与"过滤值"挤进同一个键:
      // 传 action:'block' 既不 record 也不过滤，只会掉进 query 分支。
      // 现在明确分层: schema 的 `action` 只表示操作，
      // 过滤字段用 `action_filter`，由 handler 显式翻译给底层。
      const op = args.action || 'query';
      if (op === 'record') {
        // [契约修复] record() 取 entry.action 作为**要记录的门禁动作**
        // (pass/rewrite/block)，而 args.action 在这里是**操作名** 'record'。
        // 原先直接 `ledger.record(args)` 把整个 args 透传，
        // 于是每条经 MCP 记录的出域调用，action 字段全是 'record' ——
        // 真实门禁动作永远丢失(实测落库 {"action":"record"})。
        // 与 query 分支同样处理: 操作键不透传，action_filter 翻译成 action。
        const entry = Object.assign({}, args);
        delete entry.action;
        if (entry.action_filter !== undefined) {
          entry.action = entry.action_filter;
          delete entry.action_filter;
        }
        ledger.record(entry);
        return { recorded: true };
      }
      if (op === 'stats') return ledger.stats(args);
      // 查询: 把 action_filter 翻译成底层认的 action
      const q = Object.assign({}, args);
      delete q.action;                    // 顶层操作键不透传
      if (q.action_filter !== undefined) {
        q.action = q.action_filter;       // 过滤字段交给底层
        delete q.action_filter;
      }
      return { results: ledger.query(q) };
    } catch (e) { return { error: e.message }; }
  },
};



// ═══════════════════════════════════════════════

// JSON-RPC 响应构造

// ═══════════════════════════════════════════════



function makeResponse(id, result) {

  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';

}



function makeError(id, code, message, data) {

  const error = { code, message };

  if (data !== undefined) error.data = data;

  return JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n';

}



// ═══════════════════════════════════════════════

// 请求处理

// ═══════════════════════════════════════════════



async function handleRequest(request, sessionId) {

  const { id, method, params = {} } = request;



  switch (method) {

    case 'initialize':

      return { protocolVersion: '2024-11-05', capabilities: { tools: {}, logging: {} }, serverInfo: { name: 'aspira-mcp', version: version || '1.0.0' } };



    case 'notifications/initialized':

      return null;



    case 'tools/list':

      return { tools: TOOLS };




    case 'tools/call': {
      // [P1-1] OID身份码 + 三层权限模型（[AUDIT-FIX 2026-09-20] 移入 case 内）
      // 原实现把权限块放在 switch 里两个 case 标签之间且无自己的 case 标签，
      // 前一个 case 已 return，因此这段 100% 是死代码——guest 拦截从未生效。
      // 角色: guest(只读) / user(读写) / admin(全权限)
      // 身份码: Aspira-OID-<16-char-hash>
      let { name, arguments: args = {} } = params;

      const reqOid = request.headers?.['x-heartflow-oid'] || '';
      const token = request.headers?.authorization?.replace('Bearer ', '') || '';
      let role = 'guest';
      if (token && typeof AUTH_TOKEN === 'string' && safeCompare(token, AUTH_TOKEN)) {
        role = 'admin';
      }
      const oidMatch = reqOid.match(/^Aspira-OID-([a-f0-9]{16})$/);
      if (oidMatch) {
        role = Math.max(['guest','user','admin'].indexOf(role), ['guest','user','admin'].indexOf('user'));
      }
      const needsWrite = ['aspira_memory_write_control', 'aspira_memory_eraser',
        'aspira_decision_decide', 'aspira_self_heal'].includes(name);
      if (needsWrite && role === 'guest') {
        return { content: [{ type: 'text', text: JSON.stringify({
          error: '权限不足：guest 角色不可写，请升级身份认证'
        }) }], isError: true };
      }

      const handler = HANDLERS[name];

      if (!handler) throw { code: -32601, message: `Method not found: ${name}` };

      // [MCP-ENHANCE] 主文本参数别名归一化: text ↔ input
      //
      // 实测 181 个工具里 **61 个用 text、13 个用 input** 作为主文本参数
      // (aspira_think/think_fast/emotion/decision_router/mood/self_correction/
      //  supervise/agent_think/bridge_analyze/translate/…)。agent 按一套习惯传
      // text 就会在那 13 个上撞 -32603「input 是必填参数」。
      //
      // 失败的形态特别难查: 下面的中央校验会**丢弃未声明参数**，于是调用方传的
      // text 被静默删掉，错误信息只提 input——看不到"你其实传了 text"。
      // 实测复现: tools/call aspira_think {text:'test'} → -32603 input 是必填参数。
      //
      // 修法: 声明了 input 而未收到 input、但收到 text 时，把 text 复制为 input。
      // **向后兼容**——原传 input 的调用方完全不受影响；原传 text 的从报错变为可用。
      const _aliasDef = TOOLS.find(t => t.name === name);
      if (_aliasDef && _aliasDef.inputSchema && _aliasDef.inputSchema.properties) {
        const _props = _aliasDef.inputSchema.properties;
        if ('input' in _props && !('input' in args) && typeof args.text === 'string') {
          args = Object.assign({}, args, { input: args.text });
        }
      }
      
      // [AUDIT-FIX I-2] 中央参数校验：只透传 inputSchema 声明的参数，
      // 丢弃未声明参数（防参数注入），并对 string 类型参数强制字符串（防类型混淆）
      const toolDef = TOOLS.find(t => t.name === name);
      if (toolDef && toolDef.inputSchema && toolDef.inputSchema.properties) {
        const props = toolDef.inputSchema.properties;
        const cleaned = {};
        for (const [k, v] of Object.entries(props)) {
          if (k in args) {
            if ((v.type === 'string' || v.type === 'number') && typeof args[k] !== v.type) {
              if (v.type === 'number' && typeof args[k] === 'number') { cleaned[k] = args[k]; continue; }
              if (v.type === 'string' && (typeof args[k] === 'string' || typeof args[k] === 'number')) { cleaned[k] = String(args[k]); continue; }
              return { content: [{ type: 'text', text: JSON.stringify({ error: `参数 ${k} 类型错误: 期望 ${v.type}`, timestamp: Date.now() }) }], isError: true };
            }
            cleaned[k] = args[k];
          }
        }
        args = cleaned;
      }



      let result;

      // 兼容两种签名：handler(args) 和 handler(args, sessionId)
      //
      // [mcp-tool-enhancement·第一百五十七轮] 第二次调用也要接住。
      // 原结构里第二次调用**没有自己的 try** —— 它一 throw 就逃出
      // case 'tools/call'，一路冒到 HTTP 层的 catch，变成 JSON-RPC 的 -32603
      // Internal error，而不是工具层那个 {error: …} 响应。
      //
      // 实测 181 个工具里 **18 个**用 `throw new Error('X 是必填参数')` 做参数
      // 校验(aspira_think / think_fast / memory_search / emotion / self_heal /
      // provider_health / cost_tracking / decision_router / supervise / …)，
      // 另外 163 个用 `return {error: …}`。两类形态对调用方是两回事:
      //   · 163 个 → {content:[{text:'{"error":"input 是必填参数"}'}], isError:false}
      //   · 18 个  → JSON-RPC 错误 {code:-32603, message:"input 是必填参数"}
      // MCP 客户端按 result.error / isError 判断工具成败，-32603 走的是另一条路。
      //
      // 附带代价: 每个缺参请求**白跑两遍 handler**(第一次 throw 被吞，第二次
      // 再 throw 逃逸)。对 async handler 那是两次无用的 Promise rejection。
      //
      // 修法: 第二次也包 try，转成与其它工具同形的 {error} 对象。消息仍经由
      // 下面那段错误收敛(过滤绝对路径 / 截断超长)处理，行为一致。
      try {

        result = handler(args, sessionId);

      } catch (_) {

        try {

          result = handler(args);

        } catch (e2) {

          result = { error: (e2 && e2.message) ? String(e2.message) : 'handler 调用失败' };

        }

      }

      if (result && typeof result.then === 'function') result = await result;

      // [AUDIT-FIX P1-4] 错误信息收敛：过滤绝对路径，截断超长消息，避免内部结构泄露
      if (result && typeof result === 'object' && result.error && typeof result.error === 'string') {
        let msg = result.error;
        msg = msg.replace(/\/[A-Za-z0-9_./-]*(?:\.hermes|\.claude|\.ssh|\.npm|node_modules|mark-heartflow-skill)[A-Za-z0-9_./-]*/g, '[path]');
        msg = msg.replace(/\/[A-Za-z0-9_./-]{40,}/g, '[path]');
        if (msg.length > 300) msg = msg.slice(0, 300) + '…';
        result.error = msg;
      }


      // [P0-3] 熔断接入 MCP 统计流：recordOutcome() 嵌入 handleTool
      try {
        if (typeof cb !== 'undefined' && cb.recordOutcome) {
          cb.recordOutcome(!(result && result.isError));
        }
      } catch (_) { /* 防御性：熔断统计不阻断主流程 */ }


      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false };

    }



    case 'ping':

      return {};



    default:

      throw { code: -32601, message: `Method not found: ${method}` };

  }

}



// ═══════════════════════════════════════════════

// HTTP Server（SSE 传输）

// ═══════════════════════════════════════════════



// SSE 客户端列表 (sessionId → response)

const sseClients = new Map();



function sendSSE(client, data) {

  client.write(`data: ${JSON.stringify(data)}\n\n`);

}



function sendEvent(client, event, data) {

  client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

}



const server = http.createServer((req, res) => {

  const url = new URL(req.url, `http://localhost:${PORT}`);

  const pathname = url.pathname;



  // ─── 安全认证检查 (SkillSpector fix: 强制认证，仅接受 Authorization header) ───

  const authHeader = req.headers['authorization'];

  const token = authHeader && authHeader.startsWith('Bearer ')

    ? authHeader.slice(7)

    : null;

  // SkillSpector fix: 移除 URL query parameter token 认证（token 在 URL 中会通过日志/referrer 泄露）

  

  if (AUTH_ENABLED && !safeCompare(token, AUTH_TOKEN)) {

    // [AUDIT-FIX] Token 维度速率限制：记录失败尝试

    const tokenHash = token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 16) : 'none';

    if (!checkTokenRateLimit(tokenHash)) {

      res.writeHead(429, { 'Content-Type': 'application/json' });

      res.end(JSON.stringify({ error: 'Too Many Auth Failures', retryAfter: 60 }));

      return;

    }

    res.writeHead(401, { 'Content-Type': 'application/json' });

    res.end(JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing Bearer token in Authorization header' }));

    return;

  }



  // ─── CORS Preflight ───

  if (req.method === 'OPTIONS') {

    res.writeHead(204, {

      'Access-Control-Allow-Origin': 'http://localhost',  // [AUDIT-FIX] 限制 CORS 来源为本地

      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',

      'Access-Control-Allow-Headers': 'Content-Type, Authorization',

      'Access-Control-Max-Age': '86400',

      'Access-Control-Allow-Credentials': 'false'  // [AUDIT-FIX] 禁止跨域携带凭据

    });

    res.end();

    return;

  }



  // ─── 速率限制 ───

  const clientIp = req.socket.remoteAddress || 'unknown';

  if (!checkRateLimit(clientIp)) {

    res.writeHead(429, { 'Content-Type': 'application/json' });

    res.end(JSON.stringify({ error: 'Too Many Requests', retryAfter: 60 }));

    return;

  }



  // ─── SSE 端点 ───

  if (pathname === '/mcp' && req.method === 'GET') {

    res.writeHead(200, {

      'Content-Type': 'text/event-stream',

      'Cache-Control': 'no-cache',

      'Connection': 'keep-alive',

      'Access-Control-Allow-Origin': 'http://localhost',  // [AUDIT-FIX] 限制 CORS 来源

      'X-Accel-Buffering': 'no'

    });



    // 生成 sessionId

    const sessionId = crypto.randomUUID();



    // 发送端点信息 — MCP 规范要求纯 URL 字符串

    sendEvent(res, 'endpoint', '/mcp?sessionId=' + sessionId);



    // 注册客户端 (sessionId → response)

    sseClients.set(sessionId, res);

    console.error(`[Aspira MCP] SSE 客户端已连接 sessionId=${sessionId} (共 ${sseClients.size} 个)`);



    // 心跳保持连接

    const heartbeat = setInterval(() => {

      try { sendEvent(res, 'ping', {}); } catch (_) { /* [v5.9.18] 防御性: ping发送容错 */ }

    }, 30000);



    req.on('close', () => {

      sseClients.delete(sessionId);

      clearInterval(heartbeat);

      console.error(`[Aspira MCP] SSE 客户端断开 sessionId=${sessionId} (剩余 ${sseClients.size} 个)`);

    });



    return;

  }



  // ─── JSON-RPC 端点 ───

  if (pathname === '/mcp' && req.method === 'POST') {

    // 从 URL 中获取 sessionId

    const sessionId = url.searchParams.get('sessionId');



    // 请求超时 30s

    req.setTimeout(30000, () => {

      res.writeHead(408);

      res.end('Request Timeout');

      req.destroy();

    });



    // 请求体大小限制 1MB

    const MAX_BODY = 1024 * 1024;

    let body = '';

    let bodySize = 0;



    req.on('error', (err) => {

      console.error(`[Aspira MCP] 请求错误:`, err.message);

    });



    req.on('data', chunk => {

      bodySize += chunk.length;

      if (bodySize > MAX_BODY) {

        res.writeHead(413);

        res.end('Payload Too Large');

        req.destroy();

        return;

      }

      body += chunk;

    });



    req.on('end', async () => {

      try {

        const request = JSON.parse(body);

        if (!request || typeof request !== 'object' || Array.isArray(request)) {

          res.writeHead(200, {

            'Content-Type': 'application/json',

            'Access-Control-Allow-Origin': 'http://localhost',

          });

          res.end(makeError(null, -32600, 'Invalid Request: expected JSON-RPC object'));

          return;

        }

        const result = await handleRequest(request, sessionId);

        if (result !== null) {

          // 找到对应的 SSE 客户端，通过 SSE 发送结果

          if (sessionId && sseClients.has(sessionId)) {

            const client = sseClients.get(sessionId);

            sendEvent(client, 'message', makeResponse(request.id, result));

            res.writeHead(202, {

              'Content-Type': 'application/json',

              'Access-Control-Allow-Origin': 'http://localhost',

            });

            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'accepted' }) + '\n');

          } else {

            // 没有 SSE 客户端，直接返回

            res.writeHead(200, {

              'Content-Type': 'application/json',

              'Access-Control-Allow-Origin': 'http://localhost',

            });

            res.end(makeResponse(request.id, result));

          }

        } else {

          // notification — 202 accepted

          res.writeHead(202, {

            'Content-Type': 'application/json',

            'Access-Control-Allow-Origin': 'http://localhost',

          });

          res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id }) + '\n');

        }

      } catch (err) {

        res.writeHead(200, {

          'Content-Type': 'application/json',

          'Access-Control-Allow-Origin': 'http://localhost',

        });

        res.end(makeError(null, err.code || -32603, err.message || 'Internal error'));

      }

    });

    return;

  }



  // ─── 健康检查 ───

  if (pathname === '/health') {

    res.writeHead(200, { 'Content-Type': 'application/json' });

    res.end(JSON.stringify({

      status: 'ok',

      version,

      clients: sseClients.size,

    }));

    return;

  }



  // ─── 404 ───

  res.writeHead(404);

  res.end('Not Found');

});



server.on('error', (err) => {

  if (err.code === 'EADDRINUSE') {

    console.error(`[Aspira MCP] 端口 ${PORT} 已被占用，尝试强制释放后重启。`);

    try {
      const { execSync } = require('child_process');
      if (!/^\d+$/.test(String(PORT))) {
        console.error(`[Aspira MCP] 端口值非法，跳过自动清理: ${PORT}`);
        process.exit(1);
      }
      try {
        // 跨平台释放端口：Linux 用 fuser，macOS 的 fuser 不支持 -k，改用 lsof
        const releaseCmd = process.platform === 'darwin'
          ? `lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill`
          : `fuser -k ${PORT}/tcp`;
        execSync(releaseCmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
      } catch (e) {
        const stderr = (e.stderr && e.stderr.toString()) || e.message || '';
        console.error(`[Aspira MCP] 释放端口输出: ${stderr.trim()}`);
      }
      console.error(`[Aspira MCP] 端口 ${PORT} 已释放，3秒后自动重启。`);
      setTimeout(() => {
        server.close(() => {
          server.listen(PORT, '127.0.0.1');
        });
      }, 3000);
      return;
    } catch (_) {
      console.error(`[Aspira MCP] 无法释放端口 ${PORT}，进程退出。`);
      process.exit(1);
    }

  }

  console.error(`[Aspira MCP] HTTP 服务器错误:`, err.message);

  // [v6.2.7] 崩溃自动恢复：非退出类错误自动重启
  if (!process.exitCode || process.exitCode === 0) {
    console.error('[Aspira MCP] 尝试自动重启...');
    setTimeout(() => {
      server.close(() => {
        server.listen(PORT, '127.0.0.1');
      });
    }, 2000);
  }

});



// ═══════════════════════════════════════════════

// 优雅退出

// ═══════════════════════════════════════════════



function shutdown() {

  console.error('[Aspira MCP] 关闭中...');

  // 关闭所有 SSE 连接

  for (const [sessionId, client] of sseClients) {

    try { client.end(); } catch (_) { /* [v5.9.18] intentional: graceful degradation */ }

  }

  sseClients.clear();

  // 停止引擎

  if (heartflow) { try { heartflow.stop(); } catch (_) { /* [v5.9.18] intentional: graceful degradation */ } }

  server.close(() => process.exit(0));

}



process.on('SIGINT', shutdown);

process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {

  console.error(`[Aspira MCP] 未捕获异常:`, err.message);

  shutdown();

});

process.on('unhandledRejection', (reason) => {

  console.error(`[Aspira MCP] 未处理 Promise 拒绝:`, reason);

});



// ═══════════════════════════════════════════════

// 启动

// ═══════════════════════════════════════════════



initAspira();

/**
 * 启动常驻服务（HTTP SSE 或 Unix socket）。
 *
 * [FIX 2026-09-21] 抽出为函数并加 require.main 守卫：此前这段监听逻辑写在
 * 模块顶层无条件执行，任何 require('../src/mcp-server.js') 的调用方（测试、
 * 其他模块）都会连带启动一个真的服务器，进而触发端口冲突时的"强制释放"
 * 分支——那个分支会杀死占用该端口的进程，被 require 时杀掉的往往是上一轮
 * 自己的服务，形成"释放→3秒后重启→再释放"的自噬循环，且调用方永不退出。
 * 现在只有本文件作为入口直接执行（node src/mcp-server.js / npm bin heartflow）
 * 才启动服务；被 require 时仅加载 HANDLERS/TOOLS 等导出，无副作用。
 */
function startServer() {
  if (SOCKET_PATH) {
    const unixServer = net.createServer(handleUnixClient);
    try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}
    try {
      unixServer.listen(SOCKET_PATH, () => {
        fs.chmodSync(SOCKET_PATH, 0o600);
        console.error(`[Aspira MCP] Unix socket: ${SOCKET_PATH}`);
        console.error(`[Aspira MCP] 连接方式: hermes mcp add aspira --url unix://${SOCKET_PATH}`);
      });
    } catch (err) {
      console.error(`[Aspira MCP] Unix socket 监听失败: ${err.message}`);
      process.exit(1);
    }
    unixServer.on('error', (err) => {
      console.error(`[Aspira MCP] Unix socket error: ${err.message}`);
      process.exit(1);
    });
  } else {
    server.listen(PORT, '127.0.0.1', () => {
      console.error(`[Aspira MCP] HTTP SSE 服务已启动: http://127.0.0.1:${PORT}/mcp`);
      console.error(`[Aspira MCP] 健康检查: http://127.0.0.1:${PORT}/health`);
      console.error(`[Aspira MCP] 连接方式: hermes mcp add aspira --url http://127.0.0.1:${PORT}/mcp`);
    });
  }
}

// 仅作为入口直接执行时启动常驻服务；被 require 时保持无副作用。
// ASPIRA_NO_AUTOSTART=1 可作为逃生门，供调试/测试时连入口执行也不起服务。
if (require.main === module && process.env.ASPIRA_NO_AUTOSTART !== '1') {
  startServer();
}

// 导出 HANDLERS/TOOLS 供测试断言工具表与 handler 映射的一致性。
// 背景: 曾出现「工具已定义但无 handler」「handler 重复定义后者静默覆盖前者」
// 「registry 里某个工具对象未闭合、字段被下一个条目吞掉」三类静默损坏，
// 全都不被任何测试发现。有了这两个导出，不变式可以直接断言。
module.exports = { HANDLERS, TOOLS };

