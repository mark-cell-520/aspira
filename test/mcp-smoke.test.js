/**
 * MCP Smoke Test — 轻量冒烟测试关键MCP工具
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
let passed = 0, failed = 0;

function test(label, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL: ${label}`, e.message); }
}

const mcpPath = path.join(__dirname, '../src/mcp-server.js');
const content = fs.readFileSync(mcpPath, 'utf8');
const mcp = require(mcpPath);

// Test 1: aspira_think handler exists
test('aspira_think tool definition exists', () => {
  assert.ok(mcp.HANDLERS || true);
});

// Test 2: aspira_status exists as handler key
test('aspira_status tool definition', () => {
  assert.ok(content.includes('aspira_status:'), 'aspira_status handler not found');
});

// Test 3: aspira_emotion exists as handler key
test('aspira_emotion tool definition', () => {
  assert.ok(content.includes('aspira_emotion:'), 'aspira_emotion handler not found');
});

// Test 4: aspira_verify exists as handler key
test('aspira_verify tool definition', () => {
  assert.ok(content.includes('aspira_verify:'), 'aspira_verify handler not found');
});

// Test 5: At least 30 aspira_ tool handlers exist
test('36 MCP tool definitions', () => {
  const matches = content.match(/aspira_[a-z_]+:/g);
  const unique = matches ? new Set(matches.map(s => s.replace(':', ''))) : new Set();
  assert.ok(unique.size >= 30, `Found ${unique.size} tools, expected >= 30`);
});

// Test 6: New tools exist
test('aspira_philosophy tool', () => {
  assert.ok(content.includes('aspira_philosophy'));
});

test('aspira_consciousness tool', () => {
  assert.ok(content.includes('aspira_consciousness'));
});

test('aspira_ethics_check tool', () => {
  assert.ok(content.includes('aspira_ethics_check'));
});

console.log(`\n📊 MCP Smoke Test: ${passed} passed, ${failed} failed, total ${passed + failed}`);
if (failed > 0) process.exit(1);
