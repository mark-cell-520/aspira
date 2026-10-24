#!/usr/bin/env node
/**
 * engine-dispatcher — Aspira dispatch/route logic
 * Extracted from heartflow.js (v6.0.1)
 */

const path = require('path');
const debugLog = require('../utils/debug-log');
const { instantiateSpecialModule, SPECIAL_MODULES, METHOD_BLACKLIST } = require('./module-registry');

const _perf = {
  _enabled: false,
  enable() { this._enabled = true; },
  disable() { this._enabled = false; },
  reset() { /* noop */ },
  recordDispatch(route, ms) {
    if (!this._enabled) return;
    try { debugLog.info('dispatch', 'perf', { route, ms }); } catch (e) { /* non-fatal */ }
  },
  getStats() { return { enabled: this._enabled }; },
};

function _ARG_MAP() {
  return {
    knowledgeBase:     { storagePath: { path: ['rootPath', 'data', 'knowledge'] } },
    sessionMemory:     { storagePath: { path: ['rootPath', 'data', 'sessions'] } },
    projectContext:    { storagePath: { path: ['rootPath', 'data', 'projects'] } },
    longTermMemory:    { storagePath: { path: ['rootPath', 'data', 'longterm'] } },
    crossSessionIndex: { storagePath: { path: ['rootPath', 'data', 'cross-session'] } },
    codeExecutor:      { hf: 'hf' },
    codePlanner:       { hf: 'hf' },
  };
}

/**
 * dispatch(route, ...args) — unified router
 */
function dispatch(hf, route, ...args) {
  if (!hf.started) throw new Error('Aspira not started');

  const _perfStart = _perf._enabled ? performance.now() : 0;

  const AspiraClass = hf.constructor;
  if (!AspiraClass.ALLOWED_ROUTES.has(route)) {
    throw new Error(`dispatch: route '${route}' not allowed. Use routes() to see available routes.`);
  }
  const dot = route.indexOf('.');
  if (dot === -1) throw new Error(`Invalid route: ${route} (missing '.')`);
  const subsystem = route.slice(0, dot);
  const method = route.slice(dot + 1);

  if (subsystem === 'monitor') {
    const stats = _perf.getStats();
    switch (method) {
      case 'getStats': return stats;
      case 'enable': _perf.enable(); return { ok: true };
      case 'disable': _perf.disable(); return { ok: true };
      case 'reset': _perf.reset(); return { ok: true };
      default: throw new Error(`Unknown monitor method: ${method}`);
    }
  }

  let mod = hf._modules[subsystem];
  if (!mod && hf._lazy && hf._lazy[subsystem]) {
    const entry = hf._lazy[subsystem];
    try {
      const Mod = require(entry.path);
      mod = instantiateSpecialModule(subsystem, Mod, hf);
      if (mod) {
        hf[subsystem] = mod;
        hf._modules[subsystem] = mod;
      }
      if (!mod) {
        const Ctor = Mod[entry.Ctor];
        if (Ctor) {
          const argSpec = _ARG_MAP()[subsystem];
          if (argSpec) {
            const instArgs = {};
            for (const [key, val] of Object.entries(argSpec)) {
              if (typeof val === 'string') instArgs[key] = hf[val];
              else if (val && val.path) instArgs[key] = path.join(hf.rootPath, ...val.path.slice(1));
            }
            mod = new Ctor(instArgs);
          } else {
            mod = new Ctor(entry.args);
          }
          hf[subsystem] = mod;
          hf._modules[subsystem] = mod;
        }
      }
    } catch (e) {
      throw new Error(`Lazy load failed for '${subsystem}': ${e.message}`);
    }
  }

  if (!mod) {
    const available = Object.keys(hf._modules).sort().join(', ');
    throw new Error(`Unknown subsystem: ${subsystem}. Available: ${available}`);
  }
  if (typeof mod[method] !== 'function') {
    throw new Error(`${subsystem}.${method} is not a function on ${subsystem}`);
  }
  // [N1 自愈闸门] honor 健康检查设置的禁用标记：模块被 ModuleHealthChecker 标记 __disabled 后
  // dispatch 必须拒绝路由，否则"禁用"只是记账、从不生效 = 假自愈。fail-closed。
  // 例外：允许诊断/恢复类方法穿透（healthCheck/getStats/init/reset），以便观测和重新启用。
  if (mod.__disabled === true && !['healthCheck', 'getStats', 'stats', 'init', 'reset'].includes(method)) {
    return { _disabled: true, route, reason: `模块 ${subsystem} 已被健康检查禁用（自愈闸门拦截），仅诊断/恢复方法可调用` };
  }
  const rawResult = mod[method](...args);

  if (_perfStart > 0) {
    _perf.recordDispatch(route, performance.now() - _perfStart);
  }

  const NO_ROUTE = new Set(['cognitiveIndex.estimate', 'cognitiveIndex.healthCheck', 'formula.search', 'formula.getStatus']);
  if (!NO_ROUTE.has(route) && hf._decisionRouter && rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)) {
    if (rawResult.matched === true || rawResult.matched === false) {
      return rawResult;
    }
    const routed = hf._decisionRouter.wrapDispatchResult(route, rawResult);
    if (routed !== rawResult) return routed;
  }

  if (hf.sustainedDriftDetector && rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)) {
    try { require('./engine-behavior')._feedDriftResult(hf, route, rawResult); } catch (e) { /* non-fatal */ }
  }

  if (rawResult === undefined) {
    const hint = `${subsystem}.${method}() returned undefined — possible missing return or async not awaited`;
    debugLog.warn('heartflow', hint);
    return { _dispatchWarning: true, route, hint };
  }

  return rawResult;
}

/**
 * Generate allowed routes from modules registry
 *
 * [本轮修复] 本函数原先只枚举 `Object.getPrototypeOf(mod)` 一层原型上的
 * own property names，于是 35 个"方法直接挂在对象字面量上"的模块（原型是
 * Object.prototype）的 167 个公开方法一条都进不了白名单。实测：
 * dispatch('lesson.stats') / dispatch('graph.addNode') 等恒抛
 * `route 'lesson.stats' not allowed`，而 routes() 报表面有 Object.keys 兜底、
 * 照广告这些路由 —— 门比广告窄，167 条已广告的路由在门口被拒。
 *
 * 模块注册表 src/core/module-registry.js 里一直有一份更完善的实现
 * （METHOD_BLACKLIST 排除 EventEmitter 危险方法、`_` 前缀私有助手不计入、
 * Object.keys(mod) 兜底对象字面量），却没有任何调用方。本函数改为采用同一
 * 套口径，两套枚举合一。
 *
 * 不复用那份函数本身，只复用其 METHOD_BLACKLIST：它内部用 `_boundedPush`
 * 收集结果，上限 500 且是 `arr.shift()` 挤出——超过 500 条后最早注册的
 * 模块路由会被后面的模块挤掉（实测直接复用时 ALLOWED_ROUTES 从 1804 掉到
 * 519，`lesson.stats` 这类中段模块恰好在被挤掉的那半边）。这里自行收集，
 * 不限长。
 */
function generateAllowedRoutes(modules) {
  if (!modules || typeof modules !== 'object') return [];
  const routes = [];
  for (const [name, mod] of Object.entries(modules)) {
    if (!mod) continue;
    let methods = [];
    try {
      const proto = Object.getPrototypeOf(mod);
      if (proto && proto !== Object.prototype) {
        methods = Object.getOwnPropertyNames(proto).filter(m =>
          m !== 'constructor' && !METHOD_BLACKLIST.has(m) && typeof mod[m] === 'function' && !m.startsWith('_'));
      }
    } catch (e) { /* fall through */ }
    if (!methods.length) {
      methods = Object.keys(mod).filter(k =>
        !METHOD_BLACKLIST.has(k) && !k.startsWith('_') && typeof mod[k] === 'function');
    }
    for (const method of methods) routes.push(`${name}.${method}`);
  }
  return routes;
}

module.exports = {
  dispatch,
  _perf,
  generateAllowedRoutes,
};
