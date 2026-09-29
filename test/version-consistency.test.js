/**
 * test/version-consistency.test.js — 约定 #1 的不变量必须被锁住
 *
 * ═══ 由来(第十三轮，test-coverage-gap 切片) ═══
 * 约定 #1 原文:
 *   **Never hardcode the version.** `VERSION` is the single source of truth.
 *   `src/core/version.js` reads it and carries a fallback that must match.
 *   `package.json` and `SKILL.md` must match. `hf.version` reads `VERSION` at runtime.
 *
 * 这条约定列出了 **五处**必须一致的位置，而实测:
 *   · `bin/verify.js` 不查版本一致性(全文只有 Node 主版本号检查)
 *   · 没有任何测试调用 `scripts/sync-version.js`——它只在 package.json 里被引用
 *   · `scripts/audit-doc-numbers.js` 只锁**文档声称**(SKILL.md 的
 *     `| Engine version | 1.0.0 |` 与 CURRENT_STATE 的 `> 版本 | v1.0.0`)，
 *     锁不住 package.json / version.js 兜底值 / heartflow.js BUILD_DATE / 运行时
 *
 * 于是 `sync-version.js` 是一个**只有写者、没有验证者**的脚本:
 * 改了 VERSION 却忘了跑它，五处里漏掉任何一处，都没有任何东西会响。
 *
 * ═══ 为什么兜底值这一条特别值得锁 ═══
 * `src/core/version.js` 的注释自己写明了隐患:
 *   "兜底值必须与 VERSION 保持同步 —— 否则 VERSION 文件读失败时
 *    (打包遗漏/权限问题)引擎会自报一个落后几十个版本的号，
 *    **且外部没有任何提示**。"
 *
 * 这正是本仓库反复记载的形状: **让代码安全的守卫，恰恰让失败隐形**。
 * 兜底存在的唯一理由就是"VERSION 读不到"那一刻; 而 VERSION 读得成功时
 * (也就是所有正常运行时)兜底永不被求值——所以它错了也没有任何输出。
 * 它只在整个仓库最糟的那一刻起作用，而那一刻它自己是无声的。
 *
 * ═══ 测试怎么在不动仓库的前提下验证兜底路径 ═══
 * 直接把仓库里的 VERSION 文件改名来触发兜底，会在测试崩溃时把仓库
 * 留在坏状态里(周期 11 已经吃过"报告成功的工具其实写错了东西"的亏)。
 * 改为在临时目录里复制 version.js + 它 require 的 safe-fs.js，
 * 并**不**放 VERSION 文件——路径解析完全一致，仓库一个字节都不动。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'VERSION');
const PACKAGE_FILE = path.join(ROOT, 'package.json');
const SKILL_FILE = path.join(ROOT, 'SKILL.md');
const VERSION_JS = path.join(ROOT, 'src', 'core', 'version.js');
const HEARTFLOW_JS = path.join(ROOT, 'src', 'core', 'heartflow.js');
const SYNC_SCRIPT = path.join(ROOT, 'scripts', 'sync-version.js');

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function readVersionFile() {
  const raw = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  if (!SEMVER.test(raw)) throw new Error('VERSION 文件内容不是合法语义版本: ' + JSON.stringify(raw));
  return raw;
}

module.exports = function ({ test, assertTrue, assertEqual }) {

  test('VERSION 文件必须存在且是合法语义版本', () => {
    assertTrue(fs.existsSync(VERSION_FILE), 'VERSION 文件必须存在——它是唯一真相源');
    const v = readVersionFile();
    assertTrue(SEMVER.test(v), 'VERSION 必须是合法语义版本，实测: ' + JSON.stringify(v));
  });

  test('package.json 版本必须与 VERSION 一致', () => {
    const v = readVersionFile();
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));
    assertEqual(pkg.version, v,
      'package.json 的 version 必须与 VERSION 一致——约定 #1 点名了它，'
      + '而它此前由 sync-version.js 负责写、却没有任何东西负责核对');
  });

  test('SKILL.md front-matter 版本必须与 VERSION 一致', () => {
    const v = readVersionFile();
    const s = fs.readFileSync(SKILL_FILE, 'utf8');
    const m = s.match(/^version:\s*"([^"]*)"/m);
    assertTrue(!!m, 'SKILL.md 必须有 front-matter version 字段');
    assertEqual(m[1], v,
      'SKILL.md 的 version 必须与 VERSION 一致——sync-version.js 的 syncSkill() 写的正是这一处');
  });

  test('version.js 兜底值必须与 VERSION 一致', () => {
    const v = readVersionFile();
    const src = fs.readFileSync(VERSION_JS, 'utf8');
    // 只取 try 之前的那一处赋值: try 里读文件成功后会重新赋值，
    // 抓错就会把"兜底值"变成"读到的值"，锁不住真正想锁的东西。
    const head = src.split('try {')[0];
    const m = head.match(/let\s+VERSION\s*=\s*'([^']*)'/);
    assertTrue(!!m, 'version.js 必须有 `let VERSION = \'...\'` 兜底赋值');
    assertEqual(m[1], v,
      'version.js 的兜底值必须与 VERSION 一致。它只在 VERSION 读失败时被求值，'
      + '所以正常运行时它永远不出声——错了也没有任何提示，正如该文件注释自陈');
  });

  test('heartflow.js BUILD_DATE 必须带 -VERSION 后缀', () => {
    const v = readVersionFile();
    const src = fs.readFileSync(HEARTFLOW_JS, 'utf8');
    const m = src.match(/const\s+BUILD_DATE\s*=\s*'([^']*)'/);
    assertTrue(!!m, 'heartflow.js 必须有 BUILD_DATE 常量');
    assertTrue(m[1].endsWith('-' + v),
      'BUILD_DATE 必须以 -' + v + ' 结尾(sync-version.js 的 syncHeartflowBuildDate() '
      + '写的是 `<日期>-<版本>`)，实测: ' + JSON.stringify(m[1]));
  });

  test('运行时 hf.version 必须与 VERSION 一致', () => {
    const v = readVersionFile();
    const hf = require(path.join(ROOT, 'src', 'index.js'));
    assertEqual(hf.version, v,
      '运行时 hf.version 必须与 VERSION 一致——约定 #1 说 "hf.version reads VERSION at runtime"');
  });

  test('兜底路径必须真的走得通(VERSION 读不到时要回落到兜底字面量)', () => {
    const v = readVersionFile();
    const src = fs.readFileSync(VERSION_JS, 'utf8');
    const head = src.split('try {')[0];
    const fallback = head.match(/let\s+VERSION\s*=\s*'([^']*)'/)[1];
    // 在临时目录复刻 version.js 的路径结构，但让 safe-fs 的读**一定失败**。
    // 不动仓库里的真文件——周期 11 的教训: 一个在写错东西的同时
    // 报告成功的工具，比一个失败的工具更糟。
    //
    // ⚠️ 为什么桩掉 safe-fs 而不是把整个依赖链复制过去:
    // safe-fs.js 自己还 require ../core/path-guard.js，复制链又深又脆，
    // 而且真正要模拟的场景本来就是"VERSION 读不到"——文件缺失、权限不足、
    // safe-fs 的守卫拒掉路径，三者在 version.js 眼里是同一个 catch。
    // 桩抛错比复刻依赖树更准确地表达了"那一刻"。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-version-probe-'));
    try {
      fs.mkdirSync(path.join(tmp, 'src', 'core'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'src', 'utils'), { recursive: true });
      fs.copyFileSync(VERSION_JS, path.join(tmp, 'src', 'core', 'version.js'));
      fs.writeFileSync(path.join(tmp, 'src', 'utils', 'safe-fs.js'),
        "module.exports = { readFileSync() { throw new Error('模拟 VERSION 读取失败'); } };\n");
      const probe = require(path.join(tmp, 'src', 'core', 'version.js'));
      assertEqual(probe.VERSION, fallback,
        'VERSION 文件缺失时必须回落到兜底字面量 ' + JSON.stringify(fallback)
        + '(否则引擎会自报 ' + JSON.stringify(probe.VERSION) + ')');
      assertEqual(fallback, v,
        '兜底字面量必须与 VERSION 一致——上一条已经证明兜底路径真的会被走到');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      // 清掉 require 缓存，避免临时路径污染后续用例
      for (const k of Object.keys(require.cache)) {
        if (k.startsWith(tmp)) delete require.cache[k];
      }
    }
  });

  test('sync-version.js 必须存在且写明它同步哪些位置', () => {
    assertTrue(fs.existsSync(SYNC_SCRIPT),
      'scripts/sync-version.js 必须存在——约定 #1 说它负责在发布前同步');
    const src = fs.readFileSync(SYNC_SCRIPT, 'utf8');
    for (const f of ['package.json', 'SKILL.md', 'heartflow.js']) {
      assertTrue(src.includes(f),
        'sync-version.js 必须覆盖 ' + f + '——写者漏一处，验证者就少锁一处');
    }
    assertTrue(/VERSION/.test(src), 'sync-version.js 必须以 VERSION 为来源');
  });
};
