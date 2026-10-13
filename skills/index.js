/**
 * Aspira Skills Registry
 *
 * skills/ 下全部 skill 的索引，供 Aspira 引擎和 Claude 使用。
 * 每个 skill 包含一个 SKILL.md（触发条件 + 工作流）和 references/（详细文档）。
 *
 * 历史备注：本文件头部原写「14 个工作流 skill 索引」，那个数在 skills/ 涨到
 * 33 个之后从未更新 —— 一个只会腐烂的文档数字，现已改为不写死（见 listSkills）。
 */

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = __dirname;

/**
 * 解析 SKILL.md 的 YAML frontmatter 子集。
 *
 * 支持：`key: value`、单/双引号包裹的值、`|` `|-` `>` `>-` 块标量（按缩进收
 * 集块内行，`|` 保序、`>` 折叠为单行）。不支持锚点、多文档、流式集合 ——
 * SKILL.md 用不到这些。
 *
 * 为什么不能用正则扫：skills/ 里 description 普遍是块标量。旧实现用
 * `/^description:\s*\|?-?\s*(.+)$/m`，遇到 `description: >` 时 `\|` 匹配不到
 * `>`，`(.+)` 直接把块指示符本身当成描述（返回 ">"）；遇到 `description: |`
 * 时 `\s*` 跨过换行只取到块内首行，丢掉其余内容。
 *
 * 另一个更隐蔽的坑：`.` 不匹配 `\r`。若 SKILL.md 是 CRLF 行尾，逐行正则
 * `^key:\s*(.*)$` 会在 `\r` 前停下，而 `$`（无 m 标志）只认字符串真正结尾，
 * 于是整行匹配失败 —— skills/bug-fixing/SKILL.md 是 CRLF，它的 name 和
 * description 因此对整个注册表隐身，listSkills() 只能回落到目录名。
 *
 * @param {string} content - SKILL.md 全文
 * @returns {{name: string, description: string, version: string}}
 */
function parseFrontmatter(content) {
  const out = { name: '', description: '', version: '' };
  if (typeof content !== 'string' || !content.startsWith('---')) return out;
  // 行尾归一化必须放在切块之前：先转 LF 再找结束标记。若先 slice 再 replace，
  // 块内最后一行行尾的 \r 不在任何 \r\n  pair 里（后面的 \n 已被排除），
  // 于是残留一个 \r 拼进 description 尾部。
  const normalized = content.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) return out;

  const lines = normalized.slice(3, end).split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) { i++; continue; }
    const key = m[1];
    let value = m[2].trim();

    if (/^[|>][+-]?$/.test(value)) {
      // 块标量：收集后续所有缩进行
      const folded = value[0] === '>';
      const block = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') { block.push(''); i++; continue; }
        if (!/^\s/.test(l)) break;
        block.push(l.replace(/^\s+/, ''));
        i++;
      }
      while (block.length && block[block.length - 1] === '') block.pop();
      value = folded ? block.join(' ') : block.join('\n');
    } else {
      value = value.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
      i++;
    }
    if (key in out) out[key] = value;
  }
  return out;
}

/**
 * 列出所有可用的工作流 skill
 *
 * 不含 frontmatter 的 SKILL.md 也会出现在列表里（不静默隐藏），但
 * hasFrontmatter 为 false、name 回落到目录名 —— 调用方据此判断该 skill
 * 能否被 Claude Code 注册为可调用技能。
 *
 * @returns {Array<{name: string, description: string, version: string,
 *                  hasFrontmatter: boolean, path: string}>}
 */
function listSkills() {
  const skills = [];
  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    const skillDir = path.join(SKILLS_DIR, entry);
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMd) || !fs.statSync(skillDir).isDirectory()) continue;
    const fm = parseFrontmatter(fs.readFileSync(skillMd, 'utf-8'));
    const hasFrontmatter = !!(fm.name || fm.description);
    skills.push({
      name: fm.name || entry,
      description: fm.description,
      version: fm.version,
      hasFrontmatter,
      path: skillDir,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 按名称加载 skill 的 SKILL.md 内容
 * @param {string} name - Skill 名称（如 'heartflow-debug-workflow'）
 * @returns {string|null} SKILL.md 内容
 */
function loadSkill(name) {
  const skillDir = path.join(SKILLS_DIR, name);
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    return fs.readFileSync(skillMd, 'utf-8');
  }
  return null;
}

/**
 * 加载 skill 的 references 目录内容
 * @param {string} name - Skill 名称
 * @returns {Array<{name: string, path: string}>}
 */
function listReferences(name) {
  const refDir = path.join(SKILLS_DIR, name, 'references');
  if (!fs.existsSync(refDir)) return [];
  return fs.readdirSync(refDir)
    .filter(f => f.endsWith('.md') || f.endsWith('.js'))
    .map(f => ({
      name: f,
      path: path.join(refDir, f),
    }));
}

module.exports = { listSkills, loadSkill, listReferences, parseFrontmatter };
