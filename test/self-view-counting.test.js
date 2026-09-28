/**
 * test/self-view-counting.test.js — 自省计数必须一次 think 只计一次
 *
 * ═══ 本轮(performance-optimization 切片)的发现 ═══
 * 上轮 journal 把 "self-view.json 读-改-写无锁" 列为引擎级缺陷。本轮先量测:
 *   6 个进程同时各 think 10 次(每次间 120ms 拉宽窗口)
 *     thinkCount=20  期望=70  → 声称"丢失 83%"
 * 但继续挖下去发现**更严重且更简单的缺陷**:
 *
 * ═══ 缺陷一(已修): 一次 think() 被计两次 ═══
 * src/core/think-pipeline.js:190 与 src/core/heartflow.js:4949 **都自增**
 * thinkCount / lowConfCount / blockedCount。实测: 6 个进程各 think 一次，
 * self-view.json 里 thinkCount=12(期望 6)，正好翻倍。
 * 串行同样翻倍: think 5 次得 10，think 10 次得 20。
 * 修法: 计数只保留 pipeline 一处(它还管 last50/misalignedCount)，
 * heartflow 那处退化为只落盘 + 喂 Reflector。
 * 顺带统一了 lowConfCount 阈值(原先 pipeline 用 conf<0.3、
 * heartflow 用 conf<0.4，同一次 think 会因阈值不同被分别计一次)。
 *
 * ═══ 缺陷二(部分修，诚实记录残余) ═══
 * 原实现是"内存态整份覆写": 启动时读一次旧文件，之后每次 think 把
 * 自己累加后的整份 _selfView writeFileSync 覆写回去。多进程并发时
 * 后写覆盖先写。已改为"写前重读磁盘 + 合并 + 临时文件 rename"，
 * 修掉了"读者读到写了一半的文件"这一类。
 *
 * ⚠️ 但这**没有**彻底消除计数丢失: 并发下各进程从同一基线各自累加，
 * 取 max 只能取到"走得最远的那份"，无法还原总量，实测同场景仍丢失。
 * 彻底解法是 append-only 增量日志或文件锁——试过增量日志，因与既有的
 * "启动载入视图"语义双算(thinkCount 飙到 1700 万)而回退。
 * 这里把残余风险显式写进测试，而不是假装已经修好。
 *
 * ═══ 我的两次误判(都是我的问题，不是引擎的) ═══
 * 1) 首版探针同步调用 async 的 think()，没等落盘就退出，把"我没等"
 *    误测成"引擎丢失 83%"。改对探针后数字依旧，才继续深挖。
 * 2) 曾据 journal 的推测直接去修"并发丢失"，没先量测确认它是否真的发生、
 *    是否是最严重的问题。实测后发现重复计数比它严重得多且好修得多。
 */
module.exports = function ({ test, assertTrue, assertEqual }) {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const ROOT = path.join(__dirname, '..');
  const HF_PATH = path.join(ROOT, 'src', 'core', 'heartflow.js');

  // 在独立临时目录里跑 N 次 think，返回 self-view.json 的 thinkCount
  function runThinks(times) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-svc-'));
    const src = [
      "const H=require(" + JSON.stringify(HF_PATH) + ");",
      "(async()=>{",
      "  const hf=new H.Aspira({rootPath:" + JSON.stringify(tmp) + ",silent:true});",
      "  hf.start();",
      "  for(let i=0;i<" + times + ";i++) await hf.think('测试句子');",
      "})();",
    ].join('\n');
    const r = spawnSync('node', ['-e', src], { encoding: 'utf8', timeout: 180000 });
    const f = path.join(tmp, 'data', 'self-view.json');
    const n = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).thinkCount : null;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    return n;
  }

  test('一次 think() 只能让 thinkCount +1(不得翻倍)', () => {
    // 这是本文件的核心: 修复前 think 5 次得 10、think 10 次得 20。
    const a = runThinks(5);
    const b = runThinks(10);
    assertEqual(a, 5, `think 5 次应得 thinkCount=5，实测 ${a}(修复前是 10，翻倍)`);
    assertEqual(b, 10, `think 10 次应得 thinkCount=10，实测 ${b}(修复前是 20，翻倍)`);
  });

  test('串行跨进程累积必须正确(读旧文件 → 累加 → 写回)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-svs-'));
    const src = n => [
      "const H=require(" + JSON.stringify(HF_PATH) + ");",
      "(async()=>{",
      "  const hf=new H.Aspira({rootPath:" + JSON.stringify(tmp) + ",silent:true});",
      "  hf.start();",
      "  for(let i=0;i<" + n + ";i++) await hf.think('c');",
      "})();",
    ].join('\n');
    try {
      spawnSync('node', ['-e', src(5)], { encoding: 'utf8', timeout: 180000 });
      const f = path.join(tmp, 'data', 'self-view.json');
      const a = JSON.parse(fs.readFileSync(f, 'utf8')).thinkCount;
      spawnSync('node', ['-e', src(5)], { encoding: 'utf8', timeout: 180000 });
      const b = JSON.parse(fs.readFileSync(f, 'utf8')).thinkCount;
      assertEqual(a, 5, `第一个进程 5 次后应为 5，实测 ${a}`);
      assertEqual(b, 10, `第二个进程再 5 次后应为 10，实测 ${b}`);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('self-view.json 必须始终是完整 JSON(原子替换，无半写状态)', () => {
    // 修复前用裸 writeFileSync 覆写，读者可能读到写了一半的文件。
    // 现在走"临时文件 + rename"。这里连写多次并反复读，验证不出现解析失败。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-sva-'));
    const src = [
      "const H=require(" + JSON.stringify(HF_PATH) + ");",
      "(async()=>{",
      "  const hf=new H.Aspira({rootPath:" + JSON.stringify(tmp) + ",silent:true});",
      "  hf.start();",
      "  for(let i=0;i<12;i++) await hf.think('原子性测试');",
      "})();",
    ].join('\n');
    try {
      spawnSync('node', ['-e', src], { encoding: 'utf8', timeout: 180000 });
      const f = path.join(tmp, 'data', 'self-view.json');
      assertTrue(fs.existsSync(f), 'self-view.json 应存在');
      const sv = JSON.parse(fs.readFileSync(f, 'utf8'));  // 不抛错即为完整
      assertEqual(sv.thinkCount, 12, `12 次 think 应得 12，实测 ${sv.thinkCount}`);
      // 不得残留临时文件
      const leftovers = fs.readdirSync(path.dirname(f)).filter(x => x.includes('.tmp-'));
      assertEqual(leftovers.length, 0, `不应残留临时文件: ${leftovers.join(',')}`);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('源码中不得再有两处自增 thinkCount(防回归)', () => {
    const hf = fs.readFileSync(HF_PATH, 'utf8');
    const tp = fs.readFileSync(path.join(ROOT, 'src', 'core', 'think-pipeline.js'), 'utf8');
    // pipeline 是唯一允许自增的地方
    assertTrue(/thinkCount\+\+/.test(tp), 'think-pipeline.js 应保留 thinkCount++');
    // heartflow 不得再出现自增(修复前它有 sv.thinkCount = (sv.thinkCount || 0) + 1)
    assertTrue(!/thinkCount\s*=\s*\(?[^)]*thinkCount[^)]*\)?\s*\+\s*1/.test(hf),
      'heartflow.js 不得再自增 thinkCount——那会与 think-pipeline 双算');
  });
};
