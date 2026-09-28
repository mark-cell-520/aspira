/**
 * test/introspect-wiring.test.js — 自省链路接线回归测试
 * 覆盖：heartflow.introspect 路由 / self-view 计数 / Reflector 数据流
 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

module.exports = function ({ test }) {
  const ROOT = path.join(__dirname, '..');

  test('introspect: heartflow.introspect 路由可用', async () => {
    const { Aspira } = require('../src/core/heartflow.js');
    const hf = new Aspira({ dataDir: path.join(ROOT, 'data'), silent: true });
    hf.start();
    await new Promise(r => setTimeout(r, 2500));
    const r = await hf.dispatch('heartflow.introspect');
    assert.ok(r.ok, 'introspect 应成功');
    assert.ok(r.diagnosis && Object.keys(r.diagnosis).length >= 3, '诊断项 ≥ 3');
    hf.shutdown();
  });

  /**
   * [并发竞态修复] 根因是**共享文件上的读-改-写无锁**，不是测试写得不好:
   *
   * self-view.json 固定在 `<rootPath>/data/`(heartflow.js:4947 用 this.rootPath，
   * **不看 dataDir 选项**)。run-all.js 并发跑多个测试文件，别的文件同样实例化
   * Aspira 并 think()。某个长命实例把自己内存里的旧 thinkCount 写回文件时，
   * 会把全局计数**写回一个更低的值**——计数在并发下并非单调。
   * 于是 `after > before` 随机失败: 实测同一份代码连跑 3 次全量 985/1、986/0、986/0。
   *
   * 走过的弯路(记录，都无效):
   *  - 把 before 的读取挪到 think() 前一刻: 只缩小窗口，并发实例仍可回写旧值，
   *    反而从"偶发"变成"稳定失败"(3/3)。
   *  - 用 mkdtemp 隔离 **dataDir**: 无效且有害——self-view 的路径源自 rootPath，
   *    隔离后的临时目录里根本不产生该文件，after 读取直接失败。
   *
   * 正解: 隔离 **rootPath**(而非 dataDir)到临时目录。self-view.json 随之落到
   * `<tmpRoot>/data/`，与并发测试彻底隔离，递增断言恢复确定性。
   */
  test('introspect: think 后 self-view.json 计数递增', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspira-introspect-'));
    const svPath = path.join(tmpRoot, 'data', 'self-view.json');
    const { Aspira } = require('../src/core/heartflow.js');
    const hf = new Aspira({ rootPath: tmpRoot, silent: true });
    hf.start();
    await new Promise(r => setTimeout(r, 2500));
    const before = fs.existsSync(svPath) ? (JSON.parse(fs.readFileSync(svPath, 'utf8')).thinkCount || 0) : 0;
    await hf.think('测试自省计数');
    await new Promise(r => setTimeout(r, 500));
    const after = JSON.parse(fs.readFileSync(svPath, 'utf8')).thinkCount || 0;
    assert.ok(after > before, `thinkCount 应递增 (${before} → ${after})`);
    hf.shutdown();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('introspect: Reflector.feed 打通数据流', async () => {
    const { Reflector } = require('../src/cortex/reflector.js');
    const reflector = new Reflector(ROOT);
    const res = reflector.feed({ task: '回归测试任务', success: true, emotion: { valence: 7, arousal: 5 } });
    assert.ok(res.ok, 'feed 应成功');
    const state = JSON.parse(fs.readFileSync(reflector.stateFile, 'utf8'));
    assert.ok(Array.isArray(state.achievements) && state.achievements.length > 0, 'achievements 应有数据');
  });
};
