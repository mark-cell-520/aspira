#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGE_FILE = path.join(ROOT, 'package.json');
const SKILL_FILE = path.join(ROOT, 'SKILL.md');
const HEARTFLOW_FILE = path.join(ROOT, 'src', 'core', 'heartflow.js');

function syncPackage(version) {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf-8'));
  if (pkg.version !== version) {
    pkg.version = version;
    fs.writeFileSync(PACKAGE_FILE, JSON.stringify(pkg, null, 2) + '\n');
    console.log('Updated package.json →', version);
  } else {
    console.log('package.json already at', version);
  }
}

function syncSkill(version) {
  if (!fs.existsSync(SKILL_FILE)) return;
  let content = fs.readFileSync(SKILL_FILE, 'utf-8');
  const re = /version:\s*"[^"]*"/;
  if (re.test(content)) {
    content = content.replace(re, `version: "${version}"`);
    fs.writeFileSync(SKILL_FILE, content);
    console.log('Updated SKILL.md →', version);
  } else {
    console.log('SKILL.md version field not found, skipped');
  }
}

function syncHeartflowBuildDate(version) {
  if (!fs.existsSync(HEARTFLOW_FILE)) return;
  let content = fs.readFileSync(HEARTFLOW_FILE, 'utf-8');
  const date = new Date().toISOString().slice(0, 10);
  const newBuild = `${date}-${version}`;
  const re = /const BUILD_DATE = '[^']*';/;
  if (re.test(content)) {
    content = content.replace(re, `const BUILD_DATE = '${newBuild}';`);
    fs.writeFileSync(HEARTFLOW_FILE, content);
    console.log('Updated heartflow.js BUILD_DATE →', newBuild);
  } else {
    console.log('heartflow.js BUILD_DATE not found, skipped');
  }
}

// [doc-honest-numbers·第一百八十九轮] .well-known/agent-card.json 是 A2A 协议
// 的标准发现路径, 任何按该协议发现 Aspira 的 agent 都会读它的 version 字段。
// 它曾是**第六个版本副本**而 convention #1 只列了五个: 实测它冻结在 6.7.5
// (CHANGELOG.md 的 [6.7.5] - 2026-08-27), 与 VERSION 1.0.71 相差几十个版本,
// 且审计只扫 .md 所以从未被任何东西检查过。没有 writer 的 verifier 会周期性
// 红, 所以这里补上 writer —— 否则 test/non-md-doc-claims.test.js 每轮 bump
// 都会把它揪出来, 那是一个训练人忽略锁的红。
function syncAgentCard(version) {
  const f = path.join(ROOT, '.well-known', 'agent-card.json');
  if (!fs.existsSync(f)) return;
  const card = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (card.version !== version) {
    card.version = version;
    fs.writeFileSync(f, JSON.stringify(card, null, 2) + '\n');
    console.log('Updated .well-known/agent-card.json version →', version);
  } else {
    console.log('.well-known/agent-card.json already at', version);
  }
}

// 优先从 VERSION 文件读取
const vf = path.join(ROOT, 'VERSION');
let version;
if (fs.existsSync(vf)) {
  version = fs.readFileSync(vf, 'utf-8').trim();
  console.log('Source version (from VERSION file):', version);
} else {
  const VERSION_FILE = path.join(ROOT, 'src', 'core', 'version.js');
  const versionContent = fs.readFileSync(VERSION_FILE, 'utf-8');
  const match = versionContent.match(/VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (match) {
    version = match[1];
    console.log('Source version (from version.js):', version);
  } else {
    console.error('ERROR: Cannot find version');
    process.exit(1);
  }
}

syncPackage(version);
syncSkill(version);
syncHeartflowBuildDate(version);
syncAgentCard(version);
console.log('Version sync complete:', version);
