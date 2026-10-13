#!/usr/bin/env node
/**
 * 批量替换裸 fs 为 safe-fs
 * 策略：只处理 src/ 下的 .js 文件，排除 src/utils/safe-fs.js 自身
 *
 * ═══ 为什么从 test/ 搬到 scripts/ ═══
 * 它原来叫 test/audit-fix-safe-fs.js。run-all.js 的发现规则是
 * `ent.name.endsWith('.test.js')`，所以这个文件**从来不进门禁**——
 * 而它根本不是测试，是一个批量改写 src/ 的脚本。把它放在 test/ 下的后果是：
 * 任何本着"把没跑过的测试跑一遍"去执行 test/ 下非 .test.js 文件的人
 * （包括我自己，2026-10-13），都会一键改掉 37 个 src 文件。
 * scripts/ 是放工具的地方，它属于那里。
 *
 * ═══ 修的是哪个缺陷 ═══
 * getRelativeSafeFs() 原来在 depth === 0 时返回空前缀：
 *
 *     const prefix = depth === 0 ? '' : '../'.repeat(depth);
 *     return prefix + 'utils/safe-fs';
 *
 * src/ 根下的文件 depth 为 0，于是生成 `require('utils/safe-fs')` ——
 * 一个裸标识符，node 解析不到，**每个被改的文件都加载不了**。
 * 实测一次运行改坏 37 个文件、把 src/index.js 整个打断
 * （Cannot find module 'utils/safe-fs'），而门禁在那一刻仍然是绿的，
 * 因为坏掉的文件大多不在门禁路径上。
 * depth >= 1 时 `../`.repeat(depth) 本来是对的（src/core/ → ../utils/safe-fs），
 * 所以只有 src/ 根下那一批中招——这正是它难发现的原因：不是全错，是错一半。
 *
 * 修法：depth === 0 时前缀是 './'，与 node 对相对路径的解析一致。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function getRelativeSafeFs(filePath) {
  const dir = path.dirname(filePath);
  // 计算从文件目录到 src/utils/ 的相对路径
  const relFromSrc = path.relative(SRC, dir);
  const parts = relFromSrc.split(path.sep).filter(Boolean);
  const depth = parts.length; // 例如 src/core/ 的 depth = 1
  // depth === 0 时必须是 './'，不能是空串：空串会生成裸标识符
  // require('utils/safe-fs')，node 解析不到。
  const prefix = depth === 0 ? './' : '../'.repeat(depth);
  return prefix + 'utils/safe-fs';
}

let total = 0;
let changed = 0;

function processFile(filePath) {
  total++;
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    const original = content;

    // 跳过 safe-fs.js 自身
    if (path.basename(filePath) === 'safe-fs.js') return;

    // 检查是否有裸 fs 调用
    if (!/fs\.(writeFileSync|appendFileSync|readFileSync|mkdirSync|existsSync|readdirSync|copyFileSync|unlinkSync|renameSync|chmodSync|statSync)/.test(content)) {
      return; // 无裸 fs 调用，跳过
    }

    // 1. 替换 require('fs') 为 safe-fs
    // 只替换 require('fs') 和 require("fs")，不替换其他 require
    content = content.replace(
      /require\(['"]fs['"]\)/g,
      `require('${getRelativeSafeFs(filePath)}')`
    );

    // 2. 确保 fs 变量名保持不变（safe-fs 导出完整兼容 API）

    if (content !== original) {
      fs.writeFileSync(filePath, content, 'utf8');
      changed++;
      console.log(`✓ ${path.relative(ROOT, filePath)} (${getRelativeSafeFs(filePath)})`);
    }
  } catch (e) {
    console.error(`✗ ${path.relative(ROOT, filePath)}: ${e.message}`);
  }
}

// 递归处理所有 .js 文件
function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      processFile(full);
    }
  }
}

console.log('=== 批量替换裸 fs → safe-fs ===\n');
walk(SRC);
console.log(`\n完成: 扫描 ${total} 个文件, 修改 ${changed} 个文件`);
console.log('改完请立刻 `git diff --stat -- src/` 核对：本脚本一次运行会动几十个文件，');
console.log('而其中 depth===0 的那一批（src/ 根下）历史上正是出问题的位置。');
