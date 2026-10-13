#!/usr/bin/env node
/**
 * Aspira Skill Router — truthfulness-first edition
 *
 * Only routes to skills that actually exist on disk.
 * Searches: repo skills/, global ~/.hermes/skills/heartflow/, global mark-heartflow-skill skills
 *
 * ─── 为什么这份文件被重写 ───────────────────────────────────────────────
 * 旧版 ROUTES 有 25 条，其中 19 条指向本仓库（以及两个全局根）都不存在的
 * 技能名：heartflow-self-upgrade、heartflow-audit-fix-workflow、
 * heartflow-truthfulness、heartflow-knowledge-base…… 而磁盘上真实存在的 33 个
 * 技能里，有 26 个从未出现在任何一条路由上 —— 包括 bug-fixing、security-audit、
 * log-analyzer、simplify 这些每次排障都会用到的。
 *
 * 后果不是"路由不到"，而是更坏的一种：pickRoute() 在候选全部不存在时返回
 * candidates[0]，main() 于是输出 matched:false 且 suggested 一个死名字。用户
 * 看到的是"新愿说没有这个技能"，而不是"路由表本身是坏的"。
 *
 * 同时 `__list__`（列出全部技能）这条最可靠的兜底意图，会被排在它前面的
 * 任何死路由抢先 —— `node skills/dispatch.js help upgrade` 返回
 * matched:false 而不是技能列表。
 *
 * 现在：ROUTES 只允许写磁盘上存在的技能；verifyRoutes() 把这条约束变成可执行
 * 的断言（test/skills-registry-integrity.test.js 调用它）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const SEARCH_ROOTS = [
  path.join(REPO_ROOT, 'skills'),
  path.join(os.homedir(), '.hermes', 'skills', 'heartflow'),
  path.join(os.homedir(), '.hermes', 'skills', 'ai', 'mark-heartflow-skill', 'skills'),
];

const LIST_ROUTE = '__list__';

function findSkill(skill) {
  for (const base of SEARCH_ROOTS) {
    if (fs.existsSync(path.join(base, skill, 'SKILL.md'))) return path.join(base, skill);
  }
  return null;
}

function exists(skill) {
  return !!findSkill(skill);
}

// Build registry lazily so missing skills don't break routing.
// 每条路由的 skill 字段必须是磁盘上真实存在的技能名 —— verifyRoutes() 强制这一点。
const ROUTES = [
  // ─── 升级 / 审计 ───
  { intents: ['升级','自我升级','upgrade','self-upgrade','进化'], skill: 'heartflow-audit-upgrade-push', desc: '大规模升级工作流：全量审计→分类→并发修复→验证→推送' },
  { intents: ['升级','自我升级','upgrade','进化'], skill: 'heartflow-bulk-upgrade', desc: '批量升级（多模块并行）' },
  { intents: ['升级','模块升级','upgrade'], skill: 'heartflow-module-upgrader', desc: '单模块升级模式库（63 种模式）' },
  { intents: ['审计','体检','audit'], skill: 'heartflow-audit-upgrade-push', desc: '大规模升级工作流：全量审计→分类→并发修复→验证→推送' },
  { intents: ['安全','漏洞','注入','security'], skill: 'security-audit', desc: '安全审计（密钥/路径越界/命令拼接）' },
  { intents: ['审计','安全','security'], skill: 'critical-code-reviewer', desc: '零容忍的对抗式代码审查' },

  // ─── 调试 / 修 bug ───
  { intents: ['调试','排错','崩溃','启动失败','报错','debug','error'], skill: 'heartflow-debug-workflow', desc: '新愿崩溃诊断与修复（含 44 篇实战记录）' },
  { intents: ['调试','排错','debug'], skill: 'superpowers-systematic-debugging', desc: '系统化调试（四阶段，根因未明不许修）' },
  { intents: ['调试','排错','debug'], skill: 'debug-pro', desc: '调试方法论：7 步协议 + 分语言调试命令' },
  { intents: ['bug','缺陷','修复','fix','不工作','坏了','出错'], skill: 'bug-fixing', desc: '零回归 bug 修复工作流（8 阶段 + 12 条铁律）' },
  { intents: ['错误','异常','编译错误','崩溃','error'], skill: 'code-fix', desc: '代码错误诊断与修复' },

  // ─── 架构 / 重构 / 审查 ───
  { intents: ['架构','追溯','数据流','architecture','根因定位'], skill: 'heartflow-architecture-tracing', desc: '架构追溯：think() → pipeline → judgment → decision 全链路' },
  { intents: ['架构','设计','architecture'], skill: 'system-architect', desc: '系统架构设计与规范' },
  { intents: ['重构','refactor','重写'], skill: 'code-refactoring', desc: '安全重构' },
  { intents: ['重构','整洁','clean','命名','solid'], skill: 'clean-code-review', desc: '整洁代码规范与反模式' },
  { intents: ['审查','review','pr','pull request','代码审查'], skill: 'pr-reviewer', desc: 'PR 审查（结构化中文报告）' },
  { intents: ['审查','review','代码审查'], skill: 'cody', desc: '代码 Review 助手（diff/PR，多严格度）' },
  { intents: ['审查','review','严格'], skill: 'critical-code-reviewer', desc: '零容忍的对抗式代码审查' },
  { intents: ['分析','静态分析','复杂度','重复','analyze'], skill: 'code-analyzer', desc: '代码静态分析与 DDD 结构分析' },
  { intents: ['规范','standard','整洁','clean'], skill: 'project-code-standard', desc: '项目代码规范（Python/JS/通用）' },
  { intents: ['规范','架构原则','solid','整洁架构'], skill: 'uncle-bob', desc: '整洁架构与 SOLID' },
  { intents: ['简化','simplify','过度设计','冗余'], skill: 'simplify', desc: '简化：复用/去复杂/降层级' },

  // ─── 日志 / 错误解释 ───
  { intents: ['日志','log','堆栈','stack'], skill: 'log-analyzer', desc: '日志解析与错误模式关联' },
  { intents: ['错误解释','什么意思','报错含义','explain'], skill: 'nexus-error-explain', desc: '把报错翻译成人话' },

  // ─── 引擎域 ───
  { intents: ['情绪','心理','愤怒','焦虑','共情','创伤','emotion'], skill: 'heartflow-emotion-analysis', desc: '情绪与心理分析' },
  { intents: ['梦境','做梦','潜意识','dream'], skill: 'heartflow-dreaming', desc: '梦境引擎' },
  { intents: ['记忆','遗忘','思维空间','mindspace','memory'], skill: 'mind-space', desc: '思维空间（ROM/RAM/WorkingTable）' },
  { intents: ['评测','基准','性能测试','跑分','benchmark'], skill: 'heartflow-benchmark', desc: '能力基准测试' },
  { intents: ['桥接','飞书','微信','lark','bridge','feishu'], skill: 'heartflow-bridge-layer', desc: '飞书/微信桥接层' },
  { intents: ['会话','上下文','session','context'], skill: 'heartflow-session-context', desc: '会话上下文' },
  { intents: ['系统提示','提示吸收','prompt','system prompt'], skill: 'heartflow-system-prompt-absorption', desc: '外部系统提示吸收' },
  { intents: ['注入','批量注入','静态注入','injection'], skill: 'heartflow-static-injection-upgrade', desc: '静态注入批量升级' },
  { intents: ['预测','推演','十年','未来','forecast'], skill: 'human-future-forecast', desc: '人类未来长程推演' },
  { intents: ['两遍','草稿','two-pass','先草稿'], skill: 'two-pass-response', desc: '两遍响应（先草稿后成文）' },
  { intents: ['仓库','git','oracle','仓库分析'], skill: 'agent-git-oracle', desc: '仓库分析与重构指南' },

  // ─── 兜底：列出全部技能。必须能被单独命中 ───
  { intents: ['帮助','列表','全部技能','有什么','skills','help','list'], skill: LIST_ROUTE, desc: '列出全部技能' },
];

const DEFAULTS = [
  { skill: 'heartflow-architecture-tracing', desc: '默认起点：新愿结果从哪里来（架构追溯）' },
  { skill: 'heartflow-audit-upgrade-push', desc: '默认起点：审计与升级工作流' },
];

function matchIntents(input) {
  const q = input.toLowerCase().trim();
  return ROUTES.filter(r => r.intents.some(k => q.includes(k)));
}

/**
 * 选路。
 *
 * __list__ 优先于一切：它是唯一不依赖技能是否存在的兜底意图，若被死路由
 * 抢先，"列出全部技能"就不可达了（旧版 `help upgrade` 即此症）。
 * 其余按 ROUTES 顺序取第一个磁盘上真实存在的技能；一个都没有则返回 null，
 * 由 main() 诚实报 matched:false —— 而不是像旧版那样返回一个死名字。
 */
function pickRoute(input) {
  const candidates = matchIntents(input);
  const listRoute = candidates.find(r => r.skill === LIST_ROUTE);
  if (listRoute) return listRoute;
  for (const r of candidates) {
    if (exists(r.skill)) return r;
  }
  return null;
}

/**
 * 自检：ROUTES / DEFAULTS 里的每个技能名都必须能在某个 SEARCH_ROOT 下找到。
 * 供 test/skills-registry-integrity.test.js 调用 —— 路由表重新腐烂时这里先红。
 * @returns {{ok: boolean, dead: string[]}}
 */
function verifyRoutes() {
  const dead = [];
  for (const r of ROUTES) {
    if (r.skill === LIST_ROUTE) continue;
    if (!exists(r.skill)) dead.push(r.skill);
  }
  for (const d of DEFAULTS) {
    if (!exists(d.skill)) dead.push(d.skill);
  }
  return { ok: dead.length === 0, dead: [...new Set(dead)] };
}

function main() {
  const input = process.argv.slice(2).join(' ');

  if (input === '--verify') {
    const v = verifyRoutes();
    console.log(JSON.stringify(v));
    process.exit(v.ok ? 0 : 1);
  }

  if (!input) {
    console.log('Aspira Skill Router');
    console.log('Usage: node skills/dispatch.js <intent>');
    console.log('       node skills/dispatch.js --verify   # 自检路由表');
    console.log('');
    console.log('Quick routes:');
    DEFAULTS.forEach(d => console.log(`  ${d.desc} -> ${d.skill}`));
    console.log('');
    console.log('Or use skill_view(name="<skill>") to load any skill directly.');
    process.exit(0);
  }

  const route = pickRoute(input);
  const target = route ? route.skill : null;

  if (!route) {
    const fallback = matchIntents(input)[0] || null;
    console.log(JSON.stringify({
      matched: false,
      input,
      suggested: fallback ? fallback.skill : null,
      reason: 'no matching skill available in repo skills/, global ~/.hermes/skills/heartflow, or global mark-heartflow-skill skills',
      defaults: DEFAULTS,
      hint: 'Run: node skills/dispatch.js list'
    }));
    process.exit(0);
  }

  if (target === LIST_ROUTE) {
    const skills = new Set();
    for (const base of SEARCH_ROOTS) {
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        if (fs.existsSync(path.join(base, name, 'SKILL.md'))) skills.add(name);
      }
    }
    const sorted = Array.from(skills).sort();
    console.log(JSON.stringify({ matched: true, intent: input, total: sorted.length, skills: sorted }));
    process.exit(0);
  }

  if (!exists(target)) {
    console.log(JSON.stringify({
      matched: false,
      input,
      suggested: target,
      reason: 'skill not found on disk',
      defaults: DEFAULTS,
      hint: 'Run: node skills/dispatch.js list'
    }));
    process.exit(0);
  }

  const skillPath = findSkill(target);
  console.log(JSON.stringify({
    matched: true,
    intent: input,
    route: route.desc,
    skill: target,
    skillPath,
    next: `skill_view(name="${target}")`
  }));
}

module.exports = { ROUTES, DEFAULTS, SEARCH_ROOTS, pickRoute, matchIntents, verifyRoutes, exists, findSkill };

if (require.main === module) main();
