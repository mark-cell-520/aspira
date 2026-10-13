/**
 * test/engram-init-error-visibility.test.js — Engram 子系统初始化失败必须留痕
 *
 * ═══ 背景：一个子系统死了整整一个版本号周期，而仪表盘一直是 0 ═══
 * ea288d0 修的是 src/core/heartflow.js 的 require 路径少一级 ../ ——
 * Engram 条件记忆子系统自写下那天起就没加载过。而它能藏那么久，是因为
 * 原代码长这样：
 *
 *     try { ... } catch (_) { this._engram = null; }
 *
 * catch 吞掉异常、不 push _initErrors。于是 initErrors 恒为 0，
 * `node bin/cli.js status` 与 README/SKILL 的 | Module init errors | 0 |
 * 全都"如实"报 0 —— 一个子系统是死的，没有任何读数为此变过。
 * 这正是本仓反复记载的形状：调用成功、无报错、返回值结构合法、内容为空。
 *
 * ═══ 修法 ═══
 * 与兄弟模块（memoryIndex / agentCard / memoryKernel / truth / behavior /
 * persistence / stability / execution / decision / decisionVerifier）用同一个
 * 惯用法：留着 null 不阻断启动，但把原因写进 _initErrors。
 *
 * ═══ 锁什么 ═══
 * ① 源级: catch 不得再把错误整个丢掉（不许回到 `catch (_)`）；
 * ② 行为: 注入会抛的替身模块后，_initErrors 必须出现 module:'engram'，
 *    且 _engram === null、引擎仍能 think（不阻断启动）；
 * ③ 反向对照: 正常路径下 _initErrors 里不得有 module:'engram' ——
 *    否则每轮都红，锁就失去了分辨力；
 * ④ 消费侧仍在: ea288d0 修的路径不能被回退，store/recall/recallByDecision
 *    三个调用点必须都还在。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HF = path.join(ROOT, 'src', 'core', 'heartflow.js');
const ENGRAM = path.join(ROOT, 'src', 'memory', 'engram-memory.js');

/** 读源码（本锁只读 src/ 下的源码，不碰探针目标文档，故不需持 doc 锁） */
function src(p) { return fs.readFileSync(p, 'utf8'); }

/**
 * 剥掉行注释与块注释后再做源级断言。
 *
 * 为什么必须剥：本文件自己的注释里就引用了 `catch (_) { this._engram = null; }`
 * 这个字符串，不剥的话源级正则会匹配到注释而不是代码 —— 写这把锁时当场踩中，
 * 而这是本仓反复记载的形状（cycle 224 第五例：仪器量到错的东西，于是把健康的
 * 代码报告成空的；doc-reader-lock-coverage 也因 JSDoc 引用了字符串而误伤过一次）。
 *
 * 局限（如实记）：这个剥离器不懂 JS 语法，字符串字面量里若含 `//` 或 `/*`
 * 会被误剥。对本锁够用，因为它断言的是 `catch (_)` 与 `_boundedPush` 这类
 * 不可能出现在字符串里的形态。
 */
function codeOnly(p) {
  return src(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

module.exports = function ({ test, assertTrue, assertEqual }) {

  test('源级: engram 的 catch 不得再把错误整个丢掉', () => {
    const s = codeOnly(HF);
    assertTrue(!/catch\s*\(_\s*\)\s*\{\s*this\._engram\s*=\s*null\s*;\s*\}/.test(s),
      '又回到了 catch (_) { this._engram = null; } —— 失败将再次不可见');
    // 必须与兄弟模块同惯用法
    assertTrue(/_boundedPush\(this\._initErrors,\s*\{\s*module:\s*'engram'/.test(s),
      'engram 未按 _boundedPush(this._initErrors, { module: \'engram\', ... }) 记录');
  });

  test('行为: 注入会抛的替身后，失败必须记进 _initErrors 且不阻断启动', () => {
    // 子进程隔离：heartflow.start() 有副作用（写 data/），不能污染测试进程。
    // 用 require.cache 注入一个 exports 上没有 EngramMemory 的替身，
    // 于是 new En.EngramMemory(...) 抛 TypeError —— 与路径写错同一族失败。
    const probe = `
      const path = require('path');
      const Module = require('module');
      const TARGET = ${JSON.stringify(ENGRAM)};
      const stub = new Module(TARGET, null);
      stub.filename = TARGET; stub.loaded = true; stub.exports = {};
      require.cache[TARGET] = stub;
      const hf = require(${JSON.stringify(HF)});
      const e = new hf.Aspira({ dataDir: ${JSON.stringify(path.join(ROOT, 'data'))}, silent: true });
      e.start();
      const errs = (e._initErrors || []).filter(x => x.module === 'engram');
      console.log('ENGRAM_ERRS=' + JSON.stringify(errs));
      console.log('ENGRAM_NULL=' + (e._engram === null));
      console.log('THINK_OK=' + (typeof e.think === 'function'));
    `;
    let out = '';
    try {
      out = execFileSync(process.execPath, ['-e', probe], {
        cwd: ROOT, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test' },
      });
    } catch (e) { out = (e.stdout || '') + '\n' + (e.stderr || ''); }

    const errsLine = (out.match(/ENGRAM_ERRS=(\[.*\])/) || [])[1];
    assertTrue(!!errsLine, '子进程没吐出 ENGRAM_ERRS，输出: ' + out.slice(-400));
    const errs = JSON.parse(errsLine);
    assertEqual(errs.length, 1, '失败必须恰好记一条，实际: ' + JSON.stringify(errs));
    assertTrue(!!errs[0].error && /EngramMemory/.test(errs[0].error),
      '记录里必须带错误原因，实际: ' + JSON.stringify(errs[0]));
    assertTrue(/ENGRAM_NULL=true/.test(out), '失败时 _engram 必须是 null');
    assertTrue(/THINK_OK=true/.test(out), 'engram 失败不阻断启动，引擎必须仍能 think');
  });

  test('反向对照: 正常路径下 _initErrors 里不得有 module:engram', () => {
    // 没有这一条，②可以用"永远记一条"来满足 —— 锁就废了。
    const probe = `
      const hf = require(${JSON.stringify(HF)});
      const e = new hf.Aspira({ dataDir: ${JSON.stringify(path.join(ROOT, 'data'))}, silent: true });
      e.start();
      const errs = (e._initErrors || []).filter(x => x.module === 'engram');
      console.log('OK_COUNT=' + errs.length);
      console.log('ENGRAM_ALIVE=' + (e._engram !== null));
    `;
    let out = '';
    try {
      out = execFileSync(process.execPath, ['-e', probe], {
        cwd: ROOT, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test' },
      });
    } catch (e) { out = (e.stdout || '') + '\n' + (e.stderr || ''); }
    assertTrue(/OK_COUNT=0/.test(out), '正常启动不得报 engram 失败，输出: ' + out.slice(-400));
    assertTrue(/ENGRAM_ALIVE=true/.test(out), 'ea288d0 修的路径必须仍然有效（_engram 非空）');
  });

  test('消费侧仍在: store / recall / recallByDecision 三个调用点都不得消失', () => {
    const s = codeOnly(HF);
    assertTrue(/this\._engram\.store\(/.test(s), 'this._engram.store( 调用点消失');
    assertTrue(/this\._engram\.recall\(/.test(s), 'this._engram.recall( 调用点消失');
    assertTrue(/this\._engram\.recallByDecision\(/.test(s), 'this._engram.recallByDecision( 调用点消失');
    // require 路径必须是 src/core -> ../memory（ea288d0 修的就是这个）
    assertTrue(/require\(['"]\.\.\/memory\/engram-memory\.js['"]\)/.test(s),
      'require 路径退回了 —— ea288d0 的修复被撤销');
    assertTrue(fs.existsSync(ENGRAM), 'src/memory/engram-memory.js 必须存在');
  });

};
