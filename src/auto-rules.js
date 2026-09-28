/**
 * src/auto-rules.js — 新愿自主规则生成
 *
 * 当 error-memory 检测到同类错误反复发生（3+次），
 * 自动生成新的检查规则，追加到 data/auto-rules.json。
 * 下次 checkAutoRules() 就会拦截同类型问题。
 *
 * 用法：
 *   const auto = require('./auto-rules.js');
 *   auto.tryGenerate(em.getStats());  // 检查是否需要生成新规则
 *   auto.checkAutoRules('当前回复');  // 检查是否踩到自生成规则
 */

'use strict';
const fs = require('fs');
const path = require('path');

// [测试隔离] RULES_FILE 可经环境变量覆盖。
// data/auto-rules.json 是**跨测试文件共享的可变状态**，而 run-all.js 并发执行
// 多个测试文件: test/auto-rules.test.js 与 test/auto-rules-cache.test.js 都
// clearRules()/tryGenerate()/writeFileSync 它，互相踩踏。实测连跑全量偶发
// 4 条失败(checkAutoRules detects triggered rules、duplicate rule not generated
// twice、以及缓存用例)。各测试文件设成自己的临时文件即彻底隔离。
// 生产不设该变量，行为与原先完全一致。
const RULES_FILE = process.env.ASPIRA_AUTO_RULES_FILE
  || path.join(__dirname, '..', 'data', 'auto-rules.json');

// ─── 错误模式 → 规则模板 ─────────────────────────

const RULE_TEMPLATES = {
  overconfidence: {
    name: 'auto_overconfidence',
    description: '自生成：对"过度自信"类错误的预防规则',
    triggers: ['毫无疑问', '毋庸置疑', '唯一', '绝对', '肯定', '一定'],
    action: 'alert',
    message: '检测到之前犯过类似过度自信的错误',
  },
  hallucination: {
    name: 'auto_hallucination',
    description: '自生成：对"幻觉"类错误的预防规则',
    triggers: ['根据研究', '数据表明', '专家指出', '研究表明'],
    action: 'verify',
    message: '此类断言曾被指出无证据支持，请确认',
  },
  sycophancy: {
    name: 'auto_sycophancy',
    description: '自生成：对"谄媚"类错误的预防规则',
    triggers: ['您说得对', '很好的问题', '完全同意'],
    action: 'alert',
    message: '检测到之前因过度附和被纠正',
  },
  defensiveness: {
    name: 'auto_defensiveness',
    description: '自生成：对"防御姿态"类错误的预防规则',
    triggers: ['你可能没理解', '其实我意思是', '但更重要的是'],
    action: 'block',
    message: '检测到防御姿态模式，强制认错格式',
  },
  vagueness: {
    name: 'auto_vagueness',
    description: '自生成：对"模糊回避"类错误的预防规则',
    triggers: ['相关部门', '据了解', '业内人士', '据传'],
    action: 'alert',
    message: '此类模糊表述曾被指出问题',
  },
  binary: {
    name: 'auto_binary',
    description: '自生成：对"二元论"类错误的预防规则',
    triggers: ['不是', '就是', '要么', '要么', '唯一选择'],
    action: 'alert',
    message: '二元论表述曾被指出忽略了中间可能性',
  },
  omission: {
    name: 'auto_omission',
    description: '自生成：对"遗漏问题"类错误的预防规则',
    triggers: ['没有遗漏', '完全覆盖', '全部完成', '所有都'],
    action: 'alert',
    message: '绝对化覆盖式表述曾被指出遗漏问题',
  },
};

// ─── 规则文件操作 ─────────────────────────

/**
 * [性能] loadRules 原先每次调用都 existsSync + readFileSync + JSON.parse。
 * 而 checkAutoRules() 是 pipeline 的 auto-rules 层，每次 checkInput/checkOutput/
 * runPipeline 都跑它——即**每次门禁都付一次同步文件 IO**。
 * 实测(2000 次): checkAutoRules 0.0086ms/次，其中裸 readFileSync 0.0067ms，
 * **IO 占 78%**。CPU profile(3000 次混合判别)里 readFileUtf8 占 1.5%
 * (120.7ms / 8248.5ms)，是最大的非正则单项开销; 且同步 IO 会阻塞 MCP server
 * 的事件循环，并发下代价高于单次测量所示。
 *
 * 修复: 按 (mtimeMs, size) 缓存解析结果。规则只由 saveRules()/tryGenerate() 写入，
 * mtime 或大小变化即失效重读; 另在 saveRules() 里主动清缓存，避免同一毫秒内
 * 连续写入时 mtime 分辨率不足导致的不失效。
 * 文件不存在时不缓存(仍每次 stat，成本可忽略且能立刻发现新建文件)。
 */
let _rulesCache = { mtimeMs: -1, size: -1, rules: null };

function loadRules() {
  try {
    let st;
    try {
      st = fs.statSync(RULES_FILE);
    } catch {
      return { rules: [] };
    }
    if (_rulesCache.rules && _rulesCache.mtimeMs === st.mtimeMs && _rulesCache.size === st.size) {
      return { rules: _rulesCache.rules };
    }
    const data = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    _rulesCache = { mtimeMs: st.mtimeMs, size: st.size, rules: data.rules || [] };
    return { rules: _rulesCache.rules };
  } catch {
    return { rules: [] };
  }
}

function saveRules(data) {
  const dir = path.dirname(RULES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(RULES_FILE, JSON.stringify(data, null, 2), 'utf8');
  // 主动失效: 连续写入可能落在同一 mtime 刻度内，只靠 mtime 判断会读到旧缓存
  _rulesCache = { mtimeMs: -1, size: -1, rules: null };
}

// ─── 核心：根据错误统计尝试生成新规则 ──────────

/**
 * 检查当前错误统计，对高频错误分类生成预防规则
 * @param {object} stats - 从 error-memory.getStats() 获取的统计
 * @param {object} em - error-memory 模块实例
 * @returns {{ generated: number, rules: Array }}
 */
function tryGenerate(stats, em) {
  if (!stats || !stats.byCategory) return { generated: 0, rules: [] };

  const existing = loadRules();
  const existingNames = new Set(existing.rules.map(r => r.name));
  const generated = [];

  for (const [category, count] of Object.entries(stats.byCategory)) {
    // 检查是否已高频复发（recurrenceCount >= 3）或分类计数 >= 3
    const highRecurrence = stats.highRecurrence > 0;  // 任何 3+ 复发的错误
    if ((count >= 3 || highRecurrence) && RULE_TEMPLATES[category]) {
      const template = RULE_TEMPLATES[category];
      if (!existingNames.has(template.name)) {
        const rule = {
          ...template,
          createdAt: new Date().toISOString(),
          triggerCount: count,
          category,
        };
        existing.rules.push(rule);
        generated.push(rule);
        existingNames.add(template.name);
      }
    }
  }

  if (generated.length > 0) {
    saveRules(existing);
  }

  return { generated: generated.length, rules: generated };
}

// ─── 检查回复是否踩到自生成规则 ──────────

/**
 * 检查文本是否触发任意自生成规则
 * @param {string} text - 要检查的回复文本
 * @returns {{ triggered: Array, safe: boolean }}
 */
function checkAutoRules(text) {
  if (!text || typeof text !== 'string') return { triggered: [], safe: true };

  const existing = loadRules();
  if (existing.rules.length === 0) return { triggered: [], safe: true };

  const triggered = [];

  for (const rule of existing.rules) {
    const triggers = Array.isArray(rule.triggers) ? rule.triggers : [];
    for (const trigger of triggers) {
      if (text.includes(trigger)) {
        triggered.push({
          rule: rule.name,
          trigger,
          action: rule.action,
          message: rule.message,
        });
        break;
      }
    }
  }

  return { triggered, safe: triggered.length === 0 };
}

// ─── 分析错误是否有改善趋势 ──────────

/**
 * 对比前后两段时间的错误频率，判断是否改善
 * @param {object} em - error-memory 实例
 * @returns {{ improved: string[], worsened: string[], stable: string[] }}
 */
function analyzeTrend(em) {
  // 获取完整错误历史
  const memory = em.getStats ? { errors: [] } : { errors: [] };
  // 这个实现依赖 error-memory 内部的 loadMemory，简化版本：
  return { improved: [], worsened: [], stable: [] };
}

module.exports = {
  tryGenerate,
  checkAutoRules,
  RULE_TEMPLATES,
  clearRules: () => saveRules({ rules: [] }),
};
